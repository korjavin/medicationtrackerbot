package store

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite" // Pure Go SQLite driver
)

//go:embed migrations/*.sql
var embedMigrations embed.FS

type Store struct {
	db *sql.DB
}

var nowFunc = time.Now

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
	Supplement     bool       `json:"supplement"`
	StartDate      *time.Time `json:"start_date"`
	EndDate        *time.Time `json:"end_date"`
	LastTakenAt    *time.Time `json:"last_taken_at"`
	CreatedAt      time.Time  `json:"created_at"`
	RxCUI          string     `json:"rxcui,omitempty"`
	NormalizedName string     `json:"normalized_name,omitempty"`
	InventoryCount *int       `json:"inventory_count,omitempty"` // NULL = not tracking
	TZShiftPolicy  string     `json:"tz_shift_policy"`           // flexible / medium / strict
}

type Restock struct {
	ID           int64     `json:"id"`
	MedicationID int64     `json:"medication_id"`
	Quantity     int       `json:"quantity"`
	Note         string    `json:"note,omitempty"`
	RestockedAt  time.Time `json:"restocked_at"`
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
	Status       string     `json:"status"` // PENDING, TAKEN, SKIPPED, MISSED
	SnoozedUntil *time.Time `json:"snoozed_until,omitempty"`
}

type IntakeWithMedication struct {
	IntakeLog
	MedicationName   string `json:"medication_name"`
	MedicationDosage string `json:"medication_dosage"`
}

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

type DayStat struct {
	ID        int64     `json:"id"`
	UserID    int64     `json:"user_id"`
	Day       string    `json:"day"`
	Steps     int       `json:"steps"`
	Calories  int       `json:"calories"`
	Distance  int       `json:"distance"`
	CreatedAt time.Time `json:"created_at"`
}

type FoodTargets struct {
	Calories int `json:"calories"`
	Carbs    int `json:"carbs"`
	Protein  int `json:"protein"`
	Fat      int `json:"fat"`
}

type DiaryNote struct {
	ID        int64     `json:"id"`
	UserID    int64     `json:"-"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"created_at"`
}

// CalculateBPCategory returns the ISH 2020 classification.
// Deprecated: prefer domain.CalculateBPCategory for new code.
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

func New(dbPath string) (*Store, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	// Enable WAL mode for Litestream compatibility
	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		return nil, fmt.Errorf("failed to enable WAL mode: %w", err)
	}

	// Set busy_timeout so concurrent writers retry instead of immediately
	// returning SQLITE_BUSY ("database is locked"). 5 seconds gives enough
	// time for the scheduler's simultaneous reminder writes to succeed.
	if _, err := db.Exec("PRAGMA busy_timeout = 5000"); err != nil {
		return nil, fmt.Errorf("failed to set busy_timeout: %w", err)
	}

	// Limit connection pool to 1 to avoid multiple connections racing each
	// other for the WAL write lock in concurrent-write scenarios.
	db.SetMaxOpenConns(1)

	// Set dialect
	if err := goose.SetDialect("sqlite3"); err != nil {
		return nil, err
	}

	// Set Base FS
	goose.SetBaseFS(embedMigrations)
	goose.SetLogger(goose.NopLogger())

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

func (s *Store) CreateMedication(name, dosage, schedule string, startDate, endDate *time.Time, rxcui, normalizedName string, tzShiftPolicy string) (int64, error) {
	if tzShiftPolicy == "" {
		tzShiftPolicy = "flexible"
	}
	res, err := s.db.Exec("INSERT INTO medications (name, dosage, schedule, start_date, end_date, rxcui, normalized_name, tz_shift_policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		name, dosage, schedule, startDate, endDate, rxcui, normalizedName, tzShiftPolicy)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) ListMedications(showArchived bool) ([]Medication, error) {
	query := `
		SELECT
			m.id, m.name, m.dosage, m.schedule, m.archived, m.supplement, m.start_date, m.end_date, m.created_at, m.rxcui, m.normalized_name, m.inventory_count, m.tz_shift_policy,
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
		var inventoryCount sql.NullInt64

		if err := rows.Scan(&m.ID, &m.Name, &m.Dosage, &m.Schedule, &m.Archived, &m.Supplement, &m.StartDate, &m.EndDate, &m.CreatedAt, &rxcui, &normalizedName, &inventoryCount, &m.TZShiftPolicy, &lastTaken); err != nil {
			return nil, err
		}

		if rxcui.Valid {
			m.RxCUI = rxcui.String
		}
		if normalizedName.Valid {
			m.NormalizedName = normalizedName.String
		}
		if inventoryCount.Valid {
			ic := int(inventoryCount.Int64)
			m.InventoryCount = &ic
		}

		if lastTaken.Valid {
			raw := lastTaken.String
			// Strip Go's monotonic clock suffix if present (e.g. " ... m=+123.456")
			if idx := strings.Index(raw, " m="); idx != -1 {
				raw = raw[:idx]
			}

			// Helper to parse potential SQLite formats
			formats := []string{
				"2006-01-02 15:04:05.999999999-07:00",     // Default driver format
				"2006-01-02 15:04:05.999999999 -0700 MST", // Go String() format
				"2006-01-02 15:04:05 -0700 MST",           // Go String() format (no nanos)
				"2006-01-02 15:04:05.999999999",           // No TZ
				"2006-01-02 15:04:05",                     // Simple
				time.RFC3339,
				time.RFC3339Nano,
			}
			for _, layout := range formats {
				if t, err := time.Parse(layout, raw); err == nil {
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
	var inventoryCount sql.NullInt64
	err := s.db.QueryRow("SELECT id, name, dosage, schedule, archived, supplement, start_date, end_date, created_at, rxcui, normalized_name, inventory_count, tz_shift_policy FROM medications WHERE id = ?", id).Scan(
		&m.ID, &m.Name, &m.Dosage, &m.Schedule, &m.Archived, &m.Supplement, &m.StartDate, &m.EndDate, &m.CreatedAt, &rxcui, &normalizedName, &inventoryCount, &m.TZShiftPolicy,
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
	if inventoryCount.Valid {
		ic := int(inventoryCount.Int64)
		m.InventoryCount = &ic
	}

	return &m, nil
}

func (s *Store) UpdateMedication(id int64, name, dosage, schedule string, archived bool, startDate, endDate *time.Time, rxcui, normalizedName string, inventoryCount *int, tzShiftPolicy string) error {
	if tzShiftPolicy == "" {
		tzShiftPolicy = "flexible"
	}
	_, err := s.db.Exec("UPDATE medications SET name = ?, dosage = ?, schedule = ?, archived = ?, start_date = ?, end_date = ?, rxcui = ?, normalized_name = ?, inventory_count = ?, tz_shift_policy = ? WHERE id = ?",
		name, dosage, schedule, archived, startDate, endDate, rxcui, normalizedName, inventoryCount, tzShiftPolicy, id)
	return err
}

func (s *Store) DeleteMedication(id int64) error {
	_, err := s.db.Exec("DELETE FROM medications WHERE id = ?", id)
	return err
}

func (s *Store) CanDeleteMedication(id int64) (bool, error) {
	var count int
	err := s.db.QueryRow("SELECT COUNT(*) FROM intake_log WHERE medication_id = ?", id).Scan(&count)
	if err != nil {
		return false, err
	}
	return count == 0, nil
}

func (s *Store) SetMedicationSupplement(id int64, supplement bool) error {
	_, err := s.db.Exec("UPDATE medications SET supplement = ? WHERE id = ?", supplement, id)
	return err
}

func (s *Store) UpdateMedicationCreatedAt(id int64, createdAt time.Time) error {
	_, err := s.db.Exec("UPDATE medications SET created_at = ? WHERE id = ?", createdAt, id)
	if err != nil {
		return err
	}
	return nil
}

// -- Inventory Functions --

// DecrementInventory reduces the inventory count by the given quantity
// Only decrements if inventory is being tracked (not NULL)
func (s *Store) DecrementInventory(medID int64, qty int) error {
	_, err := s.db.Exec("UPDATE medications SET inventory_count = inventory_count - ? WHERE id = ? AND inventory_count IS NOT NULL", qty, medID)
	return err
}

// IncrementInventory increases the inventory count by the given quantity
// Only increments if inventory is being tracked (not NULL)
func (s *Store) IncrementInventory(medID int64, qty int) error {
	_, err := s.db.Exec("UPDATE medications SET inventory_count = inventory_count + ? WHERE id = ? AND inventory_count IS NOT NULL", qty, medID)
	return err
}

// SetInventory sets the inventory count for a medication (nil to disable tracking)
func (s *Store) SetInventory(medID int64, count *int) error {
	_, err := s.db.Exec("UPDATE medications SET inventory_count = ? WHERE id = ?", count, medID)
	return err
}

// AddRestock adds inventory and logs the restock event
func (s *Store) AddRestock(medID int64, qty int, note string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	// Update inventory count (initialize to qty if NULL)
	_, err = tx.Exec(`
		UPDATE medications 
		SET inventory_count = COALESCE(inventory_count, 0) + ? 
		WHERE id = ?`, qty, medID)
	if err != nil {
		return err
	}

	// Log restock event
	_, err = tx.Exec("INSERT INTO medication_restocks (medication_id, quantity, note) VALUES (?, ?, ?)", medID, qty, note)
	if err != nil {
		return err
	}

	return tx.Commit()
}

// GetRestockHistory returns restock events for a medication
func (s *Store) GetRestockHistory(medID int64) ([]Restock, error) {
	rows, err := s.db.Query("SELECT id, medication_id, quantity, note, restocked_at FROM medication_restocks WHERE medication_id = ? ORDER BY restocked_at DESC", medID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var restocks []Restock
	for rows.Next() {
		var r Restock
		var note sql.NullString
		if err := rows.Scan(&r.ID, &r.MedicationID, &r.Quantity, &note, &r.RestockedAt); err != nil {
			return nil, err
		}
		if note.Valid {
			r.Note = note.String
		}
		restocks = append(restocks, r)
	}
	return restocks, nil
}

// GetMedicationsLowOnStock returns medications with inventory tracking that are low on stock
// daysThreshold: warn if stock lasts fewer than this many days
func (s *Store) GetMedicationsLowOnStock(daysThreshold int) ([]Medication, error) {
	// First get all active medications with inventory tracking
	meds, err := s.ListMedications(false)
	if err != nil {
		return nil, err
	}

	var lowStock []Medication
	for _, m := range meds {
		if m.InventoryCount == nil {
			continue // Not tracking inventory
		}

		// Calculate daily usage from schedule
		dailyUsage := s.calculateDailyUsage(&m)
		if dailyUsage == 0 {
			continue // As-needed or invalid schedule
		}

		// Check if medication has enough stock
		if s.hasEnoughStock(&m, dailyUsage, daysThreshold) {
			continue
		}

		lowStock = append(lowStock, m)
	}

	return lowStock, nil
}

// hasEnoughStock returns true if medication has enough stock
// If medication has end date: check if stock lasts until end date
// If no end date: check if stock lasts at least daysThreshold days
func (s *Store) hasEnoughStock(m *Medication, dailyUsage float64, daysThreshold int) bool {
	if m.InventoryCount == nil {
		return true // Not tracking
	}

	daysOfStock := float64(*m.InventoryCount) / dailyUsage

	// If medication has an end date, calculate how many days until it ends
	if m.EndDate != nil {
		daysUntilEnd := time.Until(*m.EndDate).Hours() / 24
		if daysUntilEnd <= 0 {
			return true // Already ended, no warning needed
		}
		// Enough stock if we have more days than needed until end
		return daysOfStock >= daysUntilEnd
	}

	// No end date: use the threshold
	return daysOfStock >= float64(daysThreshold)
}

// calculateDailyUsage returns the average daily intakes for a medication
func (s *Store) calculateDailyUsage(m *Medication) float64 {
	cfg, err := m.ValidSchedule()
	if err != nil {
		return 0
	}

	if cfg.Type == "as_needed" {
		return 0 // Can't calculate for as-needed
	}

	timesPerDay := float64(len(cfg.Times))

	if cfg.Type == "daily" {
		return timesPerDay
	}

	if cfg.Type == "weekly" {
		// Days per week that the medication is taken
		daysPerWeek := float64(len(cfg.Days))
		return (daysPerWeek / 7.0) * timesPerDay
	}

	return 0
}

// GetDaysOfStockRemaining calculates how many days of stock remain for a medication
func (s *Store) GetDaysOfStockRemaining(m *Medication) *float64 {
	if m.InventoryCount == nil {
		return nil
	}

	dailyUsage := s.calculateDailyUsage(m)
	if dailyUsage == 0 {
		return nil
	}

	days := float64(*m.InventoryCount) / dailyUsage
	return &days
}

// IsLowOnStock checks if a medication is low on stock considering its end date
func (s *Store) IsLowOnStock(m *Medication, daysThreshold int) bool {
	if m.InventoryCount == nil {
		return false
	}

	dailyUsage := s.calculateDailyUsage(m)
	if dailyUsage == 0 {
		return false
	}

	return !s.hasEnoughStock(m, dailyUsage, daysThreshold)
}

// -- Intake Log --

func (s *Store) CreateIntake(medID, userID int64, scheduledAt time.Time) (int64, error) {
	scheduledAt = scheduledAt.Truncate(0)
	res, err := s.db.Exec("INSERT INTO intake_log (medication_id, user_id, scheduled_at, status) VALUES (?, ?, ?, 'PENDING')",
		medID, userID, scheduledAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) CreateManualIntake(medID, userID int64, takenAt time.Time) (int64, error) {
	takenAt = takenAt.Truncate(0)
	// For manual intake, scheduled_at = taken_at
	res, err := s.db.Exec("INSERT INTO intake_log (medication_id, user_id, scheduled_at, taken_at, status) VALUES (?, ?, ?, ?, 'TAKEN')",
		medID, userID, takenAt, takenAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) ConfirmIntake(id int64, takenAt time.Time) error {
	takenAt = takenAt.Truncate(0)
	res, err := s.db.Exec("UPDATE intake_log SET status = 'TAKEN', taken_at = ? WHERE id = ? AND status = 'PENDING'", takenAt, id)
	if err != nil {
		return err
	}
	rowsAffected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if rowsAffected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *Store) SkipIntake(id int64) error {
	res, err := s.db.Exec("UPDATE intake_log SET status = 'SKIPPED', taken_at = NULL WHERE id = ? AND status = 'PENDING'", id)
	if err != nil {
		return err
	}
	rowsAffected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if rowsAffected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *Store) UpdateIntake(id int64, takenAt time.Time, status string) error {
	takenAt = takenAt.Truncate(0)
	var takenAtVal interface{}
	if status == "TAKEN" {
		takenAtVal = takenAt
	} else {
		takenAtVal = nil
	}
	_, err := s.db.Exec("UPDATE intake_log SET status = ?, taken_at = ? WHERE id = ?", status, takenAtVal, id)
	return err
}

func (s *Store) SnoozeIntake(id int64, snoozeUntil time.Time) error {
	res, err := s.db.Exec("UPDATE intake_log SET snoozed_until = ? WHERE id = ? AND status = 'PENDING'", snoozeUntil, id)
	if err != nil {
		return err
	}
	rowsAffected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if rowsAffected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *Store) GetPendingIntakes() ([]IntakeLog, error) {
	rows, err := s.db.Query("SELECT id, medication_id, user_id, scheduled_at, status, snoozed_until FROM intake_log WHERE status = 'PENDING'")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	logs := []IntakeLog{}
	for rows.Next() {
		var l IntakeLog
		if err := rows.Scan(&l.ID, &l.MedicationID, &l.UserID, &l.ScheduledAt, &l.Status, &l.SnoozedUntil); err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	return logs, nil
}

func (s *Store) GetTakenIntakesBySchedule(userID int64, scheduledAt time.Time) ([]IntakeLog, error) {
	rows, err := s.db.Query("SELECT id, medication_id, user_id, scheduled_at, status, snoozed_until FROM intake_log WHERE user_id = ? AND scheduled_at = ? AND status = 'TAKEN'", userID, scheduledAt)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	logs := []IntakeLog{}
	for rows.Next() {
		var l IntakeLog
		if err := rows.Scan(&l.ID, &l.MedicationID, &l.UserID, &l.ScheduledAt, &l.Status, &l.SnoozedUntil); err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	return logs, nil
}

func (s *Store) GetIntakeHistory(medID int, days int) ([]IntakeLog, error) {
	query := "SELECT id, medication_id, user_id, scheduled_at, taken_at, status, snoozed_until FROM intake_log WHERE 1=1"
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

	logs := []IntakeLog{}
	for rows.Next() {
		var l IntakeLog
		if err := rows.Scan(&l.ID, &l.MedicationID, &l.UserID, &l.ScheduledAt, &l.TakenAt, &l.Status, &l.SnoozedUntil); err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	return logs, nil
}

func (s *Store) GetIntake(id int64) (*IntakeLog, error) {
	var l IntakeLog
	err := s.db.QueryRow("SELECT id, medication_id, user_id, scheduled_at, taken_at, status, snoozed_until FROM intake_log WHERE id = ?", id).Scan(
		&l.ID, &l.MedicationID, &l.UserID, &l.ScheduledAt, &l.TakenAt, &l.Status, &l.SnoozedUntil,
	)
	if err == sql.ErrNoRows {
		return nil, nil // Not found
	}
	if err != nil {
		return nil, err
	}
	return &l, nil
}

func (s *Store) GetIntakeBySchedule(medID int64, scheduledAt time.Time) (*IntakeLog, error) {
	scheduledAt = scheduledAt.Truncate(0)
	// We want to find a log that matches the medication and the exact scheduled time (or within a small window if we used drift, but here we construct exact time)
	// Since we construct scheduledAt based on "Today + HH:MM", it should be exact.

	// SQLite datetime comparison needs format match.
	// Go's time.Time formats to ISO8601/RFC3339 in params usually.
	// Let's rely on driver.

	var l IntakeLog
	err := s.db.QueryRow("SELECT id, medication_id, user_id, scheduled_at, taken_at, status, snoozed_until FROM intake_log WHERE medication_id = ? AND scheduled_at = ?", medID, scheduledAt).Scan(
		&l.ID, &l.MedicationID, &l.UserID, &l.ScheduledAt, &l.TakenAt, &l.Status, &l.SnoozedUntil,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &l, nil
}

func (s *Store) ConfirmIntakesBySchedule(userID int64, scheduledAt time.Time, takenAt time.Time) ([]int64, error) {
	scheduledAt = scheduledAt.Truncate(0)
	takenAt = takenAt.Truncate(0)
	// Only confirm intakes for medications that are NOT archived (archived = 0)
	// Use RETURNING clause to get the IDs that were actually updated, avoiding race conditions
	// with concurrent calls that might use the same takenAt timestamp.
	rows, err := s.db.Query(`
		UPDATE intake_log
		SET status = 'TAKEN', taken_at = ?
		WHERE user_id = ?
		  AND scheduled_at = ?
		  AND status = 'PENDING'
		  AND medication_id IN (SELECT id FROM medications WHERE archived = 0)
		RETURNING id
	`, takenAt, userID, scheduledAt)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return ids, nil
}

func (s *Store) AddIntakeReminder(intakeID int64, messageID int) error {
	_, err := s.db.Exec("INSERT INTO intake_reminders (intake_id, message_id) VALUES (?, ?)", intakeID, messageID)
	return err
}

func (s *Store) GetIntakeReminders(intakeID int64) ([]int, error) {
	rows, err := s.db.Query("SELECT message_id FROM intake_reminders WHERE intake_id = ?", intakeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []int
	for rows.Next() {
		var id int
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, nil
}

func (s *Store) GetPendingIntakesBySchedule(userID int64, scheduledAt time.Time) ([]IntakeLog, error) {
	rows, err := s.db.Query("SELECT id, medication_id, user_id, scheduled_at, status, snoozed_until FROM intake_log WHERE user_id = ? AND scheduled_at = ? AND status = 'PENDING'", userID, scheduledAt)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var logs []IntakeLog
	for rows.Next() {
		var l IntakeLog
		if err := rows.Scan(&l.ID, &l.MedicationID, &l.UserID, &l.ScheduledAt, &l.Status, &l.SnoozedUntil); err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	return logs, nil
}

func (s *Store) GetPendingIntakesForMedication(medID int64) ([]IntakeLog, error) {
	rows, err := s.db.Query("SELECT id, medication_id, user_id, scheduled_at, status, snoozed_until FROM intake_log WHERE medication_id = ? AND status = 'PENDING'", medID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var logs []IntakeLog
	for rows.Next() {
		var l IntakeLog
		if err := rows.Scan(&l.ID, &l.MedicationID, &l.UserID, &l.ScheduledAt, &l.Status, &l.SnoozedUntil); err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	return logs, nil
}

func (s *Store) DeleteIntake(id int64) error {
	_, err := s.db.Exec("DELETE FROM intake_log WHERE id = ?", id)
	return err
}

// -- Settings --

func (s *Store) GetLastDownload() (time.Time, error) {
	var lastDownload time.Time
	err := s.db.QueryRow("SELECT last_download FROM settings WHERE id = 1").Scan(&lastDownload)
	if err == sql.ErrNoRows {
		return time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, err
	}
	return lastDownload, nil
}

func (s *Store) UpdateLastDownload(t time.Time) error {
	_, err := s.db.Exec("UPDATE settings SET last_download = ? WHERE id = 1", t)
	return err
}

// Weight Goal Settings
type WeightGoal struct {
	Goal     *float64   `json:"goal,omitempty"`
	GoalDate *time.Time `json:"goal_date,omitempty"`
}

func (s *Store) GetWeightGoal() (*WeightGoal, error) {
	var goal sql.NullFloat64
	var goalDateStr sql.NullString

	err := s.db.QueryRow("SELECT weight_goal, weight_goal_date FROM settings WHERE id = 1").Scan(&goal, &goalDateStr)
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

func (s *Store) SetWeightGoal(weight float64, targetDate time.Time) error {
	dateStr := targetDate.Format("2006-01-02")
	_, err := s.db.Exec("UPDATE settings SET weight_goal = ?, weight_goal_date = ? WHERE id = 1", weight, dateStr)
	return err
}

// BP Goal Settings
type BPGoal struct {
	TargetSystolic  *int `json:"target_systolic,omitempty"`
	TargetDiastolic *int `json:"target_diastolic,omitempty"`
}

func (s *Store) GetBPGoal() (*BPGoal, error) {
	var systolic, diastolic sql.NullInt64

	err := s.db.QueryRow("SELECT bp_target_systolic, bp_target_diastolic FROM settings WHERE id = 1").Scan(&systolic, &diastolic)
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

func (s *Store) SetBPGoal(targetSystolic, targetDiastolic int) error {
	_, err := s.db.Exec("UPDATE settings SET bp_target_systolic = ?, bp_target_diastolic = ? WHERE id = 1", targetSystolic, targetDiastolic)
	return err
}

// -- Downloads --

func (s *Store) GetIntakesSince(since time.Time) ([]IntakeWithMedication, error) {
	query := `
		SELECT
			il.id, il.medication_id, il.user_id, il.scheduled_at, il.taken_at, il.status, il.snoozed_until,
			m.name AS medication_name, m.dosage AS medication_dosage
		FROM intake_log il
		JOIN medications m ON il.medication_id = m.id
		WHERE il.scheduled_at >= ?
		ORDER BY il.scheduled_at DESC
	`
	rows, err := s.db.Query(query, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []IntakeWithMedication
	for rows.Next() {
		var l IntakeWithMedication
		if err := rows.Scan(&l.ID, &l.MedicationID, &l.UserID, &l.ScheduledAt, &l.TakenAt, &l.Status, &l.SnoozedUntil, &l.MedicationName, &l.MedicationDosage); err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	return logs, nil
}

// -- Blood Pressure --

func (s *Store) CreateBloodPressureReading(ctx context.Context, bp *BloodPressure) (int64, error) {
	if bp.Category == "" && !bp.IgnoreCalc {
		bp.Category = CalculateBPCategory(bp.Systolic, bp.Diastolic)
	}

	res, err := s.db.ExecContext(ctx,
		"INSERT INTO blood_pressure_readings (user_id, measured_at, systolic, diastolic, pulse, site, position, category, ignore_calc, notes, tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		bp.UserID, bp.MeasuredAt, bp.Systolic, bp.Diastolic, bp.Pulse, bp.Site, bp.Position, bp.Category, bp.IgnoreCalc, bp.Notes, bp.Tag)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) GetBloodPressureReadings(ctx context.Context, userID int64, since time.Time) ([]BloodPressure, error) {
	query := "SELECT id, user_id, measured_at, systolic, diastolic, pulse, site, position, category, ignore_calc, notes, tag FROM blood_pressure_readings WHERE user_id = ?"
	args := []interface{}{userID}

	if !since.IsZero() {
		query += " AND measured_at >= ?"
		args = append(args, since)
	}

	query += " ORDER BY measured_at DESC"

	rows, err := s.db.QueryContext(ctx, query, args...)
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

func (s *Store) DeleteBloodPressureReading(ctx context.Context, id, userID int64) error {
	res, err := s.db.ExecContext(ctx, "DELETE FROM blood_pressure_readings WHERE id = ? AND user_id = ?", id, userID)
	if err != nil {
		return err
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *Store) ImportBloodPressureReadings(ctx context.Context, userID int64, readings []BloodPressure) error {
	tx, err := s.db.BeginTx(ctx, nil)
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

// BPPeriodStats represents daily-weighted BP stats for a specific time period
type BPPeriodStats struct {
	Systolic  int `json:"systolic"`
	Diastolic int `json:"diastolic"`
	Days      int `json:"days"`     // Number of days with readings
	Readings  int `json:"readings"` // Total number of readings
}

// BPStats contains daily time-weighted blood pressure statistics for multiple time periods
type BPStats struct {
	Stats14 *BPPeriodStats `json:"stats_14,omitempty"`
	Stats30 *BPPeriodStats `json:"stats_30,omitempty"`
	Stats60 *BPPeriodStats `json:"stats_60,omitempty"`
}

// GetBPDailyWeightedStats calculates daily time-weighted blood pressure averages.
// It weights each reading by the time until the next reading, computes a per-day
// time-weighted average, then averages daily averages across the period.
func (s *Store) GetBPDailyWeightedStats(ctx context.Context, userID int64) (*BPStats, error) {
	now := nowFunc().UTC()
	maxDays := 60
	windowStart := truncateToDayUTC(now.AddDate(0, 0, -maxDays))

	var readings []BloodPressure
	{
		rows, err := s.db.QueryContext(ctx,
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

	// For each day, weight readings only within that day.
	for i := 0; i < len(readings); i++ {
		if i+1 < len(readings) && readings[i+1].MeasuredAt.Equal(readings[i].MeasuredAt) {
			continue
		}
		start := readings[i].MeasuredAt.UTC()
		if start.After(now) {
			continue
		}
		dayStart := truncateToDayUTC(start)
		dayEnd := dayStart.Add(24 * time.Hour)

		end := dayEnd
		if i+1 < len(readings) {
			next := readings[i+1].MeasuredAt.UTC()
			if truncateToDayUTC(next).Equal(dayStart) {
				end = next
			}
		}
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

	buildStats := func(periodDays int) *BPPeriodStats {
		periodStart := truncateToDayUTC(now.AddDate(0, 0, -periodDays))
		var sumSys, sumDia float64
		var days int

		for day, agg := range dayAggs {
			if day.Before(periodStart) || day.After(truncateToDayUTC(now)) {
				continue
			}
			if agg.durSec <= 0 {
				continue
			}
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
			measured := bp.MeasuredAt.UTC()
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

func truncateToDayUTC(t time.Time) time.Time {
	utc := t.UTC()
	return time.Date(utc.Year(), utc.Month(), utc.Day(), 0, 0, 0, 0, time.UTC)
}

// -- Weight Tracking --

func (s *Store) CreateWeightLog(ctx context.Context, w *WeightLog) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		"INSERT INTO weight_logs (user_id, measured_at, weight, weight_trend, body_fat, body_fat_trend, muscle_mass, muscle_mass_trend, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		w.UserID, w.MeasuredAt, w.Weight, w.WeightTrend, w.BodyFat, w.BodyFatTrend, w.MuscleMass, w.MuscleMassTrend, w.Notes)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) GetWeightLogs(ctx context.Context, userID int64, since time.Time) ([]WeightLog, error) {
	query := "SELECT id, user_id, measured_at, weight, weight_trend, body_fat, body_fat_trend, muscle_mass, muscle_mass_trend, notes FROM weight_logs WHERE user_id = ?"
	args := []interface{}{userID}

	if !since.IsZero() {
		query += " AND measured_at >= ?"
		args = append(args, since)
	}

	query += " ORDER BY measured_at DESC"

	rows, err := s.db.QueryContext(ctx, query, args...)
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

func (s *Store) DeleteWeightLog(ctx context.Context, id, userID int64) error {
	res, err := s.db.ExecContext(ctx, "DELETE FROM weight_logs WHERE id = ? AND user_id = ?", id, userID)
	if err != nil {
		return err
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *Store) GetLastWeightLog(ctx context.Context, userID int64) (*WeightLog, error) {
	var w WeightLog
	var weightTrend, bodyFat, bodyFatTrend, muscleMass, muscleMassTrend sql.NullFloat64
	var notes sql.NullString

	err := s.db.QueryRowContext(ctx,
		"SELECT id, user_id, measured_at, weight, weight_trend, body_fat, body_fat_trend, muscle_mass, muscle_mass_trend, notes FROM weight_logs WHERE user_id = ? ORDER BY measured_at DESC LIMIT 1",
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

func (s *Store) GetHighestWeightRecord(ctx context.Context, userID int64) (*WeightLog, error) {
	var w WeightLog
	var weightTrend, bodyFat, bodyFatTrend, muscleMass, muscleMassTrend sql.NullFloat64
	var notes sql.NullString

	err := s.db.QueryRowContext(ctx,
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

func (s *Store) ImportSleepLogs(ctx context.Context, userID int64, logs []SleepLog) (int, int, error) {
	if len(logs) == 0 {
		return 0, 0, nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
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

		query := `INSERT OR IGNORE INTO sleep_logs (user_id, start_time, end_time,
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

// ImportDayStats imports day statistics from backups
func (s *Store) ImportDayStats(ctx context.Context, userID int64, stats []DayStat) (int, int, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback() }()

	stmt, err := tx.PrepareContext(ctx,
		`INSERT INTO day_stats (user_id, day, steps, calories, distance)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, day) DO UPDATE SET
		   steps=excluded.steps, calories=excluded.calories, distance=excluded.distance`)
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

// GetDayStats retrieves daily stats for a user since a given date
func (s *Store) GetDayStats(ctx context.Context, userID int64, since time.Time) ([]DayStat, error) {
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

	rows, err := s.db.QueryContext(ctx, query, args...)
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

// GetSleepLogs retrieves sleep logs for a user since a given date
func (s *Store) GetSleepLogs(ctx context.Context, userID int64, since time.Time) ([]SleepLog, error) {
	query := `SELECT id, user_id, start_time, end_time, timezone_offset, day, light_minutes, deep_minutes, rem_minutes,
		 awake_minutes, total_minutes, turn_over_count, heart_rate_avg, spo2_avg, user_modified, notes, created_at
		 FROM sleep_logs WHERE user_id = ?`
	args := []interface{}{userID}

	if !since.IsZero() {
		query += " AND start_time >= ?"
		args = append(args, since)
	}

	query += " ORDER BY start_time DESC"

	rows, err := s.db.QueryContext(ctx, query, args...)
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

// PushSubscription represents a Web Push subscription
type PushSubscription struct {
	ID        int64     `json:"id"`
	UserID    int64     `json:"user_id"`
	Endpoint  string    `json:"endpoint"`
	Auth      string    `json:"auth"`
	P256dh    string    `json:"p256dh"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (s *Store) CreatePushSubscription(userID int64, endpoint, auth, p256dh string) error {
	query := `
		INSERT INTO push_subscriptions (user_id, endpoint, auth, p256dh, enabled, updated_at)
		VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
		ON CONFLICT(endpoint) DO UPDATE SET
			user_id = excluded.user_id,
			auth = excluded.auth,
			p256dh = excluded.p256dh,
			enabled = 1,
			updated_at = CURRENT_TIMESTAMP
	`
	_, err := s.db.Exec(query, userID, endpoint, auth, p256dh)
	return err
}

func (s *Store) GetPushSubscriptions(userID int64) ([]PushSubscription, error) {
	query := `SELECT id, user_id, endpoint, auth, p256dh, enabled, created_at, updated_at 
	          FROM push_subscriptions 
	          WHERE user_id = ? AND enabled = 1`

	rows, err := s.db.Query(query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var subs []PushSubscription
	for rows.Next() {
		var sub PushSubscription
		if err := rows.Scan(&sub.ID, &sub.UserID, &sub.Endpoint, &sub.Auth, &sub.P256dh, &sub.Enabled, &sub.CreatedAt, &sub.UpdatedAt); err != nil {
			return nil, err
		}
		subs = append(subs, sub)
	}
	return subs, nil
}

func (s *Store) DeletePushSubscription(endpoint string) error {
	_, err := s.db.Exec("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint)
	return err
}

func (s *Store) DisablePushSubscription(endpoint string) error {
	_, err := s.db.Exec("UPDATE push_subscriptions SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE endpoint = ?", endpoint)
	return err
}

// -- Food Logs --

type FoodLog struct {
	ID        int64     `json:"id"`
	UserID    int64     `json:"user_id"`
	EatenAt   time.Time `json:"eaten_at"`
	Weight    int       `json:"weight"`
	Carbs     int       `json:"carbs"`    // total grams
	Protein   int       `json:"protein"`  // total grams
	Fat       int       `json:"fat"`      // total grams
	Calories  int       `json:"calories"` // total kcal
	Name      string    `json:"name,omitempty"`
	ProductID *int64    `json:"product_id,omitempty"`
	IsMeal    bool      `json:"is_meal"`
}

type FoodProduct struct {
	ID             int64     `json:"id"`
	UserID         int64     `json:"user_id"`
	Name           string    `json:"name"`
	Barcode        *string   `json:"barcode,omitempty"`
	Carbs100g      float64   `json:"carbs_100g"`
	Protein100g    float64   `json:"protein_100g"`
	Fat100g        float64   `json:"fat_100g"`
	EnergyKcal100g float64   `json:"energy_kcal_100g"`
	UsageCount     int       `json:"usage_count"`
	IsMeal         bool      `json:"is_meal"`
	TotalWeightG   int       `json:"total_weight_g"`
	CreatedAt      time.Time `json:"created_at"`
	LastUsedAt     time.Time `json:"last_used_at"`
}

type OpenFoodFact struct {
	Barcode        string  `json:"barcode"`
	Name           string  `json:"name"`
	Carbs100g      float64 `json:"carbs_100g"`
	Protein100g    float64 `json:"protein_100g"`
	Fat100g        float64 `json:"fat_100g"`
	EnergyKcal100g float64 `json:"energy_kcal_100g"`
}

func (s *Store) UpsertFoodProduct(ctx context.Context, p *FoodProduct) error {
	query := `
		INSERT INTO food_products (user_id, name, barcode, carbs_100g, protein_100g, fat_100g, energy_kcal_100g, usage_count, last_used_at, is_meal, total_weight_g)
		VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, ?, ?)
		ON CONFLICT(user_id, name) DO UPDATE SET
			barcode = COALESCE(excluded.barcode, food_products.barcode),
			carbs_100g = COALESCE(NULLIF(excluded.carbs_100g, 0), food_products.carbs_100g),
			protein_100g = COALESCE(NULLIF(excluded.protein_100g, 0), food_products.protein_100g),
			fat_100g = COALESCE(NULLIF(excluded.fat_100g, 0), food_products.fat_100g),
			energy_kcal_100g = COALESCE(NULLIF(excluded.energy_kcal_100g, 0), food_products.energy_kcal_100g),
			usage_count = food_products.usage_count + 1,
			is_meal = CASE WHEN excluded.is_meal THEN 1 ELSE food_products.is_meal END,
			total_weight_g = CASE WHEN excluded.is_meal THEN excluded.total_weight_g ELSE food_products.total_weight_g END,
			last_used_at = CURRENT_TIMESTAMP
	`
	var barcode interface{}
	if p.Barcode != nil && *p.Barcode != "" {
		barcode = *p.Barcode
	}
	_, err := s.db.ExecContext(ctx, query, p.UserID, p.Name, barcode, p.Carbs100g, p.Protein100g, p.Fat100g, p.EnergyKcal100g, p.IsMeal, p.TotalWeightG)
	return err
}

func (s *Store) UpdateFoodProduct(ctx context.Context, p *FoodProduct) error {
	var barcode interface{}
	if p.Barcode != nil && *p.Barcode != "" {
		barcode = *p.Barcode
	}
	res, err := s.db.ExecContext(ctx,
		"UPDATE food_products SET name = ?, barcode = ?, carbs_100g = ?, protein_100g = ?, fat_100g = ?, energy_kcal_100g = ?, is_meal = ?, total_weight_g = ? WHERE id = ? AND user_id = ?",
		p.Name, barcode, p.Carbs100g, p.Protein100g, p.Fat100g, p.EnergyKcal100g, p.IsMeal, p.TotalWeightG, p.ID, p.UserID)
	if err != nil {
		return err
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *Store) DeleteFoodProduct(ctx context.Context, id, userID int64) error {
	res, err := s.db.ExecContext(ctx, "DELETE FROM food_products WHERE id = ? AND user_id = ?", id, userID)
	if err != nil {
		return err
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

type FoodProductsFilter struct {
	IsMeal *bool
	Query  string
	Offset int
	Limit  int
	Sort   string // "usage", "last_used", "name"
}

func (s *Store) GetFoodProducts(ctx context.Context, userID int64, filter FoodProductsFilter) ([]FoodProduct, int, error) {
	var countQuery strings.Builder
	var selectQuery strings.Builder
	var args []interface{}

	countQuery.WriteString("SELECT COUNT(*) FROM food_products WHERE user_id = ?")
	selectQuery.WriteString("SELECT id, user_id, name, barcode, carbs_100g, protein_100g, fat_100g, energy_kcal_100g, usage_count, is_meal, total_weight_g, created_at, last_used_at FROM food_products WHERE user_id = ?")
	args = append(args, userID)

	if filter.IsMeal != nil {
		countQuery.WriteString(" AND is_meal = ?")
		selectQuery.WriteString(" AND is_meal = ?")
		args = append(args, *filter.IsMeal)
	}

	if filter.Query != "" {
		countQuery.WriteString(" AND name LIKE ?")
		selectQuery.WriteString(" AND name LIKE ?")
		args = append(args, "%"+filter.Query+"%")
	}

	var total int
	err := s.db.QueryRowContext(ctx, countQuery.String(), args...).Scan(&total)
	if err != nil {
		return nil, 0, err
	}

	switch filter.Sort {
	case "last_used":
		selectQuery.WriteString(" ORDER BY last_used_at DESC")
	case "name":
		selectQuery.WriteString(" ORDER BY name ASC")
	default: // "usage" or empty
		selectQuery.WriteString(" ORDER BY usage_count DESC, last_used_at DESC")
	}

	selectQuery.WriteString(" LIMIT ? OFFSET ?")
	args = append(args, filter.Limit, filter.Offset)

	rows, err := s.db.QueryContext(ctx, selectQuery.String(), args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var products []FoodProduct
	for rows.Next() {
		var p FoodProduct
		var barcode sql.NullString
		if err := rows.Scan(&p.ID, &p.UserID, &p.Name, &barcode, &p.Carbs100g, &p.Protein100g, &p.Fat100g, &p.EnergyKcal100g, &p.UsageCount, &p.IsMeal, &p.TotalWeightG, &p.CreatedAt, &p.LastUsedAt); err != nil {
			return nil, 0, err
		}
		if barcode.Valid {
			b := barcode.String
			p.Barcode = &b
		}
		products = append(products, p)
	}
	return products, total, nil
}

func (s *Store) SearchFoodProducts(ctx context.Context, userID int64, queryStr string) ([]FoodProduct, error) {
	// Search in user's food_products and globally in open_food_facts.
	// We'll return them as FoodProduct structs. For open_food_facts, ID and UserID will be 0.

	likeQuery := "%" + queryStr + "%"

	query := `
		SELECT id, user_id, name, barcode, carbs_100g, protein_100g, fat_100g, energy_kcal_100g, usage_count, is_meal, total_weight_g, created_at, last_used_at
		FROM food_products
		WHERE user_id = ? AND (name LIKE ? OR barcode LIKE ?)
		
		UNION ALL
		
		SELECT 0 as id, 0 as user_id, name, barcode, carbs_100g, protein_100g, fat_100g, energy_kcal_100g, 0 as usage_count, 0 as is_meal, 0 as total_weight_g, CURRENT_TIMESTAMP as created_at, CURRENT_TIMESTAMP as last_used_at
		FROM open_food_facts
		WHERE name LIKE ? OR barcode LIKE ?
		
		ORDER BY is_meal DESC, usage_count DESC, name COLLATE NOCASE ASC
		LIMIT 50
	`
	rows, err := s.db.QueryContext(ctx, query, userID, likeQuery, likeQuery, likeQuery, likeQuery)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var products []FoodProduct
	for rows.Next() {
		var p FoodProduct
		var barcode sql.NullString
		if err := rows.Scan(&p.ID, &p.UserID, &p.Name, &barcode, &p.Carbs100g, &p.Protein100g, &p.Fat100g, &p.EnergyKcal100g, &p.UsageCount, &p.IsMeal, &p.TotalWeightG, &p.CreatedAt, &p.LastUsedAt); err != nil {
			return nil, err
		}
		if barcode.Valid {
			b := barcode.String
			p.Barcode = &b
		}
		products = append(products, p)
	}
	return products, nil
}

func (s *Store) CreateMealFromLogs(ctx context.Context, userID int64, name string, logIDs []int64) (*FoodProduct, error) {
	if len(logIDs) == 0 {
		return nil, fmt.Errorf("no log IDs provided")
	}

	// Dedup logIDs to know exactly how many unique IDs we expect
	uniqueIDs := make(map[int64]struct{})
	for _, id := range logIDs {
		uniqueIDs[id] = struct{}{}
	}

	// Prepare IN clause placeholders
	placeholders := make([]string, 0, len(uniqueIDs))
	args := make([]interface{}, 0, len(uniqueIDs)+1)
	args = append(args, userID)
	for id := range uniqueIDs {
		placeholders = append(placeholders, "?")
		args = append(args, id)
	}

	query := fmt.Sprintf(`
		SELECT id, user_id, eaten_at, weight, carbs, protein, fat, calories, name, product_id
		FROM food_log
		WHERE user_id = ? AND id IN (%s)
	`, strings.Join(placeholders, ","))

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var totalWeight, totalCarbs, totalProtein, totalFat, totalCalories int
	var count int

	for rows.Next() {
		var l FoodLog
		var lname sql.NullString
		var productID sql.NullInt64
		if err := rows.Scan(&l.ID, &l.UserID, &l.EatenAt, &l.Weight, &l.Carbs, &l.Protein, &l.Fat, &l.Calories, &lname, &productID); err != nil {
			return nil, err
		}
		totalWeight += l.Weight
		totalCarbs += l.Carbs
		totalProtein += l.Protein
		totalFat += l.Fat
		totalCalories += l.Calories
		count++
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	if count == 0 {
		return nil, fmt.Errorf("no valid food logs found for the given IDs")
	}

	if count != len(uniqueIDs) {
		return nil, fmt.Errorf("could not find all requested food logs; some may be deleted or belong to another user")
	}

	if totalWeight <= 0 {
		return nil, fmt.Errorf("total weight must be greater than 0")
	}

	// Calculate per 100g values
	mult := 100.0 / float64(totalWeight)
	c100 := float64(totalCarbs) * mult
	p100 := float64(totalProtein) * mult
	f100 := float64(totalFat) * mult
	k100 := float64(totalCalories) * mult

	product := &FoodProduct{
		UserID:         userID,
		Name:           name,
		Carbs100g:      c100,
		Protein100g:    p100,
		Fat100g:        f100,
		EnergyKcal100g: k100,
		IsMeal:         true,
		TotalWeightG:   totalWeight,
	}

	if err := s.UpsertFoodProduct(ctx, product); err != nil {
		return nil, err
	}

	// Get the generated ID
	var createdProduct FoodProduct
	err = s.db.QueryRowContext(ctx, "SELECT id, user_id, name, carbs_100g, protein_100g, fat_100g, energy_kcal_100g, usage_count, is_meal, total_weight_g, created_at, last_used_at FROM food_products WHERE user_id = ? AND name = ?", userID, name).Scan(
		&createdProduct.ID, &createdProduct.UserID, &createdProduct.Name, &createdProduct.Carbs100g, &createdProduct.Protein100g, &createdProduct.Fat100g, &createdProduct.EnergyKcal100g, &createdProduct.UsageCount, &createdProduct.IsMeal, &createdProduct.TotalWeightG, &createdProduct.CreatedAt, &createdProduct.LastUsedAt)
	if err != nil {
		return nil, err
	}

	return &createdProduct, nil
}

func (s *Store) CreateFoodLog(ctx context.Context, f *FoodLog) (int64, error) {
	if f.ProductID != nil {
		var exists int
		err := s.db.QueryRowContext(ctx, "SELECT 1 FROM food_products WHERE id = ? AND user_id = ?", *f.ProductID, f.UserID).Scan(&exists)
		if err == sql.ErrNoRows {
			return 0, fmt.Errorf("invalid product_id: product does not exist or belongs to another user")
		} else if err != nil {
			return 0, err
		}
	}

	// Always store eaten_at in UTC so that SQLite's lexicographic datetime
	// comparison works correctly against the UTC midnight boundaries used in
	// GetFoodLogs / GetFoodStats.  Without this, a +01:00 offset stored by a
	// CET server would sort as if it were an hour later than it actually is.
	eatenAt := f.EatenAt.UTC()

	res, err := s.db.ExecContext(ctx,
		"INSERT INTO food_log (user_id, eaten_at, weight, carbs, protein, fat, calories, name, product_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		f.UserID, eatenAt, f.Weight, f.Carbs, f.Protein, f.Fat, f.Calories, f.Name, f.ProductID)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) UpdateFoodLog(ctx context.Context, f *FoodLog) error {
	if f.ProductID != nil {
		var exists int
		err := s.db.QueryRowContext(ctx, "SELECT 1 FROM food_products WHERE id = ? AND user_id = ?", *f.ProductID, f.UserID).Scan(&exists)
		if err == sql.ErrNoRows {
			return fmt.Errorf("invalid product_id: product does not exist or belongs to another user")
		} else if err != nil {
			return err
		}
	}

	// Normalise to UTC for the same reason as CreateFoodLog.
	eatenAt := f.EatenAt.UTC()

	res, err := s.db.ExecContext(ctx,
		"UPDATE food_log SET eaten_at = ?, weight = ?, carbs = ?, protein = ?, fat = ?, calories = ?, name = ?, product_id = ? WHERE id = ? AND user_id = ?",
		eatenAt, f.Weight, f.Carbs, f.Protein, f.Fat, f.Calories, f.Name, f.ProductID, f.ID, f.UserID)
	if err != nil {
		return err
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *Store) GetFoodLogs(ctx context.Context, userID int64, date time.Time, days int) ([]FoodLog, error) {
	// Range for the days — compute calendar midnights in the client's timezone so DST
	// transitions don't shift boundaries by an hour, then convert to UTC for SQLite.
	dayMidnight := time.Date(date.Year(), date.Month(), date.Day(), 0, 0, 0, 0, date.Location())
	endOfDay := dayMidnight.AddDate(0, 0, 1).UTC()
	startOfDay := dayMidnight.AddDate(0, 0, -(days - 1)).UTC()

	query := `
		SELECT
			fl.id, fl.user_id, fl.eaten_at, fl.weight, fl.carbs, fl.protein, fl.fat, fl.calories, fl.name, fl.product_id, fp.is_meal
		FROM food_log fl
		LEFT JOIN food_products fp ON fl.product_id = fp.id AND fp.user_id = fl.user_id
		WHERE fl.user_id = ? AND fl.eaten_at >= ? AND fl.eaten_at < ?
		ORDER BY fl.eaten_at ASC
	`

	rows, err := s.db.QueryContext(ctx, query, userID, startOfDay, endOfDay)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []FoodLog
	for rows.Next() {
		var l FoodLog
		var name sql.NullString
		var productID sql.NullInt64
		var isMeal sql.NullBool

		if err := rows.Scan(&l.ID, &l.UserID, &l.EatenAt, &l.Weight, &l.Carbs, &l.Protein, &l.Fat, &l.Calories, &name, &productID, &isMeal); err != nil {
			return nil, err
		}
		if name.Valid {
			l.Name = name.String
		}
		if productID.Valid {
			id := productID.Int64
			l.ProductID = &id
		}
		if isMeal.Valid {
			l.IsMeal = isMeal.Bool
		}
		logs = append(logs, l)
	}
	return logs, nil
}

func (s *Store) DeleteFoodLog(ctx context.Context, id, userID int64) error {
	res, err := s.db.ExecContext(ctx, "DELETE FROM food_log WHERE id = ? AND user_id = ?", id, userID)
	if err != nil {
		return err
	}
	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *Store) GetFoodIntakeEnabled(ctx context.Context) (bool, error) {
	return s.getSettingsBool(ctx, "food_intake_enabled")
}

func (s *Store) SetFoodIntakeEnabled(ctx context.Context, enabled bool) error {
	return s.setSettingsBool(ctx, "food_intake_enabled", enabled)
}

type FoodStats struct {
	Calories int `json:"calories"`
	Carbs    int `json:"carbs"`
	Protein  int `json:"protein"`
	Fat      int `json:"fat"`
}

func (s *Store) GetFoodStats(ctx context.Context, userID int64, endDate time.Time, days int) (*FoodStats, error) {
	// Range for the days — calendar midnights in client timezone (DST-safe), same as GetFoodLogs.
	dayMidnight := time.Date(endDate.Year(), endDate.Month(), endDate.Day(), 0, 0, 0, 0, endDate.Location())
	endOfDay := dayMidnight.AddDate(0, 0, 1).UTC()
	startOfDay := dayMidnight.AddDate(0, 0, -(days - 1)).UTC()

	query := "SELECT COALESCE(SUM(calories), 0), COALESCE(SUM(carbs), 0), COALESCE(SUM(protein), 0), COALESCE(SUM(fat), 0) FROM food_log WHERE user_id = ? AND eaten_at >= ? AND eaten_at < ?"

	var stats FoodStats
	err := s.db.QueryRowContext(ctx, query, userID, startOfDay, endOfDay).Scan(&stats.Calories, &stats.Carbs, &stats.Protein, &stats.Fat)
	if err != nil {
		return nil, err
	}
	return &stats, nil
}

func (s *Store) GetFoodTargets(ctx context.Context) (FoodTargets, error) {
	var targets FoodTargets
	err := s.db.QueryRowContext(ctx,
		"SELECT food_target_calories, food_target_carbs, food_target_protein, food_target_fat FROM settings WHERE id = 1",
	).Scan(&targets.Calories, &targets.Carbs, &targets.Protein, &targets.Fat)
	return targets, err
}

func (s *Store) SetFoodTargets(ctx context.Context, targets FoodTargets) error {
	_, err := s.db.ExecContext(ctx,
		"UPDATE settings SET food_target_calories = ?, food_target_carbs = ?, food_target_protein = ?, food_target_fat = ? WHERE id = 1",
		targets.Calories, targets.Carbs, targets.Protein, targets.Fat,
	)
	return err
}

func (s *Store) GetBloodPressureEnabled(ctx context.Context) (bool, error) {
	return s.getSettingsBool(ctx, "blood_pressure_enabled")
}

func (s *Store) SetBloodPressureEnabled(ctx context.Context, enabled bool) error {
	return s.setSettingsBool(ctx, "blood_pressure_enabled", enabled)
}

func (s *Store) GetWeightEnabled(ctx context.Context) (bool, error) {
	return s.getSettingsBool(ctx, "weight_enabled")
}

func (s *Store) SetWeightEnabled(ctx context.Context, enabled bool) error {
	return s.setSettingsBool(ctx, "weight_enabled", enabled)
}

func (s *Store) GetMedicationEnabled(ctx context.Context) (bool, error) {
	return s.getSettingsBool(ctx, "medication_enabled")
}

func (s *Store) SetMedicationEnabled(ctx context.Context, enabled bool) error {
	return s.setSettingsBool(ctx, "medication_enabled", enabled)
}

func (s *Store) GetWorkoutEnabled(ctx context.Context) (bool, error) {
	return s.getSettingsBool(ctx, "workout_enabled")
}

func (s *Store) SetWorkoutEnabled(ctx context.Context, enabled bool) error {
	return s.setSettingsBool(ctx, "workout_enabled", enabled)
}

func (s *Store) GetHealthEnabled(ctx context.Context) (bool, error) {
	return s.getSettingsBool(ctx, "health_enabled")
}

func (s *Store) SetHealthEnabled(ctx context.Context, enabled bool) error {
	return s.setSettingsBool(ctx, "health_enabled", enabled)
}

func (s *Store) GetTabOrder(ctx context.Context) (string, error) {
	var tabOrder sql.NullString
	err := s.db.QueryRowContext(ctx, "SELECT tab_order FROM settings WHERE id = 1").Scan(&tabOrder)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if tabOrder.Valid {
		return tabOrder.String, nil
	}
	return "", nil
}

func (s *Store) SetTabOrder(ctx context.Context, order string) error {
	_, err := s.db.ExecContext(ctx, "UPDATE settings SET tab_order = ? WHERE id = 1", order)
	return err
}

// allowedSettingsBoolColumns is the allowlist of valid boolean column names in the settings table.

var allowedSettingsBoolColumns = map[string]bool{
	"food_intake_enabled":    true,
	"blood_pressure_enabled": true,
	"weight_enabled":         true,
	"medication_enabled":     true,
	"workout_enabled":        true,
	"health_enabled":         true,
}

func (s *Store) getSettingsBool(ctx context.Context, column string) (bool, error) {
	if !allowedSettingsBoolColumns[column] {
		return false, fmt.Errorf("unknown settings column: %s", column)
	}
	var val interface{}
	query := fmt.Sprintf("SELECT %s FROM settings WHERE id = 1", column) // #nosec G201 -- column validated against allowlist above
	if err := s.db.QueryRowContext(ctx, query).Scan(&val); err != nil {
		return false, err
	}

	switch v := val.(type) {
	case int64:
		return v == 1, nil
	case bool:
		return v, nil
	case []uint8:
		return len(v) > 0 && v[0] == 1, nil
	default:
		return false, nil
	}
}

func (s *Store) setSettingsBool(ctx context.Context, column string, enabled bool) error {
	if !allowedSettingsBoolColumns[column] {
		return fmt.Errorf("unknown settings column: %s", column)
	}
	query := fmt.Sprintf("UPDATE settings SET %s = ? WHERE id = 1", column) // #nosec G201 -- column validated against allowlist above
	_, err := s.db.ExecContext(ctx, query, enabled)
	return err
}

// CreateDiaryNote inserts a new diary note for the user.
func (s *Store) CreateDiaryNote(ctx context.Context, userID int64, content string) (*DiaryNote, error) {
	query := `INSERT INTO diary_notes (user_id, content, created_at) VALUES (?, ?, ?) RETURNING id, user_id, content, created_at`
	var note DiaryNote
	err := s.db.QueryRowContext(ctx, query, userID, content, nowFunc()).Scan(&note.ID, &note.UserID, &note.Content, &note.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &note, nil
}

// ListDiaryNotes returns diary notes for a user, newest first.
// If since is non-zero, only notes created at or after that time are returned.
// If until is non-zero, only notes created at or before that time are returned.
// limit <= 0 means no limit (up to 1000).
// beforeID, when > 0, acts as a keyset cursor: only notes with id < beforeID are returned,
// enabling stable pagination even when notes are added or deleted between pages.
func (s *Store) ListDiaryNotes(ctx context.Context, userID int64, since, until time.Time, limit int, beforeID int64) ([]DiaryNote, error) {
	query := `SELECT id, user_id, content, created_at FROM diary_notes WHERE user_id = ?`
	args := []interface{}{userID}
	if !since.IsZero() {
		query += " AND created_at >= ?"
		args = append(args, since)
	}
	if !until.IsZero() {
		query += " AND created_at <= ?"
		args = append(args, until)
	}
	if beforeID > 0 {
		query += " AND id < ?"
		args = append(args, beforeID)
	}
	query += " ORDER BY id DESC LIMIT ?"
	if limit > 0 {
		args = append(args, limit)
	} else {
		args = append(args, 1000)
	}

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var notes []DiaryNote
	for rows.Next() {
		var n DiaryNote
		if err := rows.Scan(&n.ID, &n.UserID, &n.Content, &n.CreatedAt); err != nil {
			return nil, err
		}
		notes = append(notes, n)
	}
	return notes, rows.Err()
}

// DeleteDiaryNote deletes a diary note by ID, scoped to the user.
func (s *Store) DeleteDiaryNote(ctx context.Context, userID, noteID int64) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM diary_notes WHERE id = ? AND user_id = ?`, noteID, userID)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// GetCurrentTimezone returns the timezone string from the most recent timezone_history row,
// or an empty string if no timezone has been recorded yet.
func (s *Store) GetCurrentTimezone() (string, error) {
	var tz string
	err := s.db.QueryRow(`SELECT timezone FROM timezone_history ORDER BY recorded_at DESC, id DESC LIMIT 1`).Scan(&tz)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return tz, nil
}

// RecordTimezone appends the new timezone to timezone_history only if it differs
// from the current active timezone. This prevents unbounded table growth when the
// frontend calls the endpoint on every startup.
func (s *Store) RecordTimezone(tz string) error {
	_, err := s.db.Exec(`
		INSERT INTO timezone_history (timezone)
		SELECT ?
		WHERE COALESCE(
			(SELECT timezone FROM timezone_history ORDER BY recorded_at DESC, id DESC LIMIT 1),
			'') != ?`, tz, tz)
	return err
}

// -- TZ Transition Plans --

// TZTransitionPlan represents a pending or completed timezone transition plan.
type TZTransitionPlan struct {
	ID         int64      `json:"id"`
	OldTZ      string     `json:"old_tz"`
	NewTZ      string     `json:"new_tz"`
	CreatedAt  time.Time  `json:"created_at"`
	Status     string     `json:"status"` // PENDING_APPROVAL / NOTIFIED / APPROVED / REJECTED / CANCELLED / EXPIRED
	StepsJSON  string     `json:"steps_json"`
	InputsJSON string     `json:"inputs_json"`
	PlanHash   string     `json:"plan_hash"`
	NotifiedAt *time.Time `json:"notified_at,omitempty"`
	ApprovedAt *time.Time `json:"approved_at,omitempty"`
	UserAction string     `json:"user_action,omitempty"`
}

// TZTransitionStep represents a single dose step in a timezone transition plan.
type TZTransitionStep struct {
	ID           int64      `json:"id"`
	PlanID       int64      `json:"plan_id"`
	MedicationID int64      `json:"medication_id"`
	StepNumber   int        `json:"step_number"`
	ScheduledAt  time.Time  `json:"scheduled_at"`
	Note         string     `json:"note"`
	ConsumedAt   *time.Time `json:"consumed_at,omitempty"`
}

// CreateTZTransitionPlan saves a new timezone transition plan and returns its ID.
func (s *Store) CreateTZTransitionPlan(plan *TZTransitionPlan) (int64, error) {
	res, err := s.db.Exec(
		`INSERT INTO tz_transition_plans (old_tz, new_tz, status, steps_json, inputs_json, plan_hash)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		plan.OldTZ, plan.NewTZ, plan.Status, plan.StepsJSON, plan.InputsJSON, plan.PlanHash,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// GetLatestActiveOrPendingTZTransitionPlan returns the most recent plan in
// PENDING_APPROVAL, NOTIFIED, or APPROVED status, or nil if none exists.
func (s *Store) GetLatestActiveOrPendingTZTransitionPlan() (*TZTransitionPlan, error) {
	var p TZTransitionPlan
	var notifiedAt, approvedAt sql.NullTime
	var userAction sql.NullString
	err := s.db.QueryRow(
		`SELECT id, old_tz, new_tz, created_at, status, steps_json, inputs_json, plan_hash, notified_at, approved_at, user_action
		 FROM tz_transition_plans
		 WHERE status IN ('PENDING_APPROVAL','NOTIFIED','APPROVED')
		 ORDER BY created_at DESC, id DESC LIMIT 1`,
	).Scan(&p.ID, &p.OldTZ, &p.NewTZ, &p.CreatedAt, &p.Status, &p.StepsJSON, &p.InputsJSON, &p.PlanHash, &notifiedAt, &approvedAt, &userAction)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if notifiedAt.Valid {
		p.NotifiedAt = &notifiedAt.Time
	}
	if approvedAt.Valid {
		p.ApprovedAt = &approvedAt.Time
	}
	if userAction.Valid {
		p.UserAction = userAction.String
	}
	return &p, nil
}

// UpdateTZTransitionPlanStatus atomically transitions a plan's status.
// If expectedStatus is non-empty, the update only applies when the current status matches.
func (s *Store) UpdateTZTransitionPlanStatus(id int64, newStatus, userAction, expectedStatus string) error {
	var err error
	if expectedStatus != "" {
		var res sql.Result
		res, err = s.db.Exec(
			`UPDATE tz_transition_plans SET status = ?, user_action = ? WHERE id = ? AND status = ?`,
			newStatus, userAction, id, expectedStatus,
		)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return nil // no-op: status already changed, idempotent
		}
		return nil
	}
	_, err = s.db.Exec(
		`UPDATE tz_transition_plans SET status = ?, user_action = ? WHERE id = ?`,
		newStatus, userAction, id,
	)
	return err
}

// SetTZTransitionPlanApproved marks a plan as APPROVED and records the approval time.
// The update is guarded to only apply when the plan is in PENDING_APPROVAL or NOTIFIED
// status, preventing stale Telegram callbacks from resurrecting superseded or cancelled plans.
func (s *Store) SetTZTransitionPlanApproved(id int64, approvedAt time.Time) (bool, error) {
	res, err := s.db.Exec(
		`UPDATE tz_transition_plans SET status = 'APPROVED', approved_at = ?, user_action = 'approved'
		 WHERE id = ? AND status IN ('PENDING_APPROVAL', 'NOTIFIED')`,
		approvedAt, id,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// SetTZTransitionPlanRejected marks a plan as REJECTED.
// The update is guarded to only apply when the plan is in PENDING_APPROVAL or NOTIFIED
// status, preventing stale Telegram callbacks from affecting cancelled or superseded plans.
func (s *Store) SetTZTransitionPlanRejected(id int64) (bool, error) {
	res, err := s.db.Exec(
		`UPDATE tz_transition_plans SET status = 'REJECTED', user_action = 'rejected'
		 WHERE id = ? AND status IN ('PENDING_APPROVAL', 'NOTIFIED')`,
		id,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// RejectTZTransitionPlanAndRevertTimezone atomically marks a plan as REJECTED and
// reverts the stored timezone back to the plan's OldTZ. This ensures that after
// rejection the scheduler continues to use the original timezone rather than the
// newly-stored one. Returns true if the plan was found and updated.
func (s *Store) RejectTZTransitionPlanAndRevertTimezone(id int64) (bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback() //nolint:errcheck

	var oldTZ string
	err = tx.QueryRow(
		`SELECT old_tz FROM tz_transition_plans WHERE id = ? AND status IN ('PENDING_APPROVAL', 'NOTIFIED')`,
		id,
	).Scan(&oldTZ)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}

	res, err := tx.Exec(
		`UPDATE tz_transition_plans SET status = 'REJECTED', user_action = 'rejected'
		 WHERE id = ? AND status IN ('PENDING_APPROVAL', 'NOTIFIED')`,
		id,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return false, nil
	}

	// Revert timezone_history to oldTZ so the scheduler resumes on the original schedule.
	_, err = tx.Exec(`
		INSERT INTO timezone_history (timezone)
		SELECT ?
		WHERE COALESCE(
			(SELECT timezone FROM timezone_history ORDER BY recorded_at DESC, id DESC LIMIT 1),
			'') != ?`, oldTZ, oldTZ)
	if err != nil {
		return false, err
	}

	return true, tx.Commit()
}

// MarkPlanNotified atomically transitions a plan from PENDING_APPROVAL to NOTIFIED.
// Returns true if the transition occurred (this process "won" the CAS), false if the
// plan was already in a different state (duplicate protection for concurrent schedulers).
func (s *Store) MarkPlanNotified(id int64) (bool, error) {
	res, err := s.db.Exec(
		`UPDATE tz_transition_plans SET status = 'NOTIFIED', notified_at = CURRENT_TIMESTAMP
		 WHERE id = ? AND status = 'PENDING_APPROVAL'`,
		id,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ResetPlanToPending reverts a NOTIFIED plan back to PENDING_APPROVAL.
// Used when the notification send fails so the plan can be retried on the next scheduler tick.
func (s *Store) ResetPlanToPending(id int64) error {
	_, err := s.db.Exec(
		`UPDATE tz_transition_plans SET status = 'PENDING_APPROVAL', notified_at = NULL
		 WHERE id = ? AND status = 'NOTIFIED'`,
		id,
	)
	return err
}

// CreateTZTransitionPlanWithSteps atomically cancels any active plans and saves
// a new timezone transition plan together with its steps in a single transaction.
// This prevents concurrent timezone updates from leaving multiple active plans.
func (s *Store) CreateTZTransitionPlanWithSteps(plan *TZTransitionPlan, steps []TZTransitionStep) (int64, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer func() {
		if err != nil {
			tx.Rollback() //nolint:errcheck
		}
	}()

	// Cancel all active plans within this transaction to prevent races where
	// concurrent timezone updates both create active plans.
	_, err = tx.Exec(
		`UPDATE tz_transition_plans SET status = 'CANCELLED', user_action = 'superseded'
		 WHERE status IN ('PENDING_APPROVAL', 'NOTIFIED', 'APPROVED')`,
	)
	if err != nil {
		return 0, err
	}

	res, err := tx.Exec(
		`INSERT INTO tz_transition_plans (old_tz, new_tz, status, steps_json, inputs_json, plan_hash)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		plan.OldTZ, plan.NewTZ, plan.Status, plan.StepsJSON, plan.InputsJSON, plan.PlanHash,
	)
	if err != nil {
		return 0, err
	}
	planID, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}

	if len(steps) > 0 {
		stmt, stmtErr := tx.Prepare(
			`INSERT INTO tz_transition_steps (plan_id, medication_id, step_number, scheduled_at, note)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		if stmtErr != nil {
			err = stmtErr
			return 0, err
		}
		defer stmt.Close()
		for _, step := range steps {
			if _, stepErr := stmt.Exec(planID, step.MedicationID, step.StepNumber, step.ScheduledAt, step.Note); stepErr != nil {
				err = stepErr
				return 0, err
			}
		}
	}

	return planID, tx.Commit()
}

// GetPlanByHash looks up a plan by its inputs hash to enable deduplication.
func (s *Store) GetPlanByHash(hash string) (*TZTransitionPlan, error) {
	var p TZTransitionPlan
	var notifiedAt, approvedAt sql.NullTime
	var userAction sql.NullString
	err := s.db.QueryRow(
		`SELECT id, old_tz, new_tz, created_at, status, steps_json, inputs_json, plan_hash, notified_at, approved_at, user_action
		 FROM tz_transition_plans WHERE plan_hash = ?
		 ORDER BY created_at DESC, id DESC LIMIT 1`,
		hash,
	).Scan(&p.ID, &p.OldTZ, &p.NewTZ, &p.CreatedAt, &p.Status, &p.StepsJSON, &p.InputsJSON, &p.PlanHash, &notifiedAt, &approvedAt, &userAction)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if notifiedAt.Valid {
		p.NotifiedAt = &notifiedAt.Time
	}
	if approvedAt.Valid {
		p.ApprovedAt = &approvedAt.Time
	}
	if userAction.Valid {
		p.UserAction = userAction.String
	}
	return &p, nil
}

// CreateTZTransitionSteps bulk-inserts transition steps for a plan.
func (s *Store) CreateTZTransitionSteps(steps []TZTransitionStep) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			tx.Rollback() //nolint:errcheck
		}
	}()
	stmt, err := tx.Prepare(
		`INSERT INTO tz_transition_steps (plan_id, medication_id, step_number, scheduled_at, note)
		 VALUES (?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, step := range steps {
		if _, err = stmt.Exec(step.PlanID, step.MedicationID, step.StepNumber, step.ScheduledAt, step.Note); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// GetPendingStepsForPlan returns all unconsumed steps for a given plan, ordered by step_number.
func (s *Store) GetPendingStepsForPlan(planID int64) ([]TZTransitionStep, error) {
	rows, err := s.db.Query(
		`SELECT id, plan_id, medication_id, step_number, scheduled_at, note
		 FROM tz_transition_steps
		 WHERE plan_id = ? AND consumed_at IS NULL
		 ORDER BY step_number ASC`,
		planID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var steps []TZTransitionStep
	for rows.Next() {
		var step TZTransitionStep
		if err := rows.Scan(&step.ID, &step.PlanID, &step.MedicationID, &step.StepNumber, &step.ScheduledAt, &step.Note); err != nil {
			return nil, err
		}
		steps = append(steps, step)
	}
	return steps, nil
}

// MarkStepConsumed records the consumption time for a transition step.
func (s *Store) MarkStepConsumed(stepID int64, consumedAt time.Time) error {
	_, err := s.db.Exec(
		`UPDATE tz_transition_steps SET consumed_at = ? WHERE id = ?`,
		consumedAt, stepID,
	)
	return err
}
