package registry

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// Risk classifies how an operation mutates state.
type Risk string

const (
	RiskRead  Risk = "read"
	RiskWrite Risk = "write"
)

// Operation describes a single backend API call that the executor is allowed to make.
type Operation struct {
	// ID is a unique dot-separated identifier, e.g. "workouts.groups.list".
	ID string `json:"id"`
	// Topic is the high-level domain, e.g. "workouts", "food", "health".
	Topic string `json:"topic"`
	// Method is the HTTP method (GET, POST, PUT, DELETE).
	Method string `json:"method"`
	// Path is the backend API path, e.g. "/api/workout/groups".
	// May contain {name} placeholders, in which case PathParams must list every
	// placeholder; the bridge will substitute them at call time from
	// BridgeRequest.PathParams.
	Path string `json:"path"`
	// PathParams is the allowlist of placeholder names appearing in Path.
	// Used by the bridge to validate substitution and by mcp_help to advertise
	// what the agent must pass alongside params/body. Order is irrelevant.
	PathParams []string `json:"path_params,omitempty"`
	// Risk indicates whether the call is read-only or mutating.
	Risk Risk `json:"risk"`
	// ParamsSchema is a compact JSON Schema describing URL query parameters.
	// May be nil for operations with no params.
	ParamsSchema json.RawMessage `json:"params_schema,omitempty"`
	// BodySchema is a compact JSON Schema for the request body.
	// May be nil for read operations.
	BodySchema json.RawMessage `json:"body_schema,omitempty"`
	// ResponseSummary is a short human-readable description of what the response contains.
	ResponseSummary string `json:"response_summary"`
	// Description explains what the operation does and when to use it.
	Description string `json:"description"`
	// Example is a compact Python snippet using medtracker.api.call.
	Example string `json:"example,omitempty"`
	// ResponseExample is a small, realistic JSON sample of what the operation
	// returns. Populated for read/list/get/overview ops that feed chained
	// scripts so the agent can write correct downstream code on the first try.
	// Surfaced on drill-in (full HelpEntry) but never in the terse catalog.
	ResponseExample string `json:"response_example,omitempty"`
}

// HelpEntry is the compact representation returned by MarshalForHelp.
//
// ParamsSchema and BodySchema are typed `any` rather than json.RawMessage so
// the MCP SDK's reflection-based output-schema inference (jsonschema-go) emits
// an unrestricted schema for them. json.RawMessage's underlying type is
// []byte, which infers to {"types": ["null", "array"]} and rejects the actual
// object payload at validation time.
type HelpEntry struct {
	ID              string   `json:"id"`
	Topic           string   `json:"topic"`
	Method          string   `json:"method"`
	Path            string   `json:"path"`
	PathParams      []string `json:"path_params,omitempty"`
	Risk            Risk     `json:"risk"`
	Description     string   `json:"description"`
	ResponseSummary string   `json:"response_summary"`
	ParamsSchema    any      `json:"params_schema,omitempty"`
	BodySchema      any      `json:"body_schema,omitempty"`
	Example         string   `json:"example,omitempty"`
	ResponseExample string   `json:"response_example,omitempty"`
}

// HelpEntryCompact is the terse catalog representation returned by
// MarshalForHelpCompact. It carries only the fields needed to scan the full
// operation catalog cheaply; the agent drills into a topic or operation_id (or
// uses query search) to obtain the full HelpEntry with schemas + example.
type HelpEntryCompact struct {
	ID          string `json:"id"`
	Topic       string `json:"topic"`
	Method      string `json:"method"`
	Risk        Risk   `json:"risk"`
	Description string `json:"description"`
}

// Registry holds the complete set of allowed operations.
type Registry struct {
	mu          sync.RWMutex
	operations  map[string]*Operation
	byTopic     map[string][]*Operation
	topicOrder  []string
	suggestions map[string]string
}

// New returns an empty registry.
func New() *Registry {
	return &Registry{
		operations: make(map[string]*Operation),
		byTopic:    make(map[string][]*Operation),
		suggestions: map[string]string{
			"workouts":    "List the available workout groups to see what you can track. Run a single create/update/delete op with mcp_call; chain several edits (groups, variants, exercises, exercise libraries) in one mcp_execute script.",
			"food":        "Before logging a meal, call food.products.search (or food.products.frequent) to find a matching saved product and reuse its product_id in food.log.create — this keeps the user's history consistent. Run a single op with mcp_call, or compose search + log into one mcp_execute script. Only invent a new name when nothing matches; the server will upsert it into the user's catalog automatically.",
			"health":      "List vital logs (weight, blood pressure) to see your progress. For device-imported sleep (with light/deep/REM phases), heart rate, SpO2, stress, and steps, call health.overview — that is the source for sleep-recovery and vitals-trend analysis. Run a single health.bp.create / health.weight.create / health.notes.create with mcp_call; batch multiple readings or sleep / vitals notes in one mcp_execute script.",
			"medications": "List your medication schedule to see what is due or check specific medication details. Run a single op with mcp_call — add a medication (medications.create), update or archive one (medications.update with archived=true), restock, or snooze / skip / confirm an intake — and use mcp_execute to chain several of these in one script.",
		},
	}
}

// Register adds one or more operations. Returns an error if any operation fails validation
// or has a duplicate ID.
func (r *Registry) Register(ops ...*Operation) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	var toRegister []*Operation
	for _, opPtr := range ops {
		// Clone to avoid mutating the original struct.
		op := *opPtr

		// Normalize ID and Topic to lowercase.
		op.ID = strings.ToLower(strings.TrimSpace(op.ID))
		op.Topic = strings.ToLower(strings.TrimSpace(op.Topic))

		if err := validate(&op); err != nil {
			return fmt.Errorf("operation %q: %w", op.ID, err)
		}
		if _, exists := r.operations[op.ID]; exists {
			return fmt.Errorf("operation %q: duplicate ID", op.ID)
		}
		for _, pending := range toRegister {
			if pending.ID == op.ID {
				return fmt.Errorf("operation %q: duplicate ID in batch", op.ID)
			}
		}
		toRegister = append(toRegister, &op)
	}

	for _, op := range toRegister {
		if _, exists := r.byTopic[op.Topic]; !exists {
			r.topicOrder = append(r.topicOrder, op.Topic)
		}
		r.operations[op.ID] = op
		r.byTopic[op.Topic] = append(r.byTopic[op.Topic], op)
	}
	return nil
}

// Get returns the operation with the given ID, or nil if not found.
func (r *Registry) Get(id string) *Operation {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.operations[strings.ToLower(id)]
}

// ByTopic returns all operations for the given topic in registration order.
// Returns nil if the topic has no operations.
func (r *Registry) ByTopic(topic string) []*Operation {
	r.mu.RLock()
	defer r.mu.RUnlock()
	ops := r.byTopic[strings.ToLower(topic)]
	if len(ops) == 0 {
		return nil
	}
	result := make([]*Operation, len(ops))
	copy(result, ops)
	return result
}

// All returns all registered operations sorted by ID.
func (r *Registry) All() []*Operation {
	r.mu.RLock()
	defer r.mu.RUnlock()
	result := make([]*Operation, 0, len(r.operations))
	for _, op := range r.operations {
		result = append(result, op)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].ID < result[j].ID
	})
	return result
}

// Topics returns the distinct topic names in registration order (first seen).
func (r *Registry) Topics() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	result := make([]string, len(r.topicOrder))
	copy(result, r.topicOrder)
	return result
}

// Suggestion returns a goal-oriented next step for the given topic.
func (r *Registry) Suggestion(topic string) string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.suggestions[strings.ToLower(topic)]
}

// MarshalForHelp returns a JSON-serializable slice of HelpEntry values for the
// given set of operations. It is used by mcp_help to produce compact documentation.
//
// The stored ParamsSchema/BodySchema are json.RawMessage; they are decoded into
// generic values here so the help output is a real JSON object (not a base64
// string) and so the MCP SDK's output-schema validator accepts it.
func MarshalForHelp(ops []*Operation) []HelpEntry {
	entries := make([]HelpEntry, 0, len(ops))
	for _, op := range ops {
		example := op.Example
		if example != "" {
			lines := strings.Split(example, "\n")

			// 1. Analyze existing content (ignoring comments)
			var (
				hasImportMedtracker bool
				hasImportOutput     bool
				hasOutputCall       bool
				lastVarName         string
				lastCallLineIdx     = -1
				transformed         bool
			)

			for i, line := range lines {
				trimmed := strings.TrimSpace(line)
				if trimmed == "" || strings.HasPrefix(trimmed, "#") {
					continue
				}

				if strings.Contains(trimmed, "import medtracker") || strings.Contains(trimmed, "from medtracker") {
					hasImportMedtracker = true
				}
				if (strings.HasPrefix(trimmed, "import ") || strings.HasPrefix(trimmed, "from ")) && strings.Contains(trimmed, "output") {
					hasImportOutput = true
				}
				if strings.HasPrefix(trimmed, "output(") {
					hasOutputCall = true
				}

				// Look for api.call(...)
				// Case 1: result = api.call(...)
				if idx := strings.Index(trimmed, "= api.call("); idx > 0 {
					potentialVar := strings.TrimSpace(trimmed[:idx])
					// Basic check for valid variable name (no spaces, only alphanumeric/underscore)
					if !strings.Contains(potentialVar, " ") && potentialVar != "" {
						lastVarName = potentialVar
						lastCallLineIdx = i
						transformed = false // No transformation needed for this line
					}
				} else if strings.HasPrefix(trimmed, "api.call(") {
					// Case 2: api.call(...) at start of line
					lastVarName = "result"
					lastCallLineIdx = i
					transformed = true
				}
			}

			// 2. Patch lines for api.call transformation
			if !hasOutputCall && lastCallLineIdx >= 0 && transformed {
				lines[lastCallLineIdx] = strings.Replace(lines[lastCallLineIdx], "api.call(", "result = api.call(", 1)
			}
			example = strings.Join(lines, "\n")

			// 3. Patch imports
			if !hasImportOutput {
				// If we have "from medtracker import api", we need to change it to "from medtracker import api, output"
				if strings.Contains(example, "from medtracker import api") && !strings.Contains(example, "import api, output") {
					example = strings.Replace(example, "from medtracker import api", "from medtracker import api, output", 1)
				} else if !hasImportMedtracker {
					example = "from medtracker import api, output\n\n" + example
				} else {
					// Has medtracker but not output, and not the specific 'from' line we know how to patch.
					// Prepend a separate import.
					example = "from medtracker import output\n" + example
				}
			}

			// 4. Patch output call
			if !hasOutputCall && lastCallLineIdx >= 0 {
				example = strings.TrimRight(example, " \n\t") + "\noutput(" + lastVarName + ")"
			}
		}

		entries = append(entries, HelpEntry{
			ID:              op.ID,
			Topic:           op.Topic,
			Method:          op.Method,
			Path:            op.Path,
			PathParams:      append([]string(nil), op.PathParams...),
			Risk:            op.Risk,
			Description:     op.Description,
			ResponseSummary: op.ResponseSummary,
			ParamsSchema:    decodeSchema(op.ParamsSchema),
			BodySchema:      decodeSchema(op.BodySchema),
			Example:         example,
			ResponseExample: op.ResponseExample,
		})
	}
	return entries
}

// MarshalForHelpCompact returns a terse catalog entry per operation: only ID,
// Topic, Method, Risk, and Description — no schemas, no example, no path. It
// powers the full-catalog and query-search views of mcp_help, keeping those
// token-light while topic/operation_id drill-ins keep returning full detail
// via MarshalForHelp.
func MarshalForHelpCompact(ops []*Operation) []HelpEntryCompact {
	entries := make([]HelpEntryCompact, 0, len(ops))
	for _, op := range ops {
		entries = append(entries, HelpEntryCompact{
			ID:          op.ID,
			Topic:       op.Topic,
			Method:      op.Method,
			Risk:        op.Risk,
			Description: op.Description,
		})
	}
	return entries
}

// Search returns operations whose ID, Description, Topic, or ResponseSummary
// contains query as a case-insensitive substring, sorted by ID (same ordering
// as All). An empty or whitespace-only query returns nil.
func (r *Registry) Search(query string) []*Operation {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()

	// Primary: whole-phrase substring match across id/description/topic/summary.
	// Precise and stable — this is what single-keyword queries hit, and it
	// preserves the help auto-expand threshold semantics.
	var result []*Operation
	for _, op := range r.operations {
		if strings.Contains(strings.ToLower(op.ID), q) ||
			strings.Contains(strings.ToLower(op.Description), q) ||
			strings.Contains(strings.ToLower(op.Topic), q) ||
			strings.Contains(strings.ToLower(op.ResponseSummary), q) {
			result = append(result, op)
		}
	}
	if len(result) > 0 {
		sort.Slice(result, func(i, j int) bool {
			return result[i].ID < result[j].ID
		})
		return result
	}

	// Fallback: only when the phrase matched nothing. Tokenize and OR-match,
	// ranking by how many distinct query tokens an op hits. This rescues natural
	// multi-word queries ("first workout group exercises") from a zero-result
	// dead-end — observed to make weaker agents give up instead of drilling in.
	// A query with 2+ meaningful tokens must hit at least 2 of them on the same
	// op, so one common word (e.g. "operation") can't drag in the whole catalog.
	tokens := searchTokens(q)
	if len(tokens) == 0 {
		return nil
	}
	minScore := 1
	if len(tokens) >= 2 {
		minScore = 2
	}
	type scored struct {
		op    *Operation
		score int
	}
	var ranked []scored
	for _, op := range r.operations {
		hay := strings.ToLower(op.ID + " " + op.Topic + " " + op.Description + " " + op.ResponseSummary)
		score := 0
		for _, tok := range tokens {
			if strings.Contains(hay, tok) {
				score++
			}
		}
		if score >= minScore {
			ranked = append(ranked, scored{op, score})
		}
	}
	sort.Slice(ranked, func(i, j int) bool {
		if ranked[i].score != ranked[j].score {
			return ranked[i].score > ranked[j].score
		}
		return ranked[i].op.ID < ranked[j].op.ID
	})
	out := make([]*Operation, len(ranked))
	for i, s := range ranked {
		out[i] = s.op
	}
	return out
}

// searchStopwords are generic filler tokens dropped from the multi-word search
// fallback so they neither dilute ranking nor match on their own.
var searchStopwords = map[string]bool{
	"the": true, "and": true, "for": true, "are": true, "was": true,
	"what": true, "that": true, "with": true, "your": true, "you": true,
	"how": true, "can": true, "from": true, "this": true, "all": true,
	"any": true, "give": true, "show": true, "tell": true, "does": true,
}

var searchTokenRe = regexp.MustCompile(`[a-z0-9]+`)

// searchTokens lowercases, splits on non-alphanumerics, and drops very short
// tokens (<3 chars) and stopwords, deduplicating the rest.
func searchTokens(q string) []string {
	seen := map[string]bool{}
	var out []string
	for _, tok := range searchTokenRe.FindAllString(strings.ToLower(q), -1) {
		if len(tok) < 3 || searchStopwords[tok] || seen[tok] {
			continue
		}
		seen[tok] = true
		out = append(out, tok)
	}
	return out
}

// decodeSchema returns the JSON-decoded schema or nil if raw is empty or
// malformed. A malformed schema is silently dropped — schema validity is
// enforced separately by tests (schemasParse).
func decodeSchema(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		slog.Error("registry: failed to decode schema", "error", err)
		return nil
	}
	return v
}

// DefaultOperations returns every operation defined across the registry's
// per-topic files. Used by the MCP server bootstrap and by tests that need a
// representative registry.
func DefaultOperations() []*Operation {
	var ops []*Operation
	ops = append(ops, WorkoutOperations()...)
	ops = append(ops, FoodOperations()...)
	ops = append(ops, HealthOperations()...)
	ops = append(ops, MedicationOperations()...)
	return ops
}

func validate(op *Operation) error {
	if op.ID == "" {
		return fmt.Errorf("id must be non-empty")
	}
	if op.Topic == "" {
		return fmt.Errorf("topic must be non-empty")
	}
	if op.Method == "" {
		return fmt.Errorf("method must be non-empty")
	}
	if op.Path == "" {
		return fmt.Errorf("path must be non-empty")
	}
	if op.Risk != RiskRead && op.Risk != RiskWrite {
		return fmt.Errorf("risk must be %q or %q, got %q", RiskRead, RiskWrite, op.Risk)
	}
	placeholders := ExtractPathPlaceholders(op.Path)
	declared := map[string]bool{}
	for _, name := range op.PathParams {
		if !pathParamNameRe.MatchString(name) {
			return fmt.Errorf("path_params name %q must match %s", name, pathParamNameRe)
		}
		if declared[name] {
			return fmt.Errorf("path_params duplicate name %q", name)
		}
		declared[name] = true
	}
	for _, ph := range placeholders {
		if !declared[ph] {
			return fmt.Errorf("path placeholder {%s} not listed in path_params", ph)
		}
	}
	for name := range declared {
		found := false
		for _, ph := range placeholders {
			if ph == name {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("path_params %q has no {%s} placeholder in path", name, name)
		}
	}
	return nil
}

// pathParamNameRe restricts placeholder names to lowercase ASCII letters,
// digits and underscore. This matches Go's net/http {name} pattern grammar
// and keeps substitution unambiguous.
var pathParamNameRe = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// pathPlaceholderRe matches {name} segments in a registered Operation.Path.
var pathPlaceholderRe = regexp.MustCompile(`\{([a-z][a-z0-9_]*)\}`)

// ExtractPathPlaceholders returns the placeholder names (without braces) found
// in path, in order of appearance. Duplicates are kept.
func ExtractPathPlaceholders(path string) []string {
	matches := pathPlaceholderRe.FindAllStringSubmatch(path, -1)
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		out = append(out, m[1])
	}
	return out
}

// SubstitutePath replaces {name} placeholders in path using values, returning
// the substituted path. It enforces:
//   - every placeholder declared in allowed must have a value in values;
//   - every key in values must appear in allowed;
//   - values are URL-path-escaped to prevent traversal/injection (so a value
//     of "1/2" is encoded, not interpreted as a sub-path).
//
// Values must be non-empty strings. The bridge calls this before forwarding
// to the internal mux; help/proxy reuse it for symmetry.
func SubstitutePath(path string, allowed []string, values map[string]string) (string, error) {
	allowedSet := make(map[string]bool, len(allowed))
	for _, name := range allowed {
		allowedSet[name] = true
	}
	for k := range values {
		if !allowedSet[k] {
			return "", fmt.Errorf("unknown path_param %q", k)
		}
	}
	for _, name := range allowed {
		v, ok := values[name]
		if !ok || v == "" {
			return "", fmt.Errorf("missing path_param %q", name)
		}
	}
	out := pathPlaceholderRe.ReplaceAllStringFunc(path, func(token string) string {
		name := token[1 : len(token)-1]
		return url.PathEscape(values[name])
	})
	return out, nil
}
