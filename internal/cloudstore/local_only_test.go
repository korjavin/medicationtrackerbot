package cloudstore

import (
	"crypto/sha256"
	"errors"
	"testing"
	"time"
)

// localOnlyCred is a minimal credential row for the POC tests.
func localOnlyCred(accountID string, id []byte) Credential {
	return Credential{
		ID:        id,
		AccountID: accountID,
		PublicKey: []byte("pubkey"),
		CreatedAt: time.Now().UTC(),
	}
}

// TestClaimAndAddLocalOnlyCredential_AtomicEnrollment pins the POC's core
// storage contract (bd med-eas.2.1): the credential is typed local_only, no
// per-credential envelope exists, and the recovery envelope + verifier landed in
// the same transaction — the account's only server-side path to the DEK.
func TestClaimAndAddLocalOnlyCredential_AtomicEnrollment(t *testing.T) {
	r := setupRepo(t)
	now := time.Now().UTC()
	tokenHash := sha256.Sum256([]byte("claim-token"))
	if _, err := r.CreateAccount(t.Context(), "acct-1", "sub-1", tokenHash[:], now.Add(time.Hour), now, "vp", "vs", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}

	verifier := []byte("verifier-bytes")
	verifierHash := sha256.Sum256(verifier)
	recEnv := Envelope{V: 1, Nonce: []byte("nonce"), CT: []byte("ct"), MAC: []byte("mac")}
	if _, err := r.ClaimAndAddLocalOnlyCredential(t.Context(), "sub-1", tokenHash[:], localOnlyCred("acct-1", []byte("cred-1")), recEnv, verifierHash[:], now); err != nil {
		t.Fatalf("ClaimAndAddLocalOnlyCredential: %v", err)
	}

	creds, err := r.CredentialsByAccount(t.Context(), "acct-1")
	if err != nil || len(creds) != 1 {
		t.Fatalf("CredentialsByAccount: %d creds, err %v", len(creds), err)
	}
	if creds[0].KeyMode != KeyModeLocalOnly {
		t.Fatalf("KeyMode = %q, want %q", creds[0].KeyMode, KeyModeLocalOnly)
	}

	envs, err := r.ListEnvelopes(t.Context(), "acct-1")
	if err != nil {
		t.Fatalf("ListEnvelopes: %v", err)
	}
	if len(envs) != 1 || envs[0].CredentialRef != "recovery" {
		t.Fatalf("envelopes = %+v, want exactly one 'recovery' envelope and no credential envelope", envs)
	}

	// The verifier is usable, i.e. recovery actually works for this account —
	// not merely that a row exists.
	if err := r.VerifyRecoveryAttempt(t.Context(), "acct-1", verifierHash[:], now); err != nil {
		t.Fatalf("VerifyRecoveryAttempt: %v", err)
	}

	// One claim, one credential: the token is spent.
	if _, err := r.ConsumeClaimToken(t.Context(), "sub-1", tokenHash[:], now); !errors.Is(err, ErrClaimInvalid) {
		t.Fatalf("claim should be spent, got %v", err)
	}
}

// TestClaimAndAddLocalOnlyCredential_RollsBackOnFailure: a local-only account
// with a credential but no recovery material would be one cleared-site-data away
// from unrecoverable, so the enrollment must be all-or-nothing. Force the last
// statement to fail (duplicate credential id) and assert nothing at all landed —
// including that the claim is still spendable, so the user can simply retry.
func TestClaimAndAddLocalOnlyCredential_RollsBackOnFailure(t *testing.T) {
	r := setupRepo(t)
	now := time.Now().UTC()

	// A pre-existing account owning the credential id we are about to reuse.
	// credentials.id is a global primary key, so the INSERT collides.
	otherHash := sha256.Sum256([]byte("other-token"))
	if _, err := r.CreateAccount(t.Context(), "acct-0", "sub-0", otherHash[:], now.Add(time.Hour), now, "vp", "vs", ""); err != nil {
		t.Fatalf("CreateAccount other: %v", err)
	}
	if err := r.AddCredential(t.Context(), localOnlyCred("acct-0", []byte("dup-cred"))); err != nil {
		t.Fatalf("AddCredential: %v", err)
	}

	tokenHash := sha256.Sum256([]byte("claim-token"))
	if _, err := r.CreateAccount(t.Context(), "acct-1", "sub-1", tokenHash[:], now.Add(time.Hour), now, "vp", "vs", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	verifierHash := sha256.Sum256([]byte("verifier"))
	recEnv := Envelope{V: 1, Nonce: []byte("nonce"), CT: []byte("ct"), MAC: []byte("mac")}
	if _, err := r.ClaimAndAddLocalOnlyCredential(t.Context(), "sub-1", tokenHash[:], localOnlyCred("acct-1", []byte("dup-cred")), recEnv, verifierHash[:], now); err == nil {
		t.Fatal("expected duplicate credential id to fail the enrollment")
	}

	envs, err := r.ListEnvelopes(t.Context(), "acct-1")
	if err != nil || len(envs) != 0 {
		t.Fatalf("expected no envelopes after rollback, got %d (err %v)", len(envs), err)
	}
	if _, err := r.ConsumeClaimToken(t.Context(), "sub-1", tokenHash[:], now); err != nil {
		t.Fatalf("claim should still be spendable after rollback, got %v", err)
	}
}

// TestRedeemLocalOnlyTransferToken_RequiresRecoveryMaterial: a local-only
// credential is not a server-side unwrap path, so adding one to an account that
// has none would produce exactly the stranded state the last-credential guard
// exists to prevent. The check lives inside the transaction, so the slot must
// also survive the refusal.
func TestRedeemLocalOnlyTransferToken_RequiresRecoveryMaterial(t *testing.T) {
	r := setupRepo(t)
	now := time.Now().UTC()
	tokenHash := sha256.Sum256([]byte("claim-token"))
	if _, err := r.CreateAccount(t.Context(), "acct-1", "sub-1", tokenHash[:], now.Add(time.Hour), now, "vp", "vs", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	env := Envelope{AccountID: "acct-1", CredentialRef: "Y3JlZC1wcmY", V: 1, Nonce: []byte("n"), CT: []byte("c"), MAC: []byte("m")}
	if _, err := r.ClaimAndAddCredential(t.Context(), "sub-1", tokenHash[:], localOnlyCred("acct-1", []byte("cred-prf")), env, now); err != nil {
		t.Fatalf("ClaimAndAddCredential: %v", err)
	}

	enrollHash := sha256.Sum256([]byte("enrollment-token"))
	if err := r.CreateClaimedTransferSlot(t.Context(), "slot-1", "acct-1", enrollHash[:], now, now.Add(time.Hour)); err != nil {
		t.Fatalf("CreateClaimedTransferSlot: %v", err)
	}

	err := r.RedeemLocalOnlyTransferToken(t.Context(), "acct-1", enrollHash[:], localOnlyCred("acct-1", []byte("cred-local")), now)
	if !errors.Is(err, ErrNoRecoveryMaterial) {
		t.Fatalf("RedeemLocalOnlyTransferToken = %v, want ErrNoRecoveryMaterial", err)
	}
	creds, _ := r.CredentialsByAccount(t.Context(), "acct-1")
	if len(creds) != 1 {
		t.Fatalf("expected the credential insert to roll back, got %d credentials", len(creds))
	}

	verifierHash := sha256.Sum256([]byte("verifier"))
	if err := r.SetRecoveryMaterial(t.Context(), "acct-1", Envelope{V: 1, Nonce: []byte("n"), CT: []byte("c"), MAC: []byte("m")}, verifierHash[:]); err != nil {
		t.Fatalf("SetRecoveryMaterial: %v", err)
	}
	// The refused attempt rolled back, so the same slot is still redeemable.
	if err := r.RedeemLocalOnlyTransferToken(t.Context(), "acct-1", enrollHash[:], localOnlyCred("acct-1", []byte("cred-local")), now); err != nil {
		t.Fatalf("RedeemLocalOnlyTransferToken with recovery material: %v", err)
	}
	creds, _ = r.CredentialsByAccount(t.Context(), "acct-1")
	if len(creds) != 2 {
		t.Fatalf("expected 2 credentials, got %d", len(creds))
	}
	// Still no envelope for the local-only credential.
	envs, _ := r.ListEnvelopes(t.Context(), "acct-1")
	for _, e := range envs {
		if e.CredentialRef == "Y3JlZC1sb2NhbA" {
			t.Fatalf("local-only credential must have no envelope, found %+v", e)
		}
	}
}

// TestDeleteCredential_LocalOnlyIsNotAnUnwrapPath: a local-only credential can
// authenticate but cannot unwrap anything server-side, so it must not satisfy
// the "the account still has a way in" guard when the last PRF credential is
// revoked. Otherwise revoking the real credential on a mixed account would slip
// past the recovery-material check.
func TestDeleteCredential_LocalOnlyIsNotAnUnwrapPath(t *testing.T) {
	r := setupRepo(t)
	now := time.Now().UTC()
	tokenHash := sha256.Sum256([]byte("claim-token"))
	if _, err := r.CreateAccount(t.Context(), "acct-1", "sub-1", tokenHash[:], now.Add(time.Hour), now, "vp", "vs", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	env := Envelope{AccountID: "acct-1", CredentialRef: "Y3JlZC1wcmY", V: 1, Nonce: []byte("n"), CT: []byte("c"), MAC: []byte("m")}
	if _, err := r.ClaimAndAddCredential(t.Context(), "sub-1", tokenHash[:], localOnlyCred("acct-1", []byte("cred-prf")), env, now); err != nil {
		t.Fatalf("ClaimAndAddCredential: %v", err)
	}
	// A second, local-only credential — and deliberately NO recovery material,
	// which is the state this guard has to catch.
	if _, err := r.db.ExecContext(t.Context(),
		`INSERT INTO credentials (id, account_id, public_key, transports, sign_count, backup_eligible, backup_state, created_at_unix, key_mode)
		 VALUES ('cred-local', 'acct-1', 'pk', '', 0, 0, 0, 0, ?)`, KeyModeLocalOnly); err != nil {
		t.Fatalf("insert local-only credential: %v", err)
	}

	err := r.DeleteCredentialWithEnvelope(t.Context(), "acct-1", []byte("cred-prf"))
	if !errors.Is(err, ErrLastCredential) {
		t.Fatalf("DeleteCredentialWithEnvelope = %v, want ErrLastCredential (a local-only credential is not an unwrap path)", err)
	}

	// With recovery material in place the same revocation is allowed, so the
	// guard is about the unwrap path, not about blocking local-only accounts.
	verifierHash := sha256.Sum256([]byte("verifier"))
	if err := r.SetRecoveryMaterial(t.Context(), "acct-1", Envelope{V: 1, Nonce: []byte("n"), CT: []byte("c"), MAC: []byte("m")}, verifierHash[:]); err != nil {
		t.Fatalf("SetRecoveryMaterial: %v", err)
	}
	if err := r.DeleteCredentialWithEnvelope(t.Context(), "acct-1", []byte("cred-prf")); err != nil {
		t.Fatalf("DeleteCredentialWithEnvelope with recovery material: %v", err)
	}
}
