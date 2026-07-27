package scheduler

import (
	"context"
	"log/slog"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/tzreschedule"
	workoutsvc "github.com/korjavin/medicationtrackerbot/internal/domain/workout"
	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
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

	// Sink is exposed so server-build-only extensions constructed after New()
	// (e.g. the weekly digest checker, which depends on the bot package and
	// so can't be wired inside this tag-free file) can reuse the same
	// delivery channel as every other checker instead of building their own.
	Sink ReminderSink
}

// New constructs a Scheduler wired against the supplied ReminderSink. The
// server build constructs a WebPushSink (notifier.Notifier fan-out); the
// sink is the delivery boundary; checkers depend only on the interface.
func New(s *store.Repos, allowedUserID int64, sink ReminderSink) *Scheduler {
	a := newStoreAdapter(s)

	medChecker := &MedicationChecker{sink: sink, allowedUserID: allowedUserID, store: a}
	medReminderChecker := &MedicationReminderChecker{sink: sink, store: a}
	lowStockChecker := &LowStockChecker{sink: sink, store: a}
	workoutChecker := &WorkoutChecker{sink: sink, allowedUserID: allowedUserID, store: a, workoutSvc: workoutsvc.New(s.Workout, s.TZ), daysCache: make(map[string][]int)}
	bpChecker := &BPReminderChecker{store: a, sink: sink}
	weightChecker := &WeightReminderChecker{store: a, sink: sink}
	tzPlanNotifier := &TZPlanNotifier{
		sink:  sink,
		store: a,
		// Lifecycle service is the auto-approve path. Constructed at the
		// composition root (cmd/bot/main.go) and shared with the HTTP and bot
		// approve handlers so all three routes write through one
		// ApproveAndMaterialize tx.
		lifecycle: tzreschedule.NewLifecycleService(s, allowedUserID),
	}

	sched := &Scheduler{
		MedicationChecker:         medChecker,
		MedicationReminderChecker: medReminderChecker,
		LowStockChecker:           lowStockChecker,
		WorkoutChecker:            workoutChecker,
		BPReminderChecker:         bpChecker,
		WeightReminderChecker:     weightChecker,
		TZPlanNotifier:            tzPlanNotifier,
		Sink:                      sink,

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

// NewWithNotifiers is a convenience wrapper for callers that have a notifier
// slice handy; it wires a WebPushSink that fans the notifiers out.
func NewWithNotifiers(s *store.Repos, allowedUserID int64, notifiers []notifier.Notifier) *Scheduler {
	return New(s, allowedUserID, NewWebPushSink(notifiers, allowedUserID))
}

// AddEntry registers an additional checker to run on its own ticker. Used by
// server-build-only extensions (weekly digest) constructed outside New()
// because they depend on packages this tag-free file can't import. Must be
// called before Start().
func (s *Scheduler) AddEntry(name string, checker Checker, interval, initialDelay time.Duration) {
	s.entries = append(s.entries, tickerEntry{name: name, checker: checker, interval: interval, initialDelay: initialDelay})
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
