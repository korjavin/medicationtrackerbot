package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestFirstRunComplete_Idempotent confirms POST /api/firstrun/complete can be
// called repeatedly without error and that the underlying flag converges to
// true. The mobile shell may retry the dismissal on transient network blips,
// so the endpoint must accept a duplicate POST as a no-op rather than a 4xx.
func TestFirstRunComplete_Idempotent(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	ctx := context.Background()

	// Pre-condition: simulate a fresh mobile DB where the first-run flow has
	// not been dismissed. The migration default for new mobile rows is 0;
	// existing test rows get backfilled to 1, so flip it explicitly.
	if err := db.Settings.SetFirstRunComplete(ctx, false); err != nil {
		t.Fatalf("seed SetFirstRunComplete(false): %v", err)
	}

	// First POST: 200 and flag becomes true.
	req1 := httptest.NewRequest("POST", "/api/firstrun/complete", nil)
	req1 = withUser(req1, 123456)
	w1 := httptest.NewRecorder()
	srv.handleFirstRunComplete(w1, req1)
	if w1.Code != http.StatusOK {
		t.Fatalf("first POST: expected 200, got %d. Body: %s", w1.Code, w1.Body.String())
	}
	var resp1 map[string]bool
	if err := json.NewDecoder(w1.Body).Decode(&resp1); err != nil {
		t.Fatalf("decode first response: %v", err)
	}
	if !resp1["ok"] {
		t.Fatalf("expected ok=true in first response, got %v", resp1)
	}
	got, err := db.Settings.GetFirstRunComplete(ctx)
	if err != nil {
		t.Fatalf("GetFirstRunComplete after first POST: %v", err)
	}
	if !got {
		t.Fatalf("expected first_run_complete=true after first POST, got false")
	}

	// Second POST: still 200, flag stays true.
	req2 := httptest.NewRequest("POST", "/api/firstrun/complete", nil)
	req2 = withUser(req2, 123456)
	w2 := httptest.NewRecorder()
	srv.handleFirstRunComplete(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("second POST: expected 200, got %d. Body: %s", w2.Code, w2.Body.String())
	}
	got, err = db.Settings.GetFirstRunComplete(ctx)
	if err != nil {
		t.Fatalf("GetFirstRunComplete after second POST: %v", err)
	}
	if !got {
		t.Fatalf("expected first_run_complete=true after second POST, got false")
	}
}

// TestFirstRunComplete_PersistsFlag confirms the endpoint flips
// first_run_complete from false to true. This is the load-bearing behaviour:
// the next bootstrap response should report needs_first_run=false so the
// overlay no longer mounts. (User-row provisioning is intentionally a no-op
// on this schema — see firstrun_handlers.go.)
func TestFirstRunComplete_PersistsFlag(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	ctx := context.Background()
	if err := db.Settings.SetFirstRunComplete(ctx, false); err != nil {
		t.Fatalf("seed SetFirstRunComplete(false): %v", err)
	}

	// Sanity: precondition matches a fresh mobile install.
	pre, err := db.Settings.GetFirstRunComplete(ctx)
	if err != nil {
		t.Fatalf("pre GetFirstRunComplete: %v", err)
	}
	if pre {
		t.Fatalf("expected first_run_complete=false pre-POST, got true")
	}

	req := httptest.NewRequest("POST", "/api/firstrun/complete", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleFirstRunComplete(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	post, err := db.Settings.GetFirstRunComplete(ctx)
	if err != nil {
		t.Fatalf("post GetFirstRunComplete: %v", err)
	}
	if !post {
		t.Fatalf("expected first_run_complete=true post-POST, got false")
	}
}
