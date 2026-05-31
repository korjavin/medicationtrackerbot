// Command mcpeval runs the MCP agent-usage evaluation suite outside `go test`
// and writes a per-case scorecard (markdown + JSON). It is the "hill-climbing"
// loop from the evals playbook: tweak the MCP tool descriptions / usage_protocol
// (or the system-prompt-under-test), re-run, and watch the score move.
//
// Requires MCPEVAL_API_KEY (and optionally MCPEVAL_BASE_URL / MCPEVAL_MODEL /
// MCPEVAL_JUDGE_MODEL / MCPEVAL_SEED / MCPEVAL_DAYS / MCPEVAL_MAX_ROUNDS).
//
//	MCPEVAL_API_KEY=sk-... MCPEVAL_MODEL=gpt-4o-mini go run ./cmd/mcpeval
//
// Exit code is non-zero if any non-skipped scenario fails, so it can gate CI.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/mcpeval"
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))

	cfg, ok := mcpeval.ConfigFromEnv()
	if !ok {
		fmt.Fprintln(os.Stderr, "mcpeval: MCPEVAL_API_KEY is required.")
		fmt.Fprintln(os.Stderr, "Set MCPEVAL_API_KEY (and optionally MCPEVAL_BASE_URL, MCPEVAL_MODEL) and re-run.")
		os.Exit(2)
	}

	ctx := context.Background()
	fmt.Printf("Building harness (model=%s, seed=%d, days=%d)…\n", cfg.Model, cfg.Seed, cfg.Days)
	h, err := mcpeval.New(ctx, cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "mcpeval: build harness: %v\n", err)
		os.Exit(1)
	}
	defer h.Close()
	if !h.PythonAvailable() {
		fmt.Println("note: python3/runner.py unavailable — mcp_execute scenarios will be skipped")
	}

	scenarios := mcpeval.Scenarios()
	results := make([]mcpeval.ScenarioResult, 0, len(scenarios))
	for _, sc := range scenarios {
		fmt.Printf("running %-22s … ", sc.ID)
		res := h.RunScenario(ctx, sc)
		results = append(results, res)
		fmt.Println(statusWord(res))
	}

	report := buildReport(cfg, h, results)
	printSummary(report)

	if err := writeReports(report); err != nil {
		fmt.Fprintf(os.Stderr, "mcpeval: write report: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("\nWrote mcpeval-report.md and mcpeval-report.json\n")

	if report.Failed > 0 {
		os.Exit(1)
	}
}

// --- report model ----------------------------------------------------------

type caseReport struct {
	ID        string `json:"id"`
	Bucket    string `json:"bucket"`
	Task      string `json:"task"`
	Status    string `json:"status"` // pass | fail | skip
	Reason    string `json:"reason"`
	Tools     string `json:"tools"`
	Rounds    int    `json:"rounds"`
	FinalText string `json:"final_text"`
	Truncated bool   `json:"truncated"`
}

type report struct {
	GeneratedAt string            `json:"generated_at"`
	Model       string            `json:"model"`
	BaseURL     string            `json:"base_url"`
	Total       int               `json:"total"`
	Passed      int               `json:"passed"`
	Failed      int               `json:"failed"`
	Skipped     int               `json:"skipped"`
	ByBucket    map[string]string `json:"by_bucket"` // bucket -> "passed/scored"
	Cases       []caseReport      `json:"cases"`
}

func buildReport(cfg mcpeval.Config, h *mcpeval.Harness, results []mcpeval.ScenarioResult) report {
	r := report{
		GeneratedAt: time.Now().Format(time.RFC3339),
		Model:       cfg.Model,
		BaseURL:     defaultStr(cfg.BaseURL, "https://api.openai.com/v1"),
		ByBucket:    map[string]string{},
	}
	bucketPass := map[string]int{}
	bucketScored := map[string]int{}

	for _, res := range results {
		c := caseReport{
			ID:     res.Scenario.ID,
			Bucket: string(res.Scenario.Bucket),
			Task:   res.Scenario.Task,
			Reason: res.Verdict.Reason,
		}
		if res.Run != nil {
			c.Tools = trajectorySummary(res.Run)
			c.Rounds = res.Run.Rounds
			c.FinalText = res.Run.FinalText
			c.Truncated = res.Run.Truncated
		}
		switch {
		case res.Skipped:
			c.Status = "skip"
			c.Reason = res.Reason
			r.Skipped++
		case res.Verdict.Pass:
			c.Status = "pass"
			r.Passed++
			bucketPass[c.Bucket]++
			bucketScored[c.Bucket]++
		default:
			c.Status = "fail"
			r.Failed++
			bucketScored[c.Bucket]++
		}
		r.Cases = append(r.Cases, c)
	}
	r.Total = len(results)
	for b, scored := range bucketScored {
		r.ByBucket[b] = fmt.Sprintf("%d/%d", bucketPass[b], scored)
	}
	return r
}

func trajectorySummary(run *mcpeval.RunResult) string {
	if len(run.Trajectory) == 0 {
		return "(no tool calls)"
	}
	parts := make([]string, 0, len(run.Trajectory))
	for _, inv := range run.Trajectory {
		label := inv.Name
		// Annotate mcp_call/mcp_execute with the operation_id / mode for a
		// readable trace.
		var a struct {
			OperationID string `json:"operation_id"`
			Mode        string `json:"mode"`
		}
		_ = json.Unmarshal(inv.Args, &a)
		if a.OperationID != "" {
			label += "(" + a.OperationID + ")"
		}
		if a.Mode == "write" {
			label += "[write]"
		}
		if inv.IsError {
			label += "✗"
		}
		parts = append(parts, label)
	}
	return strings.Join(parts, " → ")
}

func printSummary(r report) {
	fmt.Printf("\n=== mcpeval: %d passed, %d failed, %d skipped (model %s) ===\n", r.Passed, r.Failed, r.Skipped, r.Model)
	for _, b := range []string{"control", "edge", "capability"} {
		if v, ok := r.ByBucket[b]; ok {
			fmt.Printf("  %-11s %s\n", b, v)
		}
	}
}

func writeReports(r report) error {
	jsonBytes, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile("mcpeval-report.json", jsonBytes, 0o644); err != nil {
		return err
	}
	return os.WriteFile("mcpeval-report.md", []byte(renderMarkdown(r)), 0o644)
}

func renderMarkdown(r report) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# MCP agent-usage eval report\n\n")
	fmt.Fprintf(&b, "- Generated: `%s`\n", r.GeneratedAt)
	fmt.Fprintf(&b, "- Model: `%s` (`%s`)\n", r.Model, r.BaseURL)
	fmt.Fprintf(&b, "- Score: **%d passed**, %d failed, %d skipped (of %d)\n", r.Passed, r.Failed, r.Skipped, r.Total)
	fmt.Fprintf(&b, "- By bucket: ")
	bys := make([]string, 0, len(r.ByBucket))
	for _, bk := range []string{"control", "edge", "capability"} {
		if v, ok := r.ByBucket[bk]; ok {
			bys = append(bys, fmt.Sprintf("%s %s", bk, v))
		}
	}
	fmt.Fprintf(&b, "%s\n\n", strings.Join(bys, " · "))

	fmt.Fprintf(&b, "| Case | Bucket | Result | Rounds | Tool trajectory |\n")
	fmt.Fprintf(&b, "|------|--------|--------|--------|-----------------|\n")
	for _, c := range r.Cases {
		fmt.Fprintf(&b, "| %s | %s | %s | %d | %s |\n",
			c.ID, c.Bucket, resultBadge(c.Status), c.Rounds, mdEscape(c.Tools))
	}
	b.WriteString("\n## Details\n\n")
	for _, c := range r.Cases {
		fmt.Fprintf(&b, "### %s — %s\n\n", c.ID, resultBadge(c.Status))
		fmt.Fprintf(&b, "- **Task:** %s\n", c.Task)
		fmt.Fprintf(&b, "- **Verdict:** %s\n", c.Reason)
		if c.Tools != "" {
			fmt.Fprintf(&b, "- **Tools:** %s\n", mdEscape(c.Tools))
		}
		if c.Truncated {
			fmt.Fprintf(&b, "- **Note:** hit the round cap without finishing\n")
		}
		if strings.TrimSpace(c.FinalText) != "" {
			fmt.Fprintf(&b, "- **Final reply:** %s\n", mdEscape(truncate(c.FinalText, 600)))
		}
		b.WriteString("\n")
	}
	return b.String()
}

func resultBadge(status string) string {
	switch status {
	case "pass":
		return "✅ pass"
	case "fail":
		return "❌ fail"
	default:
		return "⤼ skip"
	}
}

func statusWord(res mcpeval.ScenarioResult) string {
	switch {
	case res.Skipped:
		return "SKIP (" + res.Reason + ")"
	case res.Verdict.Pass:
		return "PASS"
	default:
		return "FAIL — " + res.Verdict.Reason
	}
}

func mdEscape(s string) string {
	s = strings.ReplaceAll(s, "|", "\\|")
	return strings.ReplaceAll(s, "\n", " ")
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func defaultStr(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
