package gamification

import (
	"context"
	"database/sql"
	"errors"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// UpsertLedger writes a batch of HP awards for one user. Each entry is an
// INSERT OR REPLACE keyed on the UNIQUE (user_id, day_unix, ring,
// source_metric, kind) tuple, so re-scoring a day overwrites the matching row
// instead of accumulating duplicates — this is what makes the daily rescore and
// the 365-day backfill idempotent. The whole batch runs in one transaction so a
// day's awards land all-or-nothing. created_at_unix is stamped from the repo
// clock; Day is normalized to UTC-midnight before becoming day_unix. An empty
// slice is a no-op.
func (r *Repo) UpsertLedger(ctx context.Context, userID int64, entries []LedgerEntry) error {
	if len(entries) == 0 {
		return nil
	}
	nowUnix := storedb.TimeToUnix(r.now())
	return r.db.WithTx(ctx, func(tx storedb.TX) error {
		return upsertLedgerTx(ctx, tx, userID, entries, nowUnix)
	})
}

// ListLedger returns the user's HP awards whose day_unix falls in the inclusive
// [sinceDayUnix, untilDayUnix] range, ordered by (day_unix, ring,
// source_metric, kind) for a stable read. Bounds are UTC-midnight unix-seconds;
// pass the same day key the scorer wrote.
func (r *Repo) ListLedger(ctx context.Context, userID, sinceDayUnix, untilDayUnix int64) ([]LedgerEntry, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, user_id, day_unix, ring, source_metric, kind, hp, detail, created_at_unix
		   FROM gamification_ledger
		  WHERE user_id = ? AND day_unix >= ? AND day_unix <= ?
		  ORDER BY day_unix, ring, source_metric, kind`, userID, sinceDayUnix, untilDayUnix)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []LedgerEntry
	for rows.Next() {
		e, err := scanLedger(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// SumHP returns the user's lifetime HP — the sum of hp across every ledger row.
// COALESCE keeps a user with no awards at 0 rather than NULL.
func (r *Repo) SumHP(ctx context.Context, userID int64) (int, error) {
	var sum int
	err := r.db.QueryRowContext(ctx,
		`SELECT COALESCE(SUM(hp), 0) FROM gamification_ledger WHERE user_id = ?`, userID).Scan(&sum)
	if err != nil {
		return 0, err
	}
	return sum, nil
}

// GetState returns the user's cached gamification_state. When no row exists yet
// (the user has never been scored) it returns the same defaults a freshly
// inserted row would carry — Level 1, InsightTier 1, everything else zero — so
// callers never special-case "not yet scored".
func (r *Repo) GetState(ctx context.Context, userID int64) (State, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT user_id, lifetime_hp, level, current_streak, longest_streak, freezes, insight_tier, last_scored_day_unix, updated_at_unix
		   FROM gamification_state WHERE user_id = ?`, userID)
	s, err := scanState(row)
	if errors.Is(err, sql.ErrNoRows) {
		return State{UserID: userID, Level: 1, InsightTier: 1}, nil
	}
	if err != nil {
		return State{}, err
	}
	return s, nil
}

// UpsertState inserts or replaces the user's cached state row, preserving it via
// ON CONFLICT(user_id) DO UPDATE. updated_at_unix is stamped from the repo
// clock; LastScoredDay (nil ⇒ NULL) is normalized to UTC-midnight. Returns the
// persisted row.
func (r *Repo) UpsertState(ctx context.Context, userID int64, st State) (*State, error) {
	nowUnix := storedb.TimeToUnix(r.now())
	out, err := upsertStateTx(ctx, r.db, userID, st, nowUnix)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ApplyDayScore writes a day's ledger awards and the recomputed state row in a
// single transaction so the cached state never drifts from the ledger it
// summarizes (the "state update must accompany a ledger write" invariant). Both
// the batch of INSERT OR REPLACE awards and the state upsert commit together or
// roll back together. Returns the persisted state.
func (r *Repo) ApplyDayScore(ctx context.Context, userID int64, entries []LedgerEntry, st State) (*State, error) {
	nowUnix := storedb.TimeToUnix(r.now())
	var out State
	err := r.db.WithTx(ctx, func(tx storedb.TX) error {
		if err := upsertLedgerTx(ctx, tx, userID, entries, nowUnix); err != nil {
			return err
		}
		s, err := upsertStateTx(ctx, tx, userID, st, nowUnix)
		if err != nil {
			return err
		}
		out = s
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// upsertLedgerTx runs the INSERT OR REPLACE for each entry against the given TX
// so the same SQL path serves both the standalone UpsertLedger transaction and
// the combined ApplyDayScore transaction.
func upsertLedgerTx(ctx context.Context, tx storedb.TX, userID int64, entries []LedgerEntry, nowUnix int64) error {
	for _, e := range entries {
		if _, err := tx.ExecContext(ctx,
			`INSERT OR REPLACE INTO gamification_ledger
			   (user_id, day_unix, ring, source_metric, kind, hp, detail, created_at_unix)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			userID, dayToUnix(e.Day), e.Ring, e.SourceMetric, e.Kind, e.HP, nullString(e.Detail), nowUnix); err != nil {
			return err
		}
	}
	return nil
}

// upsertStateTx runs the state INSERT ... ON CONFLICT against the given TX,
// returning the persisted row via RETURNING.
func upsertStateTx(ctx context.Context, tx storedb.TX, userID int64, st State, nowUnix int64) (State, error) {
	var lastScored interface{}
	if st.LastScoredDay != nil {
		lastScored = dayToUnix(*st.LastScoredDay)
	}
	row := tx.QueryRowContext(ctx,
		`INSERT INTO gamification_state
		   (user_id, lifetime_hp, level, current_streak, longest_streak, freezes, insight_tier, last_scored_day_unix, updated_at_unix)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
		   lifetime_hp = excluded.lifetime_hp,
		   level = excluded.level,
		   current_streak = excluded.current_streak,
		   longest_streak = excluded.longest_streak,
		   freezes = excluded.freezes,
		   insight_tier = excluded.insight_tier,
		   last_scored_day_unix = excluded.last_scored_day_unix,
		   updated_at_unix = excluded.updated_at_unix
		 RETURNING user_id, lifetime_hp, level, current_streak, longest_streak, freezes, insight_tier, last_scored_day_unix, updated_at_unix`,
		userID, st.LifetimeHP, st.Level, st.CurrentStreak, st.LongestStreak, st.Freezes, st.InsightTier, lastScored, nowUnix)
	return scanState(row)
}

// scanLedger reads one gamification_ledger row, mapping NULL detail to "" and
// the unix-seconds columns back to UTC time.Times.
func scanLedger(s scanner) (LedgerEntry, error) {
	var e LedgerEntry
	var dayUnix, createdUnix int64
	var detail sql.NullString
	if err := s.Scan(&e.ID, &e.UserID, &dayUnix, &e.Ring, &e.SourceMetric, &e.Kind, &e.HP, &detail, &createdUnix); err != nil {
		return LedgerEntry{}, err
	}
	e.Day = storedb.UnixToTime(dayUnix)
	if detail.Valid {
		e.Detail = detail.String
	}
	e.CreatedAt = storedb.UnixToTime(createdUnix)
	return e, nil
}

// scanState reads one gamification_state row, mapping NULL last_scored_day_unix
// to a nil *time.Time and the *_unix columns back to UTC time.Times.
func scanState(s scanner) (State, error) {
	var st State
	var lastScored sql.NullInt64
	var updatedUnix int64
	if err := s.Scan(&st.UserID, &st.LifetimeHP, &st.Level, &st.CurrentStreak, &st.LongestStreak, &st.Freezes, &st.InsightTier, &lastScored, &updatedUnix); err != nil {
		return State{}, err
	}
	st.LastScoredDay = storedb.NullableUnixToTimePtr(lastScored)
	st.UpdatedAt = storedb.UnixToTime(updatedUnix)
	return st, nil
}

// dayToUnix normalizes any instant to UTC-midnight unix-seconds — the canonical
// day key for the ledger's UNIQUE dedupe and for last_scored_day_unix. Callers
// that already pass a UTC-midnight time round-trip unchanged.
func dayToUnix(day time.Time) int64 {
	d := day.UTC()
	return time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, time.UTC).Unix()
}
