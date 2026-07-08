package seeddemo

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// Each delete the wipe performs is paired with the table it clears so the set
// of wiped tables is machine-readable (see WipedTables). The vault's coverage
// guard (internal/server/vault_coverage_test.go) asserts that every table
// listed here is either carried by the vault or explicitly skipped with a
// reason — that agreement is what keeps a replace-import from silently
// dropping a user's data.
type wipeStep struct{ table, query string }

// intake_reminders has FK to intake_log with ON DELETE CASCADE, but FK
// enforcement is off in modernc/sqlite — clear it explicitly before
// intake_log so the wipe doesn't leave dangling rows. Same pattern for
// miband_gps_tracks → miband_workouts.
var wipeScopedJoins = []wipeStep{
	{"intake_reminders", "DELETE FROM intake_reminders WHERE intake_id IN (SELECT id FROM intake_log WHERE user_id = ?)"},
	{"miband_gps_tracks", "DELETE FROM miband_gps_tracks WHERE workout_id IN (SELECT id FROM miband_workouts WHERE user_id = ?)"},
}

// User-scoped tables (have a user_id column).
var wipeScoped = []string{
	"intake_log",
	"blood_pressure_readings",
	"weight_logs",
	"weight_goals",
	"sleep_logs",
	"food_log",
	"food_products",
	"diary_notes",
	"weight_reminder_state",
	"bp_reminder_state",
	"vitals_heart",
	"vitals_spo2",
	"vitals_stress",
	"day_stats",
	"miband_workouts",
	"exercise_library",
	"gamification_targets",
	"gamification_ledger",
	"gamification_state",
}

// Workout tables: rows are user-scoped via workout_groups.user_id and
// workout_sessions.user_id. Delete child rows first to satisfy any
// pragma_foreign_keys checks if they get enabled later.
var wipeWorkouts = []wipeStep{
	// Logs hang off sessions; sessions carry user_id directly.
	{"workout_exercise_logs", "DELETE FROM workout_exercise_logs WHERE session_id IN (SELECT id FROM workout_sessions WHERE user_id = ?)"},
	{"workout_sessions", "DELETE FROM workout_sessions WHERE user_id = ?"},
	// Rotation state, exercises, variants, snapshots all hang off groups.
	{"workout_rotation_state", "DELETE FROM workout_rotation_state WHERE group_id IN (SELECT id FROM workout_groups WHERE user_id = ?)"},
	{"workout_exercises", "DELETE FROM workout_exercises WHERE variant_id IN (SELECT v.id FROM workout_variants v JOIN workout_groups g ON v.group_id = g.id WHERE g.user_id = ?)"},
	{"workout_schedule_snapshots", "DELETE FROM workout_schedule_snapshots WHERE group_id IN (SELECT id FROM workout_groups WHERE user_id = ?)"},
	{"workout_variants", "DELETE FROM workout_variants WHERE group_id IN (SELECT id FROM workout_groups WHERE user_id = ?)"},
	{"workout_groups", "DELETE FROM workout_groups WHERE user_id = ?"},
}

// Single-user tables that don't carry user_id but logically belong to
// the demoed user. The seeder will repopulate them, so wipe wholesale.
// medication_restocks is a child of medications (FK ON DELETE CASCADE)
// but FK enforcement is off in modernc/sqlite, so clear it explicitly
// before medications to avoid orphan rows. Track D Task 13 dropped the
// tz_transition_steps table; pre-materialized step rows now live in
// intake_log (wiped above by user_id) and the plan's audit blob lives in
// tz_transition_plans.steps_json, which the plan delete covers.
var wipeWholesale = []wipeStep{
	{"tz_transition_plans", "DELETE FROM tz_transition_plans"},
	{"medication_restocks", "DELETE FROM medication_restocks"},
	{"medications", "DELETE FROM medications"},
	{"timezone_history", "DELETE FROM timezone_history"},
	// change_events is fed by triggers on every domain table; the
	// seeder's INSERTs (and the deletes above) leave thousands of rows.
	// Clear them so re-runs don't accumulate change-feed history.
	{"change_events", "DELETE FROM change_events"},
}

// WipedTables returns every table WipeUserTx deletes rows from (WipeUser adds
// push_subscriptions on top — see there for why the import path must not). It is the
// authoritative "what belongs to one user" manifest; the vault must carry or
// explicitly skip each of them.
func WipedTables() []string {
	out := make([]string, 0, len(wipeScopedJoins)+len(wipeScoped)+len(wipeWorkouts)+len(wipeWholesale))
	for _, s := range wipeScopedJoins {
		out = append(out, s.table)
	}
	out = append(out, wipeScoped...)
	for _, s := range wipeWorkouts {
		out = append(out, s.table)
	}
	for _, s := range wipeWholesale {
		out = append(out, s.table)
	}
	return out
}

// WipeUser removes the target user's data from every domain table the
// seeder will repopulate. It also clears medications (which have no
// user_id column in this single-user schema) and the singleton
// timezone_history table, then resets the food targets on the singleton
// settings row.
//
// The deletes run inside a transaction so a failure midway leaves the
// database untouched; this matters because the seeder is meant to be
// re-run on the same DB before each demo.
func WipeUser(ctx context.Context, s *store.Store, userID int64) error {
	if userID == 0 {
		return fmt.Errorf("seeddemo: WipeUser requires a non-zero user_id")
	}

	tx, err := s.DB().BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if err := WipeUserTx(ctx, tx, userID); err != nil {
		return err
	}

	// Seeder-only: the vault import shares WipeUserTx and must NOT drop push
	// subscriptions. The browser keeps its PushSubscription across a restore, so
	// deleting the server row silently stops every reminder while the Settings
	// toggle still reads "enabled" — nothing ever re-subscribes.
	if _, err := tx.ExecContext(ctx, "DELETE FROM push_subscriptions WHERE user_id = ?", userID); err != nil {
		return fmt.Errorf("wipe push_subscriptions: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit wipe: %w", err)
	}
	return nil
}

// WipeUserTx runs the same per-user delete set as WipeUser inside a caller-
// supplied transaction, so a wipe-then-insert flow (bot-mode vault import) is
// one atomic unit. It does NOT commit — the caller owns the transaction.
func WipeUserTx(ctx context.Context, tx *sql.Tx, userID int64) error {
	if userID == 0 {
		return fmt.Errorf("seeddemo: WipeUserTx requires a non-zero user_id")
	}

	for _, j := range wipeScopedJoins {
		if _, err := tx.ExecContext(ctx, j.query, userID); err != nil {
			return fmt.Errorf("wipe %s: %w", j.table, err)
		}
	}

	for _, table := range wipeScoped {
		// #nosec G202 -- table is from a fixed in-package list, not user input.
		if _, err := tx.ExecContext(ctx, "DELETE FROM "+table+" WHERE user_id = ?", userID); err != nil {
			return fmt.Errorf("wipe %s: %w", table, err)
		}
	}

	for _, w := range wipeWorkouts {
		if _, err := tx.ExecContext(ctx, w.query, userID); err != nil {
			return fmt.Errorf("wipe %s: %w", w.table, err)
		}
	}

	for _, w := range wipeWholesale {
		if _, err := tx.ExecContext(ctx, w.query); err != nil {
			return fmt.Errorf("wipe wholesale %s: %w", w.table, err)
		}
	}

	// Reset food targets on the singleton settings row.
	if _, err := tx.ExecContext(ctx, `
		UPDATE settings
		SET food_target_calories = 0,
		    food_target_carbs = 0,
		    food_target_protein = 0,
		    food_target_fat = 0
		WHERE id = 1
	`); err != nil {
		return fmt.Errorf("reset food targets: %w", err)
	}

	return nil
}
