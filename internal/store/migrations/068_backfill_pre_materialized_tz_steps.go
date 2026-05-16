package migrations

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"

	"github.com/pressly/goose/v3"
)

// Migration 068 is the project's first goose Go migration. It backfills
// intake_log rows for any tz_transition_plans currently in APPROVED with steps
// whose `consumed_at IS NULL`, so the Track D scheduler (which reads
// pre-materialized rows from intake_log instead of tz_transition_steps) does
// not silently lose the un-fired steps of a plan that was approved before this
// migration ran.
//
// SQL migrations cannot read environment variables, so this lives as Go: the
// project is single-user gated by ALLOWED_USER_ID at cmd/bot/main.go, and
// intake_log.user_id is INTEGER NOT NULL with no medications.user_id column to
// derive it from. A SELECT-based fallback (`SELECT user_id FROM intake_log
// LIMIT 1`) would silently no-op on a fresh deploy that has an APPROVED plan
// but zero fired intake rows yet — losing that plan's scheduling. Failing
// loudly when the env var is unset is the correct behaviour: the binary itself
// won't start without ALLOWED_USER_ID, so this can only fire during an
// out-of-band migration run.
//
// Document the precedent in docs/architecture.md so future Go migrations
// follow the same shape.
func init() {
	goose.AddMigrationContext(upBackfillPreMaterializedTZSteps, downBackfillPreMaterializedTZSteps)
}

func upBackfillPreMaterializedTZSteps(ctx context.Context, tx *sql.Tx) error {
	// Short-circuit when there's nothing to back-fill. This keeps the
	// migration idempotent on fresh databases and on every test fixture
	// that runs migrations against an empty schema (no APPROVED plans →
	// nothing to attribute, so we don't need ALLOWED_USER_ID).
	var pendingSteps int
	if err := tx.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM tz_transition_steps s
		JOIN tz_transition_plans p ON p.id = s.plan_id
		WHERE p.status = 'APPROVED' AND s.consumed_at IS NULL`).Scan(&pendingSteps); err != nil {
		return fmt.Errorf("backfill 068: count pending steps: %w", err)
	}
	if pendingSteps == 0 {
		return nil
	}

	userIDStr := os.Getenv("ALLOWED_USER_ID")
	if userIDStr == "" {
		return errors.New("backfill 068: ALLOWED_USER_ID not set; cannot attribute pre-materialized tz_step rows")
	}
	userID, err := strconv.ParseInt(userIDStr, 10, 64)
	if err != nil {
		return fmt.Errorf("backfill 068: invalid ALLOWED_USER_ID %q: %w", userIDStr, err)
	}

	// PRAGMA foreign_keys is OFF on the runtime connection (see
	// internal/store/miband_workouts.go), so a deleted medication can leave
	// orphan tz_transition_steps. The inner JOIN below silently drops those —
	// surface a count so an operator can investigate. Dropping is the right
	// outcome: a step for a deleted medication has no medication to dose.
	var orphans int
	_ = tx.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM tz_transition_steps s
		JOIN tz_transition_plans p ON p.id = s.plan_id
		LEFT JOIN medications m ON m.id = s.medication_id
		WHERE p.status = 'APPROVED' AND s.consumed_at IS NULL
		  AND m.id IS NULL`).Scan(&orphans)
	if orphans > 0 {
		slog.Warn("backfill 068: skipping tz steps for deleted medications",
			"orphan_count", orphans)
	}

	// tz_transition_steps.scheduled_at is still DATETIME (Track A skipped
	// the table — Track D Task 13 will drop it). modernc.org/sqlite stores
	// time.Time as "YYYY-MM-DD HH:MM:SS ±HHMM ZZZ" (Go's t.String()) and
	// SQLite's strftime cannot parse the trailing zone name; we apply the
	// same COALESCE/substr trick migration 057 introduced for
	// intake_log.scheduled_at.
	//
	// INSERT OR IGNORE is safe with the partial unique index added in
	// migration 067 — replaying the migration (or a concurrent
	// ApproveAndMaterialize) cannot create duplicates.
	res, err := tx.ExecContext(ctx, `
		INSERT OR IGNORE INTO intake_log
		  (medication_id, user_id, scheduled_at_unix, status,
		   source, tz_plan_id, tz_step_number)
		SELECT
		  s.medication_id,
		  ?,
		  CAST(
		    COALESCE(
		      strftime('%s', s.scheduled_at),
		      strftime('%s',
		        substr(s.scheduled_at, 1, 19) || ' ' ||
		        substr(s.scheduled_at, 20 + instr(substr(s.scheduled_at, 20), ' '), 3) || ':' ||
		        substr(s.scheduled_at, 20 + instr(substr(s.scheduled_at, 20), ' ') + 3, 2)
		      )
		    ) AS INTEGER
		  ),
		  'PENDING',
		  'tz_step',
		  s.plan_id,
		  s.step_number
		FROM tz_transition_steps s
		JOIN tz_transition_plans p ON p.id = s.plan_id
		JOIN medications m ON m.id = s.medication_id
		WHERE p.status = 'APPROVED'
		  AND s.consumed_at IS NULL`, userID)
	if err != nil {
		return fmt.Errorf("backfill 068: insert: %w", err)
	}
	n, _ := res.RowsAffected()
	slog.Info("backfill 068: pre-materialized tz step rows",
		"count", n, "orphans_skipped", orphans)
	return nil
}

func downBackfillPreMaterializedTZSteps(ctx context.Context, tx *sql.Tx) error {
	// Down removes any unconsumed pre-materialized rows we inserted. We can
	// only safely identify them by source='tz_step' AND status='PENDING':
	// rows the user has confirmed (status='TAKEN') belong to the user even
	// after rollback.
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM intake_log
		WHERE source = 'tz_step' AND status = 'PENDING'`); err != nil {
		return fmt.Errorf("backfill 068 down: delete: %w", err)
	}
	return nil
}
