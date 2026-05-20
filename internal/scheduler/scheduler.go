package scheduler

import (
	"context"
	"log/slog"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/tzreschedule"
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

// New constructs a Scheduler wired against the supplied ReminderSink. The
// server build constructs a WebPushSink (notifier.Notifier fan-out); the
// mobile build (Task 6 of the local-only-mode plan) substitutes a queue-based
// sink that retains reminders for the Capacitor app to retrieve.
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
// slice handy. The actual sink it constructs depends on the build:
//   - server builds (default): WebPushSink, which fans the notifiers out;
//   - mobile builds (//go:build mobile): LocalNotificationSink, which ignores
//     the notifiers (mobile delivery happens via the @capacitor/local-notifications
//     JS bridge pulling reminders from /api/reminders/upcoming).
//
// defaultSink is the tag-aware selector — see sink_webpush.go (!mobile) and
// sink_localnotifications.go (mobile).
func NewWithNotifiers(s *store.Repos, allowedUserID int64, notifiers []notifier.Notifier) *Scheduler {
	return New(s, allowedUserID, defaultSink(notifiers, allowedUserID))
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
