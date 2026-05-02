package server

import (
	"net/http"
	"strings"
)

// RouteSpec is one HTTP route registered on the server, normalized into method
// + path. The MCP coverage guard test (mcp_coverage_test.go) reads the slice
// of recorded RouteSpecs and asserts every entry is either covered by a
// registered MCP Operation or appears in mcpCoverageExempt with a reason.
type RouteSpec struct {
	// Method is the upper-cased HTTP method declared in the pattern, or ""
	// when the pattern omits a method (Go ServeMux treats this as "any").
	Method string
	// Path is everything after the method (or the whole pattern when no
	// method is declared). Includes leading slash and any {name} placeholders;
	// trailing slash means subtree mount.
	Path string
}

// recordingMux wraps *http.ServeMux and appends every registered route to a
// shared slice. Code that holds the wrapper as http.Handler (e.g.
// `mux.Handle("/api/", authMW(apiMux))`) keeps working because *recordingMux
// embeds *http.ServeMux and inherits ServeHTTP from it.
type recordingMux struct {
	*http.ServeMux
	routes *[]RouteSpec
}

// newRecordingMux returns a fresh ServeMux that records its registrations
// into the slice pointed to by routes. Pass the same *[]RouteSpec to multiple
// muxes to merge their registrations into one list.
func newRecordingMux(routes *[]RouteSpec) *recordingMux {
	return &recordingMux{ServeMux: http.NewServeMux(), routes: routes}
}

// HandleFunc records the pattern and forwards to the underlying ServeMux.
func (m *recordingMux) HandleFunc(pattern string, handler func(http.ResponseWriter, *http.Request)) {
	*m.routes = append(*m.routes, parseRoutePattern(pattern))
	m.ServeMux.HandleFunc(pattern, handler)
}

// Handle records the pattern and forwards to the underlying ServeMux.
func (m *recordingMux) Handle(pattern string, handler http.Handler) {
	*m.routes = append(*m.routes, parseRoutePattern(pattern))
	m.ServeMux.Handle(pattern, handler)
}

// parseRoutePattern splits a Go 1.22+ ServeMux pattern into method + path.
// Accepted shapes:
//
//	"POST /api/x"        -> {Method: "POST", Path: "/api/x"}
//	"GET /api/x/{id}"    -> {Method: "GET",  Path: "/api/x/{id}"}
//	"/api/x"             -> {Method: "",     Path: "/api/x"}
//	"/static/"           -> {Method: "",     Path: "/static/"}     (subtree)
//
// Leading/trailing whitespace is stripped. The method is upper-cased so
// downstream comparisons can be case-insensitive without normalizing both
// sides repeatedly.
func parseRoutePattern(pattern string) RouteSpec {
	pattern = strings.TrimSpace(pattern)
	if i := strings.Index(pattern, " "); i > 0 {
		method := strings.ToUpper(strings.TrimSpace(pattern[:i]))
		path := strings.TrimSpace(pattern[i+1:])
		return RouteSpec{Method: method, Path: path}
	}
	return RouteSpec{Method: "", Path: pattern}
}

// recordedRoutes returns the registered routes captured during Routes().
// Used by mcp_coverage_test.go to enforce the registry coverage policy.
func (s *Server) recordedRoutes() []RouteSpec {
	out := make([]RouteSpec, len(s.routesRecorded))
	copy(out, s.routesRecorded)
	return out
}
