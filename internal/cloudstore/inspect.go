package cloudstore

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// SyncStats summarizes an account's oplog state — op count, seq range, and
// which device last appended, for the "did the phone's write reach the
// server?" debugging question.
type SyncStats struct {
	OpCount           int64
	MinSeq            int64
	MaxSeq            int64
	LastAppendAt      *time.Time
	LastDeviceCredRef string
}

// SnapshotState is the account's compaction snapshot, or a zero value with
// Exists=false when none has been uploaded yet.
type SnapshotState struct {
	Exists    bool
	Seq       int64
	CTBytes   int
	CreatedAt time.Time
}

// EnvelopeSummary is one envelope row's non-secret metadata — size, not
// content.
type EnvelopeSummary struct {
	CredentialRef string
	V             int
	CTBytes       int
}

// PushState summarizes an account's push queue for the "is the push queue
// draining?" debugging question.
type PushState struct {
	ActiveSubscriptions   int64
	DisabledSubscriptions int64
	PendingScheduled      int64
	NextFireAt            *time.Time
	LastSentAt            *time.Time
}

// AccountInspection is the full read-only view over one account assembled by
// InspectAccount.
type AccountInspection struct {
	Devices         []Credential
	Envelopes       []EnvelopeSummary
	Sync            SyncStats
	RecordTypeCount map[string]int64
	Snapshot        SnapshotState
	Push            PushState
}

// CredentialRefPrefix returns the short prefix an operator can eyeball to
// pair a device (credential id) with its envelope (credential_ref), both
// encoded the same way the register-finish handler stores them
// (base64.RawURLEncoding — see internal/cloudserver/webauthn.go).
func CredentialRefPrefix(credentialID []byte) string {
	s := base64.RawURLEncoding.EncodeToString(credentialID)
	const n = 8
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// InspectAccount composes existing + new read-only queries into the full
// operator debug view for one account. No transaction: this is a debug view,
// mild cross-query skew (e.g. a write landing between two of these SELECTs)
// is acceptable.
func (r *Repo) InspectAccount(ctx context.Context, accountID string) (*AccountInspection, error) {
	devices, err := r.CredentialsByAccount(ctx, accountID)
	if err != nil {
		return nil, err
	}

	envelopes, err := r.ListEnvelopes(ctx, accountID)
	if err != nil {
		return nil, err
	}
	envSummaries := make([]EnvelopeSummary, len(envelopes))
	for i, e := range envelopes {
		envSummaries[i] = EnvelopeSummary{CredentialRef: e.CredentialRef, V: e.V, CTBytes: len(e.CT)}
	}

	sync, tags, err := r.syncStats(ctx, accountID)
	if err != nil {
		return nil, err
	}

	snapshot, err := r.snapshotState(ctx, accountID)
	if err != nil {
		return nil, err
	}

	push, err := r.pushState(ctx, accountID)
	if err != nil {
		return nil, err
	}

	return &AccountInspection{
		Devices:         devices,
		Envelopes:       envSummaries,
		Sync:            sync,
		RecordTypeCount: tags,
		Snapshot:        snapshot,
		Push:            push,
	}, nil
}

func (r *Repo) syncStats(ctx context.Context, accountID string) (SyncStats, map[string]int64, error) {
	var (
		stats          SyncStats
		lastAppendUnix sql.NullInt64
		lastDeviceCred []byte
	)
	row := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*), COALESCE(MIN(seq), 0), COALESCE(MAX(seq), 0),
		        (SELECT created_at_unix FROM oplog WHERE account_id = ? ORDER BY seq DESC LIMIT 1),
		        (SELECT device_credential_id FROM oplog WHERE account_id = ? ORDER BY seq DESC LIMIT 1)
		 FROM oplog WHERE account_id = ?`,
		accountID, accountID, accountID)
	if err := row.Scan(&stats.OpCount, &stats.MinSeq, &stats.MaxSeq, &lastAppendUnix, &lastDeviceCred); err != nil {
		return stats, nil, err
	}
	stats.LastAppendAt = storedb.NullableUnixToTimePtr(lastAppendUnix)
	if len(lastDeviceCred) > 0 {
		stats.LastDeviceCredRef = CredentialRefPrefix(lastDeviceCred)
	}

	rows, err := r.db.QueryContext(ctx, `SELECT record_type_tag FROM oplog WHERE account_id = ?`, accountID)
	if err != nil {
		return stats, nil, err
	}
	defer rows.Close()
	tags := map[string]int64{}
	for rows.Next() {
		var tag string
		if err := rows.Scan(&tag); err != nil {
			return stats, nil, err
		}
		typ, _, found := strings.Cut(tag, ":")
		if !found {
			typ = tag
		}
		tags[typ]++
	}
	return stats, tags, rows.Err()
}

func (r *Repo) snapshotState(ctx context.Context, accountID string) (SnapshotState, error) {
	// Read-only: unlike GetSnapshot (a sync endpoint that touches
	// sync_state.last_sync_unix), inspection must not mutate — writing here
	// would reset the staleness signal this tool exists to surface. length(ct)
	// avoids loading the ciphertext blob.
	var (
		seq         int64
		ctBytes     int
		createdUnix int64
	)
	err := r.db.QueryRowContext(ctx,
		`SELECT snapshot_seq, length(ct), created_at_unix FROM snapshots WHERE account_id = ?`, accountID).
		Scan(&seq, &ctBytes, &createdUnix)
	if errors.Is(err, sql.ErrNoRows) {
		return SnapshotState{}, nil
	}
	if err != nil {
		return SnapshotState{}, err
	}
	return SnapshotState{
		Exists:    true,
		Seq:       seq,
		CTBytes:   ctBytes,
		CreatedAt: storedb.UnixToTime(createdUnix),
	}, nil
}

func (r *Repo) pushState(ctx context.Context, accountID string) (PushState, error) {
	var state PushState
	row := r.db.QueryRowContext(ctx,
		`SELECT SUM(CASE WHEN disabled = 0 THEN 1 ELSE 0 END), SUM(CASE WHEN disabled = 1 THEN 1 ELSE 0 END)
		 FROM push_subscriptions WHERE account_id = ?`, accountID)
	var active, disabled sql.NullInt64
	if err := row.Scan(&active, &disabled); err != nil {
		return state, err
	}
	state.ActiveSubscriptions = active.Int64
	state.DisabledSubscriptions = disabled.Int64

	var nextFire sql.NullInt64
	row = r.db.QueryRowContext(ctx,
		`SELECT COUNT(*), MIN(fire_at_unix) FROM scheduled_pushes WHERE account_id = ? AND sent_at_unix IS NULL`, accountID)
	if err := row.Scan(&state.PendingScheduled, &nextFire); err != nil {
		return state, err
	}
	state.NextFireAt = storedb.NullableUnixToTimePtr(nextFire)

	var lastSent sql.NullInt64
	row = r.db.QueryRowContext(ctx,
		`SELECT MAX(sent_at_unix) FROM scheduled_pushes WHERE account_id = ?`, accountID)
	if err := row.Scan(&lastSent); err != nil {
		return state, err
	}
	state.LastSentAt = storedb.NullableUnixToTimePtr(lastSent)
	return state, nil
}

// AccountSummary is one row of the enriched `admin list` output.
type AccountSummary struct {
	Account     Account
	Claimed     bool
	DeviceCount int64
	OpCount     int64
	LastSyncAt  *time.Time
}

// AccountSummaries returns the enriched `admin list` view for every account
// in one GROUP BY query (plus the base account rows) — deliberately not
// N+1.
func (r *Repo) AccountSummaries(ctx context.Context) ([]AccountSummary, error) {
	accounts, err := r.ListAccounts(ctx)
	if err != nil {
		return nil, err
	}

	rows, err := r.db.QueryContext(ctx,
		`SELECT a.id,
		        (SELECT COUNT(*) FROM credentials c WHERE c.account_id = a.id),
		        (SELECT COUNT(*) FROM oplog o WHERE o.account_id = a.id),
		        ss.last_sync_unix
		 FROM accounts a
		 LEFT JOIN sync_state ss ON ss.account_id = a.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type agg struct {
		devices, ops int64
		lastSync     sql.NullInt64
	}
	byID := map[string]agg{}
	for rows.Next() {
		var id string
		var a agg
		if err := rows.Scan(&id, &a.devices, &a.ops, &a.lastSync); err != nil {
			return nil, err
		}
		byID[id] = a
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	summaries := make([]AccountSummary, len(accounts))
	for i, acc := range accounts {
		a := byID[acc.ID]
		summaries[i] = AccountSummary{
			Account:     acc,
			Claimed:     a.devices > 0,
			DeviceCount: a.devices,
			OpCount:     a.ops,
			LastSyncAt:  storedb.NullableUnixToTimePtr(a.lastSync),
		}
	}
	return summaries, nil
}
