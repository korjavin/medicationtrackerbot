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
	Topic       string `json:"topic"`
	OperationID string `json:"operation_id"`
}

// HelpResponse is returned by mcp_help.
type HelpResponse struct {
	Operations   []registry.HelpEntry `json:"operations"`
	Count        int                  `json:"count"`
	Topics       []string             `json:"topics,omitempty"`
	Capabilities []TopicCapability    `json:"capabilities,omitempty"`
	PythonUsage  string               `json:"python_usage,omitempty"`
	Note         string               `json:"note,omitempty"`
	NextStep     string               `json:"next_step,omitempty"`
	NextTools    []string             `json:"next_tools,omitempty"`
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
	defaultNextStep = "Pick a topic (e.g., 'workouts') or lookup an operation by ID to start building a script."
	defaultNote     = "The full operation catalog is shown below. Use mcp_execute to run any operation. Pass path_params={\"name\": \"value\"} for routes containing {placeholders} (see each operation's path_params field)."
)

func (s *Server) handleMCPHelp(ctx context.Context, req *sdkmcp.CallToolRequest, input HelpInput) (*sdkmcp.CallToolResult, HelpResponse, error) {
	if s.reg == nil {
		return nil, HelpResponse{}, fmt.Errorf("operation registry not initialized")
	}

	topic := strings.ToLower(strings.TrimSpace(input.Topic))
	opID := strings.ToLower(strings.TrimSpace(input.OperationID))

	slog.Info("[MCP] mcp_help called", "topic", topic, "operation_id", opID)

	nextStep := defaultNextStep
	if suggestion := s.reg.Suggestion(topic); suggestion != "" {
		nextStep = suggestion
	}

	// Exact operation_id lookup takes precedence.
	if opID != "" {
		op := s.reg.Get(opID)
		if op == nil {
			return nil, HelpResponse{
				Count:     0,
				Topics:    s.reg.Topics(),
				NextStep:  fmt.Sprintf("Operation %q not found. Pick a topic (e.g., 'workouts') or use a valid operation ID.", opID),
				NextTools: []string{"mcp_help"},
			}, nil
		}
		entries := registry.MarshalForHelp([]*registry.Operation{op})

		return nil, HelpResponse{
			Operations: entries,
			Count:      1,
			Note:       fmt.Sprintf("Showing details for operation %q. Use mcp_execute to run the example script.", opID),
			NextStep:   "Review the operation details and use mcp_execute to run it.",
			NextTools:  []string{"mcp_execute"},
		}, nil
	}

	// Topic filter or full catalog.
	if topic == "" || topic == "all" {
		ops := s.reg.All()
		return nil, HelpResponse{
			Operations:   registry.MarshalForHelp(ops),
			Count:        len(ops),
			Topics:       s.reg.Topics(),
			Capabilities: s.buildCapabilities(),
			Note:         defaultNote,
			NextStep:     nextStep,
			NextTools:    []string{"mcp_execute"},
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
		Note:       fmt.Sprintf("Showing %d operation(s) for topic %q. Use mcp_execute to run any of them; supply path_params for routes that contain {placeholders}.", len(ops), topic),
		NextStep:   nextStep,
		NextTools:  []string{"mcp_execute"},
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
