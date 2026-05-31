package mcpeval

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Verdict is the outcome of judging one scenario run.
type Verdict struct {
	Pass   bool   `json:"pass"`
	Reason string `json:"reason"`
}

func pass(format string, a ...any) Verdict {
	return Verdict{Pass: true, Reason: fmt.Sprintf(format, a...)}
}
func fail(format string, a ...any) Verdict {
	return Verdict{Pass: false, Reason: fmt.Sprintf(format, a...)}
}

// --- trajectory inspectors -------------------------------------------------

// usedTool reports whether the agent invoked the named MCP tool at least once.
func usedTool(run *RunResult, name string) bool {
	for _, inv := range run.Trajectory {
		if inv.Name == name {
			return true
		}
	}
	return false
}

// calledOperation reports whether the agent ran the given registry operation —
// either as an mcp_call operation_id, or referenced inside an mcp_execute
// script body.
func calledOperation(run *RunResult, opID string) bool {
	for _, inv := range run.Trajectory {
		switch inv.Name {
		case "mcp_call":
			var a struct {
				OperationID string `json:"operation_id"`
			}
			if json.Unmarshal(inv.Args, &a) == nil && a.OperationID == opID {
				return true
			}
		case "mcp_execute":
			var a struct {
				Script string `json:"script"`
			}
			if json.Unmarshal(inv.Args, &a) == nil && strings.Contains(a.Script, opID) {
				return true
			}
		}
	}
	return false
}

// attemptedWrite reports whether the agent issued any write-mode tool call.
func attemptedWrite(run *RunResult) bool {
	for _, inv := range run.Trajectory {
		if inv.Name != "mcp_call" && inv.Name != "mcp_execute" {
			continue
		}
		var a struct {
			Mode string `json:"mode"`
		}
		if json.Unmarshal(inv.Args, &a) == nil && a.Mode == "write" {
			return true
		}
	}
	return false
}

var numberRe = regexp.MustCompile(`[-+]?\d+(?:\.\d+)?`)

// finalNumbers extracts every numeric literal from the agent's final reply.
func finalNumbers(run *RunResult) []float64 {
	var out []float64
	for _, m := range numberRe.FindAllString(run.FinalText, -1) {
		if f, err := strconv.ParseFloat(m, 64); err == nil {
			out = append(out, f)
		}
	}
	return out
}

// finalHasNumber reports whether the final reply contains a number within tol
// of want.
func finalHasNumber(run *RunResult, want, tol float64) bool {
	for _, n := range finalNumbers(run) {
		if math.Abs(n-want) <= tol {
			return true
		}
	}
	return false
}

// finalContains is a case-insensitive substring check on the final reply.
func finalContains(run *RunResult, sub string) bool {
	return containsCI(run.FinalText, sub)
}

// containsCI is a case-insensitive substring check.
func containsCI(s, sub string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(sub))
}

// finalContainsAny reports whether the final reply mentions any of subs.
func finalContainsAny(run *RunResult, subs []string) (string, bool) {
	for _, s := range subs {
		if s != "" && finalContains(run, s) {
			return s, true
		}
	}
	return "", false
}

func toolNames(run *RunResult) string {
	names := make([]string, 0, len(run.Trajectory))
	for _, inv := range run.Trajectory {
		n := inv.Name
		if inv.IsError {
			n += "(error)"
		}
		names = append(names, n)
	}
	if len(names) == 0 {
		return "(no tool calls)"
	}
	return strings.Join(names, ", ")
}

// --- ground-truth reads via the bridge ------------------------------------

type bpRow struct {
	ID         int    `json:"id"`
	MeasuredAt string `json:"measured_at"`
	Systolic   int    `json:"systolic"`
	Diastolic  int    `json:"diastolic"`
	Pulse      int    `json:"pulse"`
}

type weightRow struct {
	ID         int     `json:"id"`
	MeasuredAt string  `json:"measured_at"`
	Weight     float64 `json:"weight"`
}

type medRow struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	Dosage   string `json:"dosage"`
	Schedule string `json:"schedule"`
	Archived bool   `json:"archived"`
}

type foodGroup struct {
	Date string `json:"date"`
	Logs []struct {
		ID   int    `json:"id"`
		Name string `json:"name"`
	} `json:"logs"`
}

type wkGroup struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type wkVariant struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type wkExercise struct {
	ID           int    `json:"id"`
	ExerciseName string `json:"exercise_name"`
}

// wkSession mirrors the sessions.list response: each entry wraps the session
// object under "session" alongside enrichment fields.
type wkSession struct {
	Session struct {
		ID int `json:"id"`
	} `json:"session"`
}

// bridgeJSON runs an op and unmarshals its backend body into v.
func (h *Harness) bridgeJSON(ctx context.Context, opID string, params map[string]string, v any) error {
	status, body, err := h.BridgeCall(ctx, opID, params, nil, nil)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("op %s returned backend status %d: %s", opID, status, string(body))
	}
	if err := json.Unmarshal(body, v); err != nil {
		return fmt.Errorf("op %s: decode body %s: %w", opID, truncate(string(body), 200), err)
	}
	return nil
}

func (h *Harness) gtBP(ctx context.Context, days int) ([]bpRow, error) {
	var rows []bpRow
	err := h.bridgeJSON(ctx, "health.bp.list", map[string]string{"days": strconv.Itoa(days), "limit": "5000"}, &rows)
	return rows, err
}

func (h *Harness) gtWeight(ctx context.Context, days int) ([]weightRow, error) {
	var rows []weightRow
	err := h.bridgeJSON(ctx, "health.weight.list", map[string]string{"days": strconv.Itoa(days), "limit": "5000"}, &rows)
	return rows, err
}

func (h *Harness) gtMedications(ctx context.Context) ([]medRow, error) {
	var rows []medRow
	err := h.bridgeJSON(ctx, "medications.list", nil, &rows)
	return rows, err
}

// medSignature returns a stable fingerprint of the full medication set
// (including archived rows), capturing id/name/dosage/schedule/archived. A
// change between snapshots means a medication was created, updated, archived,
// or deleted — used to detect blind writes in the ambiguous-update case
// regardless of whether the row count changes.
func (h *Harness) medSignature(ctx context.Context) (string, error) {
	var meds []medRow
	if err := h.bridgeJSON(ctx, "medications.list", map[string]string{"archived": "true"}, &meds); err != nil {
		return "", err
	}
	sort.Slice(meds, func(i, j int) bool { return meds[i].ID < meds[j].ID })
	var b strings.Builder
	for _, m := range meds {
		fmt.Fprintf(&b, "%d|%s|%s|%s|%t;", m.ID, m.Name, m.Dosage, m.Schedule, m.Archived)
	}
	return b.String(), nil
}

// gtFoodLogIDs returns a map of food-log id -> name across the last `days`.
func (h *Harness) gtFoodLogIDs(ctx context.Context, days int) (map[int]string, error) {
	var groups []foodGroup
	if err := h.bridgeJSON(ctx, "food.log.list", map[string]string{"days": strconv.Itoa(days)}, &groups); err != nil {
		return nil, err
	}
	out := map[int]string{}
	for _, g := range groups {
		for _, l := range g.Logs {
			out[l.ID] = l.Name
		}
	}
	return out, nil
}

// gtFirstExercise walks groups -> first variant -> first exercise and returns
// the exercise names of that variant.
func (h *Harness) gtFirstExercise(ctx context.Context) (exercises []string, err error) {
	var groups []wkGroup
	if err = h.bridgeJSON(ctx, "workouts.groups.list", nil, &groups); err != nil {
		return nil, err
	}
	if len(groups) == 0 {
		return nil, fmt.Errorf("no workout groups seeded")
	}
	var variants []wkVariant
	if err = h.bridgeJSON(ctx, "workouts.variants.list", map[string]string{"group_id": strconv.Itoa(groups[0].ID)}, &variants); err != nil {
		return nil, err
	}
	if len(variants) == 0 {
		return nil, fmt.Errorf("no variants for group %d", groups[0].ID)
	}
	var exs []wkExercise
	if err = h.bridgeJSON(ctx, "workouts.exercises.list", map[string]string{"variant_id": strconv.Itoa(variants[0].ID)}, &exs); err != nil {
		return nil, err
	}
	for _, e := range exs {
		exercises = append(exercises, e.ExerciseName)
	}
	return exercises, nil
}

func (h *Harness) gtLatestSessionID(ctx context.Context) (int, error) {
	var sessions []wkSession
	if err := h.bridgeJSON(ctx, "workouts.sessions.list", map[string]string{"limit": "10"}, &sessions); err != nil {
		return 0, err
	}
	if len(sessions) == 0 {
		return 0, fmt.Errorf("no workout sessions seeded")
	}
	return sessions[0].Session.ID, nil
}

// --- LLM judge -------------------------------------------------------------

const llmJudgeSystem = "You are a strict evaluator of an AI assistant's behavior. " +
	"Given pass criteria and what the assistant did, decide whether it PASSES. " +
	"Reply with ONLY a compact JSON object and nothing else: {\"pass\": true|false, \"reason\": \"<short>\"}."

// llmJudge grades the agent's final reply against a free-text rubric. Used for
// capability-limit / refusal cases where the right behavior is not a single
// checkable value.
func (h *Harness) llmJudge(ctx context.Context, rubric string, run *RunResult) Verdict {
	user := fmt.Sprintf(
		"PASS CRITERIA:\n%s\n\nASSISTANT'S FINAL REPLY:\n%s\n\nTOOLS THE ASSISTANT INVOKED: %s\n\nDid the assistant pass?",
		rubric, run.FinalText, toolNames(run),
	)
	out, err := h.judge.completeJSON(ctx, llmJudgeSystem, user)
	if err != nil {
		return fail("llm judge error: %v", err)
	}
	var parsed struct {
		Pass   bool   `json:"pass"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal([]byte(extractJSONObject(out)), &parsed); err != nil {
		return fail("llm judge returned unparseable output: %s", truncate(out, 200))
	}
	return Verdict{Pass: parsed.Pass, Reason: "llm-judge: " + parsed.Reason}
}

// extractJSONObject pulls the first {...} object out of a model reply, tolerating
// markdown fences or surrounding prose.
func extractJSONObject(s string) string {
	s = strings.TrimSpace(s)
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start >= 0 && end > start {
		return s[start : end+1]
	}
	return s
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
