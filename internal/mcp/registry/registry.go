package registry

import (
	"encoding/json"
	"fmt"
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
	Path string `json:"path"`
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
}

// HelpEntry is the compact representation returned by MarshalForHelp.
//
// ParamsSchema and BodySchema are typed `any` rather than json.RawMessage so
// the MCP SDK's reflection-based output-schema inference (jsonschema-go) emits
// an unrestricted schema for them. json.RawMessage's underlying type is
// []byte, which infers to {"types": ["null", "array"]} and rejects the actual
// object payload at validation time.
type HelpEntry struct {
	ID              string `json:"id"`
	Topic           string `json:"topic"`
	Method          string `json:"method"`
	Path            string `json:"path"`
	Risk            Risk   `json:"risk"`
	Description     string `json:"description"`
	ResponseSummary string `json:"response_summary"`
	ParamsSchema    any    `json:"params_schema,omitempty"`
	BodySchema      any    `json:"body_schema,omitempty"`
	Example         string `json:"example,omitempty"`
}

// Registry holds the complete set of allowed operations.
type Registry struct {
	mu         sync.RWMutex
	operations map[string]*Operation
	byTopic    map[string][]*Operation
	topicOrder []string
}

// New returns an empty registry.
func New() *Registry {
	return &Registry{
		operations: make(map[string]*Operation),
		byTopic:    make(map[string][]*Operation),
	}
}

// Register adds one or more operations. Returns an error if any operation fails validation
// or has a duplicate ID.
func (r *Registry) Register(ops ...*Operation) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, op := range ops {
		if err := validate(op); err != nil {
			return fmt.Errorf("operation %q: %w", op.ID, err)
		}
		if _, exists := r.operations[op.ID]; exists {
			return fmt.Errorf("operation %q: duplicate ID", op.ID)
		}

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
	return r.operations[id]
}

// ByTopic returns all operations for the given topic in registration order.
// Returns nil if the topic has no operations.
func (r *Registry) ByTopic(topic string) []*Operation {
	r.mu.RLock()
	defer r.mu.RUnlock()
	ops := r.byTopic[topic]
	if len(ops) == 0 {
		return nil
	}
	result := make([]*Operation, len(ops))
	copy(result, ops)
	return result
}

// All returns all registered operations in an unspecified order.
func (r *Registry) All() []*Operation {
	r.mu.RLock()
	defer r.mu.RUnlock()
	result := make([]*Operation, 0, len(r.operations))
	for _, op := range r.operations {
		result = append(result, op)
	}
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
			trimmed := strings.TrimSpace(example)
			if !strings.HasPrefix(trimmed, "from medtracker") && !strings.HasPrefix(trimmed, "import medtracker") {
				example = "from medtracker import api, output\n\n" + example
			}
			if !strings.Contains(example, "output(") {
				example = example + "\noutput(result)"
			}
		}

		entries = append(entries, HelpEntry{
			ID:              op.ID,
			Topic:           op.Topic,
			Method:          op.Method,
			Path:            op.Path,
			Risk:            op.Risk,
			Description:     op.Description,
			ResponseSummary: op.ResponseSummary,
			ParamsSchema:    decodeSchema(op.ParamsSchema),
			BodySchema:      decodeSchema(op.BodySchema),
			Example:         example,
		})
	}
	return entries
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
		fmt.Printf("registry: failed to decode schema: %v\n", err)
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
	return nil
}
