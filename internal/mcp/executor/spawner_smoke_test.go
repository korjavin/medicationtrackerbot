package executor

import (
	"context"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestRunnerModuleAndCwd_DerivesFromScript covers the path-to-module
// derivation that backs the production spawner. The mapping is the
// invariant: file invocation breaks the runner because of a circular
// `from runner import limits`, so we lock the `-m runner.runner` form in.
func TestRunnerModuleAndCwd_DerivesFromScript(t *testing.T) {
	cases := []struct {
		name        string
		script      string
		cwd         string
		wantModule  string
		expectError bool
	}{
		{
			name:       "default cwd",
			script:     "/app/python/runner/runner.py",
			cwd:        "",
			wantModule: "runner.runner",
		},
		{
			name:       "explicit cwd",
			script:     "/app/python/runner/runner.py",
			cwd:        "/app/python",
			wantModule: "runner.runner",
		},
		{
			name:       "nested package",
			script:     "/srv/code/pkg/sub/entry.py",
			cwd:        "/srv/code",
			wantModule: "pkg.sub.entry",
		},
		{
			name:        "missing script",
			script:      "",
			expectError: true,
		},
		{
			name:        "non-py extension",
			script:      "/app/python/runner/runner.sh",
			expectError: true,
		},
		{
			name:        "script outside cwd",
			script:      "/elsewhere/runner.py",
			cwd:         "/app/python",
			expectError: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			module, _, err := runnerModuleAndCwd(tc.script, tc.cwd)
			if tc.expectError {
				if err == nil {
					t.Fatalf("expected error, got module=%q", module)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if module != tc.wantModule {
				t.Fatalf("module: want %q, got %q", tc.wantModule, module)
			}
		})
	}
}

// TestExecCmdSpawner_SmokeRealRunner exercises the real execCmdSpawner
// against the repo's python/runner/runner.py to catch contract drift
// between the Go invocation and the Python entrypoint (e.g. the file vs.
// `-m` invocation matters because `from runner import limits` only
// resolves under module form). Skipped when python3 is not on PATH.
func TestExecCmdSpawner_SmokeRealRunner(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skipf("python3 not available: %v", err)
	}

	// repo-root/internal/mcp/executor/spawner_smoke_test.go -> repo root.
	// The Go test runs with cwd at the package dir, so step up three levels
	// to reach python/runner/runner.py.
	repoRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	script := filepath.Join(repoRoot, "python", "runner", "runner.py")

	module, cwd, err := runnerModuleAndCwd(script, "")
	if err != nil {
		t.Fatalf("derive module: %v", err)
	}
	if module != "runner.runner" {
		t.Fatalf("expected derived module runner.runner, got %q", module)
	}

	sp := &execCmdSpawner{python: "python3", module: module, cwd: cwd}

	// Minimal config: a script that imports the helper and calls
	// output(...) immediately. The runner emits a result envelope on
	// stdout regardless of whether the proxy URL is reachable, since the
	// script never makes a call.
	cfg := map[string]any{
		"script":    "from medtracker import output\noutput({\"ok\": True})\n",
		"proxy_url": "http://127.0.0.1:1/", // unused by this script
		"run_token": "smoke-token",
		"mode":      "read_only",
		"timeout_s": 5.0,
	}
	payload, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal config: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	out, err := sp.Spawn(ctx, payload)
	if err != nil {
		t.Fatalf("spawn returned error: %v (output: %s)", err, string(out))
	}
	if len(out) == 0 {
		t.Fatalf("spawn produced empty output")
	}

	var env runnerEnvelope
	if err := json.Unmarshal(out, &env); err != nil {
		t.Fatalf("unmarshal envelope: %v\nraw: %s", err, string(out))
	}

	// Most importantly: the runner must NOT come back with a sandbox
	// startup failure caused by the circular `from runner import limits`
	// import. Any other completion mode (including the script error path
	// for a malformed proxy URL) proves the entrypoint loaded.
	if env.ExitReason == "sandbox_startup_failure" ||
		strings.Contains(env.ErrorMsg, "circular") ||
		strings.Contains(env.ErrorMsg, "cannot import name 'limits'") {
		t.Fatalf("runner failed to start: exit_reason=%q err_type=%q err_msg=%q stderr=%q",
			env.ExitReason, env.ErrorType, env.ErrorMsg, env.Stderr)
	}

	// Sanity: a successful no-op run should return exit_reason="completed".
	if env.ExitReason != "completed" {
		t.Logf("non-completed envelope (acceptable as long as it isn't a startup failure): %+v", env)
	}
}
