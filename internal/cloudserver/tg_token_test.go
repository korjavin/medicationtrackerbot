package cloudserver

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// TestTGBotSealRoundtrip guards the at-rest encryption end to end: a sealed bot
// token stored in tg_bots decrypts back to the original after a load cycle, the
// stored ciphertext never contains the plaintext, and a different SESSION_SECRET
// cannot open it.
func TestTGBotSealRoundtrip(t *testing.T) {
	repo := setupStore(t)
	ctx := context.Background()
	now := time.Now().UTC()

	acc, err := repo.CreateAccount(ctx, "acc-tg", "brave-otter-tg01", []byte("claimtokenhash-32-bytes-of-junk"), now.Add(time.Hour), now, "", "", "")
	if err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}

	const secret = "super-secret-session-key"
	const token = "123456:AAH-realish-bot-token-string"

	ct, nonce, err := sealTGToken(secret, token)
	if err != nil {
		t.Fatalf("sealTGToken: %v", err)
	}
	if bytes.Contains(ct, []byte(token)) {
		t.Fatal("ciphertext contains plaintext token")
	}

	if err := repo.UpsertBot(ctx, cloudstore.TGBot{
		AccountID:     acc.ID,
		BotID:         42,
		BotUsername:   "mt_x7k2q9_bot",
		TokenCT:       ct,
		TokenNonce:    nonce,
		Kind:          "managed",
		WebhookSecret: "whsec",
		CreatedAt:     now,
	}); err != nil {
		t.Fatalf("UpsertBot: %v", err)
	}

	got, err := repo.BotByAccount(ctx, acc.ID)
	if err != nil {
		t.Fatalf("BotByAccount: %v", err)
	}
	if got.ChatID != nil || got.LinkedAt != nil {
		t.Fatalf("fresh bot should be unlinked, got chat=%v linked=%v", got.ChatID, got.LinkedAt)
	}

	opened, err := openTGToken(secret, got.TokenCT, got.TokenNonce)
	if err != nil {
		t.Fatalf("openTGToken: %v", err)
	}
	if opened != token {
		t.Fatalf("roundtrip mismatch: got %q want %q", opened, token)
	}

	// Wrong SESSION_SECRET must not decrypt (GCM auth failure).
	if _, err := openTGToken("different-secret", got.TokenCT, got.TokenNonce); err == nil {
		t.Fatal("expected decrypt failure under a different secret")
	}

	// Link the chat and confirm it round-trips.
	if err := repo.LinkChat(ctx, acc.ID, 9001, now); err != nil {
		t.Fatalf("LinkChat: %v", err)
	}
	got, err = repo.BotByWebhookRef(ctx, acc.ID)
	if err != nil {
		t.Fatalf("BotByWebhookRef: %v", err)
	}
	if got.ChatID == nil || *got.ChatID != 9001 || got.LinkedAt == nil {
		t.Fatalf("expected linked chat 9001, got chat=%v linked=%v", got.ChatID, got.LinkedAt)
	}
}

// TestTGPendingConsume guards single-use consumption of the pending pairing row.
func TestTGPendingConsume(t *testing.T) {
	repo := setupStore(t)
	ctx := context.Background()
	now := time.Now().UTC()

	if err := repo.CreatePending(ctx, "mt_x7k2q9_bot", "acc-1", now, now.Add(time.Hour)); err != nil {
		t.Fatalf("CreatePending: %v", err)
	}

	accountID, err := repo.ConsumePendingByUsername(ctx, "mt_x7k2q9_bot", now)
	if err != nil {
		t.Fatalf("ConsumePendingByUsername: %v", err)
	}
	if accountID != "acc-1" {
		t.Fatalf("got account %q want acc-1", accountID)
	}

	// Single use: replaying must fail.
	if _, err := repo.ConsumePendingByUsername(ctx, "mt_x7k2q9_bot", now); err != cloudstore.ErrPendingInvalid {
		t.Fatalf("expected ErrPendingInvalid on replay, got %v", err)
	}

	// Expired pending is not consumable.
	if err := repo.CreatePending(ctx, "mt_expired_bot", "acc-2", now.Add(-2*time.Hour), now.Add(-time.Hour)); err != nil {
		t.Fatalf("CreatePending expired: %v", err)
	}
	if _, err := repo.ConsumePendingByUsername(ctx, "mt_expired_bot", now); err != cloudstore.ErrPendingInvalid {
		t.Fatalf("expected ErrPendingInvalid on expired, got %v", err)
	}
}
