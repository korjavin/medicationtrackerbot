package store

import (
	"database/sql"
	"embed"
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

type Medication struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	Dosage    string    `json:"dosage"`
	Schedule  string    `json:"schedule"` // e.g. "09:00" or JSON
	Archived  bool      `json:"archived"`
	CreatedAt time.Time `json:"created_at"`
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

func (s *Store) CreateMedication(name, dosage, schedule string) (int64, error) {
	res, err := s.db.Exec("INSERT INTO medications (name, dosage, schedule) VALUES (?, ?, ?)", name, dosage, schedule)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) ListMedications(showArchived bool) ([]Medication, error) {
	query := "SELECT id, name, dosage, schedule, archived, created_at FROM medications"
	if !showArchived {
		query += " WHERE archived = 0"
	}
	query += " ORDER BY created_at DESC"

	rows, err := s.db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var meds []Medication
	for rows.Next() {
		var m Medication
		if err := rows.Scan(&m.ID, &m.Name, &m.Dosage, &m.Schedule, &m.Archived, &m.CreatedAt); err != nil {
			return nil, err
		}
		meds = append(meds, m)
	}
	return meds, nil
}

func (s *Store) GetMedication(id int64) (*Medication, error) {
	var m Medication
	err := s.db.QueryRow("SELECT id, name, dosage, schedule, archived, created_at FROM medications WHERE id = ?", id).Scan(
		&m.ID, &m.Name, &m.Dosage, &m.Schedule, &m.Archived, &m.CreatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil // Not found
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *Store) UpdateMedication(id int64, name, dosage, schedule string, archived bool) error {
	_, err := s.db.Exec("UPDATE medications SET name = ?, dosage = ?, schedule = ?, archived = ? WHERE id = ?",
		name, dosage, schedule, archived, id)
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

func (s *Store) GetIntakeHistory() ([]IntakeLog, error) {
	rows, err := s.db.Query("SELECT id, medication_id, user_id, scheduled_at, taken_at, status FROM intake_log ORDER BY scheduled_at DESC LIMIT 100")
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
