# Wire the cloud MCP dispatcher to every ported web/domain module

## Overview

`web/cloud/js/mcp-responder.js`'s `createDispatcher` dispatches **6** operations (bp/weight/notes list+create)
while the generated catalog advertises **98**. This is the bulk of C4: make every catalogued op callable.

The naive reading of this bead is "write 98 dispatch entries mapping op ids onto `web/domain/*` calls." That
would duplicate logic the codebase already has, and the bead forbids it outright: *"Do NOT reimplement domain
logic in the responder."*

**The actual shape of the work (measured, not assumed).** `web/cloud/js/apishim.js` already contains a
`shimCall(endpoint, method, body, opts)` router that maps HTTP `method` + `path` onto exactly these
`web/domain/*` modules — it is what the cloud frontend calls for every screen. The generated catalog carries
`method`, `path`, `path_params`, `params_schema`, `body_schema` per op. Those are the same coordinates.

So MCP dispatch is a **reuse of the existing router**, not a second dispatch table:

```
mcp_call{operation_id, params, path_params, body}
  → catalog lookup (BY_ID)          → method + path template
  → substitute path_params          → concrete path        (med-csu.2 already built this)
  → serialize params as querystring → endpoint
  → shimCall(endpoint, method, body) → web/domain/*
```

Measured coverage of the 98 catalog paths against `apishim.js`: **91 already routed, 7 absent** — 4 workouts,
2 food, 1 health. Those 7 are the only genuinely new routing work; the rest is an extraction plus an adapter.

This also means MCP and the cloud UI share one code path, which is the JS-side statement of CLAUDE.md's
domain-service rule. If an op needs behavior a domain module lacks, it is added to `web/domain/*.js` (purity-
guarded by `architecture.domain-purity.test.js`), never to the responder.

## Context (from discovery)

**Files/components involved**
- `web/cloud/js/mcp-responder.js` — `createDispatcher({bp, weight, notes})` with a 6-entry prototype-free `ops`
  map, plus a "catalogued but not yet callable" error for the other 92. `BY_ID` (module-local) maps id → entry.
- `web/cloud/js/apishim.js` (687 lines) — `installApiShim(ctx, {records, win})` builds `shimCall` and, at `:686`,
  **already returns it** after assigning `targetWindow.offlineAwareApiCall = shimCall`.
- `apishim.js:677-682` — the fallback: `console.warn('[cloud shim] unmapped route …')` then
  `throw apiError(404, 'Not found: ${method} ${path}')`. Unmapped **writes** throw too (deliberate — a resolving
  stub made unshimmed writes look successful while doing nothing).
- `apishim.js:240-251` — a `STUBS` table keyed `'GET /api/bootstrap'`-style, consulted before the 404.
- `apishim.js` `PORTED_SET` — clamps the features map; already includes `bp, weight, health, medication, food,
  workout`.
- `web/domain/` — bp, weight, notes, settings, vitals, medschedule, medications, medintake, tzplan, reminders,
  food, foodai, workout, vault. All present; only the responder never picked them up.

**The 7 catalog paths absent from apishim** (verify each — the measurement was a substring scan and may
overcount; an op whose prefix merely appears in a comment would read as present):
- `POST /api/food/log/from-description`
- `GET  /api/food/products/search`
- `GET  /api/weight/goals/history`
- `GET  /api/workout/exercises/unique`
- `POST /api/workout/rotation/initialize`
- `GET  /api/workout/rotation/state`
- `POST /api/workout/sessions/schedule`

**Already built by the two merged predecessor beads — do not rebuild**
- med-csu.1 (PR #525): the generated catalog + drift guard. `path`, `path_params`, `risk`, `required`,
  `params_schema`, `body_schema` are all present per op.
- med-csu.2 (PR #526): the full envelope (`operation_id`/`op`, `params`, `path_params`, `body`, `mode`,
  `intent`), path-param substitution with allowlist + encoding, write-intent gating off catalog `risk`,
  warn-only schema validation, and the write-frame nonce anti-replay ring.

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

**Hard rule for this bead.** No domain logic in `mcp-responder.js`. If an op cannot be served, the fix goes in
`web/domain/*.js` (shared with apishim) or in `apishim.js`'s router — never a bespoke branch in the responder.
A reviewer should be able to diff the responder and see only *adapter* code.

## Testing Strategy

- **Unit tests**: none.
- **Integration tests**: three, each guarding a boundary manual checking cannot:
  1. **Coverage sweep** (the acceptance proof): drive **every** catalog op through the dispatcher and assert
     none fails with the router's `404 Not found: METHOD /path`. This converts `apishim.js:682` into a
     machine-checkable coverage assertion, and is strictly better than the substring scan that produced the
     "7 absent" estimate. Reads run with empty params; writes run with a minimal payload synthesized from the
     catalog's `required` + `mode: 'write'` + an `intent`.
  2. **Shape conformance**: for the read/list/get ops that carry a `response_example`, assert the dispatched
     result's top-level shape matches it (keys present; array-vs-object). The bead's acceptance criteria says
     "returns data matching the registry's ResponseExample shape" — this is that check.
  3. **No-duplicate-logic guard**: assert the responder dispatches through the shared router, e.g. that
     `createDispatcher` accepts an injected router and that a stub router receives the expected
     `(endpoint, method, body)` for a representative path-param op and a representative write op.
- Extend the **owning** suite `web/cloud/js/tests/mcp-responder.test.js` (CLAUDE.md rule 8). Router-extraction
  changes belong in the existing apishim suite if one exists. Do **not** add `*-branches` / `*-edges` /
  `pin-defect-N` files.
- **E2E**: none.

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope
- Keep plan in sync with actual work done

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): code, docs, the three integration tests
- **Post-Completion** (no checkboxes): the live claude.ai session against a seeded cloud account

## Implementation Steps

### Task 1: Extract the apishim router so MCP and the UI share one code path
- [x] in `web/cloud/js/apishim.js`, extract the body of `installApiShim` into an exported `createApiRouter(ctx, { records })` that returns `shimCall` and performs **no** `window` assignment
- [x] reduce `installApiShim(ctx, { records, win })` to `createApiRouter(...)` + `targetWindow.offlineAwareApiCall = router` + `return router`, preserving its current return value and signature exactly (plus the browser-direct globals + materialization timer, which are window side-effects and cannot live in the router)
- [x] make **no behavioral change** to any route in this task — it is a pure extraction; the existing apishim tests must pass untouched (`pnpm test`: 288 files / 3118 tests green)
- [x] confirm `createApiRouter` pulls in no browser globals beyond what `shimCall` already touches (`win` is now read-only, used only for the optional `TZPlanBanner.refresh()` nudge; the domain instances are exposed as `router.domains` so `installApiShim` reuses the same set)

### Task 2: Dispatch mcp_call through the router instead of the 6-entry ops map
- [x] in `web/cloud/js/mcp-responder.js`, build the endpoint from the resolved catalog entry: substitute `path_params` into the `path` template (reuse med-csu.2's allowlisted, encoded substitution — do not write a second one), then append `params` as a querystring
- [x] dispatch via the injected router: `router(endpoint, op.method, body)`. Inject it through `createDispatcher`/`createResponder` rather than importing `apishim.js` directly, so the dispatcher stays testable without a window (`createResponder({router})`; `reconcile` dynamic-imports `createApiRouter` to keep the static module graph acyclic — `apishim.js` still imports `createDispatcher` for its in-tab voice dispatcher)
- [x] serialize `params` correctly for the router's `parseQuery`: array and object values need a defined encoding — pick one, comment it, and make the coverage sweep exercise at least one such op (arrays → repeated key, objects → JSON; `serializeQuery`. Pinned by a dispatch test now; the sweep exercises it in Task 3)
- [x] delete the 6-entry `ops` map and the now-dead "catalogued but not yet callable" branch. ⚠️ Scope note: these could not survive this task — dispatching *through* the router means there is no `ops` map left to consult. The honest error for an unrouted op is now the router's own 404, mapped to a numeric `-32603` that names the missing `METHOD /path`; the "not yet callable" test was rewritten to assert exactly that
- [x] preserve the existing error contract: the router throws `Error` with `.status`; map a 404 to a JSON-RPC error with a **numeric** code (`handleRequest` maps non-numeric codes to -32602 because the Go shim decodes `error.code` into an `int64` and silently drops the frame otherwise — do not regress that)
- [x] preserve med-csu.2's write gating and nonce anti-replay: they key off catalog `risk` and must still run **before** dispatch
- [x] ➕ `createApiRouter` gained optional `now`/`timeZone` overrides so the dispatcher tests can drive the real router across a date boundary deterministically (they previously injected a fake-clock domain instance directly)
- [x] ➕ the two `features.elevenlabs-call.test.js` voice-tool tests injected fake `bp`/`weight`/`notes` domains into `createDispatcher`; they now inject a stub router and assert the `(endpoint, method, body)` each voice tool produces

### Task 3: Coverage sweep — every catalog op reaches a domain module
- [x] integration test in `web/cloud/js/tests/mcp-responder.test.js`: iterate **all** of `CATALOG`, dispatch each op through the real dispatcher + real `createApiRouter` over an in-memory records port, and assert none throws the router's `404 Not found: …` (matched via the dispatcher's `-32603 … has no route for …`, which is the router's 404 after mapping — a domain error means the op *was* routed and does not count)
- [x] synthesize write payloads from each op's catalog `required` field names; pass `mode: 'write'` + an `intent` so the gate admits them (values typed off whichever schema declares the field: number→1, boolean→true, array→[], object→{}, else "1")
- [x] supply `path_params` for ops whose `path` has `{placeholder}` slots. ⚠️ Scope note: no record is seeded — a not-found id still proves the route exists (a domain "no such medication" is not a routing gap), and the sweep stays free of per-op fixtures
- [x] the test must **name the failing op ids** in its failure message — a bare count tells the next author nothing
- [x] expect this to fail initially — it does, naming **8** ops (see Task 4's confirmed worklist). ➕ `workouts.miband.gps` was missed by the substring scan; the sweep found it. `medications.cancel_intake` pins the array-param querystring encoding, as promised in Task 2
- ⚠️ This task lands a **red** suite by design (the plan's own instruction); Task 4 turns it green. `pnpm test` fails only on `mcp-responder.test.js` until then.

### Task 4: Route the ops the sweep proves are missing
- [x] for each op the sweep names, add its route to `apishim.js`'s `shimCall` — delegating to the matching `web/domain/*.js` function
- [x] where the domain module lacks the behavior, **add it to `web/domain/*.js`** (never to the responder or to apishim's router body), so apishim and MCP keep sharing one implementation. `architecture.domain-purity.test.js` guards that layer: no `window`, `document`, `fetch`, or IndexedDB (added: `weight.listGoals`, `workout.listUniqueExercises`, `workout.schedulePlannedAdHocSession`; exported the already-present `workout.getRotationState`/`initializeRotation`)
- [x] confirmed worklist, as named by the Task 3 sweep (8, not 7 — the scan missed `workouts.miband.gps`):
  - `food.log.from_description` → `POST /api/food/log/from-description` (routes to `foodAI.parseMealFromDescription`, browser-direct)
  - `food.products.search` → `GET /api/food/products/search` (routes to `food.search`; the catalog's `limit` is ignored, matching the Go handler, which also ignores it)
  - `health.weight.goal.history.list` → `GET /api/weight/goals/history` (new `weight.listGoals`)
  - `workouts.exercises.unique` → `GET /api/workout/exercises/unique` (new `workout.listUniqueExercises`)
  - `workouts.miband.gps` → `GET /api/workout/miband/{id}/gps` — **excluded**, see below
  - `workouts.rotation.initialize` → `POST /api/workout/rotation/initialize` (now rejects a zero group_id/variant_id instead of Go's `INSERT OR REPLACE` of an orphan row)
  - `workouts.rotation.state` → `GET /api/workout/rotation/state`
  - `workouts.sessions.schedule` → `POST /api/workout/sessions/schedule` (new `workout.schedulePlannedAdHocSession`, porting the handler's validation + the service's placeholder loop and rollback)
- [x] `food.log.from-description` and `food.products.search` reach outside the vault (AI parsing / food DB). C2c ported those as **direct-from-browser** calls — reuse that path; do **not** route them through the relay, which would break the zero-knowledge boundary. If an op genuinely cannot be served in cloud mode, do not silently skip it: add it to `catalogjs.Excluded` with a reason, which the med-csu.1 drift guard then enforces. Both routes call the very `foodAI`/`food` instances `installApiShim` hands to `CloudFoodAI`/`CloudFoodSearch`, so no plaintext crosses the relay
- [x] ➕ `workouts.miband.gps` added to `catalogjs.Excluded`: `vaultToRecords` drops `workouts.miband[].gps` on import (44% of a real vault, nothing renders it — docs/vault-format.md), so the op could only ever return an empty track in cloud mode. Catalog regenerated (98 → 97 ops)
- [x] ➕ Task 2's "catalogued but no route" test used `workouts.exercises.unique` as its example of an unrouted op; now that every op routes it injects a 404-throwing stub router instead. The coverage sweep is what guards the property from here on
- [x] re-run the sweep until it passes with zero unrouted ops (`pnpm test`: 288 files / 3122 tests green)

### Task 5: ResponseExample shape conformance
- [x] integration test: for each catalog op carrying a `response_example`, dispatch it and assert the result's top-level shape agrees (array vs object; expected keys present on an object, or on the first element of a non-empty array). 35 ops carry one. ➕ a numeric-keyed example object (`workouts.rotation.state`'s `{"1": {...}}`) was read as a dynamic map — that turned out to be a registry bug, not a map (see below)
- [x] seed enough records that the representative read ops return non-empty results; an all-empty sweep proves nothing about shape. Seeding runs through the router's own write ops (17 ops named in `MUST_BE_NON_EMPTY` must come back non-empty, asserted); `bpgoal`/`sleep`/`miband` have no catalogued write op and are seeded onto the records port directly. Every `omitempty` field the examples advertise is filled in, so a domain module that never emits them cannot pass
- [x] where a real mismatch surfaces, fix the **domain module** to match the registry's documented shape, and note any op whose `response_example` is itself wrong so it can be corrected in `internal/mcp/registry`
- [x] ➕ **domain fixes** (2): `workout.toMiBandResponse` never emitted `source_end_ms` (the Go `MiBandWorkout` always does); `vitals.sleepToResponse` never emitted `user_id`
- [x] ➕ **the registry's own examples were wrong for 14 of the 35 ops** — hand-written shapes that no Go handler ever returned, which have been misleading bot-mode agents too. All corrected against the handler's real JSON (with `ResponseSummary` where it repeated the same lie), catalog regenerated:
  - `health.bp.stats` — advertised `{dates, systolic[], diastolic[], pulse[], counts[]}`; really `{stats_14, stats_30, stats_60}`
  - `health.bp.goal.read` — invented `updated_at`
  - `health.bp.reminder.status` / `health.weight.reminder.status` — invented `dontbug_until`, `last_reminded_at`, `next_reminder_at`; really `preferred_reminder_hour` + `dont_remind_until`
  - `health.weight.goal.read` — advertised `{target_weight, updated_at}`; really `{goal, goal_set_at, highest_weight, highest_date, …}`
  - `health.sleep.list` — `created_at` is not in the vault format, so cloud cannot return it
  - `food.log.list` — advertised `[{date, logs}]`; really `[{name, time, calories, carbs, protein, fat, logs}]`
  - `food.stats.read` — advertised `{totals, daily_average, per_day}`; really flat `{calories, carbs, protein, fat}`
  - `workouts.exercises.list` — advertised `name`; the field is `exercise_name`
  - `workouts.variants.list` / `workouts.exercise_library.list` — showed `omitempty` fields with the very values that cause Go to omit them (`""`, `null`)
  - `workouts.sessions.list` — advertised a flat session; really `{session, group_name, variant_name, exercises_count, exercises_completed, total_volume}`
  - `workouts.sessions.details` — advertised `{id, …, exercise_logs}`; really `{session, logs}`
  - `workouts.sessions.next` — advertised a flat session; really `{session, group_name, variant_name, exercises_count, variant_id, group_id, is_rotating}`
  - `workouts.stats.read` — invented `per_group`; really `active_weeks` + `top_exercises[]` + `weekly_activity[]`
- [x] ➕ `workouts.rotation.state` was undocumented **and uncallable**: it advertised a map keyed by group id and no params, but the handler requires a `group_id` query param and returns one state object. Gave it a `ParamsSchema` with `required: ["group_id"]`. Same for `workouts.rotation.initialize`, whose description claimed it reset "all groups" with no body — it needs `{group_id, starting_variant_id}`; gave it a `BodySchema`
- [x] `pnpm test`: 288 files / 3123 tests green; `go build ./...` + `go test ./...` green

### Task 6: Verify acceptance criteria
- [ ] verify the bead's criteria: every non-excluded catalog op dispatches to a `web/domain` module and returns data matching the registry's `ResponseExample` shape
- [ ] adversarially verify the coverage sweep: temporarily remove one route from `apishim.js`'s `shimCall`, confirm the sweep **fails naming that op**, then restore. A coverage test that cannot fail is not a coverage test
- [ ] verify no domain logic leaked into `mcp-responder.js`: the diff there should be adapter code only (endpoint construction, router call, error mapping)
- [ ] verify med-csu.2's guarantees still hold: a write op without `mode: 'write'` is refused; a replayed write frame applies exactly once
- [ ] verify the 6 previously-wired ops (`health.bp.list`/`create`, `health.weight.*`, `health.notes.*`) behave identically to before
- [ ] run `go build ./...` — must pass
- [ ] run `go test ./...` — must pass
- [ ] run `pnpm test` — must pass (including `architecture.domain-purity.test.js`)
- [ ] run the linter — all issues must be fixed

### Task 7: [Final] Update documentation
- [ ] update `docs/cloud-mode.md`: cloud MCP now dispatches every non-excluded catalog op, through the same `apishim` router the UI uses (one code path, no duplicate domain logic); name any op excluded for zero-knowledge reasons
- [ ] remove the now-stale claim that catalogued ops are not dispatchable (added by med-csu.1's docs task)
- [ ] update `CLAUDE.md` if a new invariant lands: a new cloud route must be added to the shared router, not to the MCP responder

## Technical Details

**Why route by `method` + `path` rather than op id.** The catalog's `path` is the registry's own coordinate for
the operation, and `apishim.js` is already keyed by it. Dispatching on op id would need a second table that
must be kept in sync with the first — precisely the drift med-csu.1's guard exists to prevent. Routing by path
means the drift guard already covers dispatch: an op in the registry that the router cannot serve fails the
coverage sweep.

**Endpoint construction.**
```
path_params  → substituted into {slots}, allowlisted + encoded   (med-csu.2)
params       → querystring
body         → passed through for writes
endpoint     = `${concretePath}${qs ? '?' + qs : ''}`
result       = await router(endpoint, op.method, body)
```

**Error mapping.** `shimCall` throws `Error` with `.status` (`apiError(404, …)`). The responder must translate
`.status` into a numeric JSON-RPC code. A 404 from the router means *this op is catalogued but the router has no
route* — an internal inconsistency the coverage sweep is meant to make impossible, so it should read as an
internal error, not as "bad params."

**The 404 is load-bearing.** `apishim.js:678-682` deliberately throws on unmapped writes rather than resolving
`null`, because a resolving stub made unshimmed writes look successful while doing nothing. The coverage sweep
depends on that throw. Do not soften it.

**Zero-knowledge boundary.** `food.log.from-description` (AI parse) and `food.products.search` (food DB) leave
the vault. C2c ported them as direct-from-browser calls; MCP must reuse that path. Routing them through the
relay would hand the server plaintext and break the property the whole cloud mode exists to provide.

**Non-goals:** `mcp_execute` (no cloud path — med-csu.4), the 4409 replaced-pairing race (med-csu.5), OAuth,
gamification (the 8 named exclusions in `catalogjs.Excluded`).

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only*

**Manual verification** (the bead's second acceptance clause, which no test here can cover)
- A live claude.ai session against a seeded cloud account must be able to: list BP, log a medication intake,
  fetch workout stats, and read vitals. Run `cmd/seeddemo` against a cloud account, pair a connector, and drive
  those four flows.
- Confirm a write still requires `mode: 'write'` + `intent` end-to-end through a real connector, and that the
  relay never sees plaintext for the two direct-from-browser food ops.

**Follow-on beads**
- **med-csu.4** — document that `mcp_execute` has no cloud path (zero-knowledge); Pyodide is the only future option.
- **med-csu.5** — the dropped 4409 replaced-pairing race.
