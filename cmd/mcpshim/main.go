// Command mcpshim is the local half of the MCP blind relay (docs/cloud-mode.md
// "MCP", Tier 1 PoC): a stdio MCP server for Claude Desktop/Code that forwards
// mcp_help/mcp_call as encrypted frames to the paired browser tab via
// internal/mcpshim, and back. It is deliberately thin — all dial/crypto/
// correlation logic lives in internal/mcpshim so the Go integration test can
// drive it without spawning this binary.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"

	"github.com/korjavin/medicationtrackerbot/internal/mcpshim"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

// version has no build-time stamping (PoC — no packaged binary yet, per the
// plan's "Known PoC ceilings").
const version = "0.1.0-poc"

// toolDescriptionSuffix is appended to both tool descriptions so the model
// sees the E2E-encrypted, device-required architecture up front (the plan's
// locked "Offline-device UX" decision) without having to fail a call first.
const toolDescriptionSuffix = " This connector talks end-to-end encrypted directly to your unlocked Med Tracker browser tab, never to a server — if no device is unlocked and online, it returns a clear error instead of hanging."

// helpInput is mcp_help's argument shape. Without it the SDK advertises no
// arguments and the agent can never drill in — only an operation_id drill-in
// returns full schemas (web/cloud/js/mcp-responder.js buildHelp). Keep it
// field-for-field identical to internal/cloudserver's mcpEndpointHelpInput;
// TestMCPHelpEnvelopeLockstep is what stops them drifting.
type helpInput struct {
	OperationID  string   `json:"operation_id,omitempty" jsonschema:"one operation id to return in full, with its params_schema and body_schema"`
	OperationIDs []string `json:"operation_ids,omitempty" jsonschema:"several operation ids to return in full, with their params_schema and body_schema"`
	Topic        string   `json:"topic,omitempty" jsonschema:"list only this topic's operations, e.g. workouts"`
	Query        string   `json:"query,omitempty" jsonschema:"keyword-search the catalog, e.g. blood pressure"`
}

// callInput is mcp_call's argument shape, matching the wire contract
// web/cloud/js/mcp-responder.js's dispatcher expects — the same envelope
// bot mode's mcp_call takes (internal/mcp/call.go:19-26). Keep it
// field-for-field identical to internal/cloudserver's mcpEndpointCallInput;
// the two are duplicated rather than shared because cmd/mcpshim is package
// main, and TestMCPCallEnvelopeLockstep is what stops them drifting.
type callInput struct {
	OperationID string         `json:"operation_id,omitempty" jsonschema:"the operation id from mcp_help's catalog, e.g. health.bp.list"`
	Op          string         `json:"op,omitempty" jsonschema:"deprecated alias for operation_id; prefer operation_id"`
	Params      map[string]any `json:"params,omitempty" jsonschema:"parameters for the operation, per its params_schema in mcp_help"`
	PathParams  map[string]any `json:"path_params,omitempty" jsonschema:"values for the operation's {placeholder} path slots, per its path_params in mcp_help"`
	Body        map[string]any `json:"body,omitempty" jsonschema:"request body for a write operation, per its body_schema in mcp_help"`
	Mode        string         `json:"mode,omitempty" jsonschema:"read-only (default) or write; a write operation requires write"`
	Intent      string         `json:"intent,omitempty" jsonschema:"required and non-empty when mode is write: why this write is being made"`
}

func main() {
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println("mcpshim " + version)
		return
	}

	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))

	code := os.Getenv("MEDTRACKER_MCP_CODE")
	if code == "" {
		slog.Error("[mcpshim] MEDTRACKER_MCP_CODE is not set — paste the code from your Med Tracker app's Connect Claude screen")
		os.Exit(1)
	}

	client, err := mcpshim.NewClient(code)
	if err != nil {
		slog.Error("[mcpshim] invalid MEDTRACKER_MCP_CODE", "error", err)
		os.Exit(1)
	}

	server := sdkmcp.NewServer(&sdkmcp.Implementation{Name: "medtracker-mcp-shim", Version: version}, nil)

	sdkmcp.AddTool(server, &sdkmcp.Tool{
		Name:        "mcp_help",
		Description: "Discover the small catalog of Med Tracker operations this connector can run. Call with no arguments for the terse catalog, then pass operation_id (or operation_ids) to get an operation's full schemas." + toolDescriptionSuffix,
	}, func(ctx context.Context, _ *sdkmcp.CallToolRequest, input helpInput) (*sdkmcp.CallToolResult, any, error) {
		result, err := client.Call(ctx, "mcp_help", input)
		if err != nil {
			return nil, nil, err
		}
		return nil, json.RawMessage(result), nil
	})

	sdkmcp.AddTool(server, &sdkmcp.Tool{
		Name:        "mcp_call",
		Description: "Run exactly one Med Tracker operation by id — see mcp_help for the catalog." + toolDescriptionSuffix,
	}, func(ctx context.Context, _ *sdkmcp.CallToolRequest, input callInput) (*sdkmcp.CallToolResult, any, error) {
		result, err := client.Call(ctx, "mcp_call", input)
		if err != nil {
			return nil, nil, err
		}
		return nil, json.RawMessage(result), nil
	})

	slog.Info("[mcpshim] starting stdio MCP server", "version", version)
	if err := server.Run(context.Background(), &sdkmcp.StdioTransport{}); err != nil {
		slog.Error("[mcpshim] server error", "error", err)
		os.Exit(1)
	}
}
