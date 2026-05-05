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
	if _, err := tx.ExecContext(ctx, "DELETE FROM intake_log"); err != nil {
		return fmt.Errorf("wipe intake_log (full): %w", err)
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM medications"); err != nil {
		return fmt.Errorf("wipe medications: %w", err)
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM timezone_history"); err != nil {
		return fmt.Errorf("wipe timezone_history: %w", err)
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
