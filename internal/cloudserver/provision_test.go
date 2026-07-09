package cloudserver

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

func TestProvision_InviteClaimSingleUse(t *testing.T) {
	store := setupStore(t)
	ctx := t.Context()
	now := time.Now().UTC()

	inv, err := Provision(ctx, store, 14*24*time.Hour, now)
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if inv.Account.Subdomain == "" || inv.Token == "" {
		t.Fatalf("expected non-empty subdomain and token, got %+v", inv)
	}
	if !strings.Contains(inv.ClaimURL("app.example.com"), inv.Account.Subdomain+".app.example.com/#claim="+inv.Token) {
		t.Fatalf("unexpected claim URL: %s", inv.ClaimURL("app.example.com"))
	}

	tokenHash := sha256Sum(inv.Token)
	claimed, err := store.ConsumeClaimToken(ctx, inv.Account.Subdomain, tokenHash, now)
	if err != nil {
		t.Fatalf("ConsumeClaimToken: %v", err)
	}
	if claimed.ID != inv.Account.ID {
		t.Fatalf("claimed account %s, want %s", claimed.ID, inv.Account.ID)
	}

	// Single use: replaying the token must fail.
	if _, err := store.ConsumeClaimToken(ctx, inv.Account.Subdomain, tokenHash, now); err != cloudstore.ErrClaimInvalid {
		t.Fatalf("expected ErrClaimInvalid on reuse, got %v", err)
	}
}

func TestProvision_ExpiredClaimRejected(t *testing.T) {
	store := setupStore(t)
	ctx := t.Context()
	now := time.Now().UTC()

	inv, err := Provision(ctx, store, time.Hour, now)
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}

	tokenHash := sha256Sum(inv.Token)
	past := now.Add(2 * time.Hour) // after the 1-hour TTL
	if _, err := store.ConsumeClaimToken(ctx, inv.Account.Subdomain, tokenHash, past); err != cloudstore.ErrClaimInvalid {
		t.Fatalf("expected ErrClaimInvalid for expired claim, got %v", err)
	}

	// Sweeping at that point should reclaim the expired, still-unclaimed invite.
	swept, err := store.SweepExpiredClaims(ctx, past)
	if err != nil {
		t.Fatalf("SweepExpiredClaims: %v", err)
	}
	if swept != 1 {
		t.Fatalf("expected 1 swept account, got %d", swept)
	}
	if _, err := store.AccountBySubdomain(ctx, inv.Account.Subdomain); err == nil {
		t.Fatalf("expected swept account to be gone")
	}
}

func TestProvision_ResetClaimInvalidatesOldToken(t *testing.T) {
	store := setupStore(t)
	ctx := t.Context()
	now := time.Now().UTC()

	inv, err := Provision(ctx, store, 14*24*time.Hour, now)
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}

	newToken, newHash, err := NewClaimToken()
	if err != nil {
		t.Fatalf("NewClaimToken: %v", err)
	}
	if err := store.ResetClaim(ctx, inv.Account.Subdomain, newHash, now.Add(time.Hour)); err != nil {
		t.Fatalf("ResetClaim: %v", err)
	}

	// Old token must no longer work.
	oldHash := sha256Sum(inv.Token)
	if _, err := store.ConsumeClaimToken(ctx, inv.Account.Subdomain, oldHash, now); err != cloudstore.ErrClaimInvalid {
		t.Fatalf("expected ErrClaimInvalid for old token, got %v", err)
	}

	// New token must work.
	if _, err := store.ConsumeClaimToken(ctx, inv.Account.Subdomain, newHash, now); err != nil {
		t.Fatalf("ConsumeClaimToken with new token: %v", err)
	}
	_ = newToken
}

func TestProvision_GeneratesDistinctVAPIDKeypair(t *testing.T) {
	store := setupStore(t)
	ctx := t.Context()
	now := time.Now().UTC()

	inv1, err := Provision(ctx, store, 14*24*time.Hour, now)
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if inv1.Account.VAPIDPublicKey == nil || *inv1.Account.VAPIDPublicKey == "" {
		t.Fatalf("expected non-empty VAPID public key, got %+v", inv1.Account.VAPIDPublicKey)
	}
	if inv1.Account.VAPIDPrivateKey == nil || *inv1.Account.VAPIDPrivateKey == "" {
		t.Fatalf("expected non-empty VAPID private key, got %+v", inv1.Account.VAPIDPrivateKey)
	}

	inv2, err := Provision(ctx, store, 14*24*time.Hour, now)
	if err != nil {
		t.Fatalf("Provision (second): %v", err)
	}
	if *inv1.Account.VAPIDPublicKey == *inv2.Account.VAPIDPublicKey {
		t.Fatalf("expected distinct VAPID public keys across accounts, got the same key twice")
	}
}

func TestBackfillVAPIDKeys(t *testing.T) {
	store := setupStore(t)
	ctx := t.Context()
	now := time.Now().UTC()

	// A pre-existing account with no keys (simulates a row created before
	// per-account keys shipped).
	legacy, err := store.CreateAccount(ctx, "legacy-account", "legacy-sub", []byte("hash"), now.Add(time.Hour), now, "", "", "")
	if err != nil {
		t.Fatalf("CreateAccount (legacy): %v", err)
	}
	if legacy.VAPIDPublicKey != nil {
		t.Fatalf("expected legacy account to start with no VAPID key")
	}

	// A freshly-provisioned account already has keys and must be left alone.
	inv, err := Provision(ctx, store, 14*24*time.Hour, now)
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	populatedKey := *inv.Account.VAPIDPublicKey

	backfilled, err := BackfillVAPIDKeys(ctx, store)
	if err != nil {
		t.Fatalf("BackfillVAPIDKeys: %v", err)
	}
	if backfilled != 1 {
		t.Fatalf("expected 1 account backfilled, got %d", backfilled)
	}

	updatedLegacy, err := store.AccountBySubdomain(ctx, "legacy-sub")
	if err != nil {
		t.Fatalf("AccountBySubdomain (legacy): %v", err)
	}
	if updatedLegacy.VAPIDPublicKey == nil || *updatedLegacy.VAPIDPublicKey == "" {
		t.Fatalf("expected legacy account to have a VAPID key after backfill")
	}

	untouched, err := store.AccountBySubdomain(ctx, inv.Account.Subdomain)
	if err != nil {
		t.Fatalf("AccountBySubdomain (populated): %v", err)
	}
	if *untouched.VAPIDPublicKey != populatedKey {
		t.Fatalf("expected already-keyed account to be untouched by backfill, got %s want %s", *untouched.VAPIDPublicKey, populatedKey)
	}

	// Re-running the backfill must be a no-op: no accounts left missing keys.
	backfilledAgain, err := BackfillVAPIDKeys(ctx, store)
	if err != nil {
		t.Fatalf("BackfillVAPIDKeys (second run): %v", err)
	}
	if backfilledAgain != 0 {
		t.Fatalf("expected second backfill run to be a no-op, got %d", backfilledAgain)
	}
}

// sha256Sum re-derives the stored claim-token hash from the hex-encoded
// token NewClaimToken hands to the caller (mirrors what a real claim request
// does: decode the URL fragment, then hash before comparing).
func sha256Sum(token string) []byte {
	raw, err := hex.DecodeString(token)
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(raw)
	return sum[:]
}
