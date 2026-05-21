// Package bp owns the blood_pressure_readings and bp_reminder_state tables:
// individual BP measurements (systolic/diastolic/pulse), the singleton-row
// BP goal stored in settings, and per-user reminder cadence state.
//
// Repo is the per-domain repository. Construct via store.New / store.NewWithDB
// and reach it as r.BP; new code should depend on *bp.Repo (or a narrow
// interface satisfied by it) directly.
package bp

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// BloodPressure is one row of the blood_pressure_readings table — a single BP
// measurement with optional pulse, site/position context, an auto-calculated
// or caller-supplied category, and free-form notes/tag.
type BloodPressure struct {
	ID         int64     `json:"id"`
	UserID     int64     `json:"user_id"`
	MeasuredAt time.Time `json:"measured_at"`
	Systolic   int       `json:"systolic"`
	Diastolic  int       `json:"diastolic"`
	Pulse      *int      `json:"pulse,omitempty"`
	Site       string    `json:"site,omitempty"`
	Position   string    `json:"position,omitempty"`
	Category   string    `json:"category,omitempty"`
	IgnoreCalc bool      `json:"ignore_calc"`
	Notes      string    `json:"notes,omitempty"`
	Tag        string    `json:"tag,omitempty"`
}

// BPGoal is the per-user BP target (stored as two nullable columns on the
// singleton settings row, not its own table).
type BPGoal struct {
	TargetSystolic  *int `json:"target_systolic,omitempty"`
	TargetDiastolic *int `json:"target_diastolic,omitempty"`
}

// BPPeriodStats holds daily-weighted BP stats for a specific time period.
type BPPeriodStats struct {
	Systolic  int `json:"systolic"`
	Diastolic int `json:"diastolic"`
	Days      int `json:"days"`     // Number of days with readings
	Readings  int `json:"readings"` // Total number of readings
}

// BPStats contains daily time-weighted blood pressure statistics for multiple
// time periods (14 / 30 / 60 days).
type BPStats struct {
	Stats14 *BPPeriodStats `json:"stats_14,omitempty"`
	Stats30 *BPPeriodStats `json:"stats_30,omitempty"`
	Stats60 *BPPeriodStats `json:"stats_60,omitempty"`
}

// TimezoneLookup is the narrow interface the BP repo needs to find the user's
// current timezone for day-boundary calculations in GetDailyWeightedStats.
// Satisfied by *tz.Repo (which owns the timezone_history table).
type TimezoneLookup interface {
	GetCurrent() (string, error)
}

// Repo is the blood-pressure repository. Construct with New; share one *Repo
// per process — the underlying *db.DB owns its own connection pool.
type Repo struct {
	db  *storedb.DB
	now func() time.Time
	tz  TimezoneLookup
}

// New returns a Repo bound to the shared *db.DB. The composition root passes
// in the same *db.DB it gives every other repo so all reads/writes go through
// one connection pool. The tz lookup is required for GetDailyWeightedStats
// to compute correct local-time day boundaries — pass nil to fall back to UTC.
func New(d *storedb.DB, tz TimezoneLookup) *Repo {
	return &Repo{db: d, now: time.Now, tz: tz}
}

// SetClock overrides the time source used by GetDailyWeightedStats. Tests
// use it to inject a deterministic timestamp; production code should never
// call it.
func (r *Repo) SetClock(now func() time.Time) {
	r.now = now
}

// CalculateBPCategory returns the AHA/ACC severity bucket for a given
// systolic/diastolic pair. Pure function, no DB access — exposed at package
// level so callers that compute a category outside the DB-write path (bot
// inference, demo seeder) can share the same thresholds.
func CalculateBPCategory(systolic, diastolic int) string {
	if systolic > 180 || diastolic > 120 {
		return "Hypertensive Crisis"
	}
	if systolic >= 140 || diastolic >= 90 {
		return "High BP Stage 2"
	}
	if systolic >= 130 || diastolic >= 80 {
		return "High BP Stage 1"
	}
	if systolic >= 120 && systolic < 130 && diastolic < 80 {
		return "Elevated"
	}
	if systolic < 120 && diastolic < 80 {
		return "Normal"
	}
	return "Unknown"
}

// CategorySeverity returns a numeric value for category comparison
// (higher = worse).
func CategorySeverity(category string) int {
	switch category {
	case "Hypertensive Crisis":
		return 5
	case "High BP Stage 2":
		return 4
	case "High BP Stage 1":
		return 3
	case "Elevated":
		return 2
	case "Normal":
		return 1
	default:
		return 0
	}
}

// truncateToDay returns midnight (start of day) in the given timezone. This
// ensures day boundaries respect the user's local calendar, e.g. a reading
// at 00:30 Europe/Berlin is on the correct local day, not the previous UTC
// day.
func truncateToDay(t time.Time, loc *time.Location) time.Time {
	local := t.In(loc)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
}

// GetGoal returns the user's BP target. Returns a zero-valued goal (both
// fields nil) when no goal has been set.
func (r *Repo) GetGoal() (*BPGoal, error) {
	var systolic, diastolic sql.NullInt64

	err := r.db.QueryRow("SELECT bp_target_systolic, bp_target_diastolic FROM settings WHERE id = 1").Scan(&systolic, &diastolic)
	if err == sql.ErrNoRows {
		return &BPGoal{}, nil
	}
	if err != nil {
		return nil, err
	}

	result := &BPGoal{}
	if systolic.Valid {
		v := int(systolic.Int64)
		result.TargetSystolic = &v
	}
	if diastolic.Valid {
		v := int(diastolic.Int64)
		result.TargetDiastolic = &v
	}
	return result, nil
}

// SetGoal records a new BP target on the singleton settings row.
func (r *Repo) SetGoal(targetSystolic, targetDiastolic int) error {
	_, err := r.db.Exec("UPDATE settings SET bp_target_systolic = ?, bp_target_diastolic = ? WHERE id = 1", targetSystolic, targetDiastolic)
	return err
}

// CreateReading inserts a single BP reading. When bp.Category is
// empty and bp.IgnoreCalc is false, the category is computed from
// systolic/diastolic via CalculateBPCategory.
func (r *Repo) CreateReading(ctx context.Context, bp *BloodPressure) (int64, error) {
	if bp.Category == "" && !bp.IgnoreCalc {
		bp.Category = CalculateBPCategory(bp.Systolic, bp.Diastolic)
	}

	res, err := r.db.ExecContext(ctx,
		"INSERT INTO blood_pressure_readings (user_id, measured_at, systolic, diastolic, pulse, site, position, category, ignore_calc, notes, tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		bp.UserID, bp.MeasuredAt, bp.Systolic, bp.Diastolic, bp.Pulse, bp.Site, bp.Position, bp.Category, bp.IgnoreCalc, bp.Notes, bp.Tag)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// ListReadings returns the user's readings since the given
// instant in descending measured_at order. A zero `since` returns all.
func (r *Repo) ListReadings(ctx context.Context, userID int64, since time.Time) ([]BloodPressure, error) {
	query := "SELECT id, user_id, measured_at, systolic, diastolic, pulse, site, position, category, ignore_calc, notes, tag FROM blood_pressure_readings WHERE user_id = ?"
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

	var readings []BloodPressure
	for rows.Next() {
		var bp BloodPressure
		var pulse sql.NullInt64
		var site, position, category, notes, tag sql.NullString

		if err := rows.Scan(&bp.ID, &bp.UserID, &bp.MeasuredAt, &bp.Systolic, &bp.Diastolic, &pulse, &site, &position, &category, &bp.IgnoreCalc, &notes, &tag); err != nil {
			return nil, err
		}

		if pulse.Valid {
			bp.Pulse = new(int)
			*bp.Pulse = int(pulse.Int64)
		}
		if site.Valid {
			bp.Site = site.String
		}
		if position.Valid {
			bp.Position = position.String
		}
		if category.Valid {
			bp.Category = category.String
		}
		if notes.Valid {
			bp.Notes = notes.String
		}
		if tag.Valid {
			bp.Tag = tag.String
		}

		readings = append(readings, bp)
	}
	return readings, nil
}

// LatestReading returns the most-recent measured_at for a user's BP readings
// (zero time + found=false when the user has no readings). Used by the demo
// top-up loop to resume seeding BP from the last known reading forward.
//
// Scans through a string buffer because SQLite's MAX() strips the DATETIME
// column's affinity (same workaround as workout.GetLatestSessionScheduledDate).
func (r *Repo) LatestReading(ctx context.Context, userID int64) (time.Time, bool, error) {
	var measuredStr sql.NullString
	if err := r.db.QueryRowContext(ctx,
		"SELECT MAX(measured_at) FROM blood_pressure_readings WHERE user_id = ?", userID).Scan(&measuredStr); err != nil {
		return time.Time{}, false, err
	}
	if !measuredStr.Valid {
		return time.Time{}, false, nil
	}
	t, err := storedb.ParseSQLiteDateTime(measuredStr.String)
	if err != nil {
		return time.Time{}, false, fmt.Errorf("parse blood_pressure_readings.measured_at %q: %w", measuredStr.String, err)
	}
	return t.UTC(), true, nil
}

// DeleteReading deletes the reading with the given id, but only
// when it belongs to the supplied userID — prevents one user from deleting
// another user's data even if they guess the id. Returns sql.ErrNoRows when
// the row does not exist or belongs to a different user.
func (r *Repo) DeleteReading(ctx context.Context, id, userID int64) error {
	res, err := r.db.ExecContext(ctx, "DELETE FROM blood_pressure_readings WHERE id = ? AND user_id = ?", id, userID)
	if err != nil {
		return err
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// ImportReadings bulk-inserts BP readings inside a single
// transaction. Missing categories are auto-computed when IgnoreCalc is false.
func (r *Repo) ImportReadings(ctx context.Context, userID int64, readings []BloodPressure) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	stmt, err := tx.PrepareContext(ctx,
		"INSERT INTO blood_pressure_readings (user_id, measured_at, systolic, diastolic, pulse, site, position, category, ignore_calc, notes, tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, bp := range readings {
		bp.UserID = userID
		if bp.Category == "" && !bp.IgnoreCalc {
			bp.Category = CalculateBPCategory(bp.Systolic, bp.Diastolic)
		}

		var pulse interface{}
		if bp.Pulse != nil {
			pulse = *bp.Pulse
		} else {
			pulse = nil
		}

		_, err := stmt.ExecContext(ctx, bp.UserID, bp.MeasuredAt, bp.Systolic, bp.Diastolic, pulse, bp.Site, bp.Position, bp.Category, bp.IgnoreCalc, bp.Notes, bp.Tag)
		if err != nil {
			return err
		}
	}

	return tx.Commit()
}

// GetDailyWeightedStats computes blood pressure averages using a two-stage
// algorithm that prevents measurement-frequency bias.
//
// Problem: A user who measures 5 times on a stressful day (high BP) and once
// on 3 calm days would get an inflated average if we simply averaged all 8
// readings. The stressful day would contribute 5/8 of the result instead of
// 1/4.
//
// Stage 1 — Per-day time-weighted average:
//
//	Within each calendar day, each reading is weighted by the duration until
//	the next reading (or end-of-day / current time, whichever comes first).
//	This gives a fair intra-day average that accounts for how long each BP
//	level was sustained.
//
// Stage 2 — Equal-weight daily average across the period:
//
//	Each day that has data contributes exactly one vote to the period
//	average, regardless of how many readings that day had. Days without
//	readings are excluded entirely (they don't count as zero — they're
//	simply absent).
//
// Day boundaries use the user's stored timezone (from the tz lookup passed
// to New) so readings near midnight local time are assigned to the correct
// calendar day. Falls back to UTC when no timezone is stored or the lookup
// is nil.
func (r *Repo) GetDailyWeightedStats(ctx context.Context, userID int64) (*BPStats, error) {
	// Load user's timezone for day-boundary calculation. Falls back to UTC
	// if no timezone is stored or the stored value is invalid.
	loc := time.UTC
	if r.tz != nil {
		if tzStr, err := r.tz.GetCurrent(); err == nil && tzStr != "" {
			if parsed, err := time.LoadLocation(tzStr); err == nil {
				loc = parsed
			}
		}
	}

	now := r.now().In(loc)
	maxDays := 60
	windowStart := truncateToDay(now.AddDate(0, 0, -maxDays), loc)

	var readings []BloodPressure
	{
		rows, err := r.db.QueryContext(ctx,
			"SELECT measured_at, systolic, diastolic FROM blood_pressure_readings WHERE user_id = ? AND ignore_calc = 0 AND measured_at >= ? ORDER BY measured_at ASC",
			userID, windowStart)
		if err != nil {
			return nil, err
		}
		defer rows.Close()

		for rows.Next() {
			var bp BloodPressure
			if err := rows.Scan(&bp.MeasuredAt, &bp.Systolic, &bp.Diastolic); err != nil {
				return nil, err
			}
			readings = append(readings, bp)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}

	if len(readings) == 0 {
		return &BPStats{}, nil
	}

	type dayAgg struct {
		sumSys float64
		sumDia float64
		durSec float64
	}

	dayAggs := map[time.Time]*dayAgg{}

	// Stage 1: Aggregate readings into per-day time-weighted sums.
	// Each reading's weight = seconds until the next event (next reading, end-of-day, or now).
	for i := 0; i < len(readings); i++ {
		// Skip duplicate timestamps — keep only the last reading at any given instant.
		if i+1 < len(readings) && readings[i+1].MeasuredAt.Equal(readings[i].MeasuredAt) {
			continue
		}
		start := readings[i].MeasuredAt.In(loc)
		if start.After(now) {
			continue
		}
		dayStart := truncateToDay(start, loc)
		dayEnd := dayStart.AddDate(0, 0, 1)

		// Cap the reading's influence at the day boundary so it doesn't bleed into the next day.
		end := dayEnd
		if i+1 < len(readings) {
			next := readings[i+1].MeasuredAt.In(loc)
			// If the next reading is on the same calendar day, use it as the end point.
			if truncateToDay(next, loc).Equal(dayStart) {
				end = next
			}
		}
		// Cap at current time so future end-of-day doesn't inflate today's duration.
		if end.After(now) {
			end = now
		}
		if !end.After(start) {
			continue
		}

		dur := end.Sub(start).Seconds()
		if dur <= 0 {
			continue
		}
		agg := dayAggs[dayStart]
		if agg == nil {
			agg = &dayAgg{}
			dayAggs[dayStart] = agg
		}
		agg.sumSys += float64(readings[i].Systolic) * dur
		agg.sumDia += float64(readings[i].Diastolic) * dur
		agg.durSec += dur
	}

	// Stage 2: Compute period averages (14d, 30d, 60d) where each day with data
	// contributes equally, regardless of how many readings that day had.
	buildStats := func(periodDays int) *BPPeriodStats {
		periodStart := truncateToDay(now.AddDate(0, 0, -periodDays), loc)
		var sumSys, sumDia float64
		var days int

		for day, agg := range dayAggs {
			if day.Before(periodStart) || day.After(truncateToDay(now, loc)) {
				continue
			}
			if agg.durSec <= 0 {
				continue
			}
			// Convert time-weighted sums to a single daily average.
			avgSys := agg.sumSys / agg.durSec
			avgDia := agg.sumDia / agg.durSec
			sumSys += avgSys
			sumDia += avgDia
			days++
		}

		if days == 0 {
			return nil
		}

		readingsCount := 0
		for _, bp := range readings {
			measured := bp.MeasuredAt.In(loc)
			if measured.Before(periodStart) || measured.After(now) {
				continue
			}
			readingsCount++
		}

		return &BPPeriodStats{
			Systolic:  int(math.Round(sumSys / float64(days))),
			Diastolic: int(math.Round(sumDia / float64(days))),
			Days:      days,
			Readings:  readingsCount,
		}
	}

	result := &BPStats{}
	result.Stats14 = buildStats(14)
	result.Stats30 = buildStats(30)
	result.Stats60 = buildStats(60)

	return result, nil
}
