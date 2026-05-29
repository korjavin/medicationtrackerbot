package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/mcp/proxy"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

// CallInput is the JSON-decoded input for the mcp_call tool. It runs ONE
// registry operation directly (no Python subprocess). params / path_params
// accept arbitrary JSON scalars and are stringified by the executor before
// reaching the bridge — the same path mcp_execute scripts use.
type CallInput struct {
	OperationID string                     `json:"operation_id"`
	Params      map[string]json.RawMessage `json:"params"`
	PathParams  map[string]json.RawMessage `json:"path_params"`
	Body        json.RawMessage            `json:"body"`
	Mode        string                     `json:"mode"`
	Intent      string                     `json:"intent"`
}

// CallResponse is the output envelope returned by mcp_call. Status is one of
// the ExecuteStatus* constants (ok / proxy_denied / backend_application_error /
// backend_transport_error / demo_rate_limit). It can never be
// timeout / sandbox_startup_failure / script_error — there is no subprocess.
type CallResponse struct {
	Status   string `json:"status"`
	Result   any    `json:"result,omitempty"`
	Error    string `json:"error,omitempty"`
	APICalls int    `json:"api_calls"`
}

func (s *Server) handleMCPCall(
	ctx context.Context,
	request *sdkmcp.CallToolRequest,
	input CallInput,
) (*sdkmcp.CallToolResult, CallResponse, error) {
	// Demo-mode per-IP rate limit. Shares the limiter and IP-derivation path
	// with mcp_execute; see handleMCPExecute for why the IP comes off
	// request.Extra.Header rather than ctx.
	if s.demoLimiter != nil {
		var extra *sdkmcp.RequestExtra
		if request != nil {
			extra = request.Extra
		}
		ip := clientIPFromExtra(extra, s.config.TrustProxy)
		if !s.demoLimiter.Allow(ip) {
			// Mirror the structured-envelope handling in handleMCPExecute: the
			// SDK marshals the CallResponse zero-value into StructuredContent
			// regardless, so it must independently signal the rate limit.
			return demoRateLimitResultFor("mcp_call", int(time.Hour.Seconds())), CallResponse{
				Status: ExecuteStatusDemoRateLimit,
				Error:  "demo_rate_limit",
			}, nil
		}
	}

	if strings.TrimSpace(input.OperationID) == "" {
		return nil, CallResponse{}, fmt.Errorf("operation_id is required and must be non-empty")
	}

	mode := proxy.Mode(input.Mode)
	if mode == "" {
		mode = proxy.ModeReadOnly
	}
	if mode != proxy.ModeReadOnly && mode != proxy.ModeWrite {
		return nil, CallResponse{}, fmt.Errorf("mode must be %q or %q, got %q", proxy.ModeReadOnly, proxy.ModeWrite, mode)
	}

	if mode == proxy.ModeWrite && strings.TrimSpace(input.Intent) == "" {
		return nil, CallResponse{}, fmt.Errorf("intent is required and must be non-empty when mode is %q", proxy.ModeWrite)
	}

	if s.executor == nil {
		return nil, CallResponse{}, fmt.Errorf("execution service not configured")
	}

	slog.Info("[MCP] mcp_call called",
		"operation_id", input.OperationID,
		"mode", mode,
		"has_intent", input.Intent != "",
		"intent", truncateIntentForAudit(input.Intent),
	)

	callReq := CallRequest{
		OperationID: input.OperationID,
		Mode:        mode,
		Intent:      input.Intent,
		Params:      input.Params,
		PathParams:  input.PathParams,
		Body:        input.Body,
	}

	result, err := s.executor.Call(ctx, callReq)
	if err != nil {
		return nil, CallResponse{}, fmt.Errorf("executor: %w", err)
	}

	var resultVal any
	if len(result.Result) > 0 {
		if err := json.Unmarshal(result.Result, &resultVal); err != nil {
			resultVal = string(result.Result)
		}
	}

	return nil, CallResponse{
		Status:   result.Status,
		Result:   resultVal,
		Error:    result.Error,
		APICalls: result.APICalls,
	}, nil
}
