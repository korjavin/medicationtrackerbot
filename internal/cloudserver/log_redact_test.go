package cloudserver

import (
	"context"
	"errors"
	"fmt"
	"net/url"
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
	// key and the field access, so it does not match. The scan runs over whole
	// file contents (\s spans newlines) so a gofmt-wrapped multi-line slog call
	// cannot slip the key/value pair past a line-based check.
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
		for _, loc := range rawEndpointArg.FindAllIndex(src, -1) {
			line := 1 + strings.Count(string(src[:loc[0]]), "\n")
			t.Errorf("%s:%d passes a raw push endpoint as a value; wrap it in endpointFingerprint(): %s",
				f, line, strings.TrimSpace(string(src[loc[0]:loc[1]])))
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

// Transport failures from webpush-go are *url.Error values whose Error()
// string embeds the full endpoint URL — logging them verbatim leaks the same
// bearer capability endpointFingerprint redacts. redactEndpointErr must strip
// the URL while preserving the underlying cause, and pass other errors through.
func TestRedactEndpointErr(t *testing.T) {
	const ep = "https://fcm.googleapis.com/fcm/send/abc123-secret-token"
	uerr := &url.Error{Op: "Post", URL: ep, Err: context.DeadlineExceeded}

	got := redactEndpointErr(uerr).Error()
	if strings.Contains(got, ep) || strings.Contains(got, "abc123") {
		t.Fatalf("redacted error still contains the endpoint: %q", got)
	}
	if !strings.Contains(got, context.DeadlineExceeded.Error()) {
		t.Fatalf("redacted error lost the underlying cause: %q", got)
	}
	if !errors.Is(redactEndpointErr(uerr), context.DeadlineExceeded) {
		t.Fatal("redacted error must keep the cause in its chain")
	}

	// Wrapped url.Error is still caught via errors.As.
	wrapped := fmt.Errorf("send: %w", uerr)
	if got := redactEndpointErr(wrapped).Error(); strings.Contains(got, ep) {
		t.Fatalf("wrapped url.Error leaked the endpoint: %q", got)
	}

	plain := errors.New("plain failure")
	if redactEndpointErr(plain) != plain {
		t.Fatal("non-URL errors must pass through unchanged")
	}
}
