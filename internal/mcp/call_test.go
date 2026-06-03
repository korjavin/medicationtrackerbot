package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/mcp/proxy"
	"github.com/korjavin/medicationtrackerbot/internal/mcp/registry"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

// defaultRegistry builds a registry populated with the real default operations
// so warn-only schema validation has concrete schemas to check against.
func defaultRegistry(t *testing.T) *registry.Registry {
	t.Helper()
	reg := registry.New()
	if err := reg.Register(registry.DefaultOperations()...); err != nil {
		t.Fatalf("register default ops: %v", err)
	}
	return reg
}

// callCall invokes handleMCPCall directly with a background ctx and nil request.
func callCall(t *testing.T, s *Server, input CallInput) (CallResponse, error) {
	t.Helper()
	_, resp, err := s.handleMCPCall(context.Background(), nil, input)
	return resp, err
}

func TestMCPCall_ReadOK(t *testing.T) {
	var captured CallRequest
	exec := &fakeExecutionService{
		callFn: func(_ context.Context, req CallRequest) (*CallResult, error) {
			captured = req
			return &CallResult{
				Status:   ExecuteStatusOK,
				Result:   json.RawMessage(`{"systolic":120}`),
				APICalls: 1,
			}, nil
		},
	}
	s := serverWithExecutor(exec, 0, 0)

	resp, err := callCall(t, s, CallInput{OperationID: "bp.list"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Status != ExecuteStatusOK {
		t.Errorf("status = %q, want %q", resp.Status, ExecuteStatusOK)
	}
	if resp.APICalls != 1 {
		t.Errorf("api_calls = %d, want 1", resp.APICalls)
	}
	m, ok := resp.Result.(map[string]any)
	if !ok {
		t.Fatalf("result is not a JSON object: %#v", resp.Result)
	}
	if m["systolic"] != float64(120) {
		t.Errorf("result.systolic = %v, want 120", m["systolic"])
	}
	if captured.OperationID != "bp.list" {
		t.Errorf("captured operation_id = %q, want bp.list", captured.OperationID)
	}
	if captured.Mode != proxy.ModeReadOnly {
		t.Errorf("captured mode = %q, want %q (default)", captured.Mode, proxy.ModeReadOnly)
	}
}

func TestMCPCall_WriteWithIntentOK(t *testing.T) {
	var captured CallRequest
	exec := &fakeExecutionService{
		callFn: func(_ context.Context, req CallRequest) (*CallResult, error) {
			captured = req
			return &CallResult{Status: ExecuteStatusOK, APICalls: 1}, nil
		},
	}
	s := serverWithExecutor(exec, 0, 0)

	resp, err := callCall(t, s, CallInput{
		OperationID: "medications.create",
		Mode:        string(proxy.ModeWrite),
		Intent:      "Create medication Lisinopril",
		Body:        json.RawMessage(`{"name":"Lisinopril"}`),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Status != ExecuteStatusOK {
		t.Errorf("status = %q, want %q", resp.Status, ExecuteStatusOK)
	}
	if captured.Mode != proxy.ModeWrite {
		t.Errorf("captured mode = %q, want %q", captured.Mode, proxy.ModeWrite)
	}
	if captured.Intent != "Create medication Lisinopril" {
		t.Errorf("captured intent = %q", captured.Intent)
	}
}

func TestMCPCall_WriteMissingIntent(t *testing.T) {
	s := serverWithExecutor(&fakeExecutionService{}, 0, 0)
	_, err := callCall(t, s, CallInput{
		OperationID: "medications.create",
		Mode:        string(proxy.ModeWrite),
		Intent:      "   ",
	})
	if err == nil {
		t.Fatal("expected error for write mode without intent")
	}
	if !strings.Contains(err.Error(), "intent") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestMCPCall_EmptyOperationID(t *testing.T) {
	s := serverWithExecutor(&fakeExecutionService{}, 0, 0)
	_, err := callCall(t, s, CallInput{OperationID: "  "})
	if err == nil {
		t.Fatal("expected error for empty operation_id")
	}
	if !strings.Contains(err.Error(), "operation_id") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestMCPCall_InvalidMode(t *testing.T) {
	s := serverWithExecutor(&fakeExecutionService{}, 0, 0)
	_, err := callCall(t, s, CallInput{OperationID: "bp.list", Mode: "superuser"})
	if err == nil {
		t.Fatal("expected error for invalid mode")
	}
	if !strings.Contains(err.Error(), "mode") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestMCPCall_ExecutorNil(t *testing.T) {
	s := testServer(90)
	// s.executor is nil
	_, err := callCall(t, s, CallInput{OperationID: "bp.list"})
	if err == nil {
		t.Fatal("expected error when executor is nil")
	}
}

func TestMCPCall_ProxyDeniedPassthrough(t *testing.T) {
	exec := &fakeExecutionService{
		callFn: func(_ context.Context, _ CallRequest) (*CallResult, error) {
			return &CallResult{
				Status: ExecuteStatusProxyDenied,
				Error:  "unknown operation",
			}, nil
		},
	}
	s := serverWithExecutor(exec, 0, 0)
	resp, err := callCall(t, s, CallInput{OperationID: "does.not.exist"})
	if err != nil {
		t.Fatalf("unexpected go error: %v", err)
	}
	if resp.Status != ExecuteStatusProxyDenied {
		t.Errorf("status = %q, want %q", resp.Status, ExecuteStatusProxyDenied)
	}
	if resp.Error != "unknown operation" {
		t.Errorf("error = %q, want passthrough", resp.Error)
	}
}

// TestMCPCall_SchemaWarningsWarnOnly verifies that a type-mismatched body
// surfaces warn-only validation warnings while the call still proceeds (the
// faked executor returns ok). Warnings are advisory; they never block.
func TestMCPCall_SchemaWarningsWarnOnly(t *testing.T) {
	exec := &fakeExecutionService{
		callFn: func(_ context.Context, _ CallRequest) (*CallResult, error) {
			return &CallResult{Status: ExecuteStatusOK, APICalls: 1}, nil
		},
	}
	s := serverWithExecutor(exec, 0, 0)
	s.reg = defaultRegistry(t)

	// medications.create declares name/dosage/schedule as strings; pass name as
	// an integer to trip the type check without omitting any required field.
	resp, err := callCall(t, s, CallInput{
		OperationID: "medications.create",
		Mode:        string(proxy.ModeWrite),
		Intent:      "create med with bad-typed name",
		Body:        json.RawMessage(`{"name":123,"dosage":"5 mg","schedule":"08:00"}`),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// The call still proceeds (warn-only).
	if resp.Status != ExecuteStatusOK {
		t.Errorf("status = %q, want %q (warnings must not block)", resp.Status, ExecuteStatusOK)
	}
	if len(resp.Warnings) == 0 {
		t.Fatalf("expected schema warnings, got none")
	}
	var found bool
	for _, w := range resp.Warnings {
		if strings.Contains(w, "body.name") && strings.Contains(w, "expected string") {
			found = true
		}
	}
	if !found {
		t.Errorf("warnings = %v, want one mentioning body.name expected string", resp.Warnings)
	}
}

// TestMCPCall_NoWarningsOnValidInput verifies a well-typed body yields no
// warnings field (omitempty keeps the envelope clean).
func TestMCPCall_NoWarningsOnValidInput(t *testing.T) {
	exec := &fakeExecutionService{
		callFn: func(_ context.Context, _ CallRequest) (*CallResult, error) {
			return &CallResult{Status: ExecuteStatusOK, APICalls: 1}, nil
		},
	}
	s := serverWithExecutor(exec, 0, 0)
	s.reg = defaultRegistry(t)

	resp, err := callCall(t, s, CallInput{
		OperationID: "medications.create",
		Mode:        string(proxy.ModeWrite),
		Intent:      "create med with valid body",
		Body:        json.RawMessage(`{"name":"Lisinopril","dosage":"5 mg","schedule":"08:00"}`),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Warnings) != 0 {
		t.Errorf("warnings = %v, want none for valid input", resp.Warnings)
	}
}

// TestMCPCall_NormalizesMisplacedBodyAndRelativeDate verifies the mcp_call path
// repairs the two common weak-model mistakes before dispatch: write fields put
// in params instead of body, and a relative-date token ("today") in a timestamp
// field. The corrected shape must reach the executor, and the repair must be
// reported as a warning (observable, never silent).
func TestMCPCall_NormalizesMisplacedBodyAndRelativeDate(t *testing.T) {
	var captured CallRequest
	exec := &fakeExecutionService{
		callFn: func(_ context.Context, req CallRequest) (*CallResult, error) {
			captured = req
			return &CallResult{Status: ExecuteStatusOK, APICalls: 1}, nil
		},
	}
	s := serverWithExecutor(exec, 0, 0)
	s.reg = defaultRegistry(t)

	// Mirror gemma's failing call: all body fields in params, eaten_at="today".
	resp, err := callCall(t, s, CallInput{
		OperationID: "food.log.create",
		Mode:        string(proxy.ModeWrite),
		Intent:      "Log two boiled eggs",
		Params: map[string]json.RawMessage{
			"name":     json.RawMessage(`"boiled egg"`),
			"eaten_at": json.RawMessage(`"today"`),
			"weight":   json.RawMessage(`100`),
			"calories": json.RawMessage(`140`),
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Status != ExecuteStatusOK {
		t.Errorf("status = %q, want %q", resp.Status, ExecuteStatusOK)
	}
	// Params should have been emptied (all four are body fields).
	if len(captured.Params) != 0 {
		t.Errorf("expected params coalesced into body, got leftover params %v", captured.Params)
	}
	var body map[string]any
	if err := json.Unmarshal(captured.Body, &body); err != nil {
		t.Fatalf("captured body not valid JSON: %v (%s)", err, captured.Body)
	}
	for _, k := range []string{"name", "eaten_at", "weight", "calories"} {
		if _, ok := body[k]; !ok {
			t.Errorf("coalesced body missing %q: %s", k, captured.Body)
		}
	}
	// "today" must have been resolved to an RFC3339 timestamp, not left literal.
	if ts, _ := body["eaten_at"].(string); ts == "today" || !strings.Contains(ts, "T") {
		t.Errorf("eaten_at not resolved to a timestamp: %v", body["eaten_at"])
	}
	// The repair is reported as a warning.
	joined := strings.Join(resp.Warnings, " | ")
	if !strings.Contains(joined, "into the request body") || !strings.Contains(joined, "resolved relative date") {
		t.Errorf("expected coalesce + date-resolution warnings, got %v", resp.Warnings)
	}
}

// demoCallServer mirrors demoExecuteServer but for the mcp_call path.
func demoCallServer(maxPerHour int) *Server {
	exec := &fakeExecutionService{
		callFn: func(_ context.Context, _ CallRequest) (*CallResult, error) {
			return &CallResult{Status: ExecuteStatusOK, APICalls: 1}, nil
		},
	}
	s := serverWithExecutor(exec, 30_000, 100)
	s.config.DemoMode = true
	s.config.DemoExecuteCallsPerHour = maxPerHour
	s.config.TrustProxy = true
	s.demoLimiter = newRateLimiter(maxPerHour, time.Hour)
	return s
}

func TestMCPCall_DemoRateLimit(t *testing.T) {
	const limit = 2
	s := demoCallServer(limit)

	req := &sdkmcp.CallToolRequest{
		Extra: &sdkmcp.RequestExtra{
			Header: http.Header{"X-Forwarded-For": []string{"1.2.3.4"}},
		},
	}

	for i := 0; i < limit; i++ {
		result, resp, err := s.handleMCPCall(context.Background(), req, CallInput{OperationID: "bp.list"})
		if err != nil {
			t.Fatalf("call %d: unexpected error: %v", i+1, err)
		}
		if result != nil {
			t.Fatalf("call %d: rate-limited early", i+1)
		}
		if resp.Status != ExecuteStatusOK {
			t.Fatalf("call %d: status = %q, want %q", i+1, resp.Status, ExecuteStatusOK)
		}
	}

	// The (limit+1)th call must hit the rate limit.
	result, resp, err := s.handleMCPCall(context.Background(), req, CallInput{OperationID: "bp.list"})
	if err != nil {
		t.Fatalf("rate-limited call returned go error: %v", err)
	}
	body := extractDemoRateLimitBody(t, result)
	if body["error"] != "demo_rate_limit" {
		t.Errorf("body.error = %v, want %q", body["error"], "demo_rate_limit")
	}
	if body["limit"] != "mcp_call" {
		t.Errorf("body.limit = %v, want %q", body["limit"], "mcp_call")
	}
	if resp.Status != ExecuteStatusDemoRateLimit {
		t.Errorf("structured status = %q, want %q", resp.Status, ExecuteStatusDemoRateLimit)
	}
	if resp.Error != "demo_rate_limit" {
		t.Errorf("structured error = %q, want %q", resp.Error, "demo_rate_limit")
	}
}

// TestMCPCall_BackendErrorIsFlaggedAsError verifies that a backend application
// error (e.g. the "Invalid JSON" 400 from the reported food-logging failure) is
// returned with IsError=true so the agent's harness can't read it as success.
func TestMCPCall_BackendErrorIsFlaggedAsError(t *testing.T) {
	exec := &fakeExecutionService{
		callFn: func(_ context.Context, _ CallRequest) (*CallResult, error) {
			return &CallResult{
				Status:   ExecuteStatusBackendAppError,
				Result:   json.RawMessage(`"Invalid JSON\n"`),
				APICalls: 1,
			}, nil
		},
	}
	s := serverWithExecutor(exec, 0, 0)
	result, resp, err := s.handleMCPCall(context.Background(), nil, CallInput{OperationID: "bp.list"})
	if err != nil {
		t.Fatalf("unexpected go error: %v", err)
	}
	if resp.Status != ExecuteStatusBackendAppError {
		t.Errorf("status = %q, want %q", resp.Status, ExecuteStatusBackendAppError)
	}
	if result == nil {
		t.Fatal("expected non-nil CallToolResult so IsError can be surfaced")
	}
	if !result.IsError {
		t.Errorf("expected IsError=true on %q", ExecuteStatusBackendAppError)
	}
}

// TestMCPCall_OKNotFlaggedAsError verifies the happy path still returns a nil
// CallToolResult (isError=false via the SDK auto-envelope).
func TestMCPCall_OKNotFlaggedAsError(t *testing.T) {
	exec := &fakeExecutionService{
		callFn: func(_ context.Context, _ CallRequest) (*CallResult, error) {
			return &CallResult{Status: ExecuteStatusOK, Result: json.RawMessage(`{"id":1}`), APICalls: 1}, nil
		},
	}
	s := serverWithExecutor(exec, 0, 0)
	result, resp, err := s.handleMCPCall(context.Background(), nil, CallInput{OperationID: "bp.list"})
	if err != nil {
		t.Fatalf("unexpected go error: %v", err)
	}
	if resp.Status != ExecuteStatusOK {
		t.Errorf("status = %q, want %q", resp.Status, ExecuteStatusOK)
	}
	if result != nil {
		t.Errorf("expected nil CallToolResult on ok, got %#v", result)
	}
}
