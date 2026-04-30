package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/mcp/proxy"
)

// fakeExecutionService is a test double for ExecutionService.
type fakeExecutionService struct {
	fn func(ctx context.Context, req ExecutionRequest) (*ExecutionResult, error)
}

func (f *fakeExecutionService) Execute(ctx context.Context, req ExecutionRequest) (*ExecutionResult, error) {
	return f.fn(ctx, req)
}

// fakeOKExecutor returns a successful result regardless of input.
func fakeOKExecutor(result json.RawMessage) *fakeExecutionService {
	return &fakeExecutionService{
		fn: func(_ context.Context, _ ExecutionRequest) (*ExecutionResult, error) {
			return &ExecutionResult{
				Status:   ExecuteStatusOK,
				Result:   result,
				APICalls: 1,
				Stdout:   "hello\n",
			}, nil
		},
	}
}

// fakeErrorExecutor returns a result with the given error status.
func fakeErrorExecutor(status, errMsg string) *fakeExecutionService {
	return &fakeExecutionService{
		fn: func(_ context.Context, _ ExecutionRequest) (*ExecutionResult, error) {
			return &ExecutionResult{
				Status: status,
				Error:  errMsg,
				Stderr: "traceback...",
			}, nil
		},
	}
}

// serverWithExecutor creates a test server with the given executor and config limits.
func serverWithExecutor(exec ExecutionService, maxTimeoutMS int64, maxAPICalls int) *Server {
	s := testServer(90)
	s.executor = exec
	s.config.MaxExecutorTimeoutMS = maxTimeoutMS
	s.config.MaxExecutorAPICalls = maxAPICalls
	return s
}

func callExecute(t *testing.T, s *Server, input ExecuteInput) (ExecuteResponse, error) {
	t.Helper()
	_, resp, err := s.handleMCPExecute(context.Background(), nil, input)
	return resp, err
}

// --- Validation tests ---

func TestMCPExecute_ScriptRequired(t *testing.T) {
	s := serverWithExecutor(fakeOKExecutor(nil), 0, 0)
	_, err := callExecute(t, s, ExecuteInput{Script: ""})
	if err == nil {
		t.Fatal("expected error for empty script")
	}
	if !strings.Contains(err.Error(), "script") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestMCPExecute_ScriptWhitespaceOnly(t *testing.T) {
	s := serverWithExecutor(fakeOKExecutor(nil), 0, 0)
	_, err := callExecute(t, s, ExecuteInput{Script: "   \t\n"})
	if err == nil {
		t.Fatal("expected error for whitespace-only script")
	}
}

func TestMCPExecute_ModeDefault(t *testing.T) {
	var capturedReq ExecutionRequest
	exec := &fakeExecutionService{
		fn: func(_ context.Context, req ExecutionRequest) (*ExecutionResult, error) {
			capturedReq = req
			return &ExecutionResult{Status: ExecuteStatusOK}, nil
		},
	}
	s := serverWithExecutor(exec, 0, 0)
	_, err := callExecute(t, s, ExecuteInput{Script: "output(1)"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capturedReq.Mode != proxy.ModeReadOnly {
		t.Errorf("expected default mode %q, got %q", proxy.ModeReadOnly, capturedReq.Mode)
	}
}

func TestMCPExecute_InvalidMode(t *testing.T) {
	s := serverWithExecutor(fakeOKExecutor(nil), 0, 0)
	_, err := callExecute(t, s, ExecuteInput{Script: "output(1)", Mode: "superuser"})
	if err == nil {
		t.Fatal("expected error for invalid mode")
	}
	if !strings.Contains(err.Error(), "mode") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestMCPExecute_IntentRequiredForWrite(t *testing.T) {
	s := serverWithExecutor(fakeOKExecutor(nil), 0, 0)
	_, err := callExecute(t, s, ExecuteInput{
		Script: "output(1)",
		Mode:   string(proxy.ModeWrite),
		Intent: "",
	})
	if err == nil {
		t.Fatal("expected error for write mode without intent")
	}
	if !strings.Contains(err.Error(), "intent") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestMCPExecute_IntentWhitespaceOnlyRejected(t *testing.T) {
	s := serverWithExecutor(fakeOKExecutor(nil), 0, 0)
	_, err := callExecute(t, s, ExecuteInput{
		Script: "output(1)",
		Mode:   string(proxy.ModeWrite),
		Intent: "   ",
	})
	if err == nil {
		t.Fatal("expected error for whitespace-only intent in write mode")
	}
}

func TestMCPExecute_WriteWithIntentSucceeds(t *testing.T) {
	var capturedReq ExecutionRequest
	exec := &fakeExecutionService{
		fn: func(_ context.Context, req ExecutionRequest) (*ExecutionResult, error) {
			capturedReq = req
			return &ExecutionResult{Status: ExecuteStatusOK}, nil
		},
	}
	s := serverWithExecutor(exec, 0, 0)
	_, err := callExecute(t, s, ExecuteInput{
		Script: "output(1)",
		Mode:   string(proxy.ModeWrite),
		Intent: "testing write mode",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capturedReq.Mode != proxy.ModeWrite {
		t.Errorf("expected mode %q, got %q", proxy.ModeWrite, capturedReq.Mode)
	}
	if capturedReq.Intent != "testing write mode" {
		t.Errorf("intent not forwarded: %q", capturedReq.Intent)
	}
}

// --- Limit capping tests ---

func TestMCPExecute_LimitCapping_TimeoutExceedsMax(t *testing.T) {
	var capturedReq ExecutionRequest
	exec := &fakeExecutionService{
		fn: func(_ context.Context, req ExecutionRequest) (*ExecutionResult, error) {
			capturedReq = req
			return &ExecutionResult{Status: ExecuteStatusOK}, nil
		},
	}
	s := serverWithExecutor(exec, 5_000, 50)
	_, err := callExecute(t, s, ExecuteInput{
		Script:    "output(1)",
		TimeoutMS: 60_000, // exceeds server max of 5000
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capturedReq.TimeoutMS != 5_000 {
		t.Errorf("expected TimeoutMS capped to 5000, got %d", capturedReq.TimeoutMS)
	}
}

func TestMCPExecute_LimitCapping_APICallsExceedsMax(t *testing.T) {
	var capturedReq ExecutionRequest
	exec := &fakeExecutionService{
		fn: func(_ context.Context, req ExecutionRequest) (*ExecutionResult, error) {
			capturedReq = req
			return &ExecutionResult{Status: ExecuteStatusOK}, nil
		},
	}
	s := serverWithExecutor(exec, 0, 10)
	_, err := callExecute(t, s, ExecuteInput{
		Script:      "output(1)",
		MaxAPICalls: 500, // exceeds server max of 10
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capturedReq.MaxAPICalls != 10 {
		t.Errorf("expected MaxAPICalls capped to 10, got %d", capturedReq.MaxAPICalls)
	}
}

func TestMCPExecute_LimitDefault_ZeroUsesDefault(t *testing.T) {
	var capturedReq ExecutionRequest
	exec := &fakeExecutionService{
		fn: func(_ context.Context, req ExecutionRequest) (*ExecutionResult, error) {
			capturedReq = req
			return &ExecutionResult{Status: ExecuteStatusOK}, nil
		},
	}
	// Config has zero limits → defaults kick in.
	s := serverWithExecutor(exec, 0, 0)
	_, err := callExecute(t, s, ExecuteInput{Script: "output(1)"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capturedReq.TimeoutMS != defaultExecutorTimeoutMS {
		t.Errorf("expected default timeout %d, got %d", defaultExecutorTimeoutMS, capturedReq.TimeoutMS)
	}
	if capturedReq.MaxAPICalls != defaultExecutorMaxAPICalls {
		t.Errorf("expected default max_api_calls %d, got %d", defaultExecutorMaxAPICalls, capturedReq.MaxAPICalls)
	}
}

func TestMCPExecute_TopicAllowlistForwarded(t *testing.T) {
	var capturedReq ExecutionRequest
	exec := &fakeExecutionService{
		fn: func(_ context.Context, req ExecutionRequest) (*ExecutionResult, error) {
			capturedReq = req
			return &ExecutionResult{Status: ExecuteStatusOK}, nil
		},
	}
	s := serverWithExecutor(exec, 0, 0)
	_, err := callExecute(t, s, ExecuteInput{
		Script:         "output(1)",
		TopicAllowlist: []string{"workouts", "food"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(capturedReq.TopicAllowlist) != 2 {
		t.Errorf("expected 2 topics, got %d", len(capturedReq.TopicAllowlist))
	}
}

// --- No executor configured ---

func TestMCPExecute_NoExecutorService(t *testing.T) {
	s := testServer(90)
	// s.executor is nil
	_, err := callExecute(t, s, ExecuteInput{Script: "output(1)"})
	if err == nil {
		t.Fatal("expected error when executor is nil")
	}
	if !strings.Contains(err.Error(), "not configured") {
		t.Errorf("unexpected error message: %v", err)
	}
}

// --- Envelope shape tests ---

func TestMCPExecute_SuccessEnvelope(t *testing.T) {
	result := json.RawMessage(`{"groups": [{"id": 1}]}`)
	s := serverWithExecutor(fakeOKExecutor(result), 0, 0)
	resp, err := callExecute(t, s, ExecuteInput{Script: "output(1)"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Status != ExecuteStatusOK {
		t.Errorf("expected status %q, got %q", ExecuteStatusOK, resp.Status)
	}
	if string(resp.Result) != string(result) {
		t.Errorf("result mismatch: got %s", resp.Result)
	}
	if resp.APICalls != 1 {
		t.Errorf("expected api_calls=1, got %d", resp.APICalls)
	}
	if resp.Stdout != "hello\n" {
		t.Errorf("unexpected stdout: %q", resp.Stdout)
	}
	if resp.Error != "" {
		t.Errorf("expected no error field in success, got %q", resp.Error)
	}
}

func TestMCPExecute_ScriptErrorEnvelope(t *testing.T) {
	s := serverWithExecutor(fakeErrorExecutor(ExecuteStatusScriptError, "NameError: name 'x' is not defined"), 0, 0)
	resp, err := callExecute(t, s, ExecuteInput{Script: "output(x)"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Status != ExecuteStatusScriptError {
		t.Errorf("expected status %q, got %q", ExecuteStatusScriptError, resp.Status)
	}
	if !strings.Contains(resp.Error, "NameError") {
		t.Errorf("expected error detail, got %q", resp.Error)
	}
	if resp.Stderr == "" {
		t.Error("expected stderr in script_error envelope")
	}
}

func TestMCPExecute_TimeoutEnvelope(t *testing.T) {
	s := serverWithExecutor(fakeErrorExecutor(ExecuteStatusTimeout, "script exceeded timeout"), 0, 0)
	resp, err := callExecute(t, s, ExecuteInput{Script: "while True: pass"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Status != ExecuteStatusTimeout {
		t.Errorf("expected status %q, got %q", ExecuteStatusTimeout, resp.Status)
	}
	if resp.Error == "" {
		t.Error("expected error detail in timeout envelope")
	}
}

func TestMCPExecute_SandboxStartupFailureEnvelope(t *testing.T) {
	s := serverWithExecutor(fakeErrorExecutor(ExecuteStatusSandboxStartupFailure, "runner process failed to start"), 0, 0)
	resp, err := callExecute(t, s, ExecuteInput{Script: "output(1)"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Status != ExecuteStatusSandboxStartupFailure {
		t.Errorf("expected status %q, got %q", ExecuteStatusSandboxStartupFailure, resp.Status)
	}
}

func TestMCPExecute_ProxyDeniedEnvelope(t *testing.T) {
	s := serverWithExecutor(fakeErrorExecutor(ExecuteStatusProxyDenied, "write_blocked: operation requires write mode"), 0, 0)
	resp, err := callExecute(t, s, ExecuteInput{Script: "output(1)"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Status != ExecuteStatusProxyDenied {
		t.Errorf("expected status %q, got %q", ExecuteStatusProxyDenied, resp.Status)
	}
}

func TestMCPExecute_BackendAppErrorEnvelope(t *testing.T) {
	s := serverWithExecutor(fakeErrorExecutor(ExecuteStatusBackendAppError, "backend returned 404"), 0, 0)
	resp, err := callExecute(t, s, ExecuteInput{Script: "output(1)"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Status != ExecuteStatusBackendAppError {
		t.Errorf("expected status %q, got %q", ExecuteStatusBackendAppError, resp.Status)
	}
}

func TestMCPExecute_BackendTransportErrorEnvelope(t *testing.T) {
	s := serverWithExecutor(fakeErrorExecutor(ExecuteStatusBackendTransportError, "connection refused"), 0, 0)
	resp, err := callExecute(t, s, ExecuteInput{Script: "output(1)"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Status != ExecuteStatusBackendTransportError {
		t.Errorf("expected status %q, got %q", ExecuteStatusBackendTransportError, resp.Status)
	}
}
