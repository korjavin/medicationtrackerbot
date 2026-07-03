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
			Description:     "Full gamification read model: lifetime HP, level + within-level progress, current/longest streak + banked freezes, insight tier, per-ring HP totals for today and the trailing 7-day period, the 0-100 Health Score composite, and per-pillar habit-strength EMAs.",
			ResponseSummary: "Summary object: enabled, lifetime_hp, level, insight_tier, hp_into_level/level_span_hp/hp_to_next_level, current_streak/longest_streak/freezes, today_hp, today_rings[] and period_rings[] ({ring, hp, closed, progress, goal, sync_pending} for the three daily levers bedtime/movement/nourishment — adherence and vitals awards and the Mind ring's diary awards still earn lifetime_hp but produce no ring, gamification-10 §2.5), period_days, last_scored_day, health_score ({value (0-100 or null below min-contributors), contributors[] ({key, label, score, weight, missing} for bp/sleep/resting_hr/weight/adherence), missing[] (keys absent from the composite, weights renormalized over the rest)}), strengths[] ({key, label, value (0..1 EMA), frequency} for meds/movement/measurement), adherence_alert ({active, pdc, missed_doses} — a safety-net nudge over the trailing window when dose-level PDC drops below threshold; adherence has no ring/daily grading, so active is false the vast majority of the time). sync_pending is true only on today's bedtime/movement rings when open and no device-synced sample (sleep/steps) has arrived yet today — always false on period_rings.",
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
  "today_hp": 65,
  "today_rings": [
    {"ring": "bedtime", "hp": 0, "closed": false, "progress": 0.0, "goal": "Lights out 22:45–00:15", "sync_pending": true},
    {"ring": "movement", "hp": 25, "closed": true, "progress": 1.0, "goal": "Move toward ~7,000 steps", "sync_pending": false},
    {"ring": "nourishment", "hp": 10, "closed": true, "progress": 1.0, "goal": "Eat near target · 1,800–2,200 kcal", "sync_pending": false}
  ],
  "period_days": 7,
  "period_rings": [
    {"ring": "bedtime", "hp": 60, "closed": true, "progress": 0.0, "goal": "Lights out 22:45–00:15", "sync_pending": false},
    {"ring": "movement", "hp": 180, "closed": true, "progress": 0.0, "goal": "Move toward ~7,000 steps", "sync_pending": false},
    {"ring": "nourishment", "hp": 70, "closed": true, "progress": 0.0, "goal": "Eat near target · 1,800–2,200 kcal", "sync_pending": false}
  ],
  "last_scored_day": "2026-06-28T00:00:00Z",
  "health_score": {
    "value": 78,
    "contributors": [
      {"key": "bp", "label": "Blood pressure", "score": 0.92, "weight": 1.0, "missing": false},
      {"key": "sleep", "label": "Sleep", "score": 0.71, "weight": 1.0, "missing": false},
      {"key": "resting_hr", "label": "Resting heart rate", "score": 0, "weight": 1.0, "missing": true},
      {"key": "weight", "label": "Weight stability", "score": 0.85, "weight": 1.0, "missing": false},
      {"key": "adherence", "label": "Medication adherence", "score": 0.8, "weight": 1.0, "missing": false}
    ],
    "missing": ["resting_hr"]
  },
  "strengths": [
    {"key": "meds", "label": "Medication", "value": 0.87, "frequency": 1},
    {"key": "movement", "label": "Movement", "value": 0.62, "frequency": 0.4286},
    {"key": "measurement", "label": "Measurement", "value": 0.95, "frequency": 1}
  ],
  "adherence_alert": {"active": false, "pdc": 0.95, "missed_doses": 1}
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
			Description:     "Journey-screen read model: the full summary (including the Health Score composite and per-pillar habit strengths) plus a trailing 90-day HP-per-day history (sparse — only days that earned HP), the list of unlocked insight tiers, and the level curve (cumulative HP to reach each level up to a few past the current one).",
			ResponseSummary: "Journey object: all Summary fields (see gamification.summary, including health_score, strengths[], and adherence_alert) plus hp_history[] ({day_unix, hp}), unlocked_tiers[] (ints 1..insight_tier), and level_curve[] ({level, hp_to_reach}).",
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
  "today_rings": [{"ring": "movement", "hp": 40, "closed": true, "progress": 1.0, "goal": "Move toward ~7,000 steps", "sync_pending": false}],
  "period_days": 7,
  "period_rings": [{"ring": "movement", "hp": 260, "closed": true, "progress": 0.0, "goal": "Move toward ~7,000 steps", "sync_pending": false}],
  "last_scored_day": "2026-06-28T00:00:00Z",
  "health_score": {
    "value": 78,
    "contributors": [
      {"key": "bp", "label": "Blood pressure", "score": 0.92, "weight": 1.0, "missing": false},
      {"key": "resting_hr", "label": "Resting heart rate", "score": 0, "weight": 1.0, "missing": true}
    ],
    "missing": ["resting_hr"]
  },
  "strengths": [
    {"key": "meds", "label": "Medication", "value": 0.87, "frequency": 1}
  ],
  "adherence_alert": {"active": false, "pdc": 0.95, "missed_doses": 1},
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
			ResponseSummary: "Object {enabled, level, today_hp, rings[] of {ring, hp, closed, progress, goal, sync_pending} for the three daily levers bedtime/movement/nourishment, health_score, adherence_alert}. closed=true means the ring earned an outcome/consistency award today (not just the honesty floor). progress is the 0..1 fill gauge (1.0 when closed), goal is the short imperative subtitle. sync_pending=true means the ring is open only because its device-synced sample (sleep/steps) hasn't arrived yet today — not a failure. health_score rides along (same shape as gamification.summary's field) so the Today widget can show the 0-100 composite without a second call. adherence_alert ({active, pdc, missed_doses}) is the safety-net nudge, active only when trailing dose-level PDC drops below threshold; adherence itself has no ring.",
			ResponseExample: `{
  "enabled": true,
  "level": 7,
  "today_hp": 65,
  "rings": [
    {"ring": "bedtime", "hp": 0, "closed": false, "progress": 0.0, "goal": "Lights out 22:45–00:15", "sync_pending": true},
    {"ring": "movement", "hp": 25, "closed": true, "progress": 1.0, "goal": "Move toward ~7,000 steps", "sync_pending": false},
    {"ring": "nourishment", "hp": 10, "closed": true, "progress": 1.0, "goal": "Eat near target · 1,800–2,200 kcal", "sync_pending": false}
  ],
  "health_score": {"value": 78.5, "contributors": [{"key": "bp", "label": "Blood pressure", "score": 0.9, "weight": 1.0, "missing": false}], "missing": []},
  "adherence_alert": {"active": false, "pdc": 0.95, "missed_doses": 1}
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
			ID:              "gamification.insights",
			Topic:           "gamification",
			Method:          "GET",
			Path:            "/api/gamification/insights",
			Risk:            RiskRead,
			Description:     "Tier-3 personal insight: sleep→next-morning-BP. Over the trailing 90 days, pairs each night's sleep duration with the next morning's first systolic reading and compares the mean for short nights vs in-band nights. Honest by construction — reports 'no_effect' when the difference is under the noise floor, or 'insufficient_data' when either bucket has too few paired nights, instead of inventing a number. Gated on the feature flag AND the user's unlocked insight tier: below tier 3 (level 5) the response carries no numbers at all, just {locked:true, unlocks_at_level}.",
			ResponseSummary: "Object {enabled, locked, unlocks_at_level, sleep_bp}. sleep_bp is null when locked or disabled; otherwise {status: \"effect\"|\"no_effect\"|\"insufficient_data\", short_threshold_hours, delta_systolic (present for effect/no_effect), n_short, n_in_band, needed (present for insufficient_data), window_days}.",
			ResponseExample: `{
  "enabled": true,
  "sleep_bp": {
    "status": "effect",
    "short_threshold_hours": 7,
    "delta_systolic": 8.2,
    "n_short": 23,
    "n_in_band": 41,
    "window_days": 90
  }
}`,
			Example: `result = api.call("gamification.insights")
output(result["sleep_bp"])
# Below tier 3: {"enabled": true, "locked": true, "unlocks_at_level": 5}
# Sparse data: {"enabled": true, "sleep_bp": {"status": "insufficient_data", "short_threshold_hours": 7, "n_short": 5, "n_in_band": 30, "needed": 8, "window_days": 90}}`,
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
          "metric_key": {"type": "string", "enum": ["bp_systolic", "bp_diastolic", "resting_hr", "sleep_hours", "steps", "bedtime"], "description": "Which band-shaped metric to override."},
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
