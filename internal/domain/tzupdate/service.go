// Package tzupdate centralises the cross-transport "change the user's
// timezone" dance: capture the old timezone, generate a transition plan,
// record the new timezone, and on persistence failure revert to the
// superseded plan's baseline.
//
// Both the web settings handler and the Telegram bot's location-share
// handler funnel through this service so that a single mutex serialises
// concurrent timezone changes, and so the medication scheduler's safety
// net (preserve the old TZ until the stepped transition plan is approved)
// applies uniformly to every transport.
package tzupdate

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/tzreschedule"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// SettingsStore is the minimal slice of settings persistence the service needs.
type SettingsStore interface {
	GetCurrentTimezone() (string, error)
	RecordTimezone(tz string) error
}

// PlanBaselineStore exposes the active transition plan's baseline so the service
// can revert to it if the forward TZ write fails after a plan was created.
type PlanBaselineStore interface {
	GetLatestActiveOrPendingTZTransitionPlan() (*store.TZTransitionPlan, error)
}

// UpdateResult reports what an UpdateTimezone call did inside the serialized
// path. Both fields are read by callers that need to make user-visible
// decisions (notifications, confirmation copy) AFTER the mutex has been
// released; computing them before the call is racy when two clients submit
// the same new TZ concurrently.
type UpdateResult struct {
	// Changed is true when this specific call modified the stored timezone.
	// Concurrent calls with the same target see Changed=true exactly once;
	// the later caller observes the already-applied value and gets
	// Changed=false. This is the signal to fire one-shot side effects like
	// chat confirmations.
	Changed bool
	// PlanCreated is true when a new PENDING_APPROVAL transition plan landed
	// in the store as part of this call. Only set when Changed=true.
	PlanCreated bool
}

// Service serializes timezone updates across transports.
type Service interface {
	// UpdateTimezone validates the new timezone, generates a transition plan
	// when the timezone actually changes, and persists the new value. The
	// returned UpdateResult reports whether this call actually changed the
	// stored TZ and whether a plan was created — both decided inside the
	// service's mutex so concurrent callers don't double-fire confirmation
	// side effects. On RecordTimezone failure the service cancels any orphan
	// plan and reverts the stored timezone to the superseded plan's baseline.
	UpdateTimezone(ctx context.Context, newTZ string) (UpdateResult, error)
}

type service struct {
	settings     SettingsStore
	planBaseline PlanBaselineStore
	planner      tzreschedule.PlannerService
	now          func() time.Time
	hasNotifiers func() bool
	mu           sync.Mutex
}

// NewService constructs a Service. `planBaseline` may be nil — in that case
// the service skips the baseline-revert path on RecordTimezone failure.
// `now` may be nil — defaults to time.Now. `hasNotifiers` may be nil — when
// nil the service always asks the planner to generate a plan; when set and
// returning false the service skips plan generation and just records the new
// timezone so the medication scheduler picks it up immediately rather than
// briefly pinning to OldTZ until tz_plan_notifier cancels the orphan plan.
func NewService(
	settings SettingsStore,
	planBaseline PlanBaselineStore,
	planner tzreschedule.PlannerService,
	now func() time.Time,
	hasNotifiers func() bool,
) Service {
	if now == nil {
		now = time.Now
	}
	return &service{
		settings:     settings,
		planBaseline: planBaseline,
		planner:      planner,
		now:          now,
		hasNotifiers: hasNotifiers,
	}
}

func (s *service) UpdateTimezone(_ context.Context, newTZ string) (UpdateResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	oldTZ, err := s.settings.GetCurrentTimezone()
	if err != nil {
		return UpdateResult{}, fmt.Errorf("read current timezone: %w", err)
	}
	if oldTZ == newTZ {
		return UpdateResult{}, nil
	}

	// Synchronous gate: if no notification channel is configured, skip plan
	// generation entirely and just record the new timezone. Otherwise the
	// medication scheduler tick (medication.go pins userLoc to plan.OldTZ for
	// PENDING_APPROVAL plans) could fire before tz_plan_notifier's tick
	// cancels the undeliverable plan, briefly creating dose intakes under the
	// old timezone wall-clock. Skipping creation up-front matches the previous
	// web-handler behaviour and eliminates the race.
	if s.planner != nil && s.hasNotifiers != nil && !s.hasNotifiers() {
		if err := s.settings.RecordTimezone(newTZ); err != nil {
			return UpdateResult{}, fmt.Errorf("record timezone: %w", err)
		}
		return UpdateResult{Changed: true}, nil
	}

	// Capture the active plan's baseline before GenerateIfChanged cancels it.
	// If RecordTimezone later fails we revert to this baseline so the scheduler
	// doesn't continue on an unapproved intermediate timezone.
	//
	// When the planner is configured we MUST have the baseline before mutating
	// state: GenerateIfChanged will cancel the current active plan, and a
	// subsequent RecordTimezone failure with no captured baseline would leave
	// no active plan while the stored timezone is still the unapproved
	// intermediate value the scheduler must not honour.
	var supersededBaseline string
	if s.planBaseline != nil {
		activePlan, planErr := s.planBaseline.GetLatestActiveOrPendingTZTransitionPlan()
		if planErr != nil {
			if s.planner != nil {
				return UpdateResult{}, fmt.Errorf("read superseded plan baseline: %w", planErr)
			}
			slog.Warn("tzupdate: failed to read superseded plan baseline, revert path will skip baseline restore",
				"error", planErr)
		} else if activePlan != nil {
			supersededBaseline = activePlan.OldTZ
		}
	}

	planCreated := false
	if s.planner != nil {
		created, err := s.planner.GenerateIfChanged(oldTZ, newTZ, s.now())
		if err != nil {
			return UpdateResult{}, fmt.Errorf("generate transition plan: %w", err)
		}
		planCreated = created
	}

	if err := s.settings.RecordTimezone(newTZ); err != nil {
		if planCreated && s.planner != nil {
			if cancelErr := s.planner.CancelActivePlan("record-timezone-failed"); cancelErr != nil {
				slog.Error("tzupdate: failed to cancel plan after RecordTimezone failure", "error", cancelErr)
			}
		}
		if supersededBaseline != "" && supersededBaseline != oldTZ {
			if revertErr := s.settings.RecordTimezone(supersededBaseline); revertErr != nil {
				slog.Error("tzupdate: failed to revert timezone to superseded baseline",
					"baseline", supersededBaseline, "error", revertErr)
			} else {
				slog.Info("tzupdate: reverted stored timezone to superseded plan baseline",
					"baseline", supersededBaseline)
			}
		}
		return UpdateResult{}, fmt.Errorf("record timezone: %w", err)
	}
	return UpdateResult{Changed: true, PlanCreated: planCreated}, nil
}
