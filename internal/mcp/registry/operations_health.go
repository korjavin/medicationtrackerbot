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
			ID:              "health.bp.delete",
			Topic:           "health",
			Method:          "DELETE",
			Path:            "/api/bp/{id}",
			PathParams:      []string{"id"},
			Risk:            RiskWrite,
			Description:     "Delete a single blood pressure reading by id.",
			ResponseSummary: "Empty body on success (HTTP 200/204).",
			Example: `api.call("health.bp.delete", path_params={"id": 7})
output({"deleted": 7})`,
		},
		{
			ID:              "health.bp.reminder.status",
			Topic:           "health",
			Method:          "GET",
			Path:            "/api/bp/reminder/status",
			Risk:            RiskRead,
			Description:     "Get the BP reminder state: enabled flag, snooze-until timestamp, dontbug-until timestamp, last/next reminder times.",
			ResponseSummary: "ReminderState object with enabled, snoozed_until, dontbug_until, last_reminded_at, next_reminder_at.",
			Example: `result = api.call("health.bp.reminder.status")
output(result)`,
		},
		{
			ID:     "health.bp.reminder.toggle",
			Topic:  "health",
			Method: "POST",
			Path:   "/api/bp/reminder/toggle",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["enabled"],
  "properties": {
    "enabled": {"type": "boolean", "description": "true to enable BP reminders, false to turn them off"}
  }
}`),
			Description:     "Enable or disable the daily BP measurement reminder.",
			ResponseSummary: "Object {enabled, status:\"success\"}.",
			Example: `api.call("health.bp.reminder.toggle", body={"enabled": True})
output({"enabled": True})`,
		},
		{
			ID:              "health.bp.reminder.snooze",
			Topic:           "health",
			Method:          "POST",
			Path:            "/api/bp/reminder/snooze",
			Risk:            RiskWrite,
			Description:     "Snooze the BP reminder for 2 hours and clear any pending notification.",
			ResponseSummary: "Object {status:\"success\", message}.",
			Example: `api.call("health.bp.reminder.snooze")
output({"snoozed": True})`,
		},
		{
			ID:              "health.bp.reminder.dontbug",
			Topic:           "health",
			Method:          "POST",
			Path:            "/api/bp/reminder/dontbug",
			Risk:            RiskWrite,
			Description:     "Suppress BP reminders until the user re-enables them; clears any pending notification.",
			ResponseSummary: "Object {status:\"success\"}.",
			Example: `api.call("health.bp.reminder.dontbug")
output({"silenced": True})`,
		},
		{
			ID:              "health.bp.reminder.test",
			Topic:           "health",
			Method:          "POST",
			Path:            "/api/bp/reminder/test",
			Risk:            RiskWrite,
			Description:     "Send a test BP reminder notification through the configured channels (Telegram + web push). Useful for validating notification setup.",
			ResponseSummary: "Object {status:\"success\"}.",
			Example: `api.call("health.bp.reminder.test")
output({"sent": True})`,
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
			ID:              "health.weight.delete",
			Topic:           "health",
			Method:          "DELETE",
			Path:            "/api/weight/{id}",
			PathParams:      []string{"id"},
			Risk:            RiskWrite,
			Description:     "Delete a single weight log entry by id.",
			ResponseSummary: "Empty body on success (HTTP 200/204).",
			Example: `api.call("health.weight.delete", path_params={"id": 11})
output({"deleted": 11})`,
		},
		{
			ID:              "health.weight.reminder.status",
			Topic:           "health",
			Method:          "GET",
			Path:            "/api/weight/reminder/status",
			Risk:            RiskRead,
			Description:     "Get the weight reminder state. Reminders are temporarily muted while snoozed_until > now or dontbug_until > now (use this to decide whether to prompt the user). next_reminder_at is when the scheduler will fire the next reminder.",
			ResponseSummary: "Object {enabled (bool), snoozed_until (RFC3339 or null), dontbug_until (RFC3339 or null), last_reminded_at (RFC3339 or null), next_reminder_at (RFC3339 or null)}.",
			Example: `result = api.call("health.weight.reminder.status")
output(result)`,
		},
		{
			ID:     "health.weight.reminder.toggle",
			Topic:  "health",
			Method: "POST",
			Path:   "/api/weight/reminder/toggle",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["enabled"],
  "properties": {
    "enabled": {"type": "boolean", "description": "true to enable weight reminders, false to turn them off"}
  }
}`),
			Description:     "Enable or disable the weight measurement reminder.",
			ResponseSummary: "Object {enabled, status:\"success\"}.",
			Example: `api.call("health.weight.reminder.toggle", body={"enabled": True})
output({"enabled": True})`,
		},
		{
			ID:              "health.weight.reminder.snooze",
			Topic:           "health",
			Method:          "POST",
			Path:            "/api/weight/reminder/snooze",
			Risk:            RiskWrite,
			Description:     "Snooze the weight reminder and clear any pending notification.",
			ResponseSummary: "Object {status:\"success\", message}.",
			Example: `api.call("health.weight.reminder.snooze")
output({"snoozed": True})`,
		},
		{
			ID:              "health.weight.reminder.dontbug",
			Topic:           "health",
			Method:          "POST",
			Path:            "/api/weight/reminder/dontbug",
			Risk:            RiskWrite,
			Description:     "Suppress weight reminders until the user re-enables them; clears any pending notification.",
			ResponseSummary: "Object {status:\"success\"}.",
			Example: `api.call("health.weight.reminder.dontbug")
output({"silenced": True})`,
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

		// --- Cross-domain dashboard ---
		{
			ID:              "health.overview",
			Topic:           "health",
			Method:          "GET",
			Path:            "/api/health/overview",
			Risk:            RiskRead,
			Description:     "Aggregate dashboard read: recent BP/weight summaries plus medication adherence over a default window. Useful for a single-call \"how am I doing\" snapshot.",
			ResponseSummary: "Aggregate object with bp summary, weight summary, medication adherence stats.",
			Example: `result = api.call("health.overview")
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
			ID:              "health.notes.delete",
			Topic:           "health",
			Method:          "DELETE",
			Path:            "/api/notes/{id}",
			PathParams:      []string{"id"},
			Risk:            RiskWrite,
			Description:     "Delete a diary note by id. Use when the user asks to remove a sleep/vitals/notes entry.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call("health.notes.delete", path_params={"id": 11})
output({"deleted": 11})`,
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
			Description:     "Create a diary note, optionally tagged. Tag values: SLEEP = sleep log entry; HR / SPO2 = single-sample vitals (heart rate / oxygen saturation, encode the number in content); STEPS = step counts; STRESS = stress / mood entry; NOTE = explicit category for general journaling. Pass null (or omit tag) for an untagged free-form note. Empty/invalid tag values are silently coerced to null.",
			ResponseSummary: "DiaryNote object with id, content, tag, created_at (HTTP 201).",
			Example: `result = api.call(
    "health.notes.create",
    body={"content": "8h, woke once at 4am", "tag": "SLEEP"},
)
output(result)`,
		},
	}
}
