package gamification

// goals.go builds the per-ring Goal string (Task 2): a short, concrete
// description of what closes the ring, derived from the user's effective
// scoring Config (bands already overlaid with their target overrides — see
// effectiveConfig) and their food targets. Pure and config-derived, so the
// same goal text applies to both today's and period rings.

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/korjavin/medicationtrackerbot/internal/domain/gamification/scoring"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// ringGoals returns the lever-key → goal-text map for cfg + the user's food
// targets + the resolved bedtime baseline center (bedtimeBaselineCenter,
// scoreday.go — the trailing-median onset ScoreSleep's timing award grades
// against). hasBedtimeCenter is false until enough baseline nights exist, in
// which case bedtimeCenterMin is unused.
func ringGoals(cfg scoring.Config, food store.FoodTargets, bedtimeCenterMin float64, hasBedtimeCenter bool) map[string]string {
	// Nourishment needs a calorie target, which defaults to 0 until the user
	// sets one (migration 023) — first-run and demo users have none. Mirror the
	// scorer's `CalorieTarget > 0` guard (scoring.go:494): with no target the
	// calorie outcome isn't scored at all, so a "0–0 kcal" range would advertise
	// a metric that isn't being measured. Fall back to an actionable prompt.
	nourishment := "Set a daily calorie target"
	if food.Calories > 0 {
		calLow := int(float64(food.Calories) * (1 - cfg.CalorieTolerancePct))
		calHigh := int(float64(food.Calories) * (1 + cfg.CalorieTolerancePct))
		nourishment = fmt.Sprintf("Eat near target · %s–%s kcal",
			formatThousands(calLow), formatThousands(calHigh))
	}
	// Bedtime needs a few nights of history before there's a personal window to
	// name; until then the goal is the action that unlocks one.
	bedtime := "Log a few nights to find your bedtime window"
	if hasBedtimeCenter {
		low := bedtimeCenterMin - cfg.BedtimeWindow.High
		high := bedtimeCenterMin + cfg.BedtimeWindow.High
		bedtime = fmt.Sprintf("Lights out %s–%s", clockFromOnsetMinutes(low), clockFromOnsetMinutes(high))
	}
	return map[string]string{
		LeverBedtime:     bedtime,
		LeverMovement:    fmt.Sprintf("Move toward ~%s steps", formatThousands(int(cfg.StepsBand.Low))),
		LeverNourishment: nourishment,
	}
}

// clockFromOnsetMinutes renders a sleepOnsetMinutes-scale value (continuous
// noon-to-next-noon, wellbeing.go) as a wall-clock "HH:MM", wrapping back onto
// the 24h clock.
func clockFromOnsetMinutes(m float64) string {
	mm := math.Mod(m, 24*60)
	if mm < 0 {
		mm += 24 * 60
	}
	total := int(math.Round(mm))
	return fmt.Sprintf("%02d:%02d", total/60, total%60)
}

// formatThousands renders a non-negative int with comma thousands separators
// (e.g. 1800 -> "1,800"). The gamification metrics it formats (steps,
// calories) are always non-negative.
func formatThousands(n int) string {
	s := strconv.Itoa(n)
	if len(s) <= 3 {
		return s
	}
	lead := len(s) % 3
	if lead == 0 {
		lead = 3
	}
	var b strings.Builder
	b.WriteString(s[:lead])
	for i := lead; i < len(s); i += 3 {
		b.WriteByte(',')
		b.WriteString(s[i : i+3])
	}
	return b.String()
}
