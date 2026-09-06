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
	}, func(ctx context.Context, _ *sdkmcp.CallToolRequest, input mcpshim.HelpInput) (*sdkmcp.CallToolResult, any, error) {
		result, err := client.Call(ctx, "mcp_help", input)
		if err != nil {
			return nil, nil, err
		}
		return nil, json.RawMessage(result), nil
	})

	sdkmcp.AddTool(server, &sdkmcp.Tool{
		Name:        "mcp_call",
		Description: "Run exactly one Med Tracker operation by id (ids and schemas come from mcp_help). Pass params for query fields, path_params for {placeholder} slots in the route, and body as a JSON object for writes. Any operation that changes data requires mode='write' and a one-sentence intent; reads never mutate. Returns the operation's result, or an error naming the reason (no device unlocked and online, unknown operation, validation failure)." + toolDescriptionSuffix,
	}, func(ctx context.Context, _ *sdkmcp.CallToolRequest, input mcpshim.CallInput) (*sdkmcp.CallToolResult, any, error) {
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
