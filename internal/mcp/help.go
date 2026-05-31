package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/mcp/registry"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

// HelpInput is the input for the mcp_help tool.
type HelpInput struct {
	Topic        string   `json:"topic"`
	OperationID  string   `json:"operation_id"`
	OperationIDs []string `json:"operation_ids"`
	Query        string   `json:"query"`
}

// HelpResponse is returned by mcp_help.
type HelpResponse struct {
	Operations        []registry.HelpEntry        `json:"operations,omitempty"`
	CompactOperations []registry.HelpEntryCompact `json:"compact_operations,omitempty"`
	Count             int                         `json:"count"`
	Topics            []string                    `json:"topics,omitempty"`
	Capabilities      []TopicCapability           `json:"capabilities,omitempty"`
	UsageProtocol     string                      `json:"usage_protocol,omitempty"`
	CurrentTime       string                      `json:"current_time,omitempty"`
	Note              string                      `json:"note,omitempty"`
	NextStep          string                      `json:"next_step,omitempty"`
	NextTools         []string                    `json:"next_tools,omitempty"`
}

// currentTimeHint is the real current date/time the agent should use to resolve
// relative dates ("today", "now", "yesterday", "last N days") instead of
// guessing the year — a frequent failure mode for tool-only agents that have no
// other clock. Stamped on every mcp_help response and the mcp://catalog
// resource. UTC keeps it operation-agnostic; operations re-interpret the
// calendar day in the user's stored timezone when day-precision matters.
func currentTimeHint() string {
	now := time.Now().UTC()
	return now.Format("2006-01-02T15:04:05Z07:00") + " (" + now.Weekday().String() + ", UTC)"
}

// usageProtocol is the stable, self-contained decision rule the agent should
// follow on the MCP surface. It is embedded in the no-arg/full-catalog mcp_help
// response (guaranteed reach for tool-only clients) and mirrored in the
// mcp://catalog resource (zero round-trip for preloading clients).
const usageProtocol = "Decision rule: (1) Discover — call mcp_help with no args (or topic=/query=) to scan the catalog, then drill in with operation_id=/operation_ids=[...] for full schemas + a runnable example. (2) Run ONE operation — use mcp_call(operation_id, params, path_params, body). (3) Run MULTIPLE steps (loops, joins, or deriving a value from many rows) — write an mcp_execute Python script. Computing a precise or aggregate value (average, sum, count, min/max, grouping) or joining several operations is ALWAYS step (3): do the math inside the script and output() it — do NOT fetch rows with mcp_call and add them up by hand. " +
	"Rules: an mcp_execute script MUST call output(value) exactly once (zero or multiple calls abort the run). Params are passed as a query-string object (params={...}); placeholders like {id} in an operation's route go in path_params={...}, not params. Writes require mode='write' AND a one-sentence intent. Timestamps use the user's stored timezone unless an operation accepts an explicit tz/tz_offset; for relative dates ('today', 'now', 'yesterday', 'last N days') use this response's current_time as the real clock — never guess the date or year. " +
	"Resolving references: when the user names an item by position or recency ('first', 'next', 'last', 'latest', 'most recent', 'Nth', 'top'), it means the element at that index in the order the matching list operation returns — read the list, then act on that exact element. Do NOT re-rank by importance/size or substitute a different one you think is more 'primary'. 'First X' = the first row of X's list; 'most recent X' = the newest row of X's list. " +
	"Safety & finishing: there is NO bulk-delete or 'wipe/erase everything' operation — destructive ops only delete one record at a time by id. Before any destructive write (delete/archive/overwrite), and ALWAYS before one that would touch many records, STOP and ask the user to confirm, stating exactly what will be changed; do not improvise a long sequence of deletes to fake a bulk wipe. If a request can't be satisfied with the available operations, or is ambiguous (which item? what change?), ask ONE clarifying question instead of guessing. End every turn with a brief plain-text reply to the user (the answer, the confirmation question, or the limitation) — never stop after tool calls without replying."

// TopicCapability is a per-topic summary the agent can scan before drilling
// into a specific topic. It tells the agent how many read vs write operations
// exist and gives a one-line, action-oriented hint of what the topic covers,
// so an agent looking for "can I create a medication?" doesn't have to read
// every operation entry to find out.
type TopicCapability struct {
	Topic       string `json:"topic"`
	ReadCount   int    `json:"read_count"`
	WriteCount  int    `json:"write_count"`
	Suggestion  string `json:"suggestion"`
	SampleWrite string `json:"sample_write,omitempty"`
}

const (
	defaultNextStep = "Pick a topic (e.g., 'workouts'), look up an operation by ID, or pass query='blood pressure' to keyword-search."
	defaultNote     = "The full operation catalog is shown below in terse form (id, topic, method, risk, description). Drill in with topic='workouts' or operation_id='workouts.groups.list' for params/body schemas + a runnable example, or pass query='blood pressure' to keyword-search. Run a single operation with mcp_call; compose multiple in an mcp_execute script. Pass path_params={\"name\": \"value\"} for routes containing {placeholders}."
)

// handleMCPHelp is the registered tool handler. It delegates to buildHelp and
// then stamps current_time on every successful response so the agent always has
// a real clock for resolving relative dates, regardless of which mcp_help
// variant (catalog / topic / query / operation_id drill-in) it called.
func (s *Server) handleMCPHelp(ctx context.Context, req *sdkmcp.CallToolRequest, input HelpInput) (*sdkmcp.CallToolResult, HelpResponse, error) {
	res, resp, err := s.buildHelp(ctx, req, input)
	if err == nil {
		resp.CurrentTime = currentTimeHint()
	}
	return res, resp, err
}

func (s *Server) buildHelp(ctx context.Context, req *sdkmcp.CallToolRequest, input HelpInput) (*sdkmcp.CallToolResult, HelpResponse, error) {
	if s.reg == nil {
		return nil, HelpResponse{}, fmt.Errorf("operation registry not initialized")
	}

	topic := strings.ToLower(strings.TrimSpace(input.Topic))
	opID := strings.ToLower(strings.TrimSpace(input.OperationID))
	query := strings.TrimSpace(input.Query)

	slog.Info("[MCP] mcp_help called", "topic", topic, "operation_id", opID, "query", query)

	nextStep := defaultNextStep
	if suggestion := s.reg.Suggestion(topic); suggestion != "" {
		nextStep = suggestion
	}

	// Batch / single operation lookup takes precedence (ids > query > topic >
	// catalog): return FULL schema detail for every requested id. operation_id
	// and operation_ids are merged so an agent can fetch the 2-3 ops it intends
	// to chain in one read.
	ids := make([]string, 0, len(input.OperationIDs)+1)
	if opID != "" {
		ids = append(ids, opID)
	}
	for _, raw := range input.OperationIDs {
		if id := strings.ToLower(strings.TrimSpace(raw)); id != "" {
			ids = append(ids, id)
		}
	}
	if len(ids) > 0 {
		var ops []*registry.Operation
		var missing []string
		for _, id := range ids {
			if op := s.reg.Get(id); op != nil {
				ops = append(ops, op)
			} else {
				missing = append(missing, id)
			}
		}
		if len(ops) == 0 {
			return nil, HelpResponse{
				Count:     0,
				Topics:    s.reg.Topics(),
				NextStep:  fmt.Sprintf("Operation %q not found. Pick a topic (e.g., 'workouts') or use a valid operation ID.", strings.Join(missing, ", ")),
				NextTools: []string{"mcp_help"},
			}, nil
		}
		note := fmt.Sprintf("Showing full details for %d operation(s). Run one with mcp_call (one-shot), or compose several in an mcp_execute script.", len(ops))
		if len(missing) > 0 {
			note += fmt.Sprintf(" Not found: %s.", strings.Join(missing, ", "))
		}
		return nil, HelpResponse{
			Operations: registry.MarshalForHelp(ops),
			Count:      len(ops),
			Note:       note,
			NextStep:   "Review the operation details, then run with mcp_call (one-shot) or mcp_execute (composite).",
			NextTools:  []string{"mcp_call", "mcp_execute"},
		}, nil
	}

	// Keyword search across id / description / topic / response_summary. Matches
	// are returned as a flat compact list (never auto-expanded to full nested
	// schemas) so the agent can go help(query) -> mcp_call/mcp_execute; full
	// schemas + an example come only from an operation_id drill-in.
	if query != "" {
		ops := s.reg.Search(query)
		if len(ops) == 0 {
			return nil, HelpResponse{
				Count:     0,
				Topics:    s.reg.Topics(),
				Note:      fmt.Sprintf("No operations matched query %q.", query),
				NextStep:  "No matches. Try a broader keyword, browse a topic from the list below, or omit all filters for the full catalog.",
				NextTools: []string{"mcp_help"},
			}, nil
		}
		// Compact (flat) matches — never auto-expanded to full nested schemas.
		// Discovery stays a flat list so weaker reasoning models act on it instead
		// of stalling on nested per-op schemas (measured: qwen3.5-9b emits an empty
		// turn when a query returns full body_schemas, but calls mcp_call when the
		// same matches come back compact). Each compact write entry already carries
		// its Required field names, so a write is formable straight from here; drill
		// in with operation_id for a single op's full schema + example.
		return nil, HelpResponse{
			CompactOperations: registry.MarshalForHelpCompact(ops),
			Count:             len(ops),
			Note:              fmt.Sprintf("Showing %d match(es) for query %q. These are OPERATIONS you can run, NOT the data itself — re-running the same search makes no progress.", len(ops), query),
			NextStep:          fmt.Sprintf("ACT NOW — don't search again: call mcp_call(operation_id=%q, …) (or pick whichever id above matches the request) for a single read/write (writes need mode=\"write\" + a one-sentence intent), or mcp_execute for multi-step math. If the answer needs the newest/Nth item, list first, then act on that exact element. Need a field's exact type? Fetch mcp_help(operation_id=…) for the full schema.", ops[0].ID),
			NextTools:         []string{"mcp_call", "mcp_execute"},
		}, nil
	}

	// Topic filter or full catalog.
	if topic == "" || topic == "all" {
		ops := s.reg.All()
		return nil, HelpResponse{
			CompactOperations: registry.MarshalForHelpCompact(ops),
			Count:             len(ops),
			Topics:            s.reg.Topics(),
			Capabilities:      s.buildCapabilities(),
			UsageProtocol:     usageProtocol,
			Note:              defaultNote,
			NextStep:          nextStep,
			NextTools:         []string{"mcp_call", "mcp_execute"},
		}, nil
	}

	ops := s.reg.ByTopic(topic)
	if ops == nil {
		return nil, HelpResponse{
			Count:     0,
			Topics:    s.reg.Topics(),
			NextStep:  fmt.Sprintf("Topic %q not found. Try one of the available topics listed below.", topic),
			NextTools: []string{"mcp_execute"},
		}, nil
	}

	// If the topic is valid but we don't have a specific suggestion, use a generic one.
	if nextStep == defaultNextStep {
		nextStep = fmt.Sprintf("Explore the available operations for topic %q, then act with mcp_call.", topic)
	}

	// Compact, not full: a topic can hold dozens of operations, and returning each
	// as a full nested schema is exactly what stalls weaker reasoning models (a
	// 40-op workouts topic in full detail made qwen3.5-9b emit an empty turn). The
	// flat entries carry path_params + required write fields; drill in with
	// operation_id for one op's full schema + example.
	return nil, HelpResponse{
		CompactOperations: registry.MarshalForHelpCompact(ops),
		Count:             len(ops),
		Note:              fmt.Sprintf("Showing %d operation(s) for topic %q (terse: id · method · risk · description, plus required input fields). Drill in with operation_id for full schemas + an example.", len(ops), topic),
		NextStep:          nextStep,
		NextTools:         []string{"mcp_call", "mcp_execute"},
	}, nil
}

// buildCapabilities scans the registry once and returns a per-topic summary
// (read/write counts + suggestion + one sample write op id) that the agent
// can use to answer "what can I do here" without reading every entry.
func (s *Server) buildCapabilities() []TopicCapability {
	topics := s.reg.Topics()
	out := make([]TopicCapability, 0, len(topics))
	for _, t := range topics {
		ops := s.reg.ByTopic(t)
		var read, write int
		var sampleWrite string
		for _, op := range ops {
			if op.Risk == registry.RiskWrite {
				write++
				if sampleWrite == "" {
					sampleWrite = op.ID
				}
			} else {
				read++
			}
		}
		out = append(out, TopicCapability{
			Topic:       t,
			ReadCount:   read,
			WriteCount:  write,
			Suggestion:  s.reg.Suggestion(t),
			SampleWrite: sampleWrite,
		})
	}
	return out
}

// catalogResourceURI is the stable URI of the preloadable operation catalog.
const catalogResourceURI = "mcp://catalog"

// CatalogResource is the JSON payload served by the mcp://catalog resource (and
// mirrored by no-arg mcp_help): the usage protocol plus the terse catalog of all
// operations, the topic list, and per-topic capabilities.
type CatalogResource struct {
	UsageProtocol     string                      `json:"usage_protocol"`
	CurrentTime       string                      `json:"current_time"`
	Topics            []string                    `json:"topics"`
	Capabilities      []TopicCapability           `json:"capabilities"`
	CompactOperations []registry.HelpEntryCompact `json:"compact_operations"`
}

// buildCatalogResource assembles the catalog payload from the registry. Shared
// by the resource handler and exercised directly in tests.
func (s *Server) buildCatalogResource() CatalogResource {
	return CatalogResource{
		UsageProtocol:     usageProtocol,
		CurrentTime:       currentTimeHint(),
		Topics:            s.reg.Topics(),
		Capabilities:      s.buildCapabilities(),
		CompactOperations: registry.MarshalForHelpCompact(s.reg.All()),
	}
}

// handleCatalogResource serves the mcp://catalog resource: a JSON document with
// the usage protocol + terse operation catalog so preloading clients can skip
// the first mcp_help scan round-trip.
func (s *Server) handleCatalogResource(ctx context.Context, req *sdkmcp.ReadResourceRequest) (*sdkmcp.ReadResourceResult, error) {
	if s.reg == nil {
		return nil, fmt.Errorf("operation registry not initialized")
	}
	payload, err := json.Marshal(s.buildCatalogResource())
	if err != nil {
		return nil, fmt.Errorf("marshal catalog resource: %w", err)
	}
	return &sdkmcp.ReadResourceResult{
		Contents: []*sdkmcp.ResourceContents{{
			URI:      catalogResourceURI,
			MIMEType: "application/json",
			Text:     string(payload),
		}},
	}, nil
}
