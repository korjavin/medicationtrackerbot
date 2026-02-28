package domain

import (
	"errors"
	"testing"
)

func TestValidateBP(t *testing.T) {
	tests := []struct {
		name         string
		systolic     int
		diastolic    int
		pulse        int
		pulsePresent bool
		wantErr      error
	}{
		{"valid no pulse", 120, 80, 0, false, nil},
		{"valid with pulse", 120, 80, 72, true, nil},
		{"systolic too low", 59, 80, 0, false, ErrInvalidSystolic},
		{"systolic too high", 251, 80, 0, false, ErrInvalidSystolic},
		{"diastolic too low", 120, 39, 0, false, ErrInvalidDiastolic},
		{"diastolic too high", 120, 151, 0, false, ErrInvalidDiastolic},
		{"pulse too low", 120, 80, 39, true, ErrInvalidPulse},
		{"pulse too high", 120, 80, 201, true, ErrInvalidPulse},
		{"pulse ignored when not present", 120, 80, 0, false, nil},
		{"boundary systolic low", 60, 80, 0, false, nil},
		{"boundary systolic high", 250, 80, 0, false, nil},
		{"boundary diastolic low", 120, 40, 0, false, nil},
		{"boundary diastolic high", 120, 150, 0, false, nil},
		{"boundary pulse low", 120, 80, 40, true, nil},
		{"boundary pulse high", 120, 80, 200, true, nil},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateBP(tt.systolic, tt.diastolic, tt.pulse, tt.pulsePresent)
			if tt.wantErr == nil {
				if err != nil {
					t.Errorf("expected no error, got %v", err)
				}
			} else {
				if !errors.Is(err, tt.wantErr) {
					t.Errorf("expected %v, got %v", tt.wantErr, err)
				}
			}
		})
	}
}

func TestValidateWeight(t *testing.T) {
	tests := []struct {
		name    string
		weight  float64
		wantErr bool
	}{
		{"valid", 75.5, false},
		{"too low", 29.9, true},
		{"too high", 300.1, true},
		{"boundary low", 30.0, false},
		{"boundary high", 300.0, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateWeight(tt.weight)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateWeight(%v) error = %v, wantErr %v", tt.weight, err, tt.wantErr)
			}
		})
	}
}

func TestCalculateBPCategory(t *testing.T) {
	tests := []struct {
		name      string
		systolic  int
		diastolic int
		want      string
	}{
		{"normal", 110, 70, "Normal"},
		{"elevated", 125, 75, "Elevated"},
		{"stage1 systolic", 135, 75, "High BP Stage 1"},
		{"stage1 diastolic", 115, 85, "High BP Stage 1"},
		{"stage2 systolic", 145, 75, "High BP Stage 2"},
		{"stage2 diastolic", 115, 95, "High BP Stage 2"},
		{"crisis systolic", 185, 75, "Hypertensive Crisis"},
		{"crisis diastolic", 115, 125, "Hypertensive Crisis"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CalculateBPCategory(tt.systolic, tt.diastolic)
			if got != tt.want {
				t.Errorf("CalculateBPCategory(%d, %d) = %q, want %q", tt.systolic, tt.diastolic, got, tt.want)
			}
		})
	}
}

func TestCalculateWeightTrend(t *testing.T) {
	t.Run("nil previous", func(t *testing.T) {
		result := CalculateWeightTrend(85.0, nil)
		if result != 85.0 {
			t.Errorf("expected 85.0, got %v", result)
		}
	})

	t.Run("with previous", func(t *testing.T) {
		prev := 80.0
		result := CalculateWeightTrend(85.0, &prev)
		expected := 0.1*85.0 + 0.9*80.0
		if result != expected {
			t.Errorf("expected %v, got %v", expected, result)
		}
	})

	t.Run("convergence", func(t *testing.T) {
		trend := 80.0
		for i := 0; i < 100; i++ {
			trend = CalculateWeightTrend(85.0, &trend)
		}
		if trend < 84.9 || trend > 85.1 {
			t.Errorf("expected convergence to ~85.0, got %v", trend)
		}
	})
}

func TestCalculateBPStats(t *testing.T) {
	t.Run("empty", func(t *testing.T) {
		stats := CalculateBPStats(nil)
		if stats.Count != 0 {
			t.Errorf("expected 0 count, got %d", stats.Count)
		}
	})

	t.Run("with pulse", func(t *testing.T) {
		p1, p2 := 70, 80
		readings := []BPReading{
			{Systolic: 120, Diastolic: 80, Pulse: &p1},
			{Systolic: 130, Diastolic: 90, Pulse: &p2},
		}
		stats := CalculateBPStats(readings)

		if stats.Count != 2 {
			t.Errorf("expected count 2, got %d", stats.Count)
		}
		if stats.AvgSys != 125 {
			t.Errorf("expected avg systolic 125, got %d", stats.AvgSys)
		}
		if stats.AvgDia != 85 {
			t.Errorf("expected avg diastolic 85, got %d", stats.AvgDia)
		}
		if stats.MinSys != 120 || stats.MaxSys != 130 {
			t.Errorf("expected sys range 120-130, got %d-%d", stats.MinSys, stats.MaxSys)
		}
		if stats.MinDia != 80 || stats.MaxDia != 90 {
			t.Errorf("expected dia range 80-90, got %d-%d", stats.MinDia, stats.MaxDia)
		}
		if stats.PulseCount != 2 {
			t.Errorf("expected pulse count 2, got %d", stats.PulseCount)
		}
		if stats.AvgPulse != 75 {
			t.Errorf("expected avg pulse 75, got %d", stats.AvgPulse)
		}
	})

	t.Run("without pulse", func(t *testing.T) {
		readings := []BPReading{
			{Systolic: 120, Diastolic: 80},
		}
		stats := CalculateBPStats(readings)
		if stats.PulseCount != 0 {
			t.Errorf("expected pulse count 0, got %d", stats.PulseCount)
		}
	})
}

func TestFormatBPStats(t *testing.T) {
	stats := BPStats{
		AvgSys: 125, AvgDia: 85, AvgPulse: 75,
		MinSys: 120, MaxSys: 130, MinDia: 80, MaxDia: 90,
		MinPulse: 70, MaxPulse: 80, PulseCount: 2,
	}
	text := stats.FormatBPStats()
	if text == "" {
		t.Error("expected non-empty formatted stats")
	}
}
