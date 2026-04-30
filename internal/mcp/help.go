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

const (
	defaultNextStep = "Pick a topic (e.g., 'workouts') or lookup an operation by ID to start building a script."
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
				NextTools: []string{"mcp_execute"},
			}, nil
		}
		entries := registry.MarshalForHelp([]*registry.Operation{op})

		// Use topic suggestion if possible even for exact ID lookup.
		if suggestion := s.reg.Suggestion(op.Topic); suggestion != "" {
			nextStep = suggestion
		}

		return nil, HelpResponse{
			Operations: entries,
			Count:      1,
			Note:       fmt.Sprintf("Showing details for operation %q. Use mcp_execute to run the example script.", opID),
			NextStep:   nextStep,
			NextTools:  []string{"mcp_execute"},
		}, nil
	}

	// Topic filter or full catalog.
	if topic == "" || topic == "all" {
		ops := s.reg.All()
		return nil, HelpResponse{
			Operations: registry.MarshalForHelp(ops),
			Count:      len(ops),
			Topics:     s.reg.Topics(),
			Note:       "Pick a topic to filter operations, or use an operation_id to see details and examples.",
			NextStep:   nextStep,
			NextTools:  []string{"mcp_execute"},
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
		Note:       fmt.Sprintf("Showing %d operation(s) for topic %q.", len(ops), topic),
		NextStep:   nextStep,
		NextTools:  []string{"mcp_execute"},
	}, nil
}
