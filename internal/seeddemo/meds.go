package seeddemo

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// medSpec describes one medication in the demo catalogue. Times are HH:MM
// in the synthetic UTC window. activeFrom and activeTo bound the days on
// which intakes are generated, expressed as days-before-anchor (inclusive).
// activeTo == 0 means "ongoing through the anchor day".
type medSpec struct {
	name           string
	dosage         string
	times          []string
	supplement     bool
	tzShiftPolicy  string
	activeFromDays int // start = anchor - activeFromDays
	activeToDays   int // end   = anchor - activeToDays; 0 means ongoing
}

// demoMeds is the fixed catalogue. Re-seeding with the same RNG seed
// produces identical rows.
var demoMeds = []medSpec{
	{
		name:           "Lisinopril",
		dosage:         "10mg",
		times:          []string{"08:00"},
		tzShiftPolicy:  "medium",
		activeFromDays: 0, // filled in at runtime from opts.Days
		activeToDays:   0,
	},
	{
		name:           "Metformin",
		dosage:         "500mg",
		times:          []string{"08:00", "20:00"},
		tzShiftPolicy:  "flexible",
		activeFromDays: 0, // filled in at runtime from opts.Days
		activeToDays:   0,
	},
	{
		name:           "Vitamin D3",
		dosage:         "1000IU",
		times:          []string{"09:00"},
		supplement:     true,
		tzShiftPolicy:  "flexible",
		activeFromDays: 45,
		activeToDays:   0,
	},
	{
		name:           "Amoxicillin",
		dosage:         "500mg",
		times:          []string{"08:00", "20:00"},
		tzShiftPolicy:  "strict",
		activeFromDays: 60,
		activeToDays:   53,
	},
}

// generateMeds creates the catalogue medications and backdates their
// intake_log rows across the synthetic window. Statuses are distributed
// 80% TAKEN / 10% SKIPPED / 5% MISSED / 5% PENDING, except intakes within
// the last 2 days from the anchor which are always PENDING.
func generateMeds(ctx context.Context, s *store.Store, opts Options, clk *clock, rng *rand.Rand, summary *Summary) error {
	pendingCutoff := clk.daysFromAnchor(2)

	for _, spec := range demoMeds {
		// Resolve "full window" for the always-on meds (activeFromDays==0).
		fromDays := spec.activeFromDays
		if fromDays == 0 {
			fromDays = opts.Days
		}
		startDate := clk.daysFromAnchor(fromDays)
		var endDatePtr *time.Time
		if spec.activeToDays > 0 {
			end := clk.daysFromAnchor(spec.activeToDays)
			endDatePtr = &end
		}

		schedule, err := json.Marshal(map[string]any{
			"type":  "daily",
			"times": spec.times,
		})
		if err != nil {
			return fmt.Errorf("marshal schedule for %s: %w", spec.name, err)
		}

		medID, err := s.CreateMedication(
			spec.name,
			spec.dosage,
			string(schedule),
			&startDate,
			endDatePtr,
			"",
			"",
			spec.tzShiftPolicy,
		)
		if err != nil {
			return fmt.Errorf("create medication %s: %w", spec.name, err)
		}
		// CreateMedication stamps created_at with CURRENT_TIMESTAMP. Backdate
		// it to the synthetic start_date so any UI that says "added X days
		// ago" tells a consistent story for the demo.
		if err := s.UpdateMedicationCreatedAt(medID, startDate); err != nil {
			return fmt.Errorf("backdate created_at for %s: %w", spec.name, err)
		}
		if spec.supplement {
			if err := s.SetMedicationSupplement(medID, true); err != nil {
				return fmt.Errorf("mark supplement %s: %w", spec.name, err)
			}
		}
		summary.Medications++

		// Walk every scheduled occurrence inside the med's active window
		// and create an intake row, then resolve its status deterministically.
		// windowStart rounds down to midnight so the first day's full
		// schedule is generated; windowEnd is end-of-day for finite courses
		// (so the last day's evening doses survive) but stays at the anchor
		// for ongoing meds (so we don't seed intakes in the future).
		windowStart := startOfDayUTC(startDate)
		windowEnd := clk.anchor
		if endDatePtr != nil {
			windowEnd = endOfDayUTC(*endDatePtr)
		}
		for day := windowStart; !day.After(windowEnd); day = day.AddDate(0, 0, 1) {
			for _, hhmm := range spec.times {
				scheduledAt, ok := timeOfDay(day, hhmm)
				if !ok {
					return fmt.Errorf("invalid schedule time %q for %s", hhmm, spec.name)
				}
				if scheduledAt.Before(windowStart) || scheduledAt.After(windowEnd) {
					continue
				}
				intakeID, err := s.CreateIntake(medID, opts.UserID, scheduledAt)
				if err != nil {
					return fmt.Errorf("create intake for %s at %s: %w", spec.name, scheduledAt, err)
				}
				summary.Intakes++

				if !scheduledAt.Before(pendingCutoff) {
					// Within last 2 days — leave as PENDING.
					continue
				}
				status, takenAt := pickIntakeOutcome(rng, scheduledAt)
				if status == "PENDING" {
					continue
				}
				if err := s.UpdateIntake(intakeID, takenAt, status); err != nil {
					return fmt.Errorf("update intake %d: %w", intakeID, err)
				}
			}
		}
	}
	return nil
}

// pickIntakeOutcome chooses a status for a past-window intake. Ratios:
// 80% TAKEN, 10% SKIPPED, 5% MISSED, 5% PENDING (still pending in the
// log even though the time has passed — mirrors real users who never
// confirm).
func pickIntakeOutcome(rng *rand.Rand, scheduledAt time.Time) (string, time.Time) {
	roll := rng.IntN(100)
	switch {
	case roll < 80:
		// TAKEN: jitter taken_at by -25..+25 minutes around the schedule.
		offsetMinutes := rng.IntN(51) - 25
		return "TAKEN", scheduledAt.Add(time.Duration(offsetMinutes) * time.Minute)
	case roll < 90:
		return "SKIPPED", time.Time{}
	case roll < 95:
		return "MISSED", time.Time{}
	default:
		return "PENDING", time.Time{}
	}
}

// startOfDayUTC truncates t to midnight UTC.
func startOfDayUTC(t time.Time) time.Time {
	u := t.UTC()
	return time.Date(u.Year(), u.Month(), u.Day(), 0, 0, 0, 0, time.UTC)
}

// endOfDayUTC returns 23:59:59 UTC on the day component of t.
func endOfDayUTC(t time.Time) time.Time {
	u := t.UTC()
	return time.Date(u.Year(), u.Month(), u.Day(), 23, 59, 59, 0, time.UTC)
}

// timeOfDay parses an "HH:MM" string and returns the moment of that time
// on the day component of `day` (in UTC).
func timeOfDay(day time.Time, hhmm string) (time.Time, bool) {
	if len(hhmm) != 5 || hhmm[2] != ':' {
		return time.Time{}, false
	}
	h, m := 0, 0
	if _, err := fmt.Sscanf(hhmm, "%02d:%02d", &h, &m); err != nil {
		return time.Time{}, false
	}
	if h < 0 || h > 23 || m < 0 || m > 59 {
		return time.Time{}, false
	}
	d := day.UTC()
	return time.Date(d.Year(), d.Month(), d.Day(), h, m, 0, 0, time.UTC), true
}
