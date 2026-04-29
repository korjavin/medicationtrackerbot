package domain

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

const kgPerLb = 0.45359237

var (
	ErrInvalidWeightInput = errors.New("invalid weight input")
	ErrInvalidWeightUnit  = errors.New("invalid weight unit (use kg, lb, lbs, pound, or pounds)")
)

// WeightInput is the parsed result of a user-supplied weight string.
type WeightInput struct {
	WeightKg       float64 // canonical value in kilograms (always populated)
	Unit           string  // "kg" or "lb" — the unit the user typed (or default if no suffix)
	ExplicitSuffix bool    // true when the user typed a unit suffix
}

// ParseWeightInput parses a user-supplied weight string like "150", "150lb", "70 kg".
//
// The optional unit suffix is matched case-insensitively. Recognized aliases:
// "kg" -> kg; "lb", "lbs", "pound", "pounds" -> lb. If no suffix is present,
// defaultUnit (which must be "kg" or "lb") is used.
//
// The returned WeightKg is always in kilograms (converted from lb if needed).
// The numeric value is parsed, then converted, then validated against
// ValidateWeight bounds (30-300 kg).
func ParseWeightInput(raw string, defaultUnit string) (WeightInput, error) {
	if defaultUnit != "kg" && defaultUnit != "lb" {
		defaultUnit = "kg"
	}

	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return WeightInput{}, ErrInvalidWeightInput
	}

	numPart, suffix := splitWeightTokens(trimmed)
	if numPart == "" {
		return WeightInput{}, ErrInvalidWeightInput
	}

	value, err := strconv.ParseFloat(numPart, 64)
	if err != nil {
		return WeightInput{}, fmt.Errorf("%w: %s", ErrInvalidWeightInput, err)
	}

	unit := defaultUnit
	explicit := false
	if suffix != "" {
		normalized, ok := normalizeWeightUnit(suffix)
		if !ok {
			return WeightInput{}, ErrInvalidWeightUnit
		}
		unit = normalized
		explicit = true
	}

	weightKg := value
	if unit == "lb" {
		weightKg = value * kgPerLb
	}

	if err := ValidateWeight(weightKg); err != nil {
		return WeightInput{}, err
	}

	return WeightInput{
		WeightKg:       weightKg,
		Unit:           unit,
		ExplicitSuffix: explicit,
	}, nil
}

// splitWeightTokens separates a string like "150lb" or "150 kg" into ("150", "lb"/"kg").
// If no suffix is present, returns (input, "").
func splitWeightTokens(s string) (numPart, suffix string) {
	collapsed := strings.Join(strings.Fields(s), "")
	for i, r := range collapsed {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			return collapsed[:i], collapsed[i:]
		}
	}
	return collapsed, ""
}

// normalizeWeightUnit maps recognized aliases to canonical "kg"/"lb".
func normalizeWeightUnit(suffix string) (string, bool) {
	switch strings.ToLower(suffix) {
	case "kg", "kgs", "kilogram", "kilograms":
		return "kg", true
	case "lb", "lbs", "pound", "pounds":
		return "lb", true
	}
	return "", false
}

// FormatWeightForDisplay returns a "<value> <unit>" string in the given unit,
// converting from kg if needed. Used for bot replies.
func FormatWeightForDisplay(weightKg float64, unit string) string {
	if unit == "lb" {
		return fmt.Sprintf("%.1f lb", weightKg/kgPerLb)
	}
	return fmt.Sprintf("%.1f kg", weightKg)
}
