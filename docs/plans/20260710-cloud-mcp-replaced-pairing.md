# Cloud MCP relay: close a replaced pairing's device leg instead of letting it squat

## Overview

After a re-pair, the cloud MCP connector goes silently dead. Verified against current `master`
(`fcb04dfb`), not inferred:

1. `mcp_relay.go`'s **device** leg resolves the pairing with `a.pairings.byAccountID(session.AccountID)` —
   it binds to whatever the account's *current* pairing record is, and never checks which pairing the
   connecting responder actually holds.
2. `pairingRecord.join` (`mcp_relay.go:357`) **evicts** any existing leg in the slot (last-writer-wins,
   `CloseNow`).
3. An undecryptable frame is **silently dropped** by the responder (`openMCPFrame` catch → bare `return`).

So: tab A holds the old pairing P1 (key K1). The user re-pairs; the account's pairing becomes P2 (key K2) and
tab B holds it. Tab A's socket drops, it reconnects, `byAccountID` hands it **P2's device slot**, and `join`
**evicts tab B**. The shim — connected on P2 and sealing with K2 — now sends frames to tab A, which cannot
decrypt them and drops them without a word. Tab A keeps reconnecting on backoff, re-evicting tab B each time.

Result: the connector looks alive, every `mcp_call` times out, and nothing logs an error. The device leg is
squatted by a tab holding a dead key.

**The fix**: the device leg must prove which pairing it holds. A leg whose pairing id is not the account's
current one is closed with a distinct code, and the responder treats that code as terminal-but-not-purgeable.

### Why this is a separate bead (and what to reuse)

This work was originally written as a drive-by inside med-csu.1's review pass and **dropped from PR #525**
rather than merged unreviewed — it invents a WebSocket close code, which is a wire-contract change and had no
business riding along in a codegen PR. It is recoverable in full:

```
git show 76bebda3   # ~357 lines across relay, responder, mcp-pairing.js, + tests
```

That commit is a **reference, not a cherry-pick target**: `mcp-responder.js` has since been rewritten twice
(PR #526's envelope + nonce ring, PR #527's injected-router adapter), so its hunks will not apply. Read it for
the design, re-implement against current `master`.

**Blast radius is small, which is why the close code is acceptable here.** The device leg runs between the
browser responder and the relay, and both ship from the same deploy (`web/cloud` is embedded into `cmd/cloud`).
The Go shim (`cmd/mcpshim`) — the only independently-versioned binary — uses the `/claude` leg and is untouched.

## Context (from discovery)

**Files involved**
- `internal/cloudserver/mcp_relay.go` — `StatusNoPairing = 4404` already exists (PR #521). The device-leg
  handler resolves by `byAccountID`; `pairingRecord.join` at `:357` evicts with `CloseNow` (the comment there
  explains why graceful `Close` would stall every account: it blocks ~10s while `p.mu` is held).
- `internal/cloudserver/mcp_relay_test.go` — existing relay tests, incl. PR #521's 4404 regression tests.
- `web/cloud/js/mcp-responder.js` — `STATUS_NO_PAIRING`, `onStalePairing()`, the `onclose` close-code branch,
  `wsURL()` (currently sends **no** query param on the device leg), and the Web-Lock tab election
  (`controllerCtx` / `reconcile` / `stopResponder`).
- `web/cloud/js/mcp-pairing.js` — `purgePairing(ctx)` (deletes the vault record, no DELETE request) and
  `disconnectClaude(ctx)`.
- `web/cloud/js/tests/mcp-responder.test.js` — the owning vitest suite (CLAUDE.md rule 8).

**The distinction that matters** (this is the subtle part, and where the original work earned its keep):

| close code | meaning | responder must |
|---|---|---|
| `4404` `StatusNoPairing` | account has **no** pairing at all | stop, and **purge** the vault record — nothing to revoke |
| new: `4409` replaced | account **has** a live pairing, just not this one | stop, and **not** purge — the vault record now names the *replacement*, and purging would delete the user's live pairing account-wide |

The vault record syncs across devices. A tab that purges on "replaced" destroys the pairing every other device
just adopted. So the two cases cannot share a handler, and `onStalePairing()` must learn which one fired.

**Dependencies**: none new.

## Development Approach

- **Testing approach**: NO unit tests. They blow up the codebase for no value here.
  - add an integration test ONLY when it covers a real boundary (API contract, data migration, cross-component flow) and gives a guarantee manual checking can't
  - if no integration test adds a real guarantee, the task has NO test items — that is correct and expected
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: if a task adds an integration test, it must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Maintain backward compatibility

**Scope fence.** Close-code semantics + the responder's reaction. Do **not** touch the `/claude` (shim) leg, the
frame format, the AAD, the nonce ring, the catalog, or the dispatcher. Do not add any wire field beyond the
device leg's pairing identifier and the one close code.

## Testing Strategy

- **Unit tests**: none.
- **Integration tests**: three, each guarding a boundary manual checking cannot:
  1. **Relay (Go)**: a device leg presenting a stale pairing id is closed with the replaced code, while a leg
     presenting the current pairing id is served normally and is **never** closed with it. This is the
     regression that reproduces the squat.
  2. **Responder (JS)**: on the replaced code the responder stops permanently (no reconnect after advancing
     timers) and reports the code, and — critically — does **not** purge the vault record.
  3. **Responder (JS)**: on `4404` the existing behavior is unchanged (stop + purge). This guards the
     distinction above; without it a future refactor collapses the two paths.
- Extend the owning suites: `internal/cloudserver/mcp_relay_test.go`, `web/cloud/js/tests/mcp-responder.test.js`.
- **E2E**: none.

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope
- Keep plan in sync with actual work done

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): code, docs, the three integration tests
- **Post-Completion** (no checkboxes): manual re-pair verification against a real connector

## Implementation Steps

### Task 1: Reproduce the squat as a failing relay test
- [ ] add a test to `internal/cloudserver/mcp_relay_test.go` that pairs an account (P1), re-pairs it (P2), then dials the **device** leg presenting P1
- [ ] assert what current `master` actually does — the leg is accepted and joins P2's slot — so the bug is pinned in a test before it is fixed
- [ ] extend it to show the eviction: with a device leg already attached on P2, a stale-P1 dial evicts it (`pairingRecord.join`, `:357`)
- [ ] this test must **fail** after Task 2 lands and then be rewritten into the regression form (Task 4). Its purpose is to prove the bug exists on master, not to survive

### Task 2: Device leg must present, and the relay must verify, its pairing id
- [ ] in `internal/cloudserver/mcp_relay.go`, add `StatusPairingReplaced websocket.StatusCode = 4409` beside `StatusNoPairing`, with a comment stating the 4404-vs-4409 distinction from the table above
- [ ] have the device-leg handler read the pairing id the responder presents (query param, mirroring the `/claude` leg's existing `r.URL.Query().Get("pairing")` at `:30`) and compare it to `byAccountID`'s current record
- [ ] no pairing at all → keep the existing `StatusNoPairing` (4404) behavior exactly as PR #521 left it
- [ ] pairing exists but the presented id is not the current one → accept the upgrade, then `conn.Close(StatusPairingReplaced, "pairing replaced")`. Accept-then-close, not a handshake rejection: a browser `WebSocket` cannot observe a handshake HTTP status, which is the whole reason #521 exists
- [ ] a device leg presenting **no** pairing id must not be silently trusted — decide and comment the behavior (reject, or treat as stale); an unauthenticated squat is what this bead is closing
- [ ] verify the pairing id is not a second authenticator: the session cookie still authenticates the leg (`:24-26` says so for the shim leg's absence of one). The id selects *which* pairing, it does not grant access

### Task 3: Responder presents its pairing id and distinguishes the two close codes
- [ ] `wsURL()` in `mcp-responder.js` currently returns the bare device-leg URL. Append the responder's `pairingId` as a query param, encoded
- [ ] export `STATUS_PAIRING_REPLACED = 4409` alongside `STATUS_NO_PAIRING`
- [ ] widen the callback to `onStalePairing(code)` — the owner must know which case fired. Update every call site
- [ ] `onclose`: treat **both** codes as terminal (set `stopped`, clear the reconnect timer, do not back off); every other close stays transient and reconnects. Pass the code to `onStalePairing`
- [ ] in the owner (`reconcile`): on `4404` keep purging the vault record via `purgePairing`. On `4409` **do not purge** — the vault record now names the replacement pairing, which this device may not have synced yet, so purging would delete the user's live pairing account-wide. Release the Web-Lock election instead (`stopResponder`), so the tab that re-paired — already queued on the lock — takes over with the right key
- [ ] comment why the two paths differ; this is the single most reversible-looking, most dangerous line in the change

### Task 4: Regression tests for both close codes
- [ ] rewrite Task 1's reproduction into its regression form: a stale-pairing device dial is now closed with `StatusPairingReplaced`, and a current-pairing dial is served and **never** sees that code
- [ ] vitest: on `STATUS_PAIRING_REPLACED` the responder stops permanently (advance timers, assert no new socket), reports the code to `onStalePairing`, and **does not** call `purgePairing`
- [ ] vitest: on `STATUS_NO_PAIRING` the responder still stops **and** purges — the distinction is the point of the bead and must be pinned in both directions
- [ ] confirm the pre-existing #521 reconnect-loop tests still pass untouched

### Task 5: Verify acceptance criteria
- [ ] verify the race is closed: a stale tab can no longer occupy the fresh pairing's device slot, and cannot evict the tab holding the current key
- [ ] adversarially verify each new test: revert the relay's id check → the relay regression test must fail; collapse `4409` into the `4404` purge path → the "does not purge" test must fail. A test that cannot fail is not a test
- [ ] verify no behavior change for the happy path: a single tab, paired once, connects and serves frames exactly as before
- [ ] verify the frame layer is untouched: PR #526's write gating and nonce anti-replay still pass; PR #527's coverage sweep still passes
- [ ] run `go build ./...` — must pass
- [ ] run `go test ./...` — must pass
- [ ] run `pnpm test` — must pass
- [ ] run the linter — all issues must be fixed

### Task 6: [Final] Update documentation
- [ ] `docs/cloud-mode.md`: document both device-leg close codes and what each means for the vault record (4404 purge / 4409 step aside)
- [ ] update the stale `ponytail:` comment in `mcp-responder.js` about cross-tab re-pair not being broadcast — a re-paired tab now learns via the close code, so state precisely what is still missing (a `BroadcastChannel`/storage-event nudge for a same-device, other-tab re-pair)

## Technical Details

**Why accept-then-close rather than rejecting the handshake.** A browser `WebSocket` cannot read a handshake
HTTP status; a `404` reject and a network drop both surface as `onclose`, indistinguishable. That
indistinguishability *was* the med-253 bug, fixed in PR #521 by accepting the upgrade and closing with an
application code. The same reasoning applies verbatim to the replaced case, so it must use an application close
code, not a `409` handshake response.

**Why 4404 and 4409 cannot share a handler.** The vault record is CRDT-synced across devices and has no TTL.
- 4404 = the relay has no pairing for this account (its table is in-memory, lost on redeploy, 24h TTL). The
  vault record is a tombstone pointing at nothing → purge it locally.
- 4409 = the relay has a pairing, a newer one. The vault record already names *that* one, or will once this
  device syncs. Purging it deletes the pairing every other device is happily using.

Collapsing them looks like a harmless simplification and silently destroys a working pairing account-wide.

**`join`'s eviction is not the bug and must not be "fixed".** Last-writer-wins eviction with `CloseNow` is
deliberate (`:361-367`): a graceful `Close` blocks ~10s on an unresponsive peer while `p.mu` and the pairing
table's mutex are held, stalling every account. The bug is that a stale leg reaches `join` at all. Fix the
admission check; leave the eviction alone.

**Non-goals:** the `/claude` shim leg, the frame format/AAD, the nonce ring, the catalog, the dispatcher, and
any additional wire field. `mcp_execute` remains absent in cloud mode (med-csu.4).

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only*

**Manual verification**
- Pair a connector in tab A. Re-pair from tab B. Confirm tab A stops (no reconnect storm in its console) while
  tab B serves calls, and that the pairing still exists — i.e. tab A did **not** purge it. Then confirm
  `mcp_call` works end-to-end against tab B.
- Redeploy the server (drops the in-memory pairing table) and confirm the 4404 path still purges the stale
  vault record, as PR #521 intended.

**Follow-on**
- A same-device cross-tab re-pair still leaves the losing tab idle until its next unlock/reload. A
  `BroadcastChannel`/storage-event nudge would close that gap; out of scope here.
