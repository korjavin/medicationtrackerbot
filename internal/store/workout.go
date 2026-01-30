package store

import (
	"database/sql"
	"fmt"
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
	GroupID               int64      `json:"group_id"`
	VariantID             int64      `json:"variant_id"`
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
}

// WorkoutRotationState tracks the current rotation position
type WorkoutRotationState struct {
	GroupID          int64      `json:"group_id"`
	CurrentVariantID int64      `json:"current_variant_id"`
	LastSessionDate  *time.Time `json:"last_session_date,omitempty"`
	UpdatedAt        time.Time  `json:"updated_at"`
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

func (s *Store) UpdateWorkoutExercise(id int64, exerciseName string, targetSets, targetRepsMin int, targetRepsMax *int, targetWeightKg *float64) error {
	_, err := s.db.Exec(`
		UPDATE workout_exercises 
		SET exercise_name = ?, target_sets = ?, target_reps_min = ?, target_reps_max = ?, target_weight_kg = ?
		WHERE id = ?`,
		exerciseName, targetSets, targetRepsMin, targetRepsMax, targetWeightKg, id)
	return err
}

func (s *Store) DeleteWorkoutExercise(id int64) error {
	_, err := s.db.Exec("DELETE FROM workout_exercises WHERE id = ?", id)
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

func (s *Store) SnoozeSession(id int64, snoozeDuration time.Duration) error {
	snoozeUntil := time.Now().Add(snoozeDuration)
	_, err := s.db.Exec(`
		UPDATE workout_sessions 
		SET snoozed_until = ?, snooze_count = snooze_count + 1 
		WHERE id = ?`, snoozeUntil, id)
	return err
}

func (s *Store) SetSessionNotificationMessageID(id int64, messageID int) error {
	_, err := s.db.Exec("UPDATE workout_sessions SET notification_message_id = ? WHERE id = ?", messageID, id)
	return err
}

// -- Exercise Log Methods --

func (s *Store) LogExercise(sessionID, exerciseID int64, exerciseName string, setsCompleted, repsCompleted *int, weightKg *float64, status, notes string) (int64, error) {
	res, err := s.db.Exec(`
		INSERT INTO workout_exercise_logs (session_id, exercise_id, exercise_name, sets_completed, reps_completed, weight_kg, status, notes)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		sessionID, exerciseID, exerciseName, setsCompleted, repsCompleted, weightKg, status, notes)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) GetExerciseLogs(sessionID int64) ([]WorkoutExerciseLog, error) {
	rows, err := s.db.Query(`
		SELECT id, session_id, exercise_id, exercise_name, sets_completed, reps_completed, weight_kg, status, notes, logged_at
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

		if err := rows.Scan(&log.ID, &log.SessionID, &log.ExerciseID, &log.ExerciseName, &setsCompleted, &repsCompleted, &weightKg, &log.Status, &notes, &log.LoggedAt); err != nil {
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

func (s *Store) UpdateExerciseLog(id int64, setsCompleted, repsCompleted *int, weightKg *float64, notes string) error {
	_, err := s.db.Exec(`
		UPDATE workout_exercise_logs 
		SET sets_completed = ?, reps_completed = ?, weight_kg = ?, notes = ?
		WHERE id = ?`,
		setsCompleted, repsCompleted, weightKg, notes, id)
	return err
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
