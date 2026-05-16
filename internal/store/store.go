// Package store is the database layer aggregator. It composes the per-domain
// repositories (medication, bp, weight, food, workout, vitals, diary, tz,
// settings, auth, push) into a single *Repos struct wired from the composition
// roots in cmd/.
//
// Dose-related time columns are stored as INTEGER unix seconds (UTC).
// Equality on these columns is safe across server/user time zones because
// modernc.org/sqlite no longer round-trips a zone string. Writers normalize
// via t.UTC().Unix() (or storedb.TimeToUnix); readers Scan into int64 /
// sql.NullInt64 and convert via time.Unix(n, 0).UTC() (or storedb.UnixToTime /
// storedb.NullableUnixToTimePtr).
//
// The full allowlist of dose-related INTEGER unix-seconds columns is:
//
//	intake_log.scheduled_at_unix          (NOT NULL)
//	intake_log.taken_at_unix              (nullable)
//	intake_log.snoozed_until_unix         (nullable)
//	tz_transition_plans.created_at_unix   (NOT NULL, defaulted to strftime('%s','now'))
//	tz_transition_plans.notified_at_unix  (nullable)
//	tz_transition_plans.approved_at_unix  (nullable)
//
// TestDoseTimeColumnsAreInteger (store_time_invariants_test.go) enforces
// INTEGER on every name above via PRAGMA table_info, and rejects the legacy
// text-typed DATETIME columns from re-appearing. See docs/architecture.md →
// "Time storage" for the design history (2026-05-10 intake_log incident and
// the Track A scheduler-simplification plan).
package store

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store/auth"
	"github.com/korjavin/medicationtrackerbot/internal/store/bp"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/diary"
	"github.com/korjavin/medicationtrackerbot/internal/store/food"
	"github.com/korjavin/medicationtrackerbot/internal/store/medication"
	// Blank import: migrations/068_backfill_pre_materialized_tz_steps.go
	// registers the project's first goose Go migration in its init(). The SQL
	// migrations are still embedded directly via //go:embed migrations/*.sql
	// below, so this import is purely for side effects — without it the Go
	// migration would only register when a per-domain test imports the
	// migrations package, and production deploys would skip it.
	_ "github.com/korjavin/medicationtrackerbot/internal/store/migrations"
	"github.com/korjavin/medicationtrackerbot/internal/store/push"
	"github.com/korjavin/medicationtrackerbot/internal/store/settings"
	storetz "github.com/korjavin/medicationtrackerbot/internal/store/tz"
	"github.com/korjavin/medicationtrackerbot/internal/store/vitals"
	"github.com/korjavin/medicationtrackerbot/internal/store/weight"
	"github.com/korjavin/medicationtrackerbot/internal/store/workout"
)

//go:embed migrations/*.sql
var embedMigrations embed.FS

// Repos aggregates the per-domain repositories that replaced the legacy
// monolithic *Store. The composition root (cmd/bot, cmd/mcptool, cmd/seeddemo,
// cmd/bpimporter) opens a shared *db.DB and constructs one Repos that owns
// every repo. Callers reach into individual repos via the public fields:
//
//	r := store.New(":memory:")
//	med, err := r.Medication.GetMedication(id)
//	bpState, err := r.BP.GetBPReminderState(userID)
//
// New code SHOULD NOT add methods to Repos. Each domain's methods live on its
// own *<domain>.Repo; reach them through the corresponding field.
type Repos struct {
	db *storedb.DB

	Medication *medication.Repo
	BP         *bp.Repo
	Weight     *weight.Repo
	Food       *food.Repo
	Workout    *workout.Repo
	Vitals     *vitals.Repo
	Diary      *diary.Repo
	TZ         *storetz.Repo
	Settings   *settings.Repo
	Auth       *auth.Repo
	Push       *push.Repo
}

// Store is a transitional alias for Repos kept so the ~50 production files
// and ~60 test files that still spell their store handle as *store.Store
// continue to compile. New code should use *store.Repos directly.
type Store = Repos

// -- Type aliases so existing store.XYZ references compile unchanged --
//
// Each per-domain package owns its own types. These aliases keep the legacy
// store.X spelling working while callers migrate to the per-domain spelling
// (e.g. medication.Medication). They are zero-cost at runtime.

// Medication-domain types.
type ScheduleConfig = medication.ScheduleConfig
type Medication = medication.Medication
type Restock = medication.Restock
type IntakeLog = medication.IntakeLog
type MedicationSchedule = medication.MedicationSchedule
type IntakeWithMedication = medication.IntakeWithMedication

// BP-domain types.
type BloodPressure = bp.BloodPressure
type BPGoal = bp.BPGoal
type BPStats = bp.BPStats
type BPPeriodStats = bp.BPPeriodStats
type BPReminderState = bp.BPReminderState

// Weight-domain types.
type WeightLog = weight.WeightLog
type WeightReminderState = weight.WeightReminderState
type WeightGoal = weight.WeightGoal

// Vitals-domain types.
type SleepLog = vitals.SleepLog
type DayStat = vitals.DayStat
type VitalsHeartLog = vitals.VitalsHeartLog
type VitalsSpO2Log = vitals.VitalsSpO2Log
type VitalsStressLog = vitals.VitalsStressLog

// Food-domain types.
type FoodLog = food.FoodLog
type FoodProduct = food.FoodProduct
type OpenFoodFact = food.OpenFoodFact
type FoodStats = food.FoodStats
type FoodProductsFilter = food.FoodProductsFilter
type FoodTargets = food.FoodTargets

// Diary-domain types.
type DiaryNote = diary.DiaryNote

// Push-domain types.
type PushSubscription = push.PushSubscription

// Auth-domain types.
type APIToken = auth.APIToken

// TZ-domain types.
type TZTransitionPlan = storetz.TZTransitionPlan
type TZTransitionStep = storetz.TZTransitionStep

// Workout-domain types.
type WorkoutGroup = workout.WorkoutGroup
type WorkoutVariant = workout.WorkoutVariant
type WorkoutExercise = workout.WorkoutExercise
type WorkoutSession = workout.WorkoutSession
type WorkoutExerciseLog = workout.WorkoutExerciseLog
type WorkoutRotationState = workout.WorkoutRotationState
type ExerciseStat = workout.ExerciseStat
type WorkoutScheduleSnapshot = workout.WorkoutScheduleSnapshot
type ExerciseLibraryItem = workout.ExerciseLibraryItem
type MiBandWorkout = workout.MiBandWorkout
type MiBandGPSPoint = workout.MiBandGPSPoint
type UpdateMiBandWorkoutFields = workout.UpdateMiBandWorkoutFields

// CalculateBPCategory forwards to bp.CalculateBPCategory.
// Deprecated: import internal/store/bp directly.
func CalculateBPCategory(systolic, diastolic int) string {
	return bp.CalculateBPCategory(systolic, diastolic)
}

// CategorySeverity forwards to bp.CategorySeverity.
// Deprecated: import internal/store/bp directly.
func CategorySeverity(category string) int {
	return bp.CategorySeverity(category)
}

// CalculateWeightTrend forwards to weight.CalculateWeightTrend.
// Deprecated: import internal/store/weight directly.
func CalculateWeightTrend(currentWeight float64, previousTrend *float64) float64 {
	return weight.CalculateWeightTrend(currentWeight, previousTrend)
}

// New opens a SQLite database at dbPath, runs all migrations, and returns a
// ready-to-use Repos. This is the convenience entry point for tests and the
// existing single-call command wiring.
func New(dbPath string) (*Repos, error) {
	d, err := storedb.Open(dbPath)
	if err != nil {
		return nil, err
	}
	return NewWithDB(d)
}

// NewWithDB wraps a caller-supplied *db.DB in a Repos and runs migrations.
// The composition root uses this so a single *db.DB can be shared across
// per-domain repositories. Migrations are idempotent — calling NewWithDB more
// than once against the same *db.DB is harmless.
func NewWithDB(d *storedb.DB) (*Repos, error) {
	if err := d.Migrate(embedMigrations, "migrations"); err != nil {
		return nil, fmt.Errorf("failed to migrate db: %w", err)
	}
	tzRepo := storetz.New(d)
	r := &Repos{
		db:         d,
		Diary:      diary.New(d),
		Push:       push.New(d),
		Auth:       auth.New(d),
		Vitals:     vitals.New(d),
		Settings:   settings.New(d),
		Weight:     weight.New(d),
		Food:       food.New(d),
		Workout:    workout.New(d),
		TZ:         tzRepo,
		Medication: medication.New(d),
		// bp.Repo needs a TimezoneLookup for day-boundary calculations in
		// GetBPDailyWeightedStats. The tz repo owns the timezone table.
		BP: bp.New(d, tzRepo),
	}
	return r, nil
}

// Close releases the underlying *db.DB connection pool.
func (r *Repos) Close() error {
	return r.db.Close()
}

// ApproveAndMaterialize is the cross-repo helper that flips a tz transition
// plan to APPROVED and pre-materializes every unconsumed step into intake_log
// under one transaction. See tzreschedule.LifecycleService for the runtime
// entry point — both the HTTP handler (handleTZPlanApprove) and the auto-
// approve path in tz_plan_notifier route through the lifecycle service, which
// wraps this call.
//
// Bool semantics: (true, nil) when this call performed the approval (the plan
// was PENDING_APPROVAL or NOTIFIED at tx start, is now APPROVED with steps
// materialized); (false, nil) when the plan was already past pending and this
// call is a benign no-op (e.g. another caller approved first). Any error
// short-circuits the tx via the deferred Rollback and returns (false, err).
//
// Approve→crash→restart cannot leave a plan APPROVED with no materialized
// intakes, because both writes share one tx.
func (r *Repos) ApproveAndMaterialize(ctx context.Context, planID, allowedUserID int64, approvedAt time.Time) (bool, error) {
	var approved bool
	err := r.db.WithTx(ctx, func(tx storedb.TX) error {
		ok, err := storetz.SetTZTransitionPlanApprovedTx(tx, planID, approvedAt)
		if err != nil {
			return err
		}
		if !ok {
			approved = false
			return nil
		}
		if _, err := r.Medication.MaterializePlanStepsAsIntakesTx(tx, planID, allowedUserID); err != nil {
			return err
		}
		approved = true
		return nil
	})
	if err != nil {
		return false, err
	}
	return approved, nil
}

// DB exposes the underlying *sql.DB for internal tooling (importers, the demo
// seeder) that needs to issue raw SQL the public API does not cover.
// Application code should use the typed methods on the per-domain repos instead.
func (r *Repos) DB() *sql.DB {
	return r.db.DB
}
