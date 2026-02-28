package domain

import (
	"archive/zip"
	"database/sql"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// SleepLog mirrors store.SleepLog for domain-level parsing without store dependency.
type SleepLog struct {
	StartTime      time.Time
	EndTime        time.Time
	TimezoneOffset int
	Day            string
	LightMinutes   *int
	DeepMinutes    *int
	REMMinutes     *int
	AwakeMinutes   *int
	TotalMinutes   *int
	TurnOverCount  *int
	HeartRateAvg   *int
	SpO2Avg        *int
	UserModified   bool
	Notes          string
}

// VitalsHeartLog mirrors store.VitalsHeartLog.
type VitalsHeartLog struct {
	DateTime time.Time
	TzOffset int
	Value    int
	Type     int
}

// VitalsSpO2Log mirrors store.VitalsSpO2Log.
type VitalsSpO2Log struct {
	DateTime time.Time
	TzOffset int
	Value    int
	Type     int
}

// VitalsStressLog mirrors store.VitalsStressLog.
type VitalsStressLog struct {
	DateTime time.Time
	TzOffset int
	Value    int
	Type     int
	Info     string
}

// DayStat mirrors store.DayStat.
type DayStat struct {
	Day      string
	Steps    int
	Calories int
	Distance int
}

// ValidateImportFile validates a file name and size for sleep import.
func ValidateImportFile(fileName string, fileSize int64) error {
	if !strings.HasSuffix(strings.ToLower(fileName), ".nxk") {
		return fmt.Errorf("only .nxk files are supported for sleep import")
	}
	if fileSize > 50*1024*1024 {
		return fmt.Errorf("file too large, maximum size is 50MB")
	}
	return nil
}

// ExtractBackupDB extracts backup.db from a ZIP (.nxk) file to a temp file.
// Returns the temp file path and a cleanup function that should be deferred.
func ExtractBackupDB(nxkPath string) (string, func(), error) {
	zipReader, err := zip.OpenReader(nxkPath)
	if err != nil {
		return "", nil, fmt.Errorf("invalid ZIP archive: %w", err)
	}
	defer zipReader.Close()

	var dbFile *zip.File
	for _, f := range zipReader.File {
		if f.Name == "backup.db" {
			dbFile = f
			break
		}
	}
	if dbFile == nil {
		return "", nil, fmt.Errorf("backup.db not found in archive")
	}

	tempDB, err := os.CreateTemp("", "sleep-db-*.db")
	if err != nil {
		return "", nil, err
	}

	rc, err := dbFile.Open()
	if err != nil {
		os.Remove(tempDB.Name())
		tempDB.Close()
		return "", nil, err
	}
	defer rc.Close()

	const maxSleepDBSize = 256 * 1024 * 1024
	_, err = io.Copy(tempDB, io.LimitReader(rc, maxSleepDBSize))
	if err != nil {
		os.Remove(tempDB.Name())
		tempDB.Close()
		return "", nil, err
	}
	_ = tempDB.Close()

	path := tempDB.Name()
	cleanup := func() {
		os.Remove(path)
	}
	return path, cleanup, nil
}

// ParseSleepDatabase reads sleep records from an NXK backup SQLite database.
func ParseSleepDatabase(dbPath string) ([]SleepLog, error) {
	log.Printf("Parsing sleep database: %s", dbPath)

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("invalid database file: %w", err)
	}

	rows, err := db.Query(`SELECT start, end, tz, day, light, deep, rem, awake,
		total, turnOver, hrAvg, spo2Avg, userModified, info FROM sleep ORDER BY start`)
	if err != nil {
		return nil, fmt.Errorf("failed to query sleep table: %w", err)
	}
	defer rows.Close()

	var logs []SleepLog
	for rows.Next() {
		var startMs, endMs int64
		var tz int
		var day string
		var light, deep, rem, awake, total sql.NullInt64
		var turnOver, hrAvg, spo2Avg sql.NullInt64
		var userModified int
		var info sql.NullString

		err := rows.Scan(&startMs, &endMs, &tz, &day, &light, &deep, &rem,
			&awake, &total, &turnOver, &hrAvg, &spo2Avg, &userModified, &info)
		if err != nil {
			return nil, fmt.Errorf("failed to scan sleep record: %w", err)
		}

		sl := SleepLog{
			StartTime:      time.UnixMilli(startMs).UTC(),
			EndTime:        time.UnixMilli(endMs).UTC(),
			TimezoneOffset: tz,
			Day:            day,
			UserModified:   userModified != 0,
		}

		if light.Valid {
			v := int(light.Int64)
			sl.LightMinutes = &v
		}
		if deep.Valid {
			v := int(deep.Int64)
			sl.DeepMinutes = &v
		}
		if rem.Valid {
			v := int(rem.Int64)
			sl.REMMinutes = &v
		}
		if awake.Valid {
			v := int(awake.Int64)
			sl.AwakeMinutes = &v
		}
		if total.Valid {
			v := int(total.Int64)
			sl.TotalMinutes = &v
		}
		if turnOver.Valid {
			v := int(turnOver.Int64)
			sl.TurnOverCount = &v
		}
		if hrAvg.Valid {
			v := int(hrAvg.Int64)
			sl.HeartRateAvg = &v
		}
		if spo2Avg.Valid {
			v := int(spo2Avg.Int64)
			sl.SpO2Avg = &v
		}
		if info.Valid {
			sl.Notes = info.String
		}

		logs = append(logs, sl)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error reading sleep records: %w", err)
	}

	log.Printf("Successfully parsed %d sleep records", len(logs))
	return logs, nil
}

// ParseHeartDatabase reads heart rate records from an NXK backup SQLite database.
func ParseHeartDatabase(dbPath string) ([]VitalsHeartLog, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.Query(`SELECT dateTime, tz, value, type FROM heart ORDER BY dateTime`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []VitalsHeartLog
	for rows.Next() {
		var dateMs int64
		var tz, val, typ int
		if err := rows.Scan(&dateMs, &tz, &val, &typ); err != nil {
			return nil, err
		}
		logs = append(logs, VitalsHeartLog{
			DateTime: time.UnixMilli(dateMs).UTC(),
			TzOffset: tz,
			Value:    val,
			Type:     typ,
		})
	}
	return logs, nil
}

// ParseDayDatabase reads daily stats from an NXK backup SQLite database.
func ParseDayDatabase(dbPath string) ([]DayStat, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.Query(`SELECT day, steps, calories, distance FROM day ORDER BY day`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var stats []DayStat
	for rows.Next() {
		var dayStr string
		var steps, cal, dist int
		if err := rows.Scan(&dayStr, &steps, &cal, &dist); err != nil {
			return nil, err
		}
		stats = append(stats, DayStat{
			Day:      dayStr,
			Steps:    steps,
			Calories: cal,
			Distance: dist,
		})
	}
	return stats, nil
}

// ParseSpO2Database reads SpO2 records from an NXK backup SQLite database.
func ParseSpO2Database(dbPath string) ([]VitalsSpO2Log, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.Query(`SELECT dateTime, tz, value, type FROM spo2 ORDER BY dateTime`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []VitalsSpO2Log
	for rows.Next() {
		var dateMs int64
		var tz, val, typ int
		if err := rows.Scan(&dateMs, &tz, &val, &typ); err != nil {
			return nil, err
		}
		logs = append(logs, VitalsSpO2Log{
			DateTime: time.UnixMilli(dateMs).UTC(),
			TzOffset: tz,
			Value:    val,
			Type:     typ,
		})
	}
	return logs, nil
}

// ParseStressDatabase reads stress records from an NXK backup SQLite database.
func ParseStressDatabase(dbPath string) ([]VitalsStressLog, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.Query(`SELECT dateTime, tz, value, type, info FROM stress ORDER BY dateTime`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []VitalsStressLog
	for rows.Next() {
		var dateMs int64
		var tz, val, typ int
		var info sql.NullString
		if err := rows.Scan(&dateMs, &tz, &val, &typ, &info); err != nil {
			return nil, err
		}
		l := VitalsStressLog{
			DateTime: time.UnixMilli(dateMs).UTC(),
			TzOffset: tz,
			Value:    val,
			Type:     typ,
		}
		if info.Valid {
			l.Info = info.String
		}
		logs = append(logs, l)
	}
	return logs, nil
}
