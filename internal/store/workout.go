package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// -- Workout Tracking --

// WorkoutGroup represents a workout group with schedule
type WorkoutGroup struct {
	ID                         int64     `json:"id"`
	Name                       string    `json:"name"`
	Description                string    `json:"description,omitempty"`
	IsRotating                 bool      `json:"is_rotating"`
	UserID                     int64     `json:"user_id"`
	DaysOfWeek                 string    `json:"days_of_week"` // JSON array
	ScheduledTime              string    `json:"scheduled_time"`
	NotificationAdvanceMinutes int       `json:"notification_advance_minutes"`
	Active                     bool      `json:"active"`
	CreatedAt                  time.Time `json:"created_at"`
	UpdatedAt                  time.Time `json:"updated_at"`
}

// WorkoutVariant represents a workout variant (Day A, B, C, D or Default)
type WorkoutVariant struct {
	ID            int64     `json:"id"`
	GroupID       int64     `json:"group_id"`
	Name          string    `json:"name"`
	RotationOrder *int      `json:"rotation_order,omitempty"` // NULL for non-rotating
	Description   string    `json:"description,omitempty"`
	CreatedAt     time.Time `json:"created_at"`
}

// WorkoutExercise represents an exercise within a variant
type WorkoutExercise struct {
	ID             int64    `json:"id"`
	VariantID      int64    `json:"variant_id"`
	ExerciseName   string   `json:"exercise_name"`
	TargetSets     int      `json:"target_sets"`
	TargetRepsMin  int      `json:"target_reps_min"`
	TargetRepsMax  *int     `json:"target_reps_max,omitempty"`
	TargetWeightKg *float64 `json:"target_weight_kg,omitempty"`
	OrderIndex     int      `json:"order_index"`
}

// WorkoutSession represents an actual workout instance
type WorkoutSession struct {
	ID                    int64      `json:"id"`
	GroupID               int64      `json:"group_id"`   // -1 for ad-hoc workouts
	VariantID             int64      `json:"variant_id"` // -1 for ad-hoc workouts
	UserID                int64      `json:"user_id"`
	ScheduledDate         time.Time  `json:"scheduled_date"`
	ScheduledTime         string     `json:"scheduled_time"`
	Status                string     `json:"status"` // pending, notified, in_progress, completed, skipped
	StartedAt             *time.Time `json:"started_at,omitempty"`
	CompletedAt           *time.Time `json:"completed_at,omitempty"`
	SnoozedUntil          *time.Time `json:"snoozed_until,omitempty"`
	SnoozeCount           int        `json:"snooze_count"`
	NotificationMessageID *int       `json:"notification_message_id,omitempty"`
	Notes                 string     `json:"notes,omitempty"`
}

// WorkoutExerciseLog represents completion of a single exercise
type WorkoutExerciseLog struct {
	ID            int64     `json:"id"`
	SessionID     int64     `json:"session_id"`
	ExerciseID    int64     `json:"exercise_id"`
	ExerciseName  string    `json:"exercise_name"`
	SetsCompleted *int      `json:"sets_completed,omitempty"`
	RepsCompleted *int      `json:"reps_completed,omitempty"`
	WeightKg      *float64  `json:"weight_kg,omitempty"`
	Status        string    `json:"status"` // completed, skipped
	Notes         string    `json:"notes,omitempty"`
	LoggedAt      time.Time `json:"logged_at"`
	Source        string    `json:"source"` // "schedule" or "library"
}

// WorkoutRotationState tracks the current rotation position
type WorkoutRotationState struct {
	GroupID          int64      `json:"group_id"`
	CurrentVariantID int64      `json:"current_variant_id"`
	LastSessionDate  *time.Time `json:"last_session_date,omitempty"`
	UpdatedAt        time.Time  `json:"updated_at"`
}

// ExerciseStat holds aggregated statistics for a single exercise across all sessions
type ExerciseStat struct {
	ExerciseName  string  `json:"exercise_name"`
	SessionCount  int     `json:"session_count"`
	TotalVolumeKg float64 `json:"total_volume_kg"`
	MaxWeightKg   float64 `json:"max_weight_kg"`
}

// WorkoutScheduleSnapshot represents a snapshot of a group's schedule
type WorkoutScheduleSnapshot struct {
	ID           int64     `json:"id"`
	GroupID      int64     `json:"group_id"`
	SnapshotData string    `json:"snapshot_data"` // JSON
	ChangeReason string    `json:"change_reason,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
}

// -- Workout Group Methods --

func (s *Store) CreateWorkoutGroup(name, description string, isRotating bool, userID int64, daysOfWeek string, scheduledTime string, notificationAdvance int) (*WorkoutGroup, error) {
	res, err := s.db.Exec(`
		INSERT INTO workout_groups (name, description, is_rotating, user_id, days_of_week, scheduled_time, notification_advance_minutes)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		name, description, isRotating, userID, daysOfWeek, scheduledTime, notificationAdvance)
	if err != nil {
		return nil, err
	}

	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}

	return s.GetWorkoutGroup(id)
}

func (s *Store) ListWorkoutGroups(userID int64, activeOnly bool) ([]WorkoutGroup, error) {
	query := "SELECT id, name, description, is_rotating, user_id, days_of_week, scheduled_time, notification_advance_minutes, active, created_at, updated_at FROM workout_groups WHERE user_id = ?"
	args := []interface{}{userID}

	if activeOnly {
		query += " AND active = 1"
	}

	query += " ORDER BY name ASC"

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var groups []WorkoutGroup
	for rows.Next() {
		var g WorkoutGroup
		var desc sql.NullString
		if err := rows.Scan(&g.ID, &g.Name, &desc, &g.IsRotating, &g.UserID, &g.DaysOfWeek, &g.ScheduledTime, &g.NotificationAdvanceMinutes, &g.Active, &g.CreatedAt, &g.UpdatedAt); err != nil {
			return nil, err
		}
		if desc.Valid {
			g.Description = desc.String
		}
		groups = append(groups, g)
	}
	return groups, nil
}

func (s *Store) GetWorkoutGroup(id int64) (*WorkoutGroup, error) {
	var g WorkoutGroup
	var desc sql.NullString
	err := s.db.QueryRow(`
		SELECT id, name, description, is_rotating, user_id, days_of_week, scheduled_time, notification_advance_minutes, active, created_at, updated_at 
		FROM workout_groups WHERE id = ?`, id).Scan(
		&g.ID, &g.Name, &desc, &g.IsRotating, &g.UserID, &g.DaysOfWeek, &g.ScheduledTime, &g.NotificationAdvanceMinutes, &g.Active, &g.CreatedAt, &g.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if desc.Valid {
		g.Description = desc.String
	}
	return &g, nil
}

func (s *Store) UpdateWorkoutGroup(id int64, name, description string, isRotating bool, daysOfWeek string, scheduledTime string, notificationAdvance int, active bool) error {
	_, err := s.db.Exec(`
		UPDATE workout_groups 
		SET name = ?, description = ?, is_rotating = ?, days_of_week = ?, scheduled_time = ?, notification_advance_minutes = ?, active = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?`,
		name, description, isRotating, daysOfWeek, scheduledTime, notificationAdvance, active, id)
	return err
}

func (s *Store) DeleteWorkoutGroup(id int64) error {
	var exerciseCount, activeSessionCount int

	// Use single query to fetch both exercise count and active session count
	err := s.db.QueryRow(`
		SELECT
			(SELECT COUNT(*) FROM workout_exercises we
			 JOIN workout_variants wv ON we.variant_id = wv.id
			 WHERE wv.group_id = ?),
			(SELECT COUNT(*) FROM workout_sessions
			 WHERE group_id = ? AND status NOT IN ('completed', 'skipped'))
	`, id, id).Scan(&exerciseCount, &activeSessionCount)
	if err != nil {
		return err
	}

	if exerciseCount > 0 {
		return fmt.Errorf("cannot delete group: remove all exercises from its variants first (%d remaining)", exerciseCount)
	}
	if activeSessionCount > 0 {
		return fmt.Errorf("cannot delete group: it has %d pending/active sessions", activeSessionCount)
	}

	// Delete rotation state
	if _, err := s.db.Exec("DELETE FROM workout_rotation_state WHERE group_id = ?", id); err != nil {
		return err
	}
	// Delete schedule snapshots
	if _, err := s.db.Exec("DELETE FROM workout_schedule_snapshots WHERE group_id = ?", id); err != nil {
		return err
	}
	// Delete variants (exercises already verified empty)
	if _, err := s.db.Exec("DELETE FROM workout_variants WHERE group_id = ?", id); err != nil {
		return err
	}
	// Delete the group
	_, err = s.db.Exec("DELETE FROM workout_groups WHERE id = ?", id)
	return err
}

// -- Workout Variant Methods --

func (s *Store) CreateWorkoutVariant(groupID int64, name string, rotationOrder *int, description string) (*WorkoutVariant, error) {
	res, err := s.db.Exec(`
		INSERT INTO workout_variants (group_id, name, rotation_order, description)
		VALUES (?, ?, ?, ?)`,
		groupID, name, rotationOrder, description)
	if err != nil {
		return nil, err
	}

	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}

	return s.GetWorkoutVariant(id)
}

func (s *Store) ListVariantsByGroup(groupID int64) ([]WorkoutVariant, error) {
	rows, err := s.db.Query(`
		SELECT id, group_id, name, rotation_order, description, created_at 
		FROM workout_variants 
		WHERE group_id = ? 
		ORDER BY COALESCE(rotation_order, 999), name ASC`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var variants []WorkoutVariant
	for rows.Next() {
		var v WorkoutVariant
		var rotationOrder sql.NullInt64
		var desc sql.NullString
		if err := rows.Scan(&v.ID, &v.GroupID, &v.Name, &rotationOrder, &desc, &v.CreatedAt); err != nil {
			return nil, err
		}
		if rotationOrder.Valid {
			r := int(rotationOrder.Int64)
			v.RotationOrder = &r
		}
		if desc.Valid {
			v.Description = desc.String
		}
		variants = append(variants, v)
	}
	return variants, nil
}

func (s *Store) GetWorkoutVariant(id int64) (*WorkoutVariant, error) {
	var v WorkoutVariant
	var rotationOrder sql.NullInt64
	var desc sql.NullString
	err := s.db.QueryRow(`
		SELECT id, group_id, name, rotation_order, description, created_at 
		FROM workout_variants WHERE id = ?`, id).Scan(
		&v.ID, &v.GroupID, &v.Name, &rotationOrder, &desc, &v.CreatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if rotationOrder.Valid {
		r := int(rotationOrder.Int64)
		v.RotationOrder = &r
	}
	if desc.Valid {
		v.Description = desc.String
	}
	return &v, nil
}

func (s *Store) UpdateWorkoutVariant(id int64, name string, rotationOrder *int, description string) error {
	_, err := s.db.Exec(`
		UPDATE workout_variants 
		SET name = ?, rotation_order = ?, description = ?
		WHERE id = ?`,
		name, rotationOrder, description, id)
	return err
}

func (s *Store) DeleteWorkoutVariant(id int64) error {
	// Delete all exercises in this variant first
	_, err := s.db.Exec("DELETE FROM workout_exercises WHERE variant_id = ?", id)
	if err != nil {
		return err
	}
	// Then delete the variant
	_, err = s.db.Exec("DELETE FROM workout_variants WHERE id = ?", id)
	return err
}

// -- Exercise Methods --

func (s *Store) AddExerciseToVariant(variantID int64, exerciseName string, targetSets, targetRepsMin int, targetRepsMax *int, targetWeightKg *float64, orderIndex int) (*WorkoutExercise, error) {
	res, err := s.db.Exec(`
		INSERT INTO workout_exercises (variant_id, exercise_name, target_sets, target_reps_min, target_reps_max, target_weight_kg, order_index)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		variantID, exerciseName, targetSets, targetRepsMin, targetRepsMax, targetWeightKg, orderIndex)
	if err != nil {
		return nil, err
	}

	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}

	return s.GetWorkoutExercise(id)
}

func (s *Store) ListExercisesByVariant(variantID int64) ([]WorkoutExercise, error) {
	rows, err := s.db.Query(`
		SELECT id, variant_id, exercise_name, target_sets, target_reps_min, target_reps_max, target_weight_kg, order_index
		FROM workout_exercises 
		WHERE variant_id = ? 
		ORDER BY order_index ASC`, variantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var exercises []WorkoutExercise
	for rows.Next() {
		var e WorkoutExercise
		var repsMax sql.NullInt64
		var weightKg sql.NullFloat64
		if err := rows.Scan(&e.ID, &e.VariantID, &e.ExerciseName, &e.TargetSets, &e.TargetRepsMin, &repsMax, &weightKg, &e.OrderIndex); err != nil {
			return nil, err
		}
		if repsMax.Valid {
			r := int(repsMax.Int64)
			e.TargetRepsMax = &r
		}
		if weightKg.Valid {
			e.TargetWeightKg = &weightKg.Float64
		}
		exercises = append(exercises, e)
	}
	return exercises, nil
}

func (s *Store) GetWorkoutExercise(id int64) (*WorkoutExercise, error) {
	var e WorkoutExercise
	var repsMax sql.NullInt64
	var weightKg sql.NullFloat64
	err := s.db.QueryRow(`
		SELECT id, variant_id, exercise_name, target_sets, target_reps_min, target_reps_max, target_weight_kg, order_index
		FROM workout_exercises WHERE id = ?`, id).Scan(
		&e.ID, &e.VariantID, &e.ExerciseName, &e.TargetSets, &e.TargetRepsMin, &repsMax, &weightKg, &e.OrderIndex,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if repsMax.Valid {
		r := int(repsMax.Int64)
		e.TargetRepsMax = &r
	}
	if weightKg.Valid {
		e.TargetWeightKg = &weightKg.Float64
	}
	return &e, nil
}

func (s *Store) UpdateWorkoutExercise(id int64, exerciseName string, targetSets, targetRepsMin int, targetRepsMax *int, targetWeightKg *float64, orderIndex int) error {
	_, err := s.db.Exec(`
		UPDATE workout_exercises 
		SET exercise_name = ?, target_sets = ?, target_reps_min = ?, target_reps_max = ?, target_weight_kg = ?, order_index = ?
		WHERE id = ?`,
		exerciseName, targetSets, targetRepsMin, targetRepsMax, targetWeightKg, orderIndex, id)
	return err
}

func (s *Store) DeleteWorkoutExercise(id int64) error {
	_, err := s.db.Exec("DELETE FROM workout_exercises WHERE id = ?", id)
	return err
}

// GetAllUniqueExercises returns exercises from the exercise library for a user, sorted alphabetically.
// Falls back to deduplicating workout_exercises if the library is empty.
func (s *Store) GetAllUniqueExercises(userID int64) ([]WorkoutExercise, error) {
	// Try exercise library first
	libItems, err := s.ListExerciseLibrary(userID)
	if err != nil {
		return nil, err
	}
	if len(libItems) > 0 {
		var exercises []WorkoutExercise
		for _, item := range libItems {
			e := WorkoutExercise{
				ID:             item.ID,
				ExerciseName:   item.Name,
				TargetSets:     item.DefaultSets,
				TargetRepsMin:  item.DefaultRepsMin,
				TargetRepsMax:  item.DefaultRepsMax,
				TargetWeightKg: item.DefaultWeightKg,
			}
			exercises = append(exercises, e)
		}
		return exercises, nil
	}

	// Fallback: deduplicate from workout_exercises
	query := `
		SELECT we.id, we.variant_id, we.exercise_name, we.target_sets,
			we.target_reps_min, we.target_reps_max, we.target_weight_kg, we.order_index
		FROM workout_exercises we
		JOIN workout_variants wv ON we.variant_id = wv.id
		JOIN workout_groups wg ON wv.group_id = wg.id
		WHERE wg.user_id = ?
			AND we.id IN (
				SELECT MAX(we2.id)
				FROM workout_exercises we2
				JOIN workout_variants wv2 ON we2.variant_id = wv2.id
				JOIN workout_groups wg2 ON wv2.group_id = wg2.id
				WHERE wg2.user_id = ?
				GROUP BY we2.exercise_name
			)
		ORDER BY we.exercise_name ASC`

	rows, err := s.db.Query(query, userID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var exercises []WorkoutExercise
	for rows.Next() {
		var e WorkoutExercise
		var repsMax sql.NullInt64
		var weightKg sql.NullFloat64
		if err := rows.Scan(&e.ID, &e.VariantID, &e.ExerciseName, &e.TargetSets, &e.TargetRepsMin, &repsMax, &weightKg, &e.OrderIndex); err != nil {
			return nil, err
		}
		if repsMax.Valid {
			r := int(repsMax.Int64)
			e.TargetRepsMax = &r
		}
		if weightKg.Valid {
			e.TargetWeightKg = &weightKg.Float64
		}
		exercises = append(exercises, e)
	}
	return exercises, nil
}

// -- Exercise Library Methods --

// ExerciseLibraryItem represents an exercise in the user's exercise library
type ExerciseLibraryItem struct {
	ID              int64     `json:"id"`
	UserID          int64     `json:"user_id"`
	Name            string    `json:"name"`
	DefaultSets     int       `json:"default_sets"`
	DefaultRepsMin  int       `json:"default_reps_min"`
	DefaultRepsMax  *int      `json:"default_reps_max,omitempty"`
	DefaultWeightKg *float64  `json:"default_weight_kg,omitempty"`
	Notes           string    `json:"notes,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

func (s *Store) ListExerciseLibrary(userID int64) ([]ExerciseLibraryItem, error) {
	rows, err := s.db.Query(`
		SELECT id, user_id, name, default_sets, default_reps_min, default_reps_max, default_weight_kg, notes, created_at, updated_at
		FROM exercise_library
		WHERE user_id = ?
		ORDER BY name ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []ExerciseLibraryItem
	for rows.Next() {
		var item ExerciseLibraryItem
		var sets, repsMin sql.NullInt64
		var repsMax sql.NullInt64
		var weightKg sql.NullFloat64
		var notes sql.NullString
		if err := rows.Scan(&item.ID, &item.UserID, &item.Name, &sets, &repsMin, &repsMax, &weightKg, &notes, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		if sets.Valid {
			item.DefaultSets = int(sets.Int64)
		}
		if repsMin.Valid {
			item.DefaultRepsMin = int(repsMin.Int64)
		}
		if repsMax.Valid {
			r := int(repsMax.Int64)
			item.DefaultRepsMax = &r
		}
		if weightKg.Valid {
			item.DefaultWeightKg = &weightKg.Float64
		}
		if notes.Valid {
			item.Notes = notes.String
		}
		items = append(items, item)
	}
	return items, nil
}

func (s *Store) GetExerciseLibraryItem(id int64) (*ExerciseLibraryItem, error) {
	var item ExerciseLibraryItem
	var sets, repsMin sql.NullInt64
	var repsMax sql.NullInt64
	var weightKg sql.NullFloat64
	var notes sql.NullString
	err := s.db.QueryRow(`
		SELECT id, user_id, name, default_sets, default_reps_min, default_reps_max, default_weight_kg, notes, created_at, updated_at
		FROM exercise_library WHERE id = ?`, id).Scan(
		&item.ID, &item.UserID, &item.Name, &sets, &repsMin, &repsMax, &weightKg, &notes, &item.CreatedAt, &item.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if sets.Valid {
		item.DefaultSets = int(sets.Int64)
	}
	if repsMin.Valid {
		item.DefaultRepsMin = int(repsMin.Int64)
	}
	if repsMax.Valid {
		r := int(repsMax.Int64)
		item.DefaultRepsMax = &r
	}
	if weightKg.Valid {
		item.DefaultWeightKg = &weightKg.Float64
	}
	if notes.Valid {
		item.Notes = notes.String
	}
	return &item, nil
}

func (s *Store) CreateExerciseLibraryItem(userID int64, name string, sets, repsMin int, repsMax *int, weightKg *float64, notes string) (*ExerciseLibraryItem, error) {
	res, err := s.db.Exec(`
		INSERT INTO exercise_library (user_id, name, default_sets, default_reps_min, default_reps_max, default_weight_kg, notes)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		userID, name, sets, repsMin, repsMax, weightKg, notes)
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return s.GetExerciseLibraryItem(id)
}

func (s *Store) UpdateExerciseLibraryItem(id int64, name string, sets, repsMin int, repsMax *int, weightKg *float64, notes string) error {
	_, err := s.db.Exec(`
		UPDATE exercise_library
		SET name = ?, default_sets = ?, default_reps_min = ?, default_reps_max = ?, default_weight_kg = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?`,
		name, sets, repsMin, repsMax, weightKg, notes, id)
	return err
}

func (s *Store) DeleteExerciseLibraryItem(id int64) error {
	_, err := s.db.Exec("DELETE FROM exercise_library WHERE id = ?", id)
	return err
}

// -- Rotation State Methods --

func (s *Store) GetRotationState(groupID int64) (*WorkoutRotationState, error) {
	var rs WorkoutRotationState
	var lastSessionDate sql.NullTime
	err := s.db.QueryRow(`
		SELECT group_id, current_variant_id, last_session_date, updated_at 
		FROM workout_rotation_state WHERE group_id = ?`, groupID).Scan(
		&rs.GroupID, &rs.CurrentVariantID, &lastSessionDate, &rs.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if lastSessionDate.Valid {
		rs.LastSessionDate = &lastSessionDate.Time
	}
	return &rs, nil
}

func (s *Store) InitializeRotation(groupID, startingVariantID int64) error {
	_, err := s.db.Exec(`
		INSERT OR REPLACE INTO workout_rotation_state (group_id, current_variant_id, last_session_date, updated_at)
		VALUES (?, ?, NULL, CURRENT_TIMESTAMP)`,
		groupID, startingVariantID)
	return err
}

func (s *Store) AdvanceRotation(groupID int64) error {
	// Get current state
	state, err := s.GetRotationState(groupID)
	if err != nil {
		return err
	}
	if state == nil {
		return fmt.Errorf("no rotation state found for group %d", groupID)
	}

	// Get all variants ordered by rotation_order
	variants, err := s.ListVariantsByGroup(groupID)
	if err != nil {
		return err
	}

	if len(variants) == 0 {
		return fmt.Errorf("no variants found for group %d", groupID)
	}

	// Find current index
	currentIndex := -1
	for i, v := range variants {
		if v.ID == state.CurrentVariantID {
			currentIndex = i
			break
		}
	}

	if currentIndex == -1 {
		// Current variant not found, reset to first
		currentIndex = 0
	}

	// Advance to next (circular)
	nextIndex := (currentIndex + 1) % len(variants)
	nextVariantID := variants[nextIndex].ID

	// Update state
	_, err = s.db.Exec(`
		UPDATE workout_rotation_state 
		SET current_variant_id = ?, last_session_date = DATE('now'), updated_at = CURRENT_TIMESTAMP
		WHERE group_id = ?`,
		nextVariantID, groupID)
	return err
}

// -- Session Methods --

func (s *Store) CreateWorkoutSession(groupID, variantID, userID int64, scheduledDate time.Time, scheduledTime string) (*WorkoutSession, error) {
	res, err := s.db.Exec(`
		INSERT INTO workout_sessions (group_id, variant_id, user_id, scheduled_date, scheduled_time, status)
		VALUES (?, ?, ?, ?, ?, 'pending')`,
		groupID, variantID, userID, scheduledDate, scheduledTime)
	if err != nil {
		return nil, err
	}

	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}

	return s.GetWorkoutSession(id)
}

// CreateAdHocWorkoutSession creates an unscheduled workout session
// Uses -1 as sentinel values for group_id and variant_id
func (s *Store) CreateAdHocWorkoutSession(userID int64, scheduledDate time.Time, scheduledTime string) (*WorkoutSession, error) {
	res, err := s.db.Exec(`
		INSERT INTO workout_sessions (group_id, variant_id, user_id, scheduled_date, scheduled_time, status, started_at)
		VALUES (-1, -1, ?, ?, ?, 'in_progress', CURRENT_TIMESTAMP)`,
		userID, scheduledDate, scheduledTime)
	if err != nil {
		return nil, err
	}

	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}

	return s.GetWorkoutSession(id)
}

// CreatePlannedAdHocSession creates a future ad-hoc workout in 'pending' state.
// Mirrors CreateAdHocWorkoutSession but leaves started_at NULL and status='pending'
// so the scheduler can later notify the user at scheduledDate+scheduledTime.
func (s *Store) CreatePlannedAdHocSession(userID int64, scheduledDate time.Time, scheduledTime string) (*WorkoutSession, error) {
	res, err := s.db.Exec(`
		INSERT INTO workout_sessions (group_id, variant_id, user_id, scheduled_date, scheduled_time, status)
		VALUES (-1, -1, ?, ?, ?, 'pending')`,
		userID, scheduledDate, scheduledTime)
	if err != nil {
		return nil, err
	}

	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}

	return s.GetWorkoutSession(id)
}

// ListNotifiedAdHocSessions returns every ad-hoc session (group_id = -1)
// for the user whose status is 'notified'. The scheduler iterates these to
// run the snooze wake-up, 3h re-notify, and 6h auto-skip handlers without
// being bounded by GetWorkoutHistory's row limit — an active user can easily
// accumulate >50 recent sessions, which would otherwise let an old notified
// ad-hoc fall outside the window and stay stuck in 'notified' forever.
func (s *Store) ListNotifiedAdHocSessions(userID int64) ([]WorkoutSession, error) {
	rows, err := s.db.Query(`
		SELECT id, group_id, variant_id, user_id, scheduled_date, scheduled_time, status, started_at, completed_at, snoozed_until, snooze_count, notification_message_id, notes
		FROM workout_sessions
		WHERE user_id = ?
		  AND group_id = -1
		  AND status = 'notified'
		ORDER BY scheduled_date ASC, scheduled_time ASC`,
		userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sessions []WorkoutSession
	for rows.Next() {
		var ws WorkoutSession
		var startedAt, completedAt, snoozedUntil sql.NullTime
		var notificationMsgID sql.NullInt64
		var notes sql.NullString

		if err := rows.Scan(&ws.ID, &ws.GroupID, &ws.VariantID, &ws.UserID, &ws.ScheduledDate, &ws.ScheduledTime, &ws.Status,
			&startedAt, &completedAt, &snoozedUntil, &ws.SnoozeCount, &notificationMsgID, &notes); err != nil {
			return nil, err
		}

		if startedAt.Valid {
			ws.StartedAt = &startedAt.Time
		}
		if completedAt.Valid {
			ws.CompletedAt = &completedAt.Time
		}
		if snoozedUntil.Valid {
			ws.SnoozedUntil = &snoozedUntil.Time
		}
		if notificationMsgID.Valid {
			msgID := int(notificationMsgID.Int64)
			ws.NotificationMessageID = &msgID
		}
		if notes.Valid {
			ws.Notes = notes.String
		}

		sessions = append(sessions, ws)
	}
	return sessions, nil
}

// ListPendingAdHocSessions returns ad-hoc workout sessions (group_id = -1)
// for the given user that are still 'pending' and whose scheduled date+time
// is at or before `before`. Sessions are ordered by scheduled_date ASC then
// scheduled_time ASC. The scheduler uses this to fire the notification when
// a planned ad-hoc workout becomes due.
//
// scheduled_date is stored by the modernc.org/sqlite driver as an RFC 3339
// string (e.g. "2030-06-01T00:00:00Z"). SQLite's DATE() builtin doesn't
// parse the trailing 'Z', so we use a leading 10-char substring instead —
// the lexicographic order matches calendar order.
func (s *Store) ListPendingAdHocSessions(userID int64, before time.Time) ([]WorkoutSession, error) {
	dateBound := before.Format("2006-01-02")
	timeBound := before.Format("15:04")
	rows, err := s.db.Query(`
		SELECT id, group_id, variant_id, user_id, scheduled_date, scheduled_time, status, started_at, completed_at, snoozed_until, snooze_count, notification_message_id, notes
		FROM workout_sessions
		WHERE user_id = ?
		  AND group_id = -1
		  AND status = 'pending'
		  AND (
		      substr(scheduled_date, 1, 10) < ?
		      OR (substr(scheduled_date, 1, 10) = ? AND scheduled_time <= ?)
		  )
		ORDER BY scheduled_date ASC, scheduled_time ASC`,
		userID, dateBound, dateBound, timeBound)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sessions []WorkoutSession
	for rows.Next() {
		var ws WorkoutSession
		var startedAt, completedAt, snoozedUntil sql.NullTime
		var notificationMsgID sql.NullInt64
		var notes sql.NullString

		if err := rows.Scan(&ws.ID, &ws.GroupID, &ws.VariantID, &ws.UserID, &ws.ScheduledDate, &ws.ScheduledTime, &ws.Status,
			&startedAt, &completedAt, &snoozedUntil, &ws.SnoozeCount, &notificationMsgID, &notes); err != nil {
			return nil, err
		}

		if startedAt.Valid {
			ws.StartedAt = &startedAt.Time
		}
		if completedAt.Valid {
			ws.CompletedAt = &completedAt.Time
		}
		if snoozedUntil.Valid {
			ws.SnoozedUntil = &snoozedUntil.Time
		}
		if notificationMsgID.Valid {
			msgID := int(notificationMsgID.Int64)
			ws.NotificationMessageID = &msgID
		}
		if notes.Valid {
			ws.Notes = notes.String
		}

		sessions = append(sessions, ws)
	}
	return sessions, nil
}

func (s *Store) GetWorkoutSession(id int64) (*WorkoutSession, error) {
	var ws WorkoutSession
	var startedAt, completedAt, snoozedUntil sql.NullTime
	var notificationMsgID sql.NullInt64
	var notes sql.NullString

	err := s.db.QueryRow(`
		SELECT id, group_id, variant_id, user_id, scheduled_date, scheduled_time, status, started_at, completed_at, snoozed_until, snooze_count, notification_message_id, notes
		FROM workout_sessions WHERE id = ?`, id).Scan(
		&ws.ID, &ws.GroupID, &ws.VariantID, &ws.UserID, &ws.ScheduledDate, &ws.ScheduledTime, &ws.Status,
		&startedAt, &completedAt, &snoozedUntil, &ws.SnoozeCount, &notificationMsgID, &notes,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	if startedAt.Valid {
		ws.StartedAt = &startedAt.Time
	}
	if completedAt.Valid {
		ws.CompletedAt = &completedAt.Time
	}
	if snoozedUntil.Valid {
		ws.SnoozedUntil = &snoozedUntil.Time
	}
	if notificationMsgID.Valid {
		msgID := int(notificationMsgID.Int64)
		ws.NotificationMessageID = &msgID
	}
	if notes.Valid {
		ws.Notes = notes.String
	}

	return &ws, nil
}

// IsAdHocSession checks if session is ad-hoc (group_id == -1)
func (s *Store) IsAdHocSession(sessionID int64) (bool, error) {
	var groupID int64
	err := s.db.QueryRow(`SELECT group_id FROM workout_sessions WHERE id = ?`, sessionID).Scan(&groupID)
	if err == sql.ErrNoRows {
		return false, fmt.Errorf("session not found")
	}
	if err != nil {
		return false, err
	}
	return groupID == -1, nil
}

// GetLatestSessionScheduledDate returns the most recent scheduled_date for a
// workout group's sessions, used by the scheduler to enforce a cooldown when
// the user crosses a timezone boundary. Two scheduler ticks running in two
// different user timezones can otherwise build "today" against different
// calendar dates and create two sessions for what the user perceives as one
// workout day. Returns ok=false when the group has no sessions yet.
//
// Scans the aggregate result through a string buffer because SQLite's MAX()
// strips the DATE column's affinity and the driver then refuses to bind the
// resulting TEXT directly into time.Time (same workaround used by
// GetLatestConsumedStepTimePerMed in store.go).
func (s *Store) GetLatestSessionScheduledDate(groupID, userID int64) (time.Time, bool, error) {
	var latestStr sql.NullString
	err := s.db.QueryRow(
		`SELECT MAX(scheduled_date) FROM workout_sessions WHERE group_id = ? AND user_id = ?`,
		groupID, userID,
	).Scan(&latestStr)
	if err != nil {
		return time.Time{}, false, err
	}
	if !latestStr.Valid {
		return time.Time{}, false, nil
	}
	t, err := parseSQLiteDateTime(latestStr.String)
	if err != nil {
		return time.Time{}, false, fmt.Errorf("parse scheduled_date %q: %w", latestStr.String, err)
	}
	return t, true, nil
}

func (s *Store) GetSessionByGroupAndDate(groupID int64, scheduledDate time.Time) (*WorkoutSession, error) {
	var ws WorkoutSession
	var startedAt, completedAt, snoozedUntil sql.NullTime
	var notificationMsgID sql.NullInt64
	var notes sql.NullString

	err := s.db.QueryRow(`
		SELECT id, group_id, variant_id, user_id, scheduled_date, scheduled_time, status, started_at, completed_at, snoozed_until, snooze_count, notification_message_id, notes
		FROM workout_sessions 
		WHERE group_id = ? AND scheduled_date LIKE ?
		LIMIT 1`, groupID, scheduledDate.Format("2006-01-02")+"%").Scan(
		&ws.ID, &ws.GroupID, &ws.VariantID, &ws.UserID, &ws.ScheduledDate, &ws.ScheduledTime, &ws.Status,
		&startedAt, &completedAt, &snoozedUntil, &ws.SnoozeCount, &notificationMsgID, &notes,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	if startedAt.Valid {
		ws.StartedAt = &startedAt.Time
	}
	if completedAt.Valid {
		ws.CompletedAt = &completedAt.Time
	}
	if snoozedUntil.Valid {
		ws.SnoozedUntil = &snoozedUntil.Time
	}
	if notificationMsgID.Valid {
		msgID := int(notificationMsgID.Int64)
		ws.NotificationMessageID = &msgID
	}
	if notes.Valid {
		ws.Notes = notes.String
	}

	return &ws, nil
}

func (s *Store) UpdateSessionStatus(id int64, status string) error {
	_, err := s.db.Exec("UPDATE workout_sessions SET status = ? WHERE id = ?", status, id)
	return err
}

func (s *Store) UpdateWorkoutSessionNotes(id int64, notes string) error {
	_, err := s.db.Exec("UPDATE workout_sessions SET notes = ? WHERE id = ?", notes, id)
	return err
}

func (s *Store) StartSession(id int64) error {
	_, err := s.db.Exec(`
		UPDATE workout_sessions 
		SET status = 'in_progress', started_at = CURRENT_TIMESTAMP 
		WHERE id = ?`, id)
	return err
}

// UpdateSessionVariant updates the variant_id of a session when the rotation has changed
// but the session was already created with an outdated variant.
// Only safe to call on sessions that have not yet started (pending/notified).
func (s *Store) UpdateSessionVariant(id int64, variantID int64) error {
	_, err := s.db.Exec(`
		UPDATE workout_sessions
		SET variant_id = ?
		WHERE id = ? AND status IN ('pending', 'notified')`, variantID, id)
	return err
}

func (s *Store) CompleteSession(id int64) error {
	_, err := s.db.Exec(`
		UPDATE workout_sessions 
		SET status = 'completed', completed_at = CURRENT_TIMESTAMP 
		WHERE id = ?`, id)
	return err
}

func (s *Store) SkipSession(id int64) error {
	_, err := s.db.Exec("UPDATE workout_sessions SET status = 'skipped' WHERE id = ?", id)
	return err
}

func (s *Store) PreSkipSession(id int64) error {
	_, err := s.db.Exec("UPDATE workout_sessions SET status = 'pre_skipped' WHERE id = ?", id)
	return err
}

func (s *Store) CancelPreSkip(id int64) error {
	_, err := s.db.Exec("UPDATE workout_sessions SET status = 'pending' WHERE id = ?", id)
	return err
}

func (s *Store) DeleteSession(id int64) error {
	// PRAGMA foreign_keys is not enabled in this SQLite driver, so the
	// declared ON DELETE CASCADE on workout_exercise_logs is a no-op.
	// Delete child rows explicitly to avoid orphan logs after rollback /
	// session deletion.
	if _, err := s.db.Exec("DELETE FROM workout_exercise_logs WHERE session_id = ?", id); err != nil {
		return err
	}
	_, err := s.db.Exec("DELETE FROM workout_sessions WHERE id = ?", id)
	return err
}

func (s *Store) SnoozeSession(id int64, snoozeDuration time.Duration) error {
	snoozeUntil := time.Now().Add(snoozeDuration)
	_, err := s.db.Exec(`
		UPDATE workout_sessions 
		SET snoozed_until = ?, snooze_count = snooze_count + 1 
		WHERE id = ?`, snoozeUntil, id)
	return err
}

func (s *Store) ClearSnooze(id int64) error {
	_, err := s.db.Exec(`
		UPDATE workout_sessions 
		SET snoozed_until = NULL 
		WHERE id = ?`, id)
	return err
}

func (s *Store) SetSessionNotificationMessageID(id int64, messageID int) error {
	_, err := s.db.Exec("UPDATE workout_sessions SET notification_message_id = ? WHERE id = ?", messageID, id)
	return err
}

// -- Exercise Log Methods --

func (s *Store) LogExercise(sessionID, exerciseID int64, exerciseName string, setsCompleted, repsCompleted *int, weightKg *float64, status, notes string) (int64, error) {
	return s.LogExerciseWithSource(sessionID, exerciseID, exerciseName, setsCompleted, repsCompleted, weightKg, status, notes, "schedule")
}

// LogExerciseWithSource inserts an exercise log with an explicit source value.
// Source should be "schedule" for workout_exercises or "library" for exercise_library.
func (s *Store) LogExerciseWithSource(sessionID, exerciseID int64, exerciseName string, setsCompleted, repsCompleted *int, weightKg *float64, status, notes, source string) (int64, error) {
	res, err := s.db.Exec(`
		INSERT INTO workout_exercise_logs (session_id, exercise_id, exercise_name, sets_completed, reps_completed, weight_kg, status, notes, source)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		sessionID, exerciseID, exerciseName, setsCompleted, repsCompleted, weightKg, status, notes, source)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) GetExerciseLogs(sessionID int64) ([]WorkoutExerciseLog, error) {
	rows, err := s.db.Query(`
		SELECT id, session_id, exercise_id, exercise_name, sets_completed, reps_completed, weight_kg, status, notes, logged_at, source
		FROM workout_exercise_logs
		WHERE session_id = ?
		ORDER BY id ASC`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []WorkoutExerciseLog
	for rows.Next() {
		var log WorkoutExerciseLog
		var setsCompleted, repsCompleted sql.NullInt64
		var weightKg sql.NullFloat64
		var notes sql.NullString

		if err := rows.Scan(&log.ID, &log.SessionID, &log.ExerciseID, &log.ExerciseName, &setsCompleted, &repsCompleted, &weightKg, &log.Status, &notes, &log.LoggedAt, &log.Source); err != nil {
			return nil, err
		}

		if setsCompleted.Valid {
			s := int(setsCompleted.Int64)
			log.SetsCompleted = &s
		}
		if repsCompleted.Valid {
			r := int(repsCompleted.Int64)
			log.RepsCompleted = &r
		}
		if weightKg.Valid {
			log.WeightKg = &weightKg.Float64
		}
		if notes.Valid {
			log.Notes = notes.String
		}

		logs = append(logs, log)
	}
	return logs, nil
}

// UpdateExerciseLog updates a log's sets/reps/weight/notes. When the row is
// still a placeholder (status=”), it also bumps logged_at to the current
// time so a scheduled placeholder finished days later records the completion
// time, not the schedule-creation time. Once status is non-empty, logged_at
// is preserved so subsequent edits don't rewrite the original completion
// timestamp.
func (s *Store) UpdateExerciseLog(id int64, setsCompleted, repsCompleted *int, weightKg *float64, notes string) error {
	_, err := s.db.Exec(`
		UPDATE workout_exercise_logs
		SET sets_completed = ?, reps_completed = ?, weight_kg = ?, notes = ?,
		    logged_at = CASE WHEN status = '' THEN CURRENT_TIMESTAMP ELSE logged_at END
		WHERE id = ?`,
		setsCompleted, repsCompleted, weightKg, notes, id)
	return err
}

// UpdateExerciseLogStatus updates the status of a log. When the row is still
// a placeholder (status=”), it also bumps logged_at to the current time so a
// placeholder promoted to completed/skipped records the actual transition
// time, not the schedule-creation time.
func (s *Store) UpdateExerciseLogStatus(id int64, status string) error {
	_, err := s.db.Exec(`
		UPDATE workout_exercise_logs
		SET status = ?,
		    logged_at = CASE WHEN status = '' THEN CURRENT_TIMESTAMP ELSE logged_at END
		WHERE id = ?`,
		status, id)
	return err
}

// DeleteExerciseLog removes an exercise log entry by its ID
func (s *Store) DeleteExerciseLog(id int64) error {
	_, err := s.db.Exec("DELETE FROM workout_exercise_logs WHERE id = ?", id)
	return err
}

// UpsertExerciseLogByName idempotently writes an exercise log keyed by
// (session_id, exercise_name) (case-insensitive). If a row with that name
// already exists for the session it is updated in place; otherwise a new
// row is inserted with the supplied exerciseID (use 0 for ad-hoc). The
// pair (id, isNew) lets callers distinguish the two paths. Used by the
// MCP workout_log endpoint where the agent re-sending the same exercise
// must not create duplicates.
//
// loggedAt sets the row's logged_at column (the agent's "occurred_at"). A
// zero value falls back to CURRENT_TIMESTAMP on insert and leaves the
// existing column untouched on update.
//
// On the update path the existing row's `source` and `exercise_id` are
// preserved when they already point to a scheduled/library exercise — the
// agent may enrich a planned row, but it must not relabel it as "agent"
// or zero out the planned ID (CheckCompletion only counts schedule-sourced
// logs with non-zero exercise_id). When the existing row is itself ad-hoc
// (exercise_id=0) and the new call carries a planned exercise_id (>0), we
// promote both fields so a re-send after the session was attached to a
// schedule still satisfies CheckCompletion.
func (s *Store) UpsertExerciseLogByName(ctx context.Context, sessionID, exerciseID int64, exerciseName string, setsCompleted, repsCompleted *int, weightKg *float64, status, notes, source string, loggedAt time.Time) (int64, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = tx.Rollback() }()

	var existingID, existingExerciseID int64
	var existingSource sql.NullString
	err = tx.QueryRowContext(ctx, `
		SELECT id, exercise_id, source FROM workout_exercise_logs
		WHERE session_id = ? AND LOWER(exercise_name) = LOWER(?)
		LIMIT 1`, sessionID, exerciseName).Scan(&existingID, &existingExerciseID, &existingSource)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, false, err
	}

	if errors.Is(err, sql.ErrNoRows) {
		var res sql.Result
		var execErr error
		if loggedAt.IsZero() {
			res, execErr = tx.ExecContext(ctx, `
				INSERT INTO workout_exercise_logs (session_id, exercise_id, exercise_name, sets_completed, reps_completed, weight_kg, status, notes, source)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				sessionID, exerciseID, exerciseName, setsCompleted, repsCompleted, weightKg, status, notes, source)
		} else {
			res, execErr = tx.ExecContext(ctx, `
				INSERT INTO workout_exercise_logs (session_id, exercise_id, exercise_name, sets_completed, reps_completed, weight_kg, status, notes, source, logged_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				sessionID, exerciseID, exerciseName, setsCompleted, repsCompleted, weightKg, status, notes, source, loggedAt.UTC())
		}
		if execErr != nil {
			return 0, false, execErr
		}
		newID, err := res.LastInsertId()
		if err != nil {
			return 0, false, err
		}
		if err := tx.Commit(); err != nil {
			return 0, false, err
		}
		return newID, true, nil
	}

	// Promote ad-hoc rows to scheduled when the new call carries a planned
	// exercise_id; otherwise preserve the existing identity (see func doc).
	updateExerciseID := existingExerciseID
	updateSource := existingSource.String
	if existingExerciseID == 0 && exerciseID > 0 {
		updateExerciseID = exerciseID
		updateSource = source
	}

	if loggedAt.IsZero() {
		if _, err := tx.ExecContext(ctx, `
			UPDATE workout_exercise_logs
			SET sets_completed = ?, reps_completed = ?, weight_kg = ?, status = ?, notes = ?, exercise_id = ?, source = ?
			WHERE id = ?`,
			setsCompleted, repsCompleted, weightKg, status, notes, updateExerciseID, updateSource, existingID); err != nil {
			return 0, false, err
		}
	} else {
		if _, err := tx.ExecContext(ctx, `
			UPDATE workout_exercise_logs
			SET sets_completed = ?, reps_completed = ?, weight_kg = ?, status = ?, notes = ?, exercise_id = ?, source = ?, logged_at = ?
			WHERE id = ?`,
			setsCompleted, repsCompleted, weightKg, status, notes, updateExerciseID, updateSource, loggedAt.UTC(), existingID); err != nil {
			return 0, false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, false, err
	}
	return existingID, false, nil
}

// SetExerciseLogSource updates the source field of an exercise log entry.
// Valid values: "schedule" (from workout_exercises) or "library" (from exercise_library).
func (s *Store) SetExerciseLogSource(id int64, source string) error {
	_, err := s.db.Exec("UPDATE workout_exercise_logs SET source = ? WHERE id = ?", source, id)
	return err
}

// GetExerciseLogByID fetches a single exercise log by its primary key.
func (s *Store) GetExerciseLogByID(id int64) (*WorkoutExerciseLog, error) {
	var log WorkoutExerciseLog
	var setsCompleted, repsCompleted sql.NullInt64
	var weightKg sql.NullFloat64
	var notes sql.NullString

	err := s.db.QueryRow(`
		SELECT id, session_id, exercise_id, exercise_name, sets_completed, reps_completed, weight_kg, status, notes, logged_at, source
		FROM workout_exercise_logs
		WHERE id = ?`, id).Scan(
		&log.ID, &log.SessionID, &log.ExerciseID, &log.ExerciseName,
		&setsCompleted, &repsCompleted, &weightKg, &log.Status, &notes, &log.LoggedAt, &log.Source,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	if setsCompleted.Valid {
		s := int(setsCompleted.Int64)
		log.SetsCompleted = &s
	}
	if repsCompleted.Valid {
		r := int(repsCompleted.Int64)
		log.RepsCompleted = &r
	}
	if weightKg.Valid {
		log.WeightKg = &weightKg.Float64
	}
	if notes.Valid {
		log.Notes = notes.String
	}

	return &log, nil
}

// GetExerciseLogBySessionExerciseSource returns an existing log for a given
// session+exercise+source triple. This is needed when the unique index includes
// source (schedule vs library) to avoid matching the wrong table's log entry.
func (s *Store) GetExerciseLogBySessionExerciseSource(sessionID, exerciseID int64, source string) (*WorkoutExerciseLog, error) {
	var log WorkoutExerciseLog
	var setsCompleted, repsCompleted sql.NullInt64
	var weightKg sql.NullFloat64
	var notes sql.NullString

	err := s.db.QueryRow(`
		SELECT id, session_id, exercise_id, exercise_name, sets_completed, reps_completed, weight_kg, status, notes, logged_at, source
		FROM workout_exercise_logs
		WHERE session_id = ? AND exercise_id = ? AND source = ?
		LIMIT 1`, sessionID, exerciseID, source).Scan(
		&log.ID, &log.SessionID, &log.ExerciseID, &log.ExerciseName,
		&setsCompleted, &repsCompleted, &weightKg, &log.Status, &notes, &log.LoggedAt, &log.Source,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	if setsCompleted.Valid {
		s := int(setsCompleted.Int64)
		log.SetsCompleted = &s
	}
	if repsCompleted.Valid {
		r := int(repsCompleted.Int64)
		log.RepsCompleted = &r
	}
	if weightKg.Valid {
		log.WeightKg = &weightKg.Float64
	}
	if notes.Valid {
		log.Notes = notes.String
	}

	return &log, nil
}

// PropagateExerciseToSchedule updates the workout_exercises schedule definition
// with values from a session's exercise log, but only if the session is still
// pending/notified/in_progress and the exercise belongs to the session's variant.
// Uses exerciseID (workout_exercises.id) as the identity key. The exerciseName
// check prevents cross-table ID collisions between exercise_library and
// workout_exercises from corrupting the wrong scheduled exercise.
func (s *Store) PropagateExerciseToSchedule(sessionID int64, exerciseID int64, exerciseName string, sets *int, reps *int, weight *float64) error {
	_, err := s.db.Exec(`
		UPDATE workout_exercises
		SET target_sets = COALESCE(?, target_sets),
		    target_reps_min = COALESCE(?, target_reps_min),
		    target_reps_max = CASE
		        WHEN ? IS NOT NULL AND target_reps_max IS NOT NULL AND ? > target_reps_max THEN NULL
		        ELSE target_reps_max
		    END,
		    target_weight_kg = COALESCE(?, target_weight_kg)
		WHERE id = ?
		AND exercise_name = ?
		AND variant_id = (
		    SELECT variant_id FROM workout_sessions
		    WHERE id = ? AND status IN ('pending', 'notified', 'in_progress')
		)`, sets, reps, reps, reps, weight, exerciseID, exerciseName, sessionID)
	return err
}

// GetExerciseLogBySessionAndExercise returns an existing log for a given session+exercise pair, if any
func (s *Store) GetExerciseLogBySessionAndExercise(sessionID, exerciseID int64) (*WorkoutExerciseLog, error) {
	var log WorkoutExerciseLog
	var setsCompleted, repsCompleted sql.NullInt64
	var weightKg sql.NullFloat64
	var notes sql.NullString

	err := s.db.QueryRow(`
		SELECT id, session_id, exercise_id, exercise_name, sets_completed, reps_completed, weight_kg, status, notes, logged_at, source
		FROM workout_exercise_logs
		WHERE session_id = ? AND exercise_id = ?
		LIMIT 1`, sessionID, exerciseID).Scan(
		&log.ID, &log.SessionID, &log.ExerciseID, &log.ExerciseName,
		&setsCompleted, &repsCompleted, &weightKg, &log.Status, &notes, &log.LoggedAt, &log.Source,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	if setsCompleted.Valid {
		s := int(setsCompleted.Int64)
		log.SetsCompleted = &s
	}
	if repsCompleted.Valid {
		r := int(repsCompleted.Int64)
		log.RepsCompleted = &r
	}
	if weightKg.Valid {
		log.WeightKg = &weightKg.Float64
	}
	if notes.Valid {
		log.Notes = notes.String
	}

	return &log, nil
}

// -- Schedule Snapshot Methods --

func (s *Store) CreateGroupSnapshot(groupID int64, snapshotData, changeReason string) error {
	_, err := s.db.Exec(`
		INSERT INTO workout_schedule_snapshots (group_id, snapshot_data, change_reason)
		VALUES (?, ?, ?)`,
		groupID, snapshotData, changeReason)
	return err
}

func (s *Store) GetGroupSnapshots(groupID int64) ([]WorkoutScheduleSnapshot, error) {
	rows, err := s.db.Query(`
		SELECT id, group_id, snapshot_data, change_reason, created_at
		FROM workout_schedule_snapshots 
		WHERE group_id = ? 
		ORDER BY created_at DESC`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var snapshots []WorkoutScheduleSnapshot
	for rows.Next() {
		var snap WorkoutScheduleSnapshot
		var changeReason sql.NullString
		if err := rows.Scan(&snap.ID, &snap.GroupID, &snap.SnapshotData, &changeReason, &snap.CreatedAt); err != nil {
			return nil, err
		}
		if changeReason.Valid {
			snap.ChangeReason = changeReason.String
		}
		snapshots = append(snapshots, snap)
	}
	return snapshots, nil
}

// -- History & Stats Methods --

func (s *Store) GetWorkoutHistory(userID int64, limit int) ([]WorkoutSession, error) {
	query := `
		SELECT id, group_id, variant_id, user_id, scheduled_date, scheduled_time, status, started_at, completed_at, snoozed_until, snooze_count, notification_message_id, notes
		FROM workout_sessions 
		WHERE user_id = ? 
		ORDER BY scheduled_date DESC, scheduled_time DESC
		LIMIT ?`

	rows, err := s.db.Query(query, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sessions []WorkoutSession
	for rows.Next() {
		var ws WorkoutSession
		var startedAt, completedAt, snoozedUntil sql.NullTime
		var notificationMsgID sql.NullInt64
		var notes sql.NullString

		if err := rows.Scan(&ws.ID, &ws.GroupID, &ws.VariantID, &ws.UserID, &ws.ScheduledDate, &ws.ScheduledTime, &ws.Status,
			&startedAt, &completedAt, &snoozedUntil, &ws.SnoozeCount, &notificationMsgID, &notes); err != nil {
			return nil, err
		}

		if startedAt.Valid {
			ws.StartedAt = &startedAt.Time
		}
		if completedAt.Valid {
			ws.CompletedAt = &completedAt.Time
		}
		if snoozedUntil.Valid {
			ws.SnoozedUntil = &snoozedUntil.Time
		}
		if notificationMsgID.Valid {
			msgID := int(notificationMsgID.Int64)
			ws.NotificationMessageID = &msgID
		}
		if notes.Valid {
			ws.Notes = notes.String
		}

		sessions = append(sessions, ws)
	}
	return sessions, nil
}

func (s *Store) GetSnoozedSessions(userID int64) ([]WorkoutSession, error) {
	query := `
		SELECT id, group_id, variant_id, user_id, scheduled_date, scheduled_time, status, started_at, completed_at, snoozed_until, snooze_count, notification_message_id, notes
		FROM workout_sessions 
		WHERE user_id = ? AND snoozed_until IS NOT NULL AND snoozed_until <= CURRENT_TIMESTAMP
        AND status NOT IN ('completed', 'skipped')
		ORDER BY snoozed_until ASC`

	rows, err := s.db.Query(query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sessions []WorkoutSession
	for rows.Next() {
		var ws WorkoutSession
		var startedAt, completedAt, snoozedUntil sql.NullTime
		var notificationMsgID sql.NullInt64
		var notes sql.NullString

		if err := rows.Scan(&ws.ID, &ws.GroupID, &ws.VariantID, &ws.UserID, &ws.ScheduledDate, &ws.ScheduledTime, &ws.Status,
			&startedAt, &completedAt, &snoozedUntil, &ws.SnoozeCount, &notificationMsgID, &notes); err != nil {
			return nil, err
		}

		if startedAt.Valid {
			ws.StartedAt = &startedAt.Time
		}
		if completedAt.Valid {
			ws.CompletedAt = &completedAt.Time
		}
		if snoozedUntil.Valid {
			ws.SnoozedUntil = &snoozedUntil.Time
		}
		if notificationMsgID.Valid {
			msgID := int(notificationMsgID.Int64)
			ws.NotificationMessageID = &msgID
		}
		if notes.Valid {
			ws.Notes = notes.String
		}

		sessions = append(sessions, ws)
	}
	return sessions, nil
}

// GetActiveSessions returns all sessions for a given date that are in 'notified' or 'in_progress' status
// This is used to display workouts that have been notified but not yet started/completed, even if their scheduled time has passed
// GetExerciseStats returns aggregated volume and max weight per exercise for a user.
// Only considers completed exercise logs that have weight data.
func (s *Store) GetExerciseStats(userID int64) ([]ExerciseStat, error) {
	rows, err := s.db.Query(`
		SELECT
			wel.exercise_name,
			COUNT(DISTINCT ws.id) as session_count,
			COALESCE(SUM(
				CASE WHEN wel.sets_completed IS NOT NULL
				          AND wel.reps_completed IS NOT NULL
				          AND wel.weight_kg IS NOT NULL
				     THEN wel.sets_completed * wel.reps_completed * wel.weight_kg
				     ELSE 0 END
			), 0) as total_volume,
			COALESCE(MAX(wel.weight_kg), 0) as max_weight
		FROM workout_exercise_logs wel
		JOIN workout_sessions ws ON ws.id = wel.session_id
		WHERE ws.user_id = ? AND wel.status = 'completed'
		GROUP BY wel.exercise_name
		ORDER BY total_volume DESC
		LIMIT 8`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var stats []ExerciseStat
	for rows.Next() {
		var es ExerciseStat
		if err := rows.Scan(&es.ExerciseName, &es.SessionCount, &es.TotalVolumeKg, &es.MaxWeightKg); err != nil {
			return nil, err
		}
		stats = append(stats, es)
	}
	return stats, nil
}

func (s *Store) GetActiveSessions(userID int64, date time.Time) ([]WorkoutSession, error) {
	// Format date as YYYY-MM-DD for comparison
	dateStr := date.Format("2006-01-02")

	query := `
		SELECT id, group_id, variant_id, user_id, scheduled_date, scheduled_time, status, started_at, completed_at, snoozed_until, snooze_count, notification_message_id, notes
		FROM workout_sessions
		WHERE user_id = ?
		  AND scheduled_date LIKE ?
		  AND status IN ('notified', 'in_progress', 'pre_skipped')
		ORDER BY scheduled_time ASC`

	rows, err := s.db.Query(query, userID, dateStr+"%")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sessions []WorkoutSession
	for rows.Next() {
		var ws WorkoutSession
		var startedAt, completedAt, snoozedUntil sql.NullTime
		var notificationMsgID sql.NullInt64
		var notes sql.NullString

		if err := rows.Scan(&ws.ID, &ws.GroupID, &ws.VariantID, &ws.UserID, &ws.ScheduledDate, &ws.ScheduledTime, &ws.Status,
			&startedAt, &completedAt, &snoozedUntil, &ws.SnoozeCount, &notificationMsgID, &notes); err != nil {
			return nil, err
		}

		if startedAt.Valid {
			ws.StartedAt = &startedAt.Time
		}
		if completedAt.Valid {
			ws.CompletedAt = &completedAt.Time
		}
		if snoozedUntil.Valid {
			ws.SnoozedUntil = &snoozedUntil.Time
		}
		if notificationMsgID.Valid {
			msgID := int(notificationMsgID.Int64)
			ws.NotificationMessageID = &msgID
		}
		if notes.Valid {
			ws.Notes = notes.String
		}

		sessions = append(sessions, ws)
	}
	return sessions, nil
}

// ListRecentExerciseLogsByName returns up to `limit` recent exercise logs for the
// given user that match `exerciseName` (case-insensitive). Only `completed`
// logs are returned — skipped/missed rows aren't useful as inference sources
// and would mask older completed history at limit=1. The user is matched
// via the joined workout_sessions row. Logs are returned newest-first.
// Used by the workout resolver to infer defaults for omitted sets/reps/weight.
func (s *Store) ListRecentExerciseLogsByName(ctx context.Context, userID int64, exerciseName string, limit int) ([]WorkoutExerciseLog, error) {
	if limit <= 0 {
		limit = 1
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT wel.id, wel.session_id, wel.exercise_id, wel.exercise_name,
		       wel.sets_completed, wel.reps_completed, wel.weight_kg,
		       wel.status, wel.notes, wel.logged_at, wel.source
		FROM workout_exercise_logs wel
		JOIN workout_sessions ws ON ws.id = wel.session_id
		WHERE ws.user_id = ? AND LOWER(wel.exercise_name) = LOWER(?)
		  AND wel.status = 'completed'
		ORDER BY wel.logged_at DESC, wel.id DESC
		LIMIT ?`, userID, exerciseName, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []WorkoutExerciseLog
	for rows.Next() {
		var log WorkoutExerciseLog
		var setsCompleted, repsCompleted sql.NullInt64
		var weightKg sql.NullFloat64
		var notes sql.NullString
		if err := rows.Scan(&log.ID, &log.SessionID, &log.ExerciseID, &log.ExerciseName,
			&setsCompleted, &repsCompleted, &weightKg, &log.Status, &notes, &log.LoggedAt, &log.Source); err != nil {
			return nil, err
		}
		if setsCompleted.Valid {
			s := int(setsCompleted.Int64)
			log.SetsCompleted = &s
		}
		if repsCompleted.Valid {
			r := int(repsCompleted.Int64)
			log.RepsCompleted = &r
		}
		if weightKg.Valid {
			log.WeightKg = &weightKg.Float64
		}
		if notes.Valid {
			log.Notes = notes.String
		}
		logs = append(logs, log)
	}
	return logs, nil
}

// GetDistinctExerciseNamesForUser returns the union of distinct exercise names
// the user has access to: their exercise_library entries, names from their
// workout_exercise_logs history, and names from currently-scheduled
// workout_exercises (so a freshly-planned exercise with no log yet is still
// in the resolver catalog). Names are deduplicated case-insensitively and
// returned in alphabetical order.
func (s *Store) GetDistinctExerciseNamesForUser(ctx context.Context, userID int64) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT name FROM exercise_library WHERE user_id = ?
		UNION
		SELECT wel.exercise_name FROM workout_exercise_logs wel
		JOIN workout_sessions ws ON ws.id = wel.session_id
		WHERE ws.user_id = ?
		UNION
		SELECT we.exercise_name FROM workout_exercises we
		JOIN workout_variants wv ON wv.id = we.variant_id
		JOIN workout_groups wg ON wg.id = wv.group_id
		WHERE wg.user_id = ?
		ORDER BY 1 COLLATE NOCASE ASC`, userID, userID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	seen := make(map[string]bool)
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		key := strings.ToLower(n)
		if seen[key] {
			continue
		}
		seen[key] = true
		names = append(names, n)
	}
	return names, nil
}
