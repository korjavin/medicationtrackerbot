# Goja Feasibility Spike (clean redo) — run web/domain modules server-side

## Overview
- Prove whether the pure-JS domain layer in `web/domain/*.js` can execute **server-side inside the Go binary** via goja (`github.com/dop251/goja`, pure Go), backed by a SQLite records port, with **value-exact parity** against the native Go domain and **acceptable performance**.
- Produces: a committed spike harness under `internal/gojaspike/` with deterministic parity tests + benchmarks, and a measured, caveated go/no-go recommendation written into `docs/cloud-mode.md`.
- This is the viability input for the C6 unification endgame (`med-07y`): the "no two duplicates" constraint only holds if goja can run the JS domain layer server-side. Answer = goja vs Node-sidecar.
- **No production wiring, no shadow mirroring** (that is C6, a later bead). This is a throwaway-branch-OK spike; only the harness + docs are kept.

## Context (from discovery)

**This is a REDO.** jules' PR #462 was **CLOSED** by the maintainer with a concrete blocker list. Its branch `origin/med-07y.1-goja-spike-18033936322281775428` (`internal/gojaspike/{port.go,goja_spike_test.go,fixture_test.go,benchmark_test.go,benchmark_mem_test.go}` + a docs edit) is **reference material only** — reuse the file structure, do not copy its defects.

The maintainer's blocker list **is the acceptance criteria** — every item must be satisfied:
1. **NO log-only tests.** jules' `TestGojaBP` only did `t.Logf("Result: %v", ...)`. Every test must **assert deterministic parity** between the JS-via-goja output and the native Go store output.
2. **Goja Promise execution must be deterministic and proven complete.** jules' bug: `domain.create(x).then(r => result = r); result;` read `result` *before* the microtask ran, so it was always `null`. Must capture the returned `*goja.Promise`, drain microtasks, assert `State()==Fulfilled`, read `Result()`, and **fail on Rejected or still-Pending**.
3. **Check ALL setup errors.** jules ignored errors (`d.Exec(...)` discarded, `db, _ := sql.Open`, unchecked `vm.RunString`). Every setup/exec/marshal/run error must be checked and `t.Fatalf` on failure.
4. **Docs report MEASURED CAVEATS**, not overconfident GO claims. jules wrote precise "12KB / sub-millisecond / GO" from weak tests. Docs must present measured numbers *with* their caveats and what was **not** proven.

**Files/components involved:**
- New: `internal/gojaspike/` (Go-only spike package: records port, VM harness/loader, parity tests, benchmarks).
- Read-only parity targets: `internal/store/bp/repo.go` (`CalculateBPCategory`, `CreateReading`, `ListReadings`, `GetDailyWeightedStats`), `internal/store/weight/repo.go` (`CalculateWeightTrend`, `CreateLog`, `ListLogs`).
- Driven JS (must run **unmodified**): `web/domain/bp.js`, `web/domain/weight.js`.
- DB: `internal/store/db.Open(":memory:")` for the Go side; `modernc.org/sqlite` (already the project driver, pure Go) for the records-port table.
- Fixture reference: `web/static/js/tests/cloud.shim-contract.bp.test.js`, `cloud.shim-contract.weight.test.js` — reuse the same input sequences where practical.
- Docs: `docs/cloud-mode.md`, section "The client: porting the domain layer".

**Records port contract** (from `web/domain/bp.js` `createBPDomain({ records, now, timeZone })`):
- `records.list(type)` → `Promise<array of record objects>`
- `records.put(type, record)` → `Promise`
- `records.del(type, id)` → `Promise`
- `now()` → ms epoch (int); `timeZone` → IANA string.
- Back with SQLite table `records(type TEXT, id TEXT, data JSON, PRIMARY KEY(type,id))`.

**ESM caveat:** `bp.js`/`weight.js` use `export function`/`export const`. goja has no native ESM. The Go loader strips the leading `export ` so the factory (`createBPDomain`/`createWeightDomain`) becomes a plain global. Transpile-free, tiny transform — acceptable for the spike but **must be documented as a load caveat**. `web/domain/*.js` are **not** modified.

**Related patterns found:** `web/domain/*.js` are purity-guarded (`architecture.domain-purity.test.js`) — no window/document/fetch/IndexedDB — which is exactly what makes them runnable under goja with injected ports.

**Dependencies identified:** `go.mod` gains `github.com/dop251/goja` + transitive deps. Expected and justified by the spike. Keep goja imported **only** from `internal/gojaspike` (no other package).

## Development Approach
- **Testing approach**: The parity assertions and benchmarks in `internal/gojaspike/` **are the deliverable of this spike**, not incidental unit tests — they exist to answer the go/no-go question with evidence. They must be deterministic (fixed `now`, fixed `timeZone`, in-memory DB), assert real parity, and check every setup error. No log-only tests.
- Do **not** add tests to other packages; the spike is self-contained.
- Complete each task fully before the next; keep this plan file in sync (`[x]` on completion, ➕ for new tasks, ⚠️ for blockers).
- **Do NOT modify `web/domain/*.js`** — the whole point is they run unmodified; the ESM strip happens in the Go loader.
- Keep `CGO_ENABLED=0` intact (goja + modernc.org/sqlite are pure Go).

## Testing Strategy
- **Unit tests**: none of the conventional "test a new helper" kind.
- **Integration/parity tests**: yes — this spike's tests drive `web/domain/*.js` through goja and assert value-exact parity vs `internal/store/{bp,weight}`. This IS the real boundary the spike must prove. They must pass before the docs task records any recommendation.
- **Benchmarks**: `testing.B` for cold-start and per-call; `runtime.MemStats` for per-VM memory; pooled-VM vs per-request-VM comparison.
- **E2E**: none.

## Progress Tracking
- Mark completed items `[x]` immediately.
- ➕ for newly discovered tasks, ⚠️ for blockers.
- Update the plan if scope changes.

## What Goes Where
- **Implementation Steps** (`[ ]`): Go code in `internal/gojaspike/`, the `go.mod` dep, the docs edit, and running the spike's own tests/benchmarks.
- **Post-Completion** (no checkboxes): the human go/no-go decision itself, C6 follow-up scoping.

## Implementation Steps

### Task 1: Add goja dependency and the SQLite-backed records port
- [x] `go get github.com/dop251/goja@latest`; confirm it lands in `go.mod`/`go.sum` and `go build ./...` still succeeds with `CGO_ENABLED=0`.
- [x] Create `internal/gojaspike/port.go`: a `RecordsPort` struct over `*sql.DB` exposing `list(type)`, `put(type, record)`, `del(type, id)` to the VM.
- [x] Back the port with table `records(type TEXT, id TEXT, data JSON, PRIMARY KEY(type,id))`; `put` = `INSERT ... ON CONFLICT(type,id) DO UPDATE SET data=excluded.data`, `list` = `SELECT data WHERE type=?` (JSON-decoded to `map[string]interface{}`), `del` = `DELETE WHERE type=? AND id=?`.
- [x] Each port method must **resolve a real goja Promise** with the value (do NOT return raw values pretending to be async, and do NOT fabricate via `vm.RunString("Promise.resolve()")`): build a resolved `*goja.Promise` via the runtime's promise API (`NewPromise` + resolve, or return a value the JS `await` settles deterministically) so `await records.list(t)` yields the decoded array.
- [x] Every DB/JSON error inside the port is checked and surfaced (panic-to-JS-exception or returned rejection), never silently dropped.

### Task 2: VM harness + JS module loader with deterministic promise resolution
- [x] Create `internal/gojaspike/harness.go`: `loadModule(path)` reads `web/domain/<x>.js` and strips leading `export ` (`export function`→`function`, `export const`→`const`) so the factory becomes a global. Reading errors are checked.
- [x] `newVM(db, factoryName, nowMs, tz)` creates a `goja.Runtime`, evaluates the stripped module (checked `RunString` error), injects `{ records, now: ()=>nowMs, timeZone: tz }`, and constructs `const domain = <factoryName>(injectionArgs)`.
- [x] Add `awaitCall(vm, jsExpr) (goja.Value, error)`: run the expression returning a Promise, assert the result exports to `*goja.Promise`, **drain microtasks** (synchronous SQLite port settles within the job), then switch on `State()`: `Fulfilled`→return `Result()`; `Rejected`→return error with the rejection reason; `Pending`→return an explicit "promise did not settle" error. This is the single deterministic path all tests use.
- [x] Confirm the drain mechanism is correct for goja's job queue (goja runs enqueued promise reactions as the top-level call unwinds; if a manual pump is needed, do it explicitly and comment why) — prove it by a first assertion that a create call's promise is `Fulfilled`, never `Pending`. (`TestDrainIsDeterministic` in `harness_test.go` asserts Fulfilled + computed category.)

### Task 3: BP parity test (JS-via-goja vs internal/store/bp)
- [x] Create `internal/gojaspike/bp_parity_test.go`. Set up both sides with a **fixed** `now` (shared `fixedNowMs`/`fixedTZ` = America/New_York); Go side via `internal/store/db.Open(":memory:")` + migrations + `bp.New`, clock pinned via `SetClock`.
- [x] Category parity: for a table of (systolic,diastolic) fixtures, assert JS `calculateBPCategory` output (via a domain create) equals Go `bp.CalculateBPCategory` exactly across all buckets.
- [x] Create+list parity: put an identical sequence of readings through both the JS domain (`domain.create` then `domain.list`) and the Go store (`CreateReading` then `ListReadings`); assert the JS response objects match the Go readings field-by-field (category, ordering, values, pulse/notes/tag/ignore_calc).
- [x] Stats parity: drive a multi-day fixture through JS `domain.getStats` and Go `GetDailyWeightedStats`; assert the daily-weighted aggregates match (14/30/60).
- [x] All assertions use `awaitCall` from Task 2; every setup error `t.Fatalf`s. No `t.Logf`-only outcome anywhere.
- ⚠️ CAVEAT (feeds Task 6): goja has **no `Intl`** (`Intl is not defined`). bp.js/weight.js use `Intl.DateTimeFormat(...).formatToParts` only for tz day-boundary math. The harness (`injectIntlShim` in `harness.go`) installs a minimal `Intl` shim backed by Go's `time` package — the same tz DB the native store uses — so `web/domain/*.js` still runs unmodified. This is an environment shim, not a module change.

### Task 4: Weight parity test (JS-via-goja vs internal/store/weight)
- [ ] Create `internal/gojaspike/weight_parity_test.go` with the same fixed-clock/fixed-tz setup, Go side via `weight.New`.
- [ ] Trend parity: for a sequence of weights, assert JS `calculateWeightTrend` (via domain create → `weight_trend` in response) matches Go `weight.CalculateWeightTrend` (EWMA, alpha=0.1) across the sequence.
- [ ] Create+list parity: identical log sequence through JS `domain.create`/`domain.list` and Go `CreateLog`/`ListLogs`; assert response fields (weight, weight_trend, body_fat, muscle_mass, notes, ordering) match.
- [ ] Reuse fixture input sequences from `cloud.shim-contract.weight.test.js` where practical.
- [ ] `awaitCall` for every async call; all errors checked.

### Task 5: Benchmarks — cold-start, per-call, memory, pooled-vs-per-request
- [ ] Create `internal/gojaspike/benchmark_test.go`: `BenchmarkColdStart` measures `newVM` + module eval per iteration (fresh VM each time).
- [ ] `BenchmarkPerCallGoja` (reused VM: one create/list per iteration) and `BenchmarkPerCallNative` (the equivalent Go store call) for a like-for-like latency comparison.
- [ ] `BenchmarkPerRequestVM` (new VM per iteration incl. create) to contrast one-VM-per-request against the pooled/reused path.
- [ ] Create `internal/gojaspike/benchmark_mem_test.go`: measure per-VM heap via `runtime.ReadMemStats` (GC, snapshot, allocate N VMs, snapshot) and report bytes/VM; comment the measurement method and its noise caveat.
- [ ] Confirm `go test -run x -bench . ./internal/gojaspike/` runs cleanly; capture the actual numbers (they feed Task 6).

### Task 6: Document measured findings + defensible go/no-go in docs/cloud-mode.md
- [ ] Under "The client: porting the domain layer", add a "Goja spike (med-07y.1) — measured findings" subsection.
- [ ] Record the **measured** numbers from Task 5 (cold-start, per-call goja vs native, bytes/VM, pooled vs per-request) with the **measurement method** stated (Go benchmarks, `runtime.MemStats`, in-memory SQLite, fixed clock) and **noise/caveat** notes — no rounding to marketing figures.
- [ ] State explicitly what was proven (value-exact BP+weight create/list/stats/category/trend parity) and what was **not** (only 2 of N domains; ESM handled by a strip transform not a real module loader; single-user/fixed-tz; no concurrency/GC-pressure test).
- [ ] Give a defensible **goja vs Node-sidecar** recommendation grounded in the measured evidence and caveats, framed as input to C6 — not a production decision.

### Task 7: Verify acceptance criteria
- [ ] Re-check each maintainer blocker: (1) no log-only tests — grep the package for `t.Logf` as sole outcome; (2) deterministic promise resolution proven (no `Pending`); (3) no ignored errors — every `Exec`/`Open`/`RunString`/`Marshal` checked; (4) docs report caveats not overconfidence.
- [ ] `CGO_ENABLED=0 go build ./...` succeeds; goja imported only from `internal/gojaspike` (`go list -deps` sanity: no other package pulls it).
- [ ] `go vet ./internal/gojaspike/...` clean; `go test ./internal/gojaspike/...` passes deterministically (run twice to confirm no flakiness).
- [ ] `go test ./...` still passes; `pnpm test` unaffected (no frontend change — `web/domain/*.js` untouched).

### Task 8: [Final] Update project knowledge
- [ ] If a non-obvious pattern emerged (goja promise-drain idiom, ESM-strip loader, records-port shape), note it briefly in `docs/cloud-mode.md` where future C6 work will look.

## Technical Details
- **Promise drain**: goja executes enqueued promise-reaction jobs as the current top-level `RunString` call unwinds. Because the SQLite records port is synchronous, an `await records.list()` chain settles fully within that single job — so after `RunString` returns, the returned `*goja.Promise` is already `Fulfilled`. `awaitCall` asserts this rather than assuming it (fails loudly on `Pending`).
- **Value parity, not string identity**: compare exported Go values field-by-field (`reflect.DeepEqual` on normalized maps / explicit field asserts), tolerating representation differences (e.g. JS numbers ↔ Go int/float) by normalizing before compare. Document any normalization applied.
- **Fixed clock**: inject `now: () => fixedNowMs` on the JS side and `SetClock`/fixed time on the Go side so trend/stats/day-boundary math is deterministic.

## Post-Completion
*No checkboxes — informational only.*

**Human decision:**
- The actual goja-vs-sidecar go/no-go for C6 is the maintainer's call, informed by this spike's measured evidence and stated caveats.

**Follow-up (out of scope here):**
- C6 (`med-07y`) production wiring + shadow mirroring — a separate bead. This spike deliberately stops at "we know which path."
