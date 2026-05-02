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
// Path-templated IDs (e.g. POST /api/medications/{id}) are supported by the
// bridge via PathParams + the bridge's SubstitutePath; tests in
// internal/server/mcp_bridge_test.go verify substitution and rejection of
// missing/extra/escaped values.
func MedicationOperations() []*Operation {
	return []*Operation{
		// --- Reads ---
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
			Description:     "List the user's medications. By default returns only active medications; pass archived=true for the full set. Use this to find an existing medication's id before update/delete/restock.",
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
			ID:     "medications.restocks.list",
			Topic:  "medications",
			Method: "GET",
			Path:   "/api/medications/{id}/restocks",
			Risk:   RiskRead,
			PathParams: []string{"id"},
			Description:     "List restock events for a medication, newest first.",
			ResponseSummary: "JSON array of Restock rows with id, medication_id, quantity, note, restocked_at.",
			Example: `result = api.call(
    "medications.restocks.list",
    path_params={"id": 1},
)
output(result)`,
		},
		{
			ID:     "medications.inventory.low",
			Topic:  "medications",
			Method: "GET",
			Path:   "/api/inventory/low",
			Risk:   RiskRead,
			ParamsSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "days": {"type": "integer", "minimum": 1, "description": "Threshold in days remaining (default 7); medications projected to run out within this window are returned"}
  }
}`),
			Description:     "List active medications whose inventory is projected to run out within the given days threshold.",
			ResponseSummary: "JSON array of medications enriched with days_remaining (float).",
			Example: `result = api.call("medications.inventory.low", params={"days": 14})
output(result)`,
		},

		// --- Writes: medication CRUD ---
		{
			ID:     "medications.create",
			Topic:  "medications",
			Method: "POST",
			Path:   "/api/medications",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["name", "dosage", "schedule"],
  "properties": {
    "name":            {"type": "string", "description": "Display name; deduped (case-insensitive) against the user's existing meds (active+archived)"},
    "dosage":          {"type": "string", "description": "Free-form dosage label, e.g. \"5 mg\" or \"1 tablet\""},
    "schedule":        {"type": "string", "description": "JSON-encoded ScheduleConfig string. Shape: {\"type\":\"daily|weekly|as_needed\",\"days\":[0..6],\"times\":[\"HH:MM\",...]}. days uses 0=Sunday..6=Saturday and is required for type=weekly. Legacy bare \"HH:MM\" string is also accepted (treated as type=daily). Examples: \"{\\\"type\\\":\\\"daily\\\",\\\"times\\\":[\\\"08:00\\\",\\\"20:00\\\"]}\", \"{\\\"type\\\":\\\"weekly\\\",\\\"days\\\":[6],\\\"times\\\":[\\\"10:00\\\"]}\", \"{\\\"type\\\":\\\"as_needed\\\"}\""},
    "supplement":      {"type": ["boolean", "null"], "description": "Optional flag marking the entry as a supplement instead of a medication"},
    "start_date":      {"type": ["string", "null"], "description": "RFC3339 timestamp; doses before this are not scheduled"},
    "end_date":        {"type": ["string", "null"], "description": "RFC3339 timestamp; doses after this are not scheduled (use to cap a fixed-duration course)"},
    "tz_shift_policy": {"type": "string", "enum": ["", "flexible", "medium", "strict"], "description": "How to reconcile this medication on timezone change. Empty defaults to medium."}
  }
}`),
			Description:     "Create a new medication with a schedule. Routes through the standard create handler: deduped against existing meds, RxNorm-normalized when possible, and interaction-checked against active meds; the response carries any drug-interaction warning.",
			ResponseSummary: "Object {id, status:\"created\", warning} where warning is a non-empty string when drug-drug interactions were detected.",
			Example: `# Mounjaro 5 mg every Saturday at 10:00 for 4 weeks starting next Saturday.
import json
schedule = json.dumps({"type": "weekly", "days": [6], "times": ["10:00"]})
result = api.call(
    "medications.create",
    body={
        "name": "Mounjaro",
        "dosage": "5 mg",
        "schedule": schedule,
        "start_date": "2026-05-09T00:00:00Z",
        "end_date":   "2026-05-30T23:59:59Z",
    },
)
output(result)`,
		},
		{
			ID:     "medications.update",
			Topic:  "medications",
			Method: "POST",
			Path:   "/api/medications/{id}",
			Risk:   RiskWrite,
			PathParams: []string{"id"},
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["name", "dosage", "schedule"],
  "properties": {
    "name":            {"type": "string"},
    "dosage":          {"type": "string"},
    "schedule":        {"type": "string", "description": "JSON-encoded ScheduleConfig (see medications.create for the shape)"},
    "archived":        {"type": "boolean", "description": "Set true to archive (also clears pending intakes); set false to keep active"},
    "supplement":      {"type": ["boolean", "null"]},
    "start_date":      {"type": ["string", "null"]},
    "end_date":        {"type": ["string", "null"]},
    "inventory_count": {"type": ["integer", "null"], "description": "Replace inventory count (units remaining); null leaves it untracked"},
    "tz_shift_policy": {"type": "string", "enum": ["", "flexible", "medium", "strict"]}
  }
}`),
			Description:     "Update a medication. This is a full replacement: omitted fields decode to zero values (false / empty string / null) and overwrite the stored row, so always read the medication via medications.list, mutate the field(s) you want to change, and send the merged object back. Use this to archive (set archived=true) or rename a medication.",
			ResponseSummary: "Object {status:\"updated\", warning} where warning carries any drug-interaction note.",
			Example: `# Archive a medication: list, find the row, flip archived=true, send everything back.
meds = api.call("medications.list", params={"archived": "true"})
target = next(m for m in meds if m["name"] == "Mounjaro" and m["dosage"] == "7.5 mg")
target["archived"] = True
api.call(
    "medications.update",
    path_params={"id": target["id"]},
    body={
        "name":            target["name"],
        "dosage":          target["dosage"],
        "schedule":        target.get("schedule", ""),
        "archived":        True,
        "supplement":      target.get("supplement"),
        "start_date":      target.get("start_date"),
        "end_date":        target.get("end_date"),
        "inventory_count": target.get("inventory_count"),
        "tz_shift_policy": target.get("tz_shift_policy", ""),
    },
)
output({"archived": target["id"]})`,
		},
		{
			ID:         "medications.delete",
			Topic:      "medications",
			Method:     "DELETE",
			Path:       "/api/medications/{id}",
			PathParams: []string{"id"},
			Risk:       RiskWrite,
			Description:     "Permanently delete a medication. Only allowed when the medication is already archived AND has no intake history; otherwise the handler returns 409 (use medications.update with archived=true first, and accept that medications with logged intakes can only be archived).",
			ResponseSummary: "Empty body on success (HTTP 200); 409 with reason when the medication is active or has history.",
			Example: `api.call("medications.delete", path_params={"id": 7})
output({"deleted": 7})`,
		},

		// --- Writes: per-intake controls ---
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
			Description:     "Record a single past medication intake. Routes through MedicationService.LogMedicationAt, which decrements inventory and writes change events. Use this for retroactive logging only — to add future doses, use medications.create with a schedule instead.",
			ResponseSummary: "IntakeLog object with id, medication_id, scheduled_at, taken_at, status.",
			Example: `result = api.call(
    "medications.log_past",
    body={"medication_id": 1, "taken_at": "2026-04-29T08:05:00Z"},
)
output(result)`,
		},
		{
			ID:     "medications.snooze",
			Topic:  "medications",
			Method: "POST",
			Path:   "/api/medications/snooze",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["intake_id"],
  "properties": {
    "intake_id":        {"type": "integer", "description": "Pending intake to snooze"},
    "duration_minutes": {"type": "integer", "minimum": 1, "description": "Defaults to 10 if omitted or non-positive"}
  }
}`),
			Description:     "Snooze a pending intake reminder so it fires again later. Looks up the intake via medications.history first when you need the id.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call(
    "medications.snooze",
    body={"intake_id": 123, "duration_minutes": 15},
)
output({"snoozed": 123})`,
		},
		{
			ID:     "medications.skip",
			Topic:  "medications",
			Method: "POST",
			Path:   "/api/medications/skip",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["intake_id"],
  "properties": {
    "intake_id": {"type": "integer", "description": "Pending intake to mark as skipped"}
  }
}`),
			Description:     "Mark a pending intake as SKIPPED via the domain service (same path as the bot's skip flow). Errors with 409 if the intake is no longer pending.",
			ResponseSummary: "Empty body on success (HTTP 200); 409 if not pending.",
			Example: `api.call("medications.skip", body={"intake_id": 123})
output({"skipped": 123})`,
		},
		{
			ID:     "medications.cancel_intake",
			Topic:  "medications",
			Method: "POST",
			Path:   "/api/medications/cancel-intake",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["intake_ids"],
  "properties": {
    "intake_ids": {"type": "array", "items": {"type": "integer"}, "description": "One or more TAKEN intake ids to revert back to PENDING"}
  }
}`),
			Description:     "Revert one or more TAKEN intakes back to PENDING (undo). Inventory is rolled back inside the handler.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call("medications.cancel_intake", body={"intake_ids": [123, 124]})
output({"reverted": 2})`,
		},
		{
			ID:              "medications.trigger_next_intake",
			Topic:           "medications",
			Method:          "POST",
			Path:            "/api/medications/trigger-next-intake",
			Risk:            RiskWrite,
			Description:     "Confirm the user's next upcoming dose immediately (within a 12-hour window). Useful for \"I'm taking it now, mark it taken early\". Returns 404 if nothing is scheduled in the next 12 hours.",
			ResponseSummary: "Object {status:\"confirmed\", scheduled_at, taken_at, medication_count, medication_names[]}.",
			Example: `result = api.call("medications.trigger_next_intake")
output(result)`,
		},
		{
			ID:     "medications.confirm_schedule",
			Topic:  "medications",
			Method: "POST",
			Path:   "/api/medications/confirm-schedule",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "intake_ids":     {"type": "array", "items": {"type": "integer"}, "description": "Confirm these specific intakes (preferred when known)"},
    "scheduled_at":   {"type": "string", "description": "RFC3339; required when intake_ids is omitted"},
    "medication_ids": {"type": "array", "items": {"type": "integer"}, "description": "Used together with scheduled_at to confirm by (med, time)"}
  }
}`),
			Description:     "Mark intakes as TAKEN. Pass intake_ids when known; otherwise pass scheduled_at + medication_ids and the handler will look up matching intakes. Decrements inventory and clears reminders.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call("medications.confirm_schedule", body={"intake_ids": [123]})
output({"confirmed": 123})`,
		},
		{
			ID:     "medications.intake.update",
			Topic:  "medications",
			Method: "POST",
			Path:   "/api/intakes/update",
			Risk:   RiskWrite,
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["updates"],
  "properties": {
    "updates": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "status"],
        "properties": {
          "id":       {"type": "integer", "description": "Intake row id"},
          "status":   {"type": "string", "enum": ["PENDING", "TAKEN", "SKIPPED", "MISSED"]},
          "taken_at": {"type": "string", "description": "RFC3339; required when status=TAKEN, otherwise ignored"}
        }
      }
    }
  }
}`),
			Description:     "Bulk status update for one or more intakes. Inventory is adjusted automatically when a status transitions to/from TAKEN. Use medications.confirm_schedule for the simpler \"mark taken\" path.",
			ResponseSummary: "Empty body on success (HTTP 200); per-row failures are silently skipped (check medications.history afterwards).",
			Example: `api.call(
    "medications.intake.update",
    body={"updates": [{"id": 123, "status": "SKIPPED"}]},
)
output({"updated": 123})`,
		},
		// --- Timezone transition plans ---
		// When the user changes their timezone in settings, the scheduler creates
		// a TZ transition plan describing how each active medication's schedule
		// should be reconciled. The plan stays PENDING until the user explicitly
		// approves or rejects it. The plan_id comes from a UI surface or a
		// Telegram notification — agents can't list pending plans (no list
		// endpoint), but they can act on a plan_id surfaced elsewhere.
		{
			ID:         "medications.tz_plan.approve",
			Topic:      "medications",
			Method:     "POST",
			Path:       "/api/tz-plan/{id}/approve",
			PathParams: []string{"id"},
			Risk:       RiskWrite,
			Description:     "Approve a pending timezone transition plan, letting the medication scheduler execute the reconciliation. Returns 409 if the plan is no longer pending.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call("medications.tz_plan.approve", path_params={"id": 12})
output({"approved": 12})`,
		},
		{
			ID:         "medications.tz_plan.reject",
			Topic:      "medications",
			Method:     "POST",
			Path:       "/api/tz-plan/{id}/reject",
			PathParams: []string{"id"},
			Risk:       RiskWrite,
			Description:     "Reject a pending timezone transition plan; the stored timezone is reverted to the previous value. Returns 409 if the plan is no longer pending.",
			ResponseSummary: "Empty body on success (HTTP 200).",
			Example: `api.call("medications.tz_plan.reject", path_params={"id": 12})
output({"rejected": 12})`,
		},
		{
			ID:     "medications.restock",
			Topic:  "medications",
			Method: "POST",
			Path:   "/api/medications/{id}/restock",
			Risk:   RiskWrite,
			PathParams: []string{"id"},
			BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["quantity"],
  "properties": {
    "quantity": {"type": "integer", "minimum": 1, "description": "Units added to inventory"},
    "note":     {"type": "string", "description": "Optional free-form note (e.g. pharmacy, batch)"}
  }
}`),
			Description:     "Add a restock event to a medication, increasing its inventory_count.",
			ResponseSummary: "Object {status:\"restocked\", quantity_added, inventory_count}.",
			Example: `api.call(
    "medications.restock",
    path_params={"id": 1},
    body={"quantity": 30, "note": "Pharmacy refill"},
)
output({"restocked": 1})`,
		},
	}
}
