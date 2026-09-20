package cloudweb

import (
	"io/fs"
	"os"
	"strings"
	"testing"
)

// The /s/{id} landing route serves share.html out of the REAL embed FS, but
// New() only panics on a missing index.html — and router_test.go feeds a
// MapFS that fabricates the shell files. If a page drops out of the
// //go:embed list in embed.go, it 404s in prod with zero test failures
// (for share.html: every /s/<id>; for signup.html: every passkey ceremony
// path). This test pins every top-level *.html page on disk in the real
// embed FS — same shape as TestEmbedIncludesAllDomainModules in web/domain,
// so a newly added page is covered the day it appears.
func TestEmbedIncludesAllPages(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	var checked int
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".html") {
			continue
		}
		checked++
		fi, err := fs.Stat(FS, name)
		if err != nil {
			t.Errorf("%s exists on disk but is not in //go:embed (embed.go); cloud router would 404 it", name)
			continue
		}
		if fi.IsDir() || fi.Size() == 0 {
			t.Errorf("%s stat = dir=%v size=%d, want a non-empty file", name, fi.IsDir(), fi.Size())
		}
	}
	if checked == 0 {
		t.Fatal("no *.html pages found on disk; the test would pass vacuously")
	}
}
