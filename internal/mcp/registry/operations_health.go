package registry

import "encoding/json"

// HealthOperations returns BP, weight, and diary-note operations.
//
// Sleep, vitals (HR, SPO2), and steps are not separate REST endpoints; they are
// recorded as diary notes with a tag (SLEEP, HR, SPO2, STEPS, STRESS, NOTE).
// `health.notes.list` and `health.notes.create` cover all of those paths.
func HealthOperations() []*Operation {
	return []*Operation{
		// --- Blood pressure ---
		{
			ID:     "health.bp.list",
			Topic:  "health",
			Method: "GET",
			Path:   "/api/bp",
			Risk:   RiskRead,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "days":  {"type": "integer", "minimum": 1, "description": "Look back this many days (default 30; capped by MCP_MAX_QUERY_DAYS)"},
    "limit": {"type": "integer", "minimum": 1, "maximum": 5000, "description": "Cap rows returned (default 100, max 5000)"}
  }
}`),
			Description:     "List blood pressure readings, newest first. Use days/limit to constrain the window.",
			ResponseSummary: "JSON array of BP readings with id, measured_at, systolic, diastolic, pulse, site, position, notes, tag.",
			Example: `result = api.call("health.bp.list", params={"days": 7})
output(result)`,
		},
		{
			ID:              "health.bp.stats",
			Topic:           "health",
			Method:          "GET",
			Path:            "/api/bp/stats",
			Risk:            RiskRead,
			Description:     "Daily-weighted BP statistics over the user's recent history.",
			ResponseSummary: "Stats object with arrays of date, mean systolic, mean diastolic, mean pulse, sample counts.",
			Example: `result = api.call("health.bp.stats")
output(result)`,
		},
		{
			ID:              "health.bp.goal.read",
			Topic:           "health",
			Method:          "GET",
			Path:            "/api/bp/goal",
			Risk:            RiskRead,
			Description:     "Get the user's BP goal (target systolic/diastolic).",
			ResponseSummary: "BPGoal object with target_systolic, target_diastolic and optional updated_at.",
			Example: `result = api.call("health.bp.goal.read")
output(result)`,
		},
		{
			ID:     "health.bp.create",
			Topic:  "health",
			Method: "POST",
			Path:   "/api/bp",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["measured_at", "systolic", "diastolic"],
  "properties": {
    "measured_at": {"type": "string", "description": "RFC3339 timestamp"},
    "systolic":    {"type": "integer", "description": "mmHg"},
    "diastolic":   {"type": "integer", "description": "mmHg"},
    "pulse":       {"type": ["integer", "null"], "description": "BPM (optional)"},
    "site":        {"type": "string", "description": "Optional measurement site (e.g. left_arm)"},
    "position":    {"type": "string", "description": "Optional body position (e.g. seated)"},
    "notes":       {"type": "string"},
    "tag":         {"type": "string"}
  }
}`),
			Description:     "Record a blood pressure reading. Goes through BloodPressureService.CreateBloodPressureReading.",
			ResponseSummary: "BloodPressure object with id and the persisted fields.",
			Example: `result = api.call(
    "health.bp.create",
    body={
        "measured_at": "2026-04-29T08:00:00Z",
        "systolic": 122,
        "diastolic": 78,
        "pulse": 64,
        "position": "seated",
    },
)
output(result)`,
		},

		// --- Weight ---
		{
			ID:     "health.weight.list",
			Topic:  "health",
			Method: "GET",
			Path:   "/api/weight",
			Risk:   RiskRead,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "days":  {"type": "integer", "minimum": 1, "description": "Look back this many days (default 30; capped by MCP_MAX_QUERY_DAYS)"},
    "limit": {"type": "integer", "minimum": 1, "maximum": 5000, "description": "Cap rows returned (default 100, max 5000)"}
  }
}`),
			Description:     "List weight log entries, newest first.",
			ResponseSummary: "JSON array of weight logs with id, measured_at, weight (kg), weight_trend, body_fat, muscle_mass, notes.",
			Example: `result = api.call("health.weight.list", params={"days": 30})
output(result)`,
		},
		{
			ID:              "health.weight.goal.read",
			Topic:           "health",
			Method:          "GET",
			Path:            "/api/weight/goal",
			Risk:            RiskRead,
			Description:     "Get the user's weight goal (target weight in kg).",
			ResponseSummary: "WeightGoal object with target_weight (kg) and optional updated_at.",
			Example: `result = api.call("health.weight.goal.read")
output(result)`,
		},
		{
			ID:     "health.weight.create",
			Topic:  "health",
			Method: "POST",
			Path:   "/api/weight",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["measured_at", "weight"],
  "properties": {
    "measured_at": {"type": "string", "description": "RFC3339 timestamp"},
    "weight":      {"type": "number", "description": "Weight in kg (always stored as kg)"},
    "body_fat":    {"type": ["number", "null"], "description": "Body fat percentage (optional)"},
    "muscle_mass": {"type": ["number", "null"], "description": "Muscle mass kg (optional)"},
    "notes":       {"type": "string"}
  }
}`),
			Description:     "Record a weight log entry. The server computes weight_trend (EMA) automatically.",
			ResponseSummary: "WeightLog object with id, measured_at, weight, weight_trend, body_fat, muscle_mass, notes.",
			Example: `result = api.call(
    "health.weight.create",
    body={"measured_at": "2026-04-29T07:00:00Z", "weight": 78.4},
)
output(result)`,
		},

		// --- Diary notes (covers sleep, vitals, steps via tag) ---
		{
			ID:     "health.notes.list",
			Topic:  "health",
			Method: "GET",
			Path:   "/api/notes",
			Risk:   RiskRead,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "days":      {"type": "integer", "minimum": 1, "description": "Look back this many days (default 30; capped by MCP_MAX_QUERY_DAYS)"},
    "limit":     {"type": "integer", "description": "Max notes (1..200, default 50)"},
    "before_id": {"type": "integer", "description": "Pagination cursor: only notes with id < this value"}
  }
}`),
			Description:     "List diary notes (newest first). Each row carries an optional tag identifying its category: SLEEP, STRESS, HR, SPO2, STEPS, NOTE. Use this to read sleep/vitals/steps history.",
			ResponseSummary: "JSON array of notes with id, content, tag, created_at.",
			Example: `result = api.call("health.notes.list", params={"limit": 100})
sleep_notes = [n for n in result if n.get("tag") == "SLEEP"]
output(sleep_notes)`,
		},
		{
			ID:     "health.notes.create",
			Topic:  "health",
			Method: "POST",
			Path:   "/api/notes",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["content"],
  "properties": {
    "content": {"type": "string", "description": "Free-form note body"},
    "tag":     {
      "type": ["string", "null"],
      "enum": ["SLEEP", "STRESS", "HR", "SPO2", "STEPS", "NOTE", null],
      "description": "Optional category. Invalid tags are silently dropped to NULL by the server."
    }
  }
}`),
			Description:     "Create a diary note, optionally tagged. Use tag=SLEEP for sleep entries, HR/SPO2 for vitals, STEPS for step counts.",
			ResponseSummary: "DiaryNote object with id, content, tag, created_at (HTTP 201).",
			Example: `result = api.call(
    "health.notes.create",
    body={"content": "8h, woke once at 4am", "tag": "SLEEP"},
)
output(result)`,
		},
	}
}
