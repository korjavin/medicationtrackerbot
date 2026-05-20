//go:build !mobile

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// newDemoTestServer returns a server configured for demo mode with small
// per-IP thresholds, plus its Routes() handler. Reusing createGenericTestServer
// gives the test a real DB so handlers further down the chain don't panic on
// unset dependencies — only the limiter middleware's reject path is under test.
func newDemoTestServer(t *testing.T, cfg DemoConfig) (http.Handler, func()) {
	t.Helper()
	srv, db := createGenericTestServer(t)
	srv.SetDemoMode(true)
	srv.SetDemoConfig(cfg)
	handler := srv.Routes()
	return handler, func() { db.Close() }
}

// fireUntilLimit posts/gets path repeatedly from the same remote IP and asserts
// that the first `allowed` responses do not return 429, then the very next
// request does — with the JSON shape demo mode emits. The handler beneath the
// limiter may return any non-429 status (400/415/503) because its dependencies
// aren't set up; we only assert on the rate-limit semantics.
func fireUntilLimit(t *testing.T, handler http.Handler, method, path string, body string, allowed int, wantLabel string, wantRetryAfter int) {
	t.Helper()
	for i := 0; i < allowed; i++ {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.RemoteAddr = "203.0.113.5:5555"
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code == http.StatusTooManyRequests {
			t.Fatalf("%s %s: request %d/%d was rate-limited unexpectedly (got 429)", method, path, i+1, allowed)
		}
	}

	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.RemoteAddr = "203.0.113.5:5555"
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("%s %s: expected 429 on request %d, got %d (body=%s)", method, path, allowed+1, w.Code, w.Body.String())
	}
	if got := w.Header().Get("Retry-After"); got == "" {
		t.Errorf("%s %s: expected Retry-After header on 429", method, path)
	}
	var parsed map[string]any
	if err := json.NewDecoder(w.Body).Decode(&parsed); err != nil {
		t.Fatalf("%s %s: 429 body is not JSON: %v", method, path, err)
	}
	if parsed["error"] != "demo_rate_limit" {
		t.Errorf("%s %s: expected error=demo_rate_limit, got %v", method, path, parsed["error"])
	}
	if parsed["limit"] != wantLabel {
		t.Errorf("%s %s: expected limit=%q, got %v", method, path, wantLabel, parsed["limit"])
	}
	// JSON numbers decode to float64; compare with the expected int.
	if got, _ := parsed["retry_after_seconds"].(float64); int(got) != wantRetryAfter {
		t.Errorf("%s %s: expected retry_after_seconds=%d, got %v", method, path, wantRetryAfter, parsed["retry_after_seconds"])
	}
}

func TestDemoRateLimit_FoodLog(t *testing.T) {
	handler, cleanup := newDemoTestServer(t, DemoConfig{
		AgentCallsPerDay:        2,
		FoodLogsPerHour:         2,
		FoodPhotosPerHour:       2,
		FoodDescriptionsPerHour: 2,
	})
	defer cleanup()

	fireUntilLimit(t, handler,
		"POST", "/api/food/log",
		`{}`, // empty payload triggers 400 from the handler, which is fine — middleware ran first
		2,
		"food_log",
		3600,
	)
}

func TestDemoRateLimit_FoodLogFromPhoto(t *testing.T) {
	handler, cleanup := newDemoTestServer(t, DemoConfig{
		AgentCallsPerDay:        2,
		FoodLogsPerHour:         2,
		FoodPhotosPerHour:       2,
		FoodDescriptionsPerHour: 2,
	})
	defer cleanup()

	fireUntilLimit(t, handler,
		"POST", "/api/food/log/from-photo",
		`{}`,
		2,
		"food_log_from_photo",
		3600,
	)
}

func TestDemoRateLimit_FoodLogFromDescription(t *testing.T) {
	handler, cleanup := newDemoTestServer(t, DemoConfig{
		AgentCallsPerDay:        2,
		FoodLogsPerHour:         2,
		FoodPhotosPerHour:       2,
		FoodDescriptionsPerHour: 2,
	})
	defer cleanup()

	fireUntilLimit(t, handler,
		"POST", "/api/food/log/from-description",
		`{}`,
		2,
		"food_log_from_description",
		3600,
	)
}

func TestDemoRateLimit_ElevenLabsSignedURL(t *testing.T) {
	handler, cleanup := newDemoTestServer(t, DemoConfig{
		AgentCallsPerDay:        2,
		FoodLogsPerHour:         2,
		FoodPhotosPerHour:       2,
		FoodDescriptionsPerHour: 2,
	})
	defer cleanup()

	fireUntilLimit(t, handler,
		"GET", "/api/elevenlabs/signed-url",
		"",
		2,
		"agent_calls",
		86400,
	)
}

func TestDemoRateLimit_ElevenLabsUploadFile_SharesAgentBudget(t *testing.T) {
	// Both ElevenLabs routes draw from the same per-IP daily budget because
	// they are two halves of one "talk to the agent" interaction. With a
	// budget of 2, hitting signed-url twice and then upload-file once must
	// 429 — proving the two routes share the limiter and not two independent
	// counters.
	handler, cleanup := newDemoTestServer(t, DemoConfig{
		AgentCallsPerDay:        2,
		FoodLogsPerHour:         2,
		FoodPhotosPerHour:       2,
		FoodDescriptionsPerHour: 2,
	})
	defer cleanup()

	doSignedURL := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/elevenlabs/signed-url", nil)
		req.RemoteAddr = "203.0.113.5:5555"
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}
	doUpload := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/api/elevenlabs/upload-file?conversation_id=abc", strings.NewReader(""))
		req.RemoteAddr = "203.0.113.5:5555"
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}

	if w := doSignedURL(); w.Code == http.StatusTooManyRequests {
		t.Fatalf("signed-url #1: unexpected 429")
	}
	if w := doSignedURL(); w.Code == http.StatusTooManyRequests {
		t.Fatalf("signed-url #2: unexpected 429")
	}
	w := doUpload()
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("upload-file #3: expected 429 after agent budget exhausted, got %d", w.Code)
	}
	var parsed map[string]any
	if err := json.NewDecoder(w.Body).Decode(&parsed); err != nil {
		t.Fatalf("429 body is not JSON: %v", err)
	}
	if parsed["limit"] != "agent_calls" {
		t.Errorf("expected limit=agent_calls, got %v", parsed["limit"])
	}
}

func TestDemoRateLimit_PerIP(t *testing.T) {
	// Different clients (different remote addrs) each get their own bucket.
	// With a budget of 1, IP A's second request 429s but IP B's first request
	// still goes through — confirming the limiter keys on clientIP.
	handler, cleanup := newDemoTestServer(t, DemoConfig{
		AgentCallsPerDay:        1,
		FoodLogsPerHour:         1,
		FoodPhotosPerHour:       1,
		FoodDescriptionsPerHour: 1,
	})
	defer cleanup()

	hit := func(remote string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/api/food/log", strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req.RemoteAddr = remote
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}

	if w := hit("198.51.100.1:1111"); w.Code == http.StatusTooManyRequests {
		t.Fatalf("IP A first request: unexpected 429")
	}
	if w := hit("198.51.100.1:1111"); w.Code != http.StatusTooManyRequests {
		t.Fatalf("IP A second request: expected 429, got %d", w.Code)
	}
	if w := hit("198.51.100.2:2222"); w.Code == http.StatusTooManyRequests {
		t.Fatalf("IP B first request: unexpected 429 — limiter is not per-IP")
	}
}

func TestDemoRateLimit_DisabledWhenDemoOff(t *testing.T) {
	// When demo mode is off, no limiters are wired. Firing many requests in
	// a row never produces a 429 from the demo middleware — the responses
	// will be 401 (auth) because the production resolver runs, but never 429.
	srv, db := createGenericTestServer(t)
	defer db.Close()
	handler := srv.Routes()

	for i := 0; i < 5; i++ {
		req := httptest.NewRequest("POST", "/api/food/log", strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req.RemoteAddr = "203.0.113.99:9999"
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code == http.StatusTooManyRequests {
			t.Fatalf("demo off: request %d returned 429 — limiter should not be wired", i+1)
		}
	}
}
