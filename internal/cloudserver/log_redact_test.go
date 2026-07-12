package cloudserver

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// A push subscription endpoint is a per-device bearer capability; logging it
// raw leaks a secret into application (and downstream proxy) logs. Every push
// log site in this package must route the endpoint through
// endpointFingerprint(). This guard fails if any non-test file passes a bare
// `<ident>.Endpoint` as an slog value. See bd med-yor.6.
func TestNoRawPushEndpointInLogs(t *testing.T) {
	// A quoted slog key, a comma, then a bare `<ident>.Endpoint` value. The
	// redacted form `endpointFingerprint(sub.Endpoint)` puts a `(` between the
	// key and the field access, so it does not match.
	rawEndpointArg := regexp.MustCompile(`"[^"]*",\s*[A-Za-z_][\w.]*\.Endpoint\b`)

	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	scanned := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		scanned++
		for i, line := range strings.Split(string(src), "\n") {
			if !strings.Contains(line, "slog.") {
				continue
			}
			if rawEndpointArg.MatchString(line) {
				t.Errorf("%s:%d logs a raw push endpoint as an slog value; wrap it in endpointFingerprint(): %s",
					f, i+1, strings.TrimSpace(line))
			}
		}
	}
	if scanned == 0 {
		t.Fatal("scanned no source files; glob or working dir is wrong")
	}
}

// endpointFingerprint must be stable, non-empty for real endpoints, non-reversible
// (not a substring of the input), and empty for empty input.
func TestEndpointFingerprint(t *testing.T) {
	const ep = "https://fcm.googleapis.com/fcm/send/abc123-secret-token"
	fp := endpointFingerprint(ep)
	if fp == "" {
		t.Fatal("fingerprint of a real endpoint must not be empty")
	}
	if endpointFingerprint(ep) != fp {
		t.Fatal("fingerprint must be stable")
	}
	if strings.Contains(ep, fp) || strings.Contains(fp, "googleapis") || strings.Contains(fp, "abc123") {
		t.Fatalf("fingerprint leaks the endpoint: %q", fp)
	}
	if endpointFingerprint("") != "" {
		t.Fatal("empty endpoint must fingerprint to empty string")
	}
}
