package registry

import "encoding/json"

// HealthOperations returns BP, weight, and diary-note operations.
//
// Sleep, heart rate, SpO2, stress, and steps come from TWO distinct sources —
// do not confuse them:
//
//   - Device-imported time series (wearable / Mi Band): per-night sleep with
//     light/deep/REM/awake phases + efficiency, continuous HR/SpO2/stress
//     samples, and daily step aggregates. These are READ via `health.overview`
//     (fields sleep_stats_7d/30d, heart_rate_history_*, spo2_history_*,
//     stress_history_*, step_stats_*, average_*). This is the source for any
//     "sleep recovery / phase breakdown / vitals trend" analysis.
//   - Manual diary notes tagged SLEEP/HR/SPO2/STEPS/STRESS/NOTE: free-text
//     journaling, written/read via `health.notes.create` / `health.notes.list`.
//     These are NOT the wearable time series and are usually sparse.
//
// If you are looking for structured sleep phases or vitals trends, use
// `health.overview`, NOT `health.notes.list`.
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
			ResponseExample: `[
  {"id": 412, "measured_at": "2026-04-29T08:00:00Z", "systolic": 122, "diastolic": 78, "pulse": 64, "site": "left_arm", "position": "seated", "notes": "", "tag": "morning"},
  {"id": 411, "measured_at": "2026-04-28T21:10:00Z", "systolic": 128, "diastolic": 82, "pulse": 71, "site": "", "position": "", "notes": "", "tag": ""}
]`,
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
			ResponseSummary: "Object with a stats_14 / stats_30 / stats_60 window, each carrying daily-weighted mean systolic and diastolic, the number of days with readings, and the total reading count.",
			ResponseExample: `{
  "stats_14": {"systolic": 124, "diastolic": 80, "days": 12, "readings": 21},
  "stats_30": {"systolic": 125, "diastolic": 81, "days": 26, "readings": 44},
  "stats_60": {"systolic": 126, "diastolic": 81, "days": 51, "readings": 88}
}`,
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
			ResponseSummary: "BPGoal object with target_systolic and target_diastolic; either is omitted when unset, so an empty object means no goal.",
			ResponseExample: `{"target_systolic": 120, "target_diastolic": 80}`,
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
			Description:     "Get the BP reminder state: enabled flag, the hour of day the reminder fires, and the snooze / don't-remind deadlines.",
			ResponseSummary: "ReminderState object with enabled, preferred_reminder_hour, snoozed_until and dont_remind_until.",
			ResponseExample: `{"enabled": true, "preferred_reminder_hour": 20, "snoozed_until": null, "dont_remind_until": null}`,
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
			Description:     "Record a blood pressure reading. Goes through BloodPressureService.CreateReading.",
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
			ResponseExample: `[
  {"id": 88, "measured_at": "2026-04-29T07:00:00Z", "weight": 78.4, "weight_trend": 78.6, "body_fat": 18.2, "muscle_mass": 36.1, "notes": ""},
  {"id": 87, "measured_at": "2026-04-28T07:05:00Z", "weight": 78.7, "weight_trend": 78.7, "body_fat": null, "muscle_mass": null, "notes": ""}
]`,
			Example: `result = api.call("health.weight.list", params={"days": 30})
output(result)`,
		},
		{
			ID:              "health.weight.goal.read",
			Topic:           "health",
			Method:          "GET",
			Path:            "/api/weight/goal",
			Risk:            RiskRead,
			Description:     "Get the user's weight goal (goal weight in kg), plus the highest weight ever logged as the reference point the trajectory is measured from.",
			ResponseSummary: "Object {goal (kg), goal_set_at (RFC3339), goal_date (YYYY-MM-DD, optional), goal_start_weight (kg, optional), highest_weight (kg), highest_date (RFC3339)}. Every field is omitted when unset, so an empty object means no goal and no readings.",
			ResponseExample: `{"goal": 75.0, "goal_set_at": "2026-02-01T08:00:00Z", "highest_weight": 82.5, "highest_date": "2026-01-04T07:30:00Z"}`,
			Example: `result = api.call("health.weight.goal.read")
output(result)`,
		},
		{
			ID:     "health.weight.goal.history.list",
			Topic:  "health",
			Method: "GET",
			Path:   "/api/weight/goals/history",
			Risk:   RiskRead,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "limit": {"type": "integer", "minimum": 1, "maximum": 200, "description": "Cap rows returned (default 100, max 200)"}
  }
}`),
			Description:     "List the user's historical weight goals (append-only, sorted newest first). Useful for retrospective analysis of how a user's goals evolved over time — each row captures the goal weight, target date, and the user's weight at the moment the goal was saved.",
			ResponseSummary: "Object {goals: [{id, user_id, set_at (RFC3339), target_weight (kg), target_date (YYYY-MM-DD), start_weight (kg, optional)}]}.",
			ResponseExample: `{
  "goals": [
    {"id": 3, "user_id": 1, "set_at": "2026-04-01T08:00:00Z", "target_weight": 75.0, "target_date": "2026-07-01", "start_weight": 80.2},
    {"id": 2, "user_id": 1, "set_at": "2026-01-10T08:00:00Z", "target_weight": 78.0, "target_date": "2026-04-01", "start_weight": 82.5}
  ]
}`,
			Example: `result = api.call("health.weight.goal.history.list", params={"limit": 10})
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
			Description:     "Get the weight reminder state. Reminders are temporarily muted while snoozed_until > now or dont_remind_until > now (use this to decide whether to prompt the user). preferred_reminder_hour is the local hour the scheduler fires at.",
			ResponseSummary: "Object {enabled (bool), preferred_reminder_hour (0-23), snoozed_until (RFC3339 or null), dont_remind_until (RFC3339 or null)}.",
			ResponseExample: `{"enabled": true, "preferred_reminder_hour": 9, "snoozed_until": null, "dont_remind_until": null}`,
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
			Description:     "Aggregate dashboard read over a 7d/30d window. THIS IS THE SOURCE FOR DEVICE-IMPORTED SLEEP AND VITALS. Returns per-night sleep with phase breakdown (light/deep/REM/awake minutes + avg heart rate), continuous heart-rate / SpO2 / stress histories, and daily step aggregates — plus their 7d/30d averages. Use this for any sleep-recovery, sleep-phase, or vitals-trend analysis (it replaces the older get_sleep_logs endpoint). For manual sleep journaling instead, see health.notes.*.",
			ResponseSummary: "Object with sleep_stats_7d/sleep_stats_30d (per-night {date, light_mins, deep_mins, rem_mins, awake_mins, total_mins, heart_rate_avg}), average_sleep_hours_7d/30d, heart_rate_history_7d/30d, spo2_history_7d/30d, stress_history_7d/30d (each [{timestamp, min, max, avg}]), step_stats_7d/30d, and average_heart_rate/spo2/stress/steps_7d/30d.",
			ResponseExample: `{
  "sleep_stats_7d": [
    {"date": "2026-04-29", "light_mins": 240, "deep_mins": 90, "rem_mins": 70, "awake_mins": 20, "total_mins": 420, "heart_rate_avg": 56}
  ],
  "average_sleep_hours_7d": 7.1,
  "average_sleep_hours_30d": 6.8,
  "heart_rate_history_7d": [{"timestamp": "2026-04-29T03:00:00Z", "min": 52, "max": 61, "avg": 56}],
  "spo2_history_7d": [{"timestamp": "2026-04-29T03:00:00Z", "min": 95, "max": 99, "avg": 97}],
  "stress_history_7d": [{"timestamp": "2026-04-29T12:00:00Z", "min": 22, "max": 48, "avg": 33}],
  "step_stats_7d": [{"date": "2026-04-29", "steps": 8421}],
  "average_heart_rate_7d": 62, "average_spo2_7d": 97, "average_stress_7d": 34, "average_steps_7d": 7800
}`,
			Example: `result = api.call("health.overview")
# per-night sleep phases for the last 30 days:
output(result["sleep_stats_30d"])`,
		},
		{
			ID:     "health.sleep.list",
			Topic:  "health",
			Method: "GET",
			Path:   "/api/health/sleep",
			Risk:   RiskRead,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "days":  {"type": "integer", "minimum": 1, "description": "Look back this many days from now (default 90; ignored when 'from' is set; may be capped by MCP_MAX_QUERY_DAYS)"},
    "from":  {"type": "string", "description": "Lower bound on session start. RFC3339 timestamp or bare YYYY-MM-DD (UTC). Overrides 'days'."},
    "to":    {"type": "string", "description": "Upper bound on session start. RFC3339 timestamp or bare YYYY-MM-DD (UTC)."},
    "limit": {"type": "integer", "minimum": 1, "maximum": 5000, "description": "Cap rows returned (newest first)."}
  }
}`),
			Description:     "List raw device-imported sleep sessions, newest first, each with full phase breakdown (light/deep/REM/awake minutes), total minutes, turn-over count, and HR/SpO2 averages. This is the detailed, range-queryable sleep source — use it (NOT health.notes.*) for sleep-recovery / phase analysis, and prefer it over health.overview when you need a window other than the trailing 7/30 days (e.g. a past trip). Provide an explicit from/to range or a days look-back. This replaces the older get_sleep_logs endpoint.",
			ResponseSummary: "JSON array of sleep sessions: {id, user_id, start_time, end_time, timezone_offset, day (YYYY-MM-DD), light_minutes, deep_minutes, rem_minutes, awake_minutes, total_minutes, turn_over_count, heart_rate_avg, spo2_avg, user_modified, notes}. Phase/HR fields are omitted when the device did not report them.",
			ResponseExample: `[
  {"id": 305, "user_id": 1, "start_time": "2026-04-28T23:10:00Z", "end_time": "2026-04-29T06:30:00Z", "timezone_offset": 0, "day": "2026-04-29", "light_minutes": 240, "deep_minutes": 90, "rem_minutes": 70, "awake_minutes": 20, "total_minutes": 420, "turn_over_count": 14, "heart_rate_avg": 56, "spo2_avg": 97, "user_modified": false, "notes": "restless"}
]`,
			Example: `# Sleep during a trip, by explicit date range:
result = api.call("health.sleep.list", params={"from": "2026-04-29", "to": "2026-05-13"})
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
			Description:     "List MANUAL diary notes (newest first). Each row carries an optional tag: SLEEP, STRESS, HR, SPO2, STEPS, NOTE. NOTE: this returns hand-written journal entries only, NOT device-imported data. For structured sleep phases or wearable HR/SpO2/stress/step time series, use health.overview instead.",
			ResponseSummary: "JSON array of notes with id, content, tag, created_at.",
			ResponseExample: `[
  {"id": 51, "content": "8h, woke once at 4am", "tag": "SLEEP", "created_at": "2026-04-29T06:40:00Z"},
  {"id": 50, "content": "felt stressed before the meeting", "tag": "STRESS", "created_at": "2026-04-28T14:00:00Z"}
]`,
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
			Description:     "Create a MANUAL diary note, optionally tagged. Tag values: SLEEP = a hand-written sleep journal entry (NOT the device-imported per-night phase data — that lives in health.overview); HR / SPO2 = single-sample vitals (heart rate / oxygen saturation, encode the number in content); STEPS = step counts; STRESS = stress / mood entry; NOTE = explicit category for general journaling. Pass null (or omit tag) for an untagged free-form note. Empty/invalid tag values are silently coerced to null.",
			ResponseSummary: "DiaryNote object with id, content, tag, created_at (HTTP 201).",
			Example: `result = api.call(
    "health.notes.create",
    body={"content": "8h, woke once at 4am", "tag": "SLEEP"},
)
output(result)`,
		},
	}
}
