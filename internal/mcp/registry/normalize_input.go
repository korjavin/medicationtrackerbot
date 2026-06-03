package registry

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

// relativeDateTokens maps recognized relative-date keywords (lowercased, after
// trimming) to a whole-day offset from "now". These are resolved server-side so
// a tool-only agent that has no clock can pass "today"/"now" in a timestamp
// field instead of inventing a (frequently wrong) literal date — a failure mode
// observed with weaker models, which write the literal string "today" into an
// RFC3339 field and get a 400. Mirrors the current_time hint mcp_help stamps.
var relativeDateTokens = map[string]int{
	"now":       0,
	"today":     0,
	"yesterday": -1,
	"tomorrow":  1,
}

// NormalizeCallInput repairs two common agent mistakes on the mcp_call path,
// returning possibly-adjusted params/body plus human-readable notes describing
// every change it made. The notes are surfaced to the agent as warnings so the
// repair is observable, never silent. It NEVER blocks: anything it can't
// confidently repair is left untouched (and still produces a warn-only schema
// warning downstream).
//
//  1. Misplaced body fields. For a write operation with a body schema, any
//     param whose key is a declared body-schema property is moved into the body
//     (without overwriting a value the body already carries). Weaker models
//     routinely put a write's fields in params instead of body, which the bridge
//     forwards as an empty body → "Invalid JSON" 400.
//  2. Relative dates. A timestamp/date field (detected from its schema) whose
//     value is a relative token is resolved against now: RFC3339 (UTC) for a
//     full-timestamp field, YYYY-MM-DD for a date-only field.
//
// op may be nil (unknown operation); the input is then returned unchanged.
func NormalizeCallInput(op *Operation, params map[string]json.RawMessage, body json.RawMessage, now time.Time) (map[string]json.RawMessage, json.RawMessage, []string) {
	if op == nil {
		return params, body, nil
	}

	var notes []string

	// Work on a copy of params so callers' maps aren't mutated.
	outParams := make(map[string]json.RawMessage, len(params))
	for k, v := range params {
		outParams[k] = v
	}

	// 0. Unwrap a double-encoded ("stringified") body. Weaker models routinely
	//    serialize the WHOLE request body as a JSON string
	//    (body = "{\"description\":\"...\"}") instead of a JSON object
	//    (body = {"description":"..."}). The bridge forwards that quoted string
	//    verbatim and the backend's struct decode fails with an "Invalid JSON"
	//    400. If the body is a JSON string whose contents are themselves a JSON
	//    object/array, peel the string layer(s) so the coalescing/date steps
	//    below — and the backend — see the structured body the agent meant.
	if unwrapped, ok := unwrapStringBody(body); ok {
		body = unwrapped
		notes = append(notes, fmt.Sprintf(
			"unwrapped a stringified JSON request body for operation %q — pass body as a JSON object (e.g. {\"k\":\"v\"}), not a JSON-encoded string (\"{\\\"k\\\":\\\"v\\\"}\")", op.ID))
	}

	// Decode the body into an object if it is one. An empty body counts as an
	// empty object we may fill via coalescing; a non-object body (array/scalar)
	// is left entirely untouched.
	bodyObj := map[string]json.RawMessage{}
	bodyIsObject := false
	if len(bytes.TrimSpace(body)) == 0 || string(bytes.TrimSpace(body)) == "null" {
		bodyIsObject = true
	} else if obj, ok := asObject(body); ok {
		bodyObj = obj
		bodyIsObject = true
	}

	bodyProps := schemaProps(op.BodySchema)
	paramProps := schemaProps(op.ParamsSchema)

	// 1. Coalesce misplaced body fields from params -> body (writes only).
	if op.Risk == RiskWrite && len(bodyProps) > 0 && bodyIsObject {
		var moved []string
		for _, k := range sortedKeys(outParams) {
			if _, isBodyProp := bodyProps[k]; !isBodyProp {
				continue // not a body field for this op; leave it (will warn)
			}
			if _, exists := bodyObj[k]; exists {
				continue // body already has a value; don't clobber
			}
			bodyObj[k] = outParams[k]
			delete(outParams, k)
			moved = append(moved, k)
		}
		if len(moved) > 0 {
			notes = append(notes, fmt.Sprintf(
				"moved %s from params into the request body — these are body fields for write operation %q (params is for URL query values only)",
				strings.Join(moved, ", "), op.ID))
		}
	}

	// 2. Resolve relative-date tokens in the body's date/timestamp fields.
	bodyChanged := false
	if bodyIsObject {
		for _, name := range sortedKeys(bodyObj) {
			prop, declared := bodyProps[name]
			if !declared || !isDateField(name, prop) {
				continue
			}
			if newRaw, oldStr, newStr, ok := resolveRelativeDate(bodyObj[name], isDateOnly(prop), now); ok {
				bodyObj[name] = newRaw
				bodyChanged = true
				notes = append(notes, fmt.Sprintf("resolved relative date body.%s=%q to %q using the server clock", name, oldStr, newStr))
			}
		}
	}

	// 3. Resolve relative-date tokens in query params too (helps read ops like
	//    food.log.list with date="today").
	for _, name := range sortedKeys(outParams) {
		prop, declared := paramProps[name]
		if !declared || !isDateField(name, prop) {
			continue
		}
		if newRaw, oldStr, newStr, ok := resolveRelativeDate(outParams[name], isDateOnly(prop), now); ok {
			outParams[name] = newRaw
			notes = append(notes, fmt.Sprintf("resolved relative date params.%s=%q to %q using the server clock", name, oldStr, newStr))
		}
	}

	// Re-serialize the body only if it changed (coalesced or date-resolved) and
	// is a non-empty object. Leaving an originally-empty body empty avoids
	// sending "{}" to handlers that distinguish absent from empty bodies.
	outBody := body
	if bodyIsObject && (bodyChanged || len(notes) > 0) && len(bodyObj) > 0 {
		if encoded, err := json.Marshal(bodyObj); err == nil {
			outBody = encoded
		}
	}

	if len(outParams) == 0 {
		outParams = nil
	}
	return outParams, outBody, notes
}

// unwrapStringBody detects a request body that was double-encoded as a JSON
// string — a common weak-model mistake where the agent stringifies the whole
// body ("{\"description\":\"...\"}") instead of passing a JSON object. It peels
// up to a few string layers and returns the wrapped value when it resolves to a
// JSON object or array. Returns ok=false (and no value) when the body is not a
// JSON string, or when the wrapped content is a scalar (so unwrapping wouldn't
// yield a structured body worth repairing). The peel cap bounds pathological
// inputs; one layer covers the observed failure, the rest catch the rare
// double-stringify.
func unwrapStringBody(body json.RawMessage) (json.RawMessage, bool) {
	cur := bytes.TrimSpace(body)
	peeled := 0
	for peeled < 4 {
		var s string
		if err := json.Unmarshal(cur, &s); err != nil {
			break // not a JSON string at this layer; stop peeling
		}
		cur = bytes.TrimSpace([]byte(s))
		peeled++
	}
	if peeled == 0 {
		return nil, false // body was never a JSON string
	}
	if len(cur) > 0 && (cur[0] == '{' || cur[0] == '[') && json.Valid(cur) {
		return cur, true
	}
	return nil, false
}

// schemaProps decodes the "properties" map of a JSON schema into name -> propInfo.
// Returns nil for an empty/malformed schema.
func schemaProps(raw json.RawMessage) map[string]propInfo {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	var s struct {
		Properties map[string]struct {
			Description string          `json:"description"`
			Type        json.RawMessage `json:"type"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil
	}
	out := make(map[string]propInfo, len(s.Properties))
	for name, p := range s.Properties {
		out[name] = propInfo{description: p.Description}
	}
	return out
}

// propInfo carries the bits of a property schema the normalizer needs.
type propInfo struct {
	description string
}

// dateFieldNameRe-style detection without a regexp: a field is a date/timestamp
// field if its name looks temporal or its description names a date format.
func isDateField(name string, p propInfo) bool {
	ln := strings.ToLower(name)
	if strings.HasSuffix(ln, "_at") || ln == "date" || ln == "from" || ln == "to" {
		return true
	}
	d := strings.ToLower(p.description)
	for _, kw := range []string{"rfc3339", "iso8601", "iso 8601", "yyyy-mm-dd", "timestamp"} {
		if strings.Contains(d, kw) {
			return true
		}
	}
	return false
}

// isDateOnly reports whether a date field expects a bare calendar day
// (YYYY-MM-DD) rather than a full timestamp.
func isDateOnly(p propInfo) bool {
	d := strings.ToLower(p.description)
	hasDay := strings.Contains(d, "yyyy-mm-dd")
	hasTime := strings.Contains(d, "rfc3339") || strings.Contains(d, "iso8601") ||
		strings.Contains(d, "iso 8601") || strings.Contains(d, "timestamp")
	return hasDay && !hasTime
}

// resolveRelativeDate replaces a relative-date token JSON string with a concrete
// value. It returns ok=false (and no change) unless raw is a JSON string equal
// to a recognized token. dateOnly selects YYYY-MM-DD vs RFC3339 output.
func resolveRelativeDate(raw json.RawMessage, dateOnly bool, now time.Time) (newRaw json.RawMessage, oldStr, newStr string, ok bool) {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, "", "", false // not a JSON string
	}
	offset, found := relativeDateTokens[strings.ToLower(strings.TrimSpace(s))]
	if !found {
		return nil, "", "", false
	}
	t := now.AddDate(0, 0, offset)
	if dateOnly {
		newStr = t.UTC().Format("2006-01-02")
	} else {
		newStr = t.UTC().Format(time.RFC3339)
	}
	encoded, err := json.Marshal(newStr)
	if err != nil {
		return nil, "", "", false
	}
	return encoded, s, newStr, true
}

// sortedKeys returns the keys of a raw-JSON map in deterministic order so the
// normalizer's notes and field-moves are stable across runs.
func sortedKeys(m map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
