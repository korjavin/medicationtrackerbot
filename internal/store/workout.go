package store

import (
	"context"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store/workout"
)

// This file is now a thin forwarder layer over internal/store/workout.
// All implementations live in internal/store/workout/repo.go; this layer
// preserves the legacy *Store surface so consumers compile unchanged until
// Task 13 removes forwarders. See docs/plans/2026-05-13-split-store-package.md.

// -- Type aliases so existing store.XYZ references compile unchanged --

type WorkoutGroup = workout.WorkoutGroup
type WorkoutVariant = workout.WorkoutVariant
type WorkoutExercise = workout.WorkoutExercise
type WorkoutSession = workout.WorkoutSession
type WorkoutExerciseLog = workout.WorkoutExerciseLog
type WorkoutRotationState = workout.WorkoutRotationState
type ExerciseStat = workout.ExerciseStat
type WorkoutScheduleSnapshot = workout.WorkoutScheduleSnapshot
type ExerciseLibraryItem = workout.ExerciseLibraryItem

// -- Workout Group Methods --

func (s *Store) CreateWorkoutGroup(name, description string, isRotating bool, userID int64, daysOfWeek string, scheduledTime string, notificationAdvance int) (*WorkoutGroup, error) {
	return s.workout.CreateWorkoutGroup(name, description, isRotating, userID, daysOfWeek, scheduledTime, notificationAdvance)
}

func (s *Store) ListWorkoutGroups(userID int64, activeOnly bool) ([]WorkoutGroup, error) {
	return s.workout.ListWorkoutGroups(userID, activeOnly)
}

func (s *Store) GetWorkoutGroup(id int64) (*WorkoutGroup, error) {
	return s.workout.GetWorkoutGroup(id)
}

func (s *Store) UpdateWorkoutGroup(id int64, name, description string, isRotating bool, daysOfWeek string, scheduledTime string, notificationAdvance int, active bool) error {
	return s.workout.UpdateWorkoutGroup(id, name, description, isRotating, daysOfWeek, scheduledTime, notificationAdvance, active)
}

func (s *Store) DeleteWorkoutGroup(id int64) error {
	return s.workout.DeleteWorkoutGroup(id)
}

// -- Workout Variant Methods --

func (s *Store) CreateWorkoutVariant(groupID int64, name string, rotationOrder *int, description string) (*WorkoutVariant, error) {
	return s.workout.CreateWorkoutVariant(groupID, name, rotationOrder, description)
}

func (s *Store) ListVariantsByGroup(groupID int64) ([]WorkoutVariant, error) {
	return s.workout.ListVariantsByGroup(groupID)
}

func (s *Store) GetWorkoutVariant(id int64) (*WorkoutVariant, error) {
	return s.workout.GetWorkoutVariant(id)
}

func (s *Store) UpdateWorkoutVariant(id int64, name string, rotationOrder *int, description string) error {
	return s.workout.UpdateWorkoutVariant(id, name, rotationOrder, description)
}

func (s *Store) DeleteWorkoutVariant(id int64) error {
	return s.workout.DeleteWorkoutVariant(id)
}

// -- Exercise Methods --

func (s *Store) AddExerciseToVariant(variantID int64, exerciseName string, targetSets, targetRepsMin int, targetRepsMax *int, targetWeightKg *float64, orderIndex int) (*WorkoutExercise, error) {
	return s.workout.AddExerciseToVariant(variantID, exerciseName, targetSets, targetRepsMin, targetRepsMax, targetWeightKg, orderIndex)
}

func (s *Store) ListExercisesByVariant(variantID int64) ([]WorkoutExercise, error) {
	return s.workout.ListExercisesByVariant(variantID)
}

func (s *Store) GetWorkoutExercise(id int64) (*WorkoutExercise, error) {
	return s.workout.GetWorkoutExercise(id)
}

func (s *Store) UpdateWorkoutExercise(id int64, exerciseName string, targetSets, targetRepsMin int, targetRepsMax *int, targetWeightKg *float64, orderIndex int) error {
	return s.workout.UpdateWorkoutExercise(id, exerciseName, targetSets, targetRepsMin, targetRepsMax, targetWeightKg, orderIndex)
}

func (s *Store) DeleteWorkoutExercise(id int64) error {
	return s.workout.DeleteWorkoutExercise(id)
}

func (s *Store) GetAllUniqueExercises(userID int64) ([]WorkoutExercise, error) {
	return s.workout.GetAllUniqueExercises(userID)
}

// -- Exercise Library Methods --

func (s *Store) ListExerciseLibrary(userID int64) ([]ExerciseLibraryItem, error) {
	return s.workout.ListExerciseLibrary(userID)
}

func (s *Store) GetExerciseLibraryItem(id int64) (*ExerciseLibraryItem, error) {
	return s.workout.GetExerciseLibraryItem(id)
}

func (s *Store) CreateExerciseLibraryItem(userID int64, name string, sets, repsMin int, repsMax *int, weightKg *float64, notes string) (*ExerciseLibraryItem, error) {
	return s.workout.CreateExerciseLibraryItem(userID, name, sets, repsMin, repsMax, weightKg, notes)
}

func (s *Store) UpdateExerciseLibraryItem(id int64, name string, sets, repsMin int, repsMax *int, weightKg *float64, notes string) error {
	return s.workout.UpdateExerciseLibraryItem(id, name, sets, repsMin, repsMax, weightKg, notes)
}

func (s *Store) DeleteExerciseLibraryItem(id int64) error {
	return s.workout.DeleteExerciseLibraryItem(id)
}

// -- Rotation State Methods --

func (s *Store) GetRotationState(groupID int64) (*WorkoutRotationState, error) {
	return s.workout.GetRotationState(groupID)
}

func (s *Store) InitializeRotation(groupID, startingVariantID int64) error {
	return s.workout.InitializeRotation(groupID, startingVariantID)
}

func (s *Store) AdvanceRotation(groupID int64) error {
	return s.workout.AdvanceRotation(groupID)
}

// -- Session Methods --

func (s *Store) CreateWorkoutSession(groupID, variantID, userID int64, scheduledDate time.Time, scheduledTime string) (*WorkoutSession, error) {
	return s.workout.CreateWorkoutSession(groupID, variantID, userID, scheduledDate, scheduledTime)
}

func (s *Store) CreateAdHocWorkoutSession(userID int64, scheduledDate time.Time, scheduledTime string) (*WorkoutSession, error) {
	return s.workout.CreateAdHocWorkoutSession(userID, scheduledDate, scheduledTime)
}

func (s *Store) CreatePlannedAdHocSession(userID int64, scheduledDate time.Time, scheduledTime string) (*WorkoutSession, error) {
	return s.workout.CreatePlannedAdHocSession(userID, scheduledDate, scheduledTime)
}

func (s *Store) ListNotifiedAdHocSessions(userID int64) ([]WorkoutSession, error) {
	return s.workout.ListNotifiedAdHocSessions(userID)
}

func (s *Store) ListPendingAdHocSessions(userID int64, before time.Time) ([]WorkoutSession, error) {
	return s.workout.ListPendingAdHocSessions(userID, before)
}

func (s *Store) GetWorkoutSession(id int64) (*WorkoutSession, error) {
	return s.workout.GetWorkoutSession(id)
}

func (s *Store) IsAdHocSession(sessionID int64) (bool, error) {
	return s.workout.IsAdHocSession(sessionID)
}

func (s *Store) GetLatestSessionScheduledDate(groupID, userID int64) (time.Time, bool, error) {
	return s.workout.GetLatestSessionScheduledDate(groupID, userID)
}

func (s *Store) GetSessionByGroupAndDate(groupID int64, scheduledDate time.Time) (*WorkoutSession, error) {
	return s.workout.GetSessionByGroupAndDate(groupID, scheduledDate)
}

func (s *Store) UpdateSessionStatus(id int64, status string) error {
	return s.workout.UpdateSessionStatus(id, status)
}

func (s *Store) UpdateWorkoutSessionNotes(id int64, notes string) error {
	return s.workout.UpdateWorkoutSessionNotes(id, notes)
}

func (s *Store) StartSession(id int64) error {
	return s.workout.StartSession(id)
}

func (s *Store) UpdateSessionVariant(id int64, variantID int64) error {
	return s.workout.UpdateSessionVariant(id, variantID)
}

func (s *Store) CompleteSession(id int64) error {
	return s.workout.CompleteSession(id)
}

func (s *Store) SkipSession(id int64) error {
	return s.workout.SkipSession(id)
}

func (s *Store) PreSkipSession(id int64) error {
	return s.workout.PreSkipSession(id)
}

func (s *Store) CancelPreSkip(id int64) error {
	return s.workout.CancelPreSkip(id)
}

func (s *Store) DeleteSession(id int64) error {
	return s.workout.DeleteSession(id)
}

func (s *Store) SnoozeSession(id int64, snoozeDuration time.Duration) error {
	return s.workout.SnoozeSession(id, snoozeDuration)
}

func (s *Store) ClearSnooze(id int64) error {
	return s.workout.ClearSnooze(id)
}

func (s *Store) SetSessionNotificationMessageID(id int64, messageID int) error {
	return s.workout.SetSessionNotificationMessageID(id, messageID)
}

// -- Exercise Log Methods --

func (s *Store) LogExercise(sessionID, exerciseID int64, exerciseName string, setsCompleted, repsCompleted *int, weightKg *float64, status, notes string) (int64, error) {
	return s.workout.LogExercise(sessionID, exerciseID, exerciseName, setsCompleted, repsCompleted, weightKg, status, notes)
}

func (s *Store) LogExerciseWithSource(sessionID, exerciseID int64, exerciseName string, setsCompleted, repsCompleted *int, weightKg *float64, status, notes, source string) (int64, error) {
	return s.workout.LogExerciseWithSource(sessionID, exerciseID, exerciseName, setsCompleted, repsCompleted, weightKg, status, notes, source)
}

func (s *Store) GetExerciseLogs(sessionID int64) ([]WorkoutExerciseLog, error) {
	return s.workout.GetExerciseLogs(sessionID)
}

func (s *Store) UpdateExerciseLog(id int64, setsCompleted, repsCompleted *int, weightKg *float64, notes string) error {
	return s.workout.UpdateExerciseLog(id, setsCompleted, repsCompleted, weightKg, notes)
}

func (s *Store) UpdateExerciseLogStatus(id int64, status string) error {
	return s.workout.UpdateExerciseLogStatus(id, status)
}

func (s *Store) DeleteExerciseLog(id int64) error {
	return s.workout.DeleteExerciseLog(id)
}

func (s *Store) UpsertExerciseLogByName(ctx context.Context, sessionID, exerciseID int64, exerciseName string, setsCompleted, repsCompleted *int, weightKg *float64, status, notes, source string, loggedAt time.Time) (int64, bool, error) {
	return s.workout.UpsertExerciseLogByName(ctx, sessionID, exerciseID, exerciseName, setsCompleted, repsCompleted, weightKg, status, notes, source, loggedAt)
}

func (s *Store) SetExerciseLogSource(id int64, source string) error {
	return s.workout.SetExerciseLogSource(id, source)
}

func (s *Store) GetExerciseLogByID(id int64) (*WorkoutExerciseLog, error) {
	return s.workout.GetExerciseLogByID(id)
}

func (s *Store) GetExerciseLogBySessionExerciseSource(sessionID, exerciseID int64, source string) (*WorkoutExerciseLog, error) {
	return s.workout.GetExerciseLogBySessionExerciseSource(sessionID, exerciseID, source)
}

func (s *Store) PropagateExerciseToSchedule(sessionID int64, exerciseID int64, exerciseName string, sets *int, reps *int, weight *float64) error {
	return s.workout.PropagateExerciseToSchedule(sessionID, exerciseID, exerciseName, sets, reps, weight)
}

func (s *Store) GetExerciseLogBySessionAndExercise(sessionID, exerciseID int64) (*WorkoutExerciseLog, error) {
	return s.workout.GetExerciseLogBySessionAndExercise(sessionID, exerciseID)
}

// -- Schedule Snapshot Methods --

func (s *Store) CreateGroupSnapshot(groupID int64, snapshotData, changeReason string) error {
	return s.workout.CreateGroupSnapshot(groupID, snapshotData, changeReason)
}

func (s *Store) GetGroupSnapshots(groupID int64) ([]WorkoutScheduleSnapshot, error) {
	return s.workout.GetGroupSnapshots(groupID)
}

// -- History & Stats Methods --

func (s *Store) GetWorkoutHistory(userID int64, limit int) ([]WorkoutSession, error) {
	return s.workout.GetWorkoutHistory(userID, limit)
}

func (s *Store) GetSnoozedSessions(userID int64) ([]WorkoutSession, error) {
	return s.workout.GetSnoozedSessions(userID)
}

func (s *Store) GetExerciseStats(userID int64) ([]ExerciseStat, error) {
	return s.workout.GetExerciseStats(userID)
}

func (s *Store) GetActiveSessions(userID int64, date time.Time) ([]WorkoutSession, error) {
	return s.workout.GetActiveSessions(userID, date)
}

func (s *Store) ListRecentExerciseLogsByName(ctx context.Context, userID int64, exerciseName string, limit int) ([]WorkoutExerciseLog, error) {
	return s.workout.ListRecentExerciseLogsByName(ctx, userID, exerciseName, limit)
}

func (s *Store) GetDistinctExerciseNamesForUser(ctx context.Context, userID int64) ([]string, error) {
	return s.workout.GetDistinctExerciseNamesForUser(ctx, userID)
}
