package main

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// An env var that cmd/cloud reads but docker-compose.cloud.yml never forwards
// is invisible: the binary silently falls back to its zero value and the
// feature it gates just doesn't work in the deployed stack. CLOUD_FOOD_DB_API_KEY
// shipped that way (med-eas.39 forwarded the key; compose never passed it), so
// pin the invariant rather than re-discover it in production.
func TestComposePassesEveryEnvCloudReads(t *testing.T) {
	root := filepath.Join("..", "..")

	compose, err := os.ReadFile(filepath.Join(root, "docker-compose.cloud.yml"))
	if err != nil {
		t.Fatalf("read compose: %v", err)
	}
	passed := map[string]bool{}
	for _, m := range regexp.MustCompile(`(?m)^\s+- ([A-Z_0-9]+)=`).FindAllStringSubmatch(string(compose), -1) {
		passed[m[1]] = true
	}

	getenv := regexp.MustCompile(`Getenv\("([A-Z_0-9]+)"\)`)
	var missing []string
	for _, dir := range []string{filepath.Join(root, "cmd", "cloud"), filepath.Join(root, "internal", "cloudserver")} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("read %s: %v", dir, err)
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
				continue
			}
			src, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				t.Fatalf("read %s: %v", e.Name(), err)
			}
			for _, m := range getenv.FindAllStringSubmatch(string(src), -1) {
				if !passed[m[1]] {
					missing = append(missing, m[1]+" (read in "+e.Name()+")")
				}
			}
		}
	}

	if len(missing) > 0 {
		sort.Strings(missing)
		t.Errorf("cmd/cloud reads env vars that docker-compose.cloud.yml never forwards:\n  %s\n\n"+
			"Add each as `- NAME=${NAME:-}` under the cloud service's environment, "+
			"and document it in .env.cloud.example + docs/environment.md.",
			strings.Join(missing, "\n  "))
	}
}
