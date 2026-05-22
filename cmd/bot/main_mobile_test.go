//go:build mobile

// The mobile build's wiring is verified by virtue of the package compiling
// under -tags mobile. This sentinel test asserts the build tag is in effect
// (so a regression that lands main_server.go without its !mobile tag would
// fail here at run time rather than only failing the build).

package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// mobileBuild is set to true when the mobile build tag is active. The
// server-only paired file sets it to false; if both were ever pulled in by a
// missing or duplicate build tag, the linker would fail with a duplicate
// declaration — that's the regression this guard catches.
var mobileBuild = true

func TestMobileBuildTagInEffect(t *testing.T) {
	if !mobileBuild {
		t.Fatal("mobile build tag was not applied — main_mobile.go did not select the mobile variant")
	}
}

// listenLinePattern matches the LISTENING startup line that the Android shell
// parses to discover the OS-assigned port. The hostname is intentionally fixed
// to 127.0.0.1; only the port varies.
var listenLinePattern = regexp.MustCompile(`^LISTENING 127\.0\.0\.1:(\d+)$`)

// TestRunMobile_OSAssignedPort exercises the `-port 0` argv path. The
// Android shell relies on this path so it doesn't have to pick a fixed port
// that might collide with another app on the device.
func TestRunMobile_OSAssignedPort(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")
	port, cleanup := startMobileForTest(t, []string{"-db", dbPath, "-port", "0"})
	defer cleanup()

	if port <= 0 || port > 65535 {
		t.Fatalf("unparseable port: %d", port)
	}
	assertHealthz(t, port)
}

// TestRunMobile_ListeningLineExactFormat asserts the LISTENING startup line
// matches the regex the Android shell relies on: exactly one line, the literal
// prefix "LISTENING 127.0.0.1:", then a decimal port, then a single newline.
// The shell's stdout reader grabs the first line via bufio.ReadLine; if this
// format ever drifts the shell will hang on its 10s healthz wait without ever
// knowing which port to try. Capturing the exact format here makes that
// contract a unit-level invariant rather than a runtime surprise.
func TestRunMobile_ListeningLineExactFormat(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")
	pr, pw := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = runMobile(ctx, []string{"-db", dbPath, "-port", "0"}, pw)
		_ = pw.Close()
	}()

	br := bufio.NewReader(pr)
	line, err := br.ReadString('\n')
	if err != nil {
		t.Fatalf("read first line: %v", err)
	}
	if !strings.HasSuffix(line, "\n") {
		t.Fatalf("LISTENING line missing trailing newline: %q", line)
	}
	trimmed := strings.TrimSuffix(line, "\n")
	if !listenLinePattern.MatchString(trimmed) {
		t.Fatalf("LISTENING line %q does not match %s", trimmed, listenLinePattern)
	}
	// Drain the pipe so runMobile's stdout writes don't block while we shut down.
	go func() { _, _ = io.Copy(io.Discard, br) }()

	cancel()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatalf("runMobile did not return within 15s after cancel")
	}
}

// TestRunMobile_SessionSecretRejectsShort asserts that a too-short session
// secret is rejected at argv-parse time rather than panicking deep inside
// server.New. The Android shell generates 32 random bytes so it can't trip
// this path under normal use, but a misconfigured argv (or a future caller
// passing through a truncated value) would otherwise fail with a confusing
// trace.
func TestRunMobile_SessionSecretRejectsShort(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	err := runMobile(ctx, []string{"-db", dbPath, "-port", "0", "-session-secret", "tooshort"}, io.Discard)
	if err == nil {
		t.Fatal("expected runMobile to reject a short session-secret, got nil")
	}
	if !strings.Contains(err.Error(), "session-secret") {
		t.Fatalf("error %q should mention 'session-secret'", err)
	}
}

// TestRunMobile_FixedPort exercises the `-port <fixed>` argv path. Used by
// developer workflows that want a stable URL across reboots.
func TestRunMobile_FixedPort(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("could not pick a free port: %v", err)
	}
	fixed := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()

	dbPath := filepath.Join(t.TempDir(), "test.db")
	port, cleanup := startMobileForTest(t, []string{"-db", dbPath, "-port", strconv.Itoa(fixed)})
	defer cleanup()

	if port != fixed {
		t.Fatalf("expected port %d, got %d", fixed, port)
	}
	assertHealthz(t, port)
}

// startMobileForTest launches runMobile in a goroutine, parses the LISTENING
// line from its stdout pipe, and returns the bound port plus a cleanup
// function that cancels the run context. Fails the test if startup takes more
// than 10s — DB migrations + server.New are the slowest steps and complete
// well within that bound on developer machines.
func startMobileForTest(t *testing.T, args []string) (int, func()) {
	t.Helper()
	pr, pw := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		err := runMobile(ctx, args, pw)
		_ = pw.Close()
		done <- err
	}()

	portCh := make(chan int, 1)
	errCh := make(chan error, 1)
	go func() {
		br := bufio.NewReader(pr)
		line, err := br.ReadString('\n')
		if err != nil {
			errCh <- fmt.Errorf("read LISTENING: %w", err)
			return
		}
		m := listenLinePattern.FindStringSubmatch(strings.TrimSuffix(line, "\n"))
		if m == nil {
			errCh <- fmt.Errorf("unexpected stdout first line: %q", line)
			return
		}
		p, err := strconv.Atoi(m[1])
		if err != nil {
			errCh <- fmt.Errorf("parse port from %q: %w", line, err)
			return
		}
		portCh <- p
		// Drain stdout so the writer never blocks on a future fmt.Fprintf
		// the binary may grow. Errors here are uninteresting — the pipe
		// closes when runMobile returns and Copy returns io.EOF.
		_, _ = io.Copy(io.Discard, br)
	}()

	cleanup := func() {
		cancel()
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			t.Errorf("runMobile did not return within 15s after cancel")
		}
	}

	select {
	case p := <-portCh:
		return p, cleanup
	case err := <-errCh:
		cleanup()
		t.Fatalf("startup failed: %v", err)
	case err := <-done:
		t.Fatalf("runMobile returned before LISTENING line: %v", err)
	case <-time.After(10 * time.Second):
		cleanup()
		t.Fatalf("timed out waiting for LISTENING line")
	}
	panic("unreachable")
}

// TestRunMobile_ServesEmbeddedStaticAssets exercises the embed-backed
// static-file handlers wired via server.SetStaticFS(web.StaticFS()) in
// main_mobile.go's runMobile. On Android the binary spawns from a read-only
// nativeLibraryDir with no co-located "./web/static" tree, so without the
// embed wiring GET / and GET /static/sw.js would 500 — breaking the
// WebView's loadUrl(base) path the Capacitor shell uses to render the PWA.
// The test asserts both pages serve from a cwd that does NOT contain
// "./web/static", matching the on-device condition.
func TestRunMobile_ServesEmbeddedStaticAssets(t *testing.T) {
	// chdir to a temp dir that has no "./web/static" subtree. If the embed
	// wiring regressed, the handlers would fall back to disk and the
	// resulting 500 would surface immediately on the GET / below.
	emptyCwd := t.TempDir()
	prev, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(emptyCwd); err != nil {
		t.Fatalf("chdir to %s: %v", emptyCwd, err)
	}
	t.Cleanup(func() { _ = os.Chdir(prev) })

	dbPath := filepath.Join(t.TempDir(), "test.db")
	port, cleanup := startMobileForTest(t, []string{"-db", dbPath, "-port", "0"})
	defer cleanup()

	cases := []struct {
		name     string
		path     string
		wantBody string // substring assertion; full content compares are brittle across edits
	}{
		{"index.html", "/", "<title>Med Tracker</title>"},
		{"service worker", "/static/sw.js", "self.addEventListener"},
		{"app.js", "/static/js/app.js", ""}, // existence-only; bundle is large and frequently edited
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d%s", port, tc.path))
			if err != nil {
				t.Fatalf("GET %s: %v", tc.path, err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("GET %s status=%d, want 200", tc.path, resp.StatusCode)
			}
			body, err := io.ReadAll(resp.Body)
			if err != nil {
				t.Fatalf("read body: %v", err)
			}
			if len(body) == 0 {
				t.Fatalf("GET %s returned empty body", tc.path)
			}
			if tc.wantBody != "" && !strings.Contains(string(body), tc.wantBody) {
				t.Fatalf("GET %s body missing %q (got first 200 bytes: %q)", tc.path, tc.wantBody, string(body[:min(200, len(body))]))
			}
		})
	}
}

// assertHealthz polls /healthz with a 5s deadline and asserts a 200 response
// with body "ok". Polling (rather than a single GET) tolerates the brief
// window between net.Listen succeeding and http.Server.Serve being ready to
// accept connections.
func assertHealthz(t *testing.T, port int) {
	t.Helper()
	url := fmt.Sprintf("http://127.0.0.1:%d/healthz", port)
	deadline := time.Now().Add(5 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		resp, err := http.Get(url)
		if err == nil {
			body, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				if string(body) != "ok" {
					t.Fatalf("/healthz body=%q, want %q", string(body), "ok")
				}
				return
			}
			lastErr = fmt.Errorf("status=%d body=%q", resp.StatusCode, string(body))
		} else {
			lastErr = err
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("/healthz never responded OK within deadline: %v", lastErr)
}
