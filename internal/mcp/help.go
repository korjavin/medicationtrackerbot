package mcp

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

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

// autoExpandThreshold is the maximum number of query matches that mcp_help
// returns as FULL operation detail (schemas + example) instead of terse compact
// rows. Small result sets are auto-expanded so an agent can go
// help(query) -> mcp_call/mcp_execute without a separate operation_id drill-in.
const autoExpandThreshold = 3

// HelpResponse is returned by mcp_help.
type HelpResponse struct {
	Operations        []registry.HelpEntry        `json:"operations,omitempty"`
	CompactOperations []registry.HelpEntryCompact `json:"compact_operations,omitempty"`
	Count             int                         `json:"count"`
	Topics            []string                    `json:"topics,omitempty"`
	Capabilities      []TopicCapability           `json:"capabilities,omitempty"`
	PythonUsage       string                      `json:"python_usage,omitempty"`
	Note              string                      `json:"note,omitempty"`
	NextStep          string                      `json:"next_step,omitempty"`
	NextTools         []string                    `json:"next_tools,omitempty"`
}

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

func (s *Server) handleMCPHelp(ctx context.Context, req *sdkmcp.CallToolRequest, input HelpInput) (*sdkmcp.CallToolResult, HelpResponse, error) {
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

	// Keyword search across id / description / topic / response_summary. Small
	// result sets (<= autoExpandThreshold) auto-expand to FULL detail so the
	// agent can go help(query) -> mcp_call/mcp_execute without a separate
	// operation_id drill-in; larger sets stay terse to keep the call token-light.
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
		if len(ops) <= autoExpandThreshold {
			return nil, HelpResponse{
				Operations: registry.MarshalForHelp(ops),
				Count:      len(ops),
				Note:       fmt.Sprintf("Showing %d full match(es) for query %q (auto-expanded to schemas + example). Run one with mcp_call (one-shot) or mcp_execute (composite).", len(ops), query),
				NextStep:   "Review the operation details, then run with mcp_call (one-shot) or mcp_execute (composite).",
				NextTools:  []string{"mcp_call", "mcp_execute"},
			}, nil
		}
		return nil, HelpResponse{
			CompactOperations: registry.MarshalForHelpCompact(ops),
			Count:             len(ops),
			Note:              fmt.Sprintf("Showing %d terse match(es) for query %q. Drill in with operation_id= for schemas + a runnable example.", len(ops), query),
			NextStep:          "Inspect a match with operation_id=, then run it with mcp_call (one-shot) or mcp_execute (composite).",
			NextTools:         []string{"mcp_help", "mcp_call"},
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
		nextStep = fmt.Sprintf("Explore the available operations for topic %q below.", topic)
	}

	return nil, HelpResponse{
		Operations: registry.MarshalForHelp(ops),
		Count:      len(ops),
		Note:       fmt.Sprintf("Showing %d full operation(s) for topic %q (schemas + example). Run one with mcp_call (one-shot) or mcp_execute (composite); supply path_params for routes that contain {placeholders}.", len(ops), topic),
		NextStep:   nextStep,
		NextTools:  []string{"mcp_call", "mcp_execute"},
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
