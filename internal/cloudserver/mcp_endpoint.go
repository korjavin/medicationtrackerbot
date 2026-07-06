package cloudserver

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/mcpshim"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Task 2: the internet-accessible streamable-HTTP MCP endpoint hosted
// clients (claude.ai, ChatGPT) talk to directly, mounted at "/mcp/<token>" on
// the account's subdomain (router.go's ServeHTTP already resolves the
// account from Host before reaching here). Auth is the capability token
// itself — see Development Approach's "the throttle IS the security": the
// token is short enough to type across devices, so a per-account
// failed-attempt throttle is the actual security boundary, not token
// entropy.

const (
	// mcpEndpointFailLimitMax/-Window bound wrong-token guesses per account.
	// At 100/min, brute-forcing the ~30-bit token space takes decades — see
	// the plan's Development Approach. Only failed compares consume this
	// budget; valid-token traffic never does.
	mcpEndpointFailLimitMax    = 100
	mcpEndpointFailLimitWindow = time.Minute

	// mcpEndpointCallLimitMax/-Window bound successful-auth tool calls per
	// token, so a retry-storming hosted client can't hammer the relay/device
	// round trip unbounded. ponytail: PoC value, not measured against real
	// connector traffic — tune once claude.ai/ChatGPT usage is observed.
	mcpEndpointCallLimitMax    = 60
	mcpEndpointCallLimitWindow = time.Minute

	// hostedToolDescriptionSuffix is appended to both tool descriptions,
	// reworded from cmd/mcpshim/main.go's toolDescriptionSuffix for the
	// hosted-relay context: unlike Tier 1's direct shim-to-tab connection,
	// this endpoint sits between the client and the relay by explicit user
	// consent (Task 1's leakage table), so it says so plainly.
	hostedToolDescriptionSuffix = " This connector reaches your unlocked Med Tracker browser tab end-to-end encrypted via the relay; by enabling it you consented to this server seeing MCP requests and responses in transit (never stored). If no device is unlocked and online, it returns a clear error instead of hanging."
)

// mcpEndpointCallInput mirrors cmd/mcpshim/main.go's callInput — the wire
// contract web/cloud/js/mcp-responder.js's dispatcher expects ({op, params})
// — duplicated rather than imported because cmd/mcpshim is package main.
type mcpEndpointCallInput struct {
	Op     string         `json:"op" jsonschema:"the operation id from mcp_help's catalog, e.g. bp.list"`
	Params map[string]any `json:"params,omitempty" jsonschema:"parameters for the operation, per its input_schema in mcp_help"`
}

// normalizeMCPToken lowercases and strips hyphens, so "XXX-XXX", "xxxxxx",
// and "xxx-xxx" all compare equal — the plan's "hyphen stripped on check".
func normalizeMCPToken(s string) string {
	return strings.ToLower(strings.ReplaceAll(s, "-", ""))
}

// constantTimeTokenEqual compares two normalized tokens without leaking
// timing on a byte-by-byte mismatch. The length check is not constant-time,
// but token length carries no secret (every live token is the same fixed
// length) — this mirrors crypto/hmac.Equal's own precheck.
func constantTimeTokenEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// buildHostedMCPServer wires mcp_help/mcp_call onto a fresh *sdkmcp.Server
// backed by client, mirroring cmd/mcpshim/main.go's tool wiring exactly
// (same input shapes, same responder wire contract) except for the
// description suffix. A nil client (should not happen — Endpoint only calls
// this after confirming a live registry entry) errors instead of panicking.
func buildHostedMCPServer(client *mcpshim.Client) *sdkmcp.Server {
	server := sdkmcp.NewServer(&sdkmcp.Implementation{Name: "medtracker-mcp-remote", Version: "0.1.0-poc"}, nil)

	call := func(ctx context.Context, method string, params any) (*sdkmcp.CallToolResult, any, error) {
		if client == nil {
			return nil, nil, errors.New("hosted connector not configured")
		}
		result, err := client.Call(ctx, method, params)
		if err != nil {
			return nil, nil, err
		}
		return nil, json.RawMessage(result), nil
	}

	sdkmcp.AddTool(server, &sdkmcp.Tool{
		Name:        "mcp_help",
		Description: "Discover the small catalog of Med Tracker operations this connector can run." + hostedToolDescriptionSuffix,
	}, func(ctx context.Context, _ *sdkmcp.CallToolRequest, _ any) (*sdkmcp.CallToolResult, any, error) {
		return call(ctx, "mcp_help", struct{}{})
	})

	sdkmcp.AddTool(server, &sdkmcp.Tool{
		Name:        "mcp_call",
		Description: "Run exactly one Med Tracker operation by id — see mcp_help for the catalog." + hostedToolDescriptionSuffix,
	}, func(ctx context.Context, _ *sdkmcp.CallToolRequest, input mcpEndpointCallInput) (*sdkmcp.CallToolResult, any, error) {
		return call(ctx, "mcp_call", input)
	})

	return server
}

// mcpClientCtxKey stashes the validated request's live hosted client so the
// streamable handler's getServer callback doesn't need a second registry
// lookup (and can't race a disable that happened between Endpoint's check
// and getServer's call).
type mcpClientCtxKey struct{}

func withMCPClient(ctx context.Context, client *mcpshim.Client) context.Context {
	return context.WithValue(ctx, mcpClientCtxKey{}, client)
}

func mcpClientFromContext(ctx context.Context) *mcpshim.Client {
	client, _ := ctx.Value(mcpClientCtxKey{}).(*mcpshim.Client)
	return client
}

// Endpoint builds the streamable-HTTP MCP handler mounted at "/mcp/<token>"
// on every account subdomain (router.go's SetMCPHandler). It resolves the
// account already stashed in the request context by the router's subdomain
// lookup, checks the path's token against the account's live registry entry
// (constant-time, hyphen/case-insensitive), and only then hands off to the
// SDK's streamable handler. Unknown account / wrong / revoked token all 404
// identically (Testing Strategy's "without body distinguishing existence");
// the failed-attempt throttle is checked on every such rejection, not just
// wrong-token ones, since a disabled account's token space is exactly as
// guessable.
func (a *MCPRemoteAPI) Endpoint() http.Handler {
	streamableHandler := sdkmcp.NewStreamableHTTPHandler(func(r *http.Request) *sdkmcp.Server {
		return buildHostedMCPServer(mcpClientFromContext(r.Context()))
	}, &sdkmcp.StreamableHTTPOptions{
		SessionTimeout: 30 * time.Minute,
		// The SDK's DNS-rebinding guard only recognizes an exact "localhost"
		// Host as loopback-safe, so it 403s every per-account
		// "<sub>.localhost" dev host even though CLOUD_BASE_DOMAIN=localhost
		// is the documented local-dev setup (cmd/cloud's config). The token
		// check above is this endpoint's actual auth boundary, so the SDK's
		// heuristic is both redundant here and a false positive for that
		// setup — disable it.
		DisableLocalhostProtection: true,
	})

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		account, ok := AccountFromContext(r.Context())
		if !ok {
			http.NotFound(w, r)
			return
		}
		candidate := normalizeMCPToken(strings.TrimPrefix(r.URL.Path, "/mcp/"))

		a.mu.RLock()
		entry := a.byAcc[account.ID]
		a.mu.RUnlock()

		if entry == nil || !constantTimeTokenEqual(candidate, normalizeMCPToken(entry.token)) {
			if !a.failLimiter.Allow(account.ID) {
				http.Error(w, "too many attempts", http.StatusTooManyRequests)
				return
			}
			http.NotFound(w, r)
			return
		}

		if !a.callLimiter.Allow(entry.token) {
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}

		r = r.WithContext(withMCPClient(r.Context(), entry.client))
		streamableHandler.ServeHTTP(w, r)
	})
}
