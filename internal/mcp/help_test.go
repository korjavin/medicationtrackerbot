package mcp

import (
	"context"
	"strings"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/mcp/registry"
)

func testServerWithRegistry(t *testing.T) *Server {
	t.Helper()
	reg := registry.New()
	if err := reg.Register(registry.DefaultOperations()...); err != nil {
		t.Fatalf("register default ops: %v", err)
	}
	s := testServer(90)
	s.reg = reg
	return s
}

func TestMCPHelp_FullCatalog(t *testing.T) {
	s := testServerWithRegistry(t)
	resp, err := callHelp(t, s, HelpInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Count == 0 {
		t.Error("expected at least one operation")
	}
	if len(resp.Operations) != resp.Count {
		t.Errorf("operations length %d != count %d", len(resp.Operations), resp.Count)
	}
	if len(resp.Topics) == 0 {
		t.Error("expected topics list in full catalog response")
	}
	if resp.PythonUsage == "" {
		t.Error("expected python_usage in response")
	}
	if !strings.Contains(resp.PythonUsage, "from medtracker import api, output") {
		t.Errorf("python_usage missing import line, got: %s", resp.PythonUsage)
	}
}

func TestMCPHelp_TopicAll(t *testing.T) {
	s := testServerWithRegistry(t)
	all, err := callHelp(t, s, HelpInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	explicit, err := callHelp(t, s, HelpInput{Topic: "all"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if all.Count != explicit.Count {
		t.Errorf("topic='' and topic='all' returned different counts: %d vs %d", all.Count, explicit.Count)
	}
}

func TestMCPHelp_TopicFilter(t *testing.T) {
	s := testServerWithRegistry(t)
	resp, err := callHelp(t, s, HelpInput{Topic: "workouts"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Count == 0 {
		t.Error("expected workout operations")
	}
	for _, op := range resp.Operations {
		if op.Topic != "workouts" {
			t.Errorf("expected topic 'workouts', got %q for op %s", op.Topic, op.ID)
		}
	}
	if !strings.Contains(strings.ToLower(resp.NextStep), "workout") {
		t.Errorf("NextStep should mention topic, got: %s", resp.NextStep)
	}
}

// TestMCPHelp_WorkoutsTopicHasExamples covers the Task 10 contract: the
// workouts topic response is useful as a starting point for a script —
// the catalog must include the operations the read-only vertical slice
// needs and each entry must carry an executable Python example.
func TestMCPHelp_WorkoutsTopicHasExamples(t *testing.T) {
	s := testServerWithRegistry(t)
	resp, err := callHelp(t, s, HelpInput{Topic: "workouts"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	required := []string{
		"workouts.groups.list",
		"workouts.variants.list",
		"workouts.exercises.list",
		"workouts.sessions.list",
		"workouts.stats.read",
	}
	seen := make(map[string]bool)
	for _, op := range resp.Operations {
		seen[op.ID] = true
		if op.Example == "" {
			t.Errorf("op %s missing example snippet", op.ID)
		}
		if !strings.Contains(op.Example, "from medtracker import api, output") {
			t.Errorf("op %s example missing imports, got: %s", op.ID, op.Example)
		}
		if !strings.Contains(op.Example, "api.call") {
			t.Errorf("op %s example should call api.call, got: %s", op.ID, op.Example)
		}
		if !strings.Contains(op.Example, "output(") {
			t.Errorf("op %s example should call output(), got: %s", op.ID, op.Example)
		}
	}
	for _, id := range required {
		if !seen[id] {
			t.Errorf("workouts topic missing required op: %s", id)
		}
	}

	if !strings.Contains(resp.PythonUsage, "from medtracker import api, output") {
		t.Errorf("PythonUsage should describe the medtracker import, got: %s", resp.PythonUsage)
	}
}

func TestMCPHelp_OperationIDLookup(t *testing.T) {
	s := testServerWithRegistry(t)
	resp, err := callHelp(t, s, HelpInput{OperationID: "workouts.groups.list"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Count != 1 {
		t.Fatalf("expected 1 operation, got %d", resp.Count)
	}
	if resp.Operations[0].ID != "workouts.groups.list" {
		t.Errorf("wrong operation ID: %s", resp.Operations[0].ID)
	}
}

func TestMCPHelp_UnknownTopic(t *testing.T) {
	s := testServerWithRegistry(t)
	resp, err := callHelp(t, s, HelpInput{Topic: "nonexistent-topic"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Count != 0 {
		t.Errorf("expected count 0, got %d", resp.Count)
	}
	if !strings.Contains(resp.NextStep, "not found") {
		t.Errorf("expected NextStep to mention not found, got: %s", resp.NextStep)
	}
	if len(resp.Topics) == 0 {
		t.Error("expected topics list to be populated for suggestions")
	}
}

func TestMCPHelp_UnknownOperationID(t *testing.T) {
	s := testServerWithRegistry(t)
	resp, err := callHelp(t, s, HelpInput{OperationID: "does.not.exist"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Count != 0 {
		t.Errorf("expected count 0, got %d", resp.Count)
	}
	if !strings.Contains(resp.NextStep, "not found") {
		t.Errorf("expected NextStep to mention not found, got: %s", resp.NextStep)
	}
}

func TestMCPHelp_GoalOrientedFields(t *testing.T) {
	s := testServerWithRegistry(t)
	tests := []struct {
		topic        string
		wantNextStep string
	}{
		{"workouts", "workout groups"},
		{"food", "Search for a food item"},
		{"health", "List vital logs"},
		{"medications", "medication schedule"},
		{"", "Pick a topic"},
	}

	for _, tc := range tests {
		t.Run(tc.topic, func(t *testing.T) {
			resp, err := callHelp(t, s, HelpInput{Topic: tc.topic})
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !strings.Contains(resp.NextStep, tc.wantNextStep) {
				t.Errorf("NextStep mismatch for topic %q:\nwant: %s\ngot:  %s", tc.topic, tc.wantNextStep, resp.NextStep)
			}
			if len(resp.NextTools) == 0 || resp.NextTools[0] != "mcp_execute" {
				t.Errorf("NextTools mismatch for topic %q: expected [mcp_execute], got %v", tc.topic, resp.NextTools)
			}
		})
	}
}

func TestMCPHelp_NilRegistry(t *testing.T) {
	s := testServer(90)
	// s.reg is nil
	_, err := callHelp(t, s, HelpInput{})
	if err == nil {
		t.Fatal("expected error when registry is nil")
	}
}

// callHelp is a test helper that invokes handleMCPHelp directly.
func callHelp(t *testing.T, s *Server, input HelpInput) (HelpResponse, error) {
	t.Helper()
	_, resp, err := s.handleMCPHelp(context.Background(), nil, input)
	return resp, err
}
