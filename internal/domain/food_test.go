package domain

import (
	"testing"
)

func TestCalculateMacros(t *testing.T) {
	tests := []struct {
		name                                   string
		carbs100, prot100, fat100, weight      float64
		wantCarbs, wantProt, wantFat, wantCals int
	}{
		{"100g serving", 23, 12, 10, 100, 23, 12, 10, 230},
		{"150g serving", 23, 12, 10, 150, 34, 18, 15, 343},
		{"zero weight", 23, 12, 10, 0, 0, 0, 0, 0},
		{"calorie formula", 100, 0, 0, 100, 100, 0, 0, 400},  // 4 * 100
		{"fat calories", 0, 0, 100, 100, 0, 0, 100, 900},     // 9 * 100
		{"protein calories", 0, 100, 0, 100, 0, 100, 0, 400}, // 4 * 100
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, p, f, cal := CalculateMacros(tt.carbs100, tt.prot100, tt.fat100, tt.weight)
			if c != tt.wantCarbs {
				t.Errorf("carbs: got %d, want %d", c, tt.wantCarbs)
			}
			if p != tt.wantProt {
				t.Errorf("protein: got %d, want %d", p, tt.wantProt)
			}
			if f != tt.wantFat {
				t.Errorf("fat: got %d, want %d", f, tt.wantFat)
			}
			if cal != tt.wantCals {
				t.Errorf("calories: got %d, want %d", cal, tt.wantCals)
			}
		})
	}
}

func TestParseIntakeArgs(t *testing.T) {
	tests := []struct {
		name    string
		args    string
		wantErr bool
		check   func(IntakeArgs) bool
	}{
		{"valid 4 args", "23 12 10 150", false, func(a IntakeArgs) bool {
			return a.Carbs100 == 23 && a.Prot100 == 12 && a.Fat100 == 10 && a.Weight == 150 && a.Name == "Food"
		}},
		{"valid with name", "23 12 10 150 Vinegret", false, func(a IntakeArgs) bool {
			return a.Name == "Vinegret"
		}},
		{"valid with multi-word name", "23 12 10 150 Greek Salad", false, func(a IntakeArgs) bool {
			return a.Name == "Greek Salad"
		}},
		{"too few args", "23 12", true, nil},
		{"empty", "", true, nil},
		{"invalid carbs", "abc 12 10 150", true, nil},
		{"invalid protein", "23 abc 10 150", true, nil},
		{"invalid fat", "23 12 abc 150", true, nil},
		{"invalid weight", "23 12 10 abc", true, nil},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := ParseIntakeArgs(tt.args)
			if (err != nil) != tt.wantErr {
				t.Errorf("ParseIntakeArgs(%q) error = %v, wantErr %v", tt.args, err, tt.wantErr)
				return
			}
			if !tt.wantErr && tt.check != nil && !tt.check(result) {
				t.Errorf("ParseIntakeArgs(%q) = %+v, check failed", tt.args, result)
			}
		})
	}
}
