package registry

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// fixedNow is a deterministic clock for the relative-date tests.
var fixedNow = time.Date(2026, 5, 31, 21, 20, 0, 0, time.UTC)

func rawMap(t *testing.T, kv map[string]any) map[string]json.RawMessage {
	t.Helper()
	out := map[string]json.RawMessage{}
	for k, v := range kv {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("marshal %q: %v", k, err)
		}
		out[k] = b
	}
	return out
}

// foodCreateOp mirrors the real food.log.create shape: a write with a body
// schema (eaten_at is a timestamp), no params schema.
func foodCreateOp() *Operation {
	return &Operation{
		ID: "food.log.create", Topic: "food", Method: "POST", Path: "/api/food/log", Risk: RiskWrite,
		BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["name", "eaten_at", "weight", "calories"],
  "properties": {
    "eaten_at": {"type": "string", "description": "ISO8601 timestamp (RFC3339 preferred)"},
    "weight":   {"type": "integer"},
    "calories": {"type": "integer"},
    "name":     {"type": "string"}
  }
}`),
	}
}

func TestNormalizeCallInput_CoalescesParamsIntoBodyForWrite(t *testing.T) {
	// The exact gemma failure: write fields placed in params, empty body.
	params := rawMap(t, map[string]any{"weight": 100, "calories": 280, "name": "boiled egg"})
	gotParams, gotBody, notes := NormalizeCallInput(foodCreateOp(), params, nil, fixedNow)

	if gotParams != nil {
		t.Errorf("expected all params moved into body (nil params), got %v", gotParams)
	}
	var body map[string]any
	if err := json.Unmarshal(gotBody, &body); err != nil {
		t.Fatalf("body not valid JSON: %v (%s)", err, gotBody)
	}
	for _, k := range []string{"weight", "calories", "name"} {
		if _, ok := body[k]; !ok {
			t.Errorf("body missing coalesced field %q: %s", k, gotBody)
		}
	}
	if len(notes) == 0 || !strings.Contains(strings.Join(notes, " "), "into the request body") {
		t.Errorf("expected a coalesce note, got %v", notes)
	}
}

func TestNormalizeCallInput_ResolvesRelativeDateTimestamp(t *testing.T) {
	params := rawMap(t, map[string]any{"eaten_at": "today", "weight": 100, "calories": 280, "name": "boiled egg"})
	_, gotBody, notes := NormalizeCallInput(foodCreateOp(), params, nil, fixedNow)

	var body map[string]any
	if err := json.Unmarshal(gotBody, &body); err != nil {
		t.Fatalf("body not valid JSON: %v", err)
	}
	want := fixedNow.Format(time.RFC3339)
	if body["eaten_at"] != want {
		t.Errorf("eaten_at = %v, want %q", body["eaten_at"], want)
	}
	if !strings.Contains(strings.Join(notes, " "), "resolved relative date") {
		t.Errorf("expected a date-resolution note, got %v", notes)
	}
}

func TestNormalizeCallInput_DoesNotClobberExistingBodyField(t *testing.T) {
	params := rawMap(t, map[string]any{"name": "FROM_PARAMS"})
	body := json.RawMessage(`{"name":"FROM_BODY","eaten_at":"2026-05-30T08:00:00Z","weight":50,"calories":90}`)
	_, gotBody, _ := NormalizeCallInput(foodCreateOp(), params, body, fixedNow)
	var out map[string]any
	if err := json.Unmarshal(gotBody, &out); err != nil {
		t.Fatalf("body not valid JSON: %v", err)
	}
	if out["name"] != "FROM_BODY" {
		t.Errorf("coalesce clobbered existing body field: name=%v", out["name"])
	}
}

func TestNormalizeCallInput_ReadParamDateResolves(t *testing.T) {
	// Reads still get relative-date resolution in params even with no coalescing.
	listOp := &Operation{
		ID: "food.log.list", Topic: "food", Method: "GET", Path: "/api/food/log", Risk: RiskRead,
		ParamsSchema: json.RawMessage(`{"type":"object","properties":{"date":{"type":"string","description":"YYYY-MM-DD; defaults to today"}}}`),
	}
	params := rawMap(t, map[string]any{"date": "yesterday"})
	gotParams, _, notes := NormalizeCallInput(listOp, params, nil, fixedNow)
	var got string
	if err := json.Unmarshal(gotParams["date"], &got); err != nil {
		t.Fatalf("date param not a string: %v", err)
	}
	want := fixedNow.AddDate(0, 0, -1).Format("2006-01-02")
	if got != want {
		t.Errorf("date = %q, want %q (date-only format)", got, want)
	}
	if len(notes) == 0 {
		t.Errorf("expected a resolution note")
	}
}

func TestNormalizeCallInput_NoChangeForCleanInput(t *testing.T) {
	body := json.RawMessage(`{"name":"oatmeal","eaten_at":"2026-05-31T08:00:00Z","weight":200,"calories":250}`)
	gotParams, gotBody, notes := NormalizeCallInput(foodCreateOp(), nil, body, fixedNow)
	if gotParams != nil {
		t.Errorf("expected nil params, got %v", gotParams)
	}
	if len(notes) != 0 {
		t.Errorf("expected no notes for clean input, got %v", notes)
	}
	// Body should be byte-identical (no needless re-serialization side effects).
	if string(gotBody) != string(body) {
		t.Errorf("clean body was modified: %s", gotBody)
	}
}

func TestNormalizeCallInput_NilOp(t *testing.T) {
	params := rawMap(t, map[string]any{"x": 1})
	gotParams, gotBody, notes := NormalizeCallInput(nil, params, nil, fixedNow)
	if len(gotParams) != 1 || gotBody != nil || notes != nil {
		t.Errorf("nil op should pass through unchanged: %v %s %v", gotParams, gotBody, notes)
	}
}

func TestNormalizeCallInput_ReadDoesNotCoalesce(t *testing.T) {
	// A read op must never move params into a body (it has no body).
	listOp := &Operation{
		ID: "health.bp.list", Topic: "health", Method: "GET", Path: "/api/bp", Risk: RiskRead,
		ParamsSchema: json.RawMessage(`{"type":"object","properties":{"days":{"type":"integer"}}}`),
	}
	params := rawMap(t, map[string]any{"days": 30})
	gotParams, gotBody, _ := NormalizeCallInput(listOp, params, nil, fixedNow)
	if len(gotParams) != 1 {
		t.Errorf("read params should be preserved, got %v", gotParams)
	}
	if len(gotBody) != 0 {
		t.Errorf("read should have no body, got %s", gotBody)
	}
}
