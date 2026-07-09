# Cloud MCP catalog codegen + registry drift guard

## Overview

`web/cloud/js/mcp-responder.js` serves a hardcoded 6-operation PoC catalog (bp/weight/notes list+create).
The file admits it at `:16-18` — `ponytail: PoC hardcodes this tiny catalog; full C4 generates it from
internal/mcp/registry`. Meanwhile `internal/mcp/registry.DefaultOperations()` holds **106 operations**
across workouts (40), health (24), medications (20), food (14), gamification (8).

This plan replaces the hand-written array with a **Go generator** that emits a checked-in
`web/cloud/js/mcp-catalog.generated.js` from the registry, and adds a **CI drift guard** that fails when
the registry gains an operation the cloud catalog neither covers nor explicitly excludes.

Problem it solves: the two MCP surfaces (bot mode's `internal/mcp` and cloud mode's in-browser responder)
silently rot apart. `docs/cloud-mode.md` warns about exactly this. Today cloud reaches ~6 of ~106 ops.

Key benefit: cloud `mcp_help` returns the same operation ids as bot mode minus a named, reasoned exclusion
list — and it cannot regress, because a Go test regenerates the file in memory and diffs it.

Integration: the generated module is a dependency-free browser ESM file under `web/cloud/js/`, which
`web/cloud/embed.go` already embeds via its `js` **directory** glob — no embed edit needed. The responder
imports `CATALOG` from it instead of defining it inline.

### Hard constraint discovered during design (drives the whole `mcp_help` shape)

`internal/cloudserver/mcp_relay.go:30` sets `maxRelayFrameBytes = 64 << 10` (64 KiB), applied via
`conn.SetReadLimit(maxRelayFrameBytes)` at `:246`. Measured payload sizes for all 106 ops:

| projection | bytes |
|---|---|
| full entries (schemas + response_example) | ~106 KB |
| compact entries (id/topic/method/risk/description) | ~35 KB |

So `mcp_help` **cannot** return the full catalog in one frame. It must return the **compact** projection by
default and expose drill-in for full entries. This is not a new invention — it is exactly what bot mode
already does.

### Bot-mode `mcp_help` semantics to mirror (read from `internal/mcp/help.go`)

Precedence is **ids > query > topic > full catalog**:

- `operation_id` / `operation_ids` (merged) → **full** entries (`registry.MarshalForHelp`), plus a `Not found: …`
  note for unknown ids. All ids unknown → count 0 + guidance, not an error.
- `query` → **compact** matches (`registry.MarshalForHelpCompact`). `help.go:161-167` is explicit that these
  are *never* auto-expanded to full nested schemas: a measured regression (qwen3.5-9b emits an empty turn
  when a query returns full `body_schema`s). Do **not** add a "≤3 matches auto-expand" behavior — the text
  in CLAUDE.md describing that is stale relative to `help.go`.
- `topic` / no args → **compact** catalog + `usage_protocol` + topic list.

Compact entries carry `required` (path params + required params/body field names) so an agent can form a
write straight from the terse list without a schema drill-in.

## Context (from discovery)

**Files/components involved**
- `web/cloud/js/mcp-responder.js` — inline `CATALOG` (`:19-99`), `USAGE_PROTOCOL` (`:101`), `levenshtein` +
  `suggestOperations` (`:110-135`), `createDispatcher` (`:144`, `mcp_help` returns `{catalog, usage_protocol}`),
  `handleRequest` (`:183`).
- `internal/mcp/registry/registry.go` — `Operation` struct (ID, Topic, Method, Path, PathParams, Risk,
  ParamsSchema, BodySchema, ResponseSummary, Description, Example, ResponseExample), `HelpEntry`,
  `HelpEntryCompact` (ID, Topic, Method, Risk, Description, Required), `MarshalForHelp` (`:220`),
  `MarshalForHelpCompact` (`:320`), `DefaultOperations` (`:486`).
- `internal/mcp/help.go` — the precedence + note/next-step semantics being mirrored.
- `internal/cloudserver/mcp_relay.go:30,246` — the 64 KiB frame cap.
- `web/cloud/embed.go` — `//go:embed index.html signup.html sw.js css js vendor` (directory glob).
- `web/cloud/js/tests/mcp-responder.test.js` — existing vitest suite to extend.

**Related patterns found**
- Drift-guard precedent: `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` in `internal/server`
  (`internal/server/mcp_coverage_exempt.go` holds the named exemptions with a `Reason` per entry).
  This plan copies that shape: an explicit, reasoned exclusion list, never a silent omission.
- Generator-binary naming precedent: `cmd/genvapid`.
- `web/cloud/js/apishim.js:157` `PORTED_SET` clamps gamification out of the cloud feature map — the reason
  gamification is excluded here too.

**Dependencies identified**
- None new. The generator is stdlib (`encoding/json`, `os`, `sort`, plus plain string building).
- The generated file must import nothing (plain `export const`).

## Development Approach

- **Testing approach**: NO unit tests. They blow up the codebase for no value here.
  - add an integration test ONLY when it covers a real boundary (API contract, data migration, cross-component flow) and gives a guarantee manual checking can't
  - if no integration test adds a real guarantee, the task has NO test items — that is correct and expected
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: if a task adds an integration test, it must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Maintain backward compatibility

**Scope fence.** This bead is **catalog + guard only**.
- Dispatch wiring of the ~98 operations to `web/domain/*` modules is **med-csu.3** (blocked on this bead).
- `mcp_call` envelope parity (path_params / body / write-intent gating) is **med-csu.2**.
- Therefore: do **not** add new dispatch handlers. `createDispatcher`'s existing six entries
  (`bp.list`, `bp.create`, `weight.list`, `weight.create`, `notes.list`, `notes.create`) keep working
  unchanged. An `mcp_call` for a catalogued-but-unwired op keeps returning the existing
  `unknown operation "…"` + did-you-mean error. That is the correct, expected state at the end of this plan.

## Testing Strategy

- **Unit tests**: none. Do not add unit tests.
- **Integration tests**: two, both guarding real boundaries that manual checking cannot:
  1. **Go drift guard** (`internal/mcp/catalogjs`) — the registry↔cloud-catalog contract. This is the entire
     point of the bead and it must run in CI.
  2. **Vitest additions** to the existing `web/cloud/js/tests/mcp-responder.test.js` — the `mcp_help` wire
     contract (compact by default, full on drill-in) and the **64 KiB frame-cap** assertion, which is a live
     regression risk every time someone adds a registry op.
- **E2E tests**: none. The project has no e2e suite covering the MCP relay; do not stand one up.

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope
- Keep plan in sync with actual work done

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): code changes, docs, and the two integration tests above
- **Post-Completion** (no checkboxes): manual relay verification against a real claude.ai connector

## Implementation Steps

### Task 1: Add the `internal/mcp/catalogjs` generator package with a named exclusion list
- [x] create `internal/mcp/catalogjs/catalogjs.go`, package `catalogjs`, importing only stdlib + `internal/mcp/registry`
- [x] define `type Exclusion struct { ID, Reason string }` and `var Excluded = []Exclusion{…}` listing the **8 gamification op ids** individually (not the topic), each with reason `"gamification is deferred project-wide; clamped out of apishim.js PORTED_SET"` — mirror `internal/server/mcp_coverage_exempt.go`'s reasoned-entry shape
- [x] add `func ExcludedIDs() map[string]string` returning id→reason for cheap lookup
- [x] implement `func Generate(ops []*registry.Operation) ([]byte, error)` that filters out excluded ids, sorts the remainder by `ID` (deterministic, diff-stable), and renders a browser-ESM file
- [x] emit `export const CATALOG = [...]` where each entry carries `id, topic, method, path, path_params, risk, description, response_summary, params_schema, body_schema, response_example, required` — marshal `ParamsSchema`/`BodySchema` (`json.RawMessage`) as inline JSON objects, omitting them when nil (emitted as `json.MarshalIndent` output — JSON is valid JS, so no hand-quoted literals)
- [x] compute `required` in Go (path params + required field names from params/body schemas) and bake it into each entry, so the JS side never has to walk a JSON Schema — reuse the same derivation `registry.MarshalForHelpCompact` uses rather than reimplementing it (calls `MarshalForHelpCompact` directly, so `required` is populated for write ops exactly as bot mode does)
- [x] emit `export const EXCLUDED = [{ id, reason }, …]` from `Excluded`
- [x] prepend a `// Code generated by cmd/genmcpcatalog. DO NOT EDIT.` header plus a one-line pointer to this plan, and ensure the output has **no `import` statements** and ends with a trailing newline

### Task 2: Add the `cmd/genmcpcatalog` entry point and check in the generated catalog
- [x] create `cmd/genmcpcatalog/main.go` as a thin `main`: call `catalogjs.Generate(registry.DefaultOperations())`, write to `web/cloud/js/mcp-catalog.generated.js`, accept an optional `-out` flag defaulting to that path
- [x] add a `//go:generate go run ./cmd/genmcpcatalog` directive in `catalogjs.go` so the regeneration command is discoverable from the package that owns the format (emitted as `go run ../../../cmd/genmcpcatalog -out ../../../web/cloud/js/…` — `go generate` runs in the package dir, so the plan's repo-root-relative form would not resolve)
- [x] run the generator and commit `web/cloud/js/mcp-catalog.generated.js`
- [x] confirm `go build ./...` still passes (the file is embedded by `web/cloud/embed.go`'s existing `js` directory glob — verify no embed edit is required)
- [x] sanity-check the emitted op count is `106 - 8 = 98` and that no gamification id appears in `CATALOG`

### Task 3: Serve the generated catalog from mcp-responder.js with bot-mode `mcp_help` semantics
- [ ] in `web/cloud/js/mcp-responder.js`, delete the inline `CATALOG` array (`:19-99`) and `import { CATALOG, EXCLUDED } from './mcp-catalog.generated.js'`, re-exporting `CATALOG` so existing importers/tests keep resolving it
- [ ] add a `compactEntry(op)` projection returning `{ id, topic, method, risk, description, required }` (drop `required` when empty)
- [ ] rewrite the `mcp_help` branch of `createDispatcher` to mirror `internal/mcp/help.go` precedence **ids > query > topic > catalog**:
  - [ ] merge `params.operation_id` + `params.operation_ids` (lowercased, trimmed, empties dropped); if any resolve, return **full** entries for the found ids plus a `Not found: …` note for the rest; if none resolve, return `{ count: 0, topics, next_step }` rather than throwing
  - [ ] `params.query` → **compact** matches over id/description/topic/response_summary; return `{ count: 0, topics, note }` on no match. Do **not** auto-expand to full entries — `help.go:161-167` documents this as a measured regression for weaker models
  - [ ] `params.topic` → compact entries for that topic; unknown topic → `{ count: 0, topics }`
  - [ ] no args → compact catalog + `usage_protocol` + `topics`
- [ ] rewrite `USAGE_PROTOCOL`: it currently claims *"the catalog is small enough to read in full"*, which is false at 98 ops. State the discover→drill-in→`mcp_call` decision rule, that `mcp_call` runs exactly one op, that this connector talks to an unlocked browser tab over an E2E-encrypted channel, and that **`mcp_execute` does not exist in cloud mode** (zero-knowledge — the server cannot see plaintext; see med-csu.4)
- [ ] verify `suggestOperations` still behaves over 98 entries (substring first, Levenshtein ≤3 fallback, top 3) — the `levenshtein` helper is O(n·m) per entry and now runs 98× per unknown op, which is fine; leave it alone
- [ ] leave `createDispatcher`'s six `ops` dispatch entries untouched (scope fence: med-csu.3 wires the rest)

### Task 4: Integration test — the Go drift guard (the point of this bead)
- [ ] create `internal/mcp/catalogjs/drift_test.go`, modeled on `internal/server`'s `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt`
- [ ] `TestCloudCatalog_EveryRegistryOpCoveredOrExcluded`: assert every `registry.DefaultOperations()` id is present in the checked-in `web/cloud/js/mcp-catalog.generated.js` **or** in `Excluded`; on failure, name the offending ids and tell the author to regenerate or add a reasoned exclusion
- [ ] `TestCloudCatalog_GeneratedFileIsUpToDate`: run `Generate(registry.DefaultOperations())` in memory and byte-compare against the checked-in file; on mismatch, fail with `run: go run ./cmd/genmcpcatalog`
- [ ] `TestCloudCatalog_ExclusionsAreRealOps`: assert every `Excluded` id actually exists in the registry (catches typos and stale exclusions after an op is renamed or deleted) and that every exclusion carries a non-empty `Reason`
- [ ] resolve the repo-root path from the test file location (`../../../web/cloud/js/mcp-catalog.generated.js`) rather than depending on the working directory
- [ ] run `go test ./internal/mcp/...` — must pass

### Task 5: Integration test — `mcp_help` wire contract and the 64 KiB frame cap
- [ ] extend `web/cloud/js/tests/mcp-responder.test.js` (do not create a new file — CLAUDE.md rule 8: extend the owning suite)
- [ ] assert the no-args `mcp_help` result returns **compact** entries (no `params_schema` / `body_schema` / `response_example` keys on any entry) plus `usage_protocol`
- [ ] assert the catalog contains **no** `gamification.*` op id, and does contain representative ids from each retained topic (e.g. `workouts.*`, `medications.*`, `food.*`, `health.*` — read the real ids from the generated file rather than guessing)
- [ ] assert `mcp_help({ operation_ids: [...] })` returns **full** entries for the requested ids, and reports unknown ids in the note rather than throwing
- [ ] assert `mcp_help({ query: '…' })` returns compact matches only — never full schemas
- [ ] **frame-cap regression guard**: the UTF-8 byte length of `JSON.stringify(await dispatcher.handle('mcp_help', {}))` must be `< 64 * 1024` (measure with `new TextEncoder().encode(...).length`, not `.length` — descriptions contain non-ASCII), with a comment naming `internal/cloudserver/mcp_relay.go`'s `maxRelayFrameBytes` as the source of the number
- [ ] assert `mcp_call` on a catalogued-but-unwired op (e.g. a `workouts.*` id) still returns the `unknown operation` + did-you-mean error — this pins the scope fence so med-csu.3 has a failing-to-passing signal
- [ ] run `pnpm test` — must pass

### Task 6: Verify acceptance criteria
- [ ] verify all requirements from Overview are implemented
- [ ] verify the bead's acceptance criteria: generated catalog covering every non-excluded registry op is served by `mcp-responder.js`; cloud `mcp_help` returns the same op ids as bot mode minus the named exclusions; a CI test fails if a new registry op is neither covered nor listed as excluded
- [ ] adversarially verify the guard actually guards: temporarily add a throwaway op to `registry.DefaultOperations()`, confirm `go test ./internal/mcp/...` **fails**, then revert. A drift guard that cannot fail is not a guard
- [ ] verify edge cases: unknown `operation_ids` (all + partial), empty `query`, unknown `topic`, prototype-pollution op names (`toString`, `constructor`) still hit the unknown-op path via the `Object.create(null)` map
- [ ] run `go build ./...` — must pass
- [ ] run `go test ./...` — must pass
- [ ] run `pnpm test` — must pass
- [ ] run the linter — all issues must be fixed

### Task 7: [Final] Update documentation
- [ ] update `docs/cloud-mode.md`: the MCP section must state that the cloud catalog is generated from `internal/mcp/registry` by `cmd/genmcpcatalog`, that regeneration is `go run ./cmd/genmcpcatalog`, that gamification is the named exclusion, and that `mcp_help` is compact-by-default because of the 64 KiB relay frame cap
- [ ] update `CLAUDE.md` if a new invariant lands: adding a registry operation now also requires regenerating the cloud catalog or adding a reasoned exclusion (this parallels the existing MCP-coverage rule for HTTP routes)
- [ ] note in `docs/cloud-mode.md` that catalogued ops are not yet dispatchable (med-csu.3) so the doc does not overclaim

## Technical Details

**Package split (why two packages, not one `main`).** The drift guard has to re-run the generator *in memory*
and diff. A generator that lives entirely in `package main` under `cmd/` cannot be imported by a test. So the
logic lives in `internal/mcp/catalogjs` (importable, testable) and `cmd/genmcpcatalog/main.go` is a ~20-line
`main` that calls `Generate` and writes the file.

**Generated file shape** (dependency-free ESM, sorted by id):

```js
// Code generated by cmd/genmcpcatalog. DO NOT EDIT.
// Source: internal/mcp/registry.DefaultOperations(). Regenerate: go run ./cmd/genmcpcatalog
export const CATALOG = [
  {
    id: 'bp.create',
    topic: 'health',
    method: 'POST',
    path: '/api/bp',
    risk: 'write',
    description: '…',
    response_summary: '…',
    required: ['measured_at', 'systolic', 'diastolic'],
    body_schema: { type: 'object', /* … */ },
  },
  // …
];
export const EXCLUDED = [
  { id: 'gamification.overview', reason: 'gamification is deferred project-wide; clamped out of apishim.js PORTED_SET' },
  // …
];
```

**Why `required` is baked in by the generator.** `HelpEntryCompact.Required` is derived in Go by walking the
params/body JSON Schemas. Recomputing that in the browser would duplicate schema-walking logic across two
languages — a guaranteed drift source. The generator computes it once and stores it per entry; the JS compact
projection just copies the field.

**Frame-size arithmetic.** Compact projection of all 106 ops measured ~35 KB; dropping the 8 gamification ops
takes it lower. The 64 KiB `SetReadLimit` applies to the sealed frame (ciphertext + AES-GCM overhead ≈
plaintext + a few dozen bytes), so a <64 KiB plaintext assertion is the right guard. It has real headroom
today but shrinks as the registry grows — hence the test, not a comment.

**Excluded is per-op, not per-topic.** Listing the 8 gamification ids individually costs 8 lines and buys
`TestCloudCatalog_ExclusionsAreRealOps`: if someone renames `gamification.overview`, the test fails instead of
silently excluding nothing. A topic-level exclusion would silently swallow a rename.

**Non-goals (fenced above, restated so ralphex does not drift):** no new dispatch handlers, no `mcp_call`
envelope changes, no `mcp_execute` cloud path, no OAuth, no new dependencies.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only*

**Manual verification**
- Connect a real claude.ai MCP connector to a cloud account with an unlocked tab and call `mcp_help` with no
  args; confirm the full 98-op compact catalog arrives in one frame (no read-limit socket close on the relay)
  and that `mcp_help(operation_id=…)` drills into full schemas.
- Confirm `mcp_call` on a not-yet-wired op returns the actionable did-you-mean error rather than hanging.

**Follow-on beads**
- **med-csu.2** — `mcp_call` envelope parity (path_params, body, write-intent gating).
- **med-csu.3** — wire the dispatcher to every ported `web/domain/` module (unblocked by this bead).
- **med-csu.4** — document that `mcp_execute` has no cloud path (zero-knowledge); Pyodide is the only future option.
