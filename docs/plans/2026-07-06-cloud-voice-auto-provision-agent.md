# Cloud voice: provision the ElevenLabs agent + tools entirely from code

## Overview

med-rgc/#440 shipped browser-direct signed-URL + in-tab MCP dispatch, but the
agent still needed hand-configured tools in the ElevenLabs dashboard — the agent
never actually called anything. This makes it **fully hands-off**: the user sets
**only their ElevenLabs API key** in cloud Settings, and the app **provisions the
agent and its tools dynamically from code** via the ElevenLabs API (browser-
direct with the vault key, CORS-open). It reads AND writes vault data by voice,
with an audible tool-call sound. Closes bd **med-eas.26**.

## Context (from spike, 2026-07-06 — verified)

- `api.elevenlabs.io` is CORS-open (`access-control-allow-origin/headers: *`), so
  the browser calls the ElevenLabs Agents/Tools API directly with the vault
  `xi-api-key`. No server, nothing over `/api`.
- **Create client tool** — `POST /v1/convai/tools`, body:
  ```json
  { "tool_config": { "type": "client", "name": "log_blood_pressure",
      "description": "...",
      "parameters": { "type": "object",
        "properties": { "systolic": {"type":"integer","description":"..."} },
        "required": ["systolic","diastolic"] } } }
  ```
  Response `{ id, tool_config, ... }`. List via `GET /v1/convai/tools`.
- **Create agent** — `POST /v1/convai/agents/create`, body:
  ```json
  { "conversation_config": {
      "agent": { "prompt": { "prompt": "<system prompt>", "tool_ids": ["...","..."] },
                 "first_message": "...", "language": "en" },
      "tts": { "voice_id": "cjVigY5qzO86Huf0OWal" } } }
  ```
  Response `{ agent_id, ... }`. Update via `PATCH /v1/convai/agents/{id}`.
- **Tool-call sound** (owner UX request): `tool_call_sound` ∈
  {`typing`,`elevator1..4`}, `tool_call_sound_behavior` ∈ {`auto`,`always`} — set
  under `conversation_config.agent` (verify exact nesting against the live API
  during implementation). Use `typing` + `always`.
- Existing pieces to reuse: `web/cloud/js/elevenlabs-signed-url.js` (browser-
  direct signed URL, #440), `web/static/js/features/elevenlabs-call.js`
  `buildClientTools()` (:65-77) + `startSession({ signedUrl, clientTools })`
  (:303-306), the in-tab dispatcher `window.CloudMCPDispatcher` (over the
  `mcp-responder.js` catalog: bp.list/create, weight.list/create,
  notes.list/create), the vault seam `settingsDomain.readIntegrationsUnmasked()`
  (`web/domain/settings.js`), and `apishim.js` publishing cloud modules on
  `window`.
- Vault `elevenlabs` record is `{ api_key, agent_id }` — `agent_id` becomes
  optional (the app creates + stores one). Persisting the provisioned agent id +
  a toolset version: extend the settings/integrations vault record or add a small
  vault record; keep it in the vault (never `/api`).

## Development Approach

- **Cloud-only, browser-direct, BYO key.** The ElevenLabs key is read from the
  vault and used only against `api.elevenlabs.io`; never crosses `/api`. Bot mode
  is untouched.
- **Idempotent provisioning.** A module-level `TOOLSET_VERSION` const; store the
  provisioned tool ids + agent id + version in the vault. On connect, reprovision
  only when the stored version differs (first run, or we bumped the toolset) —
  never on every call.
- **Concrete flat-param tools**, not the generic `mcp_call` — ElevenLabs tool
  params are flat typed values and voice LLMs use concrete tools reliably. Each
  maps 1:1 to a catalog op; the in-tab callback assembles the op params.
- Reuse the in-tab dispatch (no relay, instant). Publish new modules on `window`;
  allowlist any new global (`tests/architecture.globals.test.js`, CLAUDE.md #4).

## Testing Strategy

- Vitest (via `tests/helpers/frontend-harness.js`), mocking `fetch` to
  `api.elevenlabs.io`: (a) `ensureTools` is idempotent — `GET /v1/convai/tools`
  returning our tools → no re-create; missing → `POST` with the exact
  `tool_config` client shape; (b) `ensureAgent` creates once with `tool_ids` +
  prompt + `tool_call_sound`, stores agent id + version in the vault, reuses on
  matching version; (c) the `clientTools` callbacks map concrete tools to catalog
  ops — `log_blood_pressure({systolic,diastolic,pulse})` → dispatch `bp.create`
  with a stamped `measured_at` over an in-memory dispatcher;
  `get_blood_pressure({days})` → `bp.list`; (d) bot mode unaffected.
- The live voice call is manual acceptance (Post-Completion).

## Progress Tracking

- `[ ]` not started · `[x]` done · ➕ added · ⚠️ deviation

## Implementation Steps

### Task 1: Browser-direct ElevenLabs provisioning client

- [x] New `web/cloud/js/elevenlabs-agent.js`:
      `createElevenLabsAgentProvisioner({ settingsDomain })` reading the vault
      `elevenlabs.api_key`. A `TOOLSET_VERSION` const and a fixed tool spec list
      (name, description, flat params) for: `get_blood_pressure` (days?),
      `log_blood_pressure` (systolic, diastolic, pulse?), `get_weight`,
      `log_weight` (kg), `get_notes`, `add_note` (text, tag?).
- [x] `ensureTools()`: `GET /v1/convai/tools`, match our tools by name; `POST
      /v1/convai/tools` (the `tool_config` client shape above) for any missing;
      return a `{ name → id }` map. All with `xi-api-key`.
- [x] `ensureAgent(toolIds)`: if the vault has a stored agent id + matching
      `TOOLSET_VERSION`, reuse it; else `POST /v1/convai/agents/create` with the
      tool_ids, a strong system prompt (call the tools for any data question,
      never claim no access), `tts.voice_id`, and `tool_call_sound: 'typing'` +
      `tool_call_sound_behavior: 'always'`; persist `{ agentId, toolsetVersion,
      toolIds }` to the vault. (If the user pre-set an `agent_id`, `PATCH` that
      agent instead of creating one.) ➕ persistence added as a dedicated
      `voiceprovisioning` vault singleton via new
      `settingsDomain.get/setVoiceProvisioning` (object map won't round-trip the
      masked integrations record).
- [x] `provision()`: orchestrates ensureTools → ensureAgent, returns the
      `agentId`; clear errors on bad key/quota/agent-slot limits.
- [x] Publish from `apishim.js`: `window.CloudElevenLabsAgent =
      createElevenLabsAgentProvisioner({ settingsDomain: settings })`.

### Task 2: Signed URL + call flow use the provisioned agent

- [ ] Update `web/cloud/js/elevenlabs-signed-url.js` so `fetchSignedURL(agentId)`
      takes the provisioned agent id (fall back to the vault `agent_id` if set),
      not a required user-set one.
- [ ] In `web/static/js/features/elevenlabs-call.js` `startCall()` cloud branch:
      before minting the signed URL, `const agentId = await
      window.CloudElevenLabsAgent.provision();` then
      `fetchSignedURL(agentId)`. Surface provisioning errors as the call status.

### Task 3: Concrete client-tool callbacks → catalog

- [ ] In `buildClientTools()`, register callbacks whose names MATCH the
      provisioned tools, each dispatching in-tab into `CloudMCPDispatcher`:
      - `get_blood_pressure: ({days}={}) → mcp_call bp.list {days}`
      - `log_blood_pressure: ({systolic,diastolic,pulse}) → mcp_call bp.create
        {measured_at: <now ISO>, systolic, diastolic, pulse}`
      - `get_weight`/`log_weight`/`get_notes`/`add_note` likewise.
      Return concise text/JSON; catch dispatcher errors into a short string.
      JSON.parse any stringified object args.
- [ ] Keep the generic `mcp_help`/`mcp_call` too (harmless), but the concrete
      tools are the provisioned + used path.

### Task 4: Settings UX — key is enough

- [ ] `web/static/index.html` + `integrations.js`: mark the ElevenLabs **Agent
      ID** field optional with a hint that leaving it blank lets the app create
      the agent; update the API-key field hint to "Add your key — we set up the
      voice agent for you." No behavior change when an agent id IS provided
      (PATCH path).

### Task 5: Tests

- [ ] Add the Vitest cases in Testing Strategy (provisioner idempotency, tool
      create shape, agent create with tool_call_sound + version reuse, concrete
      callback → catalog mapping with measured_at stamping). Extend the existing
      `web/static/js/tests/features.elevenlabs-call.test.js` /
      `cloud.shim-contract.elevenlabs.test.js` rather than new coverage files.

### Task 6: [Final] Docs + verify

- [ ] `docs/cloud-mode.md` voice section: fully-from-code provisioning — user
      sets only the ElevenLabs API key; the app creates the tools + a MedTracker
      agent (tool-call sound on); reads and writes vault data by voice; nothing
      touches the ElevenLabs dashboard. Note the browser-direct BYO-key leakage
      row (key used against api.elevenlabs.io only).
- [ ] `go build ./...` + `pnpm test` green; new `window.*` globals allowlisted.

## Technical Details

- System prompt (agent): instruct it to ALWAYS call a tool for any question about
  the user's blood pressure / weight / notes (e.g. "For blood pressure questions
  call get_blood_pressure; to log one call log_blood_pressure. Never say you
  can't access the data — call the tool."). This is what makes the agent
  "understand what to do" without dashboard work.
- Writes stamp `measured_at`/timestamps = now (ISO) client-side, matching the
  catalog op schemas (`bp.create` requires `measured_at`, `systolic`,
  `diastolic`).

## Post-Completion (manual acceptance — fully hands-off)

- cloud Settings → Integrations → set ONLY the ElevenLabs API key → Save.
- Call Agent on an unlocked device (app auto-provisions tools + a MedTracker
  agent on first connect) → "what's my last blood pressure?" → reads vault data
  aloud with an audible typing sound on the tool call → "log a blood pressure of
  120 over 80" → a reading appears in the app. No ElevenLabs dashboard steps.
- If ElevenLabs API shapes differ from the spike (field nesting, tool_call_sound
  location), adjust against the live API — the endpoints + discriminators are
  confirmed; exact nesting is the only implementation risk.
