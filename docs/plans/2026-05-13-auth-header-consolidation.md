# Auth header consolidation

## Overview

Two different auth-header schemes coexist in the frontend:

| Header                                 | Files                                                                       |
|----------------------------------------|-----------------------------------------------------------------------------|
| `X-Telegram-Init-Data: <init>`         | `core/api.js:8`, `app.js:3241`, `features/elevenlabs-call.js:181`, `features/food.js:345, 492, 1041, 2609` |
| `Authorization: tma <init>`            | `features/bp.js:682` (CSV export), `features/weight.js:1163` (CSV export)   |

The two CSV-export call sites use a different scheme from every other
request. The two functions are nearly identical (`bp.js:678-696` ≈
`weight.js:1159-1175`), strongly suggesting copy-paste rather than a
deliberate decision. Either the server validates both schemes (so this
is silent inconsistency) or one of them is broken under specific
deployments — neither is a good state.

This plan extracts a single `makeAuthHeaders()` helper, routes every
existing call site through it, and uses one canonical scheme
(`X-Telegram-Init-Data`, the more widely-used of the two).

**Out of scope:**
- The Service Worker handlers (covered by the
  [SW handler unification plan](2026-05-13-sw-handler-unification.md)
  Task 1).
- Cookie-based authentication paths (the helpers compose with cookies;
  cookie behaviour does not change).

From the [2026-05-13 frontend review §6](../2026-05-13-frontend-code-review.md#6-auth-header-inconsistency-x-telegram-init-data-vs-authorization-tma)
and recommended-priority item #2.

## Context (from discovery)

- **Existing canonical client**: `core/api.js:7-58` (`apiCallDirect`).
  Already constructs `headers = { "X-Telegram-Init-Data": window.userInitData };`
  Promotes naturally to a separate helper that this function calls.
- **Direct fetch call sites that bypass apiCallDirect** — the ones that
  need to use the new helper:
  - `web/static/js/features/food.js:344-346` — fetch with `X-Telegram-Init-Data`
    (food product search; uses streaming so cannot use apiCallDirect)
  - `web/static/js/features/food.js:489-493` — fetch with `X-Telegram-Init-Data`
  - `web/static/js/features/food.js:1039-1043` — fetch with `X-Telegram-Init-Data`
  - `web/static/js/features/food.js:2606-2611` — fetch with `X-Telegram-Init-Data`
  - `web/static/js/features/elevenlabs-call.js:179-183` — `headers['X-Telegram-Init-Data']`
  - `web/static/js/features/bp.js:678-696` — CSV export, uses `Authorization: tma`
  - `web/static/js/features/weight.js:1159-1175` — CSV export, uses `Authorization: tma`
  - `web/static/js/app.js:3239-3242` — multipart/form-data upload (food photo);
    uses `X-Telegram-Init-Data`
- **Server-side acceptance**: confirm by inspecting
  `internal/server/auth.go` — both header forms must remain accepted
  during the transition window (one PR cannot atomically change every
  client tab in production); after this plan ships, the
  `Authorization: tma` server path becomes unused but stays as a no-op.
- **No tests cover the auth-header construction itself today** — adding
  one architecture test that scans for raw `X-Telegram-Init-Data`
  string literals outside the helper file is the right enforcement
  shape.

## Development Approach

- **Testing approach**: Regular.
- One PR. Backwards-compatible: server keeps accepting both schemes;
  client unification happens in lockstep with helper introduction; old
  clients still work.
- Architecture test added in the same commit prevents regression.

## Testing Strategy

- **Unit tests**: required. Cover (1) helper returns header when token
  present, (2) returns empty object when token absent, (3) supports
  appending content-type for body requests.
- **Architecture test**: scan `web/static/js/**.js` (excluding the
  helper file itself and tests) for raw `X-Telegram-Init-Data` /
  `Authorization: tma` literals — fail with a pointer to the helper.
- **No e2e impact**: the user-facing behaviour does not change.

## Progress Tracking

- Mark completed items with `[x]` immediately.
- Add ➕ for new tasks; ⚠️ for blockers.

## Implementation Steps

### Task 1: Extract `makeAuthHeaders()` helper

- [ ] add `makeAuthHeaders(extra = {})` to `web/static/js/core/api.js`
  (top of file, exported on `window.makeAuthHeaders`); returns a fresh
  headers object containing `X-Telegram-Init-Data` from
  `window.userInitData` when present, plus any caller-supplied extras
- [ ] refactor `apiCallDirect` (`core/api.js:7-58`) to use the new
  helper instead of constructing the header inline
- [ ] add `window.makeAuthHeaders` to the allowlist in
  `web/static/js/tests/architecture.globals.test.js` with a justification
  ("auth header construction shared by direct-fetch callers")
- [ ] write tests in `web/static/js/tests/core.api-headers.test.js`:
  with token present, returns header object containing
  `X-Telegram-Init-Data`; with token absent, returns object without that
  key; merges caller-supplied extras (e.g. `Content-Type`); does not
  mutate `extra`; subsequent reads of `window.userInitData` reflect
  changes (for the SW-token-update edge)
- [ ] run `pnpm test core.api-headers` — must pass before next task

### Task 2: Migrate direct-fetch call sites in `features/food.js`

- [ ] replace `headers = { "X-Telegram-Init-Data": userInitData }` at
  `features/food.js:345` with `headers = window.makeAuthHeaders()`
- [ ] same for `features/food.js:492`
- [ ] same for `features/food.js:1041` (use
  `makeAuthHeaders({ 'Content-Type': 'application/json' })` if the
  request has a body — verify per call site)
- [ ] same for `features/food.js:2609`
- [ ] write tests in `web/static/js/tests/food.auth-headers.test.js`
  verifying each refactored call passes the expected header into the
  mocked `fetch` (table-driven)
- [ ] run `pnpm test food.auth-headers` and `pnpm test food.` — must
  pass before next task

### Task 3: Migrate `features/elevenlabs-call.js` and `app.js`

- [ ] replace `headers['X-Telegram-Init-Data'] = window.userInitData`
  at `features/elevenlabs-call.js:181` with merging
  `makeAuthHeaders()` into the headers object before fetch
- [ ] replace `headers: { 'X-Telegram-Init-Data': userInitData }` at
  `app.js:3241` (multipart photo upload) with
  `headers: makeAuthHeaders()`; preserve existing FormData body
- [ ] write tests in `web/static/js/tests/elevenlabs.auth-headers.test.js`
  and add a case to `app.unit.test.js` (or appropriate existing app
  test) verifying header construction
- [ ] run `pnpm test elevenlabs.auth-headers` and `pnpm test app.` —
  must pass before next task

### Task 4: Migrate CSV-export call sites and drop `Authorization: tma`

- [ ] replace the `headers: { 'Authorization': 'tma ${userInitData}' }`
  at `features/bp.js:682` with `headers: window.makeAuthHeaders()`
- [ ] same for `features/weight.js:1163`
- [ ] verify backend accepts `X-Telegram-Init-Data` for `/api/bp/export`
  and `/api/weight/export` by reading `internal/server/bp_handlers.go`
  and `weight_handlers.go` — they should already use the standard
  middleware; if not, document the gap and stop here
- [ ] write a CSV-export test that mounts the export handler and
  asserts the migrated header form is sent (one test per export)
- [ ] run `pnpm test bp.` and `pnpm test weight.` — must pass before
  next task

### Task 5: Architecture test prevents regression

- [ ] add `web/static/js/tests/architecture.auth-headers.test.js` that
  reads every file under `web/static/js/` (excluding `tests/`,
  `vendor/`, and `core/api.js` which is the canonical home), greps for
  the literal strings `"X-Telegram-Init-Data"`, `'X-Telegram-Init-Data'`,
  `Authorization': 'tma`, `"Authorization": "tma`, and asserts zero
  matches; on failure, the message points at the helper
- [ ] run `pnpm test architecture.auth-headers` — must pass

### Task 6: Verify acceptance

- [ ] grep for `X-Telegram-Init-Data` in `web/static/js/` (excluding
  `core/api.js` and tests) returns zero matches
- [ ] grep for `Authorization': 'tma` and `"Authorization": "tma` in
  `web/static/js/` returns zero matches
- [ ] full `pnpm test` clean
- [ ] `go test ./...` clean (sanity)

## Technical Details

### `makeAuthHeaders` shape

```javascript
function makeAuthHeaders(extra) {
    const headers = { ...(extra || {}) };
    if (window.userInitData) {
        headers['X-Telegram-Init-Data'] = window.userInitData;
    }
    return headers;
}
window.makeAuthHeaders = makeAuthHeaders;
```

Rationale for picking `X-Telegram-Init-Data` over `Authorization: tma`:
the X-header form already serves 9 out of 11 call sites and is the
shape `apiCallDirect` uses, so unification toward it is the smaller
change. The server's `Authorization: tma` parser stays in place (no
client uses it after this PR, but removing it from Go is a separate
follow-up to avoid coupling client and server PRs).

### Migration ordering note

Tasks 2–4 each migrate a small group; finishing the helper (Task 1)
first means each subsequent task has the safety net of the architecture
test (added in Task 5) catching any missed call site once the
architecture test is committed last. Order matters: helper → migrate →
test, not test → migrate (the test would fail until every site is
moved, blocking incremental commits).

## Post-Completion

**Manual verification** (optional):
- After deploy, hit `/api/bp/export` from the BP screen and confirm a
  CSV downloads — proves the new header form is accepted server-side.

**External system updates** (deferred follow-up, not blocking):
- After this plan is merged and stable for one release cycle, remove
  the `Authorization: tma` parser from `internal/server/auth.go`.
  Track in a separate one-line plan once the deprecation window ends.
