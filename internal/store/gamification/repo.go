// Package gamification owns the three tables behind the HealthPoints / Rings /
// levels / streaks engine (migration 073): gamification_targets (per-user
// target overrides), gamification_ledger (append/replace HP awards — the source
// of truth for recompute), and gamification_state (cached level / streak /
// insight-tier per user).
//
// Repo is the per-domain repository for these tables. Construct via store.New /
// store.NewWithDB and reach it as r.Gamification; new code should depend on
// *gamification.Repo (or a narrow interface satisfied by it) directly.
//
// The recommended guideline defaults (BP, sleep, steps, activity, calories,
// protein) live in the scoring engine's Config, NOT here — a gamification_targets
// row exists only for a metric the user explicitly changed. day_unix in the
// ledger is UTC-midnight unix-seconds (INTEGER) so the UNIQUE dedupe key is
// timezone-safe; see the package comment in internal/store/store.go and
// TestDoseTimeColumnsAreInteger.
package gamification

import (
	"context"
	"database/sql"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// Target is one row in gamification_targets: a per-user override for a single
// metric's scoring band. Only metrics the user has changed have a row — the
// recommended defaults live in scoring.Config. LowVal/HighVal/Falloff are nil
// when the corresponding column is NULL (e.g. a one-sided target sets only one
// bound). Mode distinguishes range vs one-sided targets and is "" when unset.
type Target struct {
	ID        int64     `json:"id"`
	UserID    int64     `json:"-"`
	MetricKey string    `json:"metric_key"`
	LowVal    *float64  `json:"low_val,omitempty"`
	HighVal   *float64  `json:"high_val,omitempty"`
	Falloff   *float64  `json:"falloff,omitempty"`
	Mode      string    `json:"mode,omitempty"`
	UpdatedAt time.Time `json:"updated_at"`
}

// LedgerEntry is one row in gamification_ledger: an HP award for a (day, ring,
// source_metric, kind) tuple. The UNIQUE (user_id, day_unix, ring,
// source_metric, kind) constraint makes UpsertLedger / backfill idempotent. Day
// is UTC-midnight; the repo normalizes it to day_unix on write. Detail carries
// an optional JSON blob explaining the award.
type LedgerEntry struct {
	ID           int64     `json:"id"`
	UserID       int64     `json:"-"`
	Day          time.Time `json:"day"`
	Ring         string    `json:"ring"`
	SourceMetric string    `json:"source_metric"`
	Kind         string    `json:"kind"`
	HP           int       `json:"hp"`
	Detail       string    `json:"detail,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
}

// WeeklyHP is one week's total ledger HP — a single row of the read-time
// streak fold's input (deriveStreak, internal/domain/gamification/streak.go).
// Week matches the domain layer's Monday-anchored weekIndex; WeeklyHPSums only
// ever returns weeks that had at least one ledger row (sparse) — a week with
// zero HP is simply absent, same as one nobody logged anything in.
type WeeklyHP struct {
	Week int64
	HP   int
}

// State is the cached gamification_state row for a user: lifetime HP, level,
// streak bookkeeping, banked freezes, and the insight tier. It is recomputed
// from the ledger and is never the only copy of anything. LastScoredDay is nil
// when the user has not been scored yet.
//
// BackfilledAt is the "historical window fully replayed" latch: nil until the
// 365-day backfill completes, then a fixed timestamp. It is deliberately
// distinct from LastScoredDay — which advances on the first backfilled day and
// on every ordinary daily score — so a partial backfill or an unrelated live
// score is never mistaken for a finished backfill. Internal bookkeeping, so it
// is not serialized (json:"-").
type State struct {
	UserID        int64      `json:"-"`
	LifetimeHP    int        `json:"lifetime_hp"`
	Level         int        `json:"level"`
	CurrentStreak int        `json:"current_streak"`
	LongestStreak int        `json:"longest_streak"`
	Freezes       int        `json:"freezes"`
	InsightTier   int        `json:"insight_tier"`
	LastScoredDay *time.Time `json:"last_scored_day,omitempty"`
	BackfilledAt  *time.Time `json:"-"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// RingScore is a read-model aggregate: the total HP earned within one Ring over
// some period. The domain service builds these from the ledger for GetSummary
// (Plan 2's read surface); the store may return them from grouped HP sums.
type RingScore struct {
	Ring string `json:"ring"`
	HP   int    `json:"hp"`
	// Closed is true when the ring earned a non-floor award (outcome or
	// consistency) in the period — i.e. the user did better than merely
	// logging. Drives the Today "X of 5 rings closed" summary and the
	// "your move" picker. Floor-only HP (the honesty payout) leaves the
	// ring open.
	Closed bool `json:"closed"`
	// Progress is the ring's fill gauge, 0..1 (1.0 == closed/full). Closed
	// always reports 1.0 — Progress and Closed can no longer disagree, which
	// is the fix for "closed but the bar isn't full". An open ring reports
	// its best range-membership r for the day (how close to closing). Only
	// populated for today's rings; period rings leave this 0 — the gauge is a
	// daily-loop affordance, not a weekly one.
	Progress float64 `json:"progress"`
	// Goal is a short imperative description of what closes this ring, built
	// server-side from the user's effective bands + food targets (e.g. "Sleep
	// 7–9h", "Eat near target · 1,800–2,200 kcal"). Plain text, no design
	// tokens — the frontend renders it verbatim as the ring's subtitle.
	// Config-derived, not data-derived, so it is populated for both today's and
	// period rings.
	Goal string `json:"goal"`
	// SyncPending is true when this is a today's ring whose outcome source is
	// device-synced (Mind ← sleep, Movement ← steps), the ring hasn't closed,
	// and no sample has arrived yet today — "hasn't synced", not "failed".
	// Always false for period rings and for rings not sourced from
	// device-synced data. Display-only: it does not change HP/ledger math.
	SyncPending bool `json:"sync_pending"`
}

// Repo is the gamification repository. Construct with New; share one *Repo per
// process — the underlying *db.DB owns its own connection pool.
type Repo struct {
	db  *storedb.DB
	now func() time.Time
}

// New returns a Repo bound to the shared *db.DB. The composition root passes in
// the same *db.DB it gives every other repo so all reads/writes go through one
// connection pool.
func New(d *storedb.DB) *Repo {
	return &Repo{db: d, now: time.Now}
}

// SetClock overrides the time source used for updated_at_unix / created_at_unix
// stamps. Tests use it to inject a deterministic timestamp; production code
// should never call it.
func (r *Repo) SetClock(now func() time.Time) {
	r.now = now
}

// ListTargets returns the user's target overrides, ordered by metric_key for a
// stable read. An empty slice (not nil error) means the user has no overrides
// and is fully on the recommended defaults.
func (r *Repo) ListTargets(ctx context.Context, userID int64) ([]Target, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, user_id, metric_key, low_val, high_val, falloff, mode, updated_at_unix
		   FROM gamification_targets WHERE user_id = ? ORDER BY metric_key`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var targets []Target
	for rows.Next() {
		t, err := scanTarget(rows)
		if err != nil {
			return nil, err
		}
		targets = append(targets, t)
	}
	return targets, rows.Err()
}

// UpsertTarget inserts or replaces the user's override for t.MetricKey. The
// UNIQUE (user_id, metric_key) constraint drives an ON CONFLICT DO UPDATE so the
// row's id is preserved across edits. updated_at_unix is stamped from the repo
// clock. Returns the persisted row (with its id + stamped UpdatedAt).
func (r *Repo) UpsertTarget(ctx context.Context, userID int64, t Target) (*Target, error) {
	nowUnix := storedb.TimeToUnix(r.now())
	row := r.db.QueryRowContext(ctx,
		`INSERT INTO gamification_targets
		   (user_id, metric_key, low_val, high_val, falloff, mode, updated_at_unix)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, metric_key) DO UPDATE SET
		   low_val = excluded.low_val,
		   high_val = excluded.high_val,
		   falloff = excluded.falloff,
		   mode = excluded.mode,
		   updated_at_unix = excluded.updated_at_unix
		 RETURNING id, user_id, metric_key, low_val, high_val, falloff, mode, updated_at_unix`,
		userID, t.MetricKey, nullFloat(t.LowVal), nullFloat(t.HighVal), nullFloat(t.Falloff), nullString(t.Mode), nowUnix)
	out, err := scanTarget(row)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteTarget removes the user's override for metricKey, reverting them to the
// recommended default. Returns sql.ErrNoRows if no override existed (either
// never set or owned by a different user).
func (r *Repo) DeleteTarget(ctx context.Context, userID int64, metricKey string) error {
	res, err := r.db.ExecContext(ctx,
		`DELETE FROM gamification_targets WHERE user_id = ? AND metric_key = ?`, userID, metricKey)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// scanner is satisfied by both *sql.Row and *sql.Rows so scanTarget serves the
// single-row (upsert RETURNING) and multi-row (list) read paths.
type scanner interface {
	Scan(dest ...interface{}) error
}

// scanTarget reads one gamification_targets row, mapping NULL low/high/falloff
// to nil pointers and NULL/empty mode to "".
func scanTarget(s scanner) (Target, error) {
	var t Target
	var lo, hi, fo sql.NullFloat64
	var mode sql.NullString
	var updatedUnix int64
	if err := s.Scan(&t.ID, &t.UserID, &t.MetricKey, &lo, &hi, &fo, &mode, &updatedUnix); err != nil {
		return Target{}, err
	}
	if lo.Valid {
		v := lo.Float64
		t.LowVal = &v
	}
	if hi.Valid {
		v := hi.Float64
		t.HighVal = &v
	}
	if fo.Valid {
		v := fo.Float64
		t.Falloff = &v
	}
	if mode.Valid {
		t.Mode = mode.String
	}
	t.UpdatedAt = storedb.UnixToTime(updatedUnix)
	return t, nil
}

// nullFloat maps a nil *float64 to a NULL bind argument and a non-nil one to its
// value, so optional REAL columns round-trip cleanly.
func nullFloat(p *float64) interface{} {
	if p == nil {
		return nil
	}
	return *p
}

// nullString maps "" to a NULL bind argument so an unset mode stores as NULL.
func nullString(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}
