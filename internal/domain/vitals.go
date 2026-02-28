package domain

import (
	"errors"
	"fmt"
)

var (
	ErrInvalidSystolic  = errors.New("invalid systolic value (60-250)")
	ErrInvalidDiastolic = errors.New("invalid diastolic value (40-150)")
	ErrInvalidPulse     = errors.New("invalid pulse value (40-200)")
	ErrInvalidWeight    = errors.New("invalid weight value (30-300 kg)")
)

// ValidateBP validates blood pressure values.
func ValidateBP(systolic, diastolic, pulse int, pulsePresent bool) error {
	if systolic < 60 || systolic > 250 {
		return ErrInvalidSystolic
	}
	if diastolic < 40 || diastolic > 150 {
		return ErrInvalidDiastolic
	}
	if pulsePresent && (pulse < 40 || pulse > 200) {
		return ErrInvalidPulse
	}
	return nil
}

// ValidateWeight validates a weight value in kg.
func ValidateWeight(weight float64) error {
	if weight < 30 || weight > 300 {
		return ErrInvalidWeight
	}
	return nil
}

// CalculateBPCategory returns the ISH 2020 classification for the given BP values.
func CalculateBPCategory(systolic, diastolic int) string {
	if systolic > 180 || diastolic > 120 {
		return "Hypertensive Crisis"
	}
	if systolic >= 140 || diastolic >= 90 {
		return "High BP Stage 2"
	}
	if systolic >= 130 || diastolic >= 80 {
		return "High BP Stage 1"
	}
	if systolic >= 120 && systolic < 130 && diastolic < 80 {
		return "Elevated"
	}
	if systolic < 120 && diastolic < 80 {
		return "Normal"
	}
	return "Unknown"
}

// CalculateWeightTrend calculates a simple exponential moving average.
// alpha = 0.1 gives roughly a 20-day smoothing.
func CalculateWeightTrend(currentWeight float64, previousTrend *float64) float64 {
	if previousTrend == nil {
		return currentWeight
	}
	alpha := 0.1
	return alpha*currentWeight + (1-alpha)**previousTrend
}

// BPReading is a minimal interface for BP stats calculation.
type BPReading struct {
	Systolic  int
	Diastolic int
	Pulse     *int
}

// BPStats holds aggregated blood pressure statistics.
type BPStats struct {
	Count      int
	AvgSys     int
	AvgDia     int
	AvgPulse   int
	MinSys     int
	MaxSys     int
	MinDia     int
	MaxDia     int
	MinPulse   int
	MaxPulse   int
	PulseCount int
}

// FormatBPStats returns a formatted string of BP statistics.
func (s BPStats) FormatBPStats() string {
	pulsePart := ""
	if s.PulseCount > 0 {
		pulsePart = fmt.Sprintf(", pulse %d", s.AvgPulse)
	}
	text := fmt.Sprintf("Average: %d/%d%s", s.AvgSys, s.AvgDia, pulsePart)
	if s.PulseCount > 0 {
		text += fmt.Sprintf("\nMax: %d/%d, pulse %d", s.MaxSys, s.MaxDia, s.MaxPulse)
		text += fmt.Sprintf("\nMin: %d/%d, pulse %d", s.MinSys, s.MinDia, s.MinPulse)
	} else {
		text += fmt.Sprintf("\nMax: %d/%d, pulse —", s.MaxSys, s.MaxDia)
		text += fmt.Sprintf("\nMin: %d/%d, pulse —", s.MinSys, s.MinDia)
	}
	return text
}

// CalculateBPStats computes aggregate statistics from a slice of BP readings.
func CalculateBPStats(readings []BPReading) BPStats {
	if len(readings) == 0 {
		return BPStats{}
	}

	stats := BPStats{
		Count:    len(readings),
		MinSys:   readings[0].Systolic,
		MaxSys:   readings[0].Systolic,
		MinDia:   readings[0].Diastolic,
		MaxDia:   readings[0].Diastolic,
		MinPulse: 999,
		MaxPulse: -999,
	}

	var sumSys, sumDia, sumPulse int

	for _, bp := range readings {
		sumSys += bp.Systolic
		sumDia += bp.Diastolic

		if bp.Systolic < stats.MinSys {
			stats.MinSys = bp.Systolic
		}
		if bp.Systolic > stats.MaxSys {
			stats.MaxSys = bp.Systolic
		}
		if bp.Diastolic < stats.MinDia {
			stats.MinDia = bp.Diastolic
		}
		if bp.Diastolic > stats.MaxDia {
			stats.MaxDia = bp.Diastolic
		}

		if bp.Pulse != nil {
			sumPulse += *bp.Pulse
			stats.PulseCount++
			if *bp.Pulse < stats.MinPulse {
				stats.MinPulse = *bp.Pulse
			}
			if *bp.Pulse > stats.MaxPulse {
				stats.MaxPulse = *bp.Pulse
			}
		}
	}

	stats.AvgSys = sumSys / len(readings)
	stats.AvgDia = sumDia / len(readings)
	if stats.PulseCount > 0 {
		stats.AvgPulse = sumPulse / stats.PulseCount
	}

	return stats
}
