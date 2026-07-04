package cloudstore

import (
	"context"
	"database/sql"
	"errors"
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

	// After the account is claimed (token cleared by ConsumeClaimToken above),
	// reset-claim must refuse to reopen it — a stale invite link cannot enroll a
	// fresh passkey onto a live account.
	if err := r.ResetClaim(ctx, "quiet-fox-def456", []byte("another-hash"), now.Add(48*time.Hour)); !errors.Is(err, ErrAlreadyClaimed) {
		t.Fatalf("ResetClaim on claimed account = %v, want ErrAlreadyClaimed", err)
	}

	// A non-existent subdomain still reports ErrNoRows, not ErrAlreadyClaimed.
	if err := r.ResetClaim(ctx, "no-such-sub", []byte("hash"), now.Add(time.Hour)); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("ResetClaim on missing subdomain = %v, want sql.ErrNoRows", err)
	}
}

func TestClaimAndAddCredential(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()

	tokenHash := []byte("claimtokenhash-32-bytes-of-junk")
	acc, err := r.CreateAccount(ctx, "acc-3", "eager-lynx-jkl012", tokenHash, now.Add(time.Hour), now)
	if err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}

	cred := Credential{ID: []byte{9, 8, 7}, AccountID: acc.ID, PublicKey: []byte("pk"), Transports: "internal", CreatedAt: now}
	env := Envelope{AccountID: acc.ID, CredentialRef: "CQgH", V: 1, Nonce: []byte("nonce"), CT: []byte("ciphertext"), MAC: []byte("mac")}
	claimed, err := r.ClaimAndAddCredential(ctx, acc.Subdomain, tokenHash, cred, env, now)
	if err != nil {
		t.Fatalf("ClaimAndAddCredential: %v", err)
	}
	if claimed.ID != acc.ID {
		t.Fatalf("expected claimed account %s, got %s", acc.ID, claimed.ID)
	}

	// Credential, envelope, and claim consumption all committed together.
	creds, err := r.CredentialsByAccount(ctx, acc.ID)
	if err != nil || len(creds) != 1 {
		t.Fatalf("expected 1 credential, got %d (err %v)", len(creds), err)
	}
	got, err := r.GetEnvelope(ctx, acc.ID, "CQgH")
	if err != nil || string(got.CT) != "ciphertext" {
		t.Fatalf("expected envelope stored atomically, got %+v (err %v)", got, err)
	}
	if _, err := r.ClaimAndAddCredential(ctx, acc.Subdomain, tokenHash, cred, env, now); err != ErrClaimInvalid {
		t.Fatalf("expected ErrClaimInvalid on replay, got %v", err)
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

// TestDeleteCredentialWithEnvelope_NeverStrandsAccount verifies the "never
// strand the account" invariant is enforced inside DeleteCredentialWithEnvelope
// itself (not just the handler pre-check), so it holds under concurrent
// revocations: deleting down to the last credential is blocked unless a
// recovery envelope remains as an unwrap path.
func TestDeleteCredentialWithEnvelope_NeverStrandsAccount(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()

	if _, err := r.CreateAccount(ctx, "acc-strand", "brave-otter-strand1", []byte("h"), now.Add(time.Hour), now); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	credA := Credential{ID: []byte{1}, AccountID: "acc-strand", PublicKey: []byte("pkA"), CreatedAt: now}
	credB := Credential{ID: []byte{2}, AccountID: "acc-strand", PublicKey: []byte("pkB"), CreatedAt: now}
	for _, c := range []Credential{credA, credB} {
		if err := r.AddCredential(ctx, c); err != nil {
			t.Fatalf("AddCredential: %v", err)
		}
	}

	// Removing one of two credentials is fine.
	if err := r.DeleteCredentialWithEnvelope(ctx, "acc-strand", credA.ID); err != nil {
		t.Fatalf("delete first credential: %v", err)
	}
	// Removing the last credential with no recovery envelope must be refused.
	if err := r.DeleteCredentialWithEnvelope(ctx, "acc-strand", credB.ID); err != ErrLastCredential {
		t.Fatalf("delete last credential: got %v, want ErrLastCredential", err)
	}
	// The credential must still be present (the delete rolled back).
	creds, err := r.CredentialsByAccount(ctx, "acc-strand")
	if err != nil || len(creds) != 1 {
		t.Fatalf("expected the last credential to survive, got len %d err %v", len(creds), err)
	}

	// With a recovery envelope in place, removing the last credential succeeds.
	if err := r.PutEnvelope(ctx, Envelope{AccountID: "acc-strand", CredentialRef: "recovery", V: 1, Nonce: []byte("n"), CT: []byte("c"), MAC: []byte("m")}); err != nil {
		t.Fatalf("PutEnvelope(recovery): %v", err)
	}
	if err := r.DeleteCredentialWithEnvelope(ctx, "acc-strand", credB.ID); err != nil {
		t.Fatalf("delete last credential with recovery envelope: %v", err)
	}
}
