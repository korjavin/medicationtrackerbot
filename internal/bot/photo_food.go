package bot

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

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
