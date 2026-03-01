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
		if closeErr := tempDB.Close(); closeErr != nil {
			log.Printf("failed to close temp db: %v", closeErr)
		}
		if rmErr := os.Remove(tempDB.Name()); rmErr != nil {
			log.Printf("failed to remove temp db: %v", rmErr)
		}
		return "", nil, err
	}
	defer rc.Close()

	const maxSleepDBSize = 256 * 1024 * 1024
	_, err = io.Copy(tempDB, io.LimitReader(rc, maxSleepDBSize))
	if err != nil {
		if closeErr := tempDB.Close(); closeErr != nil {
			log.Printf("failed to close temp db: %v", closeErr)
		}
		if rmErr := os.Remove(tempDB.Name()); rmErr != nil {
			log.Printf("failed to remove temp db: %v", rmErr)
		}
		return "", nil, err
	}
	if closeErr := tempDB.Close(); closeErr != nil {
		log.Printf("failed to close temp db on success: %v", closeErr)
	}

	path := tempDB.Name()
	cleanup := func() {
		if rmErr := os.Remove(path); rmErr != nil {
			log.Printf("failed to remove temp db during cleanup: %v", rmErr)
		}
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

// outdoorActivityTypes maps Mi Band type codes to human-readable activity names.
// Only confirmed outdoor cardio types are listed; all other types are skipped.
// Mapping was determined empirically from GPS spread, speed analysis, and user confirmation:
//   - 80 = Nordic Walking (confirmed by user: recent workouts are 80 + 54)
//   - 54 = Strength Training (confirmed by user, NOT imported here)
//   - 12 = Cycling (~10.2 km/h avg, GPS spread 3-4 km)
//   - 3  = Outdoor Walking (GPS-confirmed, ~3.6 km/h)
//   - 17 = Outdoor Walking legacy mode (used 2024-01 through 2024-08)
//   - 1  = Outdoor (rare, single recorded session)
var outdoorActivityTypes = map[int]string{
	1:  "walking",
	3:  "walking",
	12: "cycling",
	17: "walking",
	80: "nordic_walking",
}

// OutdoorWorkout is a parsed Mi Band outdoor workout from the backup database.
type OutdoorWorkout struct {
	SourceStartMs int64
	SourceEndMs   int64
	ActivityType  int
	ActivityName  string
	DurationSec   int
	DistanceM     float64
	Steps         int
	Calories      int
	HeartRateAvg  int
	SpO2Avg       int
	PauseMs       int64
	TzOffset      int
}

// GPSPoint is a single GPS measurement within a workout.
type GPSPoint struct {
	TsMs      int64
	Latitude  float64
	Longitude float64
	Altitude  float64
	IsPause   bool
}

// ParseOutdoorWorkouts reads outdoor workout records from an NXK backup SQLite database.
// It returns:
//   - workouts: ordered list of outdoor workouts (types 1, 3, 12, 17, 80) with distance > 0
//   - gpsTracks: map keyed by SourceStartMs → ordered list of GPS points for that workout
func ParseOutdoorWorkouts(dbPath string) ([]OutdoorWorkout, map[int64][]GPSPoint, error) {
	log.Printf("Parsing outdoor workouts from: %s", dbPath)

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, nil, err
	}
	defer db.Close()

	// Collect outdoor workout type IDs for the SQL IN clause.
	typeIDs := make([]interface{}, 0, len(outdoorActivityTypes))
	for k := range outdoorActivityTypes {
		typeIDs = append(typeIDs, k)
	}
	placeholders := ""
	for i := range typeIDs {
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
	}

	query := `
		SELECT startDateTime, endDateTime, type, distance, steps, calories,
		       heartAvg, spo2Avg, pause, tz
		FROM workout
		WHERE type IN (` + placeholders + `)
		  AND distance > 0
		ORDER BY startDateTime ASC`

	rows, err := db.Query(query, typeIDs...)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to query workout table: %w", err)
	}
	defer rows.Close()

	var workouts []OutdoorWorkout
	for rows.Next() {
		var startMs, endMs int64
		var actType int
		var distance float64
		var steps, calories, heartAvg, spo2Avg int
		var pauseMs int64
		var tz int

		if err := rows.Scan(&startMs, &endMs, &actType, &distance, &steps, &calories,
			&heartAvg, &spo2Avg, &pauseMs, &tz); err != nil {
			return nil, nil, fmt.Errorf("failed to scan workout row: %w", err)
		}

		// Compute duration from timestamps (the 'duration' column is unreliable).
		durationSec := int((endMs - startMs) / 1000)
		if durationSec < 0 {
			durationSec = 0
		}

		workouts = append(workouts, OutdoorWorkout{
			SourceStartMs: startMs,
			SourceEndMs:   endMs,
			ActivityType:  actType,
			ActivityName:  outdoorActivityTypes[actType],
			DurationSec:   durationSec,
			DistanceM:     distance,
			Steps:         steps,
			Calories:      calories,
			HeartRateAvg:  heartAvg,
			SpO2Avg:       spo2Avg,
			PauseMs:       pauseMs,
			TzOffset:      tz,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}

	log.Printf("Parsed %d outdoor workout records", len(workouts))

	if len(workouts) == 0 {
		return workouts, nil, nil
	}

	// Fetch GPS points for all outdoor workouts in one pass.
	// gps table has no foreign key to workout; we join by time range.
	// Build (startMs, endMs) pairs for a single range query.
	minStart := workouts[0].SourceStartMs
	maxEnd := workouts[len(workouts)-1].SourceEndMs
	for _, w := range workouts {
		if w.SourceStartMs < minStart {
			minStart = w.SourceStartMs
		}
		if w.SourceEndMs > maxEnd {
			maxEnd = w.SourceEndMs
		}
	}

	gpsRows, err := db.Query(`
		SELECT dateTime, latitude, longitude, altitude, pause
		FROM gps
		WHERE dateTime >= ? AND dateTime <= ?
		ORDER BY dateTime ASC`, minStart, maxEnd)
	if err != nil {
		// GPS is optional — log and continue without tracks.
		log.Printf("Warning: failed to query gps table: %v", err)
		return workouts, nil, nil
	}
	defer gpsRows.Close()

	// Build index: startMs → workout end for quick lookup.
	type workoutRange struct {
		startMs int64
		endMs   int64
	}
	ranges := make([]workoutRange, len(workouts))
	for i, w := range workouts {
		ranges[i] = workoutRange{w.SourceStartMs, w.SourceEndMs}
	}

	gpsTracks := make(map[int64][]GPSPoint)

	// Current workout index for range scan.
	wi := 0
	for gpsRows.Next() {
		var tsMs int64
		var lat, lon, alt float64
		var pauseVal int
		if err := gpsRows.Scan(&tsMs, &lat, &lon, &alt, &pauseVal); err != nil {
			log.Printf("Warning: failed to scan GPS row: %v", err)
			continue
		}

		// Advance workout index until we find the window that contains tsMs.
		for wi < len(ranges) && tsMs > ranges[wi].endMs {
			wi++
		}
		if wi >= len(ranges) {
			break
		}
		if tsMs < ranges[wi].startMs {
			continue // gap between workouts
		}

		key := ranges[wi].startMs
		gpsTracks[key] = append(gpsTracks[key], GPSPoint{
			TsMs:      tsMs,
			Latitude:  lat,
			Longitude: lon,
			Altitude:  alt,
			IsPause:   pauseVal != 0,
		})
	}

	log.Printf("Loaded GPS tracks for %d workouts", len(gpsTracks))
	return workouts, gpsTracks, nil
}
