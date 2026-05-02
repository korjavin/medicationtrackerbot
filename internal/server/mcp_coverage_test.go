package server

import (
	"fmt"
	"sort"
	"strings"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/mcp/registry"
)

// TestMCPCoverage_AllRoutesEitherRegisteredOrExempt is the load-bearing
// guard: every HTTP route registered on the server must either appear as
// a registered MCP Operation (matched by Method + Path, with {placeholders}
// preserved) or be listed in mcpCoverageExempt with a reason. Adding a new
// backend route without doing one of those is a test failure.
//
// Failure output is sorted and copy-pasteable — when this test fails, the
// fix is either: register an Operation in internal/mcp/registry/operations_<topic>.go,
// or add an entry to mcpCoverageExempt with a one-line Reason.
func TestMCPCoverage_AllRoutesEitherRegisteredOrExempt(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	_ = srv.Routes()
	recorded := srv.recordedRoutes()
	if len(recorded) == 0 {
		t.Fatal("no routes recorded; recordingMux wiring is broken")
	}

	registered := registeredOpsByMethodPath()
	exempt := exemptByMethodPath()

	var missing []RouteSpec
	for _, r := range recorded {
		key := routeKey(r.Method, r.Path)
		if _, ok := registered[key]; ok {
			continue
		}
		if _, ok := exempt[key]; ok {
			continue
		}
		missing = append(missing, r)
	}

	if len(missing) == 0 {
		return
	}
	sort.Slice(missing, func(i, j int) bool {
		if missing[i].Path != missing[j].Path {
			return missing[i].Path < missing[j].Path
		}
		return missing[i].Method < missing[j].Method
	})
	var b strings.Builder
	fmt.Fprintf(&b, "%d backend route(s) lack MCP coverage:\n", len(missing))
	for _, r := range missing {
		method := r.Method
		if method == "" {
			method = "(any)"
		}
		fmt.Fprintf(&b, "  %-7s %s\n", method, r.Path)
	}
	b.WriteString("\nFor each: either register an Operation in internal/mcp/registry/operations_<topic>.go,\n")
	b.WriteString("or add an entry to mcpCoverageExempt in mcp_coverage_exempt.go with a Reason.")
	t.Error(b.String())
}

// TestMCPCoverage_ExemptionsHaveReasons asserts every exemption carries a
// non-empty Reason; an exemption without justification is a silent escape
// hatch and defeats the purpose of the guard.
func TestMCPCoverage_ExemptionsHaveReasons(t *testing.T) {
	for _, e := range mcpCoverageExempt {
		if strings.TrimSpace(e.Reason) == "" {
			t.Errorf("exemption %s %s has empty Reason", e.Method, e.Path)
		}
	}
}

// TestMCPCoverage_NoStaleExemptions asserts every exemption matches a
// currently-registered route. When a route is renamed or removed, its
// exemption must disappear too — otherwise a future regression could
// re-introduce the same path without coverage and the stale entry would
// silently mask it.
func TestMCPCoverage_NoStaleExemptions(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	_ = srv.Routes()
	recorded := make(map[string]bool, len(srv.recordedRoutes()))
	for _, r := range srv.recordedRoutes() {
		recorded[routeKey(r.Method, r.Path)] = true
	}

	for _, e := range mcpCoverageExempt {
		if !recorded[routeKey(e.Method, e.Path)] {
			t.Errorf("exemption %s %s does not match any registered route — remove the stale entry", e.Method, e.Path)
		}
	}
}

// TestMCPCoverage_NoDuplicateExemptions is a lightweight sanity check —
// duplicates would mask intent and create noise in code review.
func TestMCPCoverage_NoDuplicateExemptions(t *testing.T) {
	seen := make(map[string]bool, len(mcpCoverageExempt))
	for _, e := range mcpCoverageExempt {
		key := routeKey(e.Method, e.Path)
		if seen[key] {
			t.Errorf("duplicate exemption %s %s", e.Method, e.Path)
		}
		seen[key] = true
	}
}

// registeredOpsByMethodPath indexes the default MCP operation set by
// (uppercase method, exact path). Path templates ({id}) match verbatim.
func registeredOpsByMethodPath() map[string]struct{} {
	ops := registry.DefaultOperations()
	out := make(map[string]struct{}, len(ops))
	for _, op := range ops {
		out[routeKey(op.Method, op.Path)] = struct{}{}
	}
	return out
}

// exemptByMethodPath indexes the exemption list by the same key shape.
func exemptByMethodPath() map[string]struct{} {
	out := make(map[string]struct{}, len(mcpCoverageExempt))
	for _, e := range mcpCoverageExempt {
		out[routeKey(e.Method, e.Path)] = struct{}{}
	}
	return out
}

func routeKey(method, path string) string {
	return strings.ToUpper(strings.TrimSpace(method)) + " " + strings.TrimSpace(path)
}
