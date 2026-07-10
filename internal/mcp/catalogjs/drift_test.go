package catalogjs

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/mcp/registry"
)

// generatedPath resolves the checked-in catalog from this file's location, so
// the guard does not depend on the working directory.
func generatedPath(t *testing.T) string {
	t.Helper()
	_, self, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Join(filepath.Dir(self), "..", "..", "..", "web", "cloud", "js", "mcp-catalog.generated.js")
}

func readGenerated(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile(generatedPath(t))
	if err != nil {
		t.Fatalf("read generated catalog: %v (run: go run ./cmd/genmcpcatalog)", err)
	}
	return b
}

// catalogIDs pulls the ids out of the CATALOG array only — EXCLUDED ids also
// appear in the file, so a naive substring scan would report them as covered.
func catalogIDs(t *testing.T, src []byte) map[string]bool {
	t.Helper()
	const open = "export const CATALOG = "
	i := bytes.Index(src, []byte(open))
	if i < 0 {
		t.Fatal("generated catalog has no `export const CATALOG =` — regenerate: go run ./cmd/genmcpcatalog")
	}
	rest := src[i+len(open):]
	// Anchor on Generate's exact separator, not the first `];`: an op whose
	// description or response_example ever contains that literal would
	// otherwise truncate the array mid-string.
	const close = ";\n\nexport const EXCLUDED = "
	j := bytes.Index(rest, []byte(close))
	if j < 0 {
		t.Fatal("generated catalog has an unterminated CATALOG array")
	}
	var entries []entry
	if err := json.Unmarshal(rest[:j], &entries); err != nil {
		t.Fatalf("CATALOG is not valid JSON: %v", err)
	}
	ids := make(map[string]bool, len(entries))
	for _, e := range entries {
		ids[e.ID] = true
	}
	return ids
}

// TestCloudCatalog_CatalogIDsStopsAtExcluded pins the parser boundary the
// coverage guard rests on: if catalogIDs ever ran past the CATALOG array into
// EXCLUDED, every excluded op would read as "covered" and the exclusion
// mechanism would silently pass anything.
func TestCloudCatalog_CatalogIDsStopsAtExcluded(t *testing.T) {
	ids := catalogIDs(t, readGenerated(t))
	if len(ids) == 0 {
		t.Fatal("catalogIDs parsed no entries")
	}
	for id := range ExcludedIDs() {
		if ids[id] {
			t.Errorf("excluded op %q leaked into the parsed CATALOG ids", id)
		}
	}
}

// TestCloudCatalog_EveryRegistryOpCoveredOrExcluded is the load-bearing guard:
// a new registry operation must either land in the generated cloud catalog or
// be listed in Excluded with a reason.
func TestCloudCatalog_EveryRegistryOpCoveredOrExcluded(t *testing.T) {
	ids := catalogIDs(t, readGenerated(t))
	excluded := ExcludedIDs()

	var missing []string
	for _, op := range registry.DefaultOperations() {
		if ids[op.ID] {
			continue
		}
		if _, ok := excluded[op.ID]; ok {
			continue
		}
		missing = append(missing, op.ID)
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		t.Fatalf("registry ops missing from the cloud catalog:\n  %s\n\n"+
			"Fix: regenerate with `go run ./cmd/genmcpcatalog`, or add a reasoned\n"+
			"entry to catalogjs.Excluded if the op must not reach cloud mode.",
			strings.Join(missing, "\n  "))
	}
}

func TestCloudCatalog_GeneratedFileIsUpToDate(t *testing.T) {
	want, err := Generate(registry.DefaultOperations())
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if got := readGenerated(t); !bytes.Equal(got, want) {
		t.Fatalf("web/cloud/js/mcp-catalog.generated.js is stale (have %d bytes, want %d)\n\n"+
			"Fix: run `go run ./cmd/genmcpcatalog`", len(got), len(want))
	}
}

// TestCloudCatalog_ExclusionsAreRealOps catches typos and stale exclusions: an
// exclusion for a renamed or deleted op would otherwise silently exclude nothing.
func TestCloudCatalog_ExclusionsAreRealOps(t *testing.T) {
	known := make(map[string]bool)
	for _, op := range registry.DefaultOperations() {
		known[op.ID] = true
	}
	for _, e := range Excluded {
		if !known[e.ID] {
			t.Errorf("Excluded op %q is not in the registry — was it renamed or deleted?", e.ID)
		}
		if strings.TrimSpace(e.Reason) == "" {
			t.Errorf("Excluded op %q has an empty Reason", e.ID)
		}
	}
}
