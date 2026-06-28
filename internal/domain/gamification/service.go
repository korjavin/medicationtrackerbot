// Package gamification is the domain service for the HealthPoints / Rings /
// levels / streaks engine. It is the single code path both HTTP (Plan 2) and any
// future bot surface call (Critical Rule #1): it reads the existing per-domain
// repos through narrow read-only interfaces, resolves effective targets onto a
// scoring.Config, runs the pure scorers in internal/domain/gamification/scoring,
// and persists the resulting HP awards + cached state through the gamification
// store repo.
//
// This file establishes the skeleton (Task 6): the public GamificationService
// interface, the unexported service struct, the New constructor, the narrow
// store interfaces, and the feature-flag gate. The scoring/persistence,
// summary read model, streaks, and 365-day backfill methods are layered on in
// Tasks 7–10; each adds to both this interface and the struct.
//
// Build-tag free, like the store and HTTP layers it sits between.
package gamification

import (
	"context"
	"sync"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/gamification/scoring"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	gamstore "github.com/korjavin/medicationtrackerbot/internal/store/gamification"
)

// ----- narrow read-only store interfaces ------------------------------------
//
// Each interface declares only the List/Get methods the service needs from one
// per-domain repo (the narrow-interface convention: a service depends on the
// smallest surface, not the whole *store.Repos). The concrete sub-package repos
// satisfy these because the store package re-exports their row types as aliases
// (store.BloodPressure = bp.BloodPressure, etc.), so []store.X and []bp.X are
// the identical type.

// MedStore is the adherence read surface. ListIntakeHistoryByUser returns the
// scheduled/taken/skipped dose rows in [since, until) the adherence scorer
// needs. It is distinct from medication.Repo.ListIntakeHistory (medication-keyed,
// capped, descending); the user-keyed range reader was added in Task 9 and is
// satisfied directly by *medication.Repo.
type MedStore interface {
	ListIntakeHistoryByUser(ctx context.Context, userID int64, since, until time.Time) ([]store.IntakeLog, error)
}

// BPStore is the blood-pressure read surface.
type BPStore interface {
	ListReadings(ctx context.Context, userID int64, since time.Time) ([]store.BloodPressure, error)
}

// WeightStore is the weight read surface: the logged readings plus the user's
// goal (maintenance band vs target), which selects the weight scoring mode.
type WeightStore interface {
	ListLogs(ctx context.Context, userID int64, since time.Time) ([]store.WeightLog, error)
	GetGoal(ctx context.Context, userID int64) (*store.WeightGoal, error)
}

// VitalsStore is the auto-captured + sleep read surface.
type VitalsStore interface {
	ListDayStats(ctx context.Context, userID int64, since time.Time) ([]store.DayStat, error)
	ListSleepLogs(ctx context.Context, userID int64, since time.Time) ([]store.SleepLog, error)
	ListHeart(ctx context.Context, userID int64, start, end time.Time) ([]store.VitalsHeartLog, error)
	ListSpO2(ctx context.Context, userID int64, start, end time.Time) ([]store.VitalsSpO2Log, error)
	ListStress(ctx context.Context, userID int64, start, end time.Time) ([]store.VitalsStressLog, error)
}

// FoodStore is the nourishment read surface: per-day logs, aggregate stats, and
// the singleton calorie/macro targets that anchor the two-sided calorie band.
type FoodStore interface {
	ListLogs(ctx context.Context, userID int64, date time.Time, days int) ([]store.FoodLog, error)
	GetStats(ctx context.Context, userID int64, endDate time.Time, days int) (*store.FoodStats, error)
	GetTargets(ctx context.Context) (store.FoodTargets, error)
}

// DiaryStore is the Mind read surface (process-only journaling).
type DiaryStore interface {
	List(ctx context.Context, userID int64, since, until time.Time, limit int, beforeID int64) ([]store.DiaryNote, error)
}

// WorkoutStore is the movement read surface (logged sessions). The method is
// clock/ctx-free, mirroring the workout store package.
type WorkoutStore interface {
	ListHistory(userID int64, limit int) ([]store.WorkoutSession, error)
}

// GamStore is the gamification repo itself — the targets/ledger/state surface
// the service writes to and recomputes from. Satisfied by *gamstore.Repo. The
// service's daily write path is the whole-day ApplyDayScore; the granular
// UpsertLedger is store-internal and stays off this interface. UpsertState IS on
// it: Backfill needs a state-only write to reset the streak-tracking fields
// before replaying the window (see backfill.go), which no ledger write accompanies.
type GamStore interface {
	ListTargets(ctx context.Context, userID int64) ([]gamstore.Target, error)
	UpsertTarget(ctx context.Context, userID int64, t gamstore.Target) (*gamstore.Target, error)
	DeleteTarget(ctx context.Context, userID int64, metricKey string) error

	ListLedger(ctx context.Context, userID, sinceDayUnix, untilDayUnix int64) ([]gamstore.LedgerEntry, error)
	SumHP(ctx context.Context, userID int64) (int, error)

	GetState(ctx context.Context, userID int64) (gamstore.State, error)
	UpsertState(ctx context.Context, userID int64, st gamstore.State) (*gamstore.State, error)
	ApplyDayScore(ctx context.Context, userID int64, day time.Time, entries []gamstore.LedgerEntry, st gamstore.State) (*gamstore.State, error)
	MarkBackfilled(ctx context.Context, userID int64, at time.Time) error
}

// SettingsStore exposes the gamification feature flag. Every scoring/read entry
// point gates on GetGamificationEnabled and short-circuits when it is off.
type SettingsStore interface {
	GetGamificationEnabled(ctx context.Context) (bool, error)
}

// ----- service --------------------------------------------------------------

// GamificationService is the single domain entry point for the HealthPoints /
// Rings / levels / streaks engine. Both HTTP (Plan 2) and any future bot surface
// call only this. The surface grows as the engine is built out:
//   - Task 7: ScoreDay, GetSummary
//   - Task 8: GetInsightTier
//   - Task 10: Backfill, EnsureBackfilled
//   - Targets CRUD: ListTargets, UpsertTarget, DeleteTarget
//
// This task establishes the skeleton plus the enable gate.
type GamificationService interface {
	// Enabled reports whether the gamification feature flag is on. Every scoring
	// / read entry point short-circuits to a no-op / empty result when it is off,
	// so transports can call freely without pre-checking the flag.
	Enabled(ctx context.Context) (bool, error)

	// ScoreDay computes and persists one user-day's HP awards + recomputed state
	// (Task 7). It is a no-op when the flag is off. Idempotent for the same data.
	ScoreDay(ctx context.Context, userID int64, day time.Time) error

	// GetSummary is the read model both HTTP (Plan 2) and the bot will serve:
	// per-ring HP (today + trailing period), level, lifetime HP, next-level
	// progress, streak, and insight tier. Gate-off yields an empty summary.
	GetSummary(ctx context.Context, userID int64) (Summary, error)

	// GetInsightTier returns the user's unlocked insight tier (§8) — the depth of
	// analysis their level grants. It gates only insight depth, never raw data or
	// safety alerts. Gate-off yields 0 (Task 8).
	GetInsightTier(ctx context.Context, userID int64) (int, error)

	// GetJourney is the Journey-screen read model: the Summary plus a trailing
	// HP-per-day history, the unlocked insight tiers, and the level curve. Gate-off
	// yields a disabled Summary with empty extras. See journey.go.
	GetJourney(ctx context.Context, userID int64) (Journey, error)

	// Backfill replays the trailing 365 days (capped) through ScoreDay so an
	// existing user lands on a populated ledger + state instead of starting empty.
	// Gate-off is a no-op; re-running is idempotent (Task 10).
	Backfill(ctx context.Context, userID int64) error

	// EnsureBackfilled runs Backfill once, on first enable, guarded by the user's
	// scored state so it is cheap to call repeatedly. Plan 2 wires it into the
	// feature-enable hook (Task 10).
	EnsureBackfilled(ctx context.Context, userID int64) error

	// ListTargets returns the user's per-metric target overrides (the
	// recommendations they changed). Gate-off yields no targets. See targets.go.
	ListTargets(ctx context.Context, userID int64) ([]gamstore.Target, error)

	// UpsertTarget validates and persists one band-shaped override, rejecting an
	// unknown metric key or an incoherent band so invalid state never reaches the
	// store. Gate-off is a no-op. See targets.go.
	UpsertTarget(ctx context.Context, userID int64, t gamstore.Target) (*gamstore.Target, error)

	// DeleteTarget removes the user's override for metricKey, reverting them to the
	// recommended default. Gate-off is a no-op. See targets.go.
	DeleteTarget(ctx context.Context, userID int64, metricKey string) error
}

// service implements GamificationService. It composes the narrow per-domain read
// stores, the gamification repo, the settings flag, and a scoring.Config (the
// effective recommendations the per-user target overrides are merged onto).
type service struct {
	med      MedStore
	bp       BPStore
	weight   WeightStore
	vitals   VitalsStore
	food     FoodStore
	diary    DiaryStore
	workout  WorkoutStore
	gam      GamStore
	settings SettingsStore

	// cfg holds the recommended guideline defaults; per-user overrides are merged
	// onto a copy at scoring time. Defaults to scoring.DefaultConfig(); in-package
	// tests assign it directly to exercise alternate constants.
	cfg scoring.Config
	// now is the clock. Defaults to time.Now; tests inject a fixed clock.
	now func() time.Time
	// scoreMu serializes a user's whole ScoreDay (domain-data load → recompute →
	// write) so concurrent calls (e.g. a background backfill racing a live
	// same-day re-score) can neither read the same prior ledger sum and clobber
	// each other's state, nor commit an older domain-data snapshot after a fresher
	// one (ApplyDayScore replaces the whole day). See ScoreDay for the full
	// rationale. In-process locking suffices: the bot is a single binary over a
	// file-backed SQLite DB, so there is no second writer process. Zero value is
	// ready to use.
	scoreMu keyedMutex
}

// keyedMutex serializes work per int64 key (here: per user). The zero value is
// ready to use; locks are created lazily and kept for the process lifetime — the
// user set is bounded for a self-hosted deployment, so reference-counting the
// per-user mutexes away is not worth the complexity.
type keyedMutex struct {
	mu sync.Mutex
	m  map[int64]*sync.Mutex
}

// lock acquires the mutex for key and returns its unlock func. Callers
// `defer unlock()`.
func (k *keyedMutex) lock(key int64) func() {
	k.mu.Lock()
	if k.m == nil {
		k.m = make(map[int64]*sync.Mutex)
	}
	m := k.m[key]
	if m == nil {
		m = &sync.Mutex{}
		k.m[key] = m
	}
	k.mu.Unlock()
	m.Lock()
	return m.Unlock
}

var _ GamificationService = (*service)(nil)

// New constructs the gamification domain service from its narrow store
// dependencies, seeding the default scoring config and the real clock. Tests
// pass fakes and may override cfg/now after construction.
func New(med MedStore, bp BPStore, weight WeightStore, vitals VitalsStore, food FoodStore, diary DiaryStore, workout WorkoutStore, gam GamStore, settings SettingsStore) *service {
	return &service{
		med:      med,
		bp:       bp,
		weight:   weight,
		vitals:   vitals,
		food:     food,
		diary:    diary,
		workout:  workout,
		gam:      gam,
		settings: settings,
		cfg:      scoring.DefaultConfig(),
		now:      time.Now,
	}
}

// gate reports whether scoring/read entry points should proceed. It returns
// false (without error) when the gamification feature flag is off so callers can
// short-circuit to a no-op / empty result; a store error propagates unchanged.
func (s *service) gate(ctx context.Context) (bool, error) {
	return s.settings.GetGamificationEnabled(ctx)
}

// Enabled reports whether the gamification feature flag is on.
func (s *service) Enabled(ctx context.Context) (bool, error) {
	return s.gate(ctx)
}
