package domainweb

import (
	"os"
	"strings"
	"testing"
)

// Every web/domain/*.js module must be present in the embed FS, or the cloud
// router serves a 404 for it — and since apishim.js imports them as static
// ESM, one missing file breaks the whole shim boot. Vitest reads these off
// disk, so it can't catch a forgotten //go:embed entry; this test does.
func TestEmbedIncludesAllDomainModules(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".js") {
			continue
		}
		if _, err := FS.Open(name); err != nil {
			t.Errorf("%s exists on disk but is not in //go:embed (embed.go); cloud router would 404 it", name)
		}
	}
}
