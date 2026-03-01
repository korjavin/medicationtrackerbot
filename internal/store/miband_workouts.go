package store

import (
	"context"
	"database/sql"
	"time"
)

// MiBandWorkout represents an imported outdoor workout from a Mi Band device.
type MiBandWorkout struct {
	ID            int64     `json:"id"`
	UserID        int64     `json:"user_id"`
	SourceStartMs int64     `json:"source_start_ms"`
	SourceEndMs   int64     `json:"source_end_ms"`
	ActivityType  int       `json:"activity_type"`
	ActivityName  string    `json:"activity_name"`
	DurationSec   int       `json:"duration_sec"`
	DistanceM     float64   `json:"distance_m"`
	Steps         int       `json:"steps"`
	Calories      int       `json:"calories"`
	HeartRateAvg  int       `json:"heart_rate_avg"`
	SpO2Avg       int       `json:"spo2_avg"`
	PauseMs       int64     `json:"pause_ms"`
	TzOffset      int       `json:"tz_offset"`
	ImportedAt    time.Time `json:"imported_at"`
}

// MiBandGPSPoint is a single GPS point belonging to a MiBandWorkout.
type MiBandGPSPoint struct {
	WorkoutID  int64   `json:"workout_id"`
	PointIndex int     `json:"point_index"`
	TsMs       int64   `json:"ts_ms"`
	Latitude   float64 `json:"latitude"`
	Longitude  float64 `json:"longitude"`
	Altitude   float64 `json:"altitude"`
	IsPause    bool    `json:"is_pause"`
}

// ImportMiBandWorkouts inserts workouts that don't already exist (dedup by user_id + source_start_ms).
// GPS tracks are inserted inside the same transaction.
// Returns (imported, skipped, error).
func (s *Store) ImportMiBandWorkouts(ctx context.Context, workouts []MiBandWorkout, gpsTracks map[int64][]MiBandGPSPoint) (int, int, error) {
	imported := 0
	skipped := 0

	for i := range workouts {
		w := &workouts[i]

		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return imported, skipped, err
		}

		res, err := tx.ExecContext(ctx, `
			INSERT INTO miband_workouts
				(user_id, source_start_ms, source_end_ms, activity_type, activity_name,
				 duration_sec, distance_m, steps, calories, heart_rate_avg, spo2_avg,
				 pause_ms, tz_offset)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id, source_start_ms) DO NOTHING`,
			w.UserID, w.SourceStartMs, w.SourceEndMs, w.ActivityType, w.ActivityName,
			w.DurationSec, w.DistanceM, w.Steps, w.Calories, w.HeartRateAvg, w.SpO2Avg,
			w.PauseMs, w.TzOffset,
		)
		if err != nil {
			_ = tx.Rollback()
			return imported, skipped, err
		}

		rowsAffected, err := res.RowsAffected()
		if err != nil {
			_ = tx.Rollback()
			return imported, skipped, err
		}

		if rowsAffected == 0 {
			_ = tx.Rollback()
			skipped++
			continue
		}

		workoutID, err := res.LastInsertId()
		if err != nil {
			_ = tx.Rollback()
			return imported, skipped, err
		}

		// Insert GPS track points if any
		if pts, ok := gpsTracks[w.SourceStartMs]; ok && len(pts) > 0 {
			stmt, err := tx.PrepareContext(ctx, `
				INSERT INTO miband_gps_tracks (workout_id, point_index, ts_ms, latitude, longitude, altitude, is_pause)
				VALUES (?, ?, ?, ?, ?, ?, ?)`)
			if err != nil {
				_ = tx.Rollback()
				return imported, skipped, err
			}
			for idx, pt := range pts {
				isPause := 0
				if pt.IsPause {
					isPause = 1
				}
				if _, err := stmt.ExecContext(ctx, workoutID, idx, pt.TsMs, pt.Latitude, pt.Longitude, pt.Altitude, isPause); err != nil {
					_ = stmt.Close()
					_ = tx.Rollback()
					return imported, skipped, err
				}
			}
			_ = stmt.Close()
		}

		if err := tx.Commit(); err != nil {
			return imported, skipped, err
		}
		imported++
	}

	return imported, skipped, nil
}

// ListMiBandWorkouts returns the most recent outdoor workouts for the given user.
func (s *Store) ListMiBandWorkouts(ctx context.Context, userID int64, limit int) ([]MiBandWorkout, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, user_id, source_start_ms, source_end_ms, activity_type, activity_name,
		       duration_sec, distance_m, steps, calories, heart_rate_avg, spo2_avg,
		       pause_ms, tz_offset, imported_at
		FROM miband_workouts
		WHERE user_id = ?
		ORDER BY source_start_ms DESC
		LIMIT ?`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var workouts []MiBandWorkout
	for rows.Next() {
		var w MiBandWorkout
		if err := rows.Scan(
			&w.ID, &w.UserID, &w.SourceStartMs, &w.SourceEndMs,
			&w.ActivityType, &w.ActivityName,
			&w.DurationSec, &w.DistanceM, &w.Steps, &w.Calories,
			&w.HeartRateAvg, &w.SpO2Avg, &w.PauseMs, &w.TzOffset, &w.ImportedAt,
		); err != nil {
			return nil, err
		}
		workouts = append(workouts, w)
	}
	return workouts, rows.Err()
}

// GetMiBandWorkoutGPS returns the GPS track for a single workout, ordered by point_index.
func (s *Store) GetMiBandWorkoutGPS(ctx context.Context, workoutID int64) ([]MiBandGPSPoint, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT workout_id, point_index, ts_ms, latitude, longitude, altitude, is_pause
		FROM miband_gps_tracks
		WHERE workout_id = ?
		ORDER BY point_index ASC`, workoutID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var pts []MiBandGPSPoint
	for rows.Next() {
		var pt MiBandGPSPoint
		var isPause int
		if err := rows.Scan(&pt.WorkoutID, &pt.PointIndex, &pt.TsMs, &pt.Latitude, &pt.Longitude, &pt.Altitude, &isPause); err != nil {
			return nil, err
		}
		pt.IsPause = isPause != 0
		pts = append(pts, pt)
	}
	return pts, rows.Err()
}

// GetMiBandWorkout returns a single workout by ID, or nil if not found.
func (s *Store) GetMiBandWorkout(ctx context.Context, id int64) (*MiBandWorkout, error) {
	var w MiBandWorkout
	err := s.db.QueryRowContext(ctx, `
		SELECT id, user_id, source_start_ms, source_end_ms, activity_type, activity_name,
		       duration_sec, distance_m, steps, calories, heart_rate_avg, spo2_avg,
		       pause_ms, tz_offset, imported_at
		FROM miband_workouts WHERE id = ?`, id).Scan(
		&w.ID, &w.UserID, &w.SourceStartMs, &w.SourceEndMs,
		&w.ActivityType, &w.ActivityName,
		&w.DurationSec, &w.DistanceM, &w.Steps, &w.Calories,
		&w.HeartRateAvg, &w.SpO2Avg, &w.PauseMs, &w.TzOffset, &w.ImportedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &w, nil
}
