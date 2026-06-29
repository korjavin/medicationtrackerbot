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

// EffectiveTarget is one metric's row in the targets-editor read model (Plan 2,
// GET /api/gamification/targets): the band the user is actually scored against
// (Low/High/Falloff), the recommended default it derives from (Recommended*), and
// whether the user has overridden it. The UI edits the effective band and shows
// the recommended values as the "recommended: …" hint.
type EffectiveTarget struct {
	MetricKey          string  `json:"metric_key"`
	Low                float64 `json:"low"`
	High               float64 `json:"high"`
	Falloff            float64 `json:"falloff"`
	RecommendedLow     float64 `json:"recommended_low"`
	RecommendedHigh    float64 `json:"recommended_high"`
	RecommendedFalloff float64 `json:"recommended_falloff"`
	IsCustom           bool    `json:"is_custom"`
	IsRecommended      bool    `json:"is_recommended"`
}

// TargetsView is the GET /api/gamification/targets read model: the gate flag plus
// every overridable metric's effective band. Gate-off yields {Enabled:false} so
// the transport returns the disabled shape without flag branching.
type TargetsView struct {
	Enabled bool              `json:"enabled"`
	Targets []EffectiveTarget `json:"targets"`
}

// EffectiveTargets returns the targets-editor read model: for each overridable
// band-shaped metric, its effective values (the recommended defaults overlaid
// with the user's stored overrides — the same merge scoring uses), the
// recommended default for comparison, and whether the user customized it. Gate-off
// yields {Enabled:false}.
func (s *service) EffectiveTargets(ctx context.Context, userID int64) (TargetsView, error) {
	enabled, err := s.gate(ctx)
	if err != nil {
		return TargetsView{}, err
	}
	if !enabled {
		return TargetsView{}, nil
	}
	overrides, err := s.gam.ListTargets(ctx, userID)
	if err != nil {
		return TargetsView{}, err
	}
	custom := make(map[string]bool, len(overrides))
	eff := s.cfg
	for _, t := range overrides {
		custom[t.MetricKey] = true
		applyTarget(&eff, t)
	}
	out := make([]EffectiveTarget, 0, len(targetMetricKeys))
	for _, mk := range targetMetricKeys {
		rec := bandForMetric(s.cfg, mk)
		cur := bandForMetric(eff, mk)
		out = append(out, EffectiveTarget{
			MetricKey:          mk,
			Low:                cur.Low,
			High:               cur.High,
			Falloff:            cur.Falloff,
			RecommendedLow:     rec.Low,
			RecommendedHigh:    rec.High,
			RecommendedFalloff: rec.Falloff,
			IsCustom:           custom[mk],
			IsRecommended:      !custom[mk],
		})
	}
	return TargetsView{Enabled: true, Targets: out}, nil
}

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
	if err := s.validateTarget(t); err != nil {
		return nil, err
	}
	return s.gam.UpsertTarget(ctx, userID, t)
}

// SetTargets validates and persists a batch of band-shaped overrides as a unit
// and returns the refreshed view. The WHOLE batch is validated before any write,
// so an invalid item rejects the request without leaving earlier items partially
// committed — the failure mode a batch PUT actually hits (the per-row store
// upsert is not wrapped in a cross-row transaction, so without this pre-pass an
// item-3 rejection would already have persisted items 1–2). Gate-off is a no-op
// yielding the {Enabled:false} shape.
//
// ponytail: pre-validation makes the validation path all-or-nothing; a store
// error mid-batch can still partial-commit. Wrap the row upserts in one store
// transaction if that rarer DB-failure case ever matters.
func (s *service) SetTargets(ctx context.Context, userID int64, targets []gamstore.Target) (TargetsView, error) {
	enabled, err := s.gate(ctx)
	if err != nil {
		return TargetsView{}, err
	}
	if !enabled {
		return TargetsView{}, nil
	}
	for _, t := range targets {
		if err := s.validateTarget(t); err != nil {
			return TargetsView{}, err
		}
	}
	for _, t := range targets {
		if _, err := s.gam.UpsertTarget(ctx, userID, t); err != nil {
			return TargetsView{}, err
		}
	}
	return s.EffectiveTargets(ctx, userID)
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

// validateTarget runs the full domain validation for one override before it is
// written: the metric must be one the scorer honors, the supplied fields must be
// in-bounds, and — crucially — the band must stay coherent once merged onto the
// recommended default. The merged check is what catches a one-sided override
// whose set side crosses the default unset side (e.g. steps low=20000 against the
// default high=15000): bandFromTarget is the exact overlay the scorer applies, so
// a resulting High<Low band would otherwise persist and make the scorer silently
// award 0 for that metric on every day (trapezoid returns 0 when high<low)
// instead of returning the documented 400.
func (s *service) validateTarget(t gamstore.Target) error {
	if !isKnownTargetMetric(t.MetricKey) {
		return ErrUnknownTargetMetric
	}
	if err := validateTargetBand(t); err != nil {
		return err
	}
	eff := bandFromTarget(bandForMetric(s.cfg, t.MetricKey), t)
	if eff.High < eff.Low {
		return ErrInvalidTarget
	}
	return nil
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

// validateTargetBand rejects an out-of-bounds or incoherent override: a negative
// bound or Falloff (none of the band metrics — BP, HR, stress, sleep hours, steps
// — can be negative), or a Low above High (when both are set). A one-sided target
// (only Low or only High) is valid — bandFromTarget keeps the recommended value
// for the unset side.
func validateTargetBand(t gamstore.Target) error {
	if t.LowVal != nil && *t.LowVal < 0 {
		return ErrInvalidTarget
	}
	if t.HighVal != nil && *t.HighVal < 0 {
		return ErrInvalidTarget
	}
	if t.LowVal != nil && t.HighVal != nil && *t.LowVal > *t.HighVal {
		return ErrInvalidTarget
	}
	if t.Falloff != nil && *t.Falloff < 0 {
		return ErrInvalidTarget
	}
	return nil
}
