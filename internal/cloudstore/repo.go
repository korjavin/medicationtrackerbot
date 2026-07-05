// Package cloudstore is the storage layer for the zero-knowledge cloud
// service (cmd/cloud): accounts, WebAuthn credentials, encrypted envelopes,
// and recovery verifiers. It owns its own SQLite database (cloud.db) and its
// own migrations — it must import internal/store/db only, never
// internal/store, whose blank import of internal/store/migrations registers
// a Go migration into goose's process-global registry that would otherwise
// leak into cloud.db.
package cloudstore

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"embed"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// ErrClaimInvalid is returned by ConsumeClaimToken when the subdomain does
// not exist, the account is already claimed, the token hash does not match,
// or the claim has expired. Callers must not distinguish these cases in
// responses (a guessed fresh subdomain must not leak which failure mode hit).
var ErrClaimInvalid = errors.New("cloudstore: invalid or expired claim token")

// ErrAlreadyClaimed is returned by ResetClaim when the target account has
// already been claimed (a credential exists, claim token cleared) — reissuing a
// claim token there would let a fresh passkey be enrolled onto a live account.
var ErrAlreadyClaimed = errors.New("cloudstore: account already claimed")

// ErrTransferSlotInvalid is returned by ClaimTransferSlot when the slot does
// not exist, was already fetched, or has expired. Callers must not
// distinguish these cases in responses (all map to 410 Gone).
var ErrTransferSlotInvalid = errors.New("cloudstore: invalid, expired, or already-claimed transfer slot")

// ErrRecoveryInvalid is returned by VerifyRecoveryAttempt when no recovery
// verifier is set for the account, or the supplied one does not match.
var ErrRecoveryInvalid = errors.New("cloudstore: invalid recovery verifier")

// ErrRecoveryRateLimited is returned by VerifyRecoveryAttempt once an account
// has racked up recoveryMaxAttempts failures within the last recoveryWindow.
var ErrRecoveryRateLimited = errors.New("cloudstore: recovery attempts rate limited")

// ErrLastCredential is returned by DeleteCredentialWithEnvelope when removing
// the credential would leave the account with no credentials and no recovery
// envelope — i.e. no remaining path to unwrap the DEK.
var ErrLastCredential = errors.New("cloudstore: cannot remove the account's last unwrap path")

// ErrSourceCredentialRevoked is returned by AddCredentialWithEnvelope when the
// session's own credential no longer exists at insert time — a revocation that
// landed after RegisterFinish's ceremony began. Prevents a revoked device from
// minting a fresh credential + session.
var ErrSourceCredentialRevoked = errors.New("cloudstore: source credential revoked")

// Account is one row in the accounts table. ClaimTokenHash/ClaimExpiresAt are
// nil once the account has been claimed (first credential registered).
type Account struct {
	ID              string
	Subdomain       string
	CreatedAt       time.Time
	ClaimTokenHash  []byte
	ClaimExpiresAt  *time.Time
	LossAckAt       *time.Time
	VAPIDPublicKey  *string
	VAPIDPrivateKey *string
}

// Credential is one row in the credentials table — a WebAuthn public key
// credential bound to an account.
type Credential struct {
	ID             []byte
	AccountID      string
	PublicKey      []byte
	Transports     string
	SignCount      uint32
	// Backup flags from the registration ceremony. go-webauthn compares the
	// assertion's BE bit against the stored value at login, so synced passkeys
	// (BE=1) fail unlock unless these round-trip through the store.
	BackupEligible bool
	BackupState    bool
	CreatedAt      time.Time
	LastAssertedAt *time.Time
}

// Envelope is one row in the envelopes table — opaque ciphertext keyed by
// account + credential ref (a credential id, or the literal "recovery").
type Envelope struct {
	AccountID     string
	CredentialRef string
	V             int
	Nonce         []byte
	CT            []byte
	MAC           []byte
}

// Repo is the cloudstore repository. Construct with New; share one *Repo per
// process — the underlying *storedb.DB owns its own connection pool.
type Repo struct {
	db *storedb.DB
}

// New returns a Repo bound to d, running cloudstore's own migrations first.
func New(d *storedb.DB) (*Repo, error) {
	if err := d.Migrate(migrationsFS, "migrations"); err != nil {
		return nil, fmt.Errorf("migrate cloudstore: %w", err)
	}
	return &Repo{db: d}, nil
}

// CreateAccount inserts a new (unclaimed) account row. vapidPublicKey/
// vapidPrivateKey are the account's own VAPID keypair generated at
// provisioning; pass "" for both on the (unsupported) legacy path — stored as
// NULL, picked up later by the startup backfill.
func (r *Repo) CreateAccount(ctx context.Context, id, subdomain string, claimTokenHash []byte, claimExpiresAt, createdAt time.Time, vapidPublicKey, vapidPrivateKey string) (*Account, error) {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO accounts (id, subdomain, created_at_unix, claim_token_hash, claim_expires_unix, vapid_public_key, vapid_private_key) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, subdomain, storedb.TimeToUnix(createdAt), claimTokenHash, storedb.TimeToUnix(claimExpiresAt), nullString(vapidPublicKey), nullString(vapidPrivateKey))
	if err != nil {
		return nil, err
	}
	expires := storedb.UnixToTime(storedb.TimeToUnix(claimExpiresAt))
	return &Account{
		ID:              id,
		Subdomain:       subdomain,
		CreatedAt:       storedb.UnixToTime(storedb.TimeToUnix(createdAt)),
		ClaimTokenHash:  claimTokenHash,
		ClaimExpiresAt:  &expires,
		VAPIDPublicKey:  nullStringPtr(vapidPublicKey),
		VAPIDPrivateKey: nullStringPtr(vapidPrivateKey),
	}, nil
}

// nullString turns "" into a driver NULL so an unset VAPID key never gets
// stored as an empty-string value that would read as "present" to a NULL check.
func nullString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullStringPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// SetAccountVAPIDKeys sets an account's VAPID keypair, but only if it
// currently has none. Rotation would orphan every subscription created under
// the old key (push services bind subscriptions to the subscribe-time key),
// so this is backfill-only: it silently no-ops if the account already has keys.
func (r *Repo) SetAccountVAPIDKeys(ctx context.Context, accountID, vapidPublicKey, vapidPrivateKey string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE accounts SET vapid_public_key = ?, vapid_private_key = ? WHERE id = ? AND vapid_public_key IS NULL`,
		vapidPublicKey, vapidPrivateKey, accountID)
	return err
}

// AccountIDsMissingVAPIDKeys returns the IDs of every account with no VAPID
// keypair yet — pre-existing accounts from before per-account keys shipped.
// Used by the startup backfill.
func (r *Repo) AccountIDsMissingVAPIDKeys(ctx context.Context) ([]string, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT id FROM accounts WHERE vapid_public_key IS NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func scanAccount(scan func(dest ...any) error) (*Account, error) {
	var (
		a            Account
		createdUnix  int64
		claimHash    []byte
		claimExpires sql.NullInt64
		lossAck      sql.NullInt64
		vapidPublic  sql.NullString
		vapidPrivate sql.NullString
	)
	if err := scan(&a.ID, &a.Subdomain, &createdUnix, &claimHash, &claimExpires, &lossAck, &vapidPublic, &vapidPrivate); err != nil {
		return nil, err
	}
	a.CreatedAt = storedb.UnixToTime(createdUnix)
	if len(claimHash) > 0 {
		a.ClaimTokenHash = claimHash
	}
	a.ClaimExpiresAt = storedb.NullableUnixToTimePtr(claimExpires)
	a.LossAckAt = storedb.NullableUnixToTimePtr(lossAck)
	if vapidPublic.Valid {
		a.VAPIDPublicKey = &vapidPublic.String
	}
	if vapidPrivate.Valid {
		a.VAPIDPrivateKey = &vapidPrivate.String
	}
	return &a, nil
}

const accountColumns = `id, subdomain, created_at_unix, claim_token_hash, claim_expires_unix, loss_ack_unix, vapid_public_key, vapid_private_key`

// AccountBySubdomain looks up an account by its subdomain label.
func (r *Repo) AccountBySubdomain(ctx context.Context, subdomain string) (*Account, error) {
	row := r.db.QueryRowContext(ctx, `SELECT `+accountColumns+` FROM accounts WHERE subdomain = ?`, subdomain)
	return scanAccount(row.Scan)
}

// ListAccounts returns every account, oldest first (used by the admin CLI).
func (r *Repo) ListAccounts(ctx context.Context) ([]Account, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT `+accountColumns+` FROM accounts ORDER BY created_at_unix`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var accounts []Account
	for rows.Next() {
		a, err := scanAccount(rows.Scan)
		if err != nil {
			return nil, err
		}
		accounts = append(accounts, *a)
	}
	return accounts, rows.Err()
}

// ConsumeClaimToken validates tokenHash against the stored claim (must match,
// must not be expired, account must still be unclaimed) and, on success,
// clears the claim so it cannot be replayed. Returns ErrClaimInvalid for
// every failure mode — unknown subdomain, already-claimed, bad hash, expired.
func (r *Repo) ConsumeClaimToken(ctx context.Context, subdomain string, tokenHash []byte, now time.Time) (*Account, error) {
	var account *Account
	err := r.db.WithTx(ctx, func(tx storedb.TX) error {
		a, err := consumeClaimTx(ctx, tx, subdomain, tokenHash, now)
		if err != nil {
			return err
		}
		account = a
		return nil
	})
	if err != nil {
		return nil, err
	}
	return account, nil
}

// consumeClaimTx validates+clears the claim inside an existing transaction, so
// callers can bundle it with a follow-up write (see ClaimAndAddCredential).
func consumeClaimTx(ctx context.Context, tx storedb.TX, subdomain string, tokenHash []byte, now time.Time) (*Account, error) {
	var (
		id           string
		createdUnix  int64
		storedHash   []byte
		claimExpires sql.NullInt64
		lossAck      sql.NullInt64
	)
	err := tx.QueryRowContext(ctx,
		`SELECT id, created_at_unix, claim_token_hash, claim_expires_unix, loss_ack_unix FROM accounts WHERE subdomain = ?`,
		subdomain).Scan(&id, &createdUnix, &storedHash, &claimExpires, &lossAck)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrClaimInvalid
		}
		return nil, err
	}
	if len(storedHash) == 0 || !claimExpires.Valid {
		return nil, ErrClaimInvalid
	}
	if subtle.ConstantTimeCompare(storedHash, tokenHash) != 1 {
		return nil, ErrClaimInvalid
	}
	if now.After(storedb.UnixToTime(claimExpires.Int64)) {
		return nil, ErrClaimInvalid
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE accounts SET claim_token_hash = NULL, claim_expires_unix = NULL WHERE id = ?`, id); err != nil {
		return nil, err
	}
	return &Account{
		ID:        id,
		Subdomain: subdomain,
		CreatedAt: storedb.UnixToTime(createdUnix),
		LossAckAt: storedb.NullableUnixToTimePtr(lossAck),
	}, nil
}

// ClaimAndAddCredential atomically consumes the claim token, inserts the
// account's first credential, and stores its DEK envelope in one transaction.
// Doing all three in a single tx prevents a mid-registration failure from
// stranding an account in an unrecoverable state:
//   - claimed-but-credential-less (claim gone, can't re-register; no credential,
//     can't log in), or
//   - credential-but-envelope-less (the passkey exists so the claim is spent and
//     cold unlock can't fall back to signup, but no envelope means there is
//     nothing to unwrap the DEK from — cold unlock dead-ends at envelope fetch).
//
// Either state would otherwise need an operator reset-claim/delete. Folding the
// envelope in matches the "one transaction" first-signup upload in
// docs/cloud-crypto.md.
func (r *Repo) ClaimAndAddCredential(ctx context.Context, subdomain string, tokenHash []byte, cred Credential, env Envelope, now time.Time) (*Account, error) {
	var account *Account
	err := r.db.WithTx(ctx, func(tx storedb.TX) error {
		a, err := consumeClaimTx(ctx, tx, subdomain, tokenHash, now)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO credentials (id, account_id, public_key, transports, sign_count, backup_eligible, backup_state, created_at_unix) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			cred.ID, cred.AccountID, cred.PublicKey, cred.Transports, cred.SignCount, cred.BackupEligible, cred.BackupState, storedb.TimeToUnix(cred.CreatedAt)); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO envelopes (account_id, credential_ref, v, nonce, ct, mac) VALUES (?, ?, ?, ?, ?, ?)`,
			env.AccountID, env.CredentialRef, env.V, env.Nonce, env.CT, env.MAC); err != nil {
			return err
		}
		account = a
		return nil
	})
	if err != nil {
		return nil, err
	}
	return account, nil
}

// SweepExpiredClaims deletes unclaimed accounts whose claim has expired,
// freeing their subdomains. Called opportunistically on provisioning rather
// than from a background job (ponytail: this service is invite-only and
// low-volume; add a ticker only if that stops being true).
func (r *Repo) SweepExpiredClaims(ctx context.Context, now time.Time) (int, error) {
	result, err := r.db.ExecContext(ctx,
		`DELETE FROM accounts WHERE claim_token_hash IS NOT NULL AND claim_expires_unix IS NOT NULL AND claim_expires_unix < ?`,
		storedb.TimeToUnix(now))
	if err != nil {
		return 0, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(n), nil
}

// ResetClaim replaces an *unclaimed* account's claim token/expiry (e.g. after
// the original claim link expired unused). It is gated on
// claim_token_hash IS NOT NULL — a claimed account (credential enrolled, token
// cleared) is off-limits, so a stale invite link can never re-open a live
// account for a fresh passkey under a different DEK. Returns sql.ErrNoRows if
// the subdomain does not exist, ErrAlreadyClaimed if it exists but is claimed.
func (r *Repo) ResetClaim(ctx context.Context, subdomain string, tokenHash []byte, expiresAt time.Time) error {
	result, err := r.db.ExecContext(ctx,
		`UPDATE accounts SET claim_token_hash = ?, claim_expires_unix = ? WHERE subdomain = ? AND claim_token_hash IS NOT NULL`,
		tokenHash, storedb.TimeToUnix(expiresAt), subdomain)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		// Distinguish "no such subdomain" from "exists but already claimed".
		var id string
		if err := r.db.QueryRowContext(ctx, `SELECT id FROM accounts WHERE subdomain = ?`, subdomain).Scan(&id); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return sql.ErrNoRows
			}
			return err
		}
		return ErrAlreadyClaimed
	}
	return nil
}

// DeleteAccount removes an account and every row that references it
// (credentials, envelopes, recovery_auth), in a single transaction.
func (r *Repo) DeleteAccount(ctx context.Context, subdomain string) error {
	return r.db.WithTx(ctx, func(tx storedb.TX) error {
		var accountID string
		if err := tx.QueryRowContext(ctx, `SELECT id FROM accounts WHERE subdomain = ?`, subdomain).Scan(&accountID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM envelopes WHERE account_id = ?`, accountID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM credentials WHERE account_id = ?`, accountID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM recovery_auth WHERE account_id = ?`, accountID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM accounts WHERE id = ?`, accountID)
		return err
	})
}

// SetLossAck records that the user acknowledged the "we cannot recover your
// data" education step, so the stateless client wizard never re-nags.
func (r *Repo) SetLossAck(ctx context.Context, accountID string, ackAt time.Time) error {
	result, err := r.db.ExecContext(ctx, `UPDATE accounts SET loss_ack_unix = ? WHERE id = ?`, storedb.TimeToUnix(ackAt), accountID)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// AddCredential inserts a new WebAuthn credential for an account.
func (r *Repo) AddCredential(ctx context.Context, cred Credential) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO credentials (id, account_id, public_key, transports, sign_count, backup_eligible, backup_state, created_at_unix) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		cred.ID, cred.AccountID, cred.PublicKey, cred.Transports, cred.SignCount, cred.BackupEligible, cred.BackupState, storedb.TimeToUnix(cred.CreatedAt))
	return err
}

// CredentialsByAccount returns every credential registered for an account.
func (r *Repo) CredentialsByAccount(ctx context.Context, accountID string) ([]Credential, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, account_id, public_key, transports, sign_count, backup_eligible, backup_state, created_at_unix, last_asserted_at_unix FROM credentials WHERE account_id = ?`,
		accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var creds []Credential
	for rows.Next() {
		var (
			c              Credential
			signCount      int64
			createdUnix    int64
			lastAssertedAt sql.NullInt64
		)
		if err := rows.Scan(&c.ID, &c.AccountID, &c.PublicKey, &c.Transports, &signCount, &c.BackupEligible, &c.BackupState, &createdUnix, &lastAssertedAt); err != nil {
			return nil, err
		}
		c.SignCount = uint32(signCount)
		c.CreatedAt = storedb.UnixToTime(createdUnix)
		c.LastAssertedAt = storedb.NullableUnixToTimePtr(lastAssertedAt)
		creds = append(creds, c)
	}
	return creds, rows.Err()
}

// CredentialExists reports whether credentialID is still a registered
// credential — used by session verification to reject tokens minted for a
// credential that has since been revoked.
func (r *Repo) CredentialExists(ctx context.Context, credentialID []byte) (bool, error) {
	var exists int
	err := r.db.QueryRowContext(ctx, `SELECT 1 FROM credentials WHERE id = ?`, credentialID).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// DeleteCredentialWithEnvelope removes a credential and its DEK envelope for
// accountID in one transaction (routine device removal — docs/cloud-crypto.md
// "Removing a device / revocation"). It enforces the "never strand an account"
// invariant inside the same transaction: if the delete would leave the account
// with zero credentials and no usable recovery material (the recovery envelope
// AND its recovery_auth verifier row — see below), it rolls back and returns
// ErrLastCredential. Doing the count-and-check in the tx (rather than a
// caller-side pre-read) closes the TOCTOU where two concurrent revocations of
// different credentials both observe a stale count and drop the account to
// zero unwrap paths. Returns sql.ErrNoRows if credentialID does not belong to
// accountID.
func (r *Repo) DeleteCredentialWithEnvelope(ctx context.Context, accountID string, credentialID []byte) error {
	credRef := base64.RawURLEncoding.EncodeToString(credentialID)
	return r.db.WithTx(ctx, func(tx storedb.TX) error {
		result, err := tx.ExecContext(ctx, `DELETE FROM credentials WHERE id = ? AND account_id = ?`, credentialID, accountID)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n == 0 {
			return sql.ErrNoRows
		}
		var remaining int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM credentials WHERE account_id = ?`, accountID).Scan(&remaining); err != nil {
			return err
		}
		if remaining == 0 {
			// Recovery needs BOTH the 'recovery' envelope (holds the DEK ct) and
			// the recovery_auth verifier row (authenticates the redemption). They
			// SetRecoveryMaterial writes them atomically, but an envelope left by
			// an older half-written signup (or a bare envelope PUT) could pair a
			// recovery envelope with no verifier — and VerifyRecoveryAttempt then
			// returns ErrRecoveryInvalid forever. Require both, else deleting the
			// last credential strands the account permanently.
			var hasRecovery int
			err := tx.QueryRowContext(ctx, `SELECT 1 FROM envelopes e
				WHERE e.account_id = ? AND e.credential_ref = 'recovery'
				  AND EXISTS (SELECT 1 FROM recovery_auth ra WHERE ra.account_id = e.account_id)`, accountID).Scan(&hasRecovery)
			if errors.Is(err, sql.ErrNoRows) {
				return ErrLastCredential
			}
			if err != nil {
				return err
			}
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM envelopes WHERE account_id = ? AND credential_ref = ?`, accountID, credRef)
		return err
	})
}

// TouchCredential updates a credential's sign counter and last-asserted
// timestamp after a successful WebAuthn assertion.
func (r *Repo) TouchCredential(ctx context.Context, credentialID []byte, signCount uint32, assertedAt time.Time) error {
	result, err := r.db.ExecContext(ctx,
		`UPDATE credentials SET sign_count = ?, last_asserted_at_unix = ? WHERE id = ?`,
		signCount, storedb.TimeToUnix(assertedAt), credentialID)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// PutEnvelope upserts an encrypted envelope for account_id+credential_ref.
func (r *Repo) PutEnvelope(ctx context.Context, e Envelope) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO envelopes (account_id, credential_ref, v, nonce, ct, mac) VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(account_id, credential_ref) DO UPDATE SET v = excluded.v, nonce = excluded.nonce, ct = excluded.ct, mac = excluded.mac`,
		e.AccountID, e.CredentialRef, e.V, e.Nonce, e.CT, e.MAC)
	return err
}

// GetEnvelope returns one envelope by account_id+credential_ref.
func (r *Repo) GetEnvelope(ctx context.Context, accountID, credentialRef string) (*Envelope, error) {
	e := Envelope{AccountID: accountID, CredentialRef: credentialRef}
	err := r.db.QueryRowContext(ctx,
		`SELECT v, nonce, ct, mac FROM envelopes WHERE account_id = ? AND credential_ref = ?`,
		accountID, credentialRef).Scan(&e.V, &e.Nonce, &e.CT, &e.MAC)
	if err != nil {
		return nil, err
	}
	return &e, nil
}

// ListEnvelopes returns every envelope stored for an account.
func (r *Repo) ListEnvelopes(ctx context.Context, accountID string) ([]Envelope, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT account_id, credential_ref, v, nonce, ct, mac FROM envelopes WHERE account_id = ?`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var envelopes []Envelope
	for rows.Next() {
		var e Envelope
		if err := rows.Scan(&e.AccountID, &e.CredentialRef, &e.V, &e.Nonce, &e.CT, &e.MAC); err != nil {
			return nil, err
		}
		envelopes = append(envelopes, e)
	}
	return envelopes, rows.Err()
}

// CreateTransferSlot inserts a new device-transfer slot: ct is the DEK
// encrypted client-side under the transfer key (TK), which never reaches the
// server. enrollmentTokenHash gates the eventual passkey registration on the
// new device (see ClaimTransferSlot + the register/begin|finish gate).
func (r *Repo) CreateTransferSlot(ctx context.Context, id, accountID string, enrollmentTokenHash, ct []byte, createdAt, expiresAt time.Time) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO transfer_slots (id, account_id, enrollment_token_hash, ct, created_at_unix, expires_at_unix) VALUES (?, ?, ?, ?, ?, ?)`,
		id, accountID, enrollmentTokenHash, ct, storedb.TimeToUnix(createdAt), storedb.TimeToUnix(expiresAt))
	return err
}

// ClaimTransferSlot atomically marks a transfer slot fetched — single use,
// enforced by the UPDATE's WHERE clause plus a RowsAffected check rather than
// a SELECT-then-UPDATE, so two concurrent claims can't both succeed. On
// success it also rotates the slot's enrollment token to newTokenHash (the
// fresh token that authorizes the new device's registration) and returns the
// account id + ciphertext for the caller to hand back to the new device.
// Returns ErrTransferSlotInvalid if the slot is unknown, already fetched, or
// expired.
func (r *Repo) ClaimTransferSlot(ctx context.Context, slotID string, newTokenHash []byte, now time.Time) (accountID string, ct []byte, err error) {
	err = r.db.WithTx(ctx, func(tx storedb.TX) error {
		result, txErr := tx.ExecContext(ctx,
			`UPDATE transfer_slots SET fetched = 1, enrollment_token_hash = ? WHERE id = ? AND fetched = 0 AND expires_at_unix > ?`,
			newTokenHash, slotID, storedb.TimeToUnix(now))
		if txErr != nil {
			return txErr
		}
		n, txErr := result.RowsAffected()
		if txErr != nil {
			return txErr
		}
		if n == 0 {
			return ErrTransferSlotInvalid
		}
		return tx.QueryRowContext(ctx, `SELECT account_id, ct FROM transfer_slots WHERE id = ?`, slotID).Scan(&accountID, &ct)
	})
	if err != nil {
		return "", nil, err
	}
	return accountID, ct, nil
}

// ValidEnrollmentToken reports whether tokenHash matches the current,
// claimed (fetched=1), unexpired transfer slot for accountID — the state a
// slot is in after ClaimTransferSlot and before its enrollment token is
// redeemed. Checked at register/begin so a bad token fails before the
// WebAuthn ceremony starts; the atomic consume happens at RedeemTransferToken.
func (r *Repo) ValidEnrollmentToken(ctx context.Context, accountID string, tokenHash []byte, now time.Time) (bool, error) {
	var count int
	err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM transfer_slots WHERE account_id = ? AND enrollment_token_hash = ? AND fetched = 1 AND expires_at_unix > ?`,
		accountID, tokenHash, storedb.TimeToUnix(now)).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// RedeemTransferToken atomically consumes a claimed transfer slot's
// enrollment token and persists the new device's credential + DEK envelope in
// one transaction — mirroring ClaimAndAddCredential's rationale: a
// mid-registration failure must not strand the slot half-consumed, nor leave
// a credential with no envelope to unwrap its DEK from. Returns
// ErrTransferSlotInvalid if the token doesn't match a claimed, unexpired slot
// for accountID.
func (r *Repo) RedeemTransferToken(ctx context.Context, accountID string, tokenHash []byte, cred Credential, env Envelope, now time.Time) error {
	return r.db.WithTx(ctx, func(tx storedb.TX) error {
		result, err := tx.ExecContext(ctx,
			`DELETE FROM transfer_slots WHERE account_id = ? AND enrollment_token_hash = ? AND fetched = 1 AND expires_at_unix > ?`,
			accountID, tokenHash, storedb.TimeToUnix(now))
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return ErrTransferSlotInvalid
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO credentials (id, account_id, public_key, transports, sign_count, backup_eligible, backup_state, created_at_unix) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			cred.ID, cred.AccountID, cred.PublicKey, cred.Transports, cred.SignCount, cred.BackupEligible, cred.BackupState, storedb.TimeToUnix(cred.CreatedAt)); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx,
			`INSERT INTO envelopes (account_id, credential_ref, v, nonce, ct, mac) VALUES (?, ?, ?, ?, ?, ?)`,
			env.AccountID, env.CredentialRef, env.V, env.Nonce, env.CT, env.MAC)
		return err
	})
}

// AddCredentialWithEnvelope inserts an additional credential + its DEK
// envelope for an already-claimed account in one transaction, so an unlocked
// device adding a local passkey (e.g. a security key) via plain session auth
// can never end up with a credential that has no envelope to unwrap its DEK
// from. sourceCredentialID is the session's own credential: it must still exist
// at insert time or the insert rolls back with ErrSourceCredentialRevoked —
// checked inside the tx (not a caller-side pre-read) so a revocation committing
// mid-ceremony can't let the revoked device mint a fresh credential + session.
func (r *Repo) AddCredentialWithEnvelope(ctx context.Context, sourceCredentialID []byte, cred Credential, env Envelope) error {
	return r.db.WithTx(ctx, func(tx storedb.TX) error {
		var exists int
		err := tx.QueryRowContext(ctx, `SELECT 1 FROM credentials WHERE id = ?`, sourceCredentialID).Scan(&exists)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrSourceCredentialRevoked
		}
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO credentials (id, account_id, public_key, transports, sign_count, backup_eligible, backup_state, created_at_unix) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			cred.ID, cred.AccountID, cred.PublicKey, cred.Transports, cred.SignCount, cred.BackupEligible, cred.BackupState, storedb.TimeToUnix(cred.CreatedAt)); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx,
			`INSERT INTO envelopes (account_id, credential_ref, v, nonce, ct, mac) VALUES (?, ?, ?, ?, ?, ?)`,
			env.AccountID, env.CredentialRef, env.V, env.Nonce, env.CT, env.MAC)
		return err
	})
}

// SweepExpiredTransferSlots deletes expired slots, called opportunistically on
// every transfer API request rather than from a background job (ponytail: slot
// volume is trivial; add a ticker only if that stops being true). It must NOT
// delete claimed (fetched=1) slots on any other basis than expiry: a claimed
// slot still holds the live enrollment token that ValidEnrollmentToken /
// RedeemTransferToken need between ClaimTransferSlot and register/finish. Since
// the sweep is global (not account-scoped) and runs on every account's
// transfer/claim/recover request, deleting fetched slots eagerly would let one
// account's request wipe another's in-progress enrollment. Redeemed slots are
// deleted explicitly by RedeemTransferToken; unredeemed claimed slots expire
// via their TTL and get reaped here on expiry.
func (r *Repo) SweepExpiredTransferSlots(ctx context.Context, now time.Time) (int, error) {
	result, err := r.db.ExecContext(ctx,
		`DELETE FROM transfer_slots WHERE expires_at_unix < ?`, storedb.TimeToUnix(now))
	if err != nil {
		return 0, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(n), nil
}

// SetRecoveryVerifier upserts the hashed recovery verifier for an account,
// resetting the rate-limit counters (a new verifier invalidates old attempts).
func (r *Repo) SetRecoveryVerifier(ctx context.Context, accountID string, verifierHash []byte) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO recovery_auth (account_id, verifier_hash) VALUES (?, ?)
		 ON CONFLICT(account_id) DO UPDATE SET verifier_hash = excluded.verifier_hash, failed_attempts = 0, window_start_unix = NULL`,
		accountID, verifierHash)
	return err
}

// SetRecoveryMaterial upserts the recovery envelope and its verifier in one
// transaction, so a partial write can never pair a new envelope with an old
// verifier (or vice versa) — a mismatch silently breaks recovery: one code
// authenticates but can't decrypt, the other decrypts but can't authenticate.
// This is the atomic counterpart the Emergency Kit rotation writes through,
// replacing two independent PUTs.
func (r *Repo) SetRecoveryMaterial(ctx context.Context, accountID string, env Envelope, verifierHash []byte) error {
	return r.db.WithTx(ctx, func(tx storedb.TX) error {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO envelopes (account_id, credential_ref, v, nonce, ct, mac) VALUES (?, 'recovery', ?, ?, ?, ?)
			 ON CONFLICT(account_id, credential_ref) DO UPDATE SET v = excluded.v, nonce = excluded.nonce, ct = excluded.ct, mac = excluded.mac`,
			accountID, env.V, env.Nonce, env.CT, env.MAC); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx,
			`INSERT INTO recovery_auth (account_id, verifier_hash) VALUES (?, ?)
			 ON CONFLICT(account_id) DO UPDATE SET verifier_hash = excluded.verifier_hash, failed_attempts = 0, window_start_unix = NULL`,
			accountID, verifierHash)
		return err
	})
}

const (
	recoveryMaxAttempts = 5
	recoveryWindow      = time.Hour
)

// VerifyRecoveryAttempt checks verifierHash against accountID's stored
// recovery verifier, rate-limited to recoveryMaxAttempts per recoveryWindow
// (docs/cloud-crypto.md "recovery" domain separation — the verifier
// authenticates the attempt without unwrapping anything). A stale window
// (older than recoveryWindow) resets the counter before the limit check. On
// mismatch (or no verifier set for the account) the counter is bumped and
// ErrRecoveryInvalid is returned; a match returns nil without touching the
// counter — only a forced rotation (SetRecoveryVerifier) resets it, so a
// burned code can't be tried again after its one successful redemption plus
// rotation.
func (r *Repo) VerifyRecoveryAttempt(ctx context.Context, accountID string, verifierHash []byte, now time.Time) error {
	// WithTx rolls back the transaction on any non-nil return, so the verdict
	// travels back via result instead of fn's return value — otherwise the
	// attempt-counter UPDATE below would be discarded every time this
	// reports ErrRecoveryInvalid/ErrRecoveryRateLimited, and the rate limit
	// could never actually trip.
	result := error(ErrRecoveryInvalid)
	err := r.db.WithTx(ctx, func(tx storedb.TX) error {
		var (
			storedHash  []byte
			attempts    int
			windowStart sql.NullInt64
		)
		scanErr := tx.QueryRowContext(ctx,
			`SELECT verifier_hash, failed_attempts, window_start_unix FROM recovery_auth WHERE account_id = ?`,
			accountID).Scan(&storedHash, &attempts, &windowStart)
		if scanErr != nil {
			if errors.Is(scanErr, sql.ErrNoRows) {
				return nil
			}
			return scanErr
		}

		windowStartAt := now
		if windowStart.Valid {
			windowStartAt = storedb.UnixToTime(windowStart.Int64)
			if now.Sub(windowStartAt) > recoveryWindow {
				attempts = 0
				windowStartAt = now
			}
		}
		if attempts >= recoveryMaxAttempts {
			result = ErrRecoveryRateLimited
			return nil
		}
		if subtle.ConstantTimeCompare(storedHash, verifierHash) == 1 {
			result = nil
			return nil
		}
		_, execErr := tx.ExecContext(ctx,
			`UPDATE recovery_auth SET failed_attempts = ?, window_start_unix = ? WHERE account_id = ?`,
			attempts+1, storedb.TimeToUnix(windowStartAt), accountID)
		return execErr
	})
	if err != nil {
		return err
	}
	return result
}

// CreateClaimedTransferSlot inserts a transfer slot that starts already
// claimed (fetched=1) so a successful recovery redemption can hand out an
// enrollment token gated through the exact same machinery a device-transfer
// claim produces (ValidEnrollmentToken / RedeemTransferToken) — see
// docs/cloud-crypto.md "Token hygiene": one storage shape for both slot
// kinds, no second gate. ct is empty: recovery has no transfer ciphertext of
// its own, the DEK comes from the "recovery" envelope instead.
func (r *Repo) CreateClaimedTransferSlot(ctx context.Context, id, accountID string, enrollmentTokenHash []byte, createdAt, expiresAt time.Time) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO transfer_slots (id, account_id, enrollment_token_hash, ct, created_at_unix, expires_at_unix, fetched) VALUES (?, ?, ?, ?, ?, ?, 1)`,
		id, accountID, enrollmentTokenHash, []byte{}, storedb.TimeToUnix(createdAt), storedb.TimeToUnix(expiresAt))
	return err
}
