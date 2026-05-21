package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

// demoExecuteServer wires a Server with an OK executor and an active demo
// rate limiter capped at maxPerHour. Mirrors serverWithExecutor's shape but
// adds the demoLimiter the production code constructs in NewServer.
func demoExecuteServer(maxPerHour int) *Server {
	s := serverWithExecutor(fakeOKExecutor(json.RawMessage(`null`)), 30_000, 100)
	s.config.DemoMode = true
	s.config.DemoExecuteCallsPerHour = maxPerHour
	s.demoLimiter = newRateLimiter(maxPerHour, time.Hour)
	return s
}

// callExecuteWithIP invokes handleMCPExecute with an explicit client IP in the
// context, matching what clientIPMiddleware would inject in production.
func callExecuteWithIP(t *testing.T, s *Server, ip string) (*sdkmcp.CallToolResult, ExecuteResponse, error) {
	t.Helper()
	ctx := withClientIP(context.Background(), ip)
	return s.handleMCPExecute(ctx, nil, ExecuteInput{Script: "output(1)"})
}

// extractDemoRateLimitBody pulls the JSON body out of a CallToolResult emitted
// by demoRateLimitResult. Returns nil + a t.Fatalf if the result is not the
// rate-limit shape.
func extractDemoRateLimitBody(t *testing.T, result *sdkmcp.CallToolResult) map[string]any {
	t.Helper()
	if result == nil {
		t.Fatal("expected non-nil CallToolResult on rate-limit reject")
	}
	if !result.IsError {
		t.Errorf("expected IsError=true on rate-limit reject, got false")
	}
	if len(result.Content) == 0 {
		t.Fatal("expected at least one Content item on rate-limit reject")
	}
	text, ok := result.Content[0].(*sdkmcp.TextContent)
	if !ok {
		t.Fatalf("expected TextContent, got %T", result.Content[0])
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(text.Text), &body); err != nil {
		t.Fatalf("rate-limit body is not JSON: %v (text=%q)", err, text.Text)
	}
	return body
}

func TestMCPExecute_DemoOff_NoLimit(t *testing.T) {
	s := serverWithExecutor(fakeOKExecutor(json.RawMessage(`null`)), 30_000, 100)
	// No demoLimiter, no DemoMode — repeated calls should always succeed.
	for i := 0; i < 20; i++ {
		result, resp, err := s.handleMCPExecute(context.Background(), nil, ExecuteInput{Script: "output(1)"})
		if err != nil {
			t.Fatalf("call %d: unexpected error: %v", i, err)
		}
		if result != nil {
			t.Fatalf("call %d: expected nil result (no rate-limit branch), got %#v", i, result)
		}
		if resp.Status != ExecuteStatusOK {
			t.Fatalf("call %d: status = %q, want %q", i, resp.Status, ExecuteStatusOK)
		}
	}
}

func TestMCPExecute_DemoOn_AllowsUpToLimitThenRejects(t *testing.T) {
	const limit = 5
	s := demoExecuteServer(limit)

	for i := 0; i < limit; i++ {
		result, resp, err := callExecuteWithIP(t, s, "1.2.3.4")
		if err != nil {
			t.Fatalf("call %d: unexpected error: %v", i+1, err)
		}
		if result != nil {
			t.Fatalf("call %d: expected nil result, got rate-limit reject early", i+1)
		}
		if resp.Status != ExecuteStatusOK {
			t.Fatalf("call %d: status = %q, want %q", i+1, resp.Status, ExecuteStatusOK)
		}
	}

	// The (limit+1)th call must hit the rate limit.
	result, _, err := callExecuteWithIP(t, s, "1.2.3.4")
	if err != nil {
		t.Fatalf("rate-limited call returned go error: %v", err)
	}
	body := extractDemoRateLimitBody(t, result)
	if body["error"] != "demo_rate_limit" {
		t.Errorf("body.error = %v, want %q", body["error"], "demo_rate_limit")
	}
	if body["limit"] != "mcp_execute" {
		t.Errorf("body.limit = %v, want %q", body["limit"], "mcp_execute")
	}
	retry, _ := body["retry_after_seconds"].(float64)
	if retry <= 0 {
		t.Errorf("body.retry_after_seconds = %v, want > 0", body["retry_after_seconds"])
	}
	if retry != float64(int(time.Hour.Seconds())) {
		t.Errorf("body.retry_after_seconds = %v, want %v", retry, time.Hour.Seconds())
	}
}

func TestMCPExecute_DemoOn_PerIPBucket(t *testing.T) {
	const limit = 2
	s := demoExecuteServer(limit)

	// Exhaust IP A's bucket.
	for i := 0; i < limit; i++ {
		if _, _, err := callExecuteWithIP(t, s, "10.0.0.1"); err != nil {
			t.Fatalf("A call %d: %v", i+1, err)
		}
	}
	rejected, _, err := callExecuteWithIP(t, s, "10.0.0.1")
	if err != nil {
		t.Fatalf("A (limit+1): unexpected error: %v", err)
	}
	if rejected == nil {
		t.Fatal("A: expected rate-limit reject after exhausting bucket, got nil result")
	}

	// IP B starts fresh — first call must succeed even though IP A is blocked.
	allowed, resp, err := callExecuteWithIP(t, s, "10.0.0.2")
	if err != nil {
		t.Fatalf("B first call: unexpected error: %v", err)
	}
	if allowed != nil {
		body := extractDemoRateLimitBody(t, allowed)
		t.Fatalf("B first call was rate-limited; IP A's bucket bled into IP B (body=%v)", body)
	}
	if resp.Status != ExecuteStatusOK {
		t.Errorf("B first call status = %q, want %q", resp.Status, ExecuteStatusOK)
	}
}

func TestMCPExecute_DemoOn_NoIPInCtx_SharedBucket(t *testing.T) {
	const limit = 3
	s := demoExecuteServer(limit)

	// Calls without a context-injected IP all share the empty-string key.
	// They should hit the limit just like a single attributed IP would.
	for i := 0; i < limit; i++ {
		result, _, err := s.handleMCPExecute(context.Background(), nil, ExecuteInput{Script: "output(1)"})
		if err != nil {
			t.Fatalf("call %d: unexpected error: %v", i+1, err)
		}
		if result != nil {
			body := extractDemoRateLimitBody(t, result)
			t.Fatalf("call %d: rate-limited early (body=%v)", i+1, body)
		}
	}

	result, _, err := s.handleMCPExecute(context.Background(), nil, ExecuteInput{Script: "output(1)"})
	if err != nil {
		t.Fatalf("rate-limited call returned go error: %v", err)
	}
	body := extractDemoRateLimitBody(t, result)
	if body["limit"] != "mcp_execute" {
		t.Errorf("body.limit = %v, want %q", body["limit"], "mcp_execute")
	}
}

func TestClientIP_TrustProxy(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	req.Header.Set("X-Forwarded-For", "203.0.113.7, 10.0.0.1")
	req.RemoteAddr = "127.0.0.1:54321"

	if got := clientIP(req, true); got != "203.0.113.7" {
		t.Errorf("trustProxy=true X-Forwarded-For: got %q, want %q", got, "203.0.113.7")
	}
	if got := clientIP(req, false); got != "127.0.0.1" {
		t.Errorf("trustProxy=false: got %q, want %q (RemoteAddr host)", got, "127.0.0.1")
	}
}

func TestClientIP_XRealIPFallback(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	req.Header.Set("X-Real-IP", "198.51.100.9")
	req.RemoteAddr = "127.0.0.1:1111"

	if got := clientIP(req, true); got != "198.51.100.9" {
		t.Errorf("trustProxy=true X-Real-IP: got %q, want %q", got, "198.51.100.9")
	}
}

func TestRateLimiter_AllowsThenBlocks(t *testing.T) {
	rl := newRateLimiter(3, time.Hour)
	for i := 0; i < 3; i++ {
		if !rl.Allow("key") {
			t.Errorf("Allow #%d = false, want true (within limit)", i+1)
		}
	}
	if rl.Allow("key") {
		t.Error("Allow #4 = true, want false (over limit)")
	}
	if !rl.Allow("other-key") {
		t.Error("Allow on fresh key = false, want true (independent bucket)")
	}
}

func TestClientIPMiddleware_InjectsIPIntoContext(t *testing.T) {
	var seen string
	next := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		seen = clientIPFromCtx(r.Context())
	})
	h := clientIPMiddleware(true)(next)

	req := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	req.Header.Set("X-Forwarded-For", "203.0.113.42")
	req.RemoteAddr = "127.0.0.1:1111"
	h.ServeHTTP(httptest.NewRecorder(), req)

	if seen != "203.0.113.42" {
		t.Errorf("ctx IP = %q, want %q", seen, "203.0.113.42")
	}
}
