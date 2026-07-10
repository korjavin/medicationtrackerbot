# Cloud mcp_call envelope parity: path_params, body, write-intent gating, anti-replay

## Overview

Bot mode's `mcp_call` accepts a full envelope — `operation_id`, `params`, `path_params`, `body`, `mode`,
`intent` (`internal/mcp/call.go:21-26`). Cloud mode's dispatcher accepts only `{op, params}`. Consequences:

- **No write op can be expressed safely** — there is no `mode`/`intent` gating, so a write is
  indistinguishable from a read.
- **No `/{id}/` op can be expressed at all** — there is nowhere to put path params.
- **No request body** — write payloads have no channel.
- **No schema validation** — bot mode attaches warn-only warnings via `registry.ValidateInput`; cloud
  attaches nothing.
- **No anti-replay** — `mcp-responder.js:372-374` says so outright: *"ponytail: no anti-replay/dedup — the
  blind relay could replay a captured write frame and this re-executes it."* A remote LLM retrying a POST,
  or a malicious relay replaying a captured frame, double-logs an intake.

This plan widens the cloud envelope to bot-mode parity and closes the replay hole.

Integration: med-csu.1 landed a generated catalog (`web/cloud/js/mcp-catalog.generated.js`) carrying per-op
`path_params`, `params_schema`, `body_schema`, `risk`, and `required`. That catalog is the source of truth for
gating and validation here — nothing is re-derived.

### Scope fence

Widening the **envelope and gating** only. Dispatch wiring of the ~98 catalogued ops is **med-csu.3**; the six
wired ops (`health.bp.list`/`create`, `weight.list`/`create`, `health.notes.list`/`create`) stay the only
dispatchable ones, and a catalogued-but-unwired op keeps returning its existing actionable error.

Explicitly **not** in scope: `mcp_execute` (no cloud path — med-csu.4), OAuth, and the 4409 replaced-pairing
race (med-csu.5). **Do not invent new WebSocket close codes or wire fields** beyond the envelope below.

## Context (from discovery)

**The envelope is duplicated in three places that must stay in lockstep** (by design — `mcp_endpoint.go:49-51`
says "duplicated rather than imported because cmd/mcpshim is package main"):

1. `web/cloud/js/mcp-responder.js` — `createDispatcher`'s `mcp_call` branch reads `params.op` + `params.params`.
2. `cmd/mcpshim/main.go:30-34` — `callInput{Op, Params}` (Tier 1 shim).
3. `internal/cloudserver/mcp_endpoint.go:51-54` — `mcpEndpointCallInput{Op, Params}` (Tier 2 hosted endpoint).

**Bot-mode reference semantics** (`internal/mcp/call.go`):
- `:70-78` — `mode` defaults to `proxy.ModeReadOnly`; must be `ModeReadOnly` or `ModeWrite`;
  `mode == ModeWrite && strings.TrimSpace(input.Intent) == ""` is an error.
- `:118-121,140` — `registry.ValidateInput(op, params, body)` returns `[]string` warnings, appended to the
  response's `Warnings []string json:"warnings,omitempty"`. The comment at `:118` is explicit: *"ValidateInput
  never blocks: a missing or mistyped field produces a warning."* Mirror that; do **not** diverge into blocking.

**Corrections to assumptions (verified, trust these over any earlier brief):**
- `BY_ID` at `mcp-responder.js:45` is a module-local `const`, **not exported**. It is built from `CATALOG` via
  `Object.create(null)` (prototype-free). Export it if the tests need it; do not assume it is already exported.
- `createResponder({ pairingId, key, records, now, timeZone, relayURL, onStalePairing })` — the `records` port
  is the **vault-synced** records port. It is the WRONG store for nonces: every put replicates through the
  encrypted oplog to every device. Do not persist nonces there.
- `web/cloud/js/localdb.js` `openDb()` exposes a local-only, never-synced key-value `device` object store
  (`localdb.js:16`), alongside `records` / `pending` / `sync_meta`. That is the right store, and using a single
  key inside it needs **no schema version bump**.

**Frame format** (`internal/mcpshim/frame.go:10-11`, browser side `crypto.js:352-357`):
```
frame = nonce(12) ‖ AES-GCM(key, payload, aad)
aad   = encodeFields("mt/v1/mcp", pairing_id)
```
The sender picks a fresh random nonce (`rand.Read`, `frame.go:70-72`).

**Dependencies**: none new.

## Development Approach

- **Testing approach**: NO unit tests. They blow up the codebase for no value here.
  - add an integration test ONLY when it covers a real boundary (API contract, data migration, cross-component flow) and gives a guarantee manual checking can't
  - if no integration test adds a real guarantee, the task has NO test items — that is correct and expected
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: if a task adds an integration test, it must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Maintain backward compatibility — existing pairings send `{op, params}` and must keep working.

## Testing Strategy

- **Unit tests**: none.
- **Integration tests**: three, each guarding a boundary manual checking cannot:
  1. **Replay** — the *same sealed frame* delivered twice produces exactly **one** record. This must be driven
     through `createResponder`'s frame path (a real sealed frame via `sealMCPFrame`), **not** by calling the
     dispatcher twice: the dedupe lives at the frame layer, so a dispatcher-level test would prove nothing.
  2. **Write gating** — a `risk: 'write'` op without `mode: 'write'` is refused; with `mode: 'write'` and a
     non-empty `intent` it succeeds.
  3. **Envelope lockstep** — the three duplicated definitions carry the same field set. They drift silently.
- Extend the **owning** suites (CLAUDE.md rule 8): `web/cloud/js/tests/mcp-responder.test.js` for the
  responder; `internal/cloudserver`'s existing MCP tests for the Go side. Do **not** create new
  `*-branches` / `*-edges` / `pin-defect-N` files.
- **E2E**: none.

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope
- Keep plan in sync with actual work done

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): code, docs, and the three integration tests above
- **Post-Completion** (no checkboxes): manual verification against a real connector

## Implementation Steps

### Task 1: Widen the cloud mcp_call envelope in the dispatcher
- [x] in `web/cloud/js/mcp-responder.js`, accept the full envelope in `createDispatcher`'s `mcp_call` branch: `operation_id` (primary) with `op` as a back-compat alias, plus `params`, `path_params`, `body`, `mode`, `intent`
- [x] resolve the op via the existing `BY_ID` map; keep the existing "catalogued but not yet callable" error and the unknown-op did-you-mean path exactly as they are
- [x] default `mode` to read-only when absent, matching `internal/mcp/call.go:70-73`; reject any `mode` that is neither read-only nor `'write'`
- [x] export `BY_ID` (it is currently a module-local `const` at `:45`) only if the tests need it — otherwise leave it private (left private: no test needs it)
- [x] keep the six wired dispatch entries unchanged (scope fence)

### Task 2: Path-param substitution validated against the catalog allowlist
- [ ] add a helper that substitutes `path_params` into the op's `path` `{placeholder}` slots
- [ ] validate against the op's catalog `path_params` allowlist: reject an unknown placeholder name, and reject a `path` placeholder left unsubstituted — both with a clear numeric-code JSON-RPC error
- [ ] ensure a caller-supplied path param cannot inject a `/` or otherwise escape its slot (encode it)
- [ ] leave `body` pass-through in place for write ops

### Task 3: Write-intent gating
- [ ] refuse any op whose catalog `risk === 'write'` unless `mode === 'write'` — the error must be actionable, naming both `mode: 'write'` and `intent` so an agent can self-correct on the next call
- [ ] refuse `mode === 'write'` with an empty/whitespace `intent`, mirroring `call.go:78`
- [ ] confirm the error surfaces as a **numeric** JSON-RPC code — `handleRequest` maps non-numeric `e.code` to `-32602` because the Go shim decodes `error.code` into an `int64` and silently drops the frame otherwise (that comment is in `handleRequest`; do not regress it)
- [ ] integration test: a `risk: 'write'` op refused without `mode: 'write'`, accepted with `mode` + `intent`

### Task 4: Warn-only schema validation mirroring registry.ValidateInput
- [ ] validate `params` against the op's catalog `params_schema` and `body` against `body_schema`, plus the catalog's precomputed `required` field names
- [ ] attach the result as a `warnings` array on the successful response; **never block the call** — `call.go:118` is explicit that a missing or mistyped field produces a warning, not an error
- [ ] keep the warning strings close in wording to `registry.ValidateInput`'s so an agent sees the same guidance on both surfaces
- [ ] integration test: a schema-mismatched call still succeeds and carries `warnings`

### Task 5: Anti-replay via a persisted seen-nonce cache (no wire change)
- [ ] **Decision, do not re-open.** A replayed frame carries a byte-identical 12-byte GCM nonce (`frame.go:70-72` picks it randomly per frame). A seen-nonce set on the responder therefore rejects replays with **zero wire-protocol change** and no change to `mcpshim` or either relay tier. A repeated GCM nonce under one key is always either a replay or a catastrophic sender bug — reject either way. *(Rejected: deterministic record ids — `web/domain/notes.js` derives ids monotonically via `nextId` with `Number(recordId)` sorting and `before_id` pagination, and `bp.js` uses `genId(nowMs)`; threading caller ids would rewrite every domain module's id contract. Rejected: binding a per-connection counter into the AAD — that is a wire-format change across mcpshim + both tiers, i.e. inventing protocol, and is what `mcp-responder.js:372-374` sketches. Leave it for a future bead if the nonce cache proves insufficient.)*
- [ ] dedupe **write frames only** — a replayed read is idempotent and harmless. Decide write-ness from the resolved op's catalog `risk`, after decrypt and parse but before dispatch
- [ ] persist the seen-nonce ring in `localdb.js`'s local-only, never-synced `device` key-value store (`localdb.js:16`), under one key per pairing id. Do **not** use the `records` port — it is the vault-synced oplog and would replicate every nonce to every device
- [ ] bound the ring (FIFO, a few thousand entries) so it cannot grow without limit; a single key holding a bounded array needs no `openDb()` schema version bump
- [ ] persistence is the point: an in-memory-only `Set` is defeated by a malicious relay that simply waits for a tab reload
- [ ] a duplicate write nonce must be dropped **without dispatching** and without corrupting the JSON-RPC stream — decide and comment whether the responder replies with an error or stays silent, and make the test assert whichever is chosen
- [ ] delete the now-stale `ponytail: no anti-replay/dedup` comment at `mcp-responder.js:372-374` and replace it with one naming what IS now enforced (write-frame nonce dedupe, persisted, bounded) and what is NOT (no AAD counter; a read frame may still be replayed)
- [ ] integration test: seal ONE frame for a write op, deliver it to `createResponder`'s frame handler twice, assert exactly one record exists afterward. Drive real `sealMCPFrame`/`openMCPFrame` — not two dispatcher calls

### Task 6: Bring the two Go envelope definitions to parity
- [ ] widen `cmd/mcpshim/main.go`'s `callInput` (`:30-34`) to the full envelope: `operation_id` primary, `op` alias, plus `params`, `path_params`, `body`, `mode`, `intent`
- [ ] widen `internal/cloudserver/mcp_endpoint.go`'s `mcpEndpointCallInput` (`:51-54`) identically
- [ ] update the `jsonschema:` tags so the hosted endpoint and the shim both advertise the new fields to the MCP client (an agent cannot pass `mode` if the tool schema does not declare it)
- [ ] keep the two structs field-for-field identical — they are duplicated deliberately and drift silently
- [ ] integration test: assert the three definitions carry the same field set (a table-driven check over the JSON tags is enough; it is the only thing standing between them and silent drift)

### Task 7: Verify acceptance criteria
- [ ] verify the bead's criteria: a cloud `mcp_call` can express a path-param op and a write op with intent; a replayed write frame is applied exactly once; schema-mismatch produces the same warn-only warnings as bot mode
- [ ] adversarially verify the replay guard: remove the dedupe line, confirm the replay test **fails**, restore it. A guard that cannot fail is not a guard
- [ ] verify backward compatibility: an old-style `{op, params}` read call still works unchanged
- [ ] verify edge cases: unknown `mode`; `mode: 'write'` with whitespace-only `intent`; a path param containing `/`; a write op replayed across a simulated reload (re-open the persisted ring)
- [ ] run `go build ./...` — must pass
- [ ] run `go test ./...` — must pass
- [ ] run `pnpm test` — must pass
- [ ] run the linter — all issues must be fixed

### Task 8: [Final] Update documentation
- [ ] update `docs/cloud-mode.md`'s MCP section: the cloud `mcp_call` envelope now matches bot mode; write ops require `mode: 'write'` + `intent`; write frames are deduped by GCM nonce, persisted per-pairing and bounded
- [ ] state the residual gap plainly so the doc does not overclaim: read frames are not deduped, and there is no AAD-bound counter (med-csu.5 / future work)
- [ ] note that catalogued ops remain undispatchable until med-csu.3

## Technical Details

**Envelope (all three definitions):**

| field | type | notes |
|---|---|---|
| `operation_id` | string | primary; bot-mode parity |
| `op` | string | back-compat alias, existing pairings send this |
| `params` | object | query-style params |
| `path_params` | object | substituted into `{placeholder}` slots, allowlisted by catalog |
| `body` | object | write payload |
| `mode` | string | absent → read-only; `'write'` required for `risk: 'write'` ops |
| `intent` | string | required, non-empty, when `mode === 'write'` |

**Why nonce dedupe is at the frame layer, not the dispatcher.** The replay threat is a *frame* replayed by the
relay. By the time a request reaches the dispatcher the frame is already decrypted and its nonce discarded, so
a dispatcher-level guard would have to invent its own request id — which the attacker controls. Dedupe where
the uniqueness is cryptographically guaranteed: the GCM nonce.

**Why write-only dedupe.** A replayed `bp.list` returns the same rows; nothing changes. Deduping reads would
bloat the ring for no security gain and would break a legitimate agent that polls the same op.

**Backward compatibility.** `op` remains accepted, `mode` absent means read-only, and the six wired ops are all
reads plus creates — the creates are `risk: 'write'`, so an old client that calls `bp.create` without `mode`
will now be **refused**. That is the intended security fix, not a regression; call it out in the docs task, and
make the error message name `mode`/`intent` so the agent self-corrects.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only*

**Manual verification**
- Drive a real claude.ai connector: confirm `mcp_call` with `mode: 'write'` + `intent` logs one BP reading, and
  that omitting `mode` returns an error naming the missing fields.
- Confirm an old shim binary sending `{op, params}` for a read still works against the new responder.

**Security review**
- The nonce ring is per-pairing and bounded; a relay that floods distinct nonces evicts old entries and could
  eventually replay a very old frame. Quantify the ring size against realistic frame rates, and note that the
  AAD-counter design (`mcp-responder.js:372-374`) is the durable fix if that bound proves too weak.

**Follow-on beads**
- **med-csu.3** — wire the dispatcher to every ported `web/domain/` module (unblocked by this bead).
- **med-csu.4** — document that `mcp_execute` has no cloud path.
- **med-csu.5** — the dropped 4409 replaced-pairing race.
