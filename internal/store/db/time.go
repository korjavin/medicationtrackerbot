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
