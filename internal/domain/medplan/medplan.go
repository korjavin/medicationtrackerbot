// Package medplan owns the single source of truth for "what doses should
// fire and when". Two callers read from it:
//
//   - the medication scheduler, which materialises PENDING intakes for any
//     dose at-or-before the current tick (fire mode);
//   - the next-intake forecast endpoint, which surfaces upcoming doses
//     inside a forward-looking window for the Today UI (forecast mode).
//
// Keeping the rules in one pure function is what stops the scheduler and the
// forecast from drifting apart again — every overlap-with-consumed-step,
// start/end-date, weekly-day, and policy-aware exclusion rule lives here, so
// adding a new bucket of suppression touches exactly one place. Any
// state-mutating side effects (marking plans COMPLETED, creating intakes,
// preserving an old timezone while a plan awaits approval) stay at the
// caller — this package never reads from or writes to the database.
package medplan

import (
	"sort"
	"strconv"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/tzreschedule"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// Source identifies why a target dose was emitted.
type Source string

const (
	// SourceTransitionStep means the target comes from an approved
	// timezone-transition plan step. The scheduler must mark the step
	// consumed when it materialises the corresponding intake.
	SourceTransitionStep Source = "transition_step"

	// SourceNormalSchedule means the target comes from the medication's
	// daily / weekly clock-time schedule.
	SourceNormalSchedule Source = "normal_schedule"
)

// DoseTarget is a single planned dose for a single medication.
type DoseTarget struct {
	MedicationID int64
	MedName      string
	ScheduledAt  time.Time
	Source       Source
	// StepID is the underlying tz_transition_steps row id when
	// Source == SourceTransitionStep, zero otherwise.
	StepID int64
}

// Inputs bundles everything PlanDoses needs. The caller must:
//   - resolve UserLoc (honouring any pending-plan old-TZ override);
//   - hand in PendingSteps for the active plan only (or nil);
//   - hand in ConsumedStepTimeByMed populated from the same plan whose steps
//     it just consumed (this is what suppresses overlapping normal doses
//     after a westbound flexible-policy transition).
//
// Mode is encoded by Window:
//
//	Window == 0  → fire mode: include only targets at-or-before Now.
//	Window  > 0  → forecast mode: include only targets in (Now, Now+Window].
type Inputs struct {
	Medications           []store.Medication
	PendingSteps          []store.TZTransitionStep
	ConsumedStepTimeByMed map[int64]time.Time
	UserLoc               *time.Location
	Now                   time.Time
	Window                time.Duration
}

// PlanDoses returns dose targets sorted by ScheduledAt that the caller
// should consider firing or surfacing, applying every suppression rule the
// medication scheduler and the next-intake forecast share.
//
// Pure: no DB, no clock — Now is supplied by the caller.
func PlanDoses(in Inputs) []DoseTarget {
	loc := in.UserLoc
	if loc == nil {
		loc = time.UTC
	}

	pendingByMed := groupPendingSteps(in.PendingSteps)
	out := make([]DoseTarget, 0, len(in.Medications))

	for _, med := range in.Medications {
		if med.Archived {
			continue
		}
		// Plan owns the schedule for this med while any step is unconsumed.
		// Mirrors the scheduler's existing branch and prevents normal-schedule
		// targets from racing with planned transition steps.
		// Note: dedup against an already-materialised pending intake (a normal
		// dose that beat plan approval into intake_log) lives at the
		// materialisation site — see MedicationChecker.Check's plan-step
		// branch in internal/scheduler/medication.go. The forecast path is
		// pure and never creates intakes, so it does not need that lookup.
		if steps, has := pendingByMed[med.ID]; has {
			for _, step := range steps {
				if !targetInWindow(step.ScheduledAt, in.Now, in.Window) {
					continue
				}
				out = append(out, DoseTarget{
					MedicationID: med.ID,
					MedName:      med.Name,
					ScheduledAt:  step.ScheduledAt,
					Source:       SourceTransitionStep,
					StepID:       step.ID,
				})
			}
			continue
		}

		cfg, err := med.ValidSchedule()
		if err != nil || cfg == nil || cfg.Type == "as_needed" {
			continue
		}

		// Course window: skip meds the user is no longer taking, or hasn't
		// started yet. The medication scheduler enforced this, but it is
		// the planner's job too so the forecast matches what will fire.
		if med.EndDate != nil && !med.EndDate.After(in.Now) {
			continue
		}
		if med.StartDate != nil && med.StartDate.After(in.Now) {
			continue
		}

		nominalHours := tzreschedule.NominalIntervalHours(cfg)
		policy := tzreschedule.NormalizePolicy(med.TZShiftPolicy)
		minIntv := tzreschedule.MinDoseInterval(nominalHours, policy)

		for _, target := range candidateNormalTargets(cfg, loc, in.Now, in.Window) {
			if med.StartDate != nil && target.Before(*med.StartDate) {
				continue
			}
			if med.EndDate != nil && target.After(*med.EndDate) {
				continue
			}
			if target.Before(med.CreatedAt) {
				continue
			}
			// Overlap guard: a transition step the user already consumed
			// invalidates two surrounding normal targets — the same-day
			// pre-step slot (which lived in the old timezone) and the
			// next slot inside one minInterval (which would prompt the
			// user to re-take the dose they completed as a step).
			if stepAt, ok := in.ConsumedStepTimeByMed[med.ID]; ok {
				if !target.After(stepAt) {
					continue
				}
				if target.Sub(stepAt) <= minIntv {
					continue
				}
			}
			out = append(out, DoseTarget{
				MedicationID: med.ID,
				MedName:      med.Name,
				ScheduledAt:  target,
				Source:       SourceNormalSchedule,
			})
		}
	}

	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].ScheduledAt.Equal(out[j].ScheduledAt) {
			return out[i].ScheduledAt.Before(out[j].ScheduledAt)
		}
		return out[i].MedicationID < out[j].MedicationID
	})
	return out
}

// candidateNormalTargets enumerates the clock-time slots from the schedule
// that fall inside the requested window. Fire mode looks at the current
// user-local day only, matching the medication scheduler's existing
// behaviour — past targets queued elsewhere will already have been picked
// up at their respective ticks. Forecast mode also considers the next
// user-local day so a query made shortly before midnight still surfaces
// the early-morning dose that lives inside the look-ahead window.
func candidateNormalTargets(cfg *store.ScheduleConfig, loc *time.Location, now time.Time, window time.Duration) []time.Time {
	if cfg == nil || len(cfg.Times) == 0 {
		return nil
	}
	nowLocal := now.In(loc)

	endOffset := 0
	if window > 0 {
		endOffset = 1
	}

	var out []time.Time
	for d := 0; d <= endOffset; d++ {
		day := nowLocal.AddDate(0, 0, d)
		if cfg.Type == "weekly" {
			if !weekdayAllowed(int(day.Weekday()), cfg.Days) {
				continue
			}
		}
		for _, ts := range cfg.Times {
			if len(ts) != 5 {
				continue
			}
			hour, err1 := strconv.Atoi(ts[:2])
			minute, err2 := strconv.Atoi(ts[3:])
			if err1 != nil || err2 != nil {
				continue
			}
			target := time.Date(day.Year(), day.Month(), day.Day(), hour, minute, 0, 0, loc)
			if !targetInWindow(target, now, window) {
				continue
			}
			out = append(out, target)
		}
	}
	return out
}

func weekdayAllowed(weekday int, days []int) bool {
	if len(days) == 0 {
		return false
	}
	for _, d := range days {
		if d == weekday {
			return true
		}
	}
	return false
}

func groupPendingSteps(steps []store.TZTransitionStep) map[int64][]store.TZTransitionStep {
	if len(steps) == 0 {
		return nil
	}
	out := make(map[int64][]store.TZTransitionStep, len(steps))
	for _, s := range steps {
		out[s.MedicationID] = append(out[s.MedicationID], s)
	}
	return out
}

// targetInWindow encodes the fire-vs-forecast distinction:
//
//	window == 0 → include t when t <= now.
//	window  > 0 → include t when now < t <= now + window.
func targetInWindow(t, now time.Time, window time.Duration) bool {
	if window == 0 {
		return !now.Before(t)
	}
	if !t.After(now) {
		return false
	}
	return t.Sub(now) <= window
}
