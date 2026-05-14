package db

import (
	"database/sql"
	"time"
)

// UnixToTime converts INTEGER unix-seconds-UTC (as stored in dose-time
// columns) to a time.Time in UTC. See docs/architecture.md → "Time storage".
func UnixToTime(n int64) time.Time {
	return time.Unix(n, 0).UTC()
}

// TimeToUnix normalizes t to unix-seconds-UTC for writing into a dose-time
// column. The .UTC() also strips Go's monotonic-clock residue, which has
// previously leaked through t.String() into the DB.
func TimeToUnix(t time.Time) int64 {
	return t.UTC().Unix()
}

// NullableUnixToTimePtr converts an INTEGER nullable unix-seconds-UTC scan
// target to a *time.Time (nil when the column was NULL).
func NullableUnixToTimePtr(n sql.NullInt64) *time.Time {
	if !n.Valid {
		return nil
	}
	t := UnixToTime(n.Int64)
	return &t
}

// ParseSQLiteDateTime parses the textual representation SQLite stores when a
// time.Time is bound through database/sql. The same value comes back as either
// RFC 3339 (when the driver wrote it) or a space-separated DATETIME (when
// SQLite-side functions like MAX() materialise the column). Try the most
// common forms in priority order.
func ParseSQLiteDateTime(s string) (time.Time, error) {
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02 15:04:05.999999999 -0700 MST",
		"2006-01-02 15:04:05.999999999 -07:00",
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05",
	}
	var lastErr error
	for _, layout := range layouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		} else {
			lastErr = err
		}
	}
	return time.Time{}, lastErr
}
