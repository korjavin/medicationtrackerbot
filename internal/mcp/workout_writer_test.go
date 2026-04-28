package mcp

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNewWorkoutWriter(t *testing.T) {
	endpoint := "http://example.com/api/mcp-workout-log"
	secret := "wo-secret"

	ww := NewWorkoutWriter(endpoint, secret)

	if ww.endpoint != endpoint {
		t.Errorf("expected endpoint %q, got %q", endpoint, ww.endpoint)
	}
	if ww.secret != secret {
		t.Errorf("expected secret %q, got %q", secret, ww.secret)
	}
	if ww.client == nil {
		t.Fatal("expected client to not be nil")
	}
	if ww.client.Timeout != 15*time.Second {
		t.Errorf("expected 15s timeout, got %v", ww.client.Timeout)
	}
}

func TestWorkoutWriter_Call_Success_HMAC_BodyAndPassthrough(t *testing.T) {
	secret := "wo-hmac"
	payload := map[string]any{
		"operation":   "log",
		"session_id":  int64(123),
		"occurred_at": "2026-04-28 18:30",
		"exercises": []map[string]any{
			{"name": "biceps curls", "sets": 3, "reps": 10, "weight_kg": 12.5},
		},
	}
	respJSON := []byte(`{"session_id":123,"results":[{"input_name":"biceps curls","resolved_name":"Biceps Curls","status":"logged","log_id":901}],"summary":"1 logged, 0 ambiguous, 0 missing_defaults"}`)

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("expected Content-Type application/json, got %q", got)
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}

		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write(body)
		expected := hex.EncodeToString(mac.Sum(nil))
		if got := r.Header.Get("X-Signature"); got != expected {
			t.Errorf("expected X-Signature %s, got %s", expected, got)
		}

		var received map[string]any
		if err := json.Unmarshal(body, &received); err != nil {
			t.Fatalf("unmarshal body: %v", err)
		}
		if received["operation"] != "log" {
			t.Errorf("expected operation=log in body, got %v", received["operation"])
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(respJSON)
	}))
	defer ts.Close()

	ww := NewWorkoutWriter(ts.URL, secret)
	got, err := ww.Call(context.Background(), payload)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Response is returned verbatim (the agent reads per-exercise statuses).
	if string(got) != string(respJSON) {
		t.Errorf("expected response %s, got %s", respJSON, got)
	}
}

func TestWorkoutWriter_Call_PartialSuccess_ReturnsBodyVerbatim(t *testing.T) {
	// Application-level failures (ambiguous / missing_defaults) come back as
	// HTTP 200 with structured JSON. The writer must surface that body to the
	// caller without wrapping it in an error so the agent can self-correct.
	respJSON := []byte(`{"session_id":1,"results":[{"input_name":"press","status":"ambiguous","candidates":["Bench Press","Inclined Press"]}],"summary":"0 logged, 1 ambiguous, 0 missing_defaults"}`)

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(respJSON)
	}))
	defer ts.Close()

	ww := NewWorkoutWriter(ts.URL, "secret")
	got, err := ww.Call(context.Background(), map[string]any{"operation": "log"})
	if err != nil {
		t.Fatalf("unexpected error on application-level partial: %v", err)
	}
	if string(got) != string(respJSON) {
		t.Errorf("expected verbatim body %s, got %s", respJSON, got)
	}
}

func TestWorkoutWriter_Call_ErrorStatus(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("Invalid signature"))
	}))
	defer ts.Close()

	ww := NewWorkoutWriter(ts.URL, "wrong")
	_, err := ww.Call(context.Background(), map[string]any{"operation": "log"})
	if err == nil {
		t.Fatal("expected error on 401, got nil")
	}
	if !strings.Contains(err.Error(), "unexpected status 401") {
		t.Errorf("expected status 401 in error, got %v", err)
	}
	if !strings.Contains(err.Error(), "Invalid signature") {
		t.Errorf("expected response body in error, got %v", err)
	}
}

func TestWorkoutWriter_Call_NetworkError(t *testing.T) {
	ww := NewWorkoutWriter("http://127.0.0.1:1", "secret")
	_, err := ww.Call(context.Background(), map[string]any{"operation": "log"})
	if err == nil {
		t.Fatal("expected network error, got nil")
	}
	if !strings.Contains(err.Error(), "request failed") {
		t.Errorf("expected request failure error, got %v", err)
	}
}

func TestWorkoutWriter_Call_InvalidRequestURL(t *testing.T) {
	ww := NewWorkoutWriter("http://\x7flocalhost", "secret")
	_, err := ww.Call(context.Background(), map[string]any{"operation": "log"})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "create request") {
		t.Errorf("expected create request error, got %v", err)
	}
}

func TestWorkoutWriter_Call_MarshalError(t *testing.T) {
	ww := NewWorkoutWriter("http://localhost", "secret")
	// channels can't be marshaled to JSON.
	_, err := ww.Call(context.Background(), make(chan int))
	if err == nil {
		t.Fatal("expected marshal error, got nil")
	}
	if !strings.Contains(err.Error(), "marshal payload") {
		t.Errorf("expected marshal payload error, got %v", err)
	}
}
