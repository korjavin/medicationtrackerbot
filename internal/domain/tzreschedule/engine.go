// Package tzreschedule implements the medication timezone rescheduling engine.
// GeneratePlan is a pure, deterministic function with no side effects.
package tzreschedule

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// PlanInput is the complete set of inputs required to generate a transition plan.
// All values are immutable from the engine's perspective.
type PlanInput struct {
	Medications             []store.Medication
	OldTZ                   string
	NewTZ                   string
	Now                     time.Time
	LastIntakePerMedication map[int64]time.Time // medID → actual last intake time
}

// TransitionStep describes a single dose event during a timezone transition.
type TransitionStep struct {
	PlanID       int64 // filled in by the caller (planner) after plan persisted
	MedicationID int64
	MedName      string
	StepNumber   int
	TotalSteps   int
	ScheduledAt  time.Time
	Note         string
}

// PlanSummary carries observability information about the generated plan.
type PlanSummary struct {
	Direction           string        // "eastbound", "westbound", or "no-change"
	OffsetDelta         time.Duration // newOffset - oldOffset (signed)
	MaxShiftUsed        time.Duration
	ViolationsPrevented []string
}

// GeneratePlan produces a deterministic list of transition steps that safely
// move medication schedules from oldTZ to newTZ.  It is a pure function: it
// reads only the supplied PlanInput and returns (steps, summary, error) without
// any database or network access.
func GeneratePlan(input PlanInput) ([]TransitionStep, PlanSummary, error) {
	oldLoc, err := time.LoadLocation(input.OldTZ)
	if err != nil {
		return nil, PlanSummary{}, fmt.Errorf("invalid old timezone %q: %w", input.OldTZ, err)
	}
	newLoc, err := time.LoadLocation(input.NewTZ)
	if err != nil {
		return nil, PlanSummary{}, fmt.Errorf("invalid new timezone %q: %w", input.NewTZ, err)
	}

	_, oldOffsetSec := input.Now.In(oldLoc).Zone()
	_, newOffsetSec := input.Now.In(newLoc).Zone()
	offsetDelta := time.Duration(newOffsetSec-oldOffsetSec) * time.Second

	summary := PlanSummary{OffsetDelta: offsetDelta}
	switch {
	case offsetDelta > 0:
		summary.Direction = "eastbound"
	case offsetDelta < 0:
		summary.Direction = "westbound"
	default:
		summary.Direction = "no-change"
	}

	// If offsets are identical there is nothing to reschedule.
	if offsetDelta == 0 {
		return nil, summary, nil
	}

	var steps []TransitionStep
	maxShiftUsed := time.Duration(0)

	for _, med := range input.Medications {
		if med.Archived {
			continue
		}
		// Skip medications the user is not actively taking right now: courses
		// that have already ended, or future courses that have not yet begun.
		// Including them would generate phantom transition steps for doses
		// the scheduler will never fire — the medication scheduler enforces
		// the same window via med.StartDate / med.EndDate, so the plan must
		// match it.
		if med.EndDate != nil && !med.EndDate.After(input.Now) {
			continue
		}
		if med.StartDate != nil && med.StartDate.After(input.Now) {
			continue
		}
		cfg, err := med.ValidSchedule()
		if err != nil {
			continue
		}
		// As-needed: always skip.
		if cfg.Type == "as_needed" {
			continue
		}
		// Weekly: skip unless policy explicitly opts in (non-flexible).
		policy := NormalizePolicy(med.TZShiftPolicy)
		if cfg.Type == "weekly" && policy == PolicyFlexible {
			continue
		}
		// Daily: must have at least one scheduled time.
		if len(cfg.Times) == 0 {
			continue
		}

		medSteps, maxShift, violations, err := stepsForMedication(med, cfg, policy, offsetDelta, oldLoc, newLoc, input.Now, input.LastIntakePerMedication)
		if err != nil {
			continue
		}
		if maxShift > maxShiftUsed {
			maxShiftUsed = maxShift
		}
		summary.ViolationsPrevented = append(summary.ViolationsPrevented, violations...)
		steps = append(steps, medSteps...)
	}

	summary.MaxShiftUsed = maxShiftUsed
	return steps, summary, nil
}

// stepsForMedication generates the transition steps for a single medication.
// It returns (steps, maxShiftUsed, violationsPrevented, error).
func stepsForMedication(
	med store.Medication,
	cfg *store.ScheduleConfig,
	policy Policy,
	offsetDelta time.Duration,
	oldLoc, newLoc *time.Location,
	now time.Time,
	lastIntakes map[int64]time.Time,
) ([]TransitionStep, time.Duration, []string, error) {
	// Derive nominal interval from schedule times.
	intervalHours := nominalIntervalHours(cfg)
	maxShiftAllowed := MaxShiftPerDose(policy)
	minInterval := MinDoseInterval(intervalHours, policy)
	maxInterval := MaxDoseInterval(intervalHours, policy)

	// Total offset to bridge (absolute value; we handle direction via sign of
	// offsetDelta when constructing ScheduledAt).
	absOffset := offsetDelta
	if absOffset < 0 {
		absOffset = -absOffset
	}
	// Flexible: clamp maxShiftAllowed to actual offset (move in one step).
	if policy == PolicyFlexible {
		maxShiftAllowed = absOffset
	}

	// Compute the number of steps required to cover the full offset.
	numSteps := int(math.Ceil(float64(absOffset) / float64(maxShiftAllowed)))
	if numSteps == 0 {
		return nil, 0, nil, nil
	}

	// Anchor: use last actual intake if available; otherwise approximate from now.
	anchor, hasAnchor := lastIntakes[med.ID]
	if !hasAnchor || anchor.IsZero() {
		anchor = now.Add(-time.Duration(intervalHours) * time.Hour)
	}

	var steps []TransitionStep
	var violations []string
	prevTime := anchor
	maxShiftUsed := time.Duration(0)

	for i := 1; i <= numSteps; i++ {
		// Start from anchor + i * interval, then apply partial shift.
		proposed := anchor.Add(time.Duration(float64(i)*intervalHours*float64(time.Hour)) + partialShift(offsetDelta, i, numSteps))

		// Hard constraint: enforce min/max interval from previous step.
		gap := proposed.Sub(prevTime)
		if gap < minInterval {
			violations = append(violations, fmt.Sprintf("med %d step %d: gap %v < min %v, clamped", med.ID, i, gap, minInterval))
			proposed = prevTime.Add(minInterval)
		} else if gap > maxInterval {
			violations = append(violations, fmt.Sprintf("med %d step %d: gap %v > max %v, clamped", med.ID, i, gap, maxInterval))
			proposed = prevTime.Add(maxInterval)
		}

		shiftThisStep := proposed.Sub(prevTime) - time.Duration(intervalHours*float64(time.Hour))
		if shiftThisStep < 0 {
			shiftThisStep = -shiftThisStep
		}
		if shiftThisStep > maxShiftUsed {
			maxShiftUsed = shiftThisStep
		}

		note := buildNote(med.Name, policy, i, numSteps, proposed, oldLoc, newLoc)
		steps = append(steps, TransitionStep{
			MedicationID: med.ID,
			MedName:      med.Name,
			StepNumber:   i,
			TotalSteps:   numSteps,
			ScheduledAt:  proposed.UTC(),
			Note:         note,
		})
		prevTime = proposed
	}

	// Validate the hand-off from the last transition step to the first regular dose
	// in the new timezone. If the anchor deviated from the scheduled time (e.g.
	// the user took a dose late), the last step can land close to the next normal
	// dose, causing a near-double-dose. Attempt to adjust the last step earlier
	// to restore the minimum gap; if that would violate the previous step constraint,
	// record the conflict as a violation for operator review.
	if len(steps) > 0 && newLoc != nil {
		nextNormal := firstNormalDoseAfter(prevTime, cfg, newLoc)
		if !nextNormal.IsZero() {
			handoffGap := nextNormal.Sub(prevTime)
			if handoffGap < minInterval {
				// Try to push the last step earlier so the gap to the first normal dose
				// is at least minInterval.
				adjusted := nextNormal.Add(-minInterval)
				prevStepTime := anchor
				if len(steps) > 1 {
					prevStepTime = steps[len(steps)-2].ScheduledAt
				}
				lastIdx := len(steps) - 1
				if adjusted.After(prevStepTime) && adjusted.Sub(prevStepTime) >= minInterval {
					// Adjustment is safe: the gap from the previous step to the adjusted
					// last step still satisfies minInterval.
					oldScheduledAt := steps[lastIdx].ScheduledAt
					steps[lastIdx].ScheduledAt = adjusted.UTC()
					steps[lastIdx].Note = buildNote(med.Name, policy, steps[lastIdx].StepNumber, steps[lastIdx].TotalSteps, adjusted, oldLoc, newLoc)
					violations = append(violations, fmt.Sprintf(
						"med %d hand-off: adjusted last step %s → %s to ensure gap to first normal dose ≥ %v",
						med.ID,
						oldScheduledAt.UTC().Format("15:04Z"),
						adjusted.UTC().Format("15:04Z"),
						minInterval.Round(time.Minute),
					))
				} else {
					violations = append(violations, fmt.Sprintf(
						"med %d hand-off: gap to first normal dose %v < min %v (last step %s → first normal dose %s); cannot adjust without violating previous step constraint; review manually",
						med.ID,
						handoffGap.Round(time.Minute),
						minInterval.Round(time.Minute),
						prevTime.UTC().Format("15:04Z"),
						nextNormal.UTC().Format("15:04Z"),
					))
					// Mark the last step so the notifier can detect this unsafe
					// hand-off and omit the false "safe interval maintained" claim.
					steps[lastIdx].Note += "; review manually: gap to first normal dose may be too short"
				}
			}
		}
	}

	return steps, maxShiftUsed, violations, nil
}

// partialShift computes how much of the total offset (signed) should be
// applied by step i out of numSteps (evenly distributed).
func partialShift(totalDelta time.Duration, stepIdx, numSteps int) time.Duration {
	if numSteps == 0 {
		return 0
	}
	// Distribute offset evenly, but negate because we are moving the dose
	// *against* the offset to keep the interval bounded:
	// eastbound (positive delta): day is shorter → we want to advance doses
	// (negative adjustment from the plain anchor+i*interval baseline)
	return -time.Duration(int64(totalDelta) * int64(stepIdx) / int64(numSteps))
}

// NominalIntervalHours derives the average hours between doses from the
// schedule. Exposed so callers outside the engine (the medication scheduler
// and the next-intake forecast) can reuse the same definition when applying
// the transition-overlap guard.
func NominalIntervalHours(cfg *store.ScheduleConfig) float64 {
	return nominalIntervalHours(cfg)
}

// nominalIntervalHours derives the average hours between doses from the schedule.
func nominalIntervalHours(cfg *store.ScheduleConfig) float64 {
	if len(cfg.Times) == 0 {
		return 24
	}
	if cfg.Type == "weekly" {
		// For weekly medications the dose repeats once per week per scheduled day/time
		// combination, so the nominal interval is 7 days divided by the total number
		// of doses per week (days × times-per-day). If Days is unset, fall back to
		// treating the medication as once-per-week per time slot.
		dosesPerWeek := len(cfg.Times)
		if len(cfg.Days) > 0 {
			dosesPerWeek = len(cfg.Days) * len(cfg.Times)
		}
		interval := 168.0 / float64(dosesPerWeek)
		if interval < 1 {
			return 1
		}
		return interval
	}
	return 24.0 / float64(len(cfg.Times))
}

// firstNormalDoseAfter returns the next scheduled dose time in newLoc strictly
// after t, based on the schedule config. Returns zero time if cfg.Times is empty.
// For weekly medications, the candidate is further advanced to the nearest allowed
// day-of-week from cfg.Days so the handoff gap check is not skewed by an off-day "tomorrow".
func firstNormalDoseAfter(t time.Time, cfg *store.ScheduleConfig, newLoc *time.Location) time.Time {
	tInNew := t.In(newLoc)
	var earliest time.Time
	for _, timeStr := range cfg.Times {
		if len(timeStr) != 5 {
			continue
		}
		hour, _ := strconv.Atoi(timeStr[:2])
		min, _ := strconv.Atoi(timeStr[3:])
		candidate := time.Date(tInNew.Year(), tInNew.Month(), tInNew.Day(), hour, min, 0, 0, newLoc)
		if !candidate.After(t) {
			candidate = candidate.Add(24 * time.Hour)
		}
		// For weekly medications, advance candidate to the next allowed weekday.
		if cfg.Type == "weekly" && len(cfg.Days) > 0 {
			candidate = nextAllowedWeekday(candidate, cfg.Days, newLoc)
		}
		if earliest.IsZero() || candidate.Before(earliest) {
			earliest = candidate
		}
	}
	return earliest
}

// nextAllowedWeekday advances t (preserving its time-of-day) to the nearest
// future instant where t's weekday is one of the allowed days (0=Sunday…6=Saturday).
// If t's weekday is already in days the value is returned unchanged.
func nextAllowedWeekday(t time.Time, days []int, loc *time.Location) time.Time {
	if len(days) == 0 {
		return t
	}
	tInLoc := t.In(loc)
	wd := int(tInLoc.Weekday())
	minOffset := 8 // sentinel > 7
	for _, d := range days {
		offset := (d - wd + 7) % 7
		if offset < minOffset {
			minOffset = offset
		}
	}
	if minOffset == 0 {
		return t
	}
	return t.AddDate(0, 0, minOffset)
}

// buildNote constructs a human-readable note for a transition step.
func buildNote(medName string, policy Policy, stepIdx, totalSteps int, at time.Time, oldLoc, newLoc *time.Location) string {
	oldLocal := at.In(oldLoc).Format("15:04 MST")
	newLocal := at.In(newLoc).Format("15:04 MST")
	policyLabel := map[Policy]string{
		PolicyFlexible: "flexible — fast switch",
		PolicyMedium:   "medium",
		PolicyStrict:   "strict — gradual shift",
	}[policy]
	return fmt.Sprintf("%s (%s): step %d/%d — %s old / %s new", medName, policyLabel, stepIdx, totalSteps, oldLocal, newLocal)
}

// InputsJSON serialises the plan inputs to a canonical JSON string suitable
// for hashing. It is exported so the planner can use it.
func InputsJSON(input PlanInput) (string, error) {
	type serialisable struct {
		OldTZ       string            `json:"old_tz"`
		NewTZ       string            `json:"new_tz"`
		NowUTC      string            `json:"now_utc"`
		Medications []medSummary      `json:"medications"`
		LastIntakes map[string]string `json:"last_intakes"`
	}
	meds := make([]medSummary, 0, len(input.Medications))
	for _, m := range input.Medications {
		if !m.Archived {
			meds = append(meds, medSummary{ID: m.ID, Name: m.Name, Schedule: m.Schedule, Policy: m.TZShiftPolicy})
		}
	}
	intakes := make(map[string]string, len(input.LastIntakePerMedication))
	for id, t := range input.LastIntakePerMedication {
		intakes[fmt.Sprintf("%d", id)] = t.UTC().Format(time.RFC3339)
	}
	s := serialisable{
		OldTZ:       input.OldTZ,
		NewTZ:       input.NewTZ,
		NowUTC:      input.Now.UTC().Format(time.RFC3339),
		Medications: meds,
		LastIntakes: intakes,
	}
	b, err := json.Marshal(s)
	return string(b), err
}

type medSummary struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Schedule string `json:"schedule"`
	Policy   string `json:"policy"`
}
