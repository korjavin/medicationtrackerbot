// Package tzreschedule implements the medication timezone rescheduling engine.
// GeneratePlan is a pure, deterministic function with no side effects.
package tzreschedule

import (
	"encoding/json"
	"fmt"
	"math"
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
	PlanID       int64         // filled in by the caller (planner) after plan persisted
	MedicationID int64
	MedName      string
	StepNumber   int
	TotalSteps   int
	ScheduledAt  time.Time
	Note         string
}

// PlanSummary carries observability information about the generated plan.
type PlanSummary struct {
	Direction          string        // "eastbound", "westbound", or "no-change"
	OffsetDelta        time.Duration // newOffset - oldOffset (signed)
	MaxShiftUsed       time.Duration
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
		// Shift accumulated so far toward newLoc schedule.
		shiftSoFar := time.Duration(i) * maxShiftAllowed
		if shiftSoFar > absOffset {
			shiftSoFar = absOffset
		}
		// Naive next time: previous time + nominal interval + directional shift
		// (eastbound = day shortened, offsetDelta > 0; westbound = day lengthened).
		naiveNext := prevTime.Add(time.Duration(intervalHours)*time.Hour - offsetDelta/time.Duration(numSteps))
		_ = naiveNext // replaced by constraint-based approach below

		// Start from anchor + i * interval, then apply partial shift.
		proposed := anchor.Add(time.Duration(i)*time.Duration(intervalHours)*time.Hour + partialShift(offsetDelta, i, numSteps))

		// Hard constraint: enforce min/max interval from previous step.
		gap := proposed.Sub(prevTime)
		if gap < minInterval {
			violations = append(violations, fmt.Sprintf("med %d step %d: gap %v < min %v, clamped", med.ID, i, gap, minInterval))
			proposed = prevTime.Add(minInterval)
		} else if gap > maxInterval {
			violations = append(violations, fmt.Sprintf("med %d step %d: gap %v > max %v, clamped", med.ID, i, gap, maxInterval))
			proposed = prevTime.Add(maxInterval)
		}

		shiftThisStep := proposed.Sub(prevTime) - time.Duration(intervalHours)*time.Hour
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

// nominalIntervalHours derives the average hours between doses from the schedule.
func nominalIntervalHours(cfg *store.ScheduleConfig) int {
	if len(cfg.Times) == 0 {
		return 24
	}
	return 24 / len(cfg.Times)
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
