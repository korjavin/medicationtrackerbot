// Package weight owns the weight_logs and weight_reminder_state tables, plus
// the per-user weight goal and weight-unit preference stored on the singleton
// settings row.
//
// Repo is the per-domain repository. The legacy *store.Store still exposes
// one-line forwarders (CreateWeightLog / GetWeightLogs / DeleteWeightLog /
// GetLastWeightLog / GetLastWeightLogExcluding / GetHighestWeightRecord /
// BatchGetLastWeightLogs / GetWeightGoal / SetWeightGoal /
// GetWeightUnitPreference / SetWeightUnitPreference /
// GetWeightReminderState / SetWeightReminderEnabled / SnoozeWeightReminder /
// DontBugMeWeightReminder / UpdateWeightReminderNotificationSent /
// ClearWeightReminderNotificationMessage / CalculatePreferredWeightReminderHour /
// UpdatePreferredWeightReminderHour / GetUsersForWeightReminders /
// GetWeightReminderStates) so old callers keep compiling; new code should
// depend on *weight.Repo (or a narrow interface satisfied by it) directly.
package weight

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// WeightLog is one row of the weight_logs table — a single weight measurement
// with optional body composition (body fat %, muscle mass) and EMA-smoothed
// trend lines.
type WeightLog struct {
	ID              int64     `json:"id"`
	UserID          int64     `json:"user_id"`
	MeasuredAt      time.Time `json:"measured_at"`
	Weight          float64   `json:"weight"`
	WeightTrend     *float64  `json:"weight_trend,omitempty"`
	BodyFat         *float64  `json:"body_fat,omitempty"`
	BodyFatTrend    *float64  `json:"body_fat_trend,omitempty"`
	MuscleMass      *float64  `json:"muscle_mass,omitempty"`
	MuscleMassTrend *float64  `json:"muscle_mass_trend,omitempty"`
	Notes           string    `json:"notes,omitempty"`
}

// WeightGoal is the per-user weight target (stored as two nullable columns on
// the singleton settings row, not its own table).
type WeightGoal struct {
	Goal     *float64   `json:"goal,omitempty"`
	GoalDate *time.Time `json:"goal_date,omitempty"`
}

// Repo is the weight repository. Construct with New; share one *Repo per
// process — the underlying *db.DB owns its own connection pool.
type Repo struct {
	db *storedb.DB
}

// New returns a Repo bound to the shared *db.DB. The composition root passes
// in the same *db.DB it gives every other repo so all reads/writes go through
// one connection pool.
func New(d *storedb.DB) *Repo {
	return &Repo{db: d}
}

// CalculateWeightTrend calculates a simple exponential moving average.
// alpha = 0.1 gives roughly a 20-day smoothing.
// Deprecated: prefer domain.CalculateWeightTrend for new code.
func CalculateWeightTrend(currentWeight float64, previousTrend *float64) float64 {
	if previousTrend == nil {
		return currentWeight
	}
	alpha := 0.1
	return alpha*currentWeight + (1-alpha)**previousTrend
}

// CreateWeightLog inserts a single weight measurement.
func (r *Repo) CreateWeightLog(ctx context.Context, w *WeightLog) (int64, error) {
	res, err := r.db.ExecContext(ctx,
		"INSERT INTO weight_logs (user_id, measured_at, weight, weight_trend, body_fat, body_fat_trend, muscle_mass, muscle_mass_trend, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		w.UserID, w.MeasuredAt, w.Weight, w.WeightTrend, w.BodyFat, w.BodyFatTrend, w.MuscleMass, w.MuscleMassTrend, w.Notes)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// GetWeightLogs returns the user's logs since the given instant in descending
// measured_at order. A zero `since` returns all.
func (r *Repo) GetWeightLogs(ctx context.Context, userID int64, since time.Time) ([]WeightLog, error) {
	query := "SELECT id, user_id, measured_at, weight, weight_trend, body_fat, body_fat_trend, muscle_mass, muscle_mass_trend, notes FROM weight_logs WHERE user_id = ?"
	args := []interface{}{userID}

	if !since.IsZero() {
		query += " AND measured_at >= ?"
		args = append(args, since)
	}

	query += " ORDER BY measured_at DESC"

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []WeightLog
	for rows.Next() {
		var w WeightLog
		var weightTrend, bodyFat, bodyFatTrend, muscleMass, muscleMassTrend sql.NullFloat64
		var notes sql.NullString

		if err := rows.Scan(&w.ID, &w.UserID, &w.MeasuredAt, &w.Weight, &weightTrend, &bodyFat, &bodyFatTrend, &muscleMass, &muscleMassTrend, &notes); err != nil {
			return nil, err
		}

		if weightTrend.Valid {
			w.WeightTrend = &weightTrend.Float64
		}
		if bodyFat.Valid {
			w.BodyFat = &bodyFat.Float64
		}
		if bodyFatTrend.Valid {
			w.BodyFatTrend = &bodyFatTrend.Float64
		}
		if muscleMass.Valid {
			w.MuscleMass = &muscleMass.Float64
		}
		if muscleMassTrend.Valid {
			w.MuscleMassTrend = &muscleMassTrend.Float64
		}
		if notes.Valid {
			w.Notes = notes.String
		}

		logs = append(logs, w)
	}
	return logs, nil
}

// DeleteWeightLog deletes the log with the given id, but only when it belongs
// to the supplied userID — prevents one user from deleting another user's data
// even if they guess the id. Returns sql.ErrNoRows when the row does not exist
// or belongs to a different user.
func (r *Repo) DeleteWeightLog(ctx context.Context, id, userID int64) error {
	res, err := r.db.ExecContext(ctx, "DELETE FROM weight_logs WHERE id = ? AND user_id = ?", id, userID)
	if err != nil {
		return err
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// GetLastWeightLog returns the user's most recent weight log, or nil if none.
func (r *Repo) GetLastWeightLog(ctx context.Context, userID int64) (*WeightLog, error) {
	return r.GetLastWeightLogExcluding(ctx, userID, 0)
}

// GetLastWeightLogExcluding returns the most recent weight log for the user,
// optionally excluding a row by ID. Pass excludeID = 0 to disable exclusion.
// Used by the POST /api/weight edit path so the EMA trend baseline skips the
// soon-to-be-deleted original log.
func (r *Repo) GetLastWeightLogExcluding(ctx context.Context, userID, excludeID int64) (*WeightLog, error) {
	var w WeightLog
	var weightTrend, bodyFat, bodyFatTrend, muscleMass, muscleMassTrend sql.NullFloat64
	var notes sql.NullString

	query := "SELECT id, user_id, measured_at, weight, weight_trend, body_fat, body_fat_trend, muscle_mass, muscle_mass_trend, notes FROM weight_logs WHERE user_id = ?"
	args := []interface{}{userID}
	if excludeID > 0 {
		query += " AND id != ?"
		args = append(args, excludeID)
	}
	query += " ORDER BY measured_at DESC LIMIT 1"

	err := r.db.QueryRowContext(ctx, query, args...).Scan(
		&w.ID, &w.UserID, &w.MeasuredAt, &w.Weight,
		&weightTrend, &bodyFat, &bodyFatTrend, &muscleMass, &muscleMassTrend, &notes)

	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	if weightTrend.Valid {
		w.WeightTrend = &weightTrend.Float64
	}
	if bodyFat.Valid {
		w.BodyFat = &bodyFat.Float64
	}
	if bodyFatTrend.Valid {
		w.BodyFatTrend = &bodyFatTrend.Float64
	}
	if muscleMass.Valid {
		w.MuscleMass = &muscleMass.Float64
	}
	if muscleMassTrend.Valid {
		w.MuscleMassTrend = &muscleMassTrend.Float64
	}
	if notes.Valid {
		w.Notes = notes.String
	}

	return &w, nil
}

// GetHighestWeightRecord returns the user's heaviest recorded weight, or nil
// when there are no logs.
func (r *Repo) GetHighestWeightRecord(ctx context.Context, userID int64) (*WeightLog, error) {
	var w WeightLog
	var weightTrend, bodyFat, bodyFatTrend, muscleMass, muscleMassTrend sql.NullFloat64
	var notes sql.NullString

	err := r.db.QueryRowContext(ctx,
		"SELECT id, user_id, measured_at, weight, weight_trend, body_fat, body_fat_trend, muscle_mass, muscle_mass_trend, notes FROM weight_logs WHERE user_id = ? ORDER BY weight DESC LIMIT 1",
		userID).Scan(&w.ID, &w.UserID, &w.MeasuredAt, &w.Weight, &weightTrend, &bodyFat, &bodyFatTrend, &muscleMass, &muscleMassTrend, &notes)

	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	if weightTrend.Valid {
		w.WeightTrend = &weightTrend.Float64
	}
	if bodyFat.Valid {
		w.BodyFat = &bodyFat.Float64
	}
	if bodyFatTrend.Valid {
		w.BodyFatTrend = &bodyFatTrend.Float64
	}
	if muscleMass.Valid {
		w.MuscleMass = &muscleMass.Float64
	}
	if muscleMassTrend.Valid {
		w.MuscleMassTrend = &muscleMassTrend.Float64
	}
	if notes.Valid {
		w.Notes = notes.String
	}

	return &w, nil
}

// BatchGetLastWeightLogs fetches the last weight log for multiple users.
func (r *Repo) BatchGetLastWeightLogs(ctx context.Context, userIDs []int64) (map[int64]*WeightLog, error) {
	result := make(map[int64]*WeightLog)
	if len(userIDs) == 0 {
		return result, nil
	}

	// SQLite has a limit on parameters, so we chunk the userIDs
	const chunkSize = 500
	for i := 0; i < len(userIDs); i += chunkSize {
		end := i + chunkSize
		if end > len(userIDs) {
			end = len(userIDs)
		}
		chunk := userIDs[i:end]

		query := `
			SELECT id, user_id, measured_at, weight, weight_trend, body_fat, body_fat_trend, muscle_mass, muscle_mass_trend, notes
			FROM (
				SELECT *, ROW_NUMBER() OVER(PARTITION BY user_id ORDER BY measured_at DESC) as rn
				FROM weight_logs
				WHERE user_id IN (`

		args := make([]interface{}, len(chunk))
		for j, id := range chunk {
			if j > 0 {
				query += ", "
			}
			query += "?"
			args[j] = id
		}
		query += `)
			) WHERE rn = 1`

		rows, err := r.db.QueryContext(ctx, query, args...)
		if err != nil {
			return nil, err
		}

		for rows.Next() {
			var w WeightLog
			var weightTrend, bodyFat, bodyFatTrend, muscleMass, muscleMassTrend sql.NullFloat64
			var notes sql.NullString

			if err := rows.Scan(&w.ID, &w.UserID, &w.MeasuredAt, &w.Weight, &weightTrend, &bodyFat, &bodyFatTrend, &muscleMass, &muscleMassTrend, &notes); err != nil {
				rows.Close()
				return nil, err
			}

			if weightTrend.Valid {
				w.WeightTrend = &weightTrend.Float64
			}
			if bodyFat.Valid {
				w.BodyFat = &bodyFat.Float64
			}
			if bodyFatTrend.Valid {
				w.BodyFatTrend = &bodyFatTrend.Float64
			}
			if muscleMass.Valid {
				w.MuscleMass = &muscleMass.Float64
			}
			if muscleMassTrend.Valid {
				w.MuscleMassTrend = &muscleMassTrend.Float64
			}
			if notes.Valid {
				w.Notes = notes.String
			}

			result[w.UserID] = &w
		}

		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}

	return result, nil
}

// GetWeightGoal returns the user's weight target. Returns a zero-valued goal
// (both fields nil) when no goal has been set.
func (r *Repo) GetWeightGoal() (*WeightGoal, error) {
	var goal sql.NullFloat64
	var goalDateStr sql.NullString

	err := r.db.QueryRow("SELECT weight_goal, weight_goal_date FROM settings WHERE id = 1").Scan(&goal, &goalDateStr)
	if err == sql.ErrNoRows {
		return &WeightGoal{}, nil
	}
	if err != nil {
		return nil, err
	}

	result := &WeightGoal{}
	if goal.Valid {
		result.Goal = &goal.Float64
	}
	if goalDateStr.Valid && goalDateStr.String != "" {
		t, err := time.Parse("2006-01-02", goalDateStr.String)
		if err == nil {
			result.GoalDate = &t
		}
	}
	return result, nil
}

// SetWeightGoal records a new weight target on the singleton settings row.
func (r *Repo) SetWeightGoal(weight float64, targetDate time.Time) error {
	dateStr := targetDate.Format("2006-01-02")
	_, err := r.db.Exec("UPDATE settings SET weight_goal = ?, weight_goal_date = ? WHERE id = 1", weight, dateStr)
	return err
}

// GetWeightUnitPreference returns the user's preferred weight unit ("kg" or
// "lb"). Defaults to "kg" when no preference has been set or the stored value
// is invalid.
func (r *Repo) GetWeightUnitPreference(ctx context.Context) (string, error) {
	var unit string
	err := r.db.QueryRowContext(ctx, "SELECT weight_unit_preference FROM settings WHERE id = 1").Scan(&unit)
	if err == sql.ErrNoRows {
		return "kg", nil
	}
	if err != nil {
		return "", err
	}
	if unit != "kg" && unit != "lb" {
		return "kg", nil
	}
	return unit, nil
}

// SetWeightUnitPreference records the user's preferred weight unit. Only "kg"
// and "lb" are accepted — any other value returns an error and leaves the
// existing preference unchanged.
func (r *Repo) SetWeightUnitPreference(ctx context.Context, unit string) error {
	if unit != "kg" && unit != "lb" {
		return fmt.Errorf("invalid weight unit %q: must be 'kg' or 'lb'", unit)
	}
	_, err := r.db.ExecContext(ctx, "UPDATE settings SET weight_unit_preference = ? WHERE id = 1", unit)
	return err
}
