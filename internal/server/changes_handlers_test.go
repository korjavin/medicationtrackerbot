package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func TestHandleChanges_Empty(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("GET", "/api/changes", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleChanges(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Decode error: %v", err)
	}

	if resp["cursor"] == nil {
		t.Error("Expected 'cursor' field in response")
	}
	if resp["changed_tags"] == nil {
		t.Error("Expected 'changed_tags' field in response")
	}
}

func TestHandleChanges_WithSinceParam(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("GET", "/api/changes?since=0", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleChanges(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}
}

func TestHandleChanges_InvalidSinceIgnored(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	// Invalid since param should be treated as 0
	req := httptest.NewRequest("GET", "/api/changes?since=notanumber", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleChanges(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}
}

func TestHandleChanges_AfterBPCreate_ReturnsBPTag(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	ctx := context.Background()

	// Create a BP reading — triggers the change_events entry for 'bp'
	bp := &store.BloodPressure{
		UserID:     123456,
		MeasuredAt: time.Now(),
		Systolic:   120,
		Diastolic:  80,
	}
	_, err := db.BP.CreateReading(ctx, bp)
	if err != nil {
		t.Fatalf("CreateReading: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/changes?since=0", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleChanges(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)

	cursor, ok := resp["cursor"].(float64)
	if !ok || cursor <= 0 {
		t.Errorf("Expected cursor > 0, got %v", resp["cursor"])
	}

	tags, ok := resp["changed_tags"].([]any)
	if !ok {
		t.Fatalf("Expected changed_tags array, got %T", resp["changed_tags"])
	}

	found := false
	for _, tag := range tags {
		if tag == "bp" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("Expected 'bp' in changed_tags, got %v", tags)
	}
}

// TestNotifyOnWriteMiddleware_FanoutOnPOST exercises the write-notify
// middleware end-to-end: after a successful POST through the wrapped apiMux,
// any active broker subscriber must receive a cursor wake-up promptly.
func TestNotifyOnWriteMiddleware_FanoutOnPOST(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	// Routes() builds the handler chain that wraps apiMux with
	// notifyOnWriteMiddleware and stores the wrapped handler in
	// s.internalMux. Calling Routes() populates that field.
	_ = srv.Routes()
	if srv.internalMux == nil {
		t.Fatal("Routes() did not populate internalMux")
	}
	if srv.changesBroker == nil {
		t.Fatal("changesBroker is nil — New() must construct one")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sub := srv.changesBroker.Subscribe(ctx)

	// POST a BP reading through the wrapped handler. The middleware skips
	// auth (internalMux is meant for bridge calls), but it still requires the
	// UserCtxKey context value used by the BP handler.
	body, _ := json.Marshal(map[string]any{
		"measured_at": time.Now().Format(time.RFC3339),
		"systolic":    120,
		"diastolic":   80,
		"pulse":       70,
	})
	req := httptest.NewRequest("POST", "/api/bp", bytes.NewReader(body))
	req = req.WithContext(context.WithValue(req.Context(), UserCtxKey, &TelegramUser{ID: 123456}))
	w := httptest.NewRecorder()

	srv.internalMux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d: %s", w.Code, w.Body.String())
	}

	select {
	case cursor, ok := <-sub:
		if !ok {
			t.Fatal("subscription channel closed before fanout")
		}
		if cursor <= 0 {
			t.Errorf("Expected cursor > 0, got %d", cursor)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("subscriber did not receive fanout within 200ms")
	}
}

// TestNotifyOnWriteMiddleware_SkipsGET asserts the middleware does NOT notify
// on GET responses — only writes (POST/PUT/DELETE/PATCH) should wake clients.
func TestNotifyOnWriteMiddleware_SkipsGET(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	_ = srv.Routes()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sub := srv.changesBroker.Subscribe(ctx)

	req := httptest.NewRequest("GET", "/api/bp", nil)
	req = req.WithContext(context.WithValue(req.Context(), UserCtxKey, &TelegramUser{ID: 123456}))
	w := httptest.NewRecorder()

	srv.internalMux.ServeHTTP(w, req)

	select {
	case <-sub:
		t.Fatal("subscriber received fanout for GET — middleware must skip GET")
	case <-time.After(50 * time.Millisecond):
		// expected: no notification fired
	}
}

// TestServerShutdown_ClosesBrokerSubscribers exercises the integration
// between Server.Shutdown and the broker: in-flight subscribers must see
// their channel closed so streaming handlers can return cleanly.
func TestServerShutdown_ClosesBrokerSubscribers(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sub := srv.changesBroker.Subscribe(ctx)

	if err := srv.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown returned error: %v", err)
	}

	select {
	case _, ok := <-sub:
		if ok {
			t.Fatal("subscriber channel was not closed by Shutdown")
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("subscriber channel was not closed within 100ms")
	}
}

func TestHandleChanges_SinceCurrentCursorReturnsEmpty(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	ctx := context.Background()

	// Insert some change data
	bp := &store.BloodPressure{
		UserID:     123456,
		MeasuredAt: time.Now(),
		Systolic:   120,
		Diastolic:  80,
	}
	db.BP.CreateReading(ctx, bp)

	// Get current cursor
	cursor, err := db.Settings.GetLatestChangeCursor(ctx)
	if err != nil {
		t.Fatalf("GetLatestChangeCursor: %v", err)
	}

	// Query with since = current cursor → nothing new
	req := httptest.NewRequest("GET", fmt.Sprintf("/api/changes?since=%d", cursor), nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleChanges(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)

	tags, _ := resp["changed_tags"].([]any)
	if len(tags) != 0 {
		t.Errorf("Expected 0 tags when since=current cursor, got %v", tags)
	}
}
