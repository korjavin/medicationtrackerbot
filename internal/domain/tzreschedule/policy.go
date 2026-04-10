package tzreschedule

import "time"

// Policy controls how aggressively a medication schedule is shifted when the
// user crosses timezone boundaries.
type Policy string

const (
	PolicyFlexible Policy = "flexible" // default: shift in one step (or immediately)
	PolicyMedium   Policy = "medium"   // gradual: max 3h shift per dose
	PolicyStrict   Policy = "strict"   // very gradual: max 2h shift per dose
)

// NormalizePolicy returns a valid Policy from the stored string, defaulting to
// PolicyFlexible for unknown or empty values.
func NormalizePolicy(s string) Policy {
	switch Policy(s) {
	case PolicyMedium:
		return PolicyMedium
	case PolicyStrict:
		return PolicyStrict
	default:
		return PolicyFlexible
	}
}

// MaxShiftPerDose is the maximum amount of time a single transition step may
// move a dose time toward the target schedule.
func MaxShiftPerDose(p Policy) time.Duration {
	switch p {
	case PolicyStrict:
		return 2 * time.Hour
	case PolicyMedium:
		return 3 * time.Hour
	default: // flexible: move the full offset in one step
		return 24 * time.Hour // effectively uncapped — clamp to actual offset in engine
	}
}

// MinDoseInterval returns the minimum allowed gap between two consecutive doses
// for a medication with the given nominal schedule interval (in hours).
// This is a hard constraint that must never be violated.
func MinDoseInterval(scheduleIntervalHours float64, p Policy) time.Duration {
	base := time.Duration(scheduleIntervalHours * float64(time.Hour))
	switch p {
	case PolicyStrict:
		return time.Duration(float64(base) * 0.70)
	case PolicyMedium:
		return time.Duration(float64(base) * 0.65)
	default: // flexible
		return time.Duration(float64(base) * 0.60)
	}
}

// MaxDoseInterval returns the maximum allowed gap between two consecutive doses
// for a medication with the given nominal schedule interval (in hours).
// This is a hard constraint that must never be violated.
func MaxDoseInterval(scheduleIntervalHours float64, p Policy) time.Duration {
	base := time.Duration(scheduleIntervalHours * float64(time.Hour))
	switch p {
	case PolicyStrict:
		return time.Duration(float64(base) * 1.50)
	case PolicyMedium:
		return time.Duration(float64(base) * 1.75)
	default: // flexible
		return time.Duration(float64(base) * 2.00)
	}
}
