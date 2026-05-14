package scheduler

import (
	"context"
	"log/slog"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	workoutsvc "github.com/korjavin/medicationtrackerbot/internal/workout"
)

// Checker is the interface each independent check implements.
type Checker interface {
	Check(ctx context.Context) error
}

// tickerEntry pairs a Checker with its scheduling parameters.
type tickerEntry struct {
	name         string
	checker      Checker
	interval     time.Duration
	initialDelay time.Duration
}

// Scheduler orchestrates independent checkers on their own intervals.
type Scheduler struct {
	entries []tickerEntry

	// Exported checkers for test access.
	MedicationChecker         *MedicationChecker
	MedicationReminderChecker *MedicationReminderChecker
	LowStockChecker           *LowStockChecker
	WorkoutChecker            *WorkoutChecker
	BPReminderChecker         *BPReminderChecker
	WeightReminderChecker     *WeightReminderChecker
	TZPlanNotifier            *TZPlanNotifier
}

func New(s *store.Repos, allowedUserID int64, notifiers []notifier.Notifier) *Scheduler {
	helper := NotifyHelper{
		notifiers:     notifiers,
		allowedUserID: allowedUserID,
	}

	a := newStoreAdapter(s)

	medChecker := &MedicationChecker{NotifyHelper: helper, store: a}
	medReminderChecker := &MedicationReminderChecker{NotifyHelper: helper, store: a}
	lowStockChecker := &LowStockChecker{NotifyHelper: helper, store: a}
	workoutChecker := &WorkoutChecker{NotifyHelper: helper, store: a, workoutSvc: workoutsvc.New(s.Workout, s.TZ), daysCache: make(map[string][]int)}
	bpChecker := &BPReminderChecker{store: a, notifiers: notifiers}
	weightChecker := &WeightReminderChecker{store: a, notifiers: notifiers}
	tzPlanNotifier := &TZPlanNotifier{NotifyHelper: helper, store: a}

	sched := &Scheduler{
		MedicationChecker:         medChecker,
		MedicationReminderChecker: medReminderChecker,
		LowStockChecker:           lowStockChecker,
		WorkoutChecker:            workoutChecker,
		BPReminderChecker:         bpChecker,
		WeightReminderChecker:     weightChecker,
		TZPlanNotifier:            tzPlanNotifier,

		entries: []tickerEntry{
			{name: "medication", checker: medChecker, interval: 1 * time.Minute},
			{name: "medication_reminder", checker: medReminderChecker, interval: 1 * time.Minute},
			{name: "low_stock", checker: lowStockChecker, interval: 1 * time.Hour, initialDelay: 1 * time.Minute},
			{name: "workout", checker: workoutChecker, interval: 1 * time.Minute},
			{name: "bp_reminder", checker: bpChecker, interval: 15 * time.Minute, initialDelay: 2 * time.Minute},
			{name: "weight_reminder", checker: weightChecker, interval: 30 * time.Minute, initialDelay: 3 * time.Minute},
			{name: "tz_plan_notifier", checker: tzPlanNotifier, interval: 1 * time.Minute},
		},
	}

	return sched
}

func (s *Scheduler) Start() {
	for _, e := range s.entries {
		go s.runEntry(e)
	}
}

func (s *Scheduler) runEntry(e tickerEntry) {
	if e.initialDelay > 0 {
		time.Sleep(e.initialDelay)
		if err := e.checker.Check(context.Background()); err != nil {
			slog.Error("Error in checker", "name", e.name, "error", err)
		}
	}

	ticker := time.NewTicker(e.interval)
	for range ticker.C {
		if err := e.checker.Check(context.Background()); err != nil {
			slog.Error("Error in checker", "name", e.name, "error", err)
		}
	}
}
