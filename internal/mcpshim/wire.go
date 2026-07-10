package mcpshim

// The mcp_help / mcp_call wire envelopes, shared by both Go MCP front ends —
// cmd/mcpshim (the stdio shim) and internal/cloudserver's hosted endpoint —
// and decoded on the other side by web/cloud/js/mcp-responder.js. CallInput
// mirrors bot mode's mcp.CallInput (internal/mcp/call.go). The jsonschema
// tags are what the SDK advertises to the model, so a dropped field is a
// field no agent can ever pass.

// HelpInput is mcp_help's argument shape. Without it the SDK advertises no
// arguments and the agent can never drill in — only an operation_id drill-in
// returns full schemas (mcp-responder.js buildHelp).
type HelpInput struct {
	OperationID  string   `json:"operation_id,omitempty" jsonschema:"one operation id to return in full, with its params_schema and body_schema"`
	OperationIDs []string `json:"operation_ids,omitempty" jsonschema:"several operation ids to return in full, with their params_schema and body_schema"`
	Topic        string   `json:"topic,omitempty" jsonschema:"list only this topic's operations, e.g. workouts"`
	Query        string   `json:"query,omitempty" jsonschema:"keyword-search the catalog, e.g. blood pressure"`
}

// CallInput is mcp_call's argument shape. `op` is a back-compat alias older
// pairings and shim binaries still send.
type CallInput struct {
	OperationID string         `json:"operation_id,omitempty" jsonschema:"the operation id from mcp_help's catalog, e.g. health.bp.list"`
	Op          string         `json:"op,omitempty" jsonschema:"deprecated alias for operation_id; prefer operation_id"`
	Params      map[string]any `json:"params,omitempty" jsonschema:"parameters for the operation, per its params_schema in mcp_help"`
	PathParams  map[string]any `json:"path_params,omitempty" jsonschema:"values for the operation's {placeholder} path slots, per its path_params in mcp_help"`
	Body        map[string]any `json:"body,omitempty" jsonschema:"request body for a write operation, per its body_schema in mcp_help"`
	Mode        string         `json:"mode,omitempty" jsonschema:"read-only (default) or write; a write operation requires write"`
	Intent      string         `json:"intent,omitempty" jsonschema:"required and non-empty when mode is write: why this write is being made"`
}
