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
	if err := reg.Register(registry.WorkoutOperations()...); err != nil {
		t.Fatalf("register workout ops: %v", err)
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
	if !strings.Contains(resp.Note, "workouts") {
		t.Errorf("note should mention topic, got: %s", resp.Note)
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
	_, err := callHelp(t, s, HelpInput{Topic: "nonexistent-topic"})
	if err == nil {
		t.Fatal("expected error for unknown topic")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestMCPHelp_UnknownOperationID(t *testing.T) {
	s := testServerWithRegistry(t)
	_, err := callHelp(t, s, HelpInput{OperationID: "does.not.exist"})
	if err == nil {
		t.Fatal("expected error for unknown operation_id")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("unexpected error: %v", err)
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
