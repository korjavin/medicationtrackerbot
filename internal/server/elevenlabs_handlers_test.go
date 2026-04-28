package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandleElevenLabsSignedURL_NotConfigured(t *testing.T) {
	srv, db := createHealthTestServer(t)
	defer db.Close()

	t.Setenv("ELEVENLABS_API_KEY", "")
	t.Setenv("ELEVENLABS_AGENT_ID", "")

	req := httptest.NewRequest("GET", "/api/elevenlabs/signed-url", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleElevenLabsSignedURL(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d. Body: %s", w.Code, w.Body.String())
	}
}

func TestHandleElevenLabsSignedURL_OK(t *testing.T) {
	srv, db := createHealthTestServer(t)
	defer db.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("xi-api-key"); got != "test-key" {
			t.Errorf("expected xi-api-key=test-key, got %q", got)
		}
		if got := r.URL.Query().Get("agent_id"); got != "agent_test" {
			t.Errorf("expected agent_id=agent_test, got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"signed_url": "wss://example.test/sig?token=abc"})
	}))
	defer upstream.Close()

	prev := elevenLabsSignedURLBase
	elevenLabsSignedURLBase = upstream.URL
	defer func() { elevenLabsSignedURLBase = prev }()

	t.Setenv("ELEVENLABS_API_KEY", "test-key")
	t.Setenv("ELEVENLABS_AGENT_ID", "agent_test")

	req := httptest.NewRequest("GET", "/api/elevenlabs/signed-url", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleElevenLabsSignedURL(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}
	var body map[string]string
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["signed_url"] != "wss://example.test/sig?token=abc" {
		t.Fatalf("unexpected signed_url: %q", body["signed_url"])
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("expected Cache-Control: no-store, got %q", cc)
	}
}

func TestHandleElevenLabsSignedURL_UpstreamError(t *testing.T) {
	srv, db := createHealthTestServer(t)
	defer db.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer upstream.Close()

	prev := elevenLabsSignedURLBase
	elevenLabsSignedURLBase = upstream.URL
	defer func() { elevenLabsSignedURLBase = prev }()

	t.Setenv("ELEVENLABS_API_KEY", "test-key")
	t.Setenv("ELEVENLABS_AGENT_ID", "agent_test")

	req := httptest.NewRequest("GET", "/api/elevenlabs/signed-url", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleElevenLabsSignedURL(w, req)

	if w.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", w.Code)
	}
}
