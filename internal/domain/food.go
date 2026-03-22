package domain

import (
	"fmt"
	"strconv"
	"strings"
)

// CalculateMacros converts per-100g macros to total values for the given weight.
// Returns total carbs, protein, fat (grams) and calories (kcal).
func CalculateMacros(carbs100, prot100, fat100, weight float64) (carbs, protein, fat, calories int) {
	carbs = int((carbs100 * weight) / 100)
	protein = int((prot100 * weight) / 100)
	fat = int((fat100 * weight) / 100)
	calories = (4 * carbs) + (4 * protein) + (9 * fat)
	return
}

// IntakeArgs holds parsed intake command arguments.
type IntakeArgs struct {
	Carbs100 float64
	Prot100  float64
	Fat100   float64
	Weight   float64
	Name     string
}

// FoodLog represents an aggregated food entry without database-specific fields.
type FoodLog struct {
	Name     string
	Weight   int
	Carbs    int // total grams
	Protein  int // total grams
	Fat      int // total grams
	Calories int // total kcal
}

// ParseIntakeArgs parses the intake command arguments string.
// Expected format: <carbs> <protein> <fat> <weight> [name]
func ParseIntakeArgs(args string) (IntakeArgs, error) {
	parts := strings.Fields(args)
	if len(parts) < 4 {
		return IntakeArgs{}, fmt.Errorf("need at least 4 numbers: carbs protein fat weight")
	}

	carbs100, err := strconv.ParseFloat(parts[0], 64)
	if err != nil {
		return IntakeArgs{}, fmt.Errorf("invalid carbs value")
	}
	prot100, err := strconv.ParseFloat(parts[1], 64)
	if err != nil {
		return IntakeArgs{}, fmt.Errorf("invalid protein value")
	}
	fat100, err := strconv.ParseFloat(parts[2], 64)
	if err != nil {
		return IntakeArgs{}, fmt.Errorf("invalid fat value")
	}
	weight, err := strconv.ParseFloat(parts[3], 64)
	if err != nil {
		return IntakeArgs{}, fmt.Errorf("invalid weight value")
	}

	name := "Food"
	if len(parts) > 4 {
		name = strings.Join(parts[4:], " ")
	}

	return IntakeArgs{
		Carbs100: carbs100,
		Prot100:  prot100,
		Fat100:   fat100,
		Weight:   weight,
		Name:     name,
	}, nil
}
