package domain

import (
	"errors"
	"math"
	"testing"
)

func TestParseWeightInput(t *testing.T) {
	tests := []struct {
		name        string
		raw         string
		defaultUnit string
		wantKg      float64
		wantUnit    string
		wantExplic  bool
		wantErr     error
	}{
		{"bare number defaults to kg", "75.5", "kg", 75.5, "kg", false, nil},
		{"bare number defaults to lb when preference is lb", "150", "lb", 150 * KgPerLb, "lb", false, nil},
		{"explicit kg suffix", "75kg", "lb", 75, "kg", true, nil},
		{"explicit lb suffix", "150lb", "kg", 150 * KgPerLb, "lb", true, nil},
		{"explicit lbs suffix", "150lbs", "kg", 150 * KgPerLb, "lb", true, nil},
		{"explicit pound suffix", "150pound", "kg", 150 * KgPerLb, "lb", true, nil},
		{"explicit pounds suffix", "150pounds", "kg", 150 * KgPerLb, "lb", true, nil},
		{"explicit suffix uppercase", "150LB", "kg", 150 * KgPerLb, "lb", true, nil},
		{"space between number and unit", "150 lb", "kg", 150 * KgPerLb, "lb", true, nil},
		{"decimal lb", "154.3lb", "kg", 154.3 * KgPerLb, "lb", true, nil},
		{"empty string rejected", "", "kg", 0, "", false, ErrInvalidWeightInput},
		{"non-numeric rejected", "abc", "kg", 0, "", false, ErrInvalidWeightInput},
		{"unknown suffix rejected", "150oz", "kg", 0, "", false, ErrInvalidWeightUnit},
		{"out-of-range kg rejected", "500kg", "kg", 0, "", false, ErrInvalidWeight},
		{"out-of-range lb rejected (50 lb ~ 22.7 kg, below min)", "50lb", "kg", 0, "", false, ErrInvalidWeight},
		{"invalid default falls back to kg", "75", "yards", 75, "kg", false, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseWeightInput(tt.raw, tt.defaultUnit)
			if tt.wantErr != nil {
				if err == nil {
					t.Fatalf("expected error %v, got nil (result: %+v)", tt.wantErr, got)
				}
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("expected error %v, got %v", tt.wantErr, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if math.Abs(got.WeightKg-tt.wantKg) > 1e-6 {
				t.Errorf("WeightKg = %v, want %v", got.WeightKg, tt.wantKg)
			}
			if got.Unit != tt.wantUnit {
				t.Errorf("Unit = %q, want %q", got.Unit, tt.wantUnit)
			}
			if got.ExplicitSuffix != tt.wantExplic {
				t.Errorf("ExplicitSuffix = %v, want %v", got.ExplicitSuffix, tt.wantExplic)
			}
		})
	}
}

func TestFormatWeightForDisplay(t *testing.T) {
	tests := []struct {
		name string
		kg   float64
		unit string
		want string
	}{
		{"kg passthrough", 75.5, "kg", "75.5 kg"},
		{"kg to lb conversion", 70, "lb", "154.3 lb"},
		{"unknown unit defaults to kg", 75.5, "stones", "75.5 kg"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := FormatWeightForDisplay(tt.kg, tt.unit); got != tt.want {
				t.Errorf("FormatWeightForDisplay(%v,%q) = %q, want %q", tt.kg, tt.unit, got, tt.want)
			}
		})
	}
}
