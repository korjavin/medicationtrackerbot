# Cloud C4 PoC follow-up — Connect Claude discoverability + instructions

## Overview

The C4 PoC (PR #426) shipped the full blind-relay pipeline, but the user-facing entry point is buried: "Connect Claude" is a button on the `/devices` shell page, nothing on the Settings screen names it, the one-time code screen gives only a terse two-line hint, and no doc tells a user how to connect Claude end to end. A user who knows the feature exists cannot find it; one who finds it gets no `claude mcp add` command, no "keep a tab open" requirement, and no warning that a cloud-server restart voids the pairing.

Scope: **discoverability + instructions only.** No relay/crypto/shim behavior changes; PoC ceilings (in-memory pairings, single pairing, hardcoded catalog) stay as-is pending the exit review.

## Context (from discovery)

- Entry point today: Settings → cloud-only "Devices" row (`web/static/js/features/settings.js:94-99` reveals `.wg-settings-cloud-devices`) → `/devices` page → `Connect Claude` button (`web/cloud/js/devices.js:56`), status line `Claude connector: linked / not connected` (`devices.js:75`).
- One-time code screen: `renderClaudeCode` (`devices.js:95-123`) — shows the `mtmcp1.…` code + a Claude **Desktop** JSON snippet with copy buttons, and a two-line "build the shim" hint. No `claude mcp add` CLI line, no keep-tab-open note, no restart caveat.
- Pairing lifecycle: `web/cloud/js/mcp-pairing.js` (mints pairing, stores `mcppairing` singleton vault record); any unlocked tab auto-starts the responder (`cloud-boot.js:117-122`).
- Shim: `cmd/mcpshim` (env `MEDTRACKER_MCP_CODE`; errors clearly when unset — `main.go:49-51`). No packaged binary (PoC ceiling) — users build from the repo.
- Restart caveat source: relay pairing table is in-memory (`internal/cloudserver/mcp_relay.go`, `ponytail:`-marked) — server restart requires Disconnect + Connect again.
- Docs today: `docs/cloud-mode.md` "MCP" section describes the architecture/tiers, not a user how-to. `docs/features.md` has no Claude-connector entry.

## Development Approach

- **CRITICAL: no behavior changes** to relay, shim, pairing crypto, or responder. UI + docs only.
- Settings row follows the existing cloud-only-row pattern (`.wg-settings-cloud-devices` gate); no new `window.*` globals; no inline styles (design tokens / existing wizard classes only).
- Keep the Settings row static (a link — "Claude connector →" to `/devices`); live linked/not-linked status stays on the Devices page where it already renders. ponytail: status-on-Settings would need vault reads from `web/static`; not worth it for a PoC.
- Instructions must match reality: the exact `claude mcp add` one-liner, the Desktop JSON alternative (already rendered), keep-an-unlocked-tab-open, one pairing per account, restart-voids-pairing.

## Testing Strategy

- **Integration (Vitest)**: extend the existing devices/settings suites — Settings shows the Claude row only in cloud mode; Connect Claude screen renders the CLI one-liner containing the minted code; instruction block lists the tab-open + restart caveats.
- **E2E**: manual rig pass (this plan exists so the user can run the C4 exit review without archaeology).

## Progress Tracking

- `[ ]` not started · `[x]` done · ➕ added during implementation · ⚠️ deviation, explain inline

## Implementation Steps

### Task 1: Settings entry point

- [ ] Add a cloud-only "Claude connector" row to the Settings screen next to the Devices row (same `.wg-settings-*` block + `settings.js:94-99` gate pattern), linking to `/devices`. Row subtitle: "Let Claude read and update your data — end-to-end encrypted".
- [ ] Rename nothing else; the Devices page remains the single management surface.
- [ ] Test: settings feature suite — row visible when `window.__MEDTRACKER_CLOUD__`, absent otherwise.

### Task 2: Connect Claude screen — real instructions

- [ ] Rework `renderClaudeCode` (`web/cloud/js/devices.js`) into numbered steps:
  1. Save the pairing code (shown once) — copy button (existing).
  2. Build the shim: `go build ./cmd/mcpshim` in the repo (link to repo URL). ponytail: no packaged binary yet, per PoC ceilings.
  3. Register with Claude Code: `claude mcp add medtracker -e MEDTRACKER_MCP_CODE=<code> -- /path/to/mcpshim` — rendered with the real code, copy button. Keep the existing Claude Desktop JSON snippet as the alternative.
  4. Requirements note: keep an unlocked app tab open (any tab answers); one pairing per account; **a cloud-server restart voids the pairing — Disconnect and re-connect if Claude reports the device offline after a deploy**.
- [ ] Secrets stay `textContent`-only (existing rule in this file — the page holds the DEK).
- [ ] Show the same requirements note (minus the code) on the Devices page when a pairing is linked, so the caveats are re-findable after the one-time screen is gone.
- [ ] Test: devices suite — CLI one-liner contains the minted code; caveats block present in both places.

### Task 3: [Final] User-facing docs

- [ ] `docs/cloud-mode.md` MCP section: add a short "Connecting Claude (PoC)" how-to — where the button lives, the 4 steps above, the caveats, Disconnect.
- [ ] `docs/features.md`: one entry pointing at it.
- [ ] Verify: `pnpm test` green; manual rig walkthrough per the C4 plan's Post-Completion steps now doable from the UI + docs alone, no repo archaeology.

## Post-Completion

- Feeds the C4 exit review (latency / reconnect / tab-lifecycle go-no-go). If the review says go, full C4 picks up: packaged shim binary, QR pairing, persistent pairings, generated catalog — none of which belongs here.
