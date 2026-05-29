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
	// The full catalog is terse: ops are returned via CompactOperations, not the
	// schema-bearing Operations slice.
	if len(resp.Operations) != 0 {
		t.Errorf("full catalog should not return full Operations, got %d", len(resp.Operations))
	}
	if len(resp.CompactOperations) != resp.Count {
		t.Errorf("compact_operations length %d != count %d", len(resp.CompactOperations), resp.Count)
	}
	if len(resp.Topics) == 0 {
		t.Error("expected topics list in full catalog response")
	}
}

// TestMCPHelp_FullCatalogIsTerse verifies the terse-catalog contract: compact
// entries carry the five scan fields and nothing heavier (no schemas, no
// example, no path), so the landing call stays token-light.
func TestMCPHelp_FullCatalogIsTerse(t *testing.T) {
	s := testServerWithRegistry(t)
	resp, err := callHelp(t, s, HelpInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.CompactOperations) == 0 {
		t.Fatal("expected compact operations in full catalog")
	}
	for _, op := range resp.CompactOperations {
		if op.ID == "" || op.Topic == "" || op.Method == "" || op.Risk == "" {
			t.Errorf("compact entry missing scan fields: %+v", op)
		}
	}
	if len(resp.Capabilities) == 0 {
		t.Error("expected capabilities in full catalog response")
	}
}

// TestMCPHelp_QuerySearch covers the keyword-search axis: a query returns terse
// matches (no schemas/example) drawn from the registry's Search.
func TestMCPHelp_QuerySearch(t *testing.T) {
	s := testServerWithRegistry(t)
	resp, err := callHelp(t, s, HelpInput{Query: "blood pressure"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Count == 0 || len(resp.CompactOperations) == 0 {
		t.Fatal("expected query matches for 'blood pressure'")
	}
	if len(resp.Operations) != 0 {
		t.Errorf("query results should be terse, got %d full operations", len(resp.Operations))
	}
	if len(resp.CompactOperations) != resp.Count {
		t.Errorf("compact_operations length %d != count %d", len(resp.CompactOperations), resp.Count)
	}
	// Every match should genuinely relate to blood pressure (bp topic/id).
	for _, op := range resp.CompactOperations {
		if !strings.Contains(op.ID, "bp") && !strings.Contains(strings.ToLower(op.Description), "blood pressure") {
			t.Errorf("unexpected match for 'blood pressure': %s", op.ID)
		}
	}
}

// TestMCPHelp_QueryNoMatch verifies an unmatched query returns an empty,
// helpful response rather than an error.
func TestMCPHelp_QueryNoMatch(t *testing.T) {
	s := testServerWithRegistry(t)
	resp, err := callHelp(t, s, HelpInput{Query: "zzz-no-such-operation"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Count != 0 {
		t.Errorf("expected zero matches, got %d", resp.Count)
	}
	if len(resp.CompactOperations) != 0 {
		t.Errorf("expected no compact operations, got %d", len(resp.CompactOperations))
	}
	if resp.NextStep == "" {
		t.Error("expected a helpful NextStep for a no-match query")
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
		{"food", "food.products.search"},
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
			if len(resp.NextTools) == 0 || resp.NextTools[0] != "mcp_call" {
				t.Errorf("NextTools mismatch for topic %q: expected mcp_call first, got %v", tc.topic, resp.NextTools)
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

// TestMCPHelp_FullCatalogIncludesCapabilities verifies that the empty-args
// landing response carries a per-topic capability map; this is the entry-point
// the agent reads to decide which topic can satisfy the user's request.
func TestMCPHelp_FullCatalogIncludesCapabilities(t *testing.T) {
	s := testServerWithRegistry(t)
	resp, err := callHelp(t, s, HelpInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Capabilities) == 0 {
		t.Fatal("expected capabilities map in landing response")
	}

	wantTopics := map[string]bool{"workouts": false, "food": false, "health": false, "medications": false}
	for _, cap := range resp.Capabilities {
		if _, ok := wantTopics[cap.Topic]; ok {
			wantTopics[cap.Topic] = true
		}
		if cap.ReadCount == 0 && cap.WriteCount == 0 {
			t.Errorf("topic %q reports zero ops", cap.Topic)
		}
		if cap.Suggestion == "" {
			t.Errorf("topic %q missing Suggestion", cap.Topic)
		}
	}
	for topic, seen := range wantTopics {
		if !seen {
			t.Errorf("capabilities missing topic %q", topic)
		}
	}

	// The landing note must point the agent at mcp_execute and path_params.
	if !strings.Contains(strings.ToLower(resp.Note), "mcp_execute") {
		t.Errorf("note should reference mcp_execute, got: %s", resp.Note)
	}
	if !strings.Contains(strings.ToLower(resp.Note), "path_params") {
		t.Errorf("note should reference path_params, got: %s", resp.Note)
	}
}

// TestMCPHelp_MedicationsTopicAdvertisesCRUD verifies the medications topic
// surfaces full CRUD via mcp_help so an agent looking for "create a medication"
// finds medications.create instead of giving up like the transcripts showed.
func TestMCPHelp_MedicationsTopicAdvertisesCRUD(t *testing.T) {
	s := testServerWithRegistry(t)
	resp, err := callHelp(t, s, HelpInput{Topic: "medications"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	required := []string{"medications.create", "medications.update", "medications.delete", "medications.restock"}
	seen := make(map[string]bool)
	for _, op := range resp.Operations {
		seen[op.ID] = true
	}
	for _, id := range required {
		if !seen[id] {
			t.Errorf("medications topic missing required op: %s", id)
		}
	}
	// The medications NextStep / Suggestion must mention writing-side actions.
	if !strings.Contains(strings.ToLower(resp.NextStep), "medications.create") {
		t.Errorf("medications next_step should advertise medications.create, got: %s", resp.NextStep)
	}
}

// TestMCPHelp_PathParamsAdvertised checks that ops with {placeholders} expose
// their path_params in HelpEntry, so the agent knows exactly what keys to pass
// in api.call(path_params=...). This is the only signal the agent has when
// composing a script that hits a path-templated route.
func TestMCPHelp_PathParamsAdvertised(t *testing.T) {
	s := testServerWithRegistry(t)
	resp, err := callHelp(t, s, HelpInput{OperationID: "medications.update"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Count != 1 {
		t.Fatalf("expected 1 op, got %d", resp.Count)
	}
	op := resp.Operations[0]
	if len(op.PathParams) != 1 || op.PathParams[0] != "id" {
		t.Errorf("expected path_params=[id], got %v", op.PathParams)
	}
}

// callHelp is a test helper that invokes handleMCPHelp directly.
func callHelp(t *testing.T, s *Server, input HelpInput) (HelpResponse, error) {
	t.Helper()
	_, resp, err := s.handleMCPHelp(context.Background(), nil, input)
	return resp, err
}
