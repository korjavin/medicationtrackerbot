//go:build cross_compile_smoke

// Cross-compile smoke test for the Android binaries pipeline. Gated by the
// `cross_compile_smoke` build tag so a default `go test ./...` does not
// shell out to the build script on every push — the script invokes the Go
// cross-compiler three times (once per ABI when NDK is present) and takes
// 5–10 seconds even on a fast machine.
//
// CI / release jobs that care about the mobile pipeline opt in with:
//
//	go test -tags cross_compile_smoke ./cmd/bot
//
// The test sets OUTPUT_DIR to a temp dir so it does not clobber the
// committed-overlay jniLibs tree on the developer's machine. ANDROID_NDK_HOME
// is intentionally NOT inherited: this guarantees only arm64-v8a is built,
// matching the v1 baseline captured in docs/local-mode.md.

package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// TestCrossCompileScript_ProducesArm64Binary shells out to the build script
// with OUTPUT_DIR pointed at a temp jniLibs tree and asserts that:
//   - the script exits 0
//   - the arm64-v8a/libmedtracker.so file exists
//   - the file is executable
//   - the file starts with the ELF magic bytes (sanity check against
//     accidentally writing a "Hello\n" stub from a broken build)
func TestCrossCompileScript_ProducesArm64Binary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("/bin/sh script — Windows CI is not a target for this project")
	}

	repoRoot := findRepoRoot(t)
	script := filepath.Join(repoRoot, "scripts", "build-android-binaries.sh")
	if _, err := os.Stat(script); err != nil {
		t.Fatalf("build script missing at %s: %v", script, err)
	}

	outDir := filepath.Join(t.TempDir(), "jniLibs")

	cmd := exec.Command(script)
	// Strip ANDROID_NDK_HOME from inherited env so the script's default
	// behavior (arm64-only) kicks in — this test is the baseline check, and
	// the multi-ABI path requires a real NDK install that CI won't always have.
	env := []string{}
	for _, kv := range os.Environ() {
		if len(kv) >= 17 && kv[:17] == "ANDROID_NDK_HOME=" {
			continue
		}
		env = append(env, kv)
	}
	env = append(env, "OUTPUT_DIR="+outDir)
	cmd.Env = env
	cmd.Dir = repoRoot

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("build script failed: %v\nstdout:\n%s\nstderr:\n%s",
			err, stdout.String(), stderr.String())
	}

	bin := filepath.Join(outDir, "arm64-v8a", "libmedtracker.so")
	info, err := os.Stat(bin)
	if err != nil {
		t.Fatalf("arm64-v8a binary missing: %v\nstdout:\n%s\nstderr:\n%s",
			err, stdout.String(), stderr.String())
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("arm64-v8a binary is not executable: mode=%v", info.Mode())
	}

	// ELF magic: 0x7F 'E' 'L' 'F'. A defensive cheap check — we don't try to
	// parse the full ELF header here; that's what `file` is for in the docs.
	f, err := os.Open(bin)
	if err != nil {
		t.Fatalf("open arm64-v8a binary: %v", err)
	}
	defer f.Close()
	header := make([]byte, 4)
	if _, err := f.Read(header); err != nil {
		t.Fatalf("read arm64-v8a binary header: %v", err)
	}
	want := []byte{0x7F, 'E', 'L', 'F'}
	if !bytes.Equal(header, want) {
		t.Fatalf("arm64-v8a binary is not an ELF: header=%x", header)
	}
}

// findRepoRoot walks up from the test file's package until it finds a go.mod
// — this is the same trick `go list` uses internally. Avoids hard-coding any
// relative path that would break if the test file moves.
func findRepoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	dir := wd
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("could not find go.mod walking up from %s", wd)
		}
		dir = parent
	}
}
