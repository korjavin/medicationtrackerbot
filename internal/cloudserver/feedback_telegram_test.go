package cloudserver

import (
	"bytes"
	"io"
	"testing"
	"time"

	"filippo.io/age"
)

func TestEncryptFeedbackDoc_RoundTrip(t *testing.T) {
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatalf("generate identity: %v", err)
	}
	plaintext := []byte(`{"v":1,"created_at":"2026-07-19T00:00:00Z","text":"hi dev","attachments":[]}`)

	ct, err := encryptFeedbackDoc(id.Recipient().String(), plaintext)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if bytes.Contains(ct, []byte("hi dev")) {
		t.Fatal("ciphertext leaks plaintext")
	}

	r, err := age.Decrypt(bytes.NewReader(ct), id)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	got, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !bytes.Equal(got, plaintext) {
		t.Fatalf("round-trip mismatch: got %s", got)
	}
}

func TestEncryptFeedbackDoc_EmptyRecipient(t *testing.T) {
	if _, err := encryptFeedbackDoc("", []byte("x")); err == nil {
		t.Fatal("expected error for empty recipient")
	}
}

func TestFeedbackWaiting_SetTakeOnce(t *testing.T) {
	tg := &TelegramAPI{feedbackWaiting: make(map[int64]time.Time)}
	tg.setFeedbackWaiting(42)
	if !tg.takeFeedbackWaiting(42) {
		t.Fatal("first take should be true")
	}
	if tg.takeFeedbackWaiting(42) {
		t.Fatal("second take should be false (cleared)")
	}
	if tg.takeFeedbackWaiting(99) {
		t.Fatal("unknown chat should be false")
	}
}

func TestFeedbackWaiting_Expired(t *testing.T) {
	tg := &TelegramAPI{feedbackWaiting: make(map[int64]time.Time)}
	tg.feedbackWaiting[7] = time.Now().Add(-time.Minute) // already expired
	if tg.takeFeedbackWaiting(7) {
		t.Fatal("expired entry should return false")
	}
}
