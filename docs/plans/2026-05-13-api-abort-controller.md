# `AbortController` on `apiCallDirect`

## Overview

`web/static/js/core/api.js:7-58` (`apiCallDirect`) calls `fetch()` with
no `signal:` field. There are **zero** uses of `AbortController` across
the entire production frontend codebase (`grep -r AbortController
web/static/js --include='*.js' | grep -v /tests/` returns nothing). A
slow backend hangs the call indefinitely; the only thing that breaks
the hang is the user navigating away or the SW returning a cached 503.

Visible consequences:

1. **Stalled food product search.** `features/food.js:344-384` reads
   from a `ReadableStream` line by line — if the stream stalls
   mid-record, the user sees the search spinner forever.
2. **`BOOTSTRAP_UPDATED` revalidation can hold the SW alive.**
   `sw.js:148-167` calls `fetch(event.request)` inside
   `event.waitUntil(...)` with no timeout — a stalled bootstrap keeps
   the install/fetch lifecycle event alive arbitrarily long.
3. **Tests cannot reproduce slow-backend conditions** because there's
   no signal to abort.

This plan adds a configurable timeout to `apiCallDirect` (default 60s,
caller-overridable), threads `AbortSignal` into the helper, and wires
shorter deadlines into the food-search streaming read and the SW
bootstrap revalidation.

**Out of scope:**
- Adding cancellation tokens to feature loaders that don't have
  reentrancy bugs today (e.g. BP / weight loaders are already
  one-shot).
- Per-request retry/backoff (separate concern; sync.js already has
  exponential backoff for offline writes).

From the [2026-05-13 frontend review §9](../2026-05-13-frontend-code-review.md#9-no-request-timeouts-no-abortcontroller-anywhere)
and recommended-priority item #3.

## Context (from discovery)

- **Single chokepoint**: `core/api.js:7-58`. Every cached/SWR/feature
  call funnels through here (via `apiCall` in `core/api.js:65-92` or
  via `cachedFetch` in `cached-fetch.js:97-106`). Adding a signal here
  covers ~95% of the surface for free.
- **Streaming reads bypass apiCallDirect**: only place is
  `features/food.js:344-384` which uses `fetch().body.getReader()`
  directly. Needs separate abort wiring.
- **SW fetches**: `sw.js` has multiple bare `fetch()` calls
  (lines 150, 171, 195, 243, 282, 295). The bootstrap revalidation at
  150 is the most operationally risky.
- **Existing helpers don't accept options**: `apiCallDirect(endpoint,
  method, body)` — three positional args. Adding a 4th `opts` arg is
  backwards-compatible.
- **Test helpers**: `tests/cached-fetch.unit.test.js` already mocks
  `apiCallDirect` and `fetch` shape; the new signal threading must
  remain compatible.
- **`AbortSignal.timeout(ms)`** is supported in all browsers the app
  cares about (modern Safari, Chrome, Firefox, Telegram WebView). Use
  it as the primitive — no need for a manual `setTimeout(()=>controller.abort())`
  shim.

## Development Approach

- **Testing approach**: Regular.
- Single PR. Default timeout (60s) is conservative — chosen so that
  no existing flow that legitimately takes <60s breaks. Food search
  and bootstrap get tighter caps (10s, 15s respectively).
- Tests use Vitest's fake timers + a delayed-`fetch` mock to
  deterministically trigger the timeout.

## Testing Strategy

- **Unit tests**: required. Helper aborts on timeout; helper passes
  through caller-supplied signal (composed); helper does not abort
  successful fast calls.
- **Integration test**: food-search streaming read aborts on timeout
  and surfaces a typed error the UI can render.
- **No e2e impact** in normal operation; manual smoke-test optional.

## Progress Tracking

- Mark completed items with `[x]` immediately.
- Add ➕ for new tasks; ⚠️ for blockers.

## Implementation Steps

### Task 1: Add timeout/signal support to `apiCallDirect`

- [x] modify `apiCallDirect` signature in `core/api.js:7` to
  `apiCallDirect(endpoint, method = 'GET', body = null, opts = {})`;
  destructure `{ timeoutMs = 60_000, signal: callerSignal }` from
  `opts`
- [x] inside the function, build a composite signal: if both
  `timeoutMs` is finite AND `callerSignal` is provided, use
  `AbortSignal.any([AbortSignal.timeout(timeoutMs), callerSignal])`;
  if only one is provided, use that; pass the resulting signal to
  `fetch(endpoint, { method, headers, body, signal })`
- [x] wrap the existing `fetch()` await in a try/catch — when
  `error.name === 'TimeoutError'` or `error.name === 'AbortError'`,
  rethrow with `err.aborted = true` so callers can distinguish abort
  from network error
- [x] update `apiCall` in `core/api.js:65-92` to forward the optional
  4th `opts` arg unchanged; do NOT swallow `AbortError`s the same way
  it swallows network errors — let them bubble so the caller can
  decide
- [x] write tests in `web/static/js/tests/core.api-abort.test.js`:
  default 60s timeout fires when fetch never resolves; caller-supplied
  signal aborts mid-flight; signal+timeout composition aborts on
  whichever fires first; successful fast call is unaffected; abort
  surfaces with `err.aborted === true`
- [x] run `pnpm test core.api-abort` — must pass before next task

### Task 2: Thread tighter deadlines through cached-fetch

- [x] modify `cachedFetch` in `web/static/js/cached-fetch.js:152` to
  accept `timeoutMs` in `opts` (default unspecified — i.e. uses
  `apiCallDirect`'s 60s default); forward it via `fetchOpts.timeoutMs`
  into the `performFetch` → `apiCallDirect` chain
- [x] update `performFetch` (`cached-fetch.js:97-106`) to pass
  `{ timeoutMs }` as the 4th arg to `direct(...)`
- [x] write tests in `web/static/js/tests/cached-fetch.abort.test.js`:
  caller-supplied `timeoutMs` propagates; abort during background
  revalidation does not throw to the foreground caller; cache hit
  still returns even when revalidation aborts
- [x] run `pnpm test cached-fetch.abort` — must pass before next task

### Task 3: Apply 10s timeout to food-product search

- [x] in `features/food.js:336-384`, create a per-search
  `AbortController`; abort the previous controller when a new search
  starts (currently handled via `foodSearchRequestId` token — keep
  that, add abort on top); pass `signal: controller.signal` to the
  `fetch(endpoint, { method: 'GET', headers, signal })` call at line 346
- [x] add `setTimeout(() => controller.abort(), 10_000)` inside the
  search debounce; clear the timeout on stream completion
- [x] handle `AbortError` in the existing try/catch block
  (`features/food.js:~395`) — render a "Search timed out" status via
  `setFoodSearchStatus`, do not log to console
- [x] write tests in `web/static/js/tests/food.search-abort.test.js`:
  rapid sequential searches abort the previous fetch (proves no
  stream-leak); 10s timeout surfaces the typed status; successful
  search still resolves
- [x] run `pnpm test food.search-abort` — must pass before next task

### Task 4: Apply 15s timeout to SW bootstrap revalidation

- [ ] in `sw.js:148-167`, wrap the background `fetch(event.request)`
  in `AbortSignal.timeout(15_000)`; on `AbortError` from that path,
  swallow silently — same as existing `.catch(() => {})` shape
  (revalidation failure is non-fatal; cached response was already
  served)
- [ ] bump `BUILD_REVISION` in `sw.js:6` so existing clients pick up
  the new SW
- [ ] write a test in `web/static/js/tests/sw-bootstrap-abort.test.js`
  verifying the SW returns the cached response on time even when the
  revalidation `fetch` is artificially slow
- [ ] run `pnpm test sw-bootstrap-abort` — must pass before next task

### Task 5: Verify acceptance

- [ ] grep for `AbortController\|AbortSignal\.timeout` in
  `web/static/js/` returns at least 4 hits (api.js, cached-fetch.js,
  food.js, sw.js)
- [ ] full `pnpm test` clean
- [ ] no test takes longer than 5s wall-clock to run (proves no real
  fetch races slipped in)
- [ ] manually confirm `apiCallDirect` callers that wanted shorter
  deadlines (food search, bootstrap) propagate them correctly by
  reading the call sites

## Technical Details

### Composite signal pattern

```javascript
function composeSignal(timeoutMs, callerSignal) {
    const timeoutSignal = Number.isFinite(timeoutMs)
        ? AbortSignal.timeout(timeoutMs)
        : null;
    if (timeoutSignal && callerSignal) return AbortSignal.any([timeoutSignal, callerSignal]);
    return timeoutSignal || callerSignal || undefined;
}
```

`AbortSignal.any` is supported in all targeted browsers as of mid-2024.
Verify in `core.api-abort.test.js` by mocking both signals.

### Why 60s default

The longest legitimate flows are bootstrap (cold-start with full data
hydration) and CSV exports (potentially large). 60s is well above both
in practice. Most calls complete under 1s; the 60s cap exists only to
prevent infinite hangs.

### Why food search gets 10s

Already a streaming read; the user is actively waiting. 10s is the
upper bound where any human notices a stall. The server-side search is
typically <500ms; 10s is 20× headroom.

## Post-Completion

**Manual verification** (recommended):
- Use browser DevTools network throttling set to "offline" *while*
  pressing the Refresh button; confirm the spinner clears within ~60s
  rather than spinning forever.
- Use the Telegram WebApp on a stalled connection (airplane mode mid-
  flight) and verify food search surfaces a "timed out" status rather
  than spinning.

**No external system updates needed.**
