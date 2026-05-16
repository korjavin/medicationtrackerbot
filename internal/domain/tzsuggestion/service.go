// Package tzsuggestion centralises the cross-transport decision of whether to
// prompt the user about a detected timezone change, and persists the
// dismissal so the decision is shared across browsers.
//
// The web bootstrap historically tracked dismissal in localStorage, which is
// per-browser; a dismissal on mobile did not silence the desktop prompt. By
// routing both the "should I prompt?" check and the "user dismissed" write
// through this service (backed by the singleton settings row), every client
// sees the same decision until the detected timezone changes or the user
// actually updates settings.
package tzsuggestion

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// ErrInvalidTimezone signals that the supplied detected TZ failed validation
// (empty or not a known IANA location). Callers wrap with errors.Is to map
// it to HTTP 400; any other error indicates a store/internal failure and
// should map to 500.
var ErrInvalidTimezone = errors.New("invalid timezone")

// SettingsStore is the minimal slice of settings persistence the service needs.
type SettingsStore interface {
	GetCurrent() (string, error)
	GetDismissedTZSuggestion(ctx context.Context) (string, error)
	SetDismissedTZSuggestion(ctx context.Context, tz string) error
}

// PlanBaselineStore exposes the active transition plan so the service can
// avoid prompting when a plan whose new_tz matches the detected TZ is already
// pending the user's approval — the tz_plan_notifier owns that conversation.
type PlanBaselineStore interface {
	GetLatestActiveOrPendingTransitionPlan() (*store.TZTransitionPlan, error)
}

// Service is the transport-neutral TZ-suggestion decision API.
type Service interface {
	// ShouldPrompt returns whether a client should ask the user about
	// switching to `detectedTZ`. It returns false (with a human-readable
	// `reason`) when the detected TZ already matches the stored timezone,
	// matches the recorded dismissal, or matches the new_tz of an active
	// transition plan; otherwise true and reason="".
	ShouldPrompt(ctx context.Context, detectedTZ string) (prompt bool, reason string, err error)

	// RecordDismissal persists the IANA timezone the user dismissed so other
	// clients skip prompting for the same detected TZ. The TZ is validated
	// with time.LoadLocation; invalid input returns an error and writes
	// nothing.
	RecordDismissal(ctx context.Context, detectedTZ string) error
}

type service struct {
	settings     SettingsStore
	planBaseline PlanBaselineStore
}

// NewService constructs a Service. `planBaseline` may be nil — in that case
// the service skips the active-plan suppression check.
func NewService(settings SettingsStore, planBaseline PlanBaselineStore) Service {
	return &service{settings: settings, planBaseline: planBaseline}
}

func (s *service) ShouldPrompt(ctx context.Context, detectedTZ string) (bool, string, error) {
	if detectedTZ == "" {
		return false, "empty detected timezone", nil
	}
	if _, err := time.LoadLocation(detectedTZ); err != nil {
		return false, "", errors.Join(ErrInvalidTimezone, fmt.Errorf("%q: %w", detectedTZ, err))
	}

	currentTZ, err := s.settings.GetCurrent()
	if err != nil {
		return false, "", fmt.Errorf("read current timezone: %w", err)
	}
	if currentTZ == detectedTZ {
		return false, "detected timezone matches stored timezone", nil
	}

	dismissed, err := s.settings.GetDismissedTZSuggestion(ctx)
	if err != nil {
		return false, "", fmt.Errorf("read dismissed tz suggestion: %w", err)
	}
	if dismissed != "" && dismissed == detectedTZ {
		return false, "user already dismissed this detected timezone", nil
	}

	if s.planBaseline != nil {
		plan, err := s.planBaseline.GetLatestActiveOrPendingTransitionPlan()
		if err != nil {
			return false, "", fmt.Errorf("read active tz transition plan: %w", err)
		}
		if plan != nil && plan.NewTZ == detectedTZ {
			return false, "active transition plan already targets this timezone", nil
		}
	}

	return true, "", nil
}

func (s *service) RecordDismissal(ctx context.Context, detectedTZ string) error {
	if detectedTZ == "" {
		return fmt.Errorf("%w: detected timezone is required", ErrInvalidTimezone)
	}
	if _, err := time.LoadLocation(detectedTZ); err != nil {
		return errors.Join(ErrInvalidTimezone, fmt.Errorf("%q: %w", detectedTZ, err))
	}
	return s.settings.SetDismissedTZSuggestion(ctx, detectedTZ)
}
