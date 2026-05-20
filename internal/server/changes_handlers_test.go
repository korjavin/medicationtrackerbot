package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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

// streamingTestServer mounts srv.handleChangesStream behind a real httptest
// HTTP server that supports streaming, with the user context pre-injected so
// the SSE handler can run without the auth middleware. Returns the server and
// a cleanup func.
func streamingTestServer(t *testing.T, srv *Server, userID int64) (*httptest.Server, func()) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/changes/stream", func(w http.ResponseWriter, r *http.Request) {
		r = r.WithContext(context.WithValue(r.Context(), UserCtxKey, &TelegramUser{ID: userID}))
		srv.handleChangesStream(w, r)
	})
	ts := httptest.NewServer(mux)
	return ts, ts.Close
}

// readSSEFrame reads one SSE data frame (one "data: …\n\n" block) from r and
// returns its JSON payload. Comments (lines starting with ":") are skipped.
// Returns an error if the connection closes before a frame arrives.
func readSSEFrame(t *testing.T, r *bufio.Reader) (map[string]any, error) {
	t.Helper()
	var dataLine string
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			// Frame terminator. If we accumulated a data line, return it.
			if dataLine != "" {
				var payload map[string]any
				if err := json.Unmarshal([]byte(dataLine), &payload); err != nil {
					return nil, fmt.Errorf("decode SSE frame: %w (raw: %q)", err, dataLine)
				}
				return payload, nil
			}
			continue
		}
		if strings.HasPrefix(line, ":") || strings.HasPrefix(line, "retry:") {
			continue
		}
		if strings.HasPrefix(line, "data: ") {
			dataLine = strings.TrimPrefix(line, "data: ")
		}
	}
}

// TestHandleChangesStreamFanout exercises the broker-driven wake-up path:
// open a stream, write through the broker, and assert the handler emits a
// data frame with the expected changed_tags within 200ms.
func TestHandleChangesStreamFanout(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	ts, cleanup := streamingTestServer(t, srv, 123456)
	defer cleanup()

	resp, err := http.Get(ts.URL + "/api/changes/stream?since=0")
	if err != nil {
		t.Fatalf("GET stream: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Expected 200, got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("Expected Content-Type text/event-stream, got %q", ct)
	}
	if xab := resp.Header.Get("X-Accel-Buffering"); xab != "no" {
		t.Errorf("Expected X-Accel-Buffering: no, got %q", xab)
	}

	reader := bufio.NewReader(resp.Body)

	// Initial frame (empty state).
	if _, err := readSSEFrame(t, reader); err != nil {
		t.Fatalf("initial frame: %v", err)
	}

	// Trigger a write — change_events row gets created, then notify the broker
	// (notifyOnWriteMiddleware does this in production; we call it directly
	// here because we're not going through the wrapped apiMux).
	ctx := context.Background()
	bp := &store.BloodPressure{
		UserID:     123456,
		MeasuredAt: time.Now(),
		Systolic:   120,
		Diastolic:  80,
	}
	if _, err := db.BP.CreateReading(ctx, bp); err != nil {
		t.Fatalf("CreateReading: %v", err)
	}
	cursor, err := db.Settings.GetLatestChangeCursor(ctx)
	if err != nil {
		t.Fatalf("GetLatestChangeCursor: %v", err)
	}
	srv.changesBroker.Notify(cursor)

	// Expect a frame carrying the new cursor and the 'bp' tag.
	type frameResult struct {
		frame map[string]any
		err   error
	}
	done := make(chan frameResult, 1)
	go func() {
		f, err := readSSEFrame(t, reader)
		done <- frameResult{frame: f, err: err}
	}()

	select {
	case res := <-done:
		if res.err != nil {
			t.Fatalf("read fanout frame: %v", res.err)
		}
		gotCursor, ok := res.frame["cursor"].(float64)
		if !ok || int64(gotCursor) != cursor {
			t.Errorf("Expected cursor=%d, got %v", cursor, res.frame["cursor"])
		}
		tags, ok := res.frame["changed_tags"].([]any)
		if !ok {
			t.Fatalf("Expected changed_tags array, got %T", res.frame["changed_tags"])
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
	case <-time.After(500 * time.Millisecond):
		t.Fatal("subscriber did not receive SSE frame within 500ms")
	}
}

// TestStreamReceivesTelegramLikeWrite covers the tailer-driven catch-all path:
// a write goes straight to the store (simulating a domain-service call from
// a Telegram bot callback that bypasses notifyOnWriteMiddleware) without any
// explicit broker.Notify, and the open SSE stream must still receive the
// change within a few tailer ticks — NOT the per-stream backstop interval.
func TestStreamReceivesTelegramLikeWrite(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	ts, cleanup := streamingTestServer(t, srv, 123456)
	defer cleanup()

	resp, err := http.Get(ts.URL + "/api/changes/stream?since=0")
	if err != nil {
		t.Fatalf("GET stream: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Expected 200, got %d", resp.StatusCode)
	}

	reader := bufio.NewReader(resp.Body)

	// Consume the initial frame so we know we're inside the broker-wait loop.
	if _, err := readSSEFrame(t, reader); err != nil {
		t.Fatalf("initial frame: %v", err)
	}

	// Simulate a Telegram-bot-style write that bypasses the HTTP middleware:
	// call the store directly with no manual broker.Notify. Only the tailer
	// goroutine started in New() can wake the SSE handler now.
	ctx := context.Background()
	bp := &store.BloodPressure{
		UserID:     123456,
		MeasuredAt: time.Now(),
		Systolic:   120,
		Diastolic:  80,
	}
	if _, err := db.BP.CreateReading(ctx, bp); err != nil {
		t.Fatalf("CreateReading: %v", err)
	}

	type frameResult struct {
		frame map[string]any
		err   error
	}
	done := make(chan frameResult, 1)
	go func() {
		f, err := readSSEFrame(t, reader)
		done <- frameResult{frame: f, err: err}
	}()

	// Tailer ticks at changeTailerInterval (200ms). Give it generous slack
	// for ticker jitter + scheduler delay, but well below the per-stream
	// backstop so this test fails fast if the tailer isn't wired in.
	waitFor := 10 * changeTailerInterval
	select {
	case res := <-done:
		if res.err != nil {
			t.Fatalf("read tailer frame: %v", res.err)
		}
		gotCursor, ok := res.frame["cursor"].(float64)
		if !ok || int64(gotCursor) <= 0 {
			t.Errorf("Expected cursor > 0, got %v", res.frame["cursor"])
		}
		tags, ok := res.frame["changed_tags"].([]any)
		if !ok {
			t.Fatalf("Expected changed_tags array, got %T", res.frame["changed_tags"])
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
	case <-time.After(waitFor):
		t.Fatalf("tailer did not deliver SSE frame within %v of a direct-to-store write", waitFor)
	}
}

// TestHandleChangesStreamShutdown exercises graceful shutdown: an open stream
// must exit cleanly when the broker's subscriber channel is closed.
func TestHandleChangesStreamShutdown(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	ts, cleanup := streamingTestServer(t, srv, 123456)
	defer cleanup()

	resp, err := http.Get(ts.URL + "/api/changes/stream?since=0")
	if err != nil {
		t.Fatalf("GET stream: %v", err)
	}
	defer resp.Body.Close()

	reader := bufio.NewReader(resp.Body)
	// Consume initial frame so we know we're inside the select loop.
	if _, err := readSSEFrame(t, reader); err != nil {
		t.Fatalf("initial frame: %v", err)
	}

	// Trigger graceful shutdown — broker closes all subscriber channels.
	if err := srv.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}

	// The handler should return, closing the response body. A subsequent read
	// should reach EOF promptly.
	done := make(chan error, 1)
	go func() {
		_, err := io.Copy(io.Discard, reader)
		done <- err
	}()

	select {
	case err := <-done:
		// EOF or nil is the success signal (server closed the connection).
		if err != nil && err != io.EOF && !strings.Contains(err.Error(), "connection") {
			t.Logf("read after shutdown returned: %v (acceptable)", err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("handler did not exit within 500ms of Shutdown")
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
