package registry

import "encoding/json"

// WorkoutOperations returns the set of workout-related operations for the registry.
func WorkoutOperations() []*Operation {
	return []*Operation{
		{
			ID:              "workouts.groups.list",
			Topic:           "workouts",
			Method:          "GET",
			Path:            "/api/workout/groups",
			Risk:            RiskRead,
			Description:     "List all workout groups for the current user. A group is a named collection of workout variants (e.g. 'Gym A' or 'Home Workout'). Returned ordered alphabetically by name, so the 'first group' is the first element of this array.",
			ResponseSummary: "JSON array of workout group objects with id, name, description, is_rotating, days_of_week, scheduled_time.",
			ResponseExample: `[
  {"id": 1, "name": "Home Workout", "description": "Bodyweight rotation", "is_rotating": true, "days_of_week": "[1,3,5]", "scheduled_time": "07:00"}
]`,
			Example: `result = api.call("workouts.groups.list")
output(result)`,
		},
		{
			ID:     "workouts.variants.list",
			Topic:  "workouts",
			Method: "GET",
			Path:   "/api/workout/variants",
			Risk:   RiskRead,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "required": ["group_id"],
  "properties": {
    "group_id": {"type": "integer", "description": "Workout group ID"}
  }
}`),
			Description:     "List all variants within a workout group. A variant is one rotation slot (e.g. 'Push Day', 'Pull Day').",
			ResponseSummary: "JSON array of variant objects with id, name, group_id; description and rotation_order are omitted when unset (rotation_order is null for a non-rotating group).",
			ResponseExample: `[
  {"id": 5, "name": "Push Day", "description": "chest and triceps", "group_id": 1, "rotation_order": 1},
  {"id": 6, "name": "Pull Day", "description": "back and biceps", "group_id": 1, "rotation_order": 2}
]`,
			Example: `result = api.call("workouts.variants.list", params={"group_id": 1})
output(result)`,
		},
		{
			ID:     "workouts.exercises.list",
			Topic:  "workouts",
			Method: "GET",
			Path:   "/api/workout/exercises",
			Risk:   RiskRead,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "required": ["variant_id"],
  "properties": {
    "variant_id": {"type": "integer", "description": "Workout variant ID"}
  }
}`),
			Description:     "List all exercises in a workout variant. Returns exercises with their default sets, reps, and weight.",
			ResponseSummary: "JSON array of exercise objects with id, variant_id, exercise_name, target_sets, target_reps_min, order_index, exercise_library_id (the canonical library row the name resolves through); target_reps_max, target_weight_kg, and exercise_library_id are omitted when unset.",
			ResponseExample: `[
  {"id": 42, "variant_id": 2, "exercise_name": "Bench Press", "target_sets": 4, "target_reps_min": 6, "target_reps_max": 8, "target_weight_kg": 65.0, "order_index": 0, "exercise_library_id": 17}
]`,
			Example: `result = api.call("workouts.exercises.list", params={"variant_id": 2})
output(result)`,
		},
		{
			ID:     "workouts.sessions.list",
			Topic:  "workouts",
			Method: "GET",
			Path:   "/api/workout/sessions",
			Risk:   RiskRead,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "limit": {"type": "integer", "minimum": 1, "maximum": 500, "description": "Max sessions to return (default 30, max 500). Absent or <= 0 means the default, never 'all sessions'; larger values are clamped to the max. A full page means there may be more."}
  }
}`),
			Description:     "List recent workout sessions. Sessions represent a scheduled or ad-hoc workout that was completed or skipped. Returned sessions span every group; filter client-side on the returned group_id field if needed.",
			ResponseSummary: "JSON array of session views: {session: {id, group_id, variant_id, scheduled_date, scheduled_time, status, started_at, completed_at, snooze_count}, group_name, variant_name, exercises_count, exercises_completed, total_volume}.",
			ResponseExample: `[
  {
    "session": {"id": 42, "group_id": 1, "variant_id": 5, "scheduled_date": "2026-04-29T00:00:00Z", "scheduled_time": "07:30", "status": "completed", "started_at": "2026-04-29T07:32:00Z", "completed_at": "2026-04-29T08:20:00Z", "snooze_count": 0},
    "group_name": "Home Workout",
    "variant_name": "Push Day",
    "exercises_count": 5,
    "exercises_completed": 5,
    "total_volume": 4820.0
  }
]`,
			Example: `result = api.call("workouts.sessions.list", params={"limit": 10})
output(result)`,
		},
		{
			ID:     "workouts.sessions.details",
			Topic:  "workouts",
			Method: "GET",
			Path:   "/api/workout/sessions/details",
			Risk:   RiskRead,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "required": ["id"],
  "properties": {
    "id": {"type": "integer", "description": "Workout session ID"}
  }
}`),
			Description:     "Get detailed information for a specific workout session including all exercise logs.",
			ResponseSummary: "Object {session, logs}: the session row plus its per-exercise logs (sets_completed, reps_completed, weight_kg, status, notes). Null when no session has that id.",
			ResponseExample: `{
  "session": {"id": 42, "group_id": 1, "variant_id": 5, "scheduled_date": "2026-04-29T00:00:00Z", "scheduled_time": "07:30", "status": "completed", "snooze_count": 0},
  "logs": [
    {"id": 99, "session_id": 42, "exercise_id": 7, "exercise_name": "Bench Press", "sets_completed": 4, "reps_completed": 8, "weight_kg": 65.0, "status": "completed", "logged_at": "2026-04-29T08:10:00Z", "source": "library"}
  ]
}`,
			Example: `result = api.call("workouts.sessions.details", params={"id": 42})
output(result)`,
		},
		{
			ID:              "workouts.stats.read",
			Topic:           "workouts",
			Method:          "GET",
			Path:            "/api/workout/stats",
			Risk: RiskRead,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "range": {"type": "string", "enum": ["7d", "30d", "90d", "all"], "description": "Window the counts and top_exercises cover. Default 30d."}
  }
}`),
			Description:     "Get aggregated workout statistics: session counts, completion rate, the current weekly streak, the most-trained exercises, per-week and per-day activity breakdowns, and the training-load aggregates (working volume / hard sets / reps / PRs, per-week tonnage, and per-exercise totals for EVERY exercise trained in the window). `range` scopes the counts, totals, daily_activity, top_exercises and exercise_totals (default 30d); current_streak_weeks is always whole-history. Warm-up sets (set_type \"warmup\") are excluded from totals, weekly_volume, top_exercises and exercise_totals — they are not working volume, so an exercise logged with warm-ups ONLY has no working sets and is absent from exercise_totals and top_exercises entirely. A HARD set is a working set taken near failure: RIR <= 4, i.e. the logged per-set rpe >= 6. Per-set effort is optional, so a working set with no rpe still counts as hard (\"no opinion\", never \"too easy\"); the rated-but-easy sets that were excluded are reported separately as totals.easy_sets. Effort and coverage are separate fields, so read the one you mean: exercise_totals[].sets counts EVERY working set (ungated — this is the one that answers \"did I train this at all\"), while exercise_totals[].hard_sets, totals.hard_sets and weekly_volume[].hard_sets are effort-gated. There is no per-group breakdown — filter workouts.sessions.list on group_id for that.",
			ResponseSummary: "Stats object with range (the echoed window), total_sessions, completed_sessions, skipped_sessions, completion_rate (percent, 0-100), active_weeks, current_streak_weeks, top_exercises[], weekly_activity[], daily_activity[], totals{volume_kg,hard_sets,easy_sets,reps,pr_count}, weekly_volume[] and exercise_totals[{exercise_name,session_count,sets,hard_sets,reps,total_volume_kg,max_weight_kg}]. weekly_activity buckets by ISO Monday; daily_activity is one entry per LOCAL calendar day inside `range` that saw a completed or skipped session (sparse — rest days are simply absent), ascending by date. top_exercises is the top-8 slice of exercise_totals (same volume math, so the two always agree); exercise_totals covers every exercise with at least one working set in the window. top_exercises/weekly_activity/daily_activity/weekly_volume/exercise_totals are null (not []) when the window holds nothing.",
			ResponseExample: `{
  "range": "30d",
  "total_sessions": 48, "completed_sessions": 40, "skipped_sessions": 8, "completion_rate": 83.3, "active_weeks": 12, "current_streak_weeks": 4,
  "top_exercises": [
    {"exercise_name": "Barbell Row", "session_count": 1, "total_volume_kg": 1200.0, "max_weight_kg": 50.0},
    {"exercise_name": "Squat", "session_count": 1, "total_volume_kg": 1000.0, "max_weight_kg": 100.0}
  ],
  "weekly_activity": [
    {"week": "2026-04-27", "completed": 3, "skipped": 1}
  ],
  "daily_activity": [
    {"date": "2026-04-27", "completed": 1, "skipped": 0},
    {"date": "2026-04-29", "completed": 1, "skipped": 0},
    {"date": "2026-05-01", "completed": 1, "skipped": 1}
  ],
  "totals": {"volume_kg": 2200.0, "hard_sets": 5, "easy_sets": 1, "reps": 34, "pr_count": 1},
  "weekly_volume": [
    {"week": "2026-04-27", "volume_kg": 2200.0, "hard_sets": 5, "reps": 34}
  ],
  "exercise_totals": [
    {"exercise_name": "Barbell Row", "session_count": 1, "sets": 3, "hard_sets": 3, "reps": 24, "total_volume_kg": 1200.0, "max_weight_kg": 50.0},
    {"exercise_name": "Squat", "session_count": 1, "sets": 2, "hard_sets": 2, "reps": 10, "total_volume_kg": 1000.0, "max_weight_kg": 100.0}
  ]
}`,
			Example: `result = api.call("workouts.stats.read")
output(result)`,
		},
		{
			ID:     "workouts.exercises.update",
			Topic:  "workouts",
			Method: "PUT",
			Path:   "/api/workout/exercises/update",
			Risk:   RiskWrite,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "required": ["id"],
  "properties": {
    "id": {"type": "integer", "description": "Workout exercise ID to update"}
  }
}`),
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["exercise_name", "target_sets", "target_reps_min", "order_index"],
  "properties": {
    "exercise_name":    {"type": "string"},
    "target_sets":      {"type": "integer"},
    "target_reps_min":  {"type": "integer"},
    "target_reps_max":  {"type": ["integer", "null"]},
    "target_weight_kg": {"type": ["number", "null"]},
    "order_index":      {"type": "integer"}
  }
}`),
			Description:     "Update the configuration of a workout exercise (name, target sets/reps, weight, ordering). Goes through backend domain validation; the existing exercise must belong to a variant the user owns.",
			ResponseSummary: "Empty body on success (HTTP 200); 4xx with error message on validation failure.",
			Example: `api.call(
    "workouts.exercises.update",
    params={"id": 42},
    body={
        "exercise_name": "Bench Press",
        "target_sets": 4,
        "target_reps_min": 6,
        "target_reps_max": 8,
        "target_weight_kg": 65.0,
        "order_index": 0,
    },
)
output({"updated": 42})`,
		},

		// --- Plan mutation operations: groups, variants, exercises CRUD ---
		{
			ID:     "workouts.groups.create",
			Topic:  "workouts",
			Method: "POST",
			Path:   "/api/workout/groups/create",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["name"],
  "properties": {
    "name":                         {"type": "string"},
    "description":                  {"type": "string"},
    "is_rotating":                  {"type": "boolean", "description": "If true, variants rotate through scheduled days"},
    "days_of_week":                 {"type": "string", "description": "JSON array of weekday indices, e.g. \"[1,3,5]\""},
    "scheduled_time":               {"type": "string", "description": "HH:MM 24-hour clock"},
    "notification_advance_minutes": {"type": "integer"}
  }
}`),
			Description:     "Create a workout group (named collection of variants).",
			ResponseSummary: "WorkoutGroup object with id, name, description, is_rotating, days_of_week, scheduled_time (HTTP 201).",
			Example: `result = api.call(
    "workouts.groups.create",
    body={
        "name": "Home Workout",
        "description": "Bodyweight rotation",
        "is_rotating": True,
        "days_of_week": "[1,3,5]",
        "scheduled_time": "07:00",
        "notification_advance_minutes": 15,
    },
)
output(result)`,
		},
		{
			ID:     "workouts.groups.update",
			Topic:  "workouts",
			Method: "PUT",
			Path:   "/api/workout/groups/update",
			Risk:   RiskWrite,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "required": ["id"],
  "properties": {
    "id": {"type": "integer", "description": "Workout group ID to update"}
  }
}`),
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["name", "description", "is_rotating", "days_of_week", "scheduled_time", "notification_advance_minutes", "active"],
  "properties": {
    "name":                         {"type": "string"},
    "description":                  {"type": "string"},
    "is_rotating":                  {"type": "boolean"},
    "days_of_week":                 {"type": "string"},
    "scheduled_time":               {"type": "string"},
    "notification_advance_minutes": {"type": "integer"},
    "active":                       {"type": "boolean"}
  }
}`),
			Description:     "Update a workout group via FULL REPLACEMENT (not partial update). The schema marks all fields required because they cannot be sent empty; every field in the body overwrites the stored value, and omitted fields decode to zero values (false / empty string / 0) — including active=false, which DEACTIVATES the group. Required workflow: (1) fetch the current group via workouts.groups.list, (2) mutate only the field(s) you want to change, (3) send the merged COMPLETE object back.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `groups = api.call("workouts.groups.list")
current = next(g for g in groups if g["id"] == 1)
current["scheduled_time"] = "06:30"
api.call(
    "workouts.groups.update",
    params={"id": current["id"]},
    body={
        "name":                         current["name"],
        "description":                  current.get("description", ""),
        "is_rotating":                  current["is_rotating"],
        "days_of_week":                 current["days_of_week"],
        "scheduled_time":               current["scheduled_time"],
        "notification_advance_minutes": current.get("notification_advance_minutes", 0),
        "active":                       current.get("active", True),
    },
)
output({"updated": current["id"]})`,
		},
		{
			ID:     "workouts.variants.create",
			Topic:  "workouts",
			Method: "POST",
			Path:   "/api/workout/variants/create",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["group_id", "name"],
  "properties": {
    "group_id":       {"type": "integer"},
    "name":           {"type": "string"},
    "rotation_order": {"type": ["integer", "null"], "description": "Slot in the rotation; null for non-rotating groups"},
    "description":    {"type": "string"}
  }
}`),
			Description:     "Create a workout variant within a group (e.g. 'Push Day').",
			ResponseSummary: "WorkoutVariant object with id, group_id, name, rotation_order, description (HTTP 201).",
			Example: `result = api.call(
    "workouts.variants.create",
    body={"group_id": 1, "name": "Push Day", "rotation_order": 0},
)
output(result)`,
		},
		{
			ID:     "workouts.variants.update",
			Topic:  "workouts",
			Method: "PUT",
			Path:   "/api/workout/variants/update",
			Risk:   RiskWrite,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "required": ["id"],
  "properties": {
    "id": {"type": "integer", "description": "Variant ID to update"}
  }
}`),
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["name", "rotation_order", "description"],
  "properties": {
    "name":           {"type": "string"},
    "rotation_order": {"type": ["integer", "null"]},
    "description":    {"type": "string"}
  }
}`),
			Description:     "Update a workout variant. This is a full replacement: every field in the body overwrites the stored value, so omitted fields decode to zero values (empty string / null) and would clear the existing rotation slot or description. To change a single field, first fetch the current variant via workouts.variants.list and send the merged object back.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `variants = api.call("workouts.variants.list", params={"group_id": 1})
current = next(v for v in variants if v["id"] == 5)
current["name"] = "Pull Day"
api.call(
    "workouts.variants.update",
    params={"id": current["id"]},
    body={
        "name":           current["name"],
        "rotation_order": current.get("rotation_order"),
        "description":    current.get("description", ""),
    },
)
output({"updated": current["id"]})`,
		},
		{
			ID:     "workouts.exercises.create",
			Topic:  "workouts",
			Method: "POST",
			Path:   "/api/workout/exercises/create",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["variant_id", "exercise_name", "target_sets", "target_reps_min", "order_index"],
  "properties": {
    "variant_id":       {"type": "integer"},
    "exercise_name":    {"type": "string"},
    "target_sets":      {"type": "integer"},
    "target_reps_min":  {"type": "integer"},
    "target_reps_max":  {"type": ["integer", "null"]},
    "target_weight_kg": {"type": ["number", "null"]},
    "order_index":      {"type": "integer"}
  }
}`),
			Description:     "Add a new exercise to a workout variant.",
			ResponseSummary: "Empty body on success (HTTP 200/201) with the created exercise persisted.",
			Example: `api.call(
    "workouts.exercises.create",
    body={
        "variant_id": 5,
        "exercise_name": "Pull-ups",
        "target_sets": 3,
        "target_reps_min": 8,
        "target_reps_max": 12,
        "order_index": 0,
    },
)
output({"created": "Pull-ups"})`,
		},
		// --- Catalog reads ---
		{
			ID:              "workouts.exercises.unique",
			Topic:           "workouts",
			Method:          "GET",
			Path:            "/api/workout/exercises/unique",
			Risk:            RiskRead,
			Description:     "List the distinct exercises the user has logged historically: the exercise library when it has entries, else the latest row per distinct exercise name across every variant. Useful for autocomplete or building rotation suggestions.",
			ResponseSummary: "JSON array of exercise objects with id, exercise_name, target_sets, target_reps_min, order_index; target_reps_max and target_weight_kg are omitted when unset. variant_id is 0 for library-backed entries.",
			ResponseExample: `[
  {"id": 42, "variant_id": 0, "exercise_name": "Bench Press", "target_sets": 4, "target_reps_min": 6, "target_reps_max": 8, "target_weight_kg": 65.0, "order_index": 0}
]`,
			Example: `result = api.call("workouts.exercises.unique")
output(result)`,
		},

		// --- Mi Band sync: workouts imported from a Mi Band wearable ---
		{
			ID:     "workouts.miband.list",
			Topic:  "workouts",
			Method: "GET",
			Path:   "/api/workout/miband",
			Risk:   RiskRead,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "limit": {"type": "integer", "minimum": 1, "maximum": 1000, "description": "Max workouts to return (default 100, max 1000). Absent or <= 0 means the default, never 'all workouts'; larger values are clamped to the max. A full page means there may be more."}
  }
}`),
			Description:     "List Mi Band workouts (running, cycling, etc. imported from the wearable).",
			ResponseSummary: "JSON array of Mi Band workouts with activity_name, source_start_ms, source_end_ms, duration_sec, distance_m, steps, calories, heart_rate_avg.",
			ResponseExample: `[
  {"id": 88, "activity_name": "Outdoor Running", "source_start_ms": 1777612200000, "source_end_ms": 1777614600000, "duration_sec": 2400, "distance_m": 5200, "steps": 5400, "calories": 320, "heart_rate_avg": 148}
]`,
			Example: `result = api.call("workouts.miband.list", params={"limit": 30})
output(result)`,
		},
		{
			ID:              "workouts.miband.gps",
			Topic:           "workouts",
			Method:          "GET",
			Path:            "/api/workout/miband/{id}/gps",
			PathParams:      []string{"id"},
			Risk:            RiskRead,
			Description:     "Get GPS track points for a Mi Band workout (when GPS was recorded).",
			ResponseSummary: "JSON array of GPS points with timestamp, lat, lon, ele.",
			ResponseExample: `[
  {"timestamp": "2026-04-29T07:30:00Z", "lat": 40.7128, "lon": -74.006, "ele": 12.0},
  {"timestamp": "2026-04-29T07:30:05Z", "lat": 40.7129, "lon": -74.0061, "ele": 12.3}
]`,
			Example: `result = api.call("workouts.miband.gps", path_params={"id": 88})
output(result)`,
		},
		{
			ID:         "workouts.miband.update",
			Topic:      "workouts",
			Method:     "PATCH",
			Path:       "/api/workout/miband/{id}",
			PathParams: []string{"id"},
			Risk:       RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "description": "Patch shape — only fields you want to update. activity_name, notes, ignore_calc, etc.",
  "additionalProperties": true
}`),
			Description:     "Update a Mi Band workout (e.g. correct activity name, add notes). Patch semantics — omit fields you don't want to change.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call(
    "workouts.miband.update",
    path_params={"id": 88},
    body={"notes": "Easy zone-2 run"},
)
output({"updated": 88})`,
		},
		{
			ID:              "workouts.miband.delete",
			Topic:           "workouts",
			Method:          "DELETE",
			Path:            "/api/workout/miband/{id}",
			PathParams:      []string{"id"},
			Risk:            RiskWrite,
			Description:     "Delete a Mi Band workout entry.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call("workouts.miband.delete", path_params={"id": 88})
output({"deleted": 88})`,
		},

		// --- Rotation state: drives "what variant is next" for rotating groups ---
		{
			ID:     "workouts.rotation.state",
			Topic:  "workouts",
			Method: "GET",
			Path:   "/api/workout/rotation/state",
			Risk:   RiskRead,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "required": ["group_id"],
  "properties": {
    "group_id": {"type": "integer", "description": "Rotating workout group ID"}
  }
}`),
			Description:     "Read one rotating group's rotation state — which variant is queued next. Takes a single group_id; call it once per group.",
			ResponseSummary: "Object {group_id, current_variant_id, last_session_date (may be null), updated_at}. 404 when the group has no rotation state.",
			ResponseExample: `{"group_id": 1, "current_variant_id": 5, "last_session_date": "2026-04-29", "updated_at": "2026-04-29T08:20:00Z"}`,
			Example: `result = api.call("workouts.rotation.state", params={"group_id": 1})
output(result)`,
		},
		{
			ID:     "workouts.rotation.initialize",
			Topic:  "workouts",
			Method: "POST",
			Path:   "/api/workout/rotation/initialize",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["group_id", "starting_variant_id"],
  "properties": {
    "group_id":            {"type": "integer", "description": "Rotating workout group to reposition"},
    "starting_variant_id": {"type": "integer", "description": "Variant the rotation cursor should point at next"}
  }
}`),
			Description:     "Initialize (or reset) one rotating group's rotation state: points its rotation cursor at the given variant. Use after creating new groups/variants, or when manual skips/changes have left the rotation pointing at the wrong variant. Does NOT delete sessions or exercise logs — only repositions the rotation cursor.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call("workouts.rotation.initialize", body={"group_id": 1, "starting_variant_id": 5})
output({"reset": True})`,
		},

		// --- Exercise library: per-user catalogue of exercises with default sets/reps/weight ---
		{
			ID:              "workouts.exercise_library.list",
			Topic:           "workouts",
			Method:          "GET",
			Path:            "/api/workout/exercise-library",
			Risk:            RiskRead,
			Description:     "List the user's exercise library — saved exercises with default sets/reps/weight that the UI offers as autocomplete suggestions when building a workout.",
			ResponseSummary: "JSON array of items with id, name, default_sets, default_reps_min; default_reps_max, default_weight_kg and notes are omitted when unset.",
			ResponseExample: `[
  {"id": 7, "name": "Pull-ups", "default_sets": 3, "default_reps_min": 8, "default_reps_max": 12, "default_weight_kg": 5.0, "notes": "weighted"}
]`,
			Example: `result = api.call("workouts.exercise_library.list")
output(result)`,
		},
		{
			ID:     "workouts.exercise_library.create",
			Topic:  "workouts",
			Method: "POST",
			Path:   "/api/workout/exercise-library/create",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["name", "default_sets", "default_reps_min"],
  "properties": {
    "name":              {"type": "string"},
    "default_sets":      {"type": "integer", "minimum": 1},
    "default_reps_min":  {"type": "integer", "minimum": 1},
    "default_reps_max":  {"type": ["integer", "null"]},
    "default_weight_kg": {"type": ["number", "null"]},
    "notes":             {"type": "string"}
  }
}`),
			Description:     "Add a new entry to the user's exercise library.",
			ResponseSummary: "Created exercise library item.",
			Example: `result = api.call(
    "workouts.exercise_library.create",
    body={"name": "Pull-ups", "default_sets": 3, "default_reps_min": 8, "default_reps_max": 12},
)
output(result)`,
		},
		{
			ID:     "workouts.exercise_library.update",
			Topic:  "workouts",
			Method: "PUT",
			Path:   "/api/workout/exercise-library/update",
			Risk:   RiskWrite,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "required": ["id"],
  "properties": {
    "id": {"type": "integer", "description": "Exercise library item id (passed as a query parameter)"}
  }
}`),
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["name", "default_sets", "default_reps_min"],
  "properties": {
    "name":              {"type": "string"},
    "default_sets":      {"type": "integer", "minimum": 1},
    "default_reps_min":  {"type": "integer", "minimum": 1},
    "default_reps_max":  {"type": ["integer", "null"]},
    "default_weight_kg": {"type": ["number", "null"]},
    "notes":             {"type": "string"}
  }
}`),
			Description:     "Update an exercise library entry. Full-replacement: read with workouts.exercise_library.list first and send the merged object back.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call(
    "workouts.exercise_library.update",
    params={"id": 5},
    body={"name": "Pull-ups", "default_sets": 4, "default_reps_min": 6, "default_reps_max": 10, "default_weight_kg": 0, "notes": "Use neutral grip"},
)
output({"updated": 5})`,
		},
		{
			ID:     "workouts.exercise_library.delete",
			Topic:  "workouts",
			Method: "DELETE",
			Path:   "/api/workout/exercise-library/delete",
			Risk:   RiskWrite,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "required": ["id"],
  "properties": {
    "id": {"type": "integer", "description": "Exercise library item id"}
  }
}`),
			Description:     "Delete an exercise library entry.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call("workouts.exercise_library.delete", params={"id": 5})
output({"deleted": 5})`,
		},

		// --- Workout session per-id actions ---
		{
			ID:              "workouts.sessions.next",
			Topic:           "workouts",
			Method:          "GET",
			Path:            "/api/workout/sessions/next",
			Risk:            RiskRead,
			Description:     "Find the next upcoming or active workout session for the user, in the user's timezone. Includes already-notified sessions for the current day even if the scheduled time has passed.",
			ResponseSummary: "Object {session: {id, scheduled_date, scheduled_time, status, is_snoozed, snoozed_until, is_today}, group_name, variant_name, exercises_count, variant_id, group_id, is_rotating}; null when nothing is upcoming.",
			ResponseExample: `{
  "session": {"id": 43, "scheduled_date": "2026-05-01T00:00:00Z", "scheduled_time": "07:30", "status": "pending", "is_snoozed": false, "snoozed_until": null, "is_today": false},
  "group_name": "Home Workout",
  "variant_name": "Pull Day",
  "exercises_count": 5,
  "variant_id": 6,
  "group_id": 1,
  "is_rotating": true
}`,
			Example: `result = api.call("workouts.sessions.next")
output(result)`,
		},
		{
			ID:              "workouts.sessions.adhoc",
			Topic:           "workouts",
			Method:          "POST",
			Path:            "/api/workout/sessions/adhoc",
			Risk:            RiskWrite,
			Description:     "Create an unscheduled (ad-hoc) workout session for now. The session has group_id=-1 and variant_id=-1 (sentinel values — it's NOT tied to any saved group/variant), status starts as 'in_progress', started_at=NOW. scheduled_time is set to the current clock time in the user's timezone. group_name is always returned as 'Ad-hoc Workout', variant_name is empty. Use this for spontaneous workouts that don't match the rotation schedule; afterwards add exercises via workouts.sessions.logs.create.",
			ResponseSummary: "Object {session, group_name:\"Ad-hoc Workout\", variant_name:\"\"}.",
			Example: `result = api.call("workouts.sessions.adhoc")
output(result)`,
		},
		{
			ID:     "workouts.sessions.schedule",
			Topic:  "workouts",
			Method: "POST",
			Path:   "/api/workout/sessions/schedule",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["scheduled_date", "scheduled_time", "exercises"],
  "properties": {
    "scheduled_date": {"type": "string", "description": "Calendar day for the session in YYYY-MM-DD form (interpreted in the user's timezone)."},
    "scheduled_time": {"type": "string", "description": "24-hour HH:MM clock time for the session."},
    "exercises": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["target_sets", "target_reps_min"],
        "properties": {
          "exercise_id":      {"type": "integer", "description": "Library exercise id; required if exercise_name is omitted. The id must belong to the calling user's library."},
          "exercise_name":    {"type": "string", "description": "Free-form exercise name; required if exercise_id is 0/omitted. When both are provided the supplied name overrides the library item's name."},
          "target_sets":      {"type": "integer", "minimum": 1},
          "target_reps_min":  {"type": "integer", "minimum": 1},
          "target_reps_max":  {"type": ["integer", "null"]},
          "target_weight_kg": {"type": ["number", "null"]}
        }
      }
    }
  }
}`),
			Description:     "Schedule a one-off ad-hoc workout session for a future date and time, with a pre-selected list of planned exercises. The session lands in 'pending' status; at workout time the caller starts it with workouts.sessions.start, fills the pre-created exercise log rows with workouts.sessions.logs.update, then finalizes the session with workouts.sessions.status (status=\"completed\"). Without that final status flip the session row stays in_progress and the scheduler will treat it as stale. Use library exercise ids when available, otherwise pass a free-form exercise_name. This operation is for one-off sessions only — recurring workouts go through the workout group/variant flow.",
			ResponseSummary: "Object {session, planned} where session is the created WorkoutSession (group_id and variant_id are -1 for ad-hoc) and planned is the count of exercise placeholder rows created (HTTP 201).",
			Example: `result = api.call(
    "workouts.sessions.schedule",
    body={
        "scheduled_date": "2026-05-10",
        "scheduled_time": "07:30",
        "exercises": [
            {"exercise_name": "Bench Press", "target_sets": 4, "target_reps_min": 6, "target_reps_max": 8, "target_weight_kg": 70},
            {"exercise_name": "Pull-ups", "target_sets": 3, "target_reps_min": 8},
        ],
    },
)
output(result)`,
		},
		{
			ID:     "workouts.sessions.delete",
			Topic:  "workouts",
			Method: "DELETE",
			Path:   "/api/workout/sessions/delete",
			Risk:   RiskWrite,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "required": ["id"],
  "properties": {
    "id": {"type": "integer", "description": "Workout session id to delete"}
  }
}`),
			Description:     "Delete a workout session by id (passed as a query parameter, not a path placeholder).",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call("workouts.sessions.delete", params={"id": 42})
output({"deleted": 42})`,
		},
		{
			ID:         "workouts.sessions.snooze",
			Topic:      "workouts",
			Method:     "POST",
			Path:       "/api/workout/sessions/{id}/snooze",
			PathParams: []string{"id"},
			Risk:       RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "minutes": {"type": "integer", "minimum": 1, "description": "Snooze duration in minutes; defaults to 60 when omitted or non-positive"}
  }
}`),
			Description:     "Snooze a scheduled workout session so its reminder fires later. Closes any pending notification.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call(
    "workouts.sessions.snooze",
    path_params={"id": 42},
    body={"minutes": 30},
)
output({"snoozed": 42})`,
		},
		{
			ID:              "workouts.sessions.skip",
			Topic:           "workouts",
			Method:          "POST",
			Path:            "/api/workout/sessions/{id}/skip",
			PathParams:      []string{"id"},
			Risk:            RiskWrite,
			Description:     "Mark a workout session as skipped. Use cases: user decides not to do today's workout. Permanent — undo via workouts.sessions.cancel_preskip is not available after this.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call("workouts.sessions.skip", path_params={"id": 42})
output({"skipped": 42})`,
		},
		{
			ID:              "workouts.sessions.preskip",
			Topic:           "workouts",
			Method:          "POST",
			Path:            "/api/workout/sessions/{id}/preskip",
			PathParams:      []string{"id"},
			Risk:            RiskWrite,
			Description:     "Preemptively mark a future workout session as skipped (the rotation advances at scheduled time). Reversible via workouts.sessions.cancel_preskip.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call("workouts.sessions.preskip", path_params={"id": 42})
output({"preskipped": 42})`,
		},
		{
			ID:              "workouts.sessions.cancel_preskip",
			Topic:           "workouts",
			Method:          "POST",
			Path:            "/api/workout/sessions/{id}/cancel-preskip",
			PathParams:      []string{"id"},
			Risk:            RiskWrite,
			Description:     "Undo a preskip on a future workout session.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call("workouts.sessions.cancel_preskip", path_params={"id": 42})
output({"cancelled": 42})`,
		},
		{
			ID:              "workouts.sessions.next_variant",
			Topic:           "workouts",
			Method:          "POST",
			Path:            "/api/workout/sessions/{id}/next-variant",
			PathParams:      []string{"id"},
			Risk:            RiskWrite,
			Description:     "Rotate this session to the next variant in the rotation (e.g. switch from Push Day to Pull Day for today).",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call("workouts.sessions.next_variant", path_params={"id": 42})
output({"rotated": 42})`,
		},
		{
			ID:              "workouts.sessions.start",
			Topic:           "workouts",
			Method:          "POST",
			Path:            "/api/workout/sessions/{id}/start",
			PathParams:      []string{"id"},
			Risk:            RiskWrite,
			Description:     "Mark a workout session as in_progress and set started_at to now; clears any snooze and updates the user-facing notification.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call("workouts.sessions.start", path_params={"id": 42})
output({"started": 42})`,
		},

		// --- Per-session exercise log mutations ---
		// These were historically reachable only via the workout_log atomic MCP
		// tool, but the project is consolidating onto mcp_help + mcp_execute,
		// so they are first-class registry operations.
		{
			ID:     "workouts.sessions.logs.create",
			Topic:  "workouts",
			Method: "POST",
			Path:   "/api/workout/sessions/logs/create",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["session_id", "exercise_id", "exercise_name", "target_sets", "target_reps_min"],
  "properties": {
    "session_id":       {"type": "integer", "description": "Workout session id this exercise belongs to"},
    "exercise_id":      {"type": "integer", "description": "Library exercise id (use workouts.exercise_library.list to find it)"},
    "exercise_name":    {"type": "string"},
    "target_sets":      {"type": "integer", "minimum": 1},
    "target_reps_min":  {"type": "integer", "minimum": 1},
    "target_reps_max":  {"type": ["integer", "null"]},
    "target_weight_kg": {"type": ["number", "null"]},
    "status":           {"type": "string", "enum": ["", "completed", "skipped"], "description": "Initial status: \"\" (default) = pending/not yet started; \"completed\" = exercise already done at log time; \"skipped\" = exercise was skipped"},
    "notes":            {"type": "string"},
    "source":           {"type": "string", "enum": ["", "schedule", "library"], "description": "Where the exercise came from. \"\" or \"schedule\" (default) = part of the planned variant; \"library\" = picked from the user's saved exercise library mid-session"}
  }
}`),
			Description:     "Add an exercise log row to an existing workout session. Use when the user adds an exercise mid-session that wasn't part of the planned variant. PREREQUISITE: a session must already exist (find one via workouts.sessions.next or create with workouts.sessions.adhoc); look up exercise_id via workouts.exercise_library.list.",
			ResponseSummary: "Created exercise log row.",
			Example: `result = api.call(
    "workouts.sessions.logs.create",
    body={
        "session_id": 42,
        "exercise_id": 7,
        "exercise_name": "Pull-ups",
        "target_sets": 3,
        "target_reps_min": 8,
        "target_reps_max": 12,
        "status": "completed",
    },
)
output(result)`,
		},
		{
			ID:     "workouts.sessions.logs.update",
			Topic:  "workouts",
			Method: "POST",
			Path:   "/api/workout/sessions/logs/update",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["id"],
  "properties": {
    "id":             {"type": "integer", "description": "Exercise log row id"},
    "sets_completed": {"type": ["integer", "null"], "description": "Actual sets done; non-zero values may propagate to the schedule defaults"},
    "reps_completed": {"type": ["integer", "null"]},
    "weight_kg":      {"type": ["number", "null"]},
    "notes":          {"type": "string"},
    "status":         {"type": "string", "enum": ["", "completed", "skipped"], "description": "Optional. Explicit status to set; if omitted, a placeholder log (status==\"\") with sets_completed>=1 auto-promotes to \"completed\". Existing non-empty status is left untouched unless this field is set."}
  }
}`),
			Description:     "Update an exercise log row with completed sets/reps/weight. SIDE EFFECT: non-zero values propagate to the schedule's defaults so the NEXT session inherits them (e.g. consistently doing 12 reps bumps the planned target up). Zero/null values are treated as 'no data' and do NOT overwrite existing defaults. For scheduled ad-hoc workouts (placeholder logs with empty status), supplying sets_completed >= 1 also flips the row's status to \"completed\" so it counts in stats and history; pass status=\"skipped\" to mark a planned exercise as deliberately skipped instead. Equivalent functionality is also available via the workout_log MCP tool's \"log\" operation; this registry op is for callers building scripts via mcp_execute.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call(
    "workouts.sessions.logs.update",
    body={"id": 99, "sets_completed": 3, "reps_completed": 10, "weight_kg": 14},
)
output({"updated": 99})`,
		},
		{
			ID:     "workouts.sessions.logs.delete",
			Topic:  "workouts",
			Method: "DELETE",
			Path:   "/api/workout/sessions/logs/delete",
			Risk:   RiskWrite,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "required": ["id"],
  "properties": {
    "id": {"type": "integer", "description": "Exercise log row id"}
  }
}`),
			Description:     "Remove an exercise log row from a workout session.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call("workouts.sessions.logs.delete", params={"id": 99})
output({"deleted": 99})`,
		},
		{
			ID:     "workouts.sessions.status",
			Topic:  "workouts",
			Method: "PUT",
			Path:   "/api/workout/sessions/status",
			Risk:   RiskWrite,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "required": ["id"],
  "properties": {
    "id": {"type": "integer", "description": "Workout session id (passed as a query parameter)"}
  }
}`),
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["status"],
  "properties": {
    "status": {"type": "string", "enum": ["in_progress", "completed", "skipped"], "description": "Target session status"}
  }
}`),
			Description:     "Set the status of a workout session (in_progress / completed / skipped). For \"start\" semantics use workouts.sessions.start, which also sets started_at and clears snooze; this op is the lower-level driver.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call(
    "workouts.sessions.status",
    params={"id": 42},
    body={"status": "completed"},
)
output({"completed": 42})`,
		},

		// --- Plan-level deletes (groups / variants) ---
		{
			ID:     "workouts.groups.delete",
			Topic:  "workouts",
			Method: "DELETE",
			Path:   "/api/workout/groups/delete",
			Risk:   RiskWrite,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "required": ["id"],
  "properties": {
    "id": {"type": "integer", "description": "Workout group id"}
  }
}`),
			Description:     "Delete a workout group. Variants and exercises beneath it must already be removed (or the handler returns a constraint error).",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call("workouts.groups.delete", params={"id": 1})
output({"deleted": 1})`,
		},
		{
			ID:     "workouts.variants.delete",
			Topic:  "workouts",
			Method: "DELETE",
			Path:   "/api/workout/variants/delete",
			Risk:   RiskWrite,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "required": ["id"],
  "properties": {
    "id": {"type": "integer", "description": "Workout variant id"}
  }
}`),
			Description:     "Delete a workout variant. Exercises beneath it must already be removed.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call("workouts.variants.delete", params={"id": 5})
output({"deleted": 5})`,
		},
		{
			ID:     "workouts.exercises.delete",
			Topic:  "workouts",
			Method: "DELETE",
			Path:   "/api/workout/exercises/delete",
			Risk:   RiskWrite,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "required": ["id"],
  "properties": {
    "id": {"type": "integer", "description": "Exercise ID to delete"}
  }
}`),
			Description:     "Delete an exercise from a workout variant. The exercise must belong to a variant the user owns.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call("workouts.exercises.delete", params={"id": 42})
output({"deleted": 42})`,
		},
	}
}
