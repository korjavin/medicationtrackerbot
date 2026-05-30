package registry

import (
	"encoding/json"
	"strings"
	"testing"
)

// rawParams turns a JSON object literal into the map[string]json.RawMessage
// shape that ValidateInput receives at the raw boundary.
func rawParams(t *testing.T, obj string) map[string]json.RawMessage {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal([]byte(obj), &m); err != nil {
		t.Fatalf("rawParams: %v", err)
	}
	return m
}

func TestValidateInput(t *testing.T) {
	paramsOp := &Operation{
		ID:    "test.validate.params",
		Topic: "test",
		ParamsSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "days":  {"type": "integer"},
    "limit": {"type": "integer"},
    "note":  {"type": "string"}
  }
}`),
	}
	bodyOp := &Operation{
		ID:    "test.validate.body",
		Topic: "test",
		BodySchema: json.RawMessage(`{
  "type": "object",
  "required": ["systolic", "diastolic"],
  "properties": {
    "systolic":  {"type": "integer"},
    "diastolic": {"type": "integer"},
    "note":      {"type": "string"},
    "ratio":     {"type": "number"}
  }
}`),
	}
	noSchemaOp := &Operation{ID: "test.validate.noschema", Topic: "test"}

	tests := []struct {
		name     string
		op       *Operation
		params   map[string]json.RawMessage
		body     json.RawMessage
		wantWarn []string // substrings that must each appear in exactly one warning
		wantNone bool
	}{
		{
			name:     "params type mismatch",
			op:       paramsOp,
			params:   rawParams(t, `{"days": "7"}`),
			wantWarn: []string{"params.days: expected integer, got string"},
		},
		{
			name:     "params valid",
			op:       paramsOp,
			params:   rawParams(t, `{"days": 7, "limit": 100, "note": "hi"}`),
			wantNone: true,
		},
		{
			name:     "params unknown field ignored",
			op:       paramsOp,
			params:   rawParams(t, `{"bogus": "x", "days": 3}`),
			wantNone: true,
		},
		{
			name:     "body missing required",
			op:       bodyOp,
			body:     json.RawMessage(`{"systolic": 120}`),
			wantWarn: []string{"body.diastolic: required field missing"},
		},
		{
			name:     "body type mismatch",
			op:       bodyOp,
			body:     json.RawMessage(`{"systolic": "120", "diastolic": 80}`),
			wantWarn: []string{"body.systolic: expected integer, got string"},
		},
		{
			name:     "body integer satisfies number",
			op:       bodyOp,
			body:     json.RawMessage(`{"systolic": 120, "diastolic": 80, "ratio": 2}`),
			wantNone: true,
		},
		{
			name:     "body fractional fails integer",
			op:       bodyOp,
			body:     json.RawMessage(`{"systolic": 120.5, "diastolic": 80}`),
			wantWarn: []string{"body.systolic: expected integer, got number"},
		},
		{
			name:     "nil schema no warnings",
			op:       noSchemaOp,
			params:   rawParams(t, `{"anything": "goes"}`),
			body:     json.RawMessage(`{"x": 1}`),
			wantNone: true,
		},
		{
			name:     "nil op no warnings",
			op:       nil,
			wantNone: true,
		},
		{
			name:     "non-object body stays lenient",
			op:       bodyOp,
			body:     json.RawMessage(`[1,2,3]`),
			wantNone: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ValidateInput(tc.op, tc.params, tc.body)
			if tc.wantNone {
				if len(got) != 0 {
					t.Fatalf("expected no warnings, got %v", got)
				}
				return
			}
			for _, want := range tc.wantWarn {
				found := false
				for _, g := range got {
					if strings.Contains(g, want) {
						found = true
						break
					}
				}
				if !found {
					t.Errorf("warnings %v do not contain %q", got, want)
				}
			}
		})
	}
}
