package seeddemo

import (
	"context"
	"fmt"
	"math/rand/v2"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// productSpec describes one demo food_product. Macros are per 100g. A non-empty
// barcode tags the product as an Open Food Facts import; descriptive names with
// "(AI estimate)" stand in for the AI-suggestion path. The schema has no
// `source` column, so these conventions are how we exercise each input flow.
type productSpec struct {
	name       string
	barcode    string
	carbs100   float64
	protein100 float64
	fat100     float64
}

// demoFoodProducts mixes the three input paths users hit in the UI: manual
// entries (no barcode), OpenFoodFacts imports (barcode set), and AI-estimated
// meals (descriptive name, no barcode).
var demoFoodProducts = []productSpec{
	// Manual entries.
	{name: "Oats", carbs100: 66.3, protein100: 11.7, fat100: 6.9},
	{name: "Chicken Breast", carbs100: 0, protein100: 31, fat100: 3.6},
	{name: "Brown Rice (cooked)", carbs100: 23, protein100: 2.6, fat100: 0.9},
	{name: "Broccoli (steamed)", carbs100: 7, protein100: 2.8, fat100: 0.4},
	{name: "Olive Oil", carbs100: 0, protein100: 0, fat100: 100},
	// Open Food Facts imports — fake EAN-13 barcodes.
	{name: "Greek Yogurt 0%", barcode: "5901234567890", carbs100: 4, protein100: 10, fat100: 0.2},
	{name: "Whole Wheat Bread", barcode: "5907654321098", carbs100: 44, protein100: 12, fat100: 4},
	{name: "Roasted Almonds", barcode: "5904441122334", carbs100: 22, protein100: 21, fat100: 49},
	// AI-estimated meals.
	{name: "Mediterranean Salad (AI estimate)", carbs100: 8, protein100: 3, fat100: 8},
	{name: "Vegetable Stir Fry (AI estimate)", carbs100: 14, protein100: 4, fat100: 5},
}

func kcalPer100g(p productSpec) float64 {
	return 4*p.carbs100 + 4*p.protein100 + 9*p.fat100
}

// mealSpec is one of the 3–4 meals planted on each day; targetKcal is the
// nominal caloric load before per-day and per-meal jitter.
type mealSpec struct {
	product    string
	targetKcal float64
	hour       int
	minute     int
}

// generateFood seeds the daily nutrition target, the catalogue of food
// products, and 90 days of food_log entries with realistic over/on/under
// target patterns. On a small subset of days it also rolls those logs into
// an aggregated meal product so the meal-template UI has data.
func generateFood(ctx context.Context, s *store.Store, opts Options, clk *clock, rng *rand.Rand, summary *Summary) error {
	if err := s.Food.SetTargets(ctx, store.FoodTargets{
		Calories: 2200,
		Carbs:    250,
		Protein:  110,
		Fat:      75,
	}); err != nil {
		return fmt.Errorf("set food targets: %w", err)
	}

	productIDs, err := seedFoodProducts(ctx, s, opts, summary)
	if err != nil {
		return err
	}
	productByName := make(map[string]productSpec, len(demoFoodProducts))
	for _, p := range demoFoodProducts {
		productByName[p.name] = p
	}

	breakfastOptions := []string{"Oats", "Greek Yogurt 0%", "Whole Wheat Bread"}
	lunchOptions := []string{"Chicken Breast", "Brown Rice (cooked)", "Mediterranean Salad (AI estimate)"}
	dinnerOptions := []string{"Vegetable Stir Fry (AI estimate)", "Chicken Breast", "Whole Wheat Bread"}
	snackOptions := []string{"Roasted Almonds", "Greek Yogurt 0%"}

	aggregateDays := make(map[int]struct{}, 5)
	for _, d := range pickDays(rng, opts.Days, 5) {
		aggregateDays[d] = struct{}{}
	}

	for off := 0; off < opts.Days; off++ {
		factor := pickDailyFoodFactor(rng)
		meals := []mealSpec{
			{product: breakfastOptions[off%len(breakfastOptions)], targetKcal: 500, hour: 8, minute: 0},
			{product: lunchOptions[off%len(lunchOptions)], targetKcal: 700, hour: 12, minute: 30},
			{product: dinnerOptions[off%len(dinnerOptions)], targetKcal: 750, hour: 19, minute: 0},
		}
		// Snack on roughly half the days (deterministic via rng).
		if rng.IntN(100) < 50 {
			meals = append(meals, mealSpec{product: snackOptions[off%len(snackOptions)], targetKcal: 250, hour: 16, minute: 0})
		}

		var dayLogIDs []int64
		for _, m := range meals {
			spec, ok := productByName[m.product]
			if !ok {
				continue
			}
			kcal := kcalPer100g(spec)
			if kcal < 1 {
				continue
			}
			mealFactor := factor * (0.9 + rng.Float64()*0.2)
			grams := int((m.targetKcal*mealFactor/kcal*100)/5+0.5) * 5
			if grams < 10 {
				grams = 10
			}

			carbs, protein, fat, calories := domain.CalculateMacros(spec.carbs100, spec.protein100, spec.fat100, float64(grams))
			jitterMin := rng.IntN(31) - 15
			eatenAt := clk.at(off, m.hour, m.minute).Add(time.Duration(jitterMin) * time.Minute)
			pid := productIDs[m.product]

			id, err := s.Food.CreateLog(ctx, &store.FoodLog{
				UserID:    opts.UserID,
				EatenAt:   eatenAt,
				Weight:    grams,
				Carbs:     carbs,
				Protein:   protein,
				Fat:       fat,
				Calories:  calories,
				Name:      m.product,
				ProductID: &pid,
			})
			if err != nil {
				return fmt.Errorf("create food log day %d: %w", off, err)
			}
			dayLogIDs = append(dayLogIDs, id)
			summary.FoodLogs++
		}

		if _, ok := aggregateDays[off]; ok && len(dayLogIDs) > 0 {
			mealName := fmt.Sprintf("Demo Meal — Day %d", off+1)
			if _, err := s.Food.CreateMealFromLogs(ctx, opts.UserID, mealName, dayLogIDs); err != nil {
				return fmt.Errorf("create meal from logs day %d: %w", off, err)
			}
			summary.FoodProducts++
		}
	}

	return nil
}

// seedFoodProducts inserts the catalogue and returns a name→ID map so
// food_log rows can reference the products by ID.
func seedFoodProducts(ctx context.Context, s *store.Store, opts Options, summary *Summary) (map[string]int64, error) {
	ids := make(map[string]int64, len(demoFoodProducts))
	for _, p := range demoFoodProducts {
		prod := &store.FoodProduct{
			UserID:         opts.UserID,
			Name:           p.name,
			Carbs100g:      p.carbs100,
			Protein100g:    p.protein100,
			Fat100g:        p.fat100,
			EnergyKcal100g: kcalPer100g(p),
		}
		if p.barcode != "" {
			b := p.barcode
			prod.Barcode = &b
		}
		if err := s.Food.UpsertProduct(ctx, prod); err != nil {
			return nil, fmt.Errorf("upsert product %s: %w", p.name, err)
		}
		var id int64
		if err := s.DB().QueryRowContext(ctx,
			"SELECT id FROM food_products WHERE user_id = ? AND name = ?",
			opts.UserID, p.name,
		).Scan(&id); err != nil {
			return nil, fmt.Errorf("lookup product id %s: %w", p.name, err)
		}
		ids[p.name] = id
		summary.FoodProducts++
	}
	return ids, nil
}

// pickDailyFoodFactor returns a multiplier applied to the day's caloric
// load. ~30% over-target, ~50% on-target, ~20% under-target.
func pickDailyFoodFactor(rng *rand.Rand) float64 {
	roll := rng.IntN(100)
	switch {
	case roll < 30:
		return 1.10 + rng.Float64()*0.20 // 110%–130%
	case roll < 80:
		return 0.90 + rng.Float64()*0.20 // 90%–110%
	default:
		return 0.70 + rng.Float64()*0.20 // 70%–90%
	}
}
