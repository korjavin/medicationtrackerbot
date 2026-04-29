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
	}
	for _, id := range required {
		if r.Get(id) == nil {
			t.Errorf("missing required workout operation: %s", id)
		}
	}

	// All workout operations should be read
	for _, op := range ops {
		if op.Risk != RiskRead {
			t.Errorf("workout op %s should be read-only, got %s", op.ID, op.Risk)
		}
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
