package server

import (
	"net/http"
	"testing"
)

func TestParseRoutePattern(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want RouteSpec
	}{
		{name: "method + path", in: "POST /api/x", want: RouteSpec{Method: "POST", Path: "/api/x"}},
		{name: "method lowercased", in: "post /api/x", want: RouteSpec{Method: "POST", Path: "/api/x"}},
		{name: "templated path", in: "GET /api/x/{id}", want: RouteSpec{Method: "GET", Path: "/api/x/{id}"}},
		{name: "no method", in: "/api/x", want: RouteSpec{Method: "", Path: "/api/x"}},
		{name: "subtree", in: "/static/", want: RouteSpec{Method: "", Path: "/static/"}},
		{name: "leading whitespace", in: "  POST /api/x  ", want: RouteSpec{Method: "POST", Path: "/api/x"}},
		{name: "extra spaces between method and path", in: "POST  /api/x", want: RouteSpec{Method: "POST", Path: "/api/x"}},
		{name: "root", in: "/", want: RouteSpec{Method: "", Path: "/"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := parseRoutePattern(tc.in)
			if got != tc.want {
				t.Errorf("parseRoutePattern(%q) = %#v, want %#v", tc.in, got, tc.want)
			}
		})
	}
}

// TestServerRecordsRoutes is a smoke test: a fully wired server must record
// at least the routes we name explicitly. The MCP coverage guard
// (mcp_coverage_test.go) builds on top of this; without route recording it
// cannot enforce coverage.
func TestServerRecordsRoutes(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	_ = srv.Routes() // populates s.routesRecorded

	got := srv.recordedRoutes()
	if len(got) == 0 {
		t.Fatal("recordedRoutes() returned empty slice — recordingMux did not capture anything")
	}

	// Sample a known leaf route added in the previous task.
	want := RouteSpec{Method: "POST", Path: "/api/medications"}
	found := false
	for _, r := range got {
		if r == want {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected recorded routes to include %#v, got %d entries (sample: %v)", want, len(got), got[:min(5, len(got))])
	}
}

func TestRecordingMuxRecordsBothMethods(t *testing.T) {
	var routes []RouteSpec
	m := newRecordingMux(&routes)
	m.HandleFunc("POST /api/foo", func(_ http.ResponseWriter, _ *http.Request) {})
	m.Handle("/static/", http.NotFoundHandler())

	want := []RouteSpec{
		{Method: "POST", Path: "/api/foo"},
		{Method: "", Path: "/static/"},
	}
	if len(routes) != len(want) {
		t.Fatalf("expected %d routes, got %d (%+v)", len(want), len(routes), routes)
	}
	for i, w := range want {
		if routes[i] != w {
			t.Errorf("route[%d] = %#v, want %#v", i, routes[i], w)
		}
	}
}
