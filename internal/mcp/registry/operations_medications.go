package registry

import "encoding/json"

// MedicationOperations returns medication tracking operations.
//
// Verification gate (per Task 12 of the executor plan): medication writes are
// only exposed because both prerequisites are satisfied:
//
//  1. User identity cannot be spoofed: the bridge endpoint always overrides the
//     user context with the configured allowed user (see internal/server/mcp_bridge.go).
//     Tests in mcp_bridge_test.go verify this.
//  2. Write audit behavior is preserved: writes flow through the existing HTTP
//     handlers and domain services (MedicationService.LogMedicationAt,
//     MedicationStore.AddRestock), which already populate change events
//     and audit fields.
//
// Endpoints with path-templated IDs (e.g. PATCH /api/medications/{id}) are
// not yet supported by the bridge (it forwards Path verbatim and only injects
// query params), so this set is limited to query-param + body routes.
func MedicationOperations() []*Operation {
	return []*Operation{
		{
			ID:     "medications.list",
			Topic:  "medications",
			Method: "GET",
			Path:   "/api/medications",
			Risk:   RiskRead,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "archived": {"type": "string", "description": "Pass 'true' to include archived medications"}
  }
}`),
			Description:     "List the user's medications. By default returns only active medications; pass archived=true for the full set.",
			ResponseSummary: "JSON array of Medication rows with id, name, dosage, schedule, archived, supplement, start_date, end_date, inventory_count, rxcui, normalized_name.",
			Example: `result = api.call("medications.list")
output(result)`,
		},
		{
			ID:     "medications.history",
			Topic:  "medications",
			Method: "GET",
			Path:   "/api/history",
			Risk:   RiskRead,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "days":   {"type": "integer", "minimum": 1, "description": "Look back this many days (default 3; capped by MCP_MAX_QUERY_DAYS)"},
    "med_id": {"type": "integer", "description": "Filter to a single medication by id"}
  }
}`),
			Description:     "List intake log rows (taken/skipped/pending) over a recent window. Filter by medication with med_id.",
			ResponseSummary: "JSON array of IntakeLog rows with id, medication_id, scheduled_at, taken_at, status.",
			Example: `result = api.call("medications.history", params={"days": 7})
output(result)`,
		},
		{
			ID:              "medications.next_intake",
			Topic:           "medications",
			Method:          "GET",
			Path:            "/api/medications/next-intake",
			Risk:            RiskRead,
			Description:     "Compute the next scheduled intake across all active medications, in the user's timezone.",
			ResponseSummary: "Object with scheduled_at (RFC3339) and medication_ids/names; empty fields when nothing is upcoming.",
			Example: `result = api.call("medications.next_intake")
output(result)`,
		},
		{
			ID:     "medications.log_past",
			Topic:  "medications",
			Method: "POST",
			Path:   "/api/medications/log-past",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["medication_id", "taken_at"],
  "properties": {
    "medication_id": {"type": "integer", "description": "Medication to log against"},
    "taken_at":      {"type": "string", "description": "RFC3339 timestamp the dose was taken"}
  }
}`),
			Description:     "Record a past medication intake. Routes through MedicationService.LogMedicationAt, which decrements inventory and writes change events.",
			ResponseSummary: "IntakeLog object with id, medication_id, scheduled_at, taken_at, status.",
			Example: `result = api.call(
    "medications.log_past",
    body={"medication_id": 1, "taken_at": "2026-04-29T08:05:00Z"},
)
output(result)`,
		},
	}
}
