package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/mcp/proxy"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

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
