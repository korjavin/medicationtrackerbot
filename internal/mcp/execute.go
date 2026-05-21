package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/mcp/proxy"
	"github.com/korjavin/medicationtrackerbot/internal/mcp/registry"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	defaultExecutorTimeoutMS   = int64(30_000)
	defaultExecutorMaxAPICalls = 100

	// ExecuteStatus* are the stable status codes used in the response envelope and tests.
	ExecuteStatusOK                    = "ok"
	ExecuteStatusScriptError           = "script_error"
	ExecuteStatusTimeout               = "timeout"
	ExecuteStatusSandboxStartupFailure = "sandbox_startup_failure"
	ExecuteStatusProxyDenied           = "proxy_denied"
	ExecuteStatusBackendAppError       = "backend_application_error"
	ExecuteStatusBackendTransportError = "backend_transport_error"

	// ExecuteErr* are stable error code strings embedded in the Error field of
	// the response envelope. They are used as a prefix so callers (including
	// tests) can match on a stable token regardless of the human-readable
	// suffix that follows.
	ExecuteErrMaxConcurrent   = "max_concurrent_runs"
	ExecuteErrInvalidEnvelope = "invalid_runner_envelope"
	ExecuteErrSpawnFailed     = "spawn_failed"
	ExecuteErrConfigMarshal   = "marshal_run_config"
)

// ExecutionRequest is passed to the ExecutionService.
type ExecutionRequest struct {
	Script         string
	Mode           proxy.Mode
	Intent         string
	TimeoutMS      int64
	MaxAPICalls    int
	TopicAllowlist []string
}

// ExecutionResult is returned by the ExecutionService.
type ExecutionResult struct {
	Status   string          // one of ExecuteStatus* constants
	Result   json.RawMessage // final output() value when status is "ok"
	Error    string          // error detail for non-ok statuses
	APICalls int
	Stdout   string
	Stderr   string
	Warnings []string
}

// ExecutionService runs sandboxed Python scripts. Implemented by the executor service (Task 9).
type ExecutionService interface {
	Execute(ctx context.Context, req ExecutionRequest) (*ExecutionResult, error)
}

// SetExecutor wires an execution service into the server. Called from main
// after constructing the server, since the executor lives in a child package
// (`internal/mcp/executor`) that imports this package.
func (s *Server) SetExecutor(exec ExecutionService) {
	s.executor = exec
}

// Registry returns the operation registry. Used by main to wire the executor's
// proxy against the same registry the help/execute tools reference.
func (s *Server) Registry() *registry.Registry {
	return s.reg
}

// ExecuteInput is the JSON-decoded input for the mcp_execute tool.
type ExecuteInput struct {
	Script         string   `json:"script"`
	Mode           string   `json:"mode"`
	Intent         string   `json:"intent"`
	TimeoutMS      int64    `json:"timeout_ms"`
	MaxAPICalls    int      `json:"max_api_calls"`
	TopicAllowlist []string `json:"topic_allowlist"`
}

// ExecuteResponse is the output envelope returned by mcp_execute.
type ExecuteResponse struct {
	Status   string   `json:"status"`
	Result   any      `json:"result,omitempty"`
	Error    string   `json:"error,omitempty"`
	APICalls int      `json:"api_calls"`
	Stdout   string   `json:"stdout,omitempty"`
	Stderr   string   `json:"stderr,omitempty"`
	Warnings []string `json:"warnings,omitempty"`
}

func (s *Server) handleMCPExecute(
	ctx context.Context,
	request *sdkmcp.CallToolRequest,
	input ExecuteInput,
) (*sdkmcp.CallToolResult, ExecuteResponse, error) {
	// Demo-mode per-IP rate limit. The MCP SDK owns tool dispatch and the ctx
	// passed to this handler is the connection-level ctx captured at session-
	// init time — it does NOT change between POSTs in the same session. The
	// per-POST headers (and thus the real client IP) are propagated by the SDK
	// on request.Extra.Header, so the IP is read from there. When the headers
	// are unavailable (direct unit-test calls with a nil request, or
	// trust_proxy=false) all callers share the empty-string bucket; the demo
	// runbook documents AUTH_TRUST_PROXY=1 as required behind Traefik.
	if s.demoLimiter != nil {
		var extra *sdkmcp.RequestExtra
		if request != nil {
			extra = request.Extra
		}
		ip := clientIPFromExtra(extra, s.config.TrustProxy)
		if !s.demoLimiter.Allow(ip) {
			return demoRateLimitResult(int(time.Hour.Seconds())), ExecuteResponse{}, nil
		}
	}

	if strings.TrimSpace(input.Script) == "" {
		return nil, ExecuteResponse{}, fmt.Errorf("script is required and must be non-empty")
	}

	mode := proxy.Mode(input.Mode)
	if mode == "" {
		mode = proxy.ModeReadOnly
	}
	if mode != proxy.ModeReadOnly && mode != proxy.ModeWrite {
		return nil, ExecuteResponse{}, fmt.Errorf("mode must be %q or %q, got %q", proxy.ModeReadOnly, proxy.ModeWrite, mode)
	}

	if mode == proxy.ModeWrite && strings.TrimSpace(input.Intent) == "" {
		return nil, ExecuteResponse{}, fmt.Errorf("intent is required and must be non-empty when mode is %q", proxy.ModeWrite)
	}

	maxTimeoutMS := s.executorMaxTimeoutMS()
	maxAPICalls := s.executorMaxAPICalls()

	timeoutMS := input.TimeoutMS
	if timeoutMS <= 0 || timeoutMS > maxTimeoutMS {
		timeoutMS = maxTimeoutMS
	}
	apiCalls := input.MaxAPICalls
	if apiCalls <= 0 || apiCalls > maxAPICalls {
		apiCalls = maxAPICalls
	}

	if s.executor == nil {
		return nil, ExecuteResponse{}, fmt.Errorf("execution service not configured")
	}

	slog.Info("[MCP] mcp_execute called",
		"mode", mode,
		"timeout_ms", timeoutMS,
		"max_api_calls", apiCalls,
		"topic_count", len(input.TopicAllowlist),
		"has_intent", input.Intent != "",
		"intent", truncateIntentForAudit(input.Intent),
	)

	execReq := ExecutionRequest{
		Script:         input.Script,
		Mode:           mode,
		Intent:         input.Intent,
		TimeoutMS:      timeoutMS,
		MaxAPICalls:    apiCalls,
		TopicAllowlist: input.TopicAllowlist,
	}

	result, err := s.executor.Execute(ctx, execReq)
	if err != nil {
		return nil, ExecuteResponse{}, fmt.Errorf("executor: %w", err)
	}

	var resultVal any
	if len(result.Result) > 0 {
		if err := json.Unmarshal(result.Result, &resultVal); err != nil {
			resultVal = string(result.Result)
		}
	}

	return nil, ExecuteResponse{
		Status:   result.Status,
		Result:   resultVal,
		Error:    result.Error,
		APICalls: result.APICalls,
		Stdout:   result.Stdout,
		Stderr:   result.Stderr,
		Warnings: result.Warnings,
	}, nil
}

// truncateIntentForAudit caps the freeform intent string at a safe length
// before it lands in audit logs. Same idea as the executor's truncate helper;
// kept local to this package so the MCP-side log line doesn't depend on
// the executor implementation.
func truncateIntentForAudit(intent string) string {
	const maxIntentAuditLen = 200
	if len(intent) <= maxIntentAuditLen {
		return intent
	}
	return intent[:maxIntentAuditLen] + "..."
}

func (s *Server) executorMaxTimeoutMS() int64 {
	if s.config != nil && s.config.MaxExecutorTimeoutMS > 0 {
		return s.config.MaxExecutorTimeoutMS
	}
	return defaultExecutorTimeoutMS
}

func (s *Server) executorMaxAPICalls() int {
	if s.config != nil && s.config.MaxExecutorAPICalls > 0 {
		return s.config.MaxExecutorAPICalls
	}
	return defaultExecutorMaxAPICalls
}

// demoRateLimitResult builds the MCP tool response served when an mcp_execute
// caller exceeds the per-IP demo limit. The JSON body shape
// ({"error":"demo_rate_limit","limit":"mcp_execute","retry_after_seconds":N})
// matches the HTTP demoRateLimitMiddleware response so the voice agent /
// frontend can recognise either flavour.
func demoRateLimitResult(retryAfterSeconds int) *sdkmcp.CallToolResult {
	body, err := json.Marshal(map[string]any{
		"error":               "demo_rate_limit",
		"limit":               "mcp_execute",
		"retry_after_seconds": retryAfterSeconds,
	})
	if err != nil {
		body = []byte(`{"error":"demo_rate_limit","limit":"mcp_execute"}`)
	}
	return &sdkmcp.CallToolResult{
		IsError: true,
		Content: []sdkmcp.Content{&sdkmcp.TextContent{Text: string(body)}},
	}
}
