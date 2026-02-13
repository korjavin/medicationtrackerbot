package store

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"fmt"
	"math"
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
	StartDate      *time.Time `json:"start_date"`
	EndDate        *time.Time `json:"end_date"`
	LastTakenAt    *time.Time `json:"last_taken_at"`
	CreatedAt      time.Time  `json:"created_at"`
	RxCUI          string     `json:"rxcui,omitempty"`
	NormalizedName string     `json:"normalized_name,omitempty"`
	InventoryCount *int       `json:"inventory_count,omitempty"` // NULL = not tracking
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
	Status       string     `json:"status"` // PENDING, TAKEN, MISSED
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

func CalculateBPCategory(systolic, diastolic int) string {
	// Hypertensive Crisis: >180 or >120
	if systolic > 180 || diastolic > 120 {
		return "Hypertensive Crisis"
	}
	// High BP Stage 2: ≥140 or ≥90
	if systolic >= 140 || diastolic >= 90 {
		return "High BP Stage 2"
	}
	// High BP Stage 1: 130-139 or 80-89
	if systolic >= 130 || diastolic >= 80 {
		return "High BP Stage 1"
	}
	// Elevated: 120-129 and <80
	if systolic >= 120 && systolic < 130 && diastolic < 80 {
		return "Elevated"
	}
	// Normal: <120 and <80
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
			m.id, m.name, m.dosage, m.schedule, m.archived, m.start_date, m.end_date, m.created_at, m.rxcui, m.normalized_name, m.inventory_count,
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

		if err := rows.Scan(&m.ID, &m.Name, &m.Dosage, &m.Schedule, &m.Archived, &m.StartDate, &m.EndDate, &m.CreatedAt, &rxcui, &normalizedName, &inventoryCount, &lastTaken); err != nil {
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
	var inventoryCount sql.NullInt64
	err := s.db.QueryRow("SELECT id, name, dosage, schedule, archived, start_date, end_date, created_at, rxcui, normalized_name, inventory_count FROM medications WHERE id = ?", id).Scan(
		&m.ID, &m.Name, &m.Dosage, &m.Schedule, &m.Archived, &m.StartDate, &m.EndDate, &m.CreatedAt, &rxcui, &normalizedName, &inventoryCount,
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

func (s *Store) UpdateMedication(id int64, name, dosage, schedule string, archived bool, startDate, endDate *time.Time, rxcui, normalizedName string, inventoryCount *int) error {
	_, err := s.db.Exec("UPDATE medications SET name = ?, dosage = ?, schedule = ?, archived = ?, start_date = ?, end_date = ?, rxcui = ?, normalized_name = ?, inventory_count = ? WHERE id = ?",
		name, dosage, schedule, archived, startDate, endDate, rxcui, normalizedName, inventoryCount, id)
	return err
}

func (s *Store) DeleteMedication(id int64) error {
	_, err := s.db.Exec("DELETE FROM medications WHERE id = ?", id)
	return err
}

// -- Inventory Functions --

// DecrementInventory reduces the inventory count by the given quantity
// Only decrements if inventory is being tracked (not NULL)
func (s *Store) DecrementInventory(medID int64, qty int) error {
	_, err := s.db.Exec("UPDATE medications SET inventory_count = inventory_count - ? WHERE id = ? AND inventory_count IS NOT NULL", qty, medID)
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
	defer tx.Rollback()

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

func (s *Store) UpdateIntake(id int64, takenAt time.Time, status string) error {
	var takenAtVal interface{}
	if status == "TAKEN" {
		takenAtVal = takenAt
	} else {
		takenAtVal = nil
	}
	_, err := s.db.Exec("UPDATE intake_log SET status = ?, taken_at = ? WHERE id = ?", status, takenAtVal, id)
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

func (s *Store) GetIntake(id int64) (*IntakeLog, error) {
	var l IntakeLog
	err := s.db.QueryRow("SELECT id, medication_id, user_id, scheduled_at, taken_at, status FROM intake_log WHERE id = ?", id).Scan(
		&l.ID, &l.MedicationID, &l.UserID, &l.ScheduledAt, &l.TakenAt, &l.Status,
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
	// Only confirm intakes for medications that are NOT archived (archived = 0)
	_, err := s.db.Exec(`
		UPDATE intake_log 
		SET status = 'TAKEN', taken_at = ? 
		WHERE user_id = ? 
		  AND scheduled_at = ? 
		  AND status = 'PENDING'
		  AND medication_id IN (SELECT id FROM medications WHERE archived = 0)
	`, takenAt, userID, scheduledAt)
	return err
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
	rows, err := s.db.Query("SELECT id, medication_id, user_id, scheduled_at, status FROM intake_log WHERE user_id = ? AND scheduled_at = ? AND status = 'PENDING'", userID, scheduledAt)
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

func (s *Store) GetPendingIntakesForMedication(medID int64) ([]IntakeLog, error) {
	rows, err := s.db.Query("SELECT id, medication_id, user_id, scheduled_at, status FROM intake_log WHERE medication_id = ? AND status = 'PENDING'", medID)
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
			il.id, il.medication_id, il.user_id, il.scheduled_at, il.taken_at, il.status,
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
		if err := rows.Scan(&l.ID, &l.MedicationID, &l.UserID, &l.ScheduledAt, &l.TakenAt, &l.Status, &l.MedicationName, &l.MedicationDosage); err != nil {
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
	defer tx.Rollback()

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

// CalculateWeightTrend calculates a simple exponential moving average
// alpha = 0.1 gives roughly a 20-day smoothing
func CalculateWeightTrend(currentWeight float64, previousTrend *float64) float64 {
	if previousTrend == nil {
		return currentWeight
	}
	alpha := 0.1
	return alpha*currentWeight + (1-alpha)**previousTrend
}

func (s *Store) ImportSleepLogs(ctx context.Context, userID int64, logs []SleepLog) (int, int, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx,
		`INSERT OR IGNORE INTO sleep_logs (user_id, start_time, end_time,
		 timezone_offset, day, light_minutes, deep_minutes, rem_minutes,
		 awake_minutes, total_minutes, turn_over_count, heart_rate_avg,
		 spo2_avg, user_modified, notes)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return 0, 0, err
	}
	defer stmt.Close()

	imported := 0
	for _, sl := range logs {
		sl.UserID = userID
		res, err := stmt.ExecContext(ctx, sl.UserID, sl.StartTime, sl.EndTime,
			sl.TimezoneOffset, sl.Day, sl.LightMinutes, sl.DeepMinutes,
			sl.REMMinutes, sl.AwakeMinutes, sl.TotalMinutes, sl.TurnOverCount,
			sl.HeartRateAvg, sl.SpO2Avg, sl.UserModified, sl.Notes)
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
