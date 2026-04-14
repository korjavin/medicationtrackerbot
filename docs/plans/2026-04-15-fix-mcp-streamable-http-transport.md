# Fix MCP: Switch from SSE to Streamable HTTP Transport

## Overview

The MCP server uses the legacy SSE transport (2024-11-05 spec) via `mcp.NewSSEHandler`. Claude.ai has upgraded to the Streamable HTTP transport (2025-03-26 spec). The SSE handler cannot serve the newer protocol -- authentication succeeds (it happens at the HTTP layer) but the MCP session/tools negotiation fails because Claude sends POST requests to initialize, while the SSE handler expects GET-first flow. Fix: replace `NewSSEHandler` with `NewStreamableHTTPHandler`.

## Context

- Files involved: `internal/mcp/mcp.go` (Run method, lines 505-561)
- SDK: `github.com/modelcontextprotocol/go-sdk v1.4.1` already has `NewStreamableHTTPHandler`
- The SSE transport (2024-11-05 spec) uses GET to establish SSE stream, then POST with `?sessionid=` for messages
- The Streamable HTTP transport (2025-03-26 spec) uses POST to initialize (no session ID), server responds with `Mcp-Session-Id` header, subsequent POSTs include that header
- Claude.ai now uses the streamable transport, causing the SSE handler to reject initialize POSTs (no sessionid param)
- OAuth middleware wraps the handler and validates Bearer tokens on every request -- this is transport-agnostic and works with both SSE and streamable
- Go 1.26 `http.CrossOriginProtection` is used by the streamable handler -- non-browser requests (no `Origin`/`Sec-Fetch-Site` headers) are allowed by default, so Claude's server-side client is unaffected

## Development Approach

- **Testing approach**: Regular (code first, then verify with existing tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Switch transport handler from SSE to Streamable HTTP

**Files:**
- Modify: `internal/mcp/mcp.go`

- [ ] In the `Run` method (around line 513), replace `mcp.NewSSEHandler(...)` with `mcp.NewStreamableHTTPHandler(...)`, passing the same `getServer` closure and appropriate `StreamableHTTPOptions` (session timeout of 30 minutes, `slog.Default()` logger)
- [ ] Remove the comment about SSEHandler
- [ ] Update the `mux.Handle("/mcp", ...)` line -- the path `/mcp` stays the same but add a trailing-slash variant `/mcp/` to ensure both are routed
- [ ] Verify the existing MCP tests still pass (`go test ./internal/mcp/...`)

### Task 2: Verify acceptance criteria

- [ ] Run full test suite (`go test ./...`)
- [ ] Run linter if available
- [ ] Build binary successfully (`go build ./cmd/mcptool`)

### Task 3: Update documentation

- [ ] Update CLAUDE.md: in the MCP Server section, note the transport is Streamable HTTP (2025-03-26 spec), not SSE
- [ ] Move this plan to `docs/plans/completed/`
