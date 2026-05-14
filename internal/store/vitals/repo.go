// Package vitals owns the sleep_logs, day_stats, vitals_heart, vitals_spo2,
// and vitals_stress tables: sleep sessions and the time-series vitals captured
// by wearable imports (mi-band today, others later).
//
// Repo is the per-domain repository. Construct via store.New / store.NewWithDB
// and reach it as r.Vitals; new code should depend on *vitals.Repo (or a
// narrow interface satisfied by it) directly.
package vitals

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// SleepLog is one row of the sleep_logs table — a single sleep session with
// optional phase breakdowns (light/deep/REM/awake minutes), turn-over count,
// and average heart-rate / SpO2 for the session. Optional fields are *int so
// "not measured" is distinguishable from a zero reading.
type SleepLog struct {
	ID             int64     `json:"id"`
	UserID         int64     `json:"user_id"`
	StartTime      time.Time `json:"start_time"`
	EndTime        time.Time `json:"end_time"`
	TimezoneOffset int       `json:"timezone_offset"`
	Day            string    `json:"day"`
	LightMinutes   *int      `json:"light_minutes,omitempty"`
	DeepMinutes    *int      `json:"deep_minutes,omitempty"`
	REMMinutes     *int      `json:"rem_minutes,omitempty"`
	AwakeMinutes   *int      `json:"awake_minutes,omitempty"`
	TotalMinutes   *int      `json:"total_minutes,omitempty"`
	TurnOverCount  *int      `json:"turn_over_count,omitempty"`
	HeartRateAvg   *int      `json:"heart_rate_avg,omitempty"`
	SpO2Avg        *int      `json:"spo2_avg,omitempty"`
	UserModified   bool      `json:"user_modified"`
	Notes          string    `json:"notes,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
}

// DayStat is one row of the day_stats table — daily step/calorie/distance
// aggregates produced by the wearable summary export.
type DayStat struct {
	ID        int64     `json:"id"`
	UserID    int64     `json:"user_id"`
	Day       string    `json:"day"`
	Steps     int       `json:"steps"`
	Calories  int       `json:"calories"`
	Distance  int       `json:"distance"`
	CreatedAt time.Time `json:"created_at"`
}

// VitalsHeartLog is one heart-rate sample from the vitals_heart time series.
type VitalsHeartLog struct {
	UserID   int64     `json:"user_id"`
	DateTime time.Time `json:"date_time"`
	TzOffset int       `json:"tz_offset"`
	Value    int       `json:"value"`
	Type     int       `json:"type"`
}

// VitalsSpO2Log is one blood-oxygen sample from the vitals_spo2 time series.
type VitalsSpO2Log struct {
	UserID   int64     `json:"user_id"`
	DateTime time.Time `json:"date_time"`
	TzOffset int       `json:"tz_offset"`
	Value    int       `json:"value"`
	Type     int       `json:"type"`
}

// VitalsStressLog is one stress sample from the vitals_stress time series.
// Info may be empty for samples that don't carry a textual label.
type VitalsStressLog struct {
	UserID   int64     `json:"user_id"`
	DateTime time.Time `json:"date_time"`
	TzOffset int       `json:"tz_offset"`
	Value    int       `json:"value"`
	Type     int       `json:"type"`
	Info     string    `json:"info,omitempty"`
}

// Repo is the vitals repository. Construct with New; share one *Repo per
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

// ImportSleepLogs bulk-upserts sleep sessions for a user. The conditional
// ON CONFLICT clause prefers the row with the larger total_minutes and
// backfills NULL columns from a newer payload so an end-of-day snapshot can
// supersede a mid-day partial without downgrading already-complete fields.
// Returns (imported_or_updated, skipped, error).
func (r *Repo) ImportSleepLogs(ctx context.Context, userID int64, logs []SleepLog) (int, int, error) {
	if len(logs) == 0 {
		return 0, 0, nil
	}

	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback() }()

	imported := 0
	batchSize := 50

	for i := 0; i < len(logs); i += batchSize {
		end := i + batchSize
		if end > len(logs) {
			end = len(logs)
		}

		batch := logs[i:end]

		query := `INSERT INTO sleep_logs (user_id, start_time, end_time,
			 timezone_offset, day, light_minutes, deep_minutes, rem_minutes,
			 awake_minutes, total_minutes, turn_over_count, heart_rate_avg,
			 spo2_avg, user_modified, notes) VALUES `

		var placeholders []string
		var args []interface{}

		for _, sl := range batch {
			placeholders = append(placeholders, "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
			args = append(args, userID, sl.StartTime, sl.EndTime,
				sl.TimezoneOffset, sl.Day, sl.LightMinutes, sl.DeepMinutes,
				sl.REMMinutes, sl.AwakeMinutes, sl.TotalMinutes, sl.TurnOverCount,
				sl.HeartRateAvg, sl.SpO2Avg, sl.UserModified, sl.Notes)
		}

		query += strings.Join(placeholders, ", ")
		query += ` ON CONFLICT(user_id, start_time) DO UPDATE SET
			end_time=excluded.end_time,
			light_minutes=COALESCE(excluded.light_minutes, sleep_logs.light_minutes),
			deep_minutes=COALESCE(excluded.deep_minutes, sleep_logs.deep_minutes),
			rem_minutes=COALESCE(excluded.rem_minutes, sleep_logs.rem_minutes),
			awake_minutes=COALESCE(excluded.awake_minutes, sleep_logs.awake_minutes),
			total_minutes=excluded.total_minutes,
			turn_over_count=COALESCE(excluded.turn_over_count, sleep_logs.turn_over_count),
			heart_rate_avg=COALESCE(excluded.heart_rate_avg, sleep_logs.heart_rate_avg),
			spo2_avg=COALESCE(excluded.spo2_avg, sleep_logs.spo2_avg)
		  WHERE excluded.total_minutes > COALESCE(sleep_logs.total_minutes, 0)
		     OR (excluded.total_minutes = COALESCE(sleep_logs.total_minutes, 0) AND (
		         (excluded.light_minutes IS NOT NULL AND sleep_logs.light_minutes IS NULL)
		      OR (excluded.deep_minutes IS NOT NULL AND sleep_logs.deep_minutes IS NULL)
		      OR (excluded.rem_minutes IS NOT NULL AND sleep_logs.rem_minutes IS NULL)
		      OR (excluded.awake_minutes IS NOT NULL AND sleep_logs.awake_minutes IS NULL)
		      OR (excluded.turn_over_count IS NOT NULL AND sleep_logs.turn_over_count IS NULL)
		      OR (excluded.heart_rate_avg IS NOT NULL AND sleep_logs.heart_rate_avg IS NULL)
		      OR (excluded.spo2_avg IS NOT NULL AND sleep_logs.spo2_avg IS NULL)
		     ))`

		res, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return 0, 0, err
		}

		rowsAffected, _ := res.RowsAffected()
		imported += int(rowsAffected)
	}

	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}

	skipped := len(logs) - imported
	return imported, skipped, nil
}

// ImportDayStats upserts per-day step/calorie/distance aggregates. The
// MAX-based UPDATE clause is intentional: imports may arrive out of order
// (older backup re-imported after a newer one), and we never want a stale
// partial day to overwrite higher totals.
func (r *Repo) ImportDayStats(ctx context.Context, userID int64, stats []DayStat) (int, int, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback() }()

	stmt, err := tx.PrepareContext(ctx,
		`INSERT INTO day_stats (user_id, day, steps, calories, distance)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, day) DO UPDATE SET
		   steps=MAX(COALESCE(day_stats.steps, 0), COALESCE(excluded.steps, 0)),
		   calories=MAX(COALESCE(day_stats.calories, 0), COALESCE(excluded.calories, 0)),
		   distance=MAX(COALESCE(day_stats.distance, 0), COALESCE(excluded.distance, 0))
		 WHERE COALESCE(excluded.steps, 0) > COALESCE(day_stats.steps, 0)
		    OR COALESCE(excluded.calories, 0) > COALESCE(day_stats.calories, 0)
		    OR COALESCE(excluded.distance, 0) > COALESCE(day_stats.distance, 0)`)
	if err != nil {
		return 0, 0, err
	}
	defer stmt.Close()

	imported := 0
	for _, st := range stats {
		res, err := stmt.ExecContext(ctx, userID, st.Day, st.Steps, st.Calories, st.Distance)
		if err != nil {
			return 0, 0, err
		}
		rowsAffected, _ := res.RowsAffected()
		imported += int(rowsAffected)
	}

	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}

	skipped := len(stats) - imported
	return imported, skipped, nil
}

// GetDayStats returns the user's daily aggregates from day_stats. If since is
// non-zero, only days >= since.Format("2006-01-02") are returned. Result is
// ordered by day DESC.
func (r *Repo) GetDayStats(ctx context.Context, userID int64, since time.Time) ([]DayStat, error) {
	query := `SELECT id, user_id, day, steps, calories, distance, created_at
		 FROM day_stats WHERE user_id = ?`
	args := []interface{}{userID}

	if !since.IsZero() {
		// Day format is "2006-01-02", so we can do string comparison
		sinceDay := since.Format("2006-01-02")
		query += " AND day >= ?"
		args = append(args, sinceDay)
	}

	query += " ORDER BY day DESC"

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var stats []DayStat
	for rows.Next() {
		var st DayStat
		if err := rows.Scan(&st.ID, &st.UserID, &st.Day, &st.Steps, &st.Calories, &st.Distance, &st.CreatedAt); err != nil {
			return nil, err
		}
		stats = append(stats, st)
	}
	return stats, nil
}

// GetSleepLogs returns the user's sleep sessions. If since is non-zero, only
// rows with start_time >= since are returned. Result is ordered by start_time
// DESC. Optional columns (phase breakdowns, turn-over count, HR/SpO2 averages)
// scan via sql.NullInt64 and populate *int pointers only when present.
func (r *Repo) GetSleepLogs(ctx context.Context, userID int64, since time.Time) ([]SleepLog, error) {
	query := `SELECT id, user_id, start_time, end_time, timezone_offset, day, light_minutes, deep_minutes, rem_minutes,
		 awake_minutes, total_minutes, turn_over_count, heart_rate_avg, spo2_avg, user_modified, notes, created_at
		 FROM sleep_logs WHERE user_id = ?`
	args := []interface{}{userID}

	if !since.IsZero() {
		query += " AND start_time >= ?"
		args = append(args, since)
	}

	query += " ORDER BY start_time DESC"

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []SleepLog
	for rows.Next() {
		var sl SleepLog
		var light, deep, rem, awake, total, turnOver, hr, spo2 sql.NullInt64
		var notes sql.NullString

		if err := rows.Scan(&sl.ID, &sl.UserID, &sl.StartTime, &sl.EndTime, &sl.TimezoneOffset, &sl.Day,
			&light, &deep, &rem, &awake, &total, &turnOver, &hr, &spo2, &sl.UserModified, &notes, &sl.CreatedAt); err != nil {
			return nil, err
		}

		if light.Valid {
			val := int(light.Int64)
			sl.LightMinutes = &val
		}
		if deep.Valid {
			val := int(deep.Int64)
			sl.DeepMinutes = &val
		}
		if rem.Valid {
			val := int(rem.Int64)
			sl.REMMinutes = &val
		}
		if awake.Valid {
			val := int(awake.Int64)
			sl.AwakeMinutes = &val
		}
		if total.Valid {
			val := int(total.Int64)
			sl.TotalMinutes = &val
		}
		if turnOver.Valid {
			val := int(turnOver.Int64)
			sl.TurnOverCount = &val
		}
		if hr.Valid {
			val := int(hr.Int64)
			sl.HeartRateAvg = &val
		}
		if spo2.Valid {
			val := int(spo2.Int64)
			sl.SpO2Avg = &val
		}
		if notes.Valid {
			sl.Notes = notes.String
		}

		logs = append(logs, sl)
	}
	return logs, nil
}

// ImportVitals bulk-inserts the heart / SpO2 / stress time-series in a single
// transaction. INSERT OR IGNORE on (user_id, date_time) drops re-imports of
// identical samples without erroring. Returns (imported, skipped, error).
func (r *Repo) ImportVitals(ctx context.Context, userID int64, heartLogs []VitalsHeartLog, spo2Logs []VitalsSpO2Log, stressLogs []VitalsStressLog) (int, int, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }() // intentional: no-op if Commit succeeded

	totalImported := 0
	totalSkipped := 0

	heartImported, heartSkipped, err := importHeartLogs(tx, userID, heartLogs)
	if err != nil {
		return 0, 0, err
	}
	totalImported += heartImported
	totalSkipped += heartSkipped

	spo2Imported, spo2Skipped, err := importSpO2Logs(tx, userID, spo2Logs)
	if err != nil {
		return 0, 0, err
	}
	totalImported += spo2Imported
	totalSkipped += spo2Skipped

	stressImported, stressSkipped, err := importStressLogs(tx, userID, stressLogs)
	if err != nil {
		return 0, 0, err
	}
	totalImported += stressImported
	totalSkipped += stressSkipped

	if err := tx.Commit(); err != nil {
		return 0, 0, fmt.Errorf("failed to commit transaction: %w", err)
	}

	return totalImported, totalSkipped, nil
}

func importHeartLogs(tx *sql.Tx, userID int64, logs []VitalsHeartLog) (int, int, error) {
	if len(logs) == 0 {
		return 0, 0, nil
	}

	imported := 0
	skipped := 0

	chunkSize := 500
	for i := 0; i < len(logs); i += chunkSize {
		end := i + chunkSize
		if end > len(logs) {
			end = len(logs)
		}
		chunk := logs[i:end]

		query := "INSERT OR IGNORE INTO vitals_heart (user_id, date_time, tz_offset, value, type) VALUES "
		vals := []interface{}{}
		for _, l := range chunk {
			query += "(?, ?, ?, ?, ?),"
			vals = append(vals, userID, l.DateTime.UnixMilli(), l.TzOffset, l.Value, l.Type)
		}
		query = strings.TrimSuffix(query, ",")

		res, err := tx.Exec(query, vals...)
		if err != nil {
			return imported, skipped, fmt.Errorf("failed to bulk insert heart logs: %w", err)
		}

		rowsAllocated, _ := res.RowsAffected()
		imported += int(rowsAllocated)
		skipped += len(chunk) - int(rowsAllocated)
	}
	return imported, skipped, nil
}

func importSpO2Logs(tx *sql.Tx, userID int64, logs []VitalsSpO2Log) (int, int, error) {
	if len(logs) == 0 {
		return 0, 0, nil
	}

	imported := 0
	skipped := 0

	chunkSize := 500
	for i := 0; i < len(logs); i += chunkSize {
		end := i + chunkSize
		if end > len(logs) {
			end = len(logs)
		}
		chunk := logs[i:end]

		query := "INSERT OR IGNORE INTO vitals_spo2 (user_id, date_time, tz_offset, value, type) VALUES "
		vals := []interface{}{}
		for _, l := range chunk {
			query += "(?, ?, ?, ?, ?),"
			vals = append(vals, userID, l.DateTime.UnixMilli(), l.TzOffset, l.Value, l.Type)
		}
		query = strings.TrimSuffix(query, ",")

		res, err := tx.Exec(query, vals...)
		if err != nil {
			return imported, skipped, fmt.Errorf("failed to bulk insert spo2 logs: %w", err)
		}

		rowsAllocated, _ := res.RowsAffected()
		imported += int(rowsAllocated)
		skipped += len(chunk) - int(rowsAllocated)
	}
	return imported, skipped, nil
}

func importStressLogs(tx *sql.Tx, userID int64, logs []VitalsStressLog) (int, int, error) {
	if len(logs) == 0 {
		return 0, 0, nil
	}

	imported := 0
	skipped := 0

	chunkSize := 500
	for i := 0; i < len(logs); i += chunkSize {
		end := i + chunkSize
		if end > len(logs) {
			end = len(logs)
		}
		chunk := logs[i:end]

		query := "INSERT OR IGNORE INTO vitals_stress (user_id, date_time, tz_offset, value, type, info) VALUES "
		vals := []interface{}{}
		for _, l := range chunk {
			query += "(?, ?, ?, ?, ?, ?),"

			var info interface{}
			if l.Info != "" {
				info = l.Info
			}

			vals = append(vals, userID, l.DateTime.UnixMilli(), l.TzOffset, l.Value, l.Type, info)
		}
		query = strings.TrimSuffix(query, ",")

		res, err := tx.Exec(query, vals...)
		if err != nil {
			return imported, skipped, fmt.Errorf("failed to bulk insert stress logs: %w", err)
		}

		rowsAllocated, _ := res.RowsAffected()
		imported += int(rowsAllocated)
		skipped += len(chunk) - int(rowsAllocated)
	}
	return imported, skipped, nil
}

// GetVitalsHeart returns heart-rate samples in [start, end] (inclusive bounds
// in millisecond UNIX time), ordered by date_time ASC.
func (r *Repo) GetVitalsHeart(ctx context.Context, userID int64, start, end time.Time) ([]VitalsHeartLog, error) {
	query := "SELECT user_id, date_time, tz_offset, value, type FROM vitals_heart WHERE user_id = ? AND date_time >= ? AND date_time <= ? ORDER BY date_time ASC"
	rows, err := r.db.QueryContext(ctx, query, userID, start.UnixMilli(), end.UnixMilli())
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []VitalsHeartLog
	for rows.Next() {
		var l VitalsHeartLog
		var dateMs int64
		if err := rows.Scan(&l.UserID, &dateMs, &l.TzOffset, &l.Value, &l.Type); err != nil {
			return nil, err
		}
		l.DateTime = time.UnixMilli(dateMs).UTC()
		logs = append(logs, l)
	}
	return logs, nil
}

// GetVitalsSpO2 returns SpO2 samples in [start, end] (inclusive bounds in
// millisecond UNIX time), ordered by date_time ASC.
func (r *Repo) GetVitalsSpO2(ctx context.Context, userID int64, start, end time.Time) ([]VitalsSpO2Log, error) {
	query := "SELECT user_id, date_time, tz_offset, value, type FROM vitals_spo2 WHERE user_id = ? AND date_time >= ? AND date_time <= ? ORDER BY date_time ASC"
	rows, err := r.db.QueryContext(ctx, query, userID, start.UnixMilli(), end.UnixMilli())
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []VitalsSpO2Log
	for rows.Next() {
		var l VitalsSpO2Log
		var dateMs int64
		if err := rows.Scan(&l.UserID, &dateMs, &l.TzOffset, &l.Value, &l.Type); err != nil {
			return nil, err
		}
		l.DateTime = time.UnixMilli(dateMs).UTC()
		logs = append(logs, l)
	}
	return logs, nil
}

// GetVitalsStress returns stress samples in [start, end] (inclusive bounds in
// millisecond UNIX time), ordered by date_time ASC. Info may be empty when
// the underlying row has a NULL label.
func (r *Repo) GetVitalsStress(ctx context.Context, userID int64, start, end time.Time) ([]VitalsStressLog, error) {
	query := "SELECT user_id, date_time, tz_offset, value, type, info FROM vitals_stress WHERE user_id = ? AND date_time >= ? AND date_time <= ? ORDER BY date_time ASC"
	rows, err := r.db.QueryContext(ctx, query, userID, start.UnixMilli(), end.UnixMilli())
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []VitalsStressLog
	for rows.Next() {
		var l VitalsStressLog
		var dateMs int64
		var info sql.NullString
		if err := rows.Scan(&l.UserID, &dateMs, &l.TzOffset, &l.Value, &l.Type, &info); err != nil {
			return nil, err
		}
		l.DateTime = time.UnixMilli(dateMs).UTC()
		if info.Valid {
			l.Info = info.String
		}
		logs = append(logs, l)
	}
	return logs, nil
}
