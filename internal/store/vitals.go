package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// -- Vitals Models --

// VitalsHeartLog represents a single heart rate measurement
type VitalsHeartLog struct {
	UserID   int64     `json:"user_id"`
	DateTime time.Time `json:"date_time"`
	TzOffset int       `json:"tz_offset"`
	Value    int       `json:"value"`
	Type     int       `json:"type"`
}

// VitalsSpO2Log represents a single blood oxygen measurement
type VitalsSpO2Log struct {
	UserID   int64     `json:"user_id"`
	DateTime time.Time `json:"date_time"`
	TzOffset int       `json:"tz_offset"`
	Value    int       `json:"value"`
	Type     int       `json:"type"`
}

// VitalsStressLog represents a single stress measurement
type VitalsStressLog struct {
	UserID   int64     `json:"user_id"`
	DateTime time.Time `json:"date_time"`
	TzOffset int       `json:"tz_offset"`
	Value    int       `json:"value"`
	Type     int       `json:"type"`
	Info     string    `json:"info,omitempty"`
}

// -- Store Methods --

// ImportVitals bulk inserts time-series vitals data, ignoring duplicates
func (s *Store) ImportVitals(ctx context.Context, userID int64, heartLogs []VitalsHeartLog, spo2Logs []VitalsSpO2Log, stressLogs []VitalsStressLog) (int, int, error) {
	// Start transaction
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }() // intentional: no-op if Commit succeeded

	totalImported := 0
	totalSkipped := 0

	// Heart logs
	heartImported, heartSkipped, err := importHeartLogs(tx, userID, heartLogs)
	if err != nil {
		return 0, 0, err
	}
	totalImported += heartImported
	totalSkipped += heartSkipped

	// SpO2 logs
	spo2Imported, spo2Skipped, err := importSpO2Logs(tx, userID, spo2Logs)
	if err != nil {
		return 0, 0, err
	}
	totalImported += spo2Imported
	totalSkipped += spo2Skipped

	// Stress logs
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

	// Use standard chunked bulk insert
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

// GetVitalsHeart retrieves heart rate logs for a user within a timestamp range
func (s *Store) GetVitalsHeart(ctx context.Context, userID int64, start, end time.Time) ([]VitalsHeartLog, error) {
	query := "SELECT user_id, date_time, tz_offset, value, type FROM vitals_heart WHERE user_id = ? AND date_time >= ? AND date_time <= ? ORDER BY date_time ASC"
	rows, err := s.db.QueryContext(ctx, query, userID, start.UnixMilli(), end.UnixMilli())
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

// GetVitalsSpO2 retrieves SpO2 logs for a user within a timestamp range
func (s *Store) GetVitalsSpO2(ctx context.Context, userID int64, start, end time.Time) ([]VitalsSpO2Log, error) {
	query := "SELECT user_id, date_time, tz_offset, value, type FROM vitals_spo2 WHERE user_id = ? AND date_time >= ? AND date_time <= ? ORDER BY date_time ASC"
	rows, err := s.db.QueryContext(ctx, query, userID, start.UnixMilli(), end.UnixMilli())
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

// GetVitalsStress retrieves stress logs for a user within a timestamp range
func (s *Store) GetVitalsStress(ctx context.Context, userID int64, start, end time.Time) ([]VitalsStressLog, error) {
	query := "SELECT user_id, date_time, tz_offset, value, type, info FROM vitals_stress WHERE user_id = ? AND date_time >= ? AND date_time <= ? ORDER BY date_time ASC"
	rows, err := s.db.QueryContext(ctx, query, userID, start.UnixMilli(), end.UnixMilli())
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
