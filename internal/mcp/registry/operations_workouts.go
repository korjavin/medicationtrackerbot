package registry

import "encoding/json"

// WorkoutOperations returns the set of workout-related operations for the registry.
func WorkoutOperations() []*Operation {
	return []*Operation{
		{
			ID:          "workouts.groups.list",
			Topic:       "workouts",
			Method:      "GET",
			Path:        "/api/workout/groups",
			Risk:        RiskRead,
			Description: "List all workout groups for the current user. A group is a named collection of workout variants (e.g. 'Gym A' or 'Home Workout').",
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
    "limit": {"type": "integer", "description": "Max sessions to return (default 20)"},
    "group_id": {"type": "integer", "description": "Filter by group ID (optional)"}
  }
}`),
			Description:     "List recent workout sessions. Sessions represent a scheduled or ad-hoc workout that was completed or skipped.",
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
  "required": ["session_id"],
  "properties": {
    "session_id": {"type": "integer", "description": "Workout session ID"}
  }
}`),
			Description:     "Get detailed information for a specific workout session including all exercise logs.",
			ResponseSummary: "Session object with exercise_logs array containing sets, reps, weight_kg, status, notes per exercise.",
			Example: `result = api.call("workouts.sessions.details", params={"session_id": 42})
output(result)`,
		},
		{
			ID:          "workouts.stats.read",
			Topic:       "workouts",
			Method:      "GET",
			Path:        "/api/workout/stats",
			Risk:        RiskRead,
			Description: "Get aggregated workout statistics including total sessions, completion rate, and per-group summaries.",
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
	}
}
