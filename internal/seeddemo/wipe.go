package seeddemo

import (
	"context"
	"fmt"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

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

	// intake_reminders has FK to intake_log with ON DELETE CASCADE, but FK
	// enforcement is off in modernc/sqlite — clear it explicitly before
	// intake_log so the wipe doesn't leave dangling rows. Same pattern for
	// miband_gps_tracks → miband_workouts.
	scopedJoins := []struct{ name, query string }{
		{"intake_reminders", "DELETE FROM intake_reminders WHERE intake_id IN (SELECT id FROM intake_log WHERE user_id = ?)"},
		{"miband_gps_tracks", "DELETE FROM miband_gps_tracks WHERE workout_id IN (SELECT id FROM miband_workouts WHERE user_id = ?)"},
	}
	for _, j := range scopedJoins {
		if _, err := tx.ExecContext(ctx, j.query, userID); err != nil {
			return fmt.Errorf("wipe %s: %w", j.name, err)
		}
	}

	// User-scoped tables (have a user_id column).
	scoped := []string{
		"intake_log",
		"blood_pressure_readings",
		"weight_logs",
		"sleep_logs",
		"food_log",
		"food_products",
		"diary_notes",
		"weight_reminder_state",
		"bp_reminder_state",
		"push_subscriptions",
		"vitals_heart",
		"vitals_spo2",
		"vitals_stress",
		"day_stats",
		"miband_workouts",
		"exercise_library",
	}
	for _, table := range scoped {
		// #nosec G202 -- table is from a fixed in-package list, not user input.
		if _, err := tx.ExecContext(ctx, "DELETE FROM "+table+" WHERE user_id = ?", userID); err != nil {
			return fmt.Errorf("wipe %s: %w", table, err)
		}
	}

	// Workout tables: rows are user-scoped via workout_groups.user_id and
	// workout_sessions.user_id. Delete child rows first to satisfy any
	// pragma_foreign_keys checks if they get enabled later.
	workoutDeletes := []string{
		// Logs hang off sessions; sessions carry user_id directly.
		"DELETE FROM workout_exercise_logs WHERE session_id IN (SELECT id FROM workout_sessions WHERE user_id = ?)",
		"DELETE FROM workout_sessions WHERE user_id = ?",
		// Rotation state, exercises, variants, snapshots all hang off groups.
		"DELETE FROM workout_rotation_state WHERE group_id IN (SELECT id FROM workout_groups WHERE user_id = ?)",
		"DELETE FROM workout_exercises WHERE variant_id IN (SELECT v.id FROM workout_variants v JOIN workout_groups g ON v.group_id = g.id WHERE g.user_id = ?)",
		"DELETE FROM workout_schedule_snapshots WHERE group_id IN (SELECT id FROM workout_groups WHERE user_id = ?)",
		"DELETE FROM workout_variants WHERE group_id IN (SELECT id FROM workout_groups WHERE user_id = ?)",
		"DELETE FROM workout_groups WHERE user_id = ?",
	}
	for _, q := range workoutDeletes {
		if _, err := tx.ExecContext(ctx, q, userID); err != nil {
			return fmt.Errorf("wipe workouts: %w", err)
		}
	}

	// Single-user tables that don't carry user_id but logically belong to
	// the demoed user. The seeder will repopulate them, so wipe wholesale.
	// tz_transition_steps must go before tz_transition_plans (FK reference)
	// and before medications since plans reference medications.
	// medication_restocks is a child of medications (FK ON DELETE CASCADE)
	// but FK enforcement is off in modernc/sqlite, so clear it explicitly
	// before medications to avoid orphan rows.
	wholesale := []string{
		"DELETE FROM tz_transition_steps",
		"DELETE FROM tz_transition_plans",
		"DELETE FROM medication_restocks",
		"DELETE FROM medications",
		"DELETE FROM timezone_history",
		// change_events is fed by triggers on every domain table; the
		// seeder's INSERTs (and the deletes above) leave thousands of rows.
		// Clear them so re-runs don't accumulate change-feed history.
		"DELETE FROM change_events",
	}
	for _, q := range wholesale {
		if _, err := tx.ExecContext(ctx, q); err != nil {
			return fmt.Errorf("wipe wholesale %q: %w", q, err)
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

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit wipe: %w", err)
	}
	return nil
}
