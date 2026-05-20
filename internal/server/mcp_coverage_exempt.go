package server

// routeExemption records an HTTP route that is intentionally NOT exposed via
// the MCP registry. Every entry must carry a short Reason so the guard test
// can surface the rationale and so a code reviewer can see why the route
// stays out of MCP coverage. See mcp_coverage_test.go for the enforcement.
type routeExemption struct {
	Method string
	Path   string
	Reason string
}

// mcpCoverageExempt lists routes that are not (and should not be) reachable
// via the MCP operation registry. Three buckets:
//
//  1. transport / shell — UI delivery, auth, static files, MCP plumbing
//     itself, web-push subscriptions; the agent has no legitimate reason
//     to invoke them and exposing them would be at best useless and at
//     worst a privilege-escalation vector (e.g. an agent flipping a
//     feature flag the user disabled);
//  2. routes already served by an atomic MCP tool — for example, the
//     /api/workout/sessions/logs/* routes are the HTTP shape that the
//     workout_log MCP tool calls; reaching them through mcp_execute too
//     would duplicate semantics with no agent-side benefit;
//  3. legacy compat shims — older paths kept around to avoid breaking
//     pinned clients, superseded by a newer path that IS in the registry.
//
// The MCP coverage guard test (TestMCPCoverage_AllRoutesEitherRegisteredOrExempt)
// fails if a route appears here AND is registered, or if a route is neither
// registered nor exempt. Adding a new route to the server requires a
// conscious decision about which category it belongs to.
var mcpCoverageExempt = []routeExemption{
	// --- Transport / shell: outer mux without HTTP method ---
	{Method: "", Path: "/", Reason: "UI shell index; agent talks to the API instead"},
	{Method: "", Path: "/api/", Reason: "subtree mount onto apiMux; per-route coverage is tracked on the inner mux"},
	{Method: "", Path: "/bp_add", Reason: "Telegram Mini App deep link to UI"},
	{Method: "", Path: "/weight_add", Reason: "Telegram Mini App deep link to UI"},
	{Method: "", Path: "/favicon.ico", Reason: "static asset"},
	{Method: "", Path: "/oidc-setup", Reason: "browser-only OIDC setup page"},
	{Method: "", Path: "/pitch", Reason: "static landing page"},
	{Method: "", Path: "/static/", Reason: "static file subtree"},
	{Method: "", Path: "/static/config.js", Reason: "server-generated static config for the SPA"},
	{Method: "", Path: "/static/sw.js", Reason: "service worker delivery"},
	{Method: "", Path: "/auth/status", Reason: "browser-only auth status probe"},
	{Method: "", Path: "/auth/oidc/login", Reason: "OIDC login redirect; browser-only"},
	{Method: "", Path: "/auth/oidc/callback", Reason: "OIDC callback; browser-only"},
	{Method: "", Path: "/auth/google/login", Reason: "back-compat alias for OIDC login"},
	{Method: "", Path: "/auth/google/callback", Reason: "back-compat alias for OIDC callback"},
	{Method: "", Path: "/auth/telegram/callback", Reason: "Telegram login callback; browser-only"},

	// --- Internal MCP plumbing & external integrations ---
	{Method: "POST", Path: "/internal/mcp/bridge", Reason: "internal MCP→HTTP bridge; the proxy talks to itself, agents must not"},
	{Method: "POST", Path: "/api/mcp-audit", Reason: "internal audit hook for the MCP server"},
	{Method: "POST", Path: "/api/mcp-food-log", Reason: "HMAC-signed write-through for the legacy log_food_intake atomic tool; will be removed alongside that tool"},
	{Method: "POST", Path: "/api/mcp-workout-log", Reason: "HMAC-signed write-through for the legacy workout_log atomic tool; will be removed alongside that tool"},
	{Method: "POST", Path: "/api/workout/external", Reason: "external-API-key auth; not user-driven"},
	{Method: "GET", Path: "/api/elevenlabs/signed-url", Reason: "browser-only voice integration handshake"},
	{Method: "POST", Path: "/api/elevenlabs/upload-file", Reason: "browser-only voice integration: proxies image upload to ElevenLabs with the server's xi-api-key"},

	// --- UI bootstrap and real-time sync ---
	{Method: "GET", Path: "/api/init", Reason: "UI bootstrap aggregate; agent uses topic-specific reads"},
	{Method: "GET", Path: "/api/bootstrap", Reason: "UI bootstrap aggregate; agent uses topic-specific reads"},
	{Method: "GET", Path: "/api/changes", Reason: "UI change-feed used for real-time refresh"},
	{Method: "GET", Path: "/api/changes/stream", Reason: "UI SSE stream for real-time refresh"},

	// --- Web push: subscriptions are bound to a browser/device, not an agent ---
	{Method: "POST", Path: "/api/webpush/subscribe", Reason: "device-bound push subscription"},
	{Method: "POST", Path: "/api/webpush/unsubscribe", Reason: "device-bound push subscription"},
	{Method: "GET", Path: "/api/webpush/subscriptions", Reason: "device-bound push subscription"},
	{Method: "GET", Path: "/api/webpush/vapid-public-key", Reason: "device-bound push subscription"},
	{Method: "POST", Path: "/api/webpush/test-medication", Reason: "fires a test push to the user's devices; UI-only diagnostic"},

	// --- Settings: feature toggles + UI prefs gate MCP itself, intentionally not MCP-exposed ---
	{Method: "GET", Path: "/api/settings", Reason: "UI settings — toggling MCP gates from inside MCP is a privilege loop"},
	{Method: "POST", Path: "/api/settings", Reason: "UI settings — toggling MCP gates from inside MCP is a privilege loop"},
	{Method: "GET", Path: "/api/settings/features", Reason: "lists feature flags that gate MCP itself"},
	{Method: "POST", Path: "/api/settings/features/{feature}", Reason: "toggles feature flags that gate MCP itself"},
	{Method: "POST", Path: "/api/settings/tab-order", Reason: "UI-only navigation preference"},
	{Method: "PATCH", Path: "/api/settings/weight-unit", Reason: "UI-only display preference"},
	{Method: "GET", Path: "/api/settings/integrations", Reason: "user-editable integration credentials; an agent invoking this would either leak secrets it has no business reading or rewrite the credentials it itself runs against"},
	{Method: "PATCH", Path: "/api/settings/integrations", Reason: "user-editable integration credentials; an agent invoking this would either leak secrets it has no business reading or rewrite the credentials it itself runs against"},
	{Method: "POST", Path: "/api/tz-suggestion/dismiss", Reason: "UI/settings — TZ prompt dismissal"},
	{Method: "GET", Path: "/api/food/settings/status", Reason: "feature flag status; gates MCP itself"},
	{Method: "POST", Path: "/api/food/settings/toggle", Reason: "feature flag toggle; gates MCP itself"},

	// --- Reminders: device-bound pull for local notifications ---
	{Method: "GET", Path: "/api/reminders/upcoming", Reason: "device-bound reminder pull for the mobile-build @capacitor/local-notifications JS bridge; an agent has no business scheduling user notifications"},

	// --- Bulk import / export: CSV-shaped, awkward via mcp_execute ---
	{Method: "POST", Path: "/api/bp/import", Reason: "CSV upload, multipart form; not a JSON RPC shape"},
	{Method: "POST", Path: "/api/food/log/from-photo", Reason: "multipart image upload routed through OpenAI Vision; agents log food via the JSON /api/food/log endpoint"},
	{Method: "GET", Path: "/api/bp/export", Reason: "CSV download; agent uses health.bp.list instead"},
	{Method: "GET", Path: "/api/weight/export", Reason: "CSV download; agent uses health.weight.list instead"},

	// --- Legacy compat shims, superseded ---
	{Method: "POST", Path: "/api/workout/session/snooze", Reason: "legacy compat shim, superseded by /sessions/{id}/snooze"},
	{Method: "POST", Path: "/api/workout/session/skip", Reason: "legacy compat shim, superseded by /sessions/{id}/skip"},
}
