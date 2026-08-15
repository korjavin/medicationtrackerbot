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

func TestSubdomainByAccount(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()

	if _, err := r.CreateAccount(ctx, "acc-sub", "brave-otter-xyz789", []byte("h"), now.Add(time.Hour), now, "", "", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	got, err := r.SubdomainByAccount(ctx, "acc-sub")
	if err != nil {
		t.Fatalf("SubdomainByAccount: %v", err)
	}
	if got != "brave-otter-xyz789" {
		t.Fatalf("subdomain = %q, want brave-otter-xyz789", got)
	}
	if _, err := r.SubdomainByAccount(ctx, "nope"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("unknown account err = %v, want sql.ErrNoRows", err)
	}
}

func TestAccountCredentialEnvelopeRoundtrip(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()

	tokenHash := []byte("claimtokenhash-32-bytes-of-junk")
	acc, err := r.CreateAccount(ctx, "acc-1", "brave-otter-abc123", tokenHash, now.Add(14*24*time.Hour), now, "", "", "")
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

	// A push subscription and a future-dated scheduled push must be cascaded
	// away by DeleteAccount. Orphaned scheduled_pushes are re-selected by
	// DueScheduledPushes every relay tick, and AccountVAPIDKeysByID then errors
	// (no account row) so the relay never marks them sent — a permanent wedge.
	if err := r.UpsertPushSubscription(ctx, acc.ID, "https://push.example/endpoint", "p256dh", "auth", now); err != nil {
		t.Fatalf("UpsertPushSubscription: %v", err)
	}
	if err := r.ReplaceSchedule(ctx, acc.ID, []ScheduledPushInput{{FireAt: now.Add(time.Hour), CT: []byte("ct")}}, now); err != nil {
		t.Fatalf("ReplaceSchedule: %v", err)
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

	subs, err := r.List(ctx, acc.ID)
	if err != nil {
		t.Fatalf("List subscriptions after delete: %v", err)
	}
	if len(subs) != 0 {
		t.Fatalf("expected 0 push subscriptions after delete, got %d", len(subs))
	}
	due, err := r.DueScheduledPushes(ctx, now.Add(48*time.Hour))
	if err != nil {
		t.Fatalf("DueScheduledPushes after delete: %v", err)
	}
	for _, p := range due {
		if p.AccountID == acc.ID {
			t.Fatalf("expected no scheduled pushes for deleted account, found id=%d", p.ID)
		}
	}
}

// TestSetAccountVAPIDKeys_NeverRotates guards the backfill-only invariant
// directly: SetAccountVAPIDKeys must silently no-op on an account that already
// has keys. Rotating a live keypair would orphan every push subscription bound
// to the old subscribe-time key. The existing backfill tests only prove the
// AccountIDsMissingVAPIDKeys filter skips keyed accounts, so dropping the
// `AND vapid_public_key IS NULL` clause would still pass them — this exercises
// the guard head-on.
func TestSetAccountVAPIDKeys_NeverRotates(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()

	if _, err := r.CreateAccount(ctx, "acc-vapid", "vapid-sub", []byte("h"), now.Add(time.Hour), now, "pub-original", "priv-original", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}

	// Attempting to set keys on an already-keyed account must leave them intact.
	if err := r.SetAccountVAPIDKeys(ctx, "acc-vapid", "pub-rotated", "priv-rotated"); err != nil {
		t.Fatalf("SetAccountVAPIDKeys: %v", err)
	}
	keys, err := r.AccountVAPIDKeysByID(ctx, "acc-vapid")
	if err != nil {
		t.Fatalf("AccountVAPIDKeysByID: %v", err)
	}
	if keys.PublicKey != "pub-original" || keys.PrivateKey != "priv-original" {
		t.Fatalf("expected keys left untouched, got %+v", keys)
	}
}

func TestResetClaim(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()

	if _, err := r.CreateAccount(ctx, "acc-2", "quiet-fox-def456", []byte("old-hash"), now.Add(time.Hour), now, "", "", ""); err != nil {
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
	acc, err := r.CreateAccount(ctx, "acc-3", "eager-lynx-jkl012", tokenHash, now.Add(time.Hour), now, "", "", "")
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
	if _, err := r.CreateAccount(ctx, "acc-3", "sleepy-owl-ghi789", tokenHash, now.Add(-time.Minute), now.Add(-time.Hour), "", "", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	if _, err := r.ConsumeClaimToken(ctx, "sleepy-owl-ghi789", tokenHash, now); err != ErrClaimInvalid {
		t.Fatalf("expected ErrClaimInvalid for expired claim, got %v", err)
	}
	if _, err := r.ConsumeClaimToken(ctx, "no-such-subdomain", tokenHash, now); err != ErrClaimInvalid {
		t.Fatalf("expected ErrClaimInvalid for unknown subdomain, got %v", err)
	}
}

func TestClaimedAccountIDForCreator(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()

	// A claimed account minted by tg:42 (claim_token_hash cleared on consume).
	tokenHash := []byte("claim-hash-for-tg42-account-junk")
	acc, err := r.CreateAccount(ctx, "acc-tg42", "brave-otter-mno345", tokenHash, now.Add(time.Hour), now, "", "", "tg:42")
	if err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	if _, err := r.ConsumeClaimToken(ctx, acc.Subdomain, tokenHash, now); err != nil {
		t.Fatalf("ConsumeClaimToken: %v", err)
	}

	// An unclaimed (pending) account minted by tg:99 — must not resolve.
	if _, err := r.CreateAccount(ctx, "acc-tg99", "shy-heron-pqr678", []byte("pending-hash"), now.Add(time.Hour), now, "", "", "tg:99"); err != nil {
		t.Fatalf("CreateAccount pending: %v", err)
	}

	got, err := r.ClaimedAccountIDForCreator(ctx, "tg:42")
	if err != nil {
		t.Fatalf("ClaimedAccountIDForCreator(tg:42): %v", err)
	}
	if got != acc.ID {
		t.Fatalf("tg:42 = %q, want %q", got, acc.ID)
	}

	if got, err := r.ClaimedAccountIDForCreator(ctx, "tg:99"); err != nil || got != "" {
		t.Fatalf("tg:99 (pending) = %q err %v, want empty", got, err)
	}
	if got, err := r.ClaimedAccountIDForCreator(ctx, "tg:404"); err != nil || got != "" {
		t.Fatalf("tg:404 (unknown) = %q err %v, want empty", got, err)
	}
	if got, err := r.ClaimedAccountIDForCreator(ctx, ""); err != nil || got != "" {
		t.Fatalf("empty creator = %q err %v, want empty", got, err)
	}

	// A second claimed account by tg:42 → still resolves (to the oldest).
	tokenHash2 := []byte("claim-hash-for-tg42-second-junkkk")
	acc2, err := r.CreateAccount(ctx, "acc-tg42b", "keen-vole-stu901", tokenHash2, now.Add(time.Hour), now.Add(time.Minute), "", "", "tg:42")
	if err != nil {
		t.Fatalf("CreateAccount second: %v", err)
	}
	if _, err := r.ConsumeClaimToken(ctx, acc2.Subdomain, tokenHash2, now); err != nil {
		t.Fatalf("ConsumeClaimToken second: %v", err)
	}
	if got, err := r.ClaimedAccountIDForCreator(ctx, "tg:42"); err != nil || got != acc.ID {
		t.Fatalf("tg:42 with two claimed = %q err %v, want oldest %q", got, err, acc.ID)
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

	if _, err := r.CreateAccount(ctx, "acc-strand", "brave-otter-strand1", []byte("h"), now.Add(time.Hour), now, "", "", ""); err != nil {
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

	// A recovery envelope alone is NOT enough: recovery also needs the verifier
	// row (VerifyRecoveryAttempt fails without it), so deleting the last
	// credential must still be refused to avoid a permanent strand.
	if err := r.PutEnvelope(ctx, Envelope{AccountID: "acc-strand", CredentialRef: "recovery", V: 1, Nonce: []byte("n"), CT: []byte("c"), MAC: []byte("m")}); err != nil {
		t.Fatalf("PutEnvelope(recovery): %v", err)
	}
	if err := r.DeleteCredentialWithEnvelope(ctx, "acc-strand", credB.ID); err != ErrLastCredential {
		t.Fatalf("delete last credential with envelope but no verifier: got %v, want ErrLastCredential", err)
	}

	// With BOTH the recovery envelope and the verifier in place, the recovery
	// path is complete and removing the last credential succeeds.
	if err := r.SetRecoveryVerifier(ctx, "acc-strand", []byte("verifier-hash")); err != nil {
		t.Fatalf("SetRecoveryVerifier: %v", err)
	}
	if err := r.DeleteCredentialWithEnvelope(ctx, "acc-strand", credB.ID); err != nil {
		t.Fatalf("delete last credential with recovery envelope + verifier: %v", err)
	}
}

// TestCredentialExists_ScopedToAccount is the med-yor.12 regression test:
// credentials.id is a global PRIMARY KEY, so once a revoked device's credential
// is deleted its id bytes are free for another account to re-register. If
// CredentialExists ignored account_id, account A's still-valid (unexpired)
// session token — which RequireSession admits solely on "does this credential
// id still exist" — would be resurrected by account B re-registering the same
// id, defeating A's device revocation. The account_id predicate must make the
// existence check owner-specific: false for A, true for B.
func TestCredentialExists_ScopedToAccount(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()

	if _, err := r.CreateAccount(ctx, "acc-A", "brave-otter-aaa111", []byte("hA"), now.Add(time.Hour), now, "", "", ""); err != nil {
		t.Fatalf("CreateAccount A: %v", err)
	}
	if _, err := r.CreateAccount(ctx, "acc-B", "brave-otter-bbb222", []byte("hB"), now.Add(time.Hour), now, "", "", ""); err != nil {
		t.Fatalf("CreateAccount B: %v", err)
	}

	reused := []byte{7, 7, 7, 7}
	// A owns the reused id plus a keeper credential, so revoking the reused one
	// doesn't trip the never-strand guard.
	for _, c := range []Credential{
		{ID: reused, AccountID: "acc-A", PublicKey: []byte("pkA"), CreatedAt: now},
		{ID: []byte{8, 8, 8, 8}, AccountID: "acc-A", PublicKey: []byte("pkKeep"), CreatedAt: now},
	} {
		if err := r.AddCredential(ctx, c); err != nil {
			t.Fatalf("AddCredential (A): %v", err)
		}
	}

	// Revoke A's device, vacating the id's PRIMARY KEY slot.
	if err := r.DeleteCredentialWithEnvelope(ctx, "acc-A", reused); err != nil {
		t.Fatalf("DeleteCredentialWithEnvelope (A revoke): %v", err)
	}
	// B re-registers a credential with the SAME id bytes.
	if err := r.AddCredential(ctx, Credential{ID: reused, AccountID: "acc-B", PublicKey: []byte("pkB"), CreatedAt: now}); err != nil {
		t.Fatalf("AddCredential (B re-register same id): %v", err)
	}

	// A's revoked credential must read as gone for A (its old token is rejected)...
	existsForA, err := r.CredentialExists(ctx, "acc-A", reused)
	if err != nil {
		t.Fatalf("CredentialExists(acc-A): %v", err)
	}
	if existsForA {
		t.Fatal("revoked credential still reported present for acc-A: device revocation is bypassable via cross-account id reuse")
	}
	// ...while B legitimately owns it.
	existsForB, err := r.CredentialExists(ctx, "acc-B", reused)
	if err != nil {
		t.Fatalf("CredentialExists(acc-B): %v", err)
	}
	if !existsForB {
		t.Fatal("re-registered credential not reported present for its real owner acc-B")
	}
}

// TestScheduledPushDeliveryRoundtrip guards the C3b column addition
// (010_push_delivery.sql): a telegram entry carries its plaintext through
// ReplaceSchedule → DueScheduledPushes, and an entry inserted with no delivery
// reads back as webpush so pre-C3b clients keep firing exactly as before.
func TestScheduledPushDeliveryRoundtrip(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()

	acc, err := r.CreateAccount(ctx, "acc-tg", "keen-heron-def456", []byte("hash"), now.Add(time.Hour), now, "", "", "")
	if err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}

	past := now.Add(-time.Minute)
	if err := r.ReplaceSchedule(ctx, acc.ID, []ScheduledPushInput{
		{FireAt: past, CT: []byte("ct-legacy")}, // no Delivery → webpush
		{FireAt: past, Delivery: DeliveryTelegram, TGText: "Time to take: Lisinopril"},
		{FireAt: past, Delivery: DeliveryBoth, CT: []byte("ct-both"), TGText: "Medication time"},
	}, now); err != nil {
		t.Fatalf("ReplaceSchedule: %v", err)
	}

	due, err := r.DueScheduledPushes(ctx, now)
	if err != nil {
		t.Fatalf("DueScheduledPushes: %v", err)
	}
	if len(due) != 3 {
		t.Fatalf("expected 3 due entries, got %d", len(due))
	}

	byDelivery := map[string]ScheduledPush{}
	for _, p := range due {
		byDelivery[p.Delivery] = p
	}
	legacy, ok := byDelivery[DeliveryWebPush]
	if !ok {
		t.Fatalf("entry with no delivery did not default to %q: %+v", DeliveryWebPush, due)
	}
	if string(legacy.CT) != "ct-legacy" || legacy.TGText != "" {
		t.Errorf("legacy entry round-tripped wrong: %+v", legacy)
	}
	tg, ok := byDelivery[DeliveryTelegram]
	if !ok {
		t.Fatalf("missing telegram entry: %+v", due)
	}
	if tg.TGText != "Time to take: Lisinopril" || len(tg.CT) != 0 {
		t.Errorf("telegram entry round-tripped wrong: %+v", tg)
	}
	both, ok := byDelivery[DeliveryBoth]
	if !ok {
		t.Fatalf("missing both entry: %+v", due)
	}
	if string(both.CT) != "ct-both" || both.TGText != "Medication time" {
		t.Errorf("both entry round-tripped wrong: %+v", both)
	}
}

// TestMarkPushSentClearsPayload pins bd med-yor.13: once a scheduled push has
// fired, MarkPushSent must wipe ct/tg_text/tg_callback so Telegram plaintext
// (med name + dose) doesn't linger at rest. Every post-send reader filters on
// sent_at_unix IS NULL, so the emptied row is safe.
func TestMarkPushSentClearsPayload(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()

	acc, err := r.CreateAccount(ctx, "acc-clear", "keen-heron-ghi789", []byte("hash"), now.Add(time.Hour), now, "", "", "")
	if err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}

	past := now.Add(-time.Minute)
	if err := r.ReplaceSchedule(ctx, acc.ID, []ScheduledPushInput{
		{FireAt: past, Delivery: DeliveryBoth, CT: []byte("secret-ct"), TGText: "Time to take: Lisinopril", TGCallback: "cb-stem"},
	}, now); err != nil {
		t.Fatalf("ReplaceSchedule: %v", err)
	}

	due, err := r.DueScheduledPushes(ctx, now)
	if err != nil {
		t.Fatalf("DueScheduledPushes: %v", err)
	}
	if len(due) != 1 {
		t.Fatalf("expected 1 due entry, got %d", len(due))
	}

	if err := r.MarkPushSent(ctx, due[0].ID, now); err != nil {
		t.Fatalf("MarkPushSent: %v", err)
	}

	var (
		ct         []byte
		tgText     string
		tgCallback string
		sentUnix   sql.NullInt64
	)
	if err := r.db.QueryRowContext(ctx,
		`SELECT ct, tg_text, tg_callback, sent_at_unix FROM scheduled_pushes WHERE id = ?`, due[0].ID).
		Scan(&ct, &tgText, &tgCallback, &sentUnix); err != nil {
		t.Fatalf("read sent row: %v", err)
	}
	if len(ct) != 0 || tgText != "" || tgCallback != "" {
		t.Errorf("sent row still holds payload: ct=%q tg_text=%q tg_callback=%q", ct, tgText, tgCallback)
	}
	if !sentUnix.Valid {
		t.Errorf("sent_at_unix not set after MarkPushSent")
	}
}

// Egress hosts drive the app-document connect-src allowlist; the write path must
// normalize+dedupe (case, whitespace, order) so the persisted list — and thus the
// emitted CSP — is deterministic. An unset account reads back as no hosts, an
// empty write clears to no hosts, and a missing account errors on both sides.
func TestEgressHostsRoundTrip(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()

	if _, err := r.CreateAccount(ctx, "acc-eg", "egress-sub", []byte("h"), now.Add(time.Hour), now, "", "", ""); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}

	// Never set: no hosts, no error.
	got, err := r.EgressHosts(ctx, "acc-eg")
	if err != nil {
		t.Fatalf("EgressHosts (unset): %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("unset account = %v, want no hosts", got)
	}

	// Write with dupes, mixed case, whitespace, and empties → normalized+sorted.
	if err := r.SetEgressHosts(ctx, "acc-eg", []string{"API.OpenAI.com", " fooddb.example.com ", "api.openai.com", "", "api.elevenlabs.io"}); err != nil {
		t.Fatalf("SetEgressHosts: %v", err)
	}
	got, err = r.EgressHosts(ctx, "acc-eg")
	if err != nil {
		t.Fatalf("EgressHosts: %v", err)
	}
	want := []string{"api.elevenlabs.io", "api.openai.com", "fooddb.example.com"}
	if len(got) != len(want) {
		t.Fatalf("hosts = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("hosts = %v, want %v (normalized+deduped+sorted)", got, want)
		}
	}

	// Empty write clears the list back to no hosts (distinct from never-set, same read).
	if err := r.SetEgressHosts(ctx, "acc-eg", nil); err != nil {
		t.Fatalf("SetEgressHosts(nil): %v", err)
	}
	got, err = r.EgressHosts(ctx, "acc-eg")
	if err != nil {
		t.Fatalf("EgressHosts (cleared): %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("cleared account = %v, want no hosts", got)
	}

	// Unknown account errors on both sides.
	if err := r.SetEgressHosts(ctx, "no-such-acc", []string{"x.example.com"}); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("SetEgressHosts(unknown) = %v, want sql.ErrNoRows", err)
	}
	if _, err := r.EgressHosts(ctx, "no-such-acc"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("EgressHosts(unknown) = %v, want sql.ErrNoRows", err)
	}
}

// TestReplaceSchedulePreservesRelayRefire pins med-eas.70: a client re-upload
// (ReplaceSchedule) wipes only the account's own client rows and must leave an
// unsent relay_refire row intact, so a pending workout snooze survives the sync.
func TestReplaceSchedulePreservesRelayRefire(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()

	acc, err := r.CreateAccount(ctx, "acc-refire", "keen-heron-ref019", []byte("hash"), now.Add(time.Hour), now, "", "", "")
	if err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}

	past := now.Add(-time.Minute)
	if err := r.ReplaceSchedule(ctx, acc.ID, []ScheduledPushInput{
		{FireAt: past, Delivery: DeliveryTelegram, TGText: "client reminder", TGCallback: "s:100"},
	}, now); err != nil {
		t.Fatalf("ReplaceSchedule (first): %v", err)
	}
	if err := r.InsertRelayRefire(ctx, acc.ID, past, "workout refire", "w:6:20260720"); err != nil {
		t.Fatalf("InsertRelayRefire: %v", err)
	}

	// A second client upload replaces the batch: the client row is wiped, the
	// relay_refire row survives.
	if err := r.ReplaceSchedule(ctx, acc.ID, []ScheduledPushInput{
		{FireAt: past, Delivery: DeliveryTelegram, TGText: "new client reminder", TGCallback: "s:200"},
	}, now); err != nil {
		t.Fatalf("ReplaceSchedule (second): %v", err)
	}

	due, err := r.DueScheduledPushes(ctx, now)
	if err != nil {
		t.Fatalf("DueScheduledPushes: %v", err)
	}
	byText := map[string]ScheduledPush{}
	for _, p := range due {
		byText[p.TGText] = p
	}
	if _, ok := byText["client reminder"]; ok {
		t.Errorf("stale client row survived ReplaceSchedule: %+v", due)
	}
	if _, ok := byText["new client reminder"]; !ok {
		t.Errorf("new client row missing: %+v", due)
	}
	refire, ok := byText["workout refire"]
	if !ok {
		t.Fatalf("relay_refire row wiped by ReplaceSchedule: %+v", due)
	}
	if refire.Delivery != DeliveryTelegram || refire.TGCallback != "w:6:20260720" || len(refire.CT) != 0 {
		t.Errorf("relay_refire round-tripped wrong: %+v", refire)
	}
}

// TestCancelRelayRefire pins med-eas.70: a workout skip cancels only matching
// unsent refires — not sent ones, not other callbacks, not other accounts.
func TestCancelRelayRefire(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()

	acc, err := r.CreateAccount(ctx, "acc-cancel", "keen-heron-can019", []byte("hash"), now.Add(time.Hour), now, "", "", "")
	if err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}

	past := now.Add(-time.Minute)
	if err := r.InsertRelayRefire(ctx, acc.ID, past, "snooze A", "w:6:20260720"); err != nil {
		t.Fatalf("InsertRelayRefire A: %v", err)
	}
	if err := r.InsertRelayRefire(ctx, acc.ID, past, "snooze B", "w:7:20260720"); err != nil {
		t.Fatalf("InsertRelayRefire B: %v", err)
	}

	// Cancelling a non-matching callback removes nothing.
	if n, err := r.CancelRelayRefire(ctx, acc.ID, "w:999:20260720"); err != nil || n != 0 {
		t.Fatalf("CancelRelayRefire(non-match) = %d, %v; want 0, nil", n, err)
	}
	// Cancelling the matching callback removes exactly one.
	if n, err := r.CancelRelayRefire(ctx, acc.ID, "w:6:20260720"); err != nil || n != 1 {
		t.Fatalf("CancelRelayRefire(match) = %d, %v; want 1, nil", n, err)
	}

	due, err := r.DueScheduledPushes(ctx, now)
	if err != nil {
		t.Fatalf("DueScheduledPushes: %v", err)
	}
	if len(due) != 1 || due[0].TGCallback != "w:7:20260720" {
		t.Fatalf("after cancel, due = %+v; want only w:7 refire", due)
	}

	// A sent refire is never cancelled.
	if err := r.MarkPushSent(ctx, due[0].ID, now); err != nil {
		t.Fatalf("MarkPushSent: %v", err)
	}
	if n, err := r.CancelRelayRefire(ctx, acc.ID, "w:7:20260720"); err != nil || n != 0 {
		t.Fatalf("CancelRelayRefire(sent) = %d, %v; want 0, nil", n, err)
	}
}

// TestRescheduleRelayRefire pins med-eas.70: re-snoozing the same workout session
// supersedes the pending refire (cancel + insert in one transaction) rather than
// stacking a second pending row — so two snooze taps leave exactly one delivery.
func TestRescheduleRelayRefire(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()

	acc, err := r.CreateAccount(ctx, "acc-resched", "keen-heron-res019", []byte("hash"), now.Add(time.Hour), now, "", "", "")
	if err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}

	past := now.Add(-time.Minute)
	if err := r.RescheduleRelayRefire(ctx, acc.ID, past, "snooze 1h", "w:6:20260720", 111); err != nil {
		t.Fatalf("RescheduleRelayRefire (first): %v", err)
	}
	// Re-snooze the same session: the first refire is superseded, not stacked.
	if err := r.RescheduleRelayRefire(ctx, acc.ID, past, "snooze 2h", "w:6:20260720", 222); err != nil {
		t.Fatalf("RescheduleRelayRefire (second): %v", err)
	}

	due, err := r.DueScheduledPushes(ctx, now)
	if err != nil {
		t.Fatalf("DueScheduledPushes: %v", err)
	}
	if len(due) != 1 {
		t.Fatalf("after re-snooze, due = %+v; want exactly one refire row", due)
	}
	if due[0].TGText != "snooze 2h" || due[0].TGCallback != "w:6:20260720" || len(due[0].CT) != 0 {
		t.Errorf("refire not superseded correctly: %+v", due[0])
	}
	// med-eas.79: supersedes_message_id threads out via DueScheduledPushes.
	if due[0].SupersedesMessageID != 222 {
		t.Errorf("SupersedesMessageID = %d; want 222 (prior TG message to delete)", due[0].SupersedesMessageID)
	}

	// med-eas.79: a delayed tap from an OLDER message (lower id) must not regress
	// the pending supersedes below the newer one already queued — else the next
	// re-fire would delete an already-gone message and orphan the live one.
	if err := r.RescheduleRelayRefire(ctx, acc.ID, past, "late tap", "w:6:20260720", 100); err != nil {
		t.Fatalf("RescheduleRelayRefire (regress): %v", err)
	}
	due, err = r.DueScheduledPushes(ctx, now)
	if err != nil {
		t.Fatalf("DueScheduledPushes (after regress): %v", err)
	}
	if len(due) != 1 || due[0].SupersedesMessageID != 222 {
		t.Fatalf("after older-tap reschedule, supersedes must stay 222, got %+v", due)
	}

	// A client-uploaded (ReplaceSchedule) row carries the DEFAULT 0 — nothing to delete.
	if err := r.ReplaceSchedule(ctx, acc.ID, []ScheduledPushInput{
		{FireAt: past, Delivery: DeliveryTelegram, TGText: "orig", TGCallback: "s:9:20260720"},
	}, now); err != nil {
		t.Fatalf("ReplaceSchedule: %v", err)
	}
	due, err = r.DueScheduledPushes(ctx, now)
	if err != nil {
		t.Fatalf("DueScheduledPushes (after ReplaceSchedule): %v", err)
	}
	for _, p := range due {
		if p.TGCallback == "s:9:20260720" && p.SupersedesMessageID != 0 {
			t.Errorf("client row SupersedesMessageID = %d; want 0 (DEFAULT)", p.SupersedesMessageID)
		}
	}
}

// med-eas.79: a pending relay re-fire's supersedes id belongs to the chat that
// was linked when it was scheduled. On a bot relink (UpsertBot) or new /start
// (LinkChat) the chat id-space changes, so the pending re-fire must be cleared —
// otherwise the max-preserve compare in RescheduleRelayRefire could mix ids from
// two chats and delete the wrong message.
func TestRelayRefiresClearedOnChatRelink(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()

	acc, err := r.CreateAccount(ctx, "acc-relink", "keen-heron-rel019", []byte("hash"), now.Add(time.Hour), now, "", "", "")
	if err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}

	scheduleRefire := func() {
		t.Helper()
		if err := r.RescheduleRelayRefire(ctx, acc.ID, now.Add(-time.Minute), "snooze", "s:9:20260720", 5000); err != nil {
			t.Fatalf("RescheduleRelayRefire: %v", err)
		}
	}
	pendingRefires := func() int {
		t.Helper()
		due, err := r.DueScheduledPushes(ctx, now)
		if err != nil {
			t.Fatalf("DueScheduledPushes: %v", err)
		}
		return len(due)
	}

	bot := TGBot{AccountID: acc.ID, BotID: 1, BotUsername: "b", TokenCT: []byte("x"), TokenNonce: []byte("y"), Kind: "byo", WebhookSecret: "s", CreatedAt: now}
	if err := r.UpsertBot(ctx, bot); err != nil {
		t.Fatalf("UpsertBot: %v", err)
	}

	// LinkChat clears the pending re-fire from the prior chat.
	scheduleRefire()
	if got := pendingRefires(); got != 1 {
		t.Fatalf("before LinkChat, pending re-fires = %d; want 1", got)
	}
	if err := r.LinkChat(ctx, acc.ID, 42, now); err != nil {
		t.Fatalf("LinkChat: %v", err)
	}
	if got := pendingRefires(); got != 0 {
		t.Fatalf("LinkChat did not clear pending re-fires: got %d, want 0", got)
	}

	// UpsertBot (relink) clears too.
	scheduleRefire()
	if got := pendingRefires(); got != 1 {
		t.Fatalf("before relink UpsertBot, pending re-fires = %d; want 1", got)
	}
	if err := r.UpsertBot(ctx, bot); err != nil {
		t.Fatalf("UpsertBot (relink): %v", err)
	}
	if got := pendingRefires(); got != 0 {
		t.Fatalf("UpsertBot relink did not clear pending re-fires: got %d, want 0", got)
	}
}

// AccountsNeedingStaleSyncWarning is the ONLY safety net that notices a reminder
// horizon which stopped being re-uploaded — the server cannot compute a
// schedule, so once the browser goes quiet reminders stop forever. Its original
// form could never fire in the state that matters (bd med-2lx):
//
//   - it INNER JOINed a subquery over UNSENT scheduled_pushes rows, so an
//     account whose queue had genuinely run out produced no subquery row and was
//     dropped from the join entirely; and
//   - it gated on last_sync_unix, which every inbox drain touches, so an account
//     alive enough to tap Telegram Confirm buttons always looked freshly synced.
//
// Pin the fixed predicate on both halves, plus the anti-spam guard that dropping
// the sync gate makes necessary.
func TestAccountsNeedingStaleSyncWarning(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	now := time.Now().UTC()

	const (
		dryWithin = 120 * time.Hour
		cooldown  = 24 * time.Hour
	)

	// mkAccount creates an account, gives it a sync_state row stamped at `now`
	// (so every account here looks FRESHLY SYNCED — the old gate would have
	// silenced all of them), and optionally an enabled push subscription.
	mkAccount := func(id, subdomain string, subscribe bool) {
		t.Helper()
		if _, err := r.CreateAccount(ctx, id, subdomain, []byte("hash-"+id), now.Add(time.Hour), now, "", "", ""); err != nil {
			t.Fatalf("CreateAccount(%s): %v", id, err)
		}
		if _, err := r.ListOps(ctx, id, 0, 10, now); err != nil {
			t.Fatalf("ListOps(%s): %v", id, err)
		}
		if subscribe {
			if err := r.UpsertPushSubscription(ctx, id, "https://push.example/"+id, "p256dh", "auth", now); err != nil {
				t.Fatalf("UpsertPushSubscription(%s): %v", id, err)
			}
		}
	}

	// drainQueue arms one reminder `ago` in the past and marks it sent, leaving
	// the account with ZERO unsent rows — the production shape of
	// jolly-zebra-mkvfmv after its last queued reminder fired.
	drainQueue := func(id string, ago time.Duration) {
		t.Helper()
		if err := r.ReplaceSchedule(ctx, id, []ScheduledPushInput{
			{FireAt: now.Add(-ago), CT: []byte("fired-ct")},
		}, now); err != nil {
			t.Fatalf("ReplaceSchedule(%s): %v", id, err)
		}
		due, err := r.DueScheduledPushes(ctx, now)
		if err != nil {
			t.Fatalf("DueScheduledPushes: %v", err)
		}
		for _, p := range due {
			if p.AccountID != id {
				continue
			}
			if err := r.MarkPushSent(ctx, p.ID, now); err != nil {
				t.Fatalf("MarkPushSent(%s): %v", id, err)
			}
		}
	}

	warned := func() map[string]bool {
		t.Helper()
		ids, err := r.AccountsNeedingStaleSyncWarning(ctx, now, dryWithin, cooldown)
		if err != nil {
			t.Fatalf("AccountsNeedingStaleSyncWarning: %v", err)
		}
		set := make(map[string]bool, len(ids))
		for _, id := range ids {
			set[id] = true
		}
		return set
	}

	// The production failure: subscribed, reminders fired for months, queue now
	// completely empty. Must be the loudest case, not an invisible one.
	mkAccount("acc-dry", "jolly-zebra-mkvfmv", true)
	drainQueue("acc-dry", time.Hour)

	// Healthy: the horizon still reaches well past the warn window.
	mkAccount("acc-healthy", "calm-otter-aaa111", true)
	if err := r.ReplaceSchedule(ctx, "acc-healthy", []ScheduledPushInput{
		{FireAt: now.Add(7 * 24 * time.Hour), CT: []byte("future-ct")},
	}, now); err != nil {
		t.Fatalf("ReplaceSchedule(acc-healthy): %v", err)
	}

	// Nearly dry: last unsent entry fires inside the warn window.
	mkAccount("acc-soon", "brisk-lynx-bbb222", true)
	if err := r.ReplaceSchedule(ctx, "acc-soon", []ScheduledPushInput{
		{FireAt: now.Add(time.Hour), CT: []byte("soon-ct")},
	}, now); err != nil {
		t.Fatalf("ReplaceSchedule(acc-soon): %v", err)
	}

	// Never armed reminders at all. Has the same "empty queue" as acc-dry, and
	// must NOT be warned — dropping the sync gate would otherwise turn the sweep
	// into a daily nag for every account that never wanted reminders.
	mkAccount("acc-never", "quiet-finch-ccc333", true)

	// Dry, but its only subscription is disabled (410 Gone): the warning is
	// itself a web push, so there is nothing to deliver it over.
	mkAccount("acc-nosub", "lone-heron-ddd444", true)
	drainQueue("acc-nosub", time.Hour)
	if err := r.Disable(ctx, "https://push.example/acc-nosub"); err != nil {
		t.Fatalf("Disable: %v", err)
	}

	// Empty for far longer than the warn window: either every reminder was
	// deliberately switched off (the client PUTs an empty replace-all schedule,
	// which the server cannot tell from a browser that stopped uploading) or the
	// account was simply abandoned. Escalate-then-stop: after dryQueueWithin with
	// nothing in the queue, the warning goes permanently quiet rather than
	// nagging once a day forever.
	mkAccount("acc-longgone", "grey-marten-eee555", true)
	drainQueue("acc-longgone", 10*24*time.Hour)

	got := warned()
	for _, want := range []string{"acc-dry", "acc-soon"} {
		if !got[want] {
			t.Errorf("%s not warned; want warned (got %v)", want, got)
		}
	}
	for _, skip := range []string{"acc-healthy", "acc-never", "acc-nosub", "acc-longgone"} {
		if got[skip] {
			t.Errorf("%s warned; want skipped (got %v)", skip, got)
		}
	}

	// Cooldown still holds: a warned account goes quiet until warnCooldown.
	if err := r.MarkStaleSyncWarned(ctx, "acc-dry", now); err != nil {
		t.Fatalf("MarkStaleSyncWarned: %v", err)
	}
	if got := warned(); got["acc-dry"] {
		t.Errorf("acc-dry re-warned inside the cooldown (got %v)", got)
	}
	// ...and comes back once the cooldown has elapsed.
	ids, err := r.AccountsNeedingStaleSyncWarning(ctx, now.Add(25*time.Hour), dryWithin, cooldown)
	if err != nil {
		t.Fatalf("AccountsNeedingStaleSyncWarning (post-cooldown): %v", err)
	}
	var found bool
	for _, id := range ids {
		found = found || id == "acc-dry"
	}
	if !found {
		t.Errorf("acc-dry not warned after the cooldown elapsed (got %v)", ids)
	}
}
