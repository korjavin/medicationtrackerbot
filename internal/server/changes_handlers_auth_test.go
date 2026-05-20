//go:build !mobile

// Server-only tests of the auth middleware's 401 rejection. The mobile build
// wires a LocalUserResolver that always resolves to the local user, so there
// is no 401 path for these tests to assert against.

package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestHandleChangesStreamUnauthorized asserts that the auth middleware rejects
// requests without initData with a 401 BEFORE handleChangesStream sets the
// text/event-stream Content-Type. EventSource clients should see a clean 401,
// not a stream that ignores them.
func TestHandleChangesStreamUnauthorized(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	handler := srv.Routes()
	ts := httptest.NewServer(handler)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/changes/stream?since=0")
	if err != nil {
		t.Fatalf("GET stream: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("Expected 401, got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct == "text/event-stream" {
		t.Errorf("Unauthorized response must NOT set Content-Type=text/event-stream, got %q", ct)
	}
}
