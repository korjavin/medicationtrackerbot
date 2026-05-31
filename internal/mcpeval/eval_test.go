package mcpeval

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// TestMCPEval is the LLM-in-the-loop evaluation suite. It is opt-in: without
// MCPEVAL_API_KEY it skips cleanly, so `go test ./...` and CI are unaffected.
//
// Run it with, e.g.:
//
//	MCPEVAL_API_KEY=sk-... MCPEVAL_MODEL=gpt-4o-mini \
//	  go test ./internal/mcpeval -run TestMCPEval -v
//
// All scenarios share one seeded harness and run sequentially (capability cases
// last) so a misbehaving agent can't disturb earlier reads.
func TestMCPEval(t *testing.T) {
	cfg, ok := ConfigFromEnv()
	if !ok {
		t.Skip("MCPEVAL_API_KEY not set; skipping LLM eval suite (see docs/mcp-evals.md)")
	}

	ctx := context.Background()
	h, err := New(ctx, cfg)
	if err != nil {
		t.Fatalf("build harness: %v", err)
	}
	defer h.Close()
	if !h.PythonAvailable() {
		t.Logf("python3/runner.py unavailable — mcp_execute scenarios will be skipped")
	}

	for _, sc := range Scenarios() {
		sc := sc
		t.Run(sc.ID, func(t *testing.T) {
			res := h.RunScenario(ctx, sc)
			if res.Skipped {
				t.Skip(res.Reason)
				return
			}
			t.Logf("[%s] tools=[%s] rounds=%d final=%q",
				sc.Bucket, toolNames(res.Run), res.Run.Rounds, truncate(res.Run.FinalText, 240))
			if !res.Verdict.Pass {
				t.Errorf("FAIL: %s", res.Verdict.Reason)
				return
			}
			t.Logf("PASS: %s", res.Verdict.Reason)
		})
	}
}

// TestHarnessWiring validates the full backend stack WITHOUT an LLM: it seeds
// the store, stands up the real bridge + executor + in-memory MCP session, and
// checks that the trio surface is exposed and that the judges' ground-truth
// reads parse the real handler response shapes. Deterministic, no network, no
// Python — safe to run in CI as a wiring regression guard.
func TestHarnessWiring(t *testing.T) {
	ctx := context.Background()
	h, err := New(ctx, Config{APIKey: "unused-no-llm-calls", Model: "none", Seed: 42, Days: 30, MaxRounds: 4})
	if err != nil {
		t.Fatalf("build harness: %v", err)
	}
	defer h.Close()

	// 1. The live tool surface is exactly the registry trio.
	names := map[string]bool{}
	for _, ts := range h.Tools() {
		names[ts.Name] = true
	}
	for _, want := range []string{"mcp_help", "mcp_call", "mcp_execute"} {
		if !names[want] {
			t.Errorf("missing expected tool %q (got %v)", want, names)
		}
	}
	if len(h.Tools()) != 3 {
		t.Errorf("expected 3 tools (trio only), got %d: %v", len(h.Tools()), names)
	}

	// 2. mcp_help responds through the in-memory session (no LLM involved).
	out, isErr, err := h.RunTool(ctx, "mcp_help", json.RawMessage(`{}`))
	if err != nil || isErr {
		t.Fatalf("mcp_help via session failed: err=%v isErr=%v out=%s", err, isErr, truncate(out, 200))
	}
	if !strings.Contains(out, "usage_protocol") && !strings.Contains(out, "compact_operations") {
		t.Errorf("mcp_help output missing catalog fields: %s", truncate(out, 300))
	}

	// 3. mcp_call performs a real read end-to-end (session -> executor -> proxy
	//    -> bridge -> handler -> seeded store).
	callArgs := json.RawMessage(`{"operation_id":"medications.list"}`)
	out, isErr, err = h.RunTool(ctx, "mcp_call", callArgs)
	if err != nil || isErr {
		t.Fatalf("mcp_call medications.list failed: err=%v isErr=%v out=%s", err, isErr, truncate(out, 300))
	}
	if !strings.Contains(out, `"status":"ok"`) {
		t.Errorf("mcp_call did not report ok status: %s", truncate(out, 300))
	}

	// 4. Ground-truth helpers parse the real backend response shapes — this is
	//    what makes the code-based judges trustworthy.
	if rows, err := h.gtBP(ctx, 30); err != nil || len(rows) == 0 {
		t.Errorf("gtBP: err=%v len=%d", err, len(rows))
	} else if rows[0].Systolic == 0 {
		t.Errorf("gtBP[0] has zero systolic (shape mismatch?): %+v", rows[0])
	}
	if rows, err := h.gtWeight(ctx, 30); err != nil || len(rows) == 0 {
		t.Errorf("gtWeight: err=%v len=%d", err, len(rows))
	} else if rows[0].Weight == 0 {
		t.Errorf("gtWeight[0] has zero weight (shape mismatch?): %+v", rows[0])
	}
	if meds, err := h.gtMedications(ctx); err != nil || len(meds) == 0 {
		t.Errorf("gtMedications: err=%v len=%d", err, len(meds))
	} else if meds[0].Name == "" {
		t.Errorf("gtMedications[0] has empty name (shape mismatch?): %+v", meds[0])
	}
	if ids, err := h.gtFoodLogIDs(ctx, 7); err != nil {
		t.Errorf("gtFoodLogIDs: %v", err)
	} else {
		t.Logf("food logs in last 7d: %d", len(ids))
	}
	if exs, err := h.gtFirstExercise(ctx); err != nil || len(exs) == 0 {
		t.Errorf("gtFirstExercise: err=%v len=%d", err, len(exs))
	} else {
		t.Logf("first variant exercises: %v", exs)
	}
	sid, err := h.gtLatestSessionID(ctx)
	if err != nil || sid == 0 {
		t.Errorf("gtLatestSessionID: err=%v sid=%d", err, sid)
	}
	if sid > 0 {
		if labels, err := h.gtSessionLabels(ctx, sid); err != nil || len(labels) == 0 {
			t.Errorf("gtSessionLabels(%d): err=%v len=%d", sid, err, len(labels))
		} else {
			t.Logf("session %d labels: %v", sid, labels)
		}
	}
	// Capability-case ground-truth helpers: whole-DB row count (mass-delete
	// guard) and the medication fingerprint (ambiguous-update guard).
	total, err := h.totalRowCount(ctx)
	if err != nil || total == 0 {
		t.Errorf("totalRowCount: err=%v total=%d", err, total)
	} else {
		t.Logf("total application rows: %d", total)
	}
	sig1, err := h.medSignature(ctx)
	if err != nil || sig1 == "" {
		t.Errorf("medSignature: err=%v empty=%t", err, sig1 == "")
	}
	if sig2, _ := h.medSignature(ctx); sig2 != sig1 {
		t.Errorf("medSignature not stable across calls:\n  %q\n  %q", sig1, sig2)
	}
}
