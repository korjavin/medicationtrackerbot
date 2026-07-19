package cloudserver

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"time"

	"filippo.io/age"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	"github.com/korjavin/medicationtrackerbot/internal/tgclient"
)

// feedbackWaitingTTL bounds how long a "Send feedback" tap stays armed. After
// this, the next message is treated as an ordinary manager-bot message again.
const feedbackWaitingTTL = 5 * time.Minute

// feedbackCallbackData is the callback_data on the manager bot's "Send feedback"
// inline button — the only inline button the manager bot offers.
const feedbackCallbackData = "fb"

// maxFeedbackAttachmentBytes bounds a downloaded voice/photo before base64. Same
// ceiling as the photo proxy — a Telegram voice memo or screenshot is well under.
const maxFeedbackAttachmentBytes = 8 << 20

// Feedback copy the manager bot sends for the Telegram feedback channel (server
// constants, like the onboarding copy).
const (
	feedbackButtonLabel      = "📮 Send feedback to developer"
	feedbackPromptMessage    = "Send your message, voice, or screenshot now (or /cancel)."
	feedbackCancelMessage    = "Cancelled."
	feedbackThanksMessage    = "✅ Thanks — sent to the developer."
	feedbackNoAccountMessage = "Finish setting up your account first, then you can send feedback."
	feedbackQueueFullMessage = "You've sent a lot of feedback recently — please try again later."
	feedbackFailMessage      = "Sorry, I couldn't send your feedback just now. Please try again in a few minutes."
)

// feedbackDoc is the v1 plaintext envelope the server encrypts to the developer
// (the same shape the browser client produces in med-dni.3 and cmd/feedbackpull
// decodes): feedback text plus at most one inline base64 attachment.
type feedbackDoc struct {
	V           int                  `json:"v"`
	CreatedAt   string               `json:"created_at"`
	Text        string               `json:"text"`
	Attachments []feedbackAttachment `json:"attachments,omitempty"`
}

type feedbackAttachment struct {
	Type    string `json:"type"`
	Mime    string `json:"mime"`
	DataB64 string `json:"data_b64"`
}

// feedbackEnabled reports whether the Telegram feedback channel is configured.
// "" recipient disables it: no button offered, a stale tap does nothing.
func (t *TelegramAPI) feedbackEnabled() bool { return t.feedbackRecipient != "" }

// feedbackButton is the single-row inline keyboard offering the feedback button.
func feedbackButton() []tgclient.InlineKeyboardButton {
	return []tgclient.InlineKeyboardButton{{Text: feedbackButtonLabel, CallbackData: feedbackCallbackData}}
}

// replyManagerClaimed sends the "you already have an account" reply, attaching
// the "Send feedback" button when the channel is enabled — a claimed sender is
// the manager bot's only feedback audience, so this is the one place it's offered.
func (t *TelegramAPI) replyManagerClaimed(ctx context.Context, chatID int64) {
	if !t.feedbackEnabled() {
		t.reply(ctx, chatID, onboardingClaimedMessage)
		return
	}
	if err := t.managerClient().SendMessageWithButtons(ctx, chatID, onboardingClaimedMessage, feedbackButton()); err != nil {
		slog.Error("telegram feedback: send claimed reply", "error", err, "chat_id", chatID)
	}
}

// handleManagerCallback answers a manager-bot inline-button tap. It acks every
// tap (Telegram spins the button until answered) and, on our "fb" button, arms
// the chat so the user's next message is captured as feedback. Unknown callback
// data or a disabled channel is acked and otherwise ignored.
func (t *TelegramAPI) handleManagerCallback(ctx context.Context, cq *tgclient.CallbackQuery) {
	if cq == nil {
		return
	}
	if cq.ID != "" {
		if err := t.managerClient().AnswerCallbackQuery(ctx, cq.ID, ""); err != nil {
			slog.Warn("telegram manager callback: answer failed", "error", err)
		}
	}
	if cq.Data != feedbackCallbackData || !t.feedbackEnabled() {
		return
	}
	chatID, ok := callbackChatID(cq)
	if !ok {
		return
	}
	t.setFeedbackWaiting(chatID)
	t.reply(ctx, chatID, feedbackPromptMessage)
}

// callbackChatID resolves the private chat to arm/reply to: the message's chat
// when present, else the tapping user's id (in a private chat the two are equal).
func callbackChatID(cq *tgclient.CallbackQuery) (int64, bool) {
	if cq.Message != nil {
		return cq.Message.Chat.ID, true
	}
	if cq.From != nil {
		return cq.From.ID, true
	}
	return 0, false
}

// captureFeedback handles the message following a "Send feedback" tap: it
// resolves the sender's claimed account, builds the v1 plaintext doc from the
// text/caption plus at most one downloaded attachment (voice or photo),
// age-encrypts it to the developer's recipient, and queues it via AppendFeedback.
// The server holds only the recipient public key — it encrypts blindly and never
// persists the plaintext. Every failure becomes a friendly reply; the webhook
// still answers 200.
func (t *TelegramAPI) captureFeedback(ctx context.Context, msg *tgclient.Message, creator string) {
	accountID, err := t.store.ClaimedAccountIDForCreator(ctx, creator)
	if err != nil {
		slog.Error("telegram feedback: resolve account", "error", err)
		t.reply(ctx, msg.Chat.ID, feedbackFailMessage)
		return
	}
	if accountID == "" {
		// A stale tap from a sender who never finished (or lost) their account.
		t.reply(ctx, msg.Chat.ID, feedbackNoAccountMessage)
		return
	}

	text := strings.TrimSpace(msg.Text)
	if text == "" {
		text = strings.TrimSpace(msg.Caption)
	}
	if strings.EqualFold(text, "/cancel") {
		t.reply(ctx, msg.Chat.ID, feedbackCancelMessage)
		return
	}

	doc := feedbackDoc{V: 1, CreatedAt: time.Now().UTC().Format(time.RFC3339), Text: text}
	if att, ok := t.downloadFeedbackAttachment(ctx, msg); ok {
		doc.Attachments = append(doc.Attachments, att)
	}
	if doc.Text == "" && len(doc.Attachments) == 0 {
		// Nothing to send (empty message, or an attachment that failed to
		// download) — treat like a cancel rather than queue an empty doc.
		t.reply(ctx, msg.Chat.ID, feedbackCancelMessage)
		return
	}

	plaintext, err := json.Marshal(doc)
	if err != nil {
		slog.Error("telegram feedback: marshal doc", "error", err)
		t.reply(ctx, msg.Chat.ID, feedbackFailMessage)
		return
	}
	ciphertext, err := encryptFeedbackDoc(t.feedbackRecipient, plaintext)
	if err != nil {
		slog.Error("telegram feedback: encrypt", "error", err)
		t.reply(ctx, msg.Chat.ID, feedbackFailMessage)
		return
	}
	switch err := t.store.AppendFeedback(ctx, accountID, randomSecret(), "telegram", "", ciphertext, time.Now().UTC()); {
	case err == nil:
		t.reply(ctx, msg.Chat.ID, feedbackThanksMessage)
	case errors.Is(err, cloudstore.ErrFeedbackQueueFull):
		t.reply(ctx, msg.Chat.ID, feedbackQueueFullMessage)
	default:
		slog.Error("telegram feedback: append", "error", err)
		t.reply(ctx, msg.Chat.ID, feedbackFailMessage)
	}
}

// downloadFeedbackAttachment fetches at most one attachment — a voice memo if
// present, else the largest photo — through the MANAGER bot client (the media
// was sent to the manager bot, not a child bot). Returns ok=false when there's
// nothing to attach or the download fails; the feedback text still goes through.
// Size-gated like the photo proxy.
func (t *TelegramAPI) downloadFeedbackAttachment(ctx context.Context, msg *tgclient.Message) (feedbackAttachment, bool) {
	var fileID, typ, mime string
	switch {
	case msg.Voice != nil && msg.Voice.FileID != "":
		fileID, typ, mime = msg.Voice.FileID, "audio", msg.Voice.MimeType
		if mime == "" {
			mime = "audio/ogg"
		}
	case msg.LargestPhoto() != nil:
		fileID, typ, mime = msg.LargestPhoto().FileID, "image", "image/jpeg"
	default:
		return feedbackAttachment{}, false
	}

	client := t.managerClient()
	file, err := client.GetFile(ctx, fileID)
	if err != nil {
		slog.Warn("telegram feedback: getFile failed", "error", err)
		return feedbackAttachment{}, false
	}
	if file.FileSize > maxFeedbackAttachmentBytes {
		slog.Warn("telegram feedback: attachment over cap", "size", file.FileSize)
		return feedbackAttachment{}, false
	}
	body, _, err := client.DownloadFile(ctx, file.FilePath)
	if err != nil {
		slog.Warn("telegram feedback: download failed", "error", err)
		return feedbackAttachment{}, false
	}
	defer body.Close()
	data, err := io.ReadAll(io.LimitReader(body, maxFeedbackAttachmentBytes))
	if err != nil {
		slog.Warn("telegram feedback: read attachment", "error", err)
		return feedbackAttachment{}, false
	}
	return feedbackAttachment{Type: typ, Mime: mime, DataB64: base64.StdEncoding.EncodeToString(data)}, true
}

// encryptFeedbackDoc age-encrypts a v1 plaintext feedback document to the
// developer's recipient pubkey. The server only holds the public key — it
// encrypts blindly and cannot decrypt (the counterpart decrypt lives in
// cmd/feedbackpull). Returns an error on an empty or malformed recipient.
func encryptFeedbackDoc(recipient string, doc []byte) ([]byte, error) {
	if recipient == "" {
		return nil, errors.New("feedback recipient not configured")
	}
	recip, err := age.ParseX25519Recipient(recipient)
	if err != nil {
		return nil, fmt.Errorf("parse feedback recipient: %w", err)
	}
	var buf bytes.Buffer
	w, err := age.Encrypt(&buf, recip)
	if err != nil {
		return nil, fmt.Errorf("start age encrypt: %w", err)
	}
	if _, err := w.Write(doc); err != nil {
		return nil, fmt.Errorf("write feedback doc: %w", err)
	}
	if err := w.Close(); err != nil { // flushes the age footer
		return nil, fmt.Errorf("close age writer: %w", err)
	}
	return buf.Bytes(), nil
}

// setFeedbackWaiting arms a chat so its next message is captured as feedback.
func (t *TelegramAPI) setFeedbackWaiting(chatID int64) {
	t.feedbackMu.Lock()
	defer t.feedbackMu.Unlock()
	now := time.Now()
	// Reclaim entries from taps that were never followed by a message, so the
	// map can't grow unbounded on a long-lived process (takeFeedbackWaiting only
	// clears a chat that sends its own next message).
	for id, expiry := range t.feedbackWaiting {
		if !now.Before(expiry) {
			delete(t.feedbackWaiting, id)
		}
	}
	t.feedbackWaiting[chatID] = now.Add(feedbackWaitingTTL)
}

// takeFeedbackWaiting reports whether a chat has an unexpired armed feedback
// tap, clearing it in the same step. Returns false for unknown or expired chats.
func (t *TelegramAPI) takeFeedbackWaiting(chatID int64) bool {
	t.feedbackMu.Lock()
	defer t.feedbackMu.Unlock()
	expiry, ok := t.feedbackWaiting[chatID]
	if !ok {
		return false
	}
	delete(t.feedbackWaiting, chatID)
	return time.Now().Before(expiry)
}
