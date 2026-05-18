# ElevenLabs MCP via client tools — mcp_help-only production spike

## Overview

Production validation slice on top of `docs/plans/2026-05-18-elevenlabs-dynamic-mcp-client-tools.md`. That parent plan wires up `mcp_help` + `mcp_execute` as ElevenLabs SDK client tools, with a short-lived session token, CORS on the MCP server, and a token-mint endpoint on the bot. **Assume the parent plan is fully implemented in this branch.** This spike plan answers one question only: **does the dynamic client-tools approach actually work end-to-end in production, with the agent successfully calling tools via the SDK callback?**

To minimize blast radius and time-to-signal, the spike exposes only `mcp_help`:
- **Read-only** (just lists the MCP operation catalog) — nothing can be wrongly written or deleted if anything misbehaves.
- **No Python sandbox involved** — eliminates the executor as a variable. If something fails, we know it's the SDK / client-tool / token / CORS path, not the heavy-machinery path.
- **Tiny payload** — args are at most a `topic` filter; response is a JSON catalog. Latency and serialization issues, if any, will be unambiguous.

If the spike succeeds, `mcp_execute` is unblocked: re-enable it via the feature flag, ship, and the parent plan's work activates fully. If it fails, the learnings drive a redesign before we invest in `mcp_execute` validation work.

**Explicit deviation from the project's normal Development Approach**: this plan has no automated tests. The user has signaled a spike posture — they want to see the approach work in production before committing more. The prior plan already wrote tests for the underlying token endpoint, CORS, and frontend integration framework. This plan changes only one thing (gating `mcp_execute` off) and validates the result manually. If the spike succeeds, normal test discipline resumes for follow-up work.

## Context (from discovery)

**Assumed state in this branch (from the parent plan):**
- `internal/store/auth/repo.go` has `expires_at` column on `api_tokens` and `CreateTokenWithExpiry`.
- `POST /api/elevenlabs/mcp-session-token` on the bot mints a 15-min token + returns `mcp_server_url`.
- MCP server at `MCP_DOMAIN` has CORS allowance for `APP_DOMAIN` origin.
- `web/static/js/features/elevenlabs-call.js` constructs a `clientTools` object containing both `mcp_help` and `mcp_execute` and passes it to `Conversation.startSession({...})`.

**What changes for the spike:**
- Only `mcp_help` is registered as a client tool. `mcp_execute` is gated behind a default-off flag — handler code stays in place, just isn't registered with the SDK, so the agent never sees it as available.
- Production deploy + real voice call + verify logs.
- After confirming client-tools work, the static MCP server config in the ElevenLabs agent dashboard is removed manually — this proves the client-tools path alone is sufficient and removes the long-lived token from ElevenLabs' systems.

**Files/components involved (minimal):**
- `web/static/js/features/elevenlabs-call.js` — the `buildClientTools()` helper (from the parent plan's Task 4). Add a simple guard around the `mcp_execute` entry.
- No backend changes.
- No DB changes.
- No test changes.

## Development Approach

**Spike posture — deliberate deviation from the project's normal Development Approach.** The standard rules (every task includes new/updated tests, all tests pass before next task, etc.) are explicitly suspended for this plan, by user direction. The reasoning: we are validating an external-system integration in production, and the cost of getting test coverage *for the gating change alone* is high relative to the signal it provides. The parent plan already covered the substantive code with tests. This plan adds only a flag check and a deploy.

**Standard project rules still apply:**
- Make small, focused changes.
- Maintain backward compatibility — re-enabling `mcp_execute` is a one-line flip, no other code rewires needed.
- Update this plan file when scope changes during implementation.
- Architecture rules (no inline styles, no hardcoded colors, design-token usage) still hold.
- The MCP coverage guard, dose-time-columns invariant, etc., must still pass — but they're untouched by this plan.

## Testing Strategy

**No automated tests in this plan.** Validation is manual, in production, via real voice calls.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with `➕` prefix.
- Document issues/blockers with `⚠️` prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): the gating code change.
- **Post-Completion** (no checkboxes): deploy, manual production verification, ElevenLabs dashboard cleanup, and the go/no-go decision on `mcp_execute`.

## Implementation Steps

### Task 1: Gate `mcp_execute` behind a default-off flag in the frontend
- [x] in `web/static/js/features/elevenlabs-call.js`, locate the `buildClientTools({token, mcpServerUrl})` helper introduced by the parent plan's Task 4.
- [x] add a top-of-file constant: `const MCP_VOICE_ENABLE_EXECUTE = false;` with a one-line comment: `// spike: mcp_help only until production validation; see docs/plans/2026-05-18-elevenlabs-mcp-help-only-spike.md`.
- [x] inside `buildClientTools`, wrap the `mcp_execute` entry: only include it in the returned object when `MCP_VOICE_ENABLE_EXECUTE` is true. Keep the handler function code itself in place (do not delete) — only the registration is gated.
- [x] verify by reading the diff that `mcp_help` registration is unchanged and `mcp_execute` is omitted from the returned `clientTools` object when the flag is false.
- [x] no tests written (spike posture).

### Task 2: Update documentation to reflect the spike scope
- [ ] add a short subsection to `docs/local-mode.md` (or `docs/mcp-deployment.md`, wherever the parent plan's "Voice agent integration" doc lives) noting that `mcp_execute` is feature-flagged off pending the production validation spike. Reference this plan file.
- [ ] no test changes.

*Note: ralphex automatically moves completed plans to `docs/plans/completed/`*

## Technical Details

**The flag (frontend, in `elevenlabs-call.js`):**

```js
// spike: mcp_help only until production validation;
// see docs/plans/2026-05-18-elevenlabs-mcp-help-only-spike.md
const MCP_VOICE_ENABLE_EXECUTE = false;

function buildClientTools({ token, mcpServerUrl }) {
  const tools = {
    mcp_help: { /* handler from parent plan */ },
  };
  if (MCP_VOICE_ENABLE_EXECUTE) {
    tools.mcp_execute = { /* handler from parent plan */ };
  }
  return tools;
}
```

When the spike validates successfully, flipping the constant to `true` re-enables `mcp_execute`. No other code changes needed.

**What the agent sees during the spike:** at session start the SDK pushes the tool list to ElevenLabs' cloud. The agent's tool catalog for the call contains only `mcp_help`. If the agent attempts to invoke any other tool (it won't — it doesn't see them), the SDK silently ignores. The agent can still talk and reason; it just can't run scripts. Read-style questions ("what BP entries do I have this week?") will not yield specific data via `mcp_execute`; the agent will degrade to general responses or ask clarifying questions. That's acceptable for the spike — we are validating tool-call plumbing, not conversational quality.

**Rollback if the spike misbehaves:** the parent plan's Task 4 already left the dashboard MCP server config functional (Post-Completion step is to delete it manually). If client tools cause problems in production, the rollback path is one line: revert the parent plan's Task 4 change to `elevenlabs-call.js` (or remove the `clientTools` option from `startSession`) and the agent falls back to the dashboard's static MCP server config — same behavior the user has today.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only.*

### Deploy + manual production verification

1. Deploy this branch to production via the existing deploy pipeline.
2. Open the app in a logged-in browser session. Tap "Call agent" on the Today screen.
3. While in the call, ask the agent something that should trigger `mcp_help`. Two reliable prompts:
   - **"What tools do you have available for blood pressure?"** — Should cause the agent to call `mcp_help` with `topic: "health"` and respond with the catalog content.
   - **"What kinds of things can you log for me?"** — Broader; agent should call `mcp_help` with no topic filter and summarize categories.
4. Watch the bot's logs and the MCP server's logs during the call. Confirm:
   - A `POST /api/elevenlabs/mcp-session-token` request from the user's session before the call starts.
   - A `POST {MCP_SERVER_URL}/mcp` request with JSON-RPC `tools/call` for `mcp_help` and a Bearer token matching the minted one.
   - The MCP server responds with a `result` envelope, not an `error`.
   - The agent's response, in audio, references content from `mcp_help` (e.g. names actual tool categories rather than generic possibilities).
5. Note any failures with `⚠️` in this plan file. Common candidates: CORS misconfiguration (preflight 4xx in browser devtools), token expiry edge cases, JSON-RPC payload shape mismatches between what the frontend sends and what the MCP server expects.

### Clean up the ElevenLabs dashboard MCP config

After (and only after) the verification above succeeds:

1. Log into the ElevenLabs agent dashboard for your `ELEVENLABS_AGENT_ID`.
2. Remove the static MCP server URL + token configuration from the agent.
3. Make another voice call. Use the same prompts as above.
4. Confirm the agent still successfully calls `mcp_help` — proving the client-tools path alone is sufficient and the dashboard config was redundant.
5. Revoke the long-lived `mcp_*` token that was sitting in the dashboard by deleting it via the loopback admin port (`DELETE /admin/tokens/{id}` per `docs/mcp-deployment.md`).

### Go/no-go decision on `mcp_execute`

After the validation steps above, document the outcome in `docs/local-mode.md` (or a new "ElevenLabs voice agent validation" section in `docs/mcp-deployment.md`). Specifically capture:

- **Result**: did `mcp_help` work end-to-end? Yes / no / with caveats (latency, agent confusion, etc.).
- **Observations**: round-trip latency from agent decision to tool-result delivery. Anecdotal but useful for sizing `mcp_execute` expectations (those calls will be ~1–5s slower due to sandbox spin-up).
- **Decision**:
  - **Green**: flip `MCP_VOICE_ENABLE_EXECUTE` to `true`, ship, declare the parent plan's work fully active.
  - **Yellow** (works but with quirks): write a follow-up plan for the specific quirks before enabling `mcp_execute`.
  - **Red**: roll back per the Technical Details section, write a new plan addressing the root cause, and reconsider the architecture before re-attempting.

The decision is documented in markdown, not in code. Once it's made and acted upon, this plan is complete.
