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
			Description:     "List all workout groups for the current user. A group is a named collection of workout variants (e.g. 'Gym A' or 'Home Workout').",
			ResponseSummary: "JSON array of workout group objects with id, name, description, is_rotating, days_of_week, scheduled_time.",
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
			ResponseSummary: "JSON array of variant objects with id, name, description, group_id.",
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
			ResponseSummary: "JSON array of exercise objects with id, name, sets, reps, weight_kg, notes, variant_id.",
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
    "limit": {"type": "integer", "minimum": 1, "maximum": 500, "description": "Max sessions to return (default 30, max 500)"}
  }
}`),
			Description:     "List recent workout sessions. Sessions represent a scheduled or ad-hoc workout that was completed or skipped. Returned sessions span every group; filter client-side on the returned group_id field if needed.",
			ResponseSummary: "JSON array of session objects with id, group_id, variant_id, scheduled_date, status, started_at, completed_at.",
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
			ResponseSummary: "Session object with exercise_logs array containing sets, reps, weight_kg, status, notes per exercise.",
			Example: `result = api.call("workouts.sessions.details", params={"id": 42})
output(result)`,
		},
		{
			ID:              "workouts.stats.read",
			Topic:           "workouts",
			Method:          "GET",
			Path:            "/api/workout/stats",
			Risk:            RiskRead,
			Description:     "Get aggregated workout statistics including total sessions, completion rate, and per-group summaries.",
			ResponseSummary: "Stats object with total_sessions, completed_sessions, skipped_sessions, completion_rate, and per-group breakdowns.",
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
			Description:     "Update a workout group. This is a full replacement: every field in the body overwrites the stored value, so omitted fields decode to zero values (false / empty string / 0) and would clear or deactivate the group. To change a single field, first fetch the current group via workouts.groups.list and send the merged object back.",
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
			Description:     "List the distinct exercise names the user has logged historically (deduped union across all variants and sessions). Useful for autocomplete or building rotation suggestions.",
			ResponseSummary: "JSON array of strings (exercise names).",
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
    "limit": {"type": "integer", "minimum": 1, "maximum": 1000, "description": "Max workouts to return (default 100)"}
  }
}`),
			Description:     "List Mi Band workouts (running, cycling, etc. imported from the wearable).",
			ResponseSummary: "JSON array of Mi Band workouts with activity_name, source_start_ms, source_end_ms, duration_sec, distance_m, steps, calories, heart_rate_avg.",
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
			ID:              "workouts.rotation.state",
			Topic:           "workouts",
			Method:          "GET",
			Path:            "/api/workout/rotation/state",
			Risk:            RiskRead,
			Description:     "Read the current rotation state — which variant is queued next for each rotating workout group.",
			ResponseSummary: "JSON object keyed by group_id with the current rotation slot and pointer.",
			Example: `result = api.call("workouts.rotation.state")
output(result)`,
		},
		{
			ID:              "workouts.rotation.initialize",
			Topic:           "workouts",
			Method:          "POST",
			Path:            "/api/workout/rotation/initialize",
			Risk:            RiskWrite,
			Description:     "Initialize (or reset) the rotation state for all rotating groups. Use after creating new groups/variants or to bring a stale rotation back to a clean baseline.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call("workouts.rotation.initialize")
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
			ResponseSummary: "JSON array of items with id, name, default_sets, default_reps_min, default_reps_max, default_weight_kg, notes.",
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
			ResponseSummary: "Session object with id, group_id, variant_id, scheduled_date, status; or HTTP 204 if nothing is upcoming.",
			Example: `result = api.call("workouts.sessions.next")
output(result)`,
		},
		{
			ID:              "workouts.sessions.adhoc",
			Topic:           "workouts",
			Method:          "POST",
			Path:            "/api/workout/sessions/adhoc",
			Risk:            RiskWrite,
			Description:     "Create an unscheduled (ad-hoc) workout session for now. The server picks a default group/variant and the scheduled_time is the current clock time.",
			ResponseSummary: "Object {session, group_name, variant_name}.",
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
        "required": ["exercise_name", "target_sets", "target_reps_min"],
        "properties": {
          "exercise_id":      {"type": "integer", "description": "Library exercise id; 0 or omitted for a free-form exercise."},
          "exercise_name":    {"type": "string"},
          "target_sets":      {"type": "integer", "minimum": 1},
          "target_reps_min":  {"type": "integer", "minimum": 1},
          "target_reps_max":  {"type": ["integer", "null"]},
          "target_weight_kg": {"type": ["number", "null"]}
        }
      }
    }
  }
}`),
			Description:     "Schedule a one-off ad-hoc workout session for a future date and time, with a pre-selected list of planned exercises. The session lands in 'pending' status; the user can later complete it via workouts.sessions.start followed by workouts.sessions.logs.update on each pre-created exercise log row. Use library exercise ids when available, otherwise pass a free-form exercise_name. This operation is for one-off sessions only — recurring workouts go through the workout group/variant flow.",
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
    "status":           {"type": "string", "enum": ["", "completed", "skipped"], "description": "Initial status; empty means pending"},
    "notes":            {"type": "string"},
    "source":           {"type": "string", "enum": ["", "schedule", "library"], "description": "Defaults to \"schedule\""}
  }
}`),
			Description:     "Add an exercise log row to an existing workout session. Use this when the user wants to add an exercise mid-session that wasn't part of the planned variant.",
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
    "notes":          {"type": "string"}
  }
}`),
			Description:     "Update an exercise log row with completed sets/reps/weight. Non-zero values propagate to the schedule's defaults so the next session inherits them. Equivalent functionality is also available via the workout_log MCP tool's \"log\" operation; this registry op is for callers building scripts via mcp_execute.",
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
