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
