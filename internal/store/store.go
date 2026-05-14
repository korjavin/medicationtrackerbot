package store

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store/auth"
	"github.com/korjavin/medicationtrackerbot/internal/store/bp"
	"github.com/korjavin/medicationtrackerbot/internal/store/diary"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/food"
	"github.com/korjavin/medicationtrackerbot/internal/store/push"
	"github.com/korjavin/medicationtrackerbot/internal/store/settings"
	"github.com/korjavin/medicationtrackerbot/internal/store/vitals"
	"github.com/korjavin/medicationtrackerbot/internal/store/weight"
	"github.com/korjavin/medicationtrackerbot/internal/store/workout"
)

//go:embed migrations/*.sql
var embedMigrations embed.FS

// EmbeddedMigrations exposes the embed.FS that owns the SQL migration files
// shipped with this package. It is exported so the composition root can
// supply it to (*db.DB).Migrate when it manages the DB lifecycle directly.
var EmbeddedMigrations = embedMigrations

// Dose-time columns convention (see docs/plans/2026-05-10-intake-log-utc-unix-fix.md
// and docs/architecture.md → "Time storage").
//
// The following columns are (or are being migrated to) INTEGER unix-seconds-UTC.
// SQL equality (WHERE col = ?) on these columns is unambiguous regardless of the
// caller's time.Location — which is the property that closes the TZ-name-equality
// bug class that has hit intake_log scheduling repeatedly:
//
//   - intake_log.scheduled_at_unix
//   - intake_log.taken_at_unix     (NULL until the dose is taken)
//   - intake_log.snoozed_until_unix (NULL unless snoozed)
//
// Write path: every writer normalizes at the store boundary via
// `t.UTC().Unix()`. `.UTC()` strips Go's monotonic-clock residue (which has
// previously leaked through t.String() into the DB) and forces the wall clock
// onto UTC.
//
// Read path: `Scan(&n int64)` then `time.Unix(n, 0).UTC()`. Nullable columns
// scan into `sql.NullInt64`; populate pointer fields only when Valid.
//
// The architecture test `TestIntakeLogTimeColumnsAreInteger` (see Task 7 of the
// fix plan) parses `PRAGMA table_info(intake_log)` and fails CI if any of these
// columns regresses to a DATETIME / TEXT storage type.

// Store is the legacy aggregate repository: a single struct with methods for
// every domain. It is being decomposed into per-domain repositories under
// internal/store/<domain>/ (see docs/plans/2026-05-13-split-store-package.md).
//
// New code should NOT add methods here — start a new package under
// internal/store/<feature>/ and follow the diary/push pattern instead.
//
// While the split is in progress, Store wraps the shared *db.DB and exposes
// per-domain methods via forwarders for backward compatibility. The db field
// remains spelled "db" so the ~111 existing s.db.Query/Exec/BeginTx callsites
// keep compiling unchanged (embedded *sql.DB methods are promoted).
type Store struct {
	db       *storedb.DB
	diary    *diary.Repo
	push     *push.Repo
	auth     *auth.Repo
	vitals   *vitals.Repo
	settings *settings.Repo
	bp       *bp.Repo
	weight   *weight.Repo
	food     *food.Repo
	workout  *workout.Repo
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

// MedicationSchedule represents a combination of medication ID and target time
// for batch fetching intakes.
type MedicationSchedule struct {
	MedID       int64
	ScheduledAt time.Time
}

type IntakeWithMedication struct {
	IntakeLog
	MedicationName   string `json:"medication_name"`
	MedicationDosage string `json:"medication_dosage"`
}

// BloodPressure is an alias for the canonical type defined in
// internal/store/bp. Kept here so existing references (server BP handlers,
// MCP cardiovascular tools, bot BP callbacks, narrow consumer interfaces,
// importer, demo seeder, tests) continue to compile during the per-domain
// split; new code should depend on bp.BloodPressure directly.
type BloodPressure = bp.BloodPressure

// BPGoal is an alias for the canonical type defined in internal/store/bp.
// New code should depend on bp.BPGoal directly.
type BPGoal = bp.BPGoal

// BPStats is an alias for the canonical type defined in internal/store/bp.
// New code should depend on bp.BPStats directly.
type BPStats = bp.BPStats

// BPPeriodStats is an alias for the canonical type defined in
// internal/store/bp. New code should depend on bp.BPPeriodStats directly.
type BPPeriodStats = bp.BPPeriodStats

// BPReminderState is an alias for the canonical type defined in
// internal/store/bp. New code should depend on bp.BPReminderState directly.
type BPReminderState = bp.BPReminderState

// WeightLog is an alias for the canonical type defined in
// internal/store/weight. Kept here so existing references (server weight
// handlers, MCP weight tools, bot weight callbacks, narrow consumer
// interfaces, importer, demo seeder, tests) continue to compile during the
// per-domain split; new code should depend on weight.WeightLog directly.
type WeightLog = weight.WeightLog

// WeightReminderState is an alias for the canonical type defined in
// internal/store/weight. New code should depend on weight.WeightReminderState
// directly.
type WeightReminderState = weight.WeightReminderState

// SleepLog is an alias for the canonical type defined in internal/store/vitals.
// Kept here so existing references (server health handlers, MCP cardiovascular
// tools, bot sleep importer, tests) continue to compile during the per-domain
// split; new code should depend on vitals.SleepLog directly.
type SleepLog = vitals.SleepLog

// DayStat is an alias for the canonical type defined in internal/store/vitals.
// Kept here so existing references (server health handlers, MCP fitness tools,
// bot sleep importer, tests) continue to compile during the per-domain split;
// new code should depend on vitals.DayStat directly.
type DayStat = vitals.DayStat

// VitalsHeartLog is an alias for the canonical type defined in
// internal/store/vitals. New code should depend on vitals.VitalsHeartLog
// directly.
type VitalsHeartLog = vitals.VitalsHeartLog

// VitalsSpO2Log is an alias for the canonical type defined in
// internal/store/vitals. New code should depend on vitals.VitalsSpO2Log
// directly.
type VitalsSpO2Log = vitals.VitalsSpO2Log

// VitalsStressLog is an alias for the canonical type defined in
// internal/store/vitals. New code should depend on vitals.VitalsStressLog
// directly.
type VitalsStressLog = vitals.VitalsStressLog

// FoodTargets is an alias for the canonical type defined in
// internal/store/food. Kept here so existing references (server food
// handlers, MCP food tools, bot food commands, narrow consumer interfaces,
// demo seeder, tests) continue to compile during the per-domain split; new
// code should depend on food.FoodTargets directly.
type FoodTargets = food.FoodTargets

// DiaryNote is an alias for the canonical type defined in
// internal/store/diary. Kept here so existing references (handlers, MCP, tests)
// continue to compile during the per-domain split; new code should depend on
// diary.DiaryNote directly.
type DiaryNote = diary.DiaryNote

// PushSubscription is an alias for the canonical type defined in
// internal/store/push. Kept here so existing references (server, webpush,
// tests) continue to compile during the per-domain split; new code should
// depend on push.PushSubscription directly.
type PushSubscription = push.PushSubscription

// APIToken is an alias for the canonical type defined in internal/store/auth.
// Kept here so existing references (MCP admin handler, OAuth middleware,
// tests) continue to compile during the per-domain split; new code should
// depend on auth.APIToken directly.
type APIToken = auth.APIToken

// CalculateBPCategory returns the ISH 2020 classification.
// Deprecated: prefer domain.CalculateBPCategory for new code.
// CalculateBPCategory is a forwarder to bp.CalculateBPCategory. New code
// should call the bp package function directly.
func CalculateBPCategory(systolic, diastolic int) string {
	return bp.CalculateBPCategory(systolic, diastolic)
}

// CategorySeverity is a forwarder to bp.CategorySeverity. New code should
// call the bp package function directly.
func CategorySeverity(category string) int {
	return bp.CategorySeverity(category)
}

// New opens a SQLite database at dbPath, runs all migrations, and returns a
// ready-to-use Store. This is the convenience entry point for tests and the
// existing single-call command wiring; the per-domain split (see
// docs/plans/2026-05-13-split-store-package.md) eventually deprecates this in
// favor of composition-root code that calls db.Open and per-repo constructors
// directly.
func New(dbPath string) (*Store, error) {
	d, err := storedb.Open(dbPath)
	if err != nil {
		return nil, err
	}
	return NewWithDB(d)
}

// NewWithDB wraps a caller-supplied *db.DB in a Store and runs migrations.
// The composition root (cmd/bot, cmd/mcptool, cmd/seeddemo, cmd/bpimporter)
// uses this so a single *db.DB can be shared across per-domain repositories
// as they come online. Migrations are idempotent — calling NewWithDB more
// than once against the same *db.DB is harmless.
func NewWithDB(d *storedb.DB) (*Store, error) {
	if err := d.Migrate(embedMigrations, "migrations"); err != nil {
		return nil, fmt.Errorf("failed to migrate db: %w", err)
	}
	diaryRepo := diary.New(d)
	diaryRepo.SetClock(func() time.Time { return nowFunc() })
	pushRepo := push.New(d)
	authRepo := auth.New(d)
	authRepo.SetClock(func() time.Time { return nowFunc() })
	vitalsRepo := vitals.New(d)
	settingsRepo := settings.New(d)
	weightRepo := weight.New(d)
	foodRepo := food.New(d)
	workoutRepo := workout.New(d)
	s := &Store{
		db:       d,
		diary:    diaryRepo,
		push:     pushRepo,
		auth:     authRepo,
		vitals:   vitalsRepo,
		settings: settingsRepo,
		weight:   weightRepo,
		food:     foodRepo,
		workout:  workoutRepo,
	}
	// bp.Repo needs a TimezoneLookup for day-boundary calculations in
	// GetBPDailyWeightedStats. *Store still owns the timezone table until
	// Task 11, so it satisfies that interface today; after Task 11 the
	// composition root will pass *tz.Repo directly.
	bpRepo := bp.New(d, s)
	bpRepo.SetClock(func() time.Time { return nowFunc() })
	s.bp = bpRepo
	return s, nil
}

// Diary returns the per-domain diary repository. The legacy *Store still
// forwards CreateDiaryNote/ListDiaryNotes/DeleteDiaryNote to this same Repo;
// new callers should depend on *diary.Repo (or a narrow interface satisfied
// by it) and obtain it through this accessor.
func (s *Store) Diary() *diary.Repo {
	return s.diary
}

// Push returns the per-domain push subscription repository. The legacy
// *Store still forwards CreatePushSubscription / GetPushSubscriptions /
// DeletePushSubscription / DisablePushSubscription to this same Repo; new
// callers should depend on *push.Repo (or a narrow interface satisfied by
// it) and obtain it through this accessor.
func (s *Store) Push() *push.Repo {
	return s.push
}

// Auth returns the per-domain api_tokens + used_login_hashes repository.
// The legacy *Store still forwards CreateAPIToken / ListAPITokens /
// DeleteAPIToken / FindAPITokenByHash / TouchAPITokenLastUsed /
// TryUseLoginHash to this same Repo; new callers should depend on
// *auth.Repo (or a narrow interface satisfied by it) and obtain it through
// this accessor.
func (s *Store) Auth() *auth.Repo {
	return s.auth
}

// Vitals returns the per-domain sleep_logs + day_stats + vitals_* repository.
// The legacy *Store still forwards ImportSleepLogs / GetSleepLogs /
// ImportDayStats / GetDayStats / ImportVitals / GetVitalsHeart /
// GetVitalsSpO2 / GetVitalsStress to this same Repo; new callers should
// depend on *vitals.Repo (or a narrow interface satisfied by it) and obtain
// it through this accessor.
func (s *Store) Vitals() *vitals.Repo {
	return s.vitals
}

// BP returns the per-domain blood-pressure repository. The legacy *Store
// still forwards CreateBloodPressureReading / GetBloodPressureReadings /
// DeleteBloodPressureReading / ImportBloodPressureReadings / GetBPGoal /
// SetBPGoal / GetBPDailyWeightedStats / GetBPReminderState /
// SetBPReminderEnabled / SnoozeBPReminder / DontBugMeBPReminder /
// UpdateBPReminderNotificationSent / ClearBPReminderNotificationMessage /
// GetLastBPReading / GetDominantBPCategory / CalculatePreferredReminderHour /
// UpdatePreferredReminderHour / GetUsersForBPReminders /
// BatchGetBPReminderStates / BatchGetLastBPReadings to this same Repo; new
// callers should depend on *bp.Repo (or a narrow interface satisfied by it)
// and obtain it through this accessor.
func (s *Store) BP() *bp.Repo {
	return s.bp
}

// Settings returns the per-domain settings + change_events repository. The
// legacy *Store still forwards GetFoodIntakeEnabled / SetFoodIntakeEnabled /
// GetBloodPressureEnabled / SetBloodPressureEnabled / GetWeightEnabled /
// SetWeightEnabled / GetMedicationEnabled / SetMedicationEnabled /
// GetWorkoutEnabled / SetWorkoutEnabled / GetHealthEnabled / SetHealthEnabled /
// GetTabOrder / SetTabOrder / GetLastDownload / UpdateLastDownload /
// GetLatestChangeCursor / GetChangedTagsSince / PruneChangeEvents to this
// same Repo; new callers should depend on *settings.Repo (or a narrow
// interface satisfied by it) and obtain it through this accessor.
func (s *Store) Settings() *settings.Repo {
	return s.settings
}

// Weight returns the per-domain weight repository. The legacy *Store still
// forwards CreateWeightLog / GetWeightLogs / DeleteWeightLog /
// GetLastWeightLog / GetLastWeightLogExcluding / GetHighestWeightRecord /
// BatchGetLastWeightLogs / GetWeightGoal / SetWeightGoal /
// GetWeightUnitPreference / SetWeightUnitPreference /
// GetWeightReminderState / SetWeightReminderEnabled / SnoozeWeightReminder /
// DontBugMeWeightReminder / UpdateWeightReminderNotificationSent /
// ClearWeightReminderNotificationMessage /
// CalculatePreferredWeightReminderHour / UpdatePreferredWeightReminderHour /
// GetUsersForWeightReminders / GetWeightReminderStates to this same Repo;
// new callers should depend on *weight.Repo (or a narrow interface satisfied
// by it) and obtain it through this accessor.
func (s *Store) Weight() *weight.Repo {
	return s.weight
}

// Food returns the per-domain food repository. The legacy *Store still
// forwards CreateFoodLog / UpdateFoodLog / GetFoodLogs / DeleteFoodLog /
// GetFoodStats / GetFoodTargets / SetFoodTargets / UpsertFoodProduct /
// UpdateFoodProduct / DeleteFoodProduct / GetFoodProductByID /
// GetFoodProductByName / GetFoodProducts / SearchFoodProducts /
// SearchRemoteFoodAPI / CreateMealFromLogs to this same Repo; new callers
// should depend on *food.Repo (or a narrow interface satisfied by it) and
// obtain it through this accessor.
func (s *Store) Food() *food.Repo {
	return s.food
}

// Workout returns the per-domain workout repository (workout_groups,
// workout_variants, workout_exercises, workout_sessions, workout_exercise_logs,
// workout_rotation_state, workout_schedule_snapshots, exercise_library, plus
// the miband_workouts / miband_gps_tracks tables). The legacy *Store still
// forwards every workout / Mi Band method to this same Repo; new callers
// should depend on *workout.Repo (or a narrow interface satisfied by it) and
// obtain it through this accessor.
func (s *Store) Workout() *workout.Repo {
	return s.workout
}

func (s *Store) Close() error {
	return s.db.Close()
}

// DB exposes the underlying *sql.DB for internal tooling (importers, the
// demo seeder) that needs to issue raw SQL the public API does not cover.
// Application code should use the typed methods on Store instead.
func (s *Store) DB() *sql.DB {
	return s.db.DB
}

// SharedDB exposes the wrapping *db.DB so composition-root code can pass it
// into per-domain repository constructors as they land. Prefer this over DB()
// for any new code under cmd/.
func (s *Store) SharedDB() *storedb.DB {
	return s.db
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
			MAX(CASE WHEN l.status = 'TAKEN' THEN l.taken_at_unix ELSE NULL END) as last_taken_unix
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
		var lastTakenUnix sql.NullInt64
		// Handle nullable fields
		var rxcui, normalizedName sql.NullString
		var inventoryCount sql.NullInt64

		if err := rows.Scan(&m.ID, &m.Name, &m.Dosage, &m.Schedule, &m.Archived, &m.Supplement, &m.StartDate, &m.EndDate, &m.CreatedAt, &rxcui, &normalizedName, &inventoryCount, &m.TZShiftPolicy, &lastTakenUnix); err != nil {
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

		if lastTakenUnix.Valid {
			t := time.Unix(lastTakenUnix.Int64, 0).UTC()
			m.LastTakenAt = &t
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
	res, err := s.db.Exec("INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, status) VALUES (?, ?, ?, 'PENDING')",
		medID, userID, scheduledAt.UTC().Unix())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) CreateManualIntake(medID, userID int64, takenAt time.Time) (int64, error) {
	// For manual intake, scheduled_at_unix = taken_at unix seconds.
	takenUnix := takenAt.UTC().Unix()
	res, err := s.db.Exec("INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, taken_at_unix, status) VALUES (?, ?, ?, ?, 'TAKEN')",
		medID, userID, takenUnix, takenUnix)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) ConfirmIntake(id int64, takenAt time.Time) error {
	res, err := s.db.Exec("UPDATE intake_log SET status = 'TAKEN', taken_at_unix = ? WHERE id = ? AND status = 'PENDING'",
		takenAt.UTC().Unix(), id)
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
	res, err := s.db.Exec("UPDATE intake_log SET status = 'SKIPPED', taken_at_unix = NULL WHERE id = ? AND status = 'PENDING'", id)
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
	var takenAtUnixVal interface{}
	if status == "TAKEN" {
		takenAtUnixVal = takenAt.UTC().Unix()
	} else {
		takenAtUnixVal = nil
	}
	_, err := s.db.Exec("UPDATE intake_log SET status = ?, taken_at_unix = ? WHERE id = ?", status, takenAtUnixVal, id)
	return err
}

func (s *Store) SnoozeIntake(id int64, snoozeUntil time.Time) error {
	res, err := s.db.Exec("UPDATE intake_log SET snoozed_until_unix = ? WHERE id = ? AND status = 'PENDING'",
		snoozeUntil.UTC().Unix(), id)
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
	rows, err := s.db.Query("SELECT id, medication_id, user_id, scheduled_at_unix, status, snoozed_until_unix FROM intake_log WHERE status = 'PENDING'")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	logs := []IntakeLog{}
	for rows.Next() {
		var l IntakeLog
		var schedUnix int64
		var snoozeUnix sql.NullInt64
		if err := rows.Scan(&l.ID, &l.MedicationID, &l.UserID, &schedUnix, &l.Status, &snoozeUnix); err != nil {
			return nil, err
		}
		l.ScheduledAt = time.Unix(schedUnix, 0).UTC()
		if snoozeUnix.Valid {
			t := time.Unix(snoozeUnix.Int64, 0).UTC()
			l.SnoozedUntil = &t
		}
		logs = append(logs, l)
	}
	return logs, nil
}

func (s *Store) GetTakenIntakesBySchedule(userID int64, scheduledAt time.Time) ([]IntakeLog, error) {
	rows, err := s.db.Query("SELECT id, medication_id, user_id, scheduled_at_unix, status, snoozed_until_unix FROM intake_log WHERE user_id = ? AND scheduled_at_unix = ? AND status = 'TAKEN'", userID, scheduledAt.UTC().Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	logs := []IntakeLog{}
	for rows.Next() {
		var l IntakeLog
		var schedUnix int64
		var snoozeUnix sql.NullInt64
		if err := rows.Scan(&l.ID, &l.MedicationID, &l.UserID, &schedUnix, &l.Status, &snoozeUnix); err != nil {
			return nil, err
		}
		l.ScheduledAt = time.Unix(schedUnix, 0).UTC()
		if snoozeUnix.Valid {
			t := time.Unix(snoozeUnix.Int64, 0).UTC()
			l.SnoozedUntil = &t
		}
		logs = append(logs, l)
	}
	return logs, nil
}

func (s *Store) GetIntakeHistory(medID int, days int) ([]IntakeLog, error) {
	query := "SELECT id, medication_id, user_id, scheduled_at_unix, taken_at_unix, status, snoozed_until_unix FROM intake_log WHERE 1=1"
	args := []interface{}{}

	if medID > 0 {
		query += " AND medication_id = ?"
		args = append(args, medID)
	}

	if days > 0 {
		since := time.Now().Add(-time.Duration(days) * 24 * time.Hour)
		query += " AND scheduled_at_unix >= ?"
		args = append(args, since.UTC().Unix())
	}

	query += " ORDER BY scheduled_at_unix DESC LIMIT 100"

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	logs := []IntakeLog{}
	for rows.Next() {
		var l IntakeLog
		var schedUnix int64
		var takenUnix sql.NullInt64
		var snoozeUnix sql.NullInt64
		if err := rows.Scan(&l.ID, &l.MedicationID, &l.UserID, &schedUnix, &takenUnix, &l.Status, &snoozeUnix); err != nil {
			return nil, err
		}
		l.ScheduledAt = time.Unix(schedUnix, 0).UTC()
		if takenUnix.Valid {
			t := time.Unix(takenUnix.Int64, 0).UTC()
			l.TakenAt = &t
		}
		if snoozeUnix.Valid {
			t := time.Unix(snoozeUnix.Int64, 0).UTC()
			l.SnoozedUntil = &t
		}
		logs = append(logs, l)
	}
	return logs, nil
}

func (s *Store) GetIntake(id int64) (*IntakeLog, error) {
	var l IntakeLog
	var schedUnix int64
	var takenUnix sql.NullInt64
	var snoozeUnix sql.NullInt64
	err := s.db.QueryRow("SELECT id, medication_id, user_id, scheduled_at_unix, taken_at_unix, status, snoozed_until_unix FROM intake_log WHERE id = ?", id).Scan(
		&l.ID, &l.MedicationID, &l.UserID, &schedUnix, &takenUnix, &l.Status, &snoozeUnix,
	)
	if err == sql.ErrNoRows {
		return nil, nil // Not found
	}
	if err != nil {
		return nil, err
	}
	l.ScheduledAt = time.Unix(schedUnix, 0).UTC()
	if takenUnix.Valid {
		t := time.Unix(takenUnix.Int64, 0).UTC()
		l.TakenAt = &t
	}
	if snoozeUnix.Valid {
		t := time.Unix(snoozeUnix.Int64, 0).UTC()
		l.SnoozedUntil = &t
	}
	return &l, nil
}

func (s *Store) GetIntakeBySchedule(medID int64, scheduledAt time.Time) (*IntakeLog, error) {
	var l IntakeLog
	var schedUnix int64
	var takenUnix sql.NullInt64
	var snoozeUnix sql.NullInt64
	err := s.db.QueryRow("SELECT id, medication_id, user_id, scheduled_at_unix, taken_at_unix, status, snoozed_until_unix FROM intake_log WHERE medication_id = ? AND scheduled_at_unix = ?", medID, scheduledAt.UTC().Unix()).Scan(
		&l.ID, &l.MedicationID, &l.UserID, &schedUnix, &takenUnix, &l.Status, &snoozeUnix,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	l.ScheduledAt = time.Unix(schedUnix, 0).UTC()
	if takenUnix.Valid {
		t := time.Unix(takenUnix.Int64, 0).UTC()
		l.TakenAt = &t
	}
	if snoozeUnix.Valid {
		t := time.Unix(snoozeUnix.Int64, 0).UTC()
		l.SnoozedUntil = &t
	}
	return &l, nil
}

func (s *Store) BatchGetIntakesBySchedule(schedules []MedicationSchedule) (map[MedicationSchedule]*IntakeLog, error) {
	result := make(map[MedicationSchedule]*IntakeLog, len(schedules))
	if len(schedules) == 0 {
		return result, nil
	}

	// SQLite maximum variables is typically 32766, but we'll use a conservative batch size
	// Each tuple (medication_id, scheduled_at_unix) uses 2 variables.
	// 500 schedules * 2 = 1000 variables per batch.
	const batchSize = 500

	for i := 0; i < len(schedules); i += batchSize {
		end := i + batchSize
		if end > len(schedules) {
			end = len(schedules)
		}

		batch := schedules[i:end]
		placeholders := make([]string, len(batch))
		args := make([]interface{}, len(batch)*2)

		for j, sched := range batch {
			placeholders[j] = "(?, ?)"
			args[j*2] = sched.MedID
			args[j*2+1] = sched.ScheduledAt.UTC().Unix()
		}

		query := fmt.Sprintf(
			"SELECT id, medication_id, user_id, scheduled_at_unix, taken_at_unix, status, snoozed_until_unix FROM intake_log WHERE (medication_id, scheduled_at_unix) IN (%s)",
			strings.Join(placeholders, ", "),
		)

		rows, err := s.db.Query(query, args...)
		if err != nil {
			return nil, err
		}

		for rows.Next() {
			var l IntakeLog
			var schedUnix int64
			var takenUnix sql.NullInt64
			var snoozeUnix sql.NullInt64
			err := rows.Scan(
				&l.ID, &l.MedicationID, &l.UserID, &schedUnix, &takenUnix, &l.Status, &snoozeUnix,
			)
			if err != nil {
				rows.Close()
				return nil, err
			}
			l.ScheduledAt = time.Unix(schedUnix, 0).UTC()
			if takenUnix.Valid {
				t := time.Unix(takenUnix.Int64, 0).UTC()
				l.TakenAt = &t
			}
			if snoozeUnix.Valid {
				t := time.Unix(snoozeUnix.Int64, 0).UTC()
				l.SnoozedUntil = &t
			}
			// Key by UTC. Callers that look up with a non-UTC ScheduledAt
			// must convert via .UTC() — the scheduler dedupe path already
			// does so.
			result[MedicationSchedule{MedID: l.MedicationID, ScheduledAt: l.ScheduledAt}] = &l
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		rows.Close()
	}

	return result, nil
}

// ConfirmIntakesBySchedule marks every PENDING intake whose scheduled_at_unix
// matches the supplied target as TAKEN, returning the IDs that were updated.
// The comparison is on the INTEGER scheduled_at_unix column, so it is
// independent of the caller's time.Location — what previously required an
// in-memory time.Equal filter (modernc.org/sqlite serialized time.Time via
// t.String() with embedded TZ name, breaking SQL text equality across
// locations) is now a single SQL predicate.
func (s *Store) ConfirmIntakesBySchedule(userID int64, scheduledAt time.Time, takenAt time.Time) ([]int64, error) {
	candidates, err := s.GetPendingIntakesBySchedule(userID, scheduledAt)
	if err != nil {
		return nil, err
	}

	var ids []int64
	for _, c := range candidates {
		// ConfirmIntake guards on status='PENDING', so a concurrent confirm
		// returns sql.ErrNoRows here — treat that as "already taken" and skip
		// instead of failing the batch.
		if err := s.ConfirmIntake(c.ID, takenAt); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			return nil, err
		}
		ids = append(ids, c.ID)
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

func (s *Store) GetBatchIntakeReminders(intakeIDs []int64) (map[int64][]int, error) {
	if len(intakeIDs) == 0 {
		return make(map[int64][]int), nil
	}

	result := make(map[int64][]int)

	chunkSize := 500
	for i := 0; i < len(intakeIDs); i += chunkSize {
		end := i + chunkSize
		if end > len(intakeIDs) {
			end = len(intakeIDs)
		}
		chunk := intakeIDs[i:end]

		args := make([]interface{}, len(chunk))
		placeholders := make([]string, len(chunk))
		for j, id := range chunk {
			args[j] = id
			placeholders[j] = "?"
		}

		query := fmt.Sprintf("SELECT intake_id, message_id FROM intake_reminders WHERE intake_id IN (%s)", strings.Join(placeholders, ","))
		rows, err := s.db.Query(query, args...)
		if err != nil {
			return nil, err
		}

		for rows.Next() {
			var intakeID int64
			var msgID int
			if err := rows.Scan(&intakeID, &msgID); err != nil {
				rows.Close()
				return nil, err
			}
			result[intakeID] = append(result[intakeID], msgID)
		}

		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}

	return result, nil
}

// GetPendingIntakesBySchedule returns every PENDING intake for the user whose
// scheduled_at_unix matches the supplied target instant. The match is on the
// INTEGER unix-seconds column, so it is independent of the caller's
// time.Location.
func (s *Store) GetPendingIntakesBySchedule(userID int64, scheduledAt time.Time) ([]IntakeLog, error) {
	rows, err := s.db.Query(
		`SELECT id, medication_id, user_id, scheduled_at_unix, status, snoozed_until_unix
		 FROM intake_log
		 WHERE user_id = ? AND status = 'PENDING'
		   AND scheduled_at_unix = ?
		   AND medication_id IN (SELECT id FROM medications WHERE archived = 0)`,
		userID, scheduledAt.UTC().Unix(),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var logs []IntakeLog
	for rows.Next() {
		var l IntakeLog
		var schedUnix int64
		var snoozeUnix sql.NullInt64
		if err := rows.Scan(&l.ID, &l.MedicationID, &l.UserID, &schedUnix, &l.Status, &snoozeUnix); err != nil {
			return nil, err
		}
		l.ScheduledAt = time.Unix(schedUnix, 0).UTC()
		if snoozeUnix.Valid {
			t := time.Unix(snoozeUnix.Int64, 0).UTC()
			l.SnoozedUntil = &t
		}
		logs = append(logs, l)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return logs, nil
}

func (s *Store) GetPendingIntakesForMedication(medID int64) ([]IntakeLog, error) {
	rows, err := s.db.Query("SELECT id, medication_id, user_id, scheduled_at_unix, status, snoozed_until_unix FROM intake_log WHERE medication_id = ? AND status = 'PENDING'", medID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var logs []IntakeLog
	for rows.Next() {
		var l IntakeLog
		var schedUnix int64
		var snoozeUnix sql.NullInt64
		if err := rows.Scan(&l.ID, &l.MedicationID, &l.UserID, &schedUnix, &l.Status, &snoozeUnix); err != nil {
			return nil, err
		}
		l.ScheduledAt = time.Unix(schedUnix, 0).UTC()
		if snoozeUnix.Valid {
			t := time.Unix(snoozeUnix.Int64, 0).UTC()
			l.SnoozedUntil = &t
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

// GetLastDownload forwards to (*settings.Repo).GetLastDownload.
func (s *Store) GetLastDownload() (time.Time, error) {
	return s.settings.GetLastDownload()
}

// UpdateLastDownload forwards to (*settings.Repo).UpdateLastDownload.
func (s *Store) UpdateLastDownload(t time.Time) error {
	return s.settings.UpdateLastDownload(t)
}

// WeightGoal is an alias for the canonical type defined in
// internal/store/weight. New code should depend on weight.WeightGoal directly.
type WeightGoal = weight.WeightGoal

// GetWeightGoal forwards to (*weight.Repo).GetWeightGoal.
func (s *Store) GetWeightGoal() (*WeightGoal, error) {
	return s.weight.GetWeightGoal()
}

// SetWeightGoal forwards to (*weight.Repo).SetWeightGoal.
func (s *Store) SetWeightGoal(weightVal float64, targetDate time.Time) error {
	return s.weight.SetWeightGoal(weightVal, targetDate)
}

// -- Downloads --

func (s *Store) GetIntakesSince(since time.Time) ([]IntakeWithMedication, error) {
	query := `
		SELECT
			il.id, il.medication_id, il.user_id, il.scheduled_at_unix, il.taken_at_unix, il.status, il.snoozed_until_unix,
			m.name AS medication_name, m.dosage AS medication_dosage
		FROM intake_log il
		JOIN medications m ON il.medication_id = m.id
		WHERE il.scheduled_at_unix >= ?
		ORDER BY il.scheduled_at_unix DESC
	`
	rows, err := s.db.Query(query, since.UTC().Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []IntakeWithMedication
	for rows.Next() {
		var l IntakeWithMedication
		var schedUnix int64
		var takenUnix sql.NullInt64
		var snoozeUnix sql.NullInt64
		if err := rows.Scan(&l.ID, &l.MedicationID, &l.UserID, &schedUnix, &takenUnix, &l.Status, &snoozeUnix, &l.MedicationName, &l.MedicationDosage); err != nil {
			return nil, err
		}
		l.ScheduledAt = time.Unix(schedUnix, 0).UTC()
		if takenUnix.Valid {
			t := time.Unix(takenUnix.Int64, 0).UTC()
			l.TakenAt = &t
		}
		if snoozeUnix.Valid {
			t := time.Unix(snoozeUnix.Int64, 0).UTC()
			l.SnoozedUntil = &t
		}
		logs = append(logs, l)
	}
	return logs, nil
}

// -- Blood Pressure (forwarders to internal/store/bp.Repo) --

// GetBPGoal forwards to (*bp.Repo).GetBPGoal.
func (s *Store) GetBPGoal() (*BPGoal, error) {
	return s.bp.GetBPGoal()
}

// SetBPGoal forwards to (*bp.Repo).SetBPGoal.
func (s *Store) SetBPGoal(targetSystolic, targetDiastolic int) error {
	return s.bp.SetBPGoal(targetSystolic, targetDiastolic)
}

// CreateBloodPressureReading forwards to (*bp.Repo).CreateBloodPressureReading.
func (s *Store) CreateBloodPressureReading(ctx context.Context, reading *BloodPressure) (int64, error) {
	return s.bp.CreateBloodPressureReading(ctx, reading)
}

// GetBloodPressureReadings forwards to (*bp.Repo).GetBloodPressureReadings.
func (s *Store) GetBloodPressureReadings(ctx context.Context, userID int64, since time.Time) ([]BloodPressure, error) {
	return s.bp.GetBloodPressureReadings(ctx, userID, since)
}

// DeleteBloodPressureReading forwards to (*bp.Repo).DeleteBloodPressureReading.
func (s *Store) DeleteBloodPressureReading(ctx context.Context, id, userID int64) error {
	return s.bp.DeleteBloodPressureReading(ctx, id, userID)
}

// ImportBloodPressureReadings forwards to (*bp.Repo).ImportBloodPressureReadings.
func (s *Store) ImportBloodPressureReadings(ctx context.Context, userID int64, readings []BloodPressure) error {
	return s.bp.ImportBloodPressureReadings(ctx, userID, readings)
}

// GetBPDailyWeightedStats forwards to (*bp.Repo).GetBPDailyWeightedStats.
func (s *Store) GetBPDailyWeightedStats(ctx context.Context, userID int64) (*BPStats, error) {
	return s.bp.GetBPDailyWeightedStats(ctx, userID)
}

// GetBPReminderState forwards to (*bp.Repo).GetBPReminderState.
func (s *Store) GetBPReminderState(userID int64) (*BPReminderState, error) {
	return s.bp.GetBPReminderState(userID)
}

// SetBPReminderEnabled forwards to (*bp.Repo).SetBPReminderEnabled.
func (s *Store) SetBPReminderEnabled(userID int64, enabled bool) error {
	return s.bp.SetBPReminderEnabled(userID, enabled)
}

// SnoozeBPReminder forwards to (*bp.Repo).SnoozeBPReminder.
func (s *Store) SnoozeBPReminder(userID int64) error {
	return s.bp.SnoozeBPReminder(userID)
}

// DontBugMeBPReminder forwards to (*bp.Repo).DontBugMeBPReminder.
func (s *Store) DontBugMeBPReminder(userID int64) error {
	return s.bp.DontBugMeBPReminder(userID)
}

// UpdateBPReminderNotificationSent forwards to (*bp.Repo).UpdateBPReminderNotificationSent.
func (s *Store) UpdateBPReminderNotificationSent(userID int64, messageID *int) error {
	return s.bp.UpdateBPReminderNotificationSent(userID, messageID)
}

// ClearBPReminderNotificationMessage forwards to (*bp.Repo).ClearBPReminderNotificationMessage.
func (s *Store) ClearBPReminderNotificationMessage(userID int64) error {
	return s.bp.ClearBPReminderNotificationMessage(userID)
}

// GetLastBPReading forwards to (*bp.Repo).GetLastBPReading.
func (s *Store) GetLastBPReading(ctx context.Context, userID int64) (*BloodPressure, error) {
	return s.bp.GetLastBPReading(ctx, userID)
}

// GetDominantBPCategory forwards to (*bp.Repo).GetDominantBPCategory.
func (s *Store) GetDominantBPCategory(ctx context.Context, userID int64) (string, error) {
	return s.bp.GetDominantBPCategory(ctx, userID)
}

// CalculatePreferredReminderHour forwards to (*bp.Repo).CalculatePreferredReminderHour.
func (s *Store) CalculatePreferredReminderHour(ctx context.Context, userID int64) (int, error) {
	return s.bp.CalculatePreferredReminderHour(ctx, userID)
}

// UpdatePreferredReminderHour forwards to (*bp.Repo).UpdatePreferredReminderHour.
func (s *Store) UpdatePreferredReminderHour(userID int64, hour int) error {
	return s.bp.UpdatePreferredReminderHour(userID, hour)
}

// GetUsersForBPReminders forwards to (*bp.Repo).GetUsersForBPReminders.
func (s *Store) GetUsersForBPReminders() ([]int64, error) {
	return s.bp.GetUsersForBPReminders()
}

// BatchGetBPReminderStates forwards to (*bp.Repo).BatchGetBPReminderStates.
func (s *Store) BatchGetBPReminderStates(ctx context.Context, userIDs []int64) (map[int64]*BPReminderState, error) {
	return s.bp.BatchGetBPReminderStates(ctx, userIDs)
}

// BatchGetLastBPReadings forwards to (*bp.Repo).BatchGetLastBPReadings.
func (s *Store) BatchGetLastBPReadings(ctx context.Context, userIDs []int64) (map[int64]*BloodPressure, error) {
	return s.bp.BatchGetLastBPReadings(ctx, userIDs)
}

// -- Weight Tracking (forwarders to internal/store/weight.Repo) --

// CreateWeightLog forwards to (*weight.Repo).CreateWeightLog.
func (s *Store) CreateWeightLog(ctx context.Context, w *WeightLog) (int64, error) {
	return s.weight.CreateWeightLog(ctx, w)
}

// GetWeightLogs forwards to (*weight.Repo).GetWeightLogs.
func (s *Store) GetWeightLogs(ctx context.Context, userID int64, since time.Time) ([]WeightLog, error) {
	return s.weight.GetWeightLogs(ctx, userID, since)
}

// DeleteWeightLog forwards to (*weight.Repo).DeleteWeightLog.
func (s *Store) DeleteWeightLog(ctx context.Context, id, userID int64) error {
	return s.weight.DeleteWeightLog(ctx, id, userID)
}

// GetLastWeightLog forwards to (*weight.Repo).GetLastWeightLog.
func (s *Store) GetLastWeightLog(ctx context.Context, userID int64) (*WeightLog, error) {
	return s.weight.GetLastWeightLog(ctx, userID)
}

// GetLastWeightLogExcluding forwards to (*weight.Repo).GetLastWeightLogExcluding.
func (s *Store) GetLastWeightLogExcluding(ctx context.Context, userID, excludeID int64) (*WeightLog, error) {
	return s.weight.GetLastWeightLogExcluding(ctx, userID, excludeID)
}

// GetHighestWeightRecord forwards to (*weight.Repo).GetHighestWeightRecord.
func (s *Store) GetHighestWeightRecord(ctx context.Context, userID int64) (*WeightLog, error) {
	return s.weight.GetHighestWeightRecord(ctx, userID)
}

// CalculateWeightTrend forwards to weight.CalculateWeightTrend. New code
// should call the weight package function directly.
// Deprecated: prefer domain.CalculateWeightTrend for new code.
func CalculateWeightTrend(currentWeight float64, previousTrend *float64) float64 {
	return weight.CalculateWeightTrend(currentWeight, previousTrend)
}

// ImportSleepLogs forwards to (*vitals.Repo).ImportSleepLogs.
func (s *Store) ImportSleepLogs(ctx context.Context, userID int64, logs []SleepLog) (int, int, error) {
	return s.vitals.ImportSleepLogs(ctx, userID, logs)
}

// ImportDayStats forwards to (*vitals.Repo).ImportDayStats.
func (s *Store) ImportDayStats(ctx context.Context, userID int64, stats []DayStat) (int, int, error) {
	return s.vitals.ImportDayStats(ctx, userID, stats)
}

// GetDayStats forwards to (*vitals.Repo).GetDayStats.
func (s *Store) GetDayStats(ctx context.Context, userID int64, since time.Time) ([]DayStat, error) {
	return s.vitals.GetDayStats(ctx, userID, since)
}

// GetSleepLogs forwards to (*vitals.Repo).GetSleepLogs.
func (s *Store) GetSleepLogs(ctx context.Context, userID int64, since time.Time) ([]SleepLog, error) {
	return s.vitals.GetSleepLogs(ctx, userID, since)
}

// ImportVitals forwards to (*vitals.Repo).ImportVitals.
func (s *Store) ImportVitals(ctx context.Context, userID int64, heartLogs []VitalsHeartLog, spo2Logs []VitalsSpO2Log, stressLogs []VitalsStressLog) (int, int, error) {
	return s.vitals.ImportVitals(ctx, userID, heartLogs, spo2Logs, stressLogs)
}

// GetVitalsHeart forwards to (*vitals.Repo).GetVitalsHeart.
func (s *Store) GetVitalsHeart(ctx context.Context, userID int64, start, end time.Time) ([]VitalsHeartLog, error) {
	return s.vitals.GetVitalsHeart(ctx, userID, start, end)
}

// GetVitalsSpO2 forwards to (*vitals.Repo).GetVitalsSpO2.
func (s *Store) GetVitalsSpO2(ctx context.Context, userID int64, start, end time.Time) ([]VitalsSpO2Log, error) {
	return s.vitals.GetVitalsSpO2(ctx, userID, start, end)
}

// GetVitalsStress forwards to (*vitals.Repo).GetVitalsStress.
func (s *Store) GetVitalsStress(ctx context.Context, userID int64, start, end time.Time) ([]VitalsStressLog, error) {
	return s.vitals.GetVitalsStress(ctx, userID, start, end)
}

// CreatePushSubscription forwards to (*push.Repo).Create.
func (s *Store) CreatePushSubscription(userID int64, endpoint, auth, p256dh string) error {
	return s.push.Create(userID, endpoint, auth, p256dh)
}

// GetPushSubscriptions forwards to (*push.Repo).List.
func (s *Store) GetPushSubscriptions(userID int64) ([]PushSubscription, error) {
	return s.push.List(userID)
}

// DeletePushSubscription forwards to (*push.Repo).Delete.
func (s *Store) DeletePushSubscription(endpoint string) error {
	return s.push.Delete(endpoint)
}

// DisablePushSubscription forwards to (*push.Repo).Disable.
func (s *Store) DisablePushSubscription(endpoint string) error {
	return s.push.Disable(endpoint)
}

// -- Food (forwarders to internal/store/food.Repo) --

// FoodLog is an alias for the canonical type defined in
// internal/store/food. Kept here so existing references (server food
// handlers, MCP food tools, bot food commands, demo seeder, narrow consumer
// interfaces, tests) continue to compile during the per-domain split; new
// code should depend on food.FoodLog directly.
type FoodLog = food.FoodLog

// FoodProduct is an alias for the canonical type defined in
// internal/store/food. New code should depend on food.FoodProduct directly.
type FoodProduct = food.FoodProduct

// OpenFoodFact is an alias for the canonical type defined in
// internal/store/food. New code should depend on food.OpenFoodFact directly.
type OpenFoodFact = food.OpenFoodFact

// FoodStats is an alias for the canonical type defined in
// internal/store/food. New code should depend on food.FoodStats directly.
type FoodStats = food.FoodStats

// FoodProductsFilter is an alias for the canonical type defined in
// internal/store/food. New code should depend on food.FoodProductsFilter
// directly.
type FoodProductsFilter = food.FoodProductsFilter

// UpsertFoodProduct forwards to (*food.Repo).UpsertFoodProduct.
func (s *Store) UpsertFoodProduct(ctx context.Context, p *FoodProduct) error {
	return s.food.UpsertFoodProduct(ctx, p)
}

// GetFoodProductByName forwards to (*food.Repo).GetFoodProductByName.
func (s *Store) GetFoodProductByName(ctx context.Context, userID int64, name string) (*FoodProduct, error) {
	return s.food.GetFoodProductByName(ctx, userID, name)
}

// GetFoodProductByID forwards to (*food.Repo).GetFoodProductByID.
func (s *Store) GetFoodProductByID(ctx context.Context, userID, id int64) (*FoodProduct, error) {
	return s.food.GetFoodProductByID(ctx, userID, id)
}

// UpdateFoodProduct forwards to (*food.Repo).UpdateFoodProduct.
func (s *Store) UpdateFoodProduct(ctx context.Context, p *FoodProduct) error {
	return s.food.UpdateFoodProduct(ctx, p)
}

// DeleteFoodProduct forwards to (*food.Repo).DeleteFoodProduct.
func (s *Store) DeleteFoodProduct(ctx context.Context, id, userID int64) error {
	return s.food.DeleteFoodProduct(ctx, id, userID)
}

// GetFoodProducts forwards to (*food.Repo).GetFoodProducts.
func (s *Store) GetFoodProducts(ctx context.Context, userID int64, filter FoodProductsFilter) ([]FoodProduct, int, error) {
	return s.food.GetFoodProducts(ctx, userID, filter)
}

// SearchFoodProducts forwards to (*food.Repo).SearchFoodProducts.
func (s *Store) SearchFoodProducts(ctx context.Context, userID int64, queryStr string) ([]FoodProduct, error) {
	return s.food.SearchFoodProducts(ctx, userID, queryStr)
}

// SearchRemoteFoodAPI forwards to (*food.Repo).SearchRemoteFoodAPI.
func (s *Store) SearchRemoteFoodAPI(ctx context.Context, query string) ([]FoodProduct, error) {
	return s.food.SearchRemoteFoodAPI(ctx, query)
}

// CreateMealFromLogs forwards to (*food.Repo).CreateMealFromLogs.
func (s *Store) CreateMealFromLogs(ctx context.Context, userID int64, name string, logIDs []int64) (*FoodProduct, error) {
	return s.food.CreateMealFromLogs(ctx, userID, name, logIDs)
}

// CreateFoodLog forwards to (*food.Repo).CreateFoodLog.
func (s *Store) CreateFoodLog(ctx context.Context, f *FoodLog) (int64, error) {
	return s.food.CreateFoodLog(ctx, f)
}

// UpdateFoodLog forwards to (*food.Repo).UpdateFoodLog.
func (s *Store) UpdateFoodLog(ctx context.Context, f *FoodLog) error {
	return s.food.UpdateFoodLog(ctx, f)
}

// GetFoodLogs forwards to (*food.Repo).GetFoodLogs.
func (s *Store) GetFoodLogs(ctx context.Context, userID int64, date time.Time, days int) ([]FoodLog, error) {
	return s.food.GetFoodLogs(ctx, userID, date, days)
}

// DeleteFoodLog forwards to (*food.Repo).DeleteFoodLog.
func (s *Store) DeleteFoodLog(ctx context.Context, id, userID int64) error {
	return s.food.DeleteFoodLog(ctx, id, userID)
}

// GetFoodStats forwards to (*food.Repo).GetFoodStats.
func (s *Store) GetFoodStats(ctx context.Context, userID int64, endDate time.Time, days int) (*FoodStats, error) {
	return s.food.GetFoodStats(ctx, userID, endDate, days)
}

// GetFoodTargets forwards to (*food.Repo).GetFoodTargets.
func (s *Store) GetFoodTargets(ctx context.Context) (FoodTargets, error) {
	return s.food.GetFoodTargets(ctx)
}

// SetFoodTargets forwards to (*food.Repo).SetFoodTargets.
func (s *Store) SetFoodTargets(ctx context.Context, targets FoodTargets) error {
	return s.food.SetFoodTargets(ctx, targets)
}

// GetFoodIntakeEnabled forwards to (*settings.Repo).GetFoodIntakeEnabled.
func (s *Store) GetFoodIntakeEnabled(ctx context.Context) (bool, error) {
	return s.settings.GetFoodIntakeEnabled(ctx)
}

// SetFoodIntakeEnabled forwards to (*settings.Repo).SetFoodIntakeEnabled.
func (s *Store) SetFoodIntakeEnabled(ctx context.Context, enabled bool) error {
	return s.settings.SetFoodIntakeEnabled(ctx, enabled)
}

// GetBloodPressureEnabled forwards to (*settings.Repo).GetBloodPressureEnabled.
func (s *Store) GetBloodPressureEnabled(ctx context.Context) (bool, error) {
	return s.settings.GetBloodPressureEnabled(ctx)
}

// SetBloodPressureEnabled forwards to (*settings.Repo).SetBloodPressureEnabled.
func (s *Store) SetBloodPressureEnabled(ctx context.Context, enabled bool) error {
	return s.settings.SetBloodPressureEnabled(ctx, enabled)
}

// GetWeightEnabled forwards to (*settings.Repo).GetWeightEnabled.
func (s *Store) GetWeightEnabled(ctx context.Context) (bool, error) {
	return s.settings.GetWeightEnabled(ctx)
}

// SetWeightEnabled forwards to (*settings.Repo).SetWeightEnabled.
func (s *Store) SetWeightEnabled(ctx context.Context, enabled bool) error {
	return s.settings.SetWeightEnabled(ctx, enabled)
}

// GetMedicationEnabled forwards to (*settings.Repo).GetMedicationEnabled.
func (s *Store) GetMedicationEnabled(ctx context.Context) (bool, error) {
	return s.settings.GetMedicationEnabled(ctx)
}

// SetMedicationEnabled forwards to (*settings.Repo).SetMedicationEnabled.
func (s *Store) SetMedicationEnabled(ctx context.Context, enabled bool) error {
	return s.settings.SetMedicationEnabled(ctx, enabled)
}

// GetWorkoutEnabled forwards to (*settings.Repo).GetWorkoutEnabled.
func (s *Store) GetWorkoutEnabled(ctx context.Context) (bool, error) {
	return s.settings.GetWorkoutEnabled(ctx)
}

// SetWorkoutEnabled forwards to (*settings.Repo).SetWorkoutEnabled.
func (s *Store) SetWorkoutEnabled(ctx context.Context, enabled bool) error {
	return s.settings.SetWorkoutEnabled(ctx, enabled)
}

// GetHealthEnabled forwards to (*settings.Repo).GetHealthEnabled.
func (s *Store) GetHealthEnabled(ctx context.Context) (bool, error) {
	return s.settings.GetHealthEnabled(ctx)
}

// SetHealthEnabled forwards to (*settings.Repo).SetHealthEnabled.
func (s *Store) SetHealthEnabled(ctx context.Context, enabled bool) error {
	return s.settings.SetHealthEnabled(ctx, enabled)
}

// GetTabOrder forwards to (*settings.Repo).GetTabOrder.
func (s *Store) GetTabOrder(ctx context.Context) (string, error) {
	return s.settings.GetTabOrder(ctx)
}

// SetTabOrder forwards to (*settings.Repo).SetTabOrder.
func (s *Store) SetTabOrder(ctx context.Context, order string) error {
	return s.settings.SetTabOrder(ctx, order)
}

// GetWeightUnitPreference forwards to (*weight.Repo).GetWeightUnitPreference.
func (s *Store) GetWeightUnitPreference(ctx context.Context) (string, error) {
	return s.weight.GetWeightUnitPreference(ctx)
}

// SetWeightUnitPreference forwards to (*weight.Repo).SetWeightUnitPreference.
func (s *Store) SetWeightUnitPreference(ctx context.Context, unit string) error {
	return s.weight.SetWeightUnitPreference(ctx, unit)
}

// CreateDiaryNote forwards to (*diary.Repo).Create. Kept on *Store so the
// pre-split callers (HTTP handler, MCP tools, bot command) compile unchanged;
// this forwarder is one of the last things deleted in Task 13.
func (s *Store) CreateDiaryNote(ctx context.Context, userID int64, content string, tag *string) (*DiaryNote, error) {
	return s.diary.Create(ctx, userID, content, tag)
}

// ListDiaryNotes forwards to (*diary.Repo).List.
func (s *Store) ListDiaryNotes(ctx context.Context, userID int64, since, until time.Time, limit int, beforeID int64) ([]DiaryNote, error) {
	return s.diary.List(ctx, userID, since, until, limit, beforeID)
}

// DeleteDiaryNote forwards to (*diary.Repo).Delete.
func (s *Store) DeleteDiaryNote(ctx context.Context, userID, noteID int64) error {
	return s.diary.Delete(ctx, userID, noteID)
}

// GetLatestChangeCursor forwards to (*settings.Repo).GetLatestChangeCursor.
func (s *Store) GetLatestChangeCursor(ctx context.Context) (int64, error) {
	return s.settings.GetLatestChangeCursor(ctx)
}

// GetChangedTagsSince forwards to (*settings.Repo).GetChangedTagsSince.
func (s *Store) GetChangedTagsSince(ctx context.Context, since int64) (int64, []string, error) {
	return s.settings.GetChangedTagsSince(ctx, since)
}

// PruneChangeEvents forwards to (*settings.Repo).PruneChangeEvents.
func (s *Store) PruneChangeEvents(ctx context.Context, keepLast, maxAgeDays int) error {
	return s.settings.PruneChangeEvents(ctx, keepLast, maxAgeDays)
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

// GetLatestCompletedTZTransitionPlan returns the most recent plan in
// COMPLETED status, or nil if none exists. The medication scheduler uses this
// as a fallback for the overlap-guard data once a plan transitions out of
// APPROVED — the previous tick that consumed the final step also flipped the
// status, so the next tick can no longer see the plan via
// GetLatestActiveOrPendingTZTransitionPlan and would otherwise lose the
// consumed-step times that suppress the just-superseded normal-schedule slots.
func (s *Store) GetLatestCompletedTZTransitionPlan() (*TZTransitionPlan, error) {
	var p TZTransitionPlan
	var notifiedAt, approvedAt sql.NullTime
	var userAction sql.NullString
	err := s.db.QueryRow(
		`SELECT id, old_tz, new_tz, created_at, status, steps_json, inputs_json, plan_hash, notified_at, approved_at, user_action
		 FROM tz_transition_plans
		 WHERE status = 'COMPLETED'
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

// GetLatestConsumedStepTimePerMed returns, for each medication that has at
// least one consumed step under the given plan, the latest scheduled-at time
// among those consumed steps. The medication scheduler uses this to suppress
// normal-schedule doses that overlap with a transition step the user has
// already taken: targets earlier than the consumed step belong to the old
// timezone, and targets within minInterval after it would fire a duplicate
// dose right on top of the just-completed transition.
//
// The query scans the column as a string and parses it manually because
// SQLite's aggregate result loses the DATETIME affinity and the driver then
// refuses to bind the resulting TEXT into time.Time directly. The values were
// originally written by Go's time formatter and round-trip cleanly.
func (s *Store) GetLatestConsumedStepTimePerMed(planID int64) (map[int64]time.Time, error) {
	rows, err := s.db.Query(
		`SELECT medication_id, MAX(scheduled_at)
		 FROM tz_transition_steps
		 WHERE plan_id = ? AND consumed_at IS NOT NULL
		 GROUP BY medication_id`,
		planID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[int64]time.Time)
	for rows.Next() {
		var medID int64
		var scheduledAtStr sql.NullString
		if err := rows.Scan(&medID, &scheduledAtStr); err != nil {
			return nil, err
		}
		if !scheduledAtStr.Valid {
			continue
		}
		t, parseErr := parseSQLiteDateTime(scheduledAtStr.String)
		if parseErr != nil {
			return nil, fmt.Errorf("parse scheduled_at %q for med %d: %w", scheduledAtStr.String, medID, parseErr)
		}
		out[medID] = t
	}
	return out, nil
}

// parseSQLiteDateTime parses the textual representation SQLite stores when a
// time.Time is bound through database/sql. The same value comes back as
// either RFC 3339 (when the driver wrote it) or a space-separated DATETIME
// (when SQLite-side functions like MAX() materialise the column). Try the
// most common forms in priority order.
func parseSQLiteDateTime(s string) (time.Time, error) {
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

// MarkStepConsumed records the consumption time for a transition step.
func (s *Store) MarkStepConsumed(stepID int64, consumedAt time.Time) error {
	_, err := s.db.Exec(
		`UPDATE tz_transition_steps SET consumed_at = ? WHERE id = ?`,
		consumedAt, stepID,
	)
	return err
}

// TryUseLoginHash forwards to (*auth.Repo).TryUseLoginHash.
func (s *Store) TryUseLoginHash(hash string, expiresAt time.Time) (bool, error) {
	return s.auth.TryUseLoginHash(hash, expiresAt)
}

// BatchGetLastWeightLogs forwards to (*weight.Repo).BatchGetLastWeightLogs.
func (s *Store) BatchGetLastWeightLogs(ctx context.Context, userIDs []int64) (map[int64]*WeightLog, error) {
	return s.weight.BatchGetLastWeightLogs(ctx, userIDs)
}

// CreateAPIToken forwards to (*auth.Repo).CreateAPIToken.
func (s *Store) CreateAPIToken(ctx context.Context, name, tokenHash string) (int64, error) {
	return s.auth.CreateAPIToken(ctx, name, tokenHash)
}

// ListAPITokens forwards to (*auth.Repo).ListAPITokens.
func (s *Store) ListAPITokens(ctx context.Context) ([]APIToken, error) {
	return s.auth.ListAPITokens(ctx)
}

// DeleteAPIToken forwards to (*auth.Repo).DeleteAPIToken.
func (s *Store) DeleteAPIToken(ctx context.Context, id int64) error {
	return s.auth.DeleteAPIToken(ctx, id)
}

// FindAPITokenByHash forwards to (*auth.Repo).FindAPITokenByHash.
func (s *Store) FindAPITokenByHash(ctx context.Context, hash string) (*APIToken, error) {
	return s.auth.FindAPITokenByHash(ctx, hash)
}

// TouchAPITokenLastUsed forwards to (*auth.Repo).TouchAPITokenLastUsed.
func (s *Store) TouchAPITokenLastUsed(ctx context.Context, id int64) error {
	return s.auth.TouchAPITokenLastUsed(ctx, id)
}
