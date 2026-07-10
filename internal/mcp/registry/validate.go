package registry

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"

	"github.com/google/jsonschema-go/jsonschema"
)

// compiledSchemas holds the parsed params/body schemas for one operation.
// Parsing happens once per op id and is cached, since registry schemas are
// static after the registry is built.
type compiledSchemas struct {
	params *jsonschema.Schema
	body   *jsonschema.Schema
}

// schemaCache memoizes compiled schemas keyed by Operation.ID.
var schemaCache sync.Map // op.ID -> *compiledSchemas

func compiledFor(op *Operation) *compiledSchemas {
	if v, ok := schemaCache.Load(op.ID); ok {
		return v.(*compiledSchemas)
	}
	c := &compiledSchemas{
		params: parseSchema(op.ParamsSchema),
		body:   parseSchema(op.BodySchema),
	}
	schemaCache.Store(op.ID, c)
	return c
}

// parseSchema compiles a raw JSON Schema via jsonschema-go. A nil/empty or
// malformed schema yields nil (validation then becomes a no-op for it).
func parseSchema(raw json.RawMessage) *jsonschema.Schema {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	var s jsonschema.Schema
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil
	}
	return &s
}

// ValidateInput performs lenient, warn-only validation of caller-supplied
// params and body against an operation's JSON schemas. It returns a slice of
// human-readable warning strings (e.g. "body.systolic: expected integer, got
// string") and NEVER an error: callers attach the warnings and forward the
// request regardless.
//
// Leniency rules:
//   - report missing required fields;
//   - report wrong-typed DECLARED fields only;
//   - ignore unknown/extra fields (additionalProperties is never enforced);
//   - skip checks when a schema is absent or input can't be parsed.
//
// Returns nil when the op has no schemas or the input is valid.
func ValidateInput(op *Operation, params map[string]json.RawMessage, body json.RawMessage) []string {
	if op == nil {
		return nil
	}
	c := compiledFor(op)
	var warnings []string

	if c.params != nil {
		obj := make(map[string]json.RawMessage, len(params))
		for k, v := range params {
			obj[k] = v
		}
		warnings = append(warnings, checkObject("params", c.params, obj)...)
	}

	if c.body != nil {
		obj := map[string]json.RawMessage{}
		if len(bytes.TrimSpace(body)) > 0 {
			parsed, ok := asObject(body)
			if !ok {
				// A non-object body can't be field-checked; stay lenient.
				return warnings
			}
			obj = parsed
		}
		warnings = append(warnings, checkObject("body", c.body, obj)...)
	}
	return warnings
}

// RequiredMissing returns the labels of required-but-absent fields (e.g.
// "body.eaten_at", "params.id") for an operation, reusing the same compiled
// schemas and Required lists that checkObject walks for its warnings. Unlike
// ValidateInput it reports ONLY missing-required (not type mismatches), so
// write-op callers can block on it. Returns nil when the op is nil, has no
// schemas, or nothing is missing.
func RequiredMissing(op *Operation, params map[string]json.RawMessage, body json.RawMessage) []string {
	if op == nil {
		return nil
	}
	c := compiledFor(op)
	var missing []string

	if c.params != nil {
		obj := make(map[string]json.RawMessage, len(params))
		for k, v := range params {
			obj[k] = v
		}
		missing = append(missing, missingRequired("params", c.params, obj)...)
	}

	if c.body != nil {
		obj := map[string]json.RawMessage{}
		if len(bytes.TrimSpace(body)) > 0 {
			// A present-but-non-object body (null / array / scalar) satisfies no
			// required field, so leave obj empty and let every required body field
			// be reported. Unlike ValidateInput (warn-only, stays lenient here),
			// this is a hard gate: forwarding a `null` body would silently persist
			// a malformed record — the exact med-d5t.11 shape this block prevents.
			if parsed, ok := asObject(body); ok {
				obj = parsed
			}
		}
		missing = append(missing, missingRequired("body", c.body, obj)...)
	}
	return missing
}

// missingRequired reports required fields of schema absent from obj, labeled
// with prefix ("params" or "body").
func missingRequired(prefix string, schema *jsonschema.Schema, obj map[string]json.RawMessage) []string {
	var missing []string
	for _, req := range schema.Required {
		if _, ok := obj[req]; !ok {
			missing = append(missing, prefix+"."+req)
		}
	}
	return missing
}

// checkObject reports required-but-missing and wrong-typed declared fields of
// obj against schema. prefix labels the source ("params" or "body").
func checkObject(prefix string, schema *jsonschema.Schema, obj map[string]json.RawMessage) []string {
	var warnings []string

	for _, req := range schema.Required {
		if _, ok := obj[req]; !ok {
			warnings = append(warnings, fmt.Sprintf("%s.%s: required field missing", prefix, req))
		}
	}

	names := make([]string, 0, len(obj))
	for name := range obj {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		propSchema, declared := schema.Properties[name]
		if !declared || propSchema == nil {
			continue // ignore unknown/extra fields
		}
		expected := schemaTypes(propSchema)
		if len(expected) == 0 {
			continue // no declared type to check against
		}
		actual := jsonTypeOf(obj[name])
		if actual == "" {
			continue // unparseable value; stay lenient
		}
		if !typeMatches(actual, expected) {
			warnings = append(warnings, fmt.Sprintf("%s.%s: expected %s, got %s",
				prefix, name, strings.Join(expected, " or "), actual))
		}
	}
	return warnings
}

// schemaTypes returns the declared type(s) of a property schema, normalizing
// the mutually-exclusive Type/Types fields into a single slice.
func schemaTypes(s *jsonschema.Schema) []string {
	if s.Type != "" {
		return []string{s.Type}
	}
	return s.Types
}

// asObject decodes raw into a map of field -> raw value, reporting whether raw
// was a JSON object.
func asObject(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, false
	}
	if obj == nil {
		// JSON null decodes to a nil map; treat as "not an object".
		return nil, false
	}
	return obj, true
}

// jsonTypeOf returns the JSON Schema type name of a raw JSON value, or "" if it
// can't be parsed. Whole numbers report "integer"; fractional report "number".
func jsonTypeOf(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return ""
	}
	var v any
	if err := json.Unmarshal(trimmed, &v); err != nil {
		return ""
	}
	switch n := v.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case float64:
		if n == math.Trunc(n) {
			return "integer"
		}
		return "number"
	case string:
		return "string"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	return ""
}

// typeMatches reports whether an actual JSON type satisfies any of the expected
// schema types. A whole number ("integer") satisfies an expected "number".
func typeMatches(actual string, expected []string) bool {
	for _, e := range expected {
		if e == actual {
			return true
		}
		if e == "number" && actual == "integer" {
			return true
		}
	}
	return false
}
