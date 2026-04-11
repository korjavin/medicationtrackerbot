package store

import (
	"strings"

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
	Source        string    `json:"source"` // "device" or "manual"
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

// CheckDuplicateMiBandWorkout checks if a workout exists for a user within a given start timestamp range.
func (s *Store) CheckDuplicateMiBandWorkout(ctx context.Context, userID int64, startMsMin, startMsMax int64) (bool, error) {
	var count int
	err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM miband_workouts
		WHERE user_id = ? AND source_start_ms >= ? AND source_start_ms <= ?
	`, userID, startMsMin, startMsMax).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// InsertMiBandWorkout inserts a single workout (dedup by user_id + source_start_ms).
// Returns inserted=true if a new row was created, inserted=false if deduplicated.
func (s *Store) InsertMiBandWorkout(ctx context.Context, w *MiBandWorkout) (bool, error) {
	src := w.Source
	if src == "" {
		src = "device"
	}
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO miband_workouts
			(user_id, source_start_ms, source_end_ms, activity_type, activity_name,
			 duration_sec, distance_m, steps, calories, heart_rate_avg, spo2_avg,
			 pause_ms, tz_offset, source)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, source_start_ms) DO NOTHING`,
		w.UserID, w.SourceStartMs, w.SourceEndMs, w.ActivityType, w.ActivityName,
		w.DurationSec, w.DistanceM, w.Steps, w.Calories, w.HeartRateAvg, w.SpO2Avg,
		w.PauseMs, w.TzOffset, src,
	)
	if err != nil {
		return false, err
	}

	rowsAffected, err := res.RowsAffected()
	if err != nil {
		return false, err
	}

	if rowsAffected == 0 {
		return false, nil
	}

	lastID, err := res.LastInsertId()
	if err == nil {
		w.ID = lastID
	}

	return true, nil
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

		src := w.Source
		if src == "" {
			src = "device"
		}
		res, err := tx.ExecContext(ctx, `
			INSERT INTO miband_workouts
				(user_id, source_start_ms, source_end_ms, activity_type, activity_name,
				 duration_sec, distance_m, steps, calories, heart_rate_avg, spo2_avg,
				 pause_ms, tz_offset, source)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id, source_start_ms) DO NOTHING`,
			w.UserID, w.SourceStartMs, w.SourceEndMs, w.ActivityType, w.ActivityName,
			w.DurationSec, w.DistanceM, w.Steps, w.Calories, w.HeartRateAvg, w.SpO2Avg,
			w.PauseMs, w.TzOffset, src,
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
			batchSize := 50

			// Build the base query string for exactly batchSize once
			var fullBatchBuilder strings.Builder
			fullBatchBuilder.Grow(115 + batchSize*25)
			fullBatchBuilder.WriteString("INSERT INTO miband_gps_tracks (workout_id, point_index, ts_ms, latitude, longitude, altitude, is_pause) VALUES ")
			for i := 0; i < batchSize; i++ {
				if i > 0 {
					fullBatchBuilder.WriteString(", ")
				}
				fullBatchBuilder.WriteString("(?, ?, ?, ?, ?, ?, ?)")
			}
			fullBatchQuery := fullBatchBuilder.String()
			fullStmt, err := tx.PrepareContext(ctx, fullBatchQuery)
			if err != nil {
				_ = tx.Rollback()
				return imported, skipped, err
			}

			args := make([]interface{}, batchSize*7)
			for start := 0; start < len(pts); start += batchSize {
				end := start + batchSize
				isFullBatch := true

				if end > len(pts) {
					end = len(pts)
					isFullBatch = false
				}

				batchPts := pts[start:end]

				for i, pt := range batchPts {
					isPause := 0
					if pt.IsPause {
						isPause = 1
					}
					idx := i * 7
					args[idx] = workoutID
					args[idx+1] = start + i
					args[idx+2] = pt.TsMs
					args[idx+3] = pt.Latitude
					args[idx+4] = pt.Longitude
					args[idx+5] = pt.Altitude
					args[idx+6] = isPause
				}

				if isFullBatch {
					if _, err := fullStmt.ExecContext(ctx, args...); err != nil {
						_ = fullStmt.Close()
						_ = tx.Rollback()
						return imported, skipped, err
					}
				} else {
					// Remainder batch
					remainder := end - start
					var remBuilder strings.Builder
					remBuilder.Grow(115 + remainder*25)
					remBuilder.WriteString("INSERT INTO miband_gps_tracks (workout_id, point_index, ts_ms, latitude, longitude, altitude, is_pause) VALUES ")
					for i := 0; i < remainder; i++ {
						if i > 0 {
							remBuilder.WriteString(", ")
						}
						remBuilder.WriteString("(?, ?, ?, ?, ?, ?, ?)")
					}
					if _, err := tx.ExecContext(ctx, remBuilder.String(), args[:remainder*7]...); err != nil {
						_ = fullStmt.Close()
						_ = tx.Rollback()
						return imported, skipped, err
					}
				}
			}
			_ = fullStmt.Close()
		}

		if err := tx.Commit(); err != nil {
			return imported, skipped, err
		}
		imported++
	}

	return imported, skipped, nil
}

// ListMiBandWorkouts returns the most recent outdoor workouts for the given user (last 90 days).
func (s *Store) ListMiBandWorkouts(ctx context.Context, userID int64, limit int) ([]MiBandWorkout, error) {
	if limit <= 0 {
		limit = 50
	}
	// Filter to last 90 days to avoid surfacing ancient workouts
	cutoffMs := time.Now().AddDate(0, 0, -90).UnixMilli()
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, user_id, source_start_ms, source_end_ms, activity_type, activity_name,
		       duration_sec, distance_m, steps, calories, heart_rate_avg, spo2_avg,
		       pause_ms, tz_offset, imported_at, source
		FROM miband_workouts
		WHERE user_id = ? AND source_start_ms >= ?
		ORDER BY source_start_ms DESC
		LIMIT ?`, userID, cutoffMs, limit)
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
			&w.HeartRateAvg, &w.SpO2Avg, &w.PauseMs, &w.TzOffset, &w.ImportedAt, &w.Source,
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
		       pause_ms, tz_offset, imported_at, source
		FROM miband_workouts WHERE id = ?`, id).Scan(
		&w.ID, &w.UserID, &w.SourceStartMs, &w.SourceEndMs,
		&w.ActivityType, &w.ActivityName,
		&w.DurationSec, &w.DistanceM, &w.Steps, &w.Calories,
		&w.HeartRateAvg, &w.SpO2Avg, &w.PauseMs, &w.TzOffset, &w.ImportedAt, &w.Source,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &w, nil
}

// UpdateMiBandWorkoutFields holds pointer fields for updating a Mi Band workout.
// A nil pointer means the field should not be updated.
type UpdateMiBandWorkoutFields struct {
	Steps        *int     `json:"steps"`
	DistanceM    *float64 `json:"distance_m"`
	DurationSec  *int     `json:"duration_sec"`
	Calories     *int     `json:"calories"`
	HeartRateAvg *int     `json:"heart_rate_avg"`
	SpO2Avg      *int     `json:"spo2_avg"`
}

// DeleteMiBandWorkout deletes a Mi Band workout by ID and user ID.
// Note: PRAGMA foreign_keys is not enabled by default in modernc.org/sqlite,
// so we manually cascade the deletion of GPS tracks first.
func (s *Store) DeleteMiBandWorkout(ctx context.Context, id, userID int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}

	// Verify ownership and delete workout
	res, err := tx.ExecContext(ctx, `DELETE FROM miband_workouts WHERE id = ? AND user_id = ?`, id, userID)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	rowsAffected, err := res.RowsAffected()
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if rowsAffected == 0 {
		_ = tx.Rollback()
		return sql.ErrNoRows
	}

	// Delete associated GPS tracks
	if _, err := tx.ExecContext(ctx, `DELETE FROM miband_gps_tracks WHERE workout_id = ?`, id); err != nil {
		_ = tx.Rollback()
		return err
	}

	return tx.Commit()
}

// UpdateMiBandWorkout updates the specified fields of a Mi Band workout.
func (s *Store) UpdateMiBandWorkout(ctx context.Context, id, userID int64, fields UpdateMiBandWorkoutFields) error {
	query := "UPDATE miband_workouts SET "
	var args []interface{}
	var updates []string

	if fields.Steps != nil {
		updates = append(updates, "steps = ?")
		args = append(args, *fields.Steps)
	}
	if fields.DistanceM != nil {
		updates = append(updates, "distance_m = ?")
		args = append(args, *fields.DistanceM)
	}
	if fields.DurationSec != nil {
		updates = append(updates, "duration_sec = ?")
		args = append(args, *fields.DurationSec)
	}
	if fields.Calories != nil {
		updates = append(updates, "calories = ?")
		args = append(args, *fields.Calories)
	}
	if fields.HeartRateAvg != nil {
		updates = append(updates, "heart_rate_avg = ?")
		args = append(args, *fields.HeartRateAvg)
	}
	if fields.SpO2Avg != nil {
		updates = append(updates, "spo2_avg = ?")
		args = append(args, *fields.SpO2Avg)
	}

	if len(updates) == 0 {
		return nil // Nothing to update
	}

	query += strings.Join(updates, ", ") + " WHERE id = ? AND user_id = ?"
	args = append(args, id, userID)

	res, err := s.db.ExecContext(ctx, query, args...)
	if err != nil {
		return err
	}

	rowsAffected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if rowsAffected == 0 {
		return sql.ErrNoRows
	}

	return nil
}
