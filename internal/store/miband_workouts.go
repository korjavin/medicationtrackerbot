package store

import (
	"context"

	"github.com/korjavin/medicationtrackerbot/internal/store/workout"
)

// This file is now a thin forwarder layer over internal/store/workout.
// All Mi Band implementations live in internal/store/workout/miband.go; this
// layer preserves the legacy *Store surface so consumers compile unchanged
// until Task 13 removes forwarders. See
// docs/plans/2026-05-13-split-store-package.md.

// -- Type aliases so existing store.XYZ references compile unchanged --

type MiBandWorkout = workout.MiBandWorkout
type MiBandGPSPoint = workout.MiBandGPSPoint
type UpdateMiBandWorkoutFields = workout.UpdateMiBandWorkoutFields

func (s *Store) CheckDuplicateMiBandWorkout(ctx context.Context, userID int64, startMsMin, startMsMax int64) (bool, error) {
	return s.workout.CheckDuplicateMiBandWorkout(ctx, userID, startMsMin, startMsMax)
}

func (s *Store) InsertMiBandWorkout(ctx context.Context, w *MiBandWorkout) (bool, error) {
	return s.workout.InsertMiBandWorkout(ctx, w)
}

func (s *Store) ImportMiBandWorkouts(ctx context.Context, workouts []MiBandWorkout, gpsTracks map[int64][]MiBandGPSPoint) (int, int, error) {
	return s.workout.ImportMiBandWorkouts(ctx, workouts, gpsTracks)
}

func (s *Store) ListMiBandWorkouts(ctx context.Context, userID int64, limit int) ([]MiBandWorkout, error) {
	return s.workout.ListMiBandWorkouts(ctx, userID, limit)
}

func (s *Store) GetMiBandWorkoutGPS(ctx context.Context, workoutID int64) ([]MiBandGPSPoint, error) {
	return s.workout.GetMiBandWorkoutGPS(ctx, workoutID)
}

func (s *Store) GetMiBandWorkout(ctx context.Context, id int64) (*MiBandWorkout, error) {
	return s.workout.GetMiBandWorkout(ctx, id)
}

func (s *Store) DeleteMiBandWorkout(ctx context.Context, id, userID int64) error {
	return s.workout.DeleteMiBandWorkout(ctx, id, userID)
}

func (s *Store) UpdateMiBandWorkout(ctx context.Context, id, userID int64, fields UpdateMiBandWorkoutFields) error {
	return s.workout.UpdateMiBandWorkout(ctx, id, userID, fields)
}
