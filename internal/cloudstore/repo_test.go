package cloudstore

import (
	"context"
	"testing"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

func setupRepo(t *testing.T) *Repo {
	t.Helper()
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	r, err := New(d)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return r
}

func TestAccountCredentialEnvelopeRoundtrip(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()

	tokenHash := []byte("claimtokenhash-32-bytes-of-junk")
	acc, err := r.CreateAccount(ctx, "acc-1", "brave-otter-abc123", tokenHash, now.Add(14*24*time.Hour), now)
	if err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	if acc.ID != "acc-1" || acc.Subdomain != "brave-otter-abc123" {
		t.Fatalf("unexpected account: %+v", acc)
	}

	got, err := r.AccountBySubdomain(ctx, "brave-otter-abc123")
	if err != nil {
		t.Fatalf("AccountBySubdomain: %v", err)
	}
	if got.ID != acc.ID {
		t.Fatalf("expected account %s, got %s", acc.ID, got.ID)
	}

	claimed, err := r.ConsumeClaimToken(ctx, "brave-otter-abc123", tokenHash, now)
	if err != nil {
		t.Fatalf("ConsumeClaimToken: %v", err)
	}
	if claimed.ID != acc.ID {
		t.Fatalf("expected claimed account %s, got %s", acc.ID, claimed.ID)
	}

	// Single use: replaying the same token must fail.
	if _, err := r.ConsumeClaimToken(ctx, "brave-otter-abc123", tokenHash, now); err != ErrClaimInvalid {
		t.Fatalf("expected ErrClaimInvalid on reuse, got %v", err)
	}

	cred := Credential{
		ID:         []byte{1, 2, 3, 4},
		AccountID:  acc.ID,
		PublicKey:  []byte("pubkey-bytes"),
		Transports: "internal",
		SignCount:  0,
		CreatedAt:  now,
	}
	if err := r.AddCredential(ctx, cred); err != nil {
		t.Fatalf("AddCredential: %v", err)
	}

	creds, err := r.CredentialsByAccount(ctx, acc.ID)
	if err != nil {
		t.Fatalf("CredentialsByAccount: %v", err)
	}
	if len(creds) != 1 {
		t.Fatalf("expected 1 credential, got %d", len(creds))
	}

	if err := r.TouchCredential(ctx, cred.ID, 5, now.Add(time.Minute)); err != nil {
		t.Fatalf("TouchCredential: %v", err)
	}
	creds, err = r.CredentialsByAccount(ctx, acc.ID)
	if err != nil {
		t.Fatalf("CredentialsByAccount after touch: %v", err)
	}
	if creds[0].SignCount != 5 || creds[0].LastAssertedAt == nil {
		t.Fatalf("expected touched credential, got %+v", creds[0])
	}

	env := Envelope{
		AccountID:     acc.ID,
		CredentialRef: "recovery",
		V:             1,
		Nonce:         []byte("nonce-bytes"),
		CT:            []byte("ciphertext-bytes"),
		MAC:           []byte("mac-bytes"),
	}
	if err := r.PutEnvelope(ctx, env); err != nil {
		t.Fatalf("PutEnvelope: %v", err)
	}

	gotEnv, err := r.GetEnvelope(ctx, acc.ID, "recovery")
	if err != nil {
		t.Fatalf("GetEnvelope: %v", err)
	}
	if string(gotEnv.CT) != "ciphertext-bytes" {
		t.Fatalf("unexpected envelope ct: %q", gotEnv.CT)
	}

	// Upsert: same account_id+credential_ref overwrites in place.
	env.CT = []byte("new-ciphertext")
	if err := r.PutEnvelope(ctx, env); err != nil {
		t.Fatalf("PutEnvelope (update): %v", err)
	}
	envs, err := r.ListEnvelopes(ctx, acc.ID)
	if err != nil {
		t.Fatalf("ListEnvelopes: %v", err)
	}
	if len(envs) != 1 || string(envs[0].CT) != "new-ciphertext" {
		t.Fatalf("expected 1 updated envelope, got %+v", envs)
	}

	if err := r.SetRecoveryVerifier(ctx, acc.ID, []byte("verifier-hash")); err != nil {
		t.Fatalf("SetRecoveryVerifier: %v", err)
	}

	if err := r.SetLossAck(ctx, acc.ID, now); err != nil {
		t.Fatalf("SetLossAck: %v", err)
	}
	got, err = r.AccountBySubdomain(ctx, "brave-otter-abc123")
	if err != nil {
		t.Fatalf("AccountBySubdomain after loss-ack: %v", err)
	}
	if got.LossAckAt == nil {
		t.Fatalf("expected loss ack set")
	}

	accounts, err := r.ListAccounts(ctx)
	if err != nil {
		t.Fatalf("ListAccounts: %v", err)
	}
	if len(accounts) != 1 {
		t.Fatalf("expected 1 account, got %d", len(accounts))
	}

	if err := r.DeleteAccount(ctx, "brave-otter-abc123"); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}
	accounts, err = r.ListAccounts(ctx)
	if err != nil {
		t.Fatalf("ListAccounts after delete: %v", err)
	}
	if len(accounts) != 0 {
		t.Fatalf("expected 0 accounts after delete, got %d", len(accounts))
	}
}

func TestResetClaim(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()

	if _, err := r.CreateAccount(ctx, "acc-2", "quiet-fox-def456", []byte("old-hash"), now.Add(time.Hour), now); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}

	newHash := []byte("new-hash")
	if err := r.ResetClaim(ctx, "quiet-fox-def456", newHash, now.Add(24*time.Hour)); err != nil {
		t.Fatalf("ResetClaim: %v", err)
	}

	// The old (pre-reset) token hash must no longer work.
	if _, err := r.ConsumeClaimToken(ctx, "quiet-fox-def456", []byte("old-hash"), now); err != ErrClaimInvalid {
		t.Fatalf("expected ErrClaimInvalid for stale hash, got %v", err)
	}
	// The reset hash works.
	if _, err := r.ConsumeClaimToken(ctx, "quiet-fox-def456", newHash, now); err != nil {
		t.Fatalf("ConsumeClaimToken with reset hash: %v", err)
	}
}

func TestConsumeClaimToken_ExpiredAndUnknown(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()

	tokenHash := []byte("expiring-hash")
	if _, err := r.CreateAccount(ctx, "acc-3", "sleepy-owl-ghi789", tokenHash, now.Add(-time.Minute), now.Add(-time.Hour)); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	if _, err := r.ConsumeClaimToken(ctx, "sleepy-owl-ghi789", tokenHash, now); err != ErrClaimInvalid {
		t.Fatalf("expected ErrClaimInvalid for expired claim, got %v", err)
	}
	if _, err := r.ConsumeClaimToken(ctx, "no-such-subdomain", tokenHash, now); err != ErrClaimInvalid {
		t.Fatalf("expected ErrClaimInvalid for unknown subdomain, got %v", err)
	}
}
