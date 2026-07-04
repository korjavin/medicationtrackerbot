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
