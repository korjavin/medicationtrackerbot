package gamification

// targets.go is the per-user self-set-targets surface (design §10): a user may
// override a band-shaped metric's recommended default. CRUD lives on the domain
// service (Critical Rule #1) so HTTP (Plan 2) and any future bot surface share
// one code path — including the gate, the metric-key allowlist, and the band
// validation below — instead of reaching the store directly. Stored overrides are
// merged onto the scoring Config at scoring time by effectiveConfig/applyTarget.

import (
	"context"
	"errors"

	gamstore "github.com/korjavin/medicationtrackerbot/internal/store/gamification"
)

// ErrUnknownTargetMetric is returned by UpsertTarget/DeleteTarget for a
// metric_key the scorer does not honor (see the TargetKey* constants in
// scoreday.go). Persisting one would be a silent no-op — applyTarget ignores it
// — so it is rejected at the domain boundary rather than written.
var ErrUnknownTargetMetric = errors.New("gamification: unknown target metric key")

// ErrInvalidTarget is returned for an incoherent band: a Low above High (when
// both are set) or a negative Falloff.
var ErrInvalidTarget = errors.New("gamification: invalid target band")

// ListTargets returns the user's target overrides. Gate-off yields no targets
// (the feature is hidden), never an error, so transports can call it
// unconditionally.
func (s *service) ListTargets(ctx context.Context, userID int64) ([]gamstore.Target, error) {
	enabled, err := s.gate(ctx)
	if err != nil {
		return nil, err
	}
	if !enabled {
		return nil, nil
	}
	return s.gam.ListTargets(ctx, userID)
}

// UpsertTarget validates and persists one band-shaped override. It rejects an
// unknown metric key (ErrUnknownTargetMetric) and an incoherent band
// (ErrInvalidTarget) so invalid state never reaches the store. Gate-off is a
// no-op returning (nil, nil).
func (s *service) UpsertTarget(ctx context.Context, userID int64, t gamstore.Target) (*gamstore.Target, error) {
	enabled, err := s.gate(ctx)
	if err != nil {
		return nil, err
	}
	if !enabled {
		return nil, nil
	}
	if !isKnownTargetMetric(t.MetricKey) {
		return nil, ErrUnknownTargetMetric
	}
	if err := validateTargetBand(t); err != nil {
		return nil, err
	}
	return s.gam.UpsertTarget(ctx, userID, t)
}

// DeleteTarget removes the user's override for metricKey, reverting them to the
// recommended default. Gate-off is a no-op. The unknown-key check keeps the error
// surface consistent with UpsertTarget; a missing override surfaces from the
// store as sql.ErrNoRows for the transport (Plan 2) to map to 404.
func (s *service) DeleteTarget(ctx context.Context, userID int64, metricKey string) error {
	enabled, err := s.gate(ctx)
	if err != nil {
		return err
	}
	if !enabled {
		return nil
	}
	if !isKnownTargetMetric(metricKey) {
		return ErrUnknownTargetMetric
	}
	return s.gam.DeleteTarget(ctx, userID, metricKey)
}

// isKnownTargetMetric reports whether key is one of the band-shaped metrics the
// scorer honors (the TargetKey* constants applied in applyTarget). Kept in
// lockstep with applyTarget — that is what makes a stored override actually take
// effect rather than being silently dropped at scoring time.
func isKnownTargetMetric(key string) bool {
	switch key {
	case TargetKeyBPSystolic, TargetKeyBPDiastolic, TargetKeyRestingHR,
		TargetKeyStress, TargetKeySleepHours, TargetKeySteps:
		return true
	default:
		return false
	}
}

// validateTargetBand rejects an incoherent override: a Low above High (when both
// are set) or a negative Falloff. A one-sided target (only Low or only High) is
// valid — bandFromTarget keeps the recommended value for the unset side.
func validateTargetBand(t gamstore.Target) error {
	if t.LowVal != nil && t.HighVal != nil && *t.LowVal > *t.HighVal {
		return ErrInvalidTarget
	}
	if t.Falloff != nil && *t.Falloff < 0 {
		return ErrInvalidTarget
	}
	return nil
}
