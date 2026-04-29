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
		"workouts.exercises.update": true,
		"workouts.groups.create":    true,
		"workouts.groups.update":    true,
		"workouts.variants.create":  true,
		"workouts.variants.update":  true,
		"workouts.exercises.create": true,
		"workouts.exercises.delete": true,
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
		"food.stats.read",
		"food.targets.read",
		"food.targets.set",
		"food.products.search",
	}
	for _, id := range required {
		if r.Get(id) == nil {
			t.Errorf("missing required food op: %s", id)
		}
	}

	writeOps := map[string]bool{
		"food.log.create":   true,
		"food.targets.set":  true,
	}
	for _, op := range ops {
		want := writeOps[op.ID]
		if want && op.Risk != RiskWrite {
			t.Errorf("food op %s should be write, got %s", op.ID, op.Risk)
		}
		if !want && op.Risk != RiskRead {
			t.Errorf("food op %s should be read, got %s", op.ID, op.Risk)
		}
		if want && op.BodySchema == nil {
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
		"health.bp.stats",
		"health.bp.goal.read",
		"health.weight.list",
		"health.weight.create",
		"health.weight.goal.read",
		"health.notes.list",
		"health.notes.create",
	}
	for _, id := range required {
		if r.Get(id) == nil {
			t.Errorf("missing required health op: %s", id)
		}
	}

	writeOps := map[string]bool{
		"health.bp.create":     true,
		"health.weight.create": true,
		"health.notes.create":  true,
	}
	for _, op := range ops {
		want := writeOps[op.ID]
		if want && op.Risk != RiskWrite {
			t.Errorf("health op %s should be write, got %s", op.ID, op.Risk)
		}
		if !want && op.Risk != RiskRead {
			t.Errorf("health op %s should be read, got %s", op.ID, op.Risk)
		}
		if want && op.BodySchema == nil {
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
	}
	for _, id := range required {
		if r.Get(id) == nil {
			t.Errorf("missing required medication op: %s", id)
		}
	}

	writeOps := map[string]bool{
		"medications.log_past": true,
	}
	for _, op := range ops {
		want := writeOps[op.ID]
		if want && op.Risk != RiskWrite {
			t.Errorf("medication op %s should be write, got %s", op.ID, op.Risk)
		}
		if !want && op.Risk != RiskRead {
			t.Errorf("medication op %s should be read, got %s", op.ID, op.Risk)
		}
		if want && op.BodySchema == nil {
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
