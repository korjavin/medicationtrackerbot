package cloudserver

import (
	"context"
	"crypto/sha256"
	"strings"
	"testing"
	"time"
)

// TestNotifyFeedback_LinkCarriesTokenInFragment: the web ping links to the
// base-domain reader page (bd med-rbl.1) with the capability token in the URL
// FRAGMENT. Load-bearing twice over — browsers never send a fragment to the
// server (so it stays out of access logs), and Telegram prefetches links to
// build previews, which would spend a query-param token before the developer
// ever tapped it.
func TestNotifyFeedback_LinkCarriesTokenInFragment(t *testing.T) {
	tg := newRecordingTG(t)
	store := setupStore(t)
	tgAPI := NewTelegramAPI(store, tgTestSecret, "MANAGER:TOKEN", "cloud.example.com", tg.url, "", time.Hour)
	tgAPI.SetFeedbackAdminChat(feedbackAdminChat)
	tgAPI.NotifyFeedback("bug", "1.2.3")

	if len(tg.mu.sent) != 1 {
		t.Fatalf("want 1 ping, got %v", tg.mu.sent)
	}
	ping := tg.mu.sent[0]
	if !strings.Contains(ping, "https://cloud.example.com"+feedbackReaderPath+"#t=") {
		t.Fatalf("ping has no fragment-carried reader link: %s", ping)
	}
	if strings.Contains(ping, feedbackReaderPath+"?") {
		t.Fatalf("token rode a query string: %s", ping)
	}

	// The token in the link is the live capability: its SHA-256 is what's stored.
	token := ping[strings.Index(ping, "#t=")+3:]
	if j := strings.IndexAny(token, "\" \\"); j >= 0 {
		token = token[:j]
	}
	if len(token) < 32 {
		t.Fatalf("token looks too short (%d chars): %q", len(token), token)
	}
	sum := sha256.Sum256([]byte(token))
	ok, err := store.FeedbackReaderTokenValid(context.Background(), sum[:], time.Now().UTC())
	if err != nil {
		t.Fatalf("FeedbackReaderTokenValid: %v", err)
	}
	if !ok {
		t.Fatal("the token in the DM link is not a live capability")
	}
}

// TestNotifyFeedback_MintFailureStillPings: a mint failure (here: a closed DB)
// degrades to the old "run feedbackpull" text. It must never drop the ping —
// the ping is the only signal that feedback arrived at all.
func TestNotifyFeedback_MintFailureStillPings(t *testing.T) {
	tg := newRecordingTG(t)
	store, db := setupStoreWithDB(t)
	tgAPI := NewTelegramAPI(store, tgTestSecret, "MANAGER:TOKEN", "cloud.example.com", tg.url, "", time.Hour)
	tgAPI.SetFeedbackAdminChat(feedbackAdminChat)
	if err := db.Close(); err != nil {
		t.Fatalf("close db: %v", err)
	}
	tgAPI.NotifyFeedback("bug", "1.2.3")

	if len(tg.mu.sent) != 1 {
		t.Fatalf("mint failure dropped the ping: %v", tg.mu.sent)
	}
	ping := tg.mu.sent[0]
	if !strings.Contains(ping, "feedbackpull") {
		t.Errorf("mint failure did not fall back to the feedbackpull text: %s", ping)
	}
	if strings.Contains(ping, "#t=") {
		t.Errorf("ping advertises a reader link with no token behind it: %s", ping)
	}
}
