package exercisecatalog

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// repoPath resolves a repo-relative path from this file's location, so the
// guards do not depend on the working directory (mirrors the catalogjs
// drift-test pattern).
func repoPath(t *testing.T, parts ...string) string {
	t.Helper()
	_, self, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Join(filepath.Dir(self), "..", "..")
	return filepath.Join(append([]string{root}, parts...)...)
}

func readFile(t *testing.T, parts ...string) []byte {
	t.Helper()
	b, err := os.ReadFile(repoPath(t, parts...))
	if err != nil {
		t.Fatalf("read %v: %v", parts, err)
	}
	return b
}

// TestGeneratedAssetIsUpToDate is the load-bearing guard: editing the vendored
// source (or the trim logic) without regenerating leaves the shipped asset
// stale. Same input + deterministic Trim => byte-for-byte match.
func TestGeneratedAssetIsUpToDate(t *testing.T) {
	src := readFile(t, "third_party", "exercises-dataset", "exercises.json")
	want, err := Trim(src)
	if err != nil {
		t.Fatalf("Trim: %v", err)
	}
	got := readFile(t, "web", "static", "data", "exercises-catalog.json")
	if !bytes.Equal(got, want) {
		t.Fatalf("web/static/data/exercises-catalog.json is stale (have %d bytes, want %d)\n\n"+
			"Fix: run `go run ./cmd/genexercisecatalog`", len(got), len(want))
	}
}

// TestCatalogHasNoLicensedMedia pins the hard licensing constraint: the shipped
// asset must carry text metadata only — none of the Gym-visual media fields and
// none of the 8 non-English instruction languages.
func TestCatalogHasNoLicensedMedia(t *testing.T) {
	raw := readFile(t, "web", "static", "data", "exercises-catalog.json")
	banned := []string{`"gif_url"`, `"image"`, `"attribution"`, `"media_id"`,
		`"instruction_steps"`, `"it":`, `"tr":`, `"es":`, `"ru":`, `"zh":`,
		`"hi":`, `"pl":`, `"ko":`}
	for _, b := range banned {
		if bytes.Contains(raw, []byte(b)) {
			t.Errorf("catalog leaks disallowed field/language %q", b)
		}
	}
}

// TestCatalogShape sanity-checks the parsed asset: full record count and the
// fields autocomplete/stats depend on are populated.
func TestCatalogShape(t *testing.T) {
	var cat Catalog
	if err := json.Unmarshal(readFile(t, "web", "static", "data", "exercises-catalog.json"), &cat); err != nil {
		t.Fatalf("catalog is not valid JSON: %v", err)
	}
	if cat.Source.Commit != SourceCommit {
		t.Errorf("source commit = %q, want %q", cat.Source.Commit, SourceCommit)
	}
	if len(cat.Exercises) != 1324 {
		t.Errorf("exercises = %d, want 1324", len(cat.Exercises))
	}
	for i, e := range cat.Exercises {
		if e.ID == "" || e.Name == "" {
			t.Fatalf("exercise %d has empty id/name: %+v", i, e)
		}
	}
}
