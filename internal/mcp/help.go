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
	Operations  []registry.HelpEntry `json:"operations"`
	Count       int                  `json:"count"`
	Topics      []string             `json:"topics,omitempty"`
	PythonUsage string               `json:"python_usage,omitempty"`
	Note        string               `json:"note,omitempty"`
	NextStep    string               `json:"next_step,omitempty"`
	NextTools   []string             `json:"next_tools,omitempty"`
}

const pythonUsageSnippet = `from medtracker import api, output

# Call an operation:
result = api.call("workouts.groups.list")
output(result)

# With params:
result = api.call("workouts.sessions.list", params={"limit": 10})
output(result)`

func (s *Server) handleMCPHelp(ctx context.Context, req *sdkmcp.CallToolRequest, input HelpInput) (*sdkmcp.CallToolResult, HelpResponse, error) {
	if s.reg == nil {
		return nil, HelpResponse{}, fmt.Errorf("operation registry not initialized")
	}

	topic := strings.TrimSpace(input.Topic)
	opID := strings.TrimSpace(input.OperationID)

	slog.Info("[MCP] mcp_help called", "topic", topic, "operation_id", opID)

	// Goal-oriented suggestions.
	suggestions := map[string]string{
		"workouts":    "List the available workout groups to see what you can track.",
		"food":        "Search for a food item or list recent logs to see your nutrition summary.",
		"health":      "List vital logs (weight, blood pressure) to see your progress.",
		"medications": "List your medication schedule to see what is due or check specific medication details.",
	}

	nextStep := "Pick a topic (e.g., 'workouts') or lookup an operation by ID to start building a script."
	if s, ok := suggestions[topic]; ok {
		nextStep = s
	}

	// Exact operation_id lookup takes precedence.
	if opID != "" {
		op := s.reg.Get(opID)
		if op == nil {
			return nil, HelpResponse{}, fmt.Errorf("operation %q not found", opID)
		}
		entries := registry.MarshalForHelp([]*registry.Operation{op})

		// Use topic suggestion if possible even for exact ID lookup.
		if s, ok := suggestions[op.Topic]; ok {
			nextStep = s
		}

		return nil, HelpResponse{
			Operations:  entries,
			Count:       1,
			PythonUsage: pythonUsageSnippet,
			NextStep:    nextStep,
			NextTools:   []string{"mcp_execute"},
		}, nil
	}

	// Topic filter or full catalog.
	if topic == "" || topic == "all" {
		ops := s.reg.All()
		return nil, HelpResponse{
			Operations:  registry.MarshalForHelp(ops),
			Count:       len(ops),
			Topics:      s.reg.Topics(),
			PythonUsage: pythonUsageSnippet,
			Note:        "Pick a topic to filter operations, or lookup by ID. Use mcp_execute to run scripts.",
			NextStep:    nextStep,
			NextTools:   []string{"mcp_execute"},
		}, nil
	}

	ops := s.reg.ByTopic(topic)
	if ops == nil {
		available := strings.Join(s.reg.Topics(), ", ")
		return nil, HelpResponse{}, fmt.Errorf("topic %q not found; available topics: %s", topic, available)
	}

	return nil, HelpResponse{
		Operations:  registry.MarshalForHelp(ops),
		Count:       len(ops),
		PythonUsage: pythonUsageSnippet,
		Note:        fmt.Sprintf("Help for topic %q.", topic),
		NextStep:    nextStep,
		NextTools:   []string{"mcp_execute"},
	}, nil
}
