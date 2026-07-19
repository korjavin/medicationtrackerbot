package cloudserver

import (
	"bytes"
	"errors"
	"fmt"
	"time"

	"filippo.io/age"
)

// feedbackWaitingTTL bounds how long a "Send feedback" tap stays armed. After
// this, the next message is treated as an ordinary manager-bot message again.
const feedbackWaitingTTL = 5 * time.Minute

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
	t.feedbackWaiting[chatID] = time.Now().Add(feedbackWaitingTTL)
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
