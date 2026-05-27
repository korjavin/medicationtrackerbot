// Package weight owns the weight_logs and weight_reminder_state tables, plus
// the per-user weight goal and weight-unit preference stored on the singleton
// settings row.
//
// Repo is the per-domain repository. Construct via store.New / store.NewWithDB
// and reach it as r.Weight; new code should depend on *weight.Repo (or a
// narrow interface satisfied by it) directly.
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

// WeightGoal is the per-user weight target. New goals are stored as
// append-only rows in the weight_goals history table; the legacy
// settings.weight_goal{,_date} singleton columns remain as a backward-compat
// cache populated by SetGoal. GoalSetAt / GoalStartWeight are populated only
// when the latest row comes from the history table — legacy fallback reads
// leave both nil.
type WeightGoal struct {
	Goal            *float64   `json:"goal,omitempty"`
	GoalDate        *time.Time `json:"goal_date,omitempty"`
	GoalSetAt       *time.Time `json:"goal_set_at,omitempty"`
	GoalStartWeight *float64   `json:"goal_start_weight,omitempty"`
}

// WeightGoalHistory is one row of the weight_goals history table — a single
// SetGoal commitment with the snapshot of the user's weight at that moment.
// StartWeight is nullable: NULL when the user had no prior weight log when
// they saved the goal.
type WeightGoalHistory struct {
	ID           int64     `json:"id"`
	UserID       int64     `json:"user_id"`
	SetAt        time.Time `json:"set_at"`
	TargetWeight float64   `json:"target_weight"`
	TargetDate   string    `json:"target_date"`
	StartWeight  *float64  `json:"start_weight,omitempty"`
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

// CreateLog inserts a single weight measurement.
func (r *Repo) CreateLog(ctx context.Context, w *WeightLog) (int64, error) {
	res, err := r.db.ExecContext(ctx,
		"INSERT INTO weight_logs (user_id, measured_at, weight, weight_trend, body_fat, body_fat_trend, muscle_mass, muscle_mass_trend, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		w.UserID, w.MeasuredAt, w.Weight, w.WeightTrend, w.BodyFat, w.BodyFatTrend, w.MuscleMass, w.MuscleMassTrend, w.Notes)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// ListLogs returns the user's logs since the given instant in descending
// measured_at order. A zero `since` returns all.
func (r *Repo) ListLogs(ctx context.Context, userID int64, since time.Time) ([]WeightLog, error) {
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

// DeleteLog deletes the log with the given id, but only when it belongs
// to the supplied userID — prevents one user from deleting another user's data
// even if they guess the id. Returns sql.ErrNoRows when the row does not exist
// or belongs to a different user.
func (r *Repo) DeleteLog(ctx context.Context, id, userID int64) error {
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

// GetLastLog returns the user's most recent weight log, or nil if none.
func (r *Repo) GetLastLog(ctx context.Context, userID int64) (*WeightLog, error) {
	return r.GetLastLogExcluding(ctx, userID, 0)
}

// GetLastLogExcluding returns the most recent weight log for the user,
// optionally excluding a row by ID. Pass excludeID = 0 to disable exclusion.
// Used by the POST /api/weight edit path so the EMA trend baseline skips the
// soon-to-be-deleted original log.
func (r *Repo) GetLastLogExcluding(ctx context.Context, userID, excludeID int64) (*WeightLog, error) {
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

// GetHighestLog returns the user's heaviest recorded weight, or nil
// when there are no logs.
func (r *Repo) GetHighestLog(ctx context.Context, userID int64) (*WeightLog, error) {
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

// BatchGetLastLogs fetches the last weight log for multiple users.
func (r *Repo) BatchGetLastLogs(ctx context.Context, userIDs []int64) (map[int64]*WeightLog, error) {
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

// GetGoal returns the user's weight target. It reads the most recent row from
// the per-user weight_goals history table; when that table has no row for the
// user AND no row for any other user either, it falls back to the legacy
// singleton settings.weight_goal{,_date} columns (snapshot fields stay nil in
// that case). The "no row for any user" gate is important: SetGoal dual-writes
// to the singleton for backwards compat with older clients, so once anyone has
// saved a goal via the new path the singleton no longer represents pristine
// legacy data — returning it to a different user would leak the latest
// writer's goal across users. Returns a zero-valued goal (all fields nil) when
// neither source has a goal.
func (r *Repo) GetGoal(ctx context.Context, userID int64) (*WeightGoal, error) {
	var setAtUnix int64
	var target float64
	var targetDateStr string
	var startWeight sql.NullFloat64

	err := r.db.QueryRowContext(ctx,
		// id DESC breaks ties when two saves land in the same unix second —
		// set_at_unix has second granularity and a UI double-tap or MCP burst
		// can collide. id is AUTOINCREMENT so the latest INSERT always wins.
		`SELECT set_at_unix, target_weight, target_date, start_weight
		 FROM weight_goals
		 WHERE user_id = ?
		 ORDER BY set_at_unix DESC, id DESC
		 LIMIT 1`,
		userID,
	).Scan(&setAtUnix, &target, &targetDateStr, &startWeight)
	if err == nil {
		result := &WeightGoal{
			Goal: &target,
		}
		if t, perr := time.Parse("2006-01-02", targetDateStr); perr == nil {
			result.GoalDate = &t
		}
		setAt := storedb.UnixToTime(setAtUnix)
		result.GoalSetAt = &setAt
		if startWeight.Valid {
			result.GoalStartWeight = &startWeight.Float64
		}
		return result, nil
	}
	if err != sql.ErrNoRows {
		return nil, err
	}

	// Fallback: legacy singleton settings — only when no history exists for
	// anyone. As soon as any user has called SetGoal, the singleton reflects
	// that writer's goal (dual-write) and is no longer safe to return for a
	// different user. The NOT EXISTS gate runs in the same statement as the
	// settings read so a concurrent SetGoal from another user cannot
	// interleave between the gate and the read.
	return r.getGoalFromSettings(ctx)
}

// getGoalFromSettings reads the legacy singleton settings.weight_goal{,_date}
// columns. Used as fallback when the per-user weight_goals history table has
// no row for the user. The NOT EXISTS clause atomically gates on the absence
// of any history row across all users — see the comment in GetGoal for why.
func (r *Repo) getGoalFromSettings(ctx context.Context) (*WeightGoal, error) {
	var goal sql.NullFloat64
	var goalDateStr sql.NullString

	err := r.db.QueryRowContext(ctx,
		`SELECT weight_goal, weight_goal_date
		   FROM settings
		  WHERE id = 1
		    AND NOT EXISTS (SELECT 1 FROM weight_goals)`,
	).Scan(&goal, &goalDateStr)
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

// ListGoals returns the user's weight-goal history in descending set_at order
// (most recent first). A limit <= 0 returns all rows for the user.
func (r *Repo) ListGoals(ctx context.Context, userID int64, limit int) ([]WeightGoalHistory, error) {
	query := `SELECT id, user_id, set_at_unix, target_weight, target_date, start_weight
		 FROM weight_goals
		 WHERE user_id = ?
		 ORDER BY set_at_unix DESC, id DESC`
	args := []interface{}{userID}
	if limit > 0 {
		query += " LIMIT ?"
		args = append(args, limit)
	}

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var goals []WeightGoalHistory
	for rows.Next() {
		var g WeightGoalHistory
		var setAtUnix int64
		var startWeight sql.NullFloat64
		if err := rows.Scan(&g.ID, &g.UserID, &setAtUnix, &g.TargetWeight, &g.TargetDate, &startWeight); err != nil {
			return nil, err
		}
		g.SetAt = storedb.UnixToTime(setAtUnix)
		if startWeight.Valid {
			g.StartWeight = &startWeight.Float64
		}
		goals = append(goals, g)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return goals, nil
}

// SetGoal records a new weight target as an append-only history row and
// updates the legacy singleton settings.weight_goal{,_date} columns inside the
// same transaction. The history row snapshots the user's latest logged weight
// at the moment of the call into start_weight (NULL when no log exists); the
// chart uses that snapshot together with (target_date, target_weight) as the
// trajectory endpoints — see web/static/js/components/wg-weight-chart.js. The
// legacy settings columns stay as a backward-compat denormalized cache so
// older clients (and the legacy fallback in GetGoal) continue to read the
// most recent goal.
func (r *Repo) SetGoal(ctx context.Context, userID int64, weight float64, targetDate time.Time) error {
	dateStr := targetDate.Format("2006-01-02")
	setAtUnix := time.Now().UTC().Unix()

	return r.db.WithTx(ctx, func(tx storedb.TX) error {
		// Snapshot the latest log INSIDE the tx so a concurrent CreateLog
		// between the SELECT and the INSERT can't silently leave start_weight
		// pointing at a stale row (see MEMORY.md → "Wrap SELECT+UPSERT in a
		// transaction to avoid TOCTOU race").
		var startWeight sql.NullFloat64
		err := tx.QueryRowContext(ctx,
			"SELECT weight FROM weight_logs WHERE user_id = ? ORDER BY measured_at DESC LIMIT 1",
			userID,
		).Scan(&startWeight)
		if err != nil && err != sql.ErrNoRows {
			return err
		}

		if _, err := tx.ExecContext(ctx,
			`INSERT INTO weight_goals (user_id, set_at_unix, target_weight, target_date, start_weight)
			 VALUES (?, ?, ?, ?, ?)`,
			userID, setAtUnix, weight, dateStr, startWeight,
		); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			"UPDATE settings SET weight_goal = ?, weight_goal_date = ? WHERE id = 1",
			weight, dateStr,
		); err != nil {
			return err
		}
		return nil
	})
}

// GetUnitPreference returns the user's preferred weight unit ("kg" or
// "lb"). Defaults to "kg" when no preference has been set or the stored value
// is invalid.
func (r *Repo) GetUnitPreference(ctx context.Context) (string, error) {
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

// SetUnitPreference records the user's preferred weight unit. Only "kg"
// and "lb" are accepted — any other value returns an error and leaves the
// existing preference unchanged.
func (r *Repo) SetUnitPreference(ctx context.Context, unit string) error {
	if unit != "kg" && unit != "lb" {
		return fmt.Errorf("invalid weight unit %q: must be 'kg' or 'lb'", unit)
	}
	_, err := r.db.ExecContext(ctx, "UPDATE settings SET weight_unit_preference = ? WHERE id = 1", unit)
	return err
}
