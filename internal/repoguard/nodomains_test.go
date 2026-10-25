// Package repoguard holds tree-wide guards over what is committed to git.
package repoguard

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// projectDomainB64 is the project's own registrable domain, encoded so the
// guard does not trip on itself (bd med-ffuu.2).
const projectDomainB64 = "bXloZWFsdGhib3QuYWk="

// Known hits owned by other beads, one line each.
var pendingNative = map[string]bool{
	"ios/App/Settings.bundle/Root.plist":                                               true, // remove when med-ffuu.3 ships
	"android/app/src/main/java/com/example/medtracker/PermissionsRationaleActivity.kt": true, // remove when med-ffuu.4 ships
}

var (
	emailRe = regexp.MustCompile(`[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})`)
	// Reserved for documentation/testing (RFC 2606, RFC 6761).
	reservedRe = regexp.MustCompile(`(^|\.)example\.(com|org|net)$|\.(test|example|invalid|localhost)$`)
	// Not an email: asset scale names like mark@2x.png.
	assetScaleRe = regexp.MustCompile(`^\d+x\.(png|jpe?g|gif|webp|pdf)$`)
	// Google service-account test fakes: the format Google mandates, fake project "example".
	fakeServiceAccountRe = regexp.MustCompile(`^example\.iam\.gserviceaccount\.com$`)
	// CI git commit identity, in workflow config only.
	ciIdentity = "actions" + "@github.com" // split: this file is scanned too
	skipDirs   = map[string]bool{".git": true, "node_modules": true, "vendor": true, ".claude": true}
	skipExts   = map[string]bool{
		// images
		".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".ico": true, ".icns": true, ".svg": true,
		// fonts
		".woff": true, ".woff2": true, ".ttf": true, ".otf": true, ".eot": true,
	}
	skipNames = map[string]bool{ // lockfiles: generated, third-party metadata
		"pnpm-lock.yaml": true, "package-lock.json": true, "yarn.lock": true, "go.sum": true,
		"Podfile.lock": true, "Package.resolved": true, "gradle.lockfile": true,
	}
)

// projectDomains is the project domain family: the encoded constant, plus the
// full configured base (CLOUD_BASE_DOMAIN) when it is a real, multi-label host.
// The full base, not its last two labels: those can be a public suffix (co.uk).
func projectDomains(t *testing.T, env string) []string {
	b, err := base64.StdEncoding.DecodeString(projectDomainB64)
	if err != nil {
		t.Fatal(err)
	}
	out := []string{string(b)}
	if env = strings.ToLower(strings.TrimSpace(env)); strings.Contains(env, ".") && !reservedRe.MatchString(env) {
		out = append(out, env)
	}
	var fam []string
	for _, d := range out {
		labels := strings.Split(d, ".")
		for i, j := 0, len(labels)-1; i < j; i, j = i+1, j-1 {
			labels[i], labels[j] = labels[j], labels[i]
		}
		fam = append(fam, d, strings.Join(labels, ".")+".") // reverse-DNS ids too
	}
	return fam
}

func skipped(rel string) bool {
	for _, part := range strings.Split(path.Dir(rel), "/") {
		if skipDirs[part] {
			return true
		}
	}
	base := path.Base(rel)
	upper := strings.ToUpper(base)
	if strings.HasPrefix(upper, "LICENSE") || strings.HasPrefix(upper, "OFL") { // licence texts
		return true
	}
	return skipNames[base] || skipExts[strings.ToLower(path.Ext(base))]
}

func emailAllowed(rel, addr, domain string) bool {
	domain = strings.ToLower(domain)
	switch {
	case reservedRe.MatchString(domain), assetScaleRe.MatchString(domain), fakeServiceAccountRe.MatchString(domain):
		return true
	case strings.ToLower(addr) == ciIdentity:
		return strings.HasPrefix(rel, ".github/workflows/")
	}
	return false
}

func TestEmailAllowed(t *testing.T) {
	for _, c := range []struct {
		rel, addr string
		ok        bool
	}{
		{"docs/x.md", "a@b.example.org", true},
		{"docs/x.md", "a@qa.test", true},
		{"ios/Contents.json", "mark@2x.png", true},
		{"x_test.go", "svc@example.iam.gserviceaccount.com", true},
		{".github/workflows/deploy.yml", ciIdentity, true},
		// Negative cases are split at the @ so this file stays clean under its own scan.
		{"docs/x.md", "support" + "@clinic.md", false},
		{"docs/x.md", ciIdentity, false},
		{".github/workflows/deploy.yml", "operator" + "@github.com", false},
		{"x_test.go", "owner" + "@realproject.iam.gserviceaccount.com", false},
		{"docs/x.md", "a" + "@b.co", false},
	} {
		m := emailRe.FindStringSubmatch(c.addr)
		if m == nil || emailAllowed(c.rel, m[0], m[1]) != c.ok {
			t.Errorf("emailAllowed(%s, %s) want %v", c.rel, c.addr, c.ok)
		}
	}
}

func TestProjectDomains_FullBase(t *testing.T) {
	base := "cloud.health" + ".co.uk" // split: this file is scanned too
	fam := projectDomains(t, base)
	if !slices.Contains(fam, base) || slices.Contains(fam, "co.uk") {
		t.Errorf("family %v: want the full base, never its public suffix", fam)
	}
	if len(projectDomains(t, "qa.test")) != len(projectDomains(t, "")) {
		t.Error("a reserved base must not join the family")
	}
}

// TestRepo_NoProjectDomainOrRealEmail: no real project domain and no email
// with a non-reserved domain anywhere in git (bd med-ffuu.2). Scans tracked
// files (git ls-files), so ignored local build output cannot fail it.
func TestRepo_NoProjectDomainOrRealEmail(t *testing.T) {
	top, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		t.Skipf("not a git checkout: %v", err)
	}
	root := strings.TrimSpace(string(top))
	cmd := exec.Command("git", "ls-files", "-z")
	cmd.Dir = root
	list, err := cmd.Output()
	if err != nil {
		t.Fatalf("git ls-files: %v", err)
	}
	fam := projectDomains(t, os.Getenv("CLOUD_BASE_DOMAIN"))
	for _, rel := range strings.Split(strings.TrimRight(string(list), "\x00"), "\x00") {
		if rel == "" || skipped(rel) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			continue // deleted in the working tree, a submodule dir
		}
		head := data
		if len(head) > 8000 {
			head = head[:8000]
		}
		if bytes.IndexByte(head, 0) >= 0 {
			continue // binary
		}
		sc := bufio.NewScanner(bytes.NewReader(data))
		sc.Buffer(make([]byte, 0, 64*1024), len(data)+1)
		for n := 1; sc.Scan(); n++ {
			line := sc.Text()
			lower := strings.ToLower(line)
			for _, d := range fam {
				if strings.Contains(lower, d) && !pendingNative[rel] {
					t.Errorf("%s:%d: project domain in git; use a placeholder or derive it from the base host", rel, n)
				}
			}
			for _, m := range emailRe.FindAllStringSubmatch(line, -1) {
				if !emailAllowed(rel, m[0], m[1]) {
					t.Errorf("%s:%d: email %q; use an example.com/.org/.net/.test address", rel, n, m[0])
				}
			}
		}
	}
}
