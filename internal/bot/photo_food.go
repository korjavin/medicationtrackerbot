package bot

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/domain"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// foodPhotoUndoCallbackPrefix is the inline-keyboard callback_data prefix used
// by the 5-second [Undo] button that follows a photo food log. The full
// payload is "food_photo_undo:<32-char hex token>" — 48 bytes, well under
// Telegram's 64-byte cap.
const foodPhotoUndoCallbackPrefix = "food_photo_undo:"

// foodPhotoTimeCallbackPrefix is the inline-keyboard callback_data prefix used
// by the "use photo time / use now?" picker shown when EXIF DateTimeOriginal
// is more than foodPhotoExifStaleAfter old. The full payload is
// "food_photo_time:<exif|now>:<32-char hex token>" — at most 53 bytes.
const foodPhotoTimeCallbackPrefix = "food_photo_time:"

// foodPhotoExifStaleAfter is the threshold beyond which a photo's EXIF time
// is considered "old enough that the user probably meant a different time
// than now" — the bot then asks which timestamp to use.
const foodPhotoExifStaleAfter = time.Hour

// foodPhotoUndoWindow is the visible undo window. After it expires, the bot
// edits the summary message to remove the [Undo] button. The undoBatchStore
// entry itself lives a little longer (see undoBatchTTL) so a click that races
// the timer resolves cleanly via take().
const foodPhotoUndoWindow = 5 * time.Second

// foodPhotoParseTimeout caps the total time spent inside foodAI.ParseMealPhoto.
// Vision providers can be slow on cold start; 60s mirrors the web upload's
// generous timeout.
const foodPhotoParseTimeout = 60 * time.Second

// foodPhotoSaveTimeout caps the per-batch SQLite write. We expect milliseconds
// in practice but a wide ceiling avoids spurious failures under load.
const foodPhotoSaveTimeout = 15 * time.Second

// maxFoodPhotoBytes caps photos at ~8 MB to mirror the web upload limit at
// internal/server/food_handlers.go.
const maxFoodPhotoBytes = 8 << 20

// telegramFileFetcher abstracts the two pieces of the Telegram file-download
// flow so tests can inject a fake without spinning up a real HTTP server.
//
// GetFile resolves a Telegram fileID to a File descriptor; the descriptor's
// FilePath is either a "/"-prefixed local path (when the bot is paired with a
// local Bot API server that shares a volume) or a relative path that resolves
// through file.Link(token).
type telegramFileFetcher interface {
	GetFile(cfg tgbotapi.FileConfig) (tgbotapi.File, error)
	Token() string
}

// botAPIFetcher adapts *tgbotapi.BotAPI to telegramFileFetcher. The real bot
// uses this; tests substitute a fake implementation.
type botAPIFetcher struct{ api *tgbotapi.BotAPI }

func (f botAPIFetcher) GetFile(cfg tgbotapi.FileConfig) (tgbotapi.File, error) {
	return f.api.GetFile(cfg)
}

func (f botAPIFetcher) Token() string { return f.api.Token }

// downloadTelegramPhoto fetches the bytes of a Telegram photo by file ID and
// returns the bytes plus the detected image MIME type. Files larger than
// maxFoodPhotoBytes are rejected without buffering the rest of the body, and
// non-image content (per http.DetectContentType) is rejected as well.
func (b *Bot) downloadTelegramPhoto(ctx context.Context, fileID string) ([]byte, string, error) {
	return downloadTelegramPhotoWith(ctx, botAPIFetcher{api: b.api}, b.httpClient, fileID)
}

func downloadTelegramPhotoWith(ctx context.Context, fetcher telegramFileFetcher, httpClient *http.Client, fileID string) ([]byte, string, error) {
	file, err := fetcher.GetFile(tgbotapi.FileConfig{FileID: fileID})
	if err != nil {
		return nil, "", fmt.Errorf("telegram getFile: %w", err)
	}

	imageBytes, err := readTelegramFile(ctx, fetcher, httpClient, file)
	if err != nil {
		return nil, "", err
	}
	if len(imageBytes) == 0 {
		return nil, "", fmt.Errorf("downloaded photo is empty")
	}

	mimeType := http.DetectContentType(imageBytes)
	if !strings.HasPrefix(mimeType, "image/") {
		return nil, "", fmt.Errorf("downloaded file is not an image (mime=%s)", mimeType)
	}
	return imageBytes, mimeType, nil
}

func readTelegramFile(ctx context.Context, fetcher telegramFileFetcher, httpClient *http.Client, file tgbotapi.File) ([]byte, error) {
	if strings.HasPrefix(file.FilePath, "/") {
		return readLocalTelegramFile(file.FilePath)
	}
	return readRemoteTelegramFile(ctx, httpClient, file.Link(fetcher.Token()))
}

func readLocalTelegramFile(path string) ([]byte, error) {
	f, err := os.Open(path) // #nosec G304 -- path comes from Telegram Bot API getFile, not user input
	if err != nil {
		return nil, fmt.Errorf("open local telegram file: %w", err)
	}
	defer f.Close()
	return readCapped(f)
}

func readRemoteTelegramFile(ctx context.Context, httpClient *http.Client, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build telegram download request: %w", err)
	}
	resp, err := httpClient.Do(req) // #nosec G107 -- url is built from Telegram Bot API file.Link, not user-controlled
	if err != nil {
		return nil, fmt.Errorf("download telegram file: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("telegram file download: HTTP %s", resp.Status)
	}
	return readCapped(resp.Body)
}

// respondWithFoodPhotoSummary runs the parse → save → reply pipeline for a
// food photo. It sends a transient "analyzing" status message, calls
// foodAI.ParseMealPhoto, persists each detected item via food.CreateFoodLog,
// and replies with the standard /food summary plus an inline [Undo] button
// that stays live for foodPhotoUndoWindow before being stripped.
//
// The caller is responsible for the feature-flag and foodAI nil-guard checks;
// this function assumes both are satisfied.
func (b *Bot) respondWithFoodPhotoSummary(ctx context.Context, chatID int64, eatenAt time.Time, imageBytes []byte, mimeType string) {
	statusMsg := tgbotapi.NewMessage(chatID, "⏳ Analyzing photo…")
	sentStatus, err := b.api.Send(statusMsg)
	if err != nil {
		slog.Warn("food photo: failed to send status message", "chat_id", chatID, "error", err)
	}
	defer func() {
		if sentStatus.MessageID == 0 {
			return
		}
		if _, err := b.api.Request(tgbotapi.NewDeleteMessage(chatID, sentStatus.MessageID)); err != nil {
			slog.Warn("food photo: failed to delete status message", "chat_id", chatID, "message_id", sentStatus.MessageID, "error", err)
		}
	}()

	parseCtx, parseCancel := context.WithTimeout(ctx, foodPhotoParseTimeout)
	defer parseCancel()

	parsed, err := b.foodAI.ParseMealPhoto(parseCtx, imageBytes, mimeType)
	if err != nil {
		slog.Error("food photo: parse failed", "chat_id", chatID, "error", err)
		b.sendPlain(chatID, "❌ Failed to analyze photo: "+err.Error())
		return
	}
	if len(parsed) == 0 {
		b.sendPlain(chatID, "❌ No food detected in the photo.")
		return
	}

	saveCtx, saveCancel := context.WithTimeout(ctx, foodPhotoSaveTimeout)
	defer saveCancel()

	saved := make([]domain.FoodLog, 0, len(parsed))
	savedIDs := make([]int64, 0, len(parsed))
	var failed int
	for _, item := range parsed {
		entry := &store.FoodLog{
			UserID:   b.allowedUserID,
			EatenAt:  eatenAt,
			Weight:   item.Weight,
			Carbs:    item.Carbs,
			Protein:  item.Protein,
			Fat:      item.Fat,
			Calories: item.Calories,
			Name:     item.Name,
		}
		id, err := b.food.CreateFoodLog(saveCtx, entry)
		if err != nil {
			slog.Error("food photo: failed to save food log", "chat_id", chatID, "name", item.Name, "error", err)
			failed++
			continue
		}
		saved = append(saved, item)
		savedIDs = append(savedIDs, id)
	}

	if len(saved) == 0 {
		b.sendPlain(chatID, "❌ Error saving food log to database.")
		return
	}

	summaryText := renderFoodSummary(saved, failed)
	token, tokenErr := b.undoBatches.put(undoBatchEntry{
		chatID:     chatID,
		foodLogIDs: savedIDs,
	})

	summaryMsg := tgbotapi.NewMessage(chatID, summaryText)
	if tokenErr == nil {
		summaryMsg.ReplyMarkup = tgbotapi.NewInlineKeyboardMarkup(
			tgbotapi.NewInlineKeyboardRow(
				tgbotapi.NewInlineKeyboardButtonData("↩️ Undo", foodPhotoUndoCallbackPrefix+token),
			),
		)
	} else {
		slog.Warn("food photo: failed to mint undo token", "chat_id", chatID, "error", tokenErr)
	}

	sentSummary, sendErr := b.api.Send(summaryMsg)
	if sendErr != nil {
		slog.Error("food photo: failed to send summary message", "chat_id", chatID, "error", sendErr)
		return
	}

	if tokenErr != nil {
		return
	}
	if ok := b.undoBatches.setMessageID(token, sentSummary.MessageID); !ok {
		slog.Warn("food photo: undo batch missing after send", "chat_id", chatID, "token", token)
		return
	}

	time.AfterFunc(foodPhotoUndoWindow, func() {
		b.expireUndoBatch(token)
	})
}

// expireUndoBatch strips the [Undo] keyboard from the summary message after
// foodPhotoUndoWindow elapses. Peek (not take) is used so a user click that
// races the timer can still consume the entry via the callback handler.
func (b *Bot) expireUndoBatch(token string) {
	entry, ok := b.undoBatches.peek(token)
	if !ok {
		return
	}
	if entry.messageID == 0 {
		return
	}
	edit := tgbotapi.NewEditMessageReplyMarkup(entry.chatID, entry.messageID, tgbotapi.InlineKeyboardMarkup{
		InlineKeyboard: [][]tgbotapi.InlineKeyboardButton{},
	})
	if _, err := b.api.Request(edit); err != nil {
		slog.Warn("food photo: failed to strip undo keyboard", "chat_id", entry.chatID, "message_id", entry.messageID, "error", err)
	}
}

// sendPlain is a thin wrapper around b.api.Send for fire-and-forget text
// replies whose only failure mode is logged at warn level.
func (b *Bot) sendPlain(chatID int64, text string) {
	if _, err := b.api.Send(tgbotapi.NewMessage(chatID, text)); err != nil {
		slog.Warn("food photo: failed to send message", "chat_id", chatID, "error", err)
	}
}

// handlePhotoMessage routes an incoming photo through the food-AI pipeline.
// It performs the feature-flag and AI nil-guard checks, downloads the largest
// PhotoSize, attempts to read EXIF DateTimeOriginal, and either saves the
// items immediately (default) or asks the user which timestamp to use when
// the photo is more than foodPhotoExifStaleAfter old.
func (b *Bot) handlePhotoMessage(msg *tgbotapi.Message) {
	chatID := msg.Chat.ID
	ctx := context.Background()

	enabled, err := b.food.GetFoodIntakeEnabled(ctx)
	if err != nil {
		b.sendPlain(chatID, "❌ Error checking settings.")
		return
	}
	if !enabled {
		b.sendPlain(chatID, "⚠️ Food intake tracking is disabled in settings.")
		return
	}

	if b.foodAI == nil {
		b.sendPlain(chatID, "⚠️ AI food logging is not configured. Missing OPENAI environment variables.")
		return
	}

	if len(msg.Photo) == 0 {
		return
	}
	largest := msg.Photo[len(msg.Photo)-1]

	download := b.photoDownloader
	if download == nil {
		download = b.downloadTelegramPhoto
	}
	imageBytes, mimeType, err := download(ctx, largest.FileID)
	if err != nil {
		slog.Error("food photo: download failed", "chat_id", chatID, "file_id", largest.FileID, "error", err)
		b.sendPlain(chatID, "❌ Could not download photo: "+err.Error())
		return
	}

	exifTime, hasExif := parseExifDateTimeOriginal(imageBytes)
	if hasExif && time.Since(exifTime) > foodPhotoExifStaleAfter {
		b.promptForFoodPhotoTime(chatID, imageBytes, mimeType, exifTime)
		return
	}

	b.respondWithFoodPhotoSummary(ctx, chatID, time.Now(), imageBytes, mimeType)
}

// promptForFoodPhotoTime stores the photo bytes in pendingPhotos and asks the
// user whether to use the EXIF capture time or time.Now() as the meal's
// EatenAt. The actual save runs in handleFoodPhotoTimeCallback (Task 7) once
// the user picks a button.
func (b *Bot) promptForFoodPhotoTime(chatID int64, imageBytes []byte, mimeType string, exifTime time.Time) {
	token, err := b.pendingPhotos.put(pendingPhotoEntry{
		chatID:     chatID,
		imageBytes: imageBytes,
		mimeType:   mimeType,
		exifTime:   exifTime,
	})
	if err != nil {
		slog.Error("food photo: failed to mint pending token", "chat_id", chatID, "error", err)
		// Fall back to a now-anchored save so we don't lose the photo.
		b.respondWithFoodPhotoSummary(context.Background(), chatID, time.Now(), imageBytes, mimeType)
		return
	}

	prompt := fmt.Sprintf("📸 Use the photo's time (%s) or use now?",
		exifTime.Format("15:04 on 2006-01-02"))
	msgCfg := tgbotapi.NewMessage(chatID, prompt)
	msgCfg.ReplyMarkup = tgbotapi.NewInlineKeyboardMarkup(
		tgbotapi.NewInlineKeyboardRow(
			tgbotapi.NewInlineKeyboardButtonData("📷 Photo time", foodPhotoTimeCallbackPrefix+"exif:"+token),
			tgbotapi.NewInlineKeyboardButtonData("⏱ Now", foodPhotoTimeCallbackPrefix+"now:"+token),
		),
	)
	if _, err := b.api.Send(msgCfg); err != nil {
		slog.Error("food photo: failed to send time picker", "chat_id", chatID, "error", err)
	}
}

// handleFoodPhotoTimeCallback resolves the EXIF time-picker prompt issued by
// promptForFoodPhotoTime. The callback data is "food_photo_time:<choice>:<token>"
// where choice is "exif" or "now"; the token addresses an entry in
// pendingPhotoStore. Once the user picks, we update the prompt text, drop the
// keyboard, and run the parse → save → reply pipeline as a fresh message.
func (b *Bot) handleFoodPhotoTimeCallback(cb *tgbotapi.CallbackQuery) {
	chatID := cb.Message.Chat.ID
	payload := strings.TrimPrefix(cb.Data, foodPhotoTimeCallbackPrefix)
	parts := strings.SplitN(payload, ":", 2)
	if len(parts) != 2 || (parts[0] != "exif" && parts[0] != "now") || parts[1] == "" {
		b.sendPlain(chatID, "⚠️ Invalid time selection.")
		return
	}
	choice, token := parts[0], parts[1]

	entry, ok := b.pendingPhotos.take(token)
	if !ok {
		edit := tgbotapi.NewEditMessageText(chatID, cb.Message.MessageID,
			"⚠️ This photo prompt expired. Please send the photo again.")
		if _, err := b.api.Send(edit); err != nil {
			slog.Warn("food photo: failed to edit expired prompt", "chat_id", chatID, "error", err)
		}
		return
	}

	var eatenAt time.Time
	if choice == "exif" {
		eatenAt = entry.exifTime
	} else {
		eatenAt = time.Now()
	}

	confirmText := fmt.Sprintf("✅ Using %s", eatenAt.Format("15:04 on 2006-01-02"))
	edit := tgbotapi.NewEditMessageText(chatID, cb.Message.MessageID, confirmText)
	if _, err := b.api.Send(edit); err != nil {
		slog.Warn("food photo: failed to edit prompt after selection", "chat_id", chatID, "error", err)
	}

	b.respondWithFoodPhotoSummary(context.Background(), chatID, eatenAt, entry.imageBytes, entry.mimeType)
}

// handleFoodPhotoUndoCallback resolves the [Undo] button on a photo summary
// message. The callback data is "food_photo_undo:<token>"; the token addresses
// an entry in undoBatchStore. We delete every food_log row in the batch, then
// edit the summary message to strip the keyboard and append a status line.
func (b *Bot) handleFoodPhotoUndoCallback(cb *tgbotapi.CallbackQuery) {
	chatID := cb.Message.Chat.ID
	token := strings.TrimPrefix(cb.Data, foodPhotoUndoCallbackPrefix)
	if token == "" {
		return
	}

	entry, ok := b.undoBatches.take(token)
	if !ok {
		b.sendPlain(chatID, "⚠️ Undo window expired.")
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), foodPhotoSaveTimeout)
	defer cancel()

	var deleted, failed int
	for _, id := range entry.foodLogIDs {
		if err := b.food.DeleteFoodLog(ctx, id, b.allowedUserID); err != nil {
			slog.Error("food photo: undo delete failed", "chat_id", chatID, "food_log_id", id, "error", err)
			failed++
			continue
		}
		deleted++
	}

	originalText := ""
	if cb.Message != nil {
		originalText = cb.Message.Text
	}
	var status string
	switch {
	case failed == 0:
		status = fmt.Sprintf("↩️ Undone (%d items removed)", deleted)
	case deleted == 0:
		status = fmt.Sprintf("⚠️ Undo failed for all %d items", failed)
	default:
		status = fmt.Sprintf("↩️ Undone %d items, %d failed", deleted, failed)
	}

	newText := strings.TrimRight(originalText, "\n") + "\n\n" + status
	edit := tgbotapi.NewEditMessageText(chatID, cb.Message.MessageID, newText)
	if _, err := b.api.Send(edit); err != nil {
		slog.Warn("food photo: failed to edit summary after undo", "chat_id", chatID, "error", err)
	}
}

// readCapped reads up to maxFoodPhotoBytes+1 bytes from r. If the reader still
// has bytes left after that, the source is over the limit and we return an
// error rather than the truncated prefix.
func readCapped(r io.Reader) ([]byte, error) {
	limited := io.LimitReader(r, maxFoodPhotoBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("read telegram file: %w", err)
	}
	if len(data) > maxFoodPhotoBytes {
		return nil, fmt.Errorf("photo exceeds %d-byte limit", maxFoodPhotoBytes)
	}
	return data, nil
}
