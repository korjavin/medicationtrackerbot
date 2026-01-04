package store

import (
	"database/sql"
	"embed"
	"encoding/json"
	"fmt"
	"time"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite" // Pure Go SQLite driver
)

//go:embed migrations/*.sql
var embedMigrations embed.FS

type Store struct {
	db *sql.DB
}

type ScheduleConfig struct {
	Type  string   `json:"type"`            // "daily", "weekly", "as_needed"
	Days  []int    `json:"days,omitempty"`  // 0=Sunday, 1=Monday...
	Times []string `json:"times,omitempty"` // ["08:00", "20:00"]
}

type Medication struct {
	ID             int64      `json:"id"`
	Name           string     `json:"name"`
	Dosage         string     `json:"dosage"`
	Schedule       string     `json:"schedule"` // e.g. "09:00" or JSON
	Archived       bool       `json:"archived"`
	StartDate      *time.Time `json:"start_date"`
	EndDate        *time.Time `json:"end_date"`
	LastTakenAt    *time.Time `json:"last_taken_at"`
	CreatedAt      time.Time  `json:"created_at"`
	RxCUI          string     `json:"rxcui,omitempty"`
	NormalizedName string     `json:"normalized_name,omitempty"`
}

func (m *Medication) ValidSchedule() (*ScheduleConfig, error) {
	var s ScheduleConfig
	// Check if legacy "HH:MM"
	if len(m.Schedule) == 5 && m.Schedule[2] == ':' {
		s.Type = "daily"
		s.Times = []string{m.Schedule}
		return &s, nil
	}
	// Try JSON
	if err := json.Unmarshal([]byte(m.Schedule), &s); err != nil {
		return nil, err
	}
	return &s, nil
}

type IntakeLog struct {
	ID           int64      `json:"id"`
	MedicationID int64      `json:"medication_id"`
	UserID       int64      `json:"user_id"`
	ScheduledAt  time.Time  `json:"scheduled_at"`
	TakenAt      *time.Time `json:"taken_at,omitempty"`
	Status       string     `json:"status"` // PENDING, TAKEN, MISSED
}

func New(dbPath string) (*Store, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	// Set dialect
	if err := goose.SetDialect("sqlite3"); err != nil {
		return nil, err
	}

	// Set Base FS
	goose.SetBaseFS(embedMigrations)

	// Run migrations
	if err := goose.Up(db, "migrations"); err != nil {
		return nil, fmt.Errorf("failed to migrate db: %w", err)
	}

	return &Store{db: db}, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

// -- Medications CRUD --

func (s *Store) CreateMedication(name, dosage, schedule string, startDate, endDate *time.Time, rxcui, normalizedName string) (int64, error) {
	res, err := s.db.Exec("INSERT INTO medications (name, dosage, schedule, start_date, end_date, rxcui, normalized_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
		name, dosage, schedule, startDate, endDate, rxcui, normalizedName)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) ListMedications(showArchived bool) ([]Medication, error) {
	query := `
		SELECT 
			m.id, m.name, m.dosage, m.schedule, m.archived, m.start_date, m.end_date, m.created_at, m.rxcui, m.normalized_name,
			MAX(CASE WHEN l.status = 'TAKEN' THEN l.taken_at ELSE NULL END) as last_taken
		FROM medications m
		LEFT JOIN intake_log l ON m.id = l.medication_id
	`
	if !showArchived {
		query += " WHERE m.archived = 0"
	}
	query += " GROUP BY m.id ORDER BY m.name ASC"

	rows, err := s.db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	meds := []Medication{}
	for rows.Next() {
		var m Medication
		var lastTaken sql.NullString // Scan into string first
		// Handle nullable fields
		var rxcui, normalizedName sql.NullString

		if err := rows.Scan(&m.ID, &m.Name, &m.Dosage, &m.Schedule, &m.Archived, &m.StartDate, &m.EndDate, &m.CreatedAt, &rxcui, &normalizedName, &lastTaken); err != nil {
			return nil, err
		}

		if rxcui.Valid {
			m.RxCUI = rxcui.String
		}
		if normalizedName.Valid {
			m.NormalizedName = normalizedName.String
		}

		if lastTaken.Valid {
			// Helper to parse potential SQLite formats
			formats := []string{
				"2006-01-02 15:04:05.999999999-07:00", // Default driver format
				"2006-01-02 15:04:05",                 // Simple
				time.RFC3339,
			}
			for _, layout := range formats {
				if t, err := time.Parse(layout, lastTaken.String); err == nil {
					m.LastTakenAt = &t
					break
				}
			}
		}

		meds = append(meds, m)
	}
	return meds, nil
}

func (s *Store) GetMedication(id int64) (*Medication, error) {
	var m Medication
	var rxcui, normalizedName sql.NullString
	err := s.db.QueryRow("SELECT id, name, dosage, schedule, archived, start_date, end_date, created_at, rxcui, normalized_name FROM medications WHERE id = ?", id).Scan(
		&m.ID, &m.Name, &m.Dosage, &m.Schedule, &m.Archived, &m.StartDate, &m.EndDate, &m.CreatedAt, &rxcui, &normalizedName,
	)
	if err == sql.ErrNoRows {
		return nil, nil // Not found
	}
	if err != nil {
		return nil, err
	}

	if rxcui.Valid {
		m.RxCUI = rxcui.String
	}
	if normalizedName.Valid {
		m.NormalizedName = normalizedName.String
	}

	return &m, nil
}

func (s *Store) UpdateMedication(id int64, name, dosage, schedule string, archived bool, startDate, endDate *time.Time, rxcui, normalizedName string) error {
	_, err := s.db.Exec("UPDATE medications SET name = ?, dosage = ?, schedule = ?, archived = ?, start_date = ?, end_date = ?, rxcui = ?, normalized_name = ? WHERE id = ?",
		name, dosage, schedule, archived, startDate, endDate, rxcui, normalizedName, id)
	return err
}

func (s *Store) DeleteMedication(id int64) error {
	_, err := s.db.Exec("DELETE FROM medications WHERE id = ?", id)
	return err
}

// -- Intake Log --

func (s *Store) CreateIntake(medID, userID int64, scheduledAt time.Time) (int64, error) {
	res, err := s.db.Exec("INSERT INTO intake_log (medication_id, user_id, scheduled_at, status) VALUES (?, ?, ?, 'PENDING')",
		medID, userID, scheduledAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) ConfirmIntake(id int64, takenAt time.Time) error {
	_, err := s.db.Exec("UPDATE intake_log SET status = 'TAKEN', taken_at = ? WHERE id = ?", takenAt, id)
	return err
}

func (s *Store) GetPendingIntakes() ([]IntakeLog, error) {
	rows, err := s.db.Query("SELECT id, medication_id, user_id, scheduled_at, status FROM intake_log WHERE status = 'PENDING'")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []IntakeLog
	for rows.Next() {
		var l IntakeLog
		if err := rows.Scan(&l.ID, &l.MedicationID, &l.UserID, &l.ScheduledAt, &l.Status); err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	return logs, nil
}

func (s *Store) GetIntakeHistory(medID int, days int) ([]IntakeLog, error) {
	query := "SELECT id, medication_id, user_id, scheduled_at, taken_at, status FROM intake_log WHERE 1=1"
	args := []interface{}{}

	if medID > 0 {
		query += " AND medication_id = ?"
		args = append(args, medID)
	}

	if days > 0 {
		since := time.Now().Add(-time.Duration(days) * 24 * time.Hour)
		query += " AND scheduled_at >= ?"
		args = append(args, since)
	}

	query += " ORDER BY scheduled_at DESC LIMIT 100"

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []IntakeLog
	for rows.Next() {
		var l IntakeLog
		if err := rows.Scan(&l.ID, &l.MedicationID, &l.UserID, &l.ScheduledAt, &l.TakenAt, &l.Status); err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	return logs, nil
}

func (s *Store) GetIntakeBySchedule(medID int64, scheduledAt time.Time) (*IntakeLog, error) {
	// We want to find a log that matches the medication and the exact scheduled time (or within a small window if we used drift, but here we construct exact time)
	// Since we construct scheduledAt based on "Today + HH:MM", it should be exact.

	// SQLite datetime comparison needs format match.
	// Go's time.Time formats to ISO8601/RFC3339 in params usually.
	// Let's rely on driver.

	var l IntakeLog
	err := s.db.QueryRow("SELECT id, medication_id, user_id, scheduled_at, taken_at, status FROM intake_log WHERE medication_id = ? AND scheduled_at = ?", medID, scheduledAt).Scan(
		&l.ID, &l.MedicationID, &l.UserID, &l.ScheduledAt, &l.TakenAt, &l.Status,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &l, nil
}

func (s *Store) ConfirmIntakesBySchedule(userID int64, scheduledAt time.Time, takenAt time.Time) error {
	_, err := s.db.Exec("UPDATE intake_log SET status = 'TAKEN', taken_at = ? WHERE user_id = ? AND scheduled_at = ? AND status = 'PENDING'",
		takenAt, userID, scheduledAt)
	return err
}
