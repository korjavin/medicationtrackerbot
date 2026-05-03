package registry

import (
	"encoding/json"
	"testing"
)

func TestRegister_Validation(t *testing.T) {
	tests := []struct {
		name    string
		op      *Operation
		wantErr string
	}{
		{
			name:    "empty ID",
			op:      &Operation{ID: "", Topic: "t", Method: "GET", Path: "/p", Risk: RiskRead},
			wantErr: "ID must be non-empty",
		},
		{
			name:    "empty Topic",
			op:      &Operation{ID: "a.b", Topic: "", Method: "GET", Path: "/p", Risk: RiskRead},
			wantErr: "Topic must be non-empty",
		},
		{
			name:    "empty Method",
			op:      &Operation{ID: "a.b", Topic: "t", Method: "", Path: "/p", Risk: RiskRead},
			wantErr: "Method must be non-empty",
		},
		{
			name:    "empty Path",
			op:      &Operation{ID: "a.b", Topic: "t", Method: "GET", Path: "", Risk: RiskRead},
			wantErr: "Path must be non-empty",
		},
		{
			name:    "bad risk",
			op:      &Operation{ID: "a.b", Topic: "t", Method: "GET", Path: "/p", Risk: "admin"},
			wantErr: `Risk must be "read" or "write"`,
		},
		{
			name: "valid read",
			op:   &Operation{ID: "a.b", Topic: "t", Method: "GET", Path: "/p", Risk: RiskRead},
		},
		{
			name: "valid write",
			op:   &Operation{ID: "a.b.write", Topic: "t", Method: "POST", Path: "/p", Risk: RiskWrite},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := New()
			err := r.Register(tc.op)
			if tc.wantErr == "" {
				if err != nil {
					t.Errorf("unexpected error: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			if got := err.Error(); got == "" {
				t.Fatalf("error message empty")
			}
		})
	}
}

func TestRegister_DuplicateID(t *testing.T) {
	r := New()
	op := &Operation{ID: "foo.bar", Topic: "foo", Method: "GET", Path: "/foo", Risk: RiskRead}
	if err := r.Register(op); err != nil {
		t.Fatalf("first register: %v", err)
	}
	op2 := &Operation{ID: "foo.bar", Topic: "foo", Method: "GET", Path: "/foo2", Risk: RiskRead}
	if err := r.Register(op2); err == nil {
		t.Fatal("expected duplicate ID error")
	}
}

func TestGet(t *testing.T) {
	r := New()
	op := &Operation{ID: "t.a", Topic: "t", Method: "GET", Path: "/t/a", Risk: RiskRead, Description: "desc"}
	if err := r.Register(op); err != nil {
		t.Fatalf("register: %v", err)
	}

	got := r.Get("t.a")
	if got == nil {
		t.Fatal("Get returned nil for registered operation")
	}
	if got.ID != "t.a" {
		t.Errorf("wrong ID: %s", got.ID)
	}

	if r.Get("nonexistent") != nil {
		t.Error("Get should return nil for unknown ID")
	}
}

func TestByTopic(t *testing.T) {
	r := New()
	ops := []*Operation{
		{ID: "a.one", Topic: "a", Method: "GET", Path: "/a/1", Risk: RiskRead},
		{ID: "a.two", Topic: "a", Method: "GET", Path: "/a/2", Risk: RiskRead},
		{ID: "b.one", Topic: "b", Method: "GET", Path: "/b/1", Risk: RiskRead},
	}
	if err := r.Register(ops...); err != nil {
		t.Fatalf("register: %v", err)
	}

	got := r.ByTopic("a")
	if len(got) != 2 {
		t.Errorf("expected 2 ops for topic a, got %d", len(got))
	}

	got = r.ByTopic("b")
	if len(got) != 1 {
		t.Errorf("expected 1 op for topic b, got %d", len(got))
	}

	got = r.ByTopic("z")
	if got != nil {
		t.Errorf("expected nil for unknown topic, got %v", got)
	}
}

func TestAll(t *testing.T) {
	r := New()
	ops := []*Operation{
		{ID: "x.a", Topic: "x", Method: "GET", Path: "/x/a", Risk: RiskRead},
		{ID: "x.b", Topic: "x", Method: "POST", Path: "/x/b", Risk: RiskWrite},
	}
	if err := r.Register(ops...); err != nil {
		t.Fatalf("register: %v", err)
	}
	all := r.All()
	if len(all) != 2 {
		t.Errorf("expected 2 ops, got %d", len(all))
	}
}

func TestNormalization(t *testing.T) {
	r := New()
	op := &Operation{ID: "FOO.Bar", Topic: "Workouts", Method: "GET", Path: "/p", Risk: RiskRead}
	if err := r.Register(op); err != nil {
		t.Fatalf("register: %v", err)
	}

	// Normalization during Register
	storedOp := r.Get("foo.bar")
	if storedOp == nil {
		t.Fatal("expected operation to be found via normalized ID")
	}
	if storedOp.ID != "foo.bar" {
		t.Errorf("expected ID to be normalized to foo.bar, got %s", storedOp.ID)
	}
	if storedOp.Topic != "workouts" {
		t.Errorf("expected Topic to be normalized to workouts, got %s", storedOp.Topic)
	}

	// Verify original struct was NOT mutated
	if op.ID != "FOO.Bar" {
		t.Errorf("expected original ID to be FOO.Bar, got %s", op.ID)
	}

	// Normalization during Get
	if r.Get("FOO.BAR") == nil {
		t.Error("Get should be case-insensitive")
	}

	// Normalization during ByTopic
	if len(r.ByTopic("WORKOUTS")) == 0 {
		t.Error("ByTopic should be case-insensitive")
	}

	// Normalization during Suggestion
	if r.Suggestion("WORKOUTS") == "" {
		t.Error("Suggestion should be case-insensitive")
	}
}

func TestTopics_Order(t *testing.T) {
	r := New()
	ops := []*Operation{
		{ID: "c.a", Topic: "c", Method: "GET", Path: "/c", Risk: RiskRead},
		{ID: "a.a", Topic: "a", Method: "GET", Path: "/a", Risk: RiskRead},
		{ID: "b.a", Topic: "b", Method: "GET", Path: "/b", Risk: RiskRead},
		{ID: "a.b", Topic: "a", Method: "GET", Path: "/a2", Risk: RiskRead},
	}
	if err := r.Register(ops...); err != nil {
		t.Fatalf("register: %v", err)
	}

	got := r.Topics()
	want := []string{"c", "a", "b"}
	if len(got) != len(want) {
		t.Fatalf("expected %d topics, got %d", len(want), len(got))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("topic at index %d mismatch: want %q, got %q", i, want[i], got[i])
		}
	}
}

func TestMarshalForHelp_Examples(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "empty example",
			input:    "",
			expected: "",
		},
		{
			name:     "simple call",
			input:    `result = api.call("t.read")`,
			expected: "from medtracker import api, output\n\nresult = api.call(\"t.read\")\noutput(result)",
		},
		{
			name:     "already has import",
			input:    "from medtracker import api, output\nresult = api.call(\"t.read\")",
			expected: "from medtracker import api, output\nresult = api.call(\"t.read\")\noutput(result)",
		},
		{
			name:     "already has output",
			input:    "result = api.call(\"t.read\")\noutput(result)",
			expected: "from medtracker import api, output\n\nresult = api.call(\"t.read\")\noutput(result)",
		},
		{
			name:     "already has both",
			input:    "from medtracker import api, output\nresult = api.call(\"t.read\")\noutput(result)",
			expected: "from medtracker import api, output\nresult = api.call(\"t.read\")\noutput(result)",
		},
		{
			name:     "transform api.call to result =",
			input:    `api.call("t.read")`,
			expected: "from medtracker import api, output\n\nresult = api.call(\"t.read\")\noutput(result)",
		},
		{
			name:     "nested api.call should not be transformed",
			input:    `print(api.call("t.read"))`,
			expected: "from medtracker import api, output\n\nprint(api.call(\"t.read\"))",
		},
		{
			name:     "commented out assignment should be ignored",
			input:    "# result = api.call(\"t.read\")\napi.call(\"t.read\")",
			expected: "from medtracker import api, output\n\n# result = api.call(\"t.read\")\nresult = api.call(\"t.read\")\noutput(result)",
		},
		{
			name:     "custom variable name",
			input:    "my_data = api.call(\"t.read\")",
			expected: "from medtracker import api, output\n\nmy_data = api.call(\"t.read\")\noutput(my_data)",
		},
		{
			name:     "missing output in from import",
			input:    "from medtracker import api\nresult = api.call(\"t.read\")",
			expected: "from medtracker import api, output\nresult = api.call(\"t.read\")\noutput(result)",
		},
		{
			name:     "false positive import detection in comments",
			input:    "from medtracker import api\n# Check the output\nresult = api.call(\"t.read\")",
			expected: "from medtracker import api, output\n# Check the output\nresult = api.call(\"t.read\")\noutput(result)",
		},
		{
			name:     "capture last api.call",
			input:    "result = api.call(\"t.one\")\nresult = api.call(\"t.two\")",
			expected: "from medtracker import api, output\n\nresult = api.call(\"t.one\")\nresult = api.call(\"t.two\")\noutput(result)",
		},
		{
			name:     "capture last api.call with different variables",
			input:    "one = api.call(\"t.one\")\ntwo = api.call(\"t.two\")",
			expected: "from medtracker import api, output\n\none = api.call(\"t.one\")\ntwo = api.call(\"t.two\")\noutput(two)",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ops := []*Operation{{Example: tc.input}}
			entries := MarshalForHelp(ops)
			if entries[0].Example != tc.expected {
				t.Errorf("expected:\n%s\ngot:\n%s", tc.expected, entries[0].Example)
			}
		})
	}
}

func TestMarshalForHelp_Shape(t *testing.T) {
	ops := []*Operation{
		{
			ID:              "t.read",
			Topic:           "t",
			Method:          "GET",
			Path:            "/t",
			Risk:            RiskRead,
			Description:     "read something",
			ResponseSummary: "list of things",
			Example:         `api.call("t.read")`,
			ParamsSchema:    json.RawMessage(`{"type":"object"}`),
		},
		{
			ID:          "t.write",
			Topic:       "t",
			Method:      "POST",
			Path:        "/t",
			Risk:        RiskWrite,
			Description: "write something",
			BodySchema:  json.RawMessage(`{"type":"object","properties":{"name":{"type":"string"}}}`),
		},
	}

	entries := MarshalForHelp(ops)
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}

	// Verify first entry
	e0 := entries[0]
	if e0.ID != "t.read" {
		t.Errorf("ID mismatch: %s", e0.ID)
	}
	if e0.Risk != RiskRead {
		t.Errorf("Risk mismatch: %s", e0.Risk)
	}
	if e0.Example == "" {
		t.Error("Example should not be empty")
	}
	if e0.ParamsSchema == nil {
		t.Error("ParamsSchema should be present")
	}
	if e0.BodySchema != nil {
		t.Error("BodySchema should be nil for read op")
	}

	// Verify second entry
	e1 := entries[1]
	if e1.Risk != RiskWrite {
		t.Errorf("Risk mismatch: %s", e1.Risk)
	}
	if e1.BodySchema == nil {
		t.Error("BodySchema should be present for write op")
	}

	// Verify JSON-serializable
	raw, err := json.Marshal(entries)
	if err != nil {
		t.Errorf("MarshalForHelp result is not JSON-serializable: %v", err)
	}
	if len(raw) == 0 {
		t.Error("JSON output is empty")
	}
}

func TestWorkoutOperations(t *testing.T) {
	r := New()
	ops := WorkoutOperations()
	if len(ops) == 0 {
		t.Fatal("WorkoutOperations returned empty slice")
	}
	if err := r.Register(ops...); err != nil {
		t.Fatalf("register workout operations: %v", err)
	}

	// All should be in workouts topic
	byTopic := r.ByTopic("workouts")
	if len(byTopic) != len(ops) {
		t.Errorf("expected %d workout ops, got %d", len(ops), len(byTopic))
	}

	// Spot-check required operations are present
	required := []string{
		"workouts.groups.list",
		"workouts.variants.list",
		"workouts.exercises.list",
		"workouts.sessions.list",
		"workouts.stats.read",
		// Plan mutation ops added in Task 12
		"workouts.groups.create",
		"workouts.groups.update",
		"workouts.variants.create",
		"workouts.variants.update",
		"workouts.exercises.create",
		"workouts.exercises.delete",
	}
	for _, id := range required {
		if r.Get(id) == nil {
			t.Errorf("missing required workout operation: %s", id)
		}
	}

	// All read ops carry RiskRead; the write ops carry RiskWrite. The set of
	// expected write ops is enumerated explicitly so a future regression
	// (e.g. a typo flipping a read op to write) trips the test.
	writeOps := map[string]bool{
		"workouts.exercises.update":         true,
		"workouts.groups.create":            true,
		"workouts.groups.update":            true,
		"workouts.groups.delete":            true,
		"workouts.variants.create":          true,
		"workouts.variants.update":          true,
		"workouts.variants.delete":          true,
		"workouts.exercises.create":         true,
		"workouts.exercises.delete":         true,
		"workouts.exercise_library.create":  true,
		"workouts.exercise_library.update":  true,
		"workouts.exercise_library.delete":  true,
		"workouts.miband.update":            true,
		"workouts.miband.delete":            true,
		"workouts.rotation.initialize":      true,
		"workouts.sessions.adhoc":           true,
		"workouts.sessions.delete":          true,
		"workouts.sessions.snooze":          true,
		"workouts.sessions.skip":            true,
		"workouts.sessions.preskip":         true,
		"workouts.sessions.cancel_preskip":  true,
		"workouts.sessions.next_variant":    true,
		"workouts.sessions.start":           true,
		"workouts.sessions.logs.create":     true,
		"workouts.sessions.logs.update":     true,
		"workouts.sessions.logs.delete":     true,
		"workouts.sessions.status":          true,
	}
	for _, op := range ops {
		wantWrite := writeOps[op.ID]
		if wantWrite && op.Risk != RiskWrite {
			t.Errorf("workout op %s should be write, got %s", op.ID, op.Risk)
		}
		if !wantWrite && op.Risk != RiskRead {
			t.Errorf("workout op %s should be read-only, got %s", op.ID, op.Risk)
		}
	}

	// The original write op must carry a body schema so callers know what
	// payload the backend expects. The registry validation enforces
	// method/path presence; this is a content check.
	updateOp := r.Get("workouts.exercises.update")
	if updateOp == nil {
		t.Fatal("missing workouts.exercises.update")
	}
	if updateOp.BodySchema == nil {
		t.Error("workouts.exercises.update should have a BodySchema")
	}
	if updateOp.ParamsSchema == nil {
		t.Error("workouts.exercises.update should have a ParamsSchema (id query param)")
	}

	// MarshalForHelp should produce valid JSON for workout ops
	entries := MarshalForHelp(ops)
	if len(entries) != len(ops) {
		t.Errorf("MarshalForHelp: expected %d entries, got %d", len(ops), len(entries))
	}
	raw, err := json.Marshal(entries)
	if err != nil {
		t.Errorf("JSON marshal failed: %v", err)
	}
	if len(raw) == 0 {
		t.Error("JSON output empty")
	}
}

// schemasParse asserts that every ParamsSchema/BodySchema value on the given
// ops parses as valid JSON. Catches typos before they reach mcp_help callers.
func schemasParse(t *testing.T, ops []*Operation) {
	t.Helper()
	for _, op := range ops {
		if len(op.ParamsSchema) > 0 {
			var tmp interface{}
			if err := json.Unmarshal(op.ParamsSchema, &tmp); err != nil {
				t.Errorf("op %s: ParamsSchema is not valid JSON: %v", op.ID, err)
			}
		}
		if len(op.BodySchema) > 0 {
			var tmp interface{}
			if err := json.Unmarshal(op.BodySchema, &tmp); err != nil {
				t.Errorf("op %s: BodySchema is not valid JSON: %v", op.ID, err)
			}
		}
	}
}

// uniqueIDs asserts that every op in ops has a distinct ID.
func uniqueIDs(t *testing.T, ops []*Operation) {
	t.Helper()
	seen := make(map[string]struct{}, len(ops))
	for _, op := range ops {
		if _, dup := seen[op.ID]; dup {
			t.Errorf("duplicate op ID within set: %s", op.ID)
		}
		seen[op.ID] = struct{}{}
	}
}

func TestFoodOperations(t *testing.T) {
	ops := FoodOperations()
	if len(ops) == 0 {
		t.Fatal("FoodOperations returned empty slice")
	}
	uniqueIDs(t, ops)

	r := New()
	if err := r.Register(ops...); err != nil {
		t.Fatalf("register food operations: %v", err)
	}

	for _, op := range ops {
		if op.Topic != "food" {
			t.Errorf("op %s: expected topic 'food', got %q", op.ID, op.Topic)
		}
	}

	required := []string{
		"food.log.list",
		"food.log.create",
		"food.log.update",
		"food.log.delete",
		"food.stats.read",
		"food.targets.read",
		"food.targets.set",
		"food.products.search",
		"food.products.update",
		"food.products.delete",
		"food.products.from_logs",
	}
	for _, id := range required {
		if r.Get(id) == nil {
			t.Errorf("missing required food op: %s", id)
		}
	}

	writeOps := map[string]bool{
		"food.log.create":         true,
		"food.log.update":         true,
		"food.log.delete":         true,
		"food.targets.set":        true,
		"food.products.update":    true,
		"food.products.delete":    true,
		"food.products.from_logs": true,
	}
	bodyOptional := map[string]bool{
		"food.log.delete":      true,
		"food.products.delete": true,
	}
	for _, op := range ops {
		want := writeOps[op.ID]
		if want && op.Risk != RiskWrite {
			t.Errorf("food op %s should be write, got %s", op.ID, op.Risk)
		}
		if !want && op.Risk != RiskRead {
			t.Errorf("food op %s should be read, got %s", op.ID, op.Risk)
		}
		if want && !bodyOptional[op.ID] && op.BodySchema == nil {
			t.Errorf("food write op %s missing BodySchema", op.ID)
		}
	}

	schemasParse(t, ops)

	if entries := MarshalForHelp(ops); len(entries) != len(ops) {
		t.Errorf("MarshalForHelp: expected %d entries, got %d", len(ops), len(entries))
	}
}

func TestHealthOperations(t *testing.T) {
	ops := HealthOperations()
	if len(ops) == 0 {
		t.Fatal("HealthOperations returned empty slice")
	}
	uniqueIDs(t, ops)

	r := New()
	if err := r.Register(ops...); err != nil {
		t.Fatalf("register health operations: %v", err)
	}

	for _, op := range ops {
		if op.Topic != "health" {
			t.Errorf("op %s: expected topic 'health', got %q", op.ID, op.Topic)
		}
	}

	required := []string{
		"health.bp.list",
		"health.bp.create",
		"health.bp.delete",
		"health.bp.stats",
		"health.bp.goal.read",
		"health.bp.reminder.status",
		"health.bp.reminder.toggle",
		"health.bp.reminder.snooze",
		"health.bp.reminder.dontbug",
		"health.bp.reminder.test",
		"health.weight.list",
		"health.weight.create",
		"health.weight.delete",
		"health.weight.goal.read",
		"health.weight.reminder.status",
		"health.weight.reminder.toggle",
		"health.weight.reminder.snooze",
		"health.weight.reminder.dontbug",
		"health.notes.list",
		"health.notes.create",
	}
	for _, id := range required {
		if r.Get(id) == nil {
			t.Errorf("missing required health op: %s", id)
		}
	}

	writeOps := map[string]bool{
		"health.bp.create":               true,
		"health.bp.delete":               true,
		"health.bp.reminder.toggle":      true,
		"health.bp.reminder.snooze":      true,
		"health.bp.reminder.dontbug":     true,
		"health.bp.reminder.test":        true,
		"health.weight.create":           true,
		"health.weight.delete":           true,
		"health.weight.reminder.toggle":  true,
		"health.weight.reminder.snooze":  true,
		"health.weight.reminder.dontbug": true,
		"health.notes.create":            true,
		"health.notes.delete":            true,
	}
	// These write ops have no body — only path_params or fixed effect.
	bodyOptional := map[string]bool{
		"health.bp.delete":               true,
		"health.bp.reminder.snooze":      true,
		"health.bp.reminder.dontbug":     true,
		"health.bp.reminder.test":        true,
		"health.weight.delete":           true,
		"health.weight.reminder.snooze":  true,
		"health.weight.reminder.dontbug": true,
		"health.notes.delete":            true,
	}
	for _, op := range ops {
		want := writeOps[op.ID]
		if want && op.Risk != RiskWrite {
			t.Errorf("health op %s should be write, got %s", op.ID, op.Risk)
		}
		if !want && op.Risk != RiskRead {
			t.Errorf("health op %s should be read, got %s", op.ID, op.Risk)
		}
		if want && !bodyOptional[op.ID] && op.BodySchema == nil {
			t.Errorf("health write op %s missing BodySchema", op.ID)
		}
	}

	schemasParse(t, ops)

	// notes.list documents the tag taxonomy, but it should still be a read op
	notesList := r.Get("health.notes.list")
	if notesList == nil {
		t.Fatal("health.notes.list missing")
	}
	if notesList.Description == "" {
		t.Error("health.notes.list missing description (callers need tag taxonomy info)")
	}
}

func TestMedicationOperations(t *testing.T) {
	ops := MedicationOperations()
	if len(ops) == 0 {
		t.Fatal("MedicationOperations returned empty slice")
	}
	uniqueIDs(t, ops)

	r := New()
	if err := r.Register(ops...); err != nil {
		t.Fatalf("register medication operations: %v", err)
	}

	for _, op := range ops {
		if op.Topic != "medications" {
			t.Errorf("op %s: expected topic 'medications', got %q", op.ID, op.Topic)
		}
	}

	required := []string{
		"medications.list",
		"medications.history",
		"medications.next_intake",
		"medications.log_past",
		"medications.create",
		"medications.update",
		"medications.delete",
		"medications.snooze",
		"medications.skip",
		"medications.cancel_intake",
		"medications.trigger_next_intake",
		"medications.confirm_schedule",
		"medications.intake.update",
		"medications.intake.delete",
		"medications.restock",
		"medications.restocks.list",
		"medications.inventory.low",
	}
	for _, id := range required {
		if r.Get(id) == nil {
			t.Errorf("missing required medication op: %s", id)
		}
	}

	writeOps := map[string]bool{
		"medications.log_past":            true,
		"medications.create":              true,
		"medications.update":              true,
		"medications.delete":              true,
		"medications.snooze":              true,
		"medications.skip":                true,
		"medications.cancel_intake":       true,
		"medications.trigger_next_intake": true,
		"medications.confirm_schedule":    true,
		"medications.intake.update":       true,
		"medications.intake.delete":       true,
		"medications.restock":             true,
		"medications.tz_plan.approve":     true,
		"medications.tz_plan.reject":      true,
	}
	bodyOptional := map[string]bool{
		// trigger_next_intake takes no body — the handler uses no input.
		"medications.trigger_next_intake": true,
		// delete is body-less; controlled via path_params only.
		"medications.delete":          true,
		"medications.tz_plan.approve": true,
		"medications.tz_plan.reject":  true,
	}
	for _, op := range ops {
		want := writeOps[op.ID]
		if want && op.Risk != RiskWrite {
			t.Errorf("medication op %s should be write, got %s", op.ID, op.Risk)
		}
		if !want && op.Risk != RiskRead {
			t.Errorf("medication op %s should be read, got %s", op.ID, op.Risk)
		}
		if want && !bodyOptional[op.ID] && op.BodySchema == nil {
			t.Errorf("medication write op %s missing BodySchema", op.ID)
		}
	}

	schemasParse(t, ops)
}

// TestDefaultOperations checks that the default-registration helper assembles
// every per-topic set without ID collisions and produces a fully populated
// registry across all expected topics.
func TestDefaultOperations(t *testing.T) {
	ops := DefaultOperations()
	if len(ops) == 0 {
		t.Fatal("DefaultOperations returned empty slice")
	}
	uniqueIDs(t, ops)

	r := New()
	if err := r.Register(ops...); err != nil {
		t.Fatalf("register default operations: %v", err)
	}

	wantTopics := []string{"workouts", "food", "health", "medications"}
	for _, topic := range wantTopics {
		if got := r.ByTopic(topic); len(got) == 0 {
			t.Errorf("topic %q has no registered operations", topic)
		}
	}

	// Every op must have a non-empty description and a parseable schema set.
	schemasParse(t, ops)
	for _, op := range ops {
		if op.Description == "" {
			t.Errorf("op %s: missing description (mcp_help callers depend on this)", op.ID)
		}
		if op.ResponseSummary == "" {
			t.Errorf("op %s: missing response_summary", op.ID)
		}
	}

	// MarshalForHelp must work for the entire set (used by mcp_help).
	entries := MarshalForHelp(ops)
	if len(entries) != len(ops) {
		t.Errorf("MarshalForHelp: expected %d entries, got %d", len(ops), len(entries))
	}
	if _, err := json.Marshal(entries); err != nil {
		t.Errorf("default ops marshal failed: %v", err)
	}
}

func TestRegister_PathParamsMustMatchPlaceholders(t *testing.T) {
	tests := []struct {
		name    string
		op      *Operation
		wantErr bool
	}{
		{
			name: "no placeholders, no path_params",
			op:   &Operation{ID: "x.a", Topic: "t", Method: "GET", Path: "/api/x", Risk: RiskRead},
		},
		{
			name: "placeholder declared",
			op:   &Operation{ID: "x.b", Topic: "t", Method: "GET", Path: "/api/x/{id}", PathParams: []string{"id"}, Risk: RiskRead},
		},
		{
			name:    "placeholder undeclared",
			op:      &Operation{ID: "x.c", Topic: "t", Method: "GET", Path: "/api/x/{id}", Risk: RiskRead},
			wantErr: true,
		},
		{
			name:    "path_params with no placeholder in path",
			op:      &Operation{ID: "x.d", Topic: "t", Method: "GET", Path: "/api/x", PathParams: []string{"id"}, Risk: RiskRead},
			wantErr: true,
		},
		{
			name:    "duplicate name",
			op:      &Operation{ID: "x.e", Topic: "t", Method: "GET", Path: "/api/x/{id}", PathParams: []string{"id", "id"}, Risk: RiskRead},
			wantErr: true,
		},
		{
			name:    "uppercase name rejected",
			op:      &Operation{ID: "x.f", Topic: "t", Method: "GET", Path: "/api/x/{ID}", PathParams: []string{"ID"}, Risk: RiskRead},
			wantErr: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := New().Register(tc.op)
			if tc.wantErr && err == nil {
				t.Fatal("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestSubstitutePath(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		allowed []string
		values  map[string]string
		want    string
		wantErr bool
	}{
		{
			name: "no placeholder",
			path: "/api/x", want: "/api/x",
		},
		{
			name:    "single id",
			path:    "/api/medications/{id}",
			allowed: []string{"id"},
			values:  map[string]string{"id": "42"},
			want:    "/api/medications/42",
		},
		{
			name:    "two placeholders",
			path:    "/api/medications/{id}/restocks/{rid}",
			allowed: []string{"id", "rid"},
			values:  map[string]string{"id": "1", "rid": "2"},
			want:    "/api/medications/1/restocks/2",
		},
		{
			name:    "missing value",
			path:    "/api/medications/{id}",
			allowed: []string{"id"},
			wantErr: true,
		},
		{
			name:    "extra key rejected",
			path:    "/api/medications",
			values:  map[string]string{"id": "42"},
			wantErr: true,
		},
		{
			name:    "slash escaped",
			path:    "/api/medications/{id}",
			allowed: []string{"id"},
			values:  map[string]string{"id": "1/2"},
			want:    "/api/medications/1%2F2",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := SubstitutePath(tc.path, tc.allowed, tc.values)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}
