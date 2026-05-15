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
