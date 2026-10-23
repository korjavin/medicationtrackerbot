package cloudstore

import (
	"context"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// Native push platforms — the CHECK constraint on native_push_tokens.platform.
const (
	NativePushIOS     = "ios"
	NativePushAndroid = "android"
)

// NativePushToken is one APNs (ios) / FCM (android) device token registered by
// an account's app shell (med-erq1.1).
type NativePushToken struct {
	AccountID string
	Platform  string
	Token     string
	CreatedAt time.Time
	LastSeen  time.Time
	Disabled  bool
}

// UpsertNativePushToken registers a device token for accountID, or refreshes
// it: last_seen moves, a disabled token re-enables, and a token previously
// registered by another account moves to this one (same device, new account).
func (r *Repo) UpsertNativePushToken(ctx context.Context, accountID, platform, token string, now time.Time) error {
	ts := storedb.TimeToUnix(now)
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO native_push_tokens (account_id, platform, token, created_at_unix, last_seen_unix, disabled) VALUES (?, ?, ?, ?, ?, 0)
		 ON CONFLICT(platform, token) DO UPDATE SET account_id = excluded.account_id, last_seen_unix = excluded.last_seen_unix, disabled = 0`,
		accountID, platform, token, ts, ts)
	return err
}

// DeleteNativePushToken hard-removes a token, scoped to accountID so a session
// can only delete its own account's tokens.
func (r *Repo) DeleteNativePushToken(ctx context.Context, accountID, platform, token string) error {
	_, err := r.db.ExecContext(ctx,
		`DELETE FROM native_push_tokens WHERE account_id = ? AND platform = ? AND token = ?`, accountID, platform, token)
	return err
}

// ListNativePushTokens returns accountID's enabled native push tokens — the
// fan-out set for the native senders.
func (r *Repo) ListNativePushTokens(ctx context.Context, accountID string) ([]NativePushToken, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT account_id, platform, token, created_at_unix, last_seen_unix, disabled FROM native_push_tokens WHERE account_id = ? AND disabled = 0`,
		accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []NativePushToken
	for rows.Next() {
		var (
			t                 NativePushToken
			created, lastSeen int64
			disabled          int
		)
		if err := rows.Scan(&t.AccountID, &t.Platform, &t.Token, &created, &lastSeen, &disabled); err != nil {
			return nil, err
		}
		t.CreatedAt = storedb.UnixToTime(created)
		t.LastSeen = storedb.UnixToTime(lastSeen)
		t.Disabled = disabled != 0
		out = append(out, t)
	}
	return out, rows.Err()
}

// DisableNativePushToken marks a token inactive (the sender's reaction to an
// APNs/FCM invalid-token reply) without deleting it, so a re-registration of
// the same token upserts cleanly.
func (r *Repo) DisableNativePushToken(ctx context.Context, platform, token string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE native_push_tokens SET disabled = 1 WHERE platform = ? AND token = ?`, platform, token)
	return err
}
