package registry

import "encoding/json"

// GamificationOperations returns the gamification read/write operations (Plan 2,
// Task 5). They map 1:1 onto the routes in internal/server/gamification_handlers.go
// so the MCP coverage guard stays green. Every route returns an
// {"enabled": false}-shaped body (HTTP 200) when the gamification feature flag is
// off — the examples below show the enabled shape.
//
// The enable toggle itself rides the generic POST /api/settings/features/{feature}
// route (feature = "gamification"), which is coverage-exempt as a privilege loop —
// it is deliberately NOT registered here.
func GamificationOperations() []*Operation {
	return []*Operation{
		{
			ID:              "gamification.summary",
			Topic:           "gamification",
			Method:          "GET",
			Path:            "/api/gamification/summary",
			Risk:            RiskRead,
			Description:     "Full gamification read model: lifetime HP, level + within-level progress, current/longest streak + banked freezes, insight tier, and per-ring HP totals for today and the trailing 7-day period.",
			ResponseSummary: "Summary object: enabled, lifetime_hp, level, insight_tier, hp_into_level/level_span_hp/hp_to_next_level, current_streak/longest_streak/freezes, today_hp, today_rings[] and period_rings[] ({ring, hp, closed} for adherence/movement/vitals/nourishment/mind), period_days, last_scored_day.",
			ResponseExample: `{
  "enabled": true,
  "lifetime_hp": 4820,
  "level": 7,
  "insight_tier": 2,
  "hp_into_level": 320,
  "level_span_hp": 800,
  "hp_to_next_level": 480,
  "current_streak": 12,
  "longest_streak": 21,
  "freezes": 2,
  "today_hp": 95,
  "today_rings": [
    {"ring": "adherence", "hp": 40},
    {"ring": "movement", "hp": 25},
    {"ring": "vitals", "hp": 15},
    {"ring": "nourishment", "hp": 10},
    {"ring": "mind", "hp": 5}
  ],
  "period_days": 7,
  "period_rings": [
    {"ring": "adherence", "hp": 260},
    {"ring": "movement", "hp": 180},
    {"ring": "vitals", "hp": 90},
    {"ring": "nourishment", "hp": 70},
    {"ring": "mind", "hp": 50}
  ],
  "last_scored_day": "2026-06-28T00:00:00Z"
}`,
			Example: `result = api.call("gamification.summary")
output(result)`,
		},
		{
			ID:              "gamification.journey",
			Topic:           "gamification",
			Method:          "GET",
			Path:            "/api/gamification/journey",
			Risk:            RiskRead,
			Description:     "Journey-screen read model: the full summary plus a trailing 90-day HP-per-day history (sparse — only days that earned HP), the list of unlocked insight tiers, and the level curve (cumulative HP to reach each level up to a few past the current one).",
			ResponseSummary: "Journey object: all Summary fields plus hp_history[] ({day_unix, hp}), unlocked_tiers[] (ints 1..insight_tier), and level_curve[] ({level, hp_to_reach}).",
			ResponseExample: `{
  "enabled": true,
  "lifetime_hp": 4820,
  "level": 7,
  "insight_tier": 2,
  "hp_into_level": 320,
  "level_span_hp": 800,
  "hp_to_next_level": 480,
  "current_streak": 12,
  "longest_streak": 21,
  "freezes": 2,
  "today_hp": 95,
  "today_rings": [{"ring": "adherence", "hp": 40, "closed": true}],
  "period_days": 7,
  "period_rings": [{"ring": "adherence", "hp": 260, "closed": true}],
  "last_scored_day": "2026-06-28T00:00:00Z",
  "hp_history": [
    {"day_unix": 1750982400, "hp": 110},
    {"day_unix": 1751068800, "hp": 95}
  ],
  "unlocked_tiers": [1, 2],
  "level_curve": [
    {"level": 1, "hp_to_reach": 0},
    {"level": 2, "hp_to_reach": 100},
    {"level": 3, "hp_to_reach": 250}
  ]
}`,
			Example: `result = api.call("gamification.journey")
output(result["hp_history"])`,
		},
		{
			ID:              "gamification.rings",
			Topic:           "gamification",
			Method:          "GET",
			Path:            "/api/gamification/rings",
			Risk:            RiskRead,
			Description:     "Slim Today-widget projection of the summary: the level badge plus per-ring HP earned today and whether each ring is closed (earned a non-floor award today). Use this (not gamification.summary) when you only need today's ring fill.",
			ResponseSummary: "Object {enabled, level, today_hp, rings[] of {ring, hp, closed} for adherence/movement/vitals/nourishment/mind}. closed=true means the ring earned an outcome/consistency award today (not just the honesty floor).",
			ResponseExample: `{
  "enabled": true,
  "level": 7,
  "today_hp": 95,
  "rings": [
    {"ring": "adherence", "hp": 40, "closed": true},
    {"ring": "movement", "hp": 25, "closed": true},
    {"ring": "vitals", "hp": 15, "closed": true},
    {"ring": "nourishment", "hp": 10, "closed": true},
    {"ring": "mind", "hp": 2, "closed": false}
  ]
}`,
			Example: `result = api.call("gamification.rings")
output(result)`,
		},
		{
			ID:              "gamification.targets.read",
			Topic:           "gamification",
			Method:          "GET",
			Path:            "/api/gamification/targets",
			Risk:            RiskRead,
			Description:     "Targets-editor read model: each overridable band-shaped metric's effective band (the recommended default overlaid with the user's override), the recommended default for comparison, and whether the user customized it.",
			ResponseSummary: "Object {enabled, targets[] of {metric_key, low, high, falloff, recommended_low, recommended_high, recommended_falloff, is_custom, is_recommended}}. Metrics: bp_systolic, bp_diastolic, resting_hr, stress, sleep_hours, steps.",
			ResponseExample: `{
  "enabled": true,
  "targets": [
    {"metric_key": "bp_systolic", "low": 90, "high": 120, "falloff": 20, "recommended_low": 90, "recommended_high": 120, "recommended_falloff": 20, "is_custom": false, "is_recommended": true},
    {"metric_key": "steps", "low": 8000, "high": 12000, "falloff": 3000, "recommended_low": 7000, "recommended_high": 10000, "recommended_falloff": 3000, "is_custom": true, "is_recommended": false}
  ]
}`,
			Example: `result = api.call("gamification.targets.read")
output(result["targets"])`,
		},
		{
			ID:     "gamification.targets.set",
			Topic:  "gamification",
			Method: "PUT",
			Path:   "/api/gamification/targets",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["targets"],
  "properties": {
    "targets": {
      "type": "array",
      "description": "Band overrides to upsert; each replaces the user's override for that metric.",
      "items": {
        "type": "object",
        "required": ["metric_key"],
        "properties": {
          "metric_key": {"type": "string", "enum": ["bp_systolic", "bp_diastolic", "resting_hr", "stress", "sleep_hours", "steps"], "description": "Which band-shaped metric to override."},
          "low_val":  {"type": ["number", "null"], "description": "Lower bound of the healthy band (omit/null to keep the recommended low). Must be >= 0 and <= high_val."},
          "high_val": {"type": ["number", "null"], "description": "Upper bound of the healthy band (omit/null to keep the recommended high). Must be >= 0."},
          "falloff":  {"type": ["number", "null"], "description": "How far outside the band HP decays to zero (>= 0)."},
          "mode":     {"type": "string", "description": "Optional band mode (e.g. range vs one-sided)."}
        }
      }
    }
  }
}`),
			Description:     "Upsert per-user target band overrides for one or more band-shaped metrics, then return the refreshed targets view. An unknown metric_key or an incoherent band (negative bound/falloff, or low above high) is rejected with HTTP 400.",
			ResponseSummary: "The refreshed targets read model (same shape as gamification.targets.read).",
			Example: `result = api.call(
    "gamification.targets.set",
    body={"targets": [{"metric_key": "steps", "low_val": 8000, "high_val": 12000}]},
)
output(result["targets"])`,
		},
	}
}
