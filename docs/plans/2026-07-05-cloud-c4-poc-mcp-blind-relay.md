# C4 PoC: MCP Blind Relay — Claude ↔ Encrypted Vault, End to End, Minimal

## Overview

Proof-of-concept for cloud-mode MCP tier 1 (docs/cloud-mode.md → "MCP",
Tier 1): Claude Desktop / Claude Code runs a **local Go stdio shim**, the
shim speaks ciphertext frames over WebSocket to a **blind relay** on
`cmd/cloud`, and the relay pipes them to the user's **unlocked browser
tab**, which answers from the in-browser domain layer. The server sees
sizes and timing, never content.

This is deliberately a PoC, not full C4. Goal: prove the four risky parts
before investing —

1. WS relay works behind Traefik on the real rig;
2. pairing + E2E frame crypto (shim ↔ browser, relay blind) is sound and
   implementable on both sides;
3. an unlocked PWA tab is a viable MCP responder (latency, reconnects,
   tab lifecycle);
4. Claude actually drives it: `mcp_help` → `mcp_call` → real vault data
   round-trips into a Claude conversation.

**Locked decisions** (from design review):
- **No npm.** The shim is a Go binary (`cmd/mcpshim`) using the already-
  vendored `modelcontextprotocol/go-sdk` stdio transport. Built from the
  repo (`go build ./cmd/mcpshim`); distribution polish is full-C4 scope.
- **Catalog codegen is full-C4 scope; the PoC hardcodes** a tiny catalog
  (see Task 3) with a `// ponytail:` marker pointing at the codegen plan.
  Full C4 will generate the catalog JSON from `internal/mcp/registry` and
  filter it to the ported-domain set.
- **Offline-device UX is a first-class requirement**: when no unlocked
  device is connected, the shim's tools return a clear, actionable MCP
  error ("No unlocked Med Tracker device is online. Open your app at
  https://<sub>.<base> and unlock it, then retry — this connector talks to
  your device, not to a server, because your data is end-to-end
  encrypted."). Tool descriptions state the same constraint up front so
  the model can relay it.
- **`mcp_execute` stays parked** (open question in cloud-mode.md).

## Context (from discovery)

- Design: docs/cloud-mode.md "MCP" section, Tier 1 diagram — shim ↔ wss
  ciphertext ↔ relay ↔ device. Pairing: one-time code carrying relay
  endpoint + shared session key.
- MCP SDK: `github.com/modelcontextprotocol/go-sdk` already in go.mod
  (used throughout `internal/mcp`); it provides the stdio server side for
  the shim. Follow `internal/mcp`'s tool-registration idioms.
- No WebSocket dependency exists yet — add `github.com/coder/websocket`
  (pure Go, maintained, CGO-free; keeps the mobile cross-compile story).
- Relay lives in `internal/cloudserver` (new `mcp_relay.go`), routes on
  the account subdomain under `/api/mcp/relay/*`. cloudserver routes are
  NOT under the bot-mode MCP-coverage guard (that test covers
  `internal/server` only) — no exemption entries needed.
- Browser side: `web/cloud/js/` owns crypto (`crypto.js` HKDF/AES-GCM
  helpers), the unlocked ctx (`{accountId, dek}`), and the domain
  instances (`web/domain/bp.js`, `weight.js`, C2a's `notes.js` if merged).
  The responder is a new module wired from the unlocked boot path
  (`cloud-boot.js`), NOT from web/static (zero bot-mode surface).
- Traefik: WS passes through Traefik v3 by default (no special labels for
  same-origin wss on an existing router); verify on the rig — that's half
  the point of the PoC.

## Development Approach

- **Testing approach**: NO unit tests. They blow up the codebase for no value here.
  - add an integration test ONLY when it covers a real boundary (API contract, data migration, cross-component flow) and gives a guarantee manual checking can't
  - here: ONE Go integration test driving the full loop in-process (shim
    core ↔ relay ↔ fake device responder) — the E2E-crypto + framing
    contract; browser responder dispatch gets one Vitest case
- PoC posture: smallest honest implementation; every deliberate ceiling
  gets a `ponytail:` comment naming the full-C4 upgrade path
- **CRITICAL: bot-mode must not regress.** No `internal/server`/`web/static`
  changes at all in this plan; `go test ./...` (both tags) + `pnpm test`
  green after every task
- **CRITICAL: update this plan file when scope changes during implementation**

## Testing Strategy

- **Unit tests**: none.
- **Integration tests**: one Go test (relay + shim core + fake device, full
  encrypted round-trip incl. the no-device-online error path); one Vitest
  (responder dispatches `mcp_call` to a domain instance over the in-memory
  records port and produces the wire response shape).
- **E2E tests**: none — the rig walkthrough in Post-Completion is the PoC's
  real acceptance.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix

## Implementation Steps

### Task 1: Blind relay endpoint in cloudserver

- [x] `internal/cloudserver/mcp_relay.go`: in-memory pairing table
      (pairing id → device conn / shim conn, TTL ~24h, single shim + single
      device per pairing — `ponytail:` multi-pairing later if wanted)
- [x] `GET /api/mcp/relay/device` (WS upgrade; auth: existing session
      cookie + account context) and `GET /api/mcp/relay/shim?pairing=<id>`
      (WS upgrade; auth: possession of the pairing id — the E2E key is the
      real secret and the relay never has it; pairing ids are single-use,
      bound to the account that minted them)
- [x] relay behavior: pipe opaque binary frames both ways, no inspection,
      no buffering beyond one in-flight frame per direction (PoC), close
      both ends when either drops; frame size cap (64 KiB) and a
      per-pairing rate limit reusing the repo's limiter idiom
- [x] `POST /api/mcp/pairings` (session-authed): mint `{pairing_id}`;
      DELETE to revoke; pairings die with process restart (in-memory —
      `ponytail:` persist if PoC graduates)
- [x] add `github.com/coder/websocket`; Go integration test: two test WS
      clients through the real handler — frames pass opaque, cross-pairing
      access rejected, dead-peer close propagates

### Task 2: Pairing + frame crypto (shared contract)

- [x] pairing code format (client-generated, shown once):
      `mtmcp1.<base64url(json{relay_url, pairing_id, key})>` where `key` is
      32 random bytes from the browser; the code never touches the server
      (the POST from Task 1 registers only the id)
- [x] frame format (both directions): `nonce(12) ‖ AES-GCM(key, payload,
      aad="mt/v1/mcp"‖pairing_id)`; payload = one JSON-RPC MCP message;
      document in the plan-adjacent code comment as the wire contract
- [x] Go side: `internal/mcpshim/` package (shim core, importable by the
      test): dial, encrypt/decrypt, request/response correlation by
      JSON-RPC id, 30s per-call timeout → the offline-device error text
- [x] browser side: extend `web/cloud/js/crypto.js` with the same
      seal/open (reuse existing AES-GCM helpers; no new primitives)

### Task 3: Browser responder — catalog + dispatcher

- [x] `web/cloud/js/mcp-responder.js`: connects to `/api/mcp/relay/device`
      when a pairing exists and the vault is unlocked; decrypts frames,
      dispatches, encrypts responses; reconnect with backoff while the tab
      lives; visibly indicates "Claude connector: linked/active" in the
      settings screen it's minted from
- [x] hardcoded PoC catalog (one static JS object, `ponytail:` replaced by
      registry codegen in full C4): `bp.list`, `bp.create`, `weight.list`,
      `weight.create`, plus `notes.list`/`notes.create` if C2a is merged
      by then — each with description + input schema matching the
      registry's shapes for those ops
- [x] `mcp_help` returns the catalog (+ a `usage_protocol` string that
      names the online-device constraint); `mcp_call` maps op → the
      existing domain instances (same construction path as apishim);
      errors mirror registry semantics (unknown op → did-you-mean over the
      tiny catalog)
- [x] Vitest: responder dispatch over in-memory records port — `mcp_call`
      for `bp.create` then `bp.list` round-trips and returns wire-shaped
      JSON

### Task 4: Pairing UI in the cloud app

- [x] settings/devices screen (cloud shell surface, `web/cloud/js/`):
      "Connect Claude" → POST pairing, generate key, render the one-time
      code (copy button; QR unnecessary for PoC) + the exact shim config
      snippet to paste into Claude Code/Desktop (`command: <path>/mcpshim`,
      `env: MEDTRACKER_MCP_CODE=...`)
- [x] "Disconnect" → DELETE pairing + drop the stored key (key lives in a
      vault record `mcppairing` so any unlocked device can answer —
      `ponytail:` single pairing record, per-device pairings later)

### Task 5: The shim — `cmd/mcpshim`

- [ ] stdio MCP server via `modelcontextprotocol/go-sdk` exposing exactly
      two tools, `mcp_help` and `mcp_call`, whose descriptions state the
      E2E architecture and the online-device requirement in one sentence
- [ ] reads `MEDTRACKER_MCP_CODE`; dials the relay; forwards tool calls as
      encrypted frames via `internal/mcpshim`; no device / timeout →
      the actionable error text (locked decision above)
- [ ] no config file, no flags beyond `-version` (PoC); reconnects on
      drop; logs to stderr only (stdout is the MCP transport)
- [ ] Go integration test (the one that matters): in-process relay +
      fake device (Go crypto from Task 2) + shim core — `mcp_help` and
      `mcp_call` round-trip ciphertext through the relay; kill the fake
      device → next call returns the offline error within the timeout

### Task 6: Verify acceptance criteria

- [ ] full loop green in tests; `go build ./... && go build -tags mobile
      ./...`, `go test -count=1 ./...`, `pnpm test` all green
- [ ] run linters — all issues fixed
- [ ] arch boundaries hold: no `internal/server` or `web/static` diffs in
      this plan; `cmd/mcpshim` pulls no store/domain packages (transport +
      crypto only — verify with `go list -deps`, same idiom as
      `internal/cloudstore/arch_test.go`)

### Task 7: [Final] Update documentation

- [ ] `docs/cloud-mode.md` MCP section: mark Tier-1 PoC implemented, add
      the pairing-code + frame-format contract, restate the four locked
      decisions (Go shim / codegen-in-full-C4 / offline-UX / executor
      parked), and add the leakage-table row: MCP frame sizes + timing →
      cloud (tier 1), content → nobody
- [ ] `docs/cloud-deployment.md`: one "Connect Claude (PoC)" subsection —
      build the shim, paste the code, Claude Code config snippet
- [ ] `CLAUDE.md`: add `cmd/mcpshim` to the entry-points list

## Technical Details

- **Trust recap**: the relay authenticates *routing* (session cookie on the
  device leg, single-use pairing id on the shim leg) but confidentiality
  rests entirely on the pairing key, which the server never sees (the code
  is generated and displayed client-side). A malicious relay can drop or
  delay frames — it cannot read or forge them (AEAD with pairing-bound AAD).
- **Tab lifecycle honesty**: the responder lives in an open unlocked tab.
  Backgrounded/closed tab = offline connector; that's the accepted tier-1
  availability model, surfaced through the shim's error text. SW-based
  answering is NOT attempted (SWs can't hold WS reliably) — full C4 may
  revisit.
- **Why `internal/mcpshim` is a package**: the integration test needs the
  shim's crypto/framing without spawning a subprocess; `cmd/mcpshim` stays
  a thin main.
- **What graduating to full C4 adds** (explicitly out of PoC): catalog
  codegen from `internal/mcp/registry` + drift guard test, ported-set
  filtering, shim binary distribution (release artifact), multi-pairing +
  persistence, per-op input validation warnings, reconnect hardening,
  maybe QR pairing. The PoC's exit review decides whether tier 1 earns
  that investment.

## Post-Completion

*No checkboxes — informational.*

**The actual PoC acceptance — manual, on the Hetzner rig:**
1. deploy; open the unlocked app; Connect Claude → pairing code
2. laptop: `go build ./cmd/mcpshim`, add to Claude Code MCP config with the
   code in env
3. in Claude Code: "what BP readings do I have?" → `mcp_help` → `mcp_call
   bp.list` → real vault data appears in the conversation; add a reading
   via `bp.create` and see it in the PWA instantly
4. close the tab → ask again → clean "open your app" error, no hang
5. check Traefik: wss upgrade works through the existing router; check
   `cloud admin inspect`: nothing new leaks (pairing ids only)
6. **exit review**: latency feel, reconnect pain, tab-lifecycle annoyance —
   decide go/no-go on full C4 investment

**Known PoC ceilings** (all `ponytail:`-marked in code): in-memory
pairings (restart = re-pair), single pairing per account, hardcoded
catalog, no QR, no packaged binary.
