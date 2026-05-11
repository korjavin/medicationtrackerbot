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

// Service serializes timezone updates across transports.
type Service interface {
	// UpdateTimezone validates the new timezone, generates a transition plan
	// when the timezone actually changes, and persists the new value. Returns
	// planCreated=true when a new PENDING_APPROVAL plan landed in the store
	// (the caller can use this to phrase confirmation messages). On
	// RecordTimezone failure the service cancels any orphan plan and reverts
	// the stored timezone to the superseded plan's baseline.
	UpdateTimezone(ctx context.Context, newTZ string) (planCreated bool, err error)
}

type service struct {
	settings     SettingsStore
	planBaseline PlanBaselineStore
	planner      tzreschedule.PlannerService
	now          func() time.Time
	mu           sync.Mutex
}

// NewService constructs a Service. `planBaseline` may be nil — in that case
// the service skips the baseline-revert path on RecordTimezone failure.
// `now` may be nil — defaults to time.Now.
func NewService(
	settings SettingsStore,
	planBaseline PlanBaselineStore,
	planner tzreschedule.PlannerService,
	now func() time.Time,
) Service {
	if now == nil {
		now = time.Now
	}
	return &service{
		settings:     settings,
		planBaseline: planBaseline,
		planner:      planner,
		now:          now,
	}
}

func (s *service) UpdateTimezone(_ context.Context, newTZ string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	oldTZ, err := s.settings.GetCurrentTimezone()
	if err != nil {
		return false, fmt.Errorf("read current timezone: %w", err)
	}
	if oldTZ == newTZ {
		return false, nil
	}

	// Capture the active plan's baseline before GenerateIfChanged cancels it.
	// If RecordTimezone later fails we revert to this baseline so the scheduler
	// doesn't continue on an unapproved intermediate timezone.
	var supersededBaseline string
	if s.planBaseline != nil {
		activePlan, planErr := s.planBaseline.GetLatestActiveOrPendingTZTransitionPlan()
		if planErr != nil {
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
			return false, fmt.Errorf("generate transition plan: %w", err)
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
		return false, fmt.Errorf("record timezone: %w", err)
	}
	return planCreated, nil
}
