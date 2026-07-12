# Cloud PWA Offline App Shell — SW fetch handler + versioned cache (med-deq.1)

## Overview
The cloud-mode service worker (`web/cloud/sw.js`) is push-only: it handles
install/activate/push/notificationclick/pushsubscriptionchange but has **no
fetch handler and no asset cache**. Consequence: an installed cloud PWA cannot
open with zero network — tapping its icon offline yields the browser error
page. `web/static/js/app-shell.js` deliberately skips registering the bot-mode
precaching SW in cloud mode, and every cloud asset is served `no-store`, so no
HTTP-cache backstop exists either.

This change extends `web/cloud/sw.js` (the one SW already registered on account
subdomains) with a **network-first fetch handler backed by a versioned Cache
API store**, so the warm-unlock path renders from cache when the network is
unreachable, while online navigation always hits the network first (fresh
per-account CSP, fresh assets) and refreshes the cache.

**Strictly SW-only diff.** The Cache API stores responses regardless of
`no-store` HTTP headers, so `internal/cloudserver/router.go` needs no change.

## Context (from discovery)
- `web/cloud/sw.js` — push-only SW. `SW_VERSION` const (line 15,
  `CACHE_VERSION_PLACEHOLDER`, rewritten per-deploy by `.github/workflows/deploy.yml`)
  already gives a per-deploy version key. `CACHE_PREFIX = 'medtracker-cloud'`
  (line 22). Existing `activate` handler (lines 28-35) currently deletes **all**
  caches with that prefix (safe today because there is no cache to keep) then
  `clients.claim()`.
- Asset routing in `internal/cloudserver/router.go` (~lines 313-373):
  - `/` — account document (HTML), per-request CSP from stored egress hosts, `no-store`.
  - `/unlock`, `/claim`, `/recover`, `/devices`, `/connectors` — shell pages (signup.html), `no-store`.
  - `/static/*` (real app JS/CSS, `?v=<build_ts>` fingerprinted) + `/static/config.js` (generated).
  - `/domain/*` (runtime-agnostic BP/weight modules, fingerprinted).
  - `/api/*`, `/mcp/*` — dynamic, **must never be cached**.
- Reference fetch handler: `web/static/sw.js` (bot mode) — network-first for
  `/api/`, stale-while-revalidate for navigations, cache-first for static. We
  adopt a single simpler network-first-with-cache-fallback strategy (see below).
- Test harness pattern: `web/cloud/js/tests/sw.reminder-actions.test.js` loads
  `sw.js` via `new Function('self','caches','fetch','indexedDB', src)(...)` with
  hand-rolled mocks and fires captured listeners. New test follows this exactly.
- Node: system is v18; `pnpm test` needs Node 20 at
  `/tmp/node-v20.18.1-linux-x64/bin` (prepend to PATH).

## Development Approach
- **Testing approach**: Regular (code first, then tests) — the SW is a
  pure-unit test layer; the new behavior is small and self-contained.
- One task adds the fetch handler + activate update; one task adds tests; a
  final task verifies acceptance + runs the full suite.
- **All tests must pass before the task is considered done.**
- Strictly SW-only: do NOT touch `router.go`, CSP emission, or
  `web/cloud/js/sync.js` (owned by another executor right now).

## Testing Strategy
- **Unit tests**: new `web/cloud/js/tests/sw.fetch-cache.test.js` driving the
  captured `fetch` and `activate` listeners against mock `caches`/`fetch`.
- No e2e layer for the SW; offline is simulated by rejecting `fetch`.
- Run full `pnpm test` (Node 20) to confirm no regression in existing cloud SW
  tests (`sw.push-resubscribe`, `sw.reminder-actions`, `architecture.sw-version`).

## Progress Tracking
- Mark completed items `[x]` immediately.
- ➕ for newly discovered tasks, ⚠️ for blockers.

## Implementation Steps

### Task 1: Add fetch handler + versioned cache to web/cloud/sw.js
- [x] Add a `SHELL_CACHE = \`${CACHE_PREFIX}-shell-${SW_VERSION}\`` constant near
      the existing `CACHE_PREFIX` (line 22), reusing the deploy-rewritten
      `SW_VERSION` so the cache name changes every deploy.
- [x] Add a top-of-handler comment block documenting the **CSP-snapshot-freeze
      rationale**: the `/` document carries a per-account CSP computed from
      stored egress hosts; a cached copy replayed offline freezes that CSP
      snapshot. Acceptable because offline there is no egress anyway, and the
      next successful online navigation (network-first) overwrites the cached
      copy. Never serve a cached document when the network responded.
- [x] Add `self.addEventListener('fetch', ...)` that:
      - Ignores (does not call `respondWith`, lets it pass to network) any
        request that is **not GET**, is **cross-origin**, or whose pathname
        starts with `/api/` or `/mcp/`. `/api/*` is NEVER cached or served from
        cache.
      - For all other same-origin GETs (the `/` document, shell pages,
        `/static/*`, `/domain/*`): **network-first** — `fetch(request)`, and on
        a successful (`response.ok`) response, `cache.put(request, clone)` into
        `SHELL_CACHE` then return it; on network rejection, return
        `caches.match(request)`, falling back to `caches.match('/')` (the app
        shell) so a deep-link navigation still opens offline; if nothing
        cached, re-throw / return the failed fetch.
- [x] Update the existing `activate` handler so it prunes only caches whose name
      starts with `CACHE_PREFIX` **and is not** the current `SHELL_CACHE` (keep
      the current version), still ending with `self.clients.claim()`.
- [x] Leave push / notificationclick / pushsubscriptionchange / decodePush /
      readNK and all their helpers **byte-for-byte unchanged**.
- [x] ➕ Update `web/cloud/js/tests/architecture.sw-version.test.js`: its
      "declares no cache it never serves from" case asserted the SW is
      push-only (no fetch handler, no `caches.open`) — obsolete by design now;
      replaced with the inverse invariant (fetch handler paired with a
      `SW_VERSION`-keyed cache name, still no `PRECACHE_URLS`). The test's own
      comment said to update it together with a fetch handler.

### Task 2: Unit tests — web/cloud/js/tests/sw.fetch-cache.test.js
- [x] Create the test following `sw.reminder-actions.test.js`'s loader
      (`new Function('self','caches','fetch','indexedDB', src)`) with a mock
      `caches` object backed by an in-memory Map (open→{match,put}, keys, delete)
      and a controllable `fetch`, capturing listeners into a Map.
- [x] Test: **offline document** — `fetch` rejects, cache pre-seeded with a `/`
      response → the fetch handler resolves to the cached shell.
- [x] Test: **online passthrough + refresh** — `fetch` resolves ok → handler
      returns the network response AND writes it into the versioned cache
      (assert `cache.put` called for `/` and a `/static/*` asset).
- [x] Test: **/api/\* never cached, never served from cache** — a GET to
      `/api/whatever` is not intercepted (no `respondWith` / passes to network),
      and even when the network fails the handler does not serve a cached
      `/api/*` response.
- [x] Test: **non-GET passthrough** — a POST is not intercepted.
- [x] Test: **activate prunes old, keeps current** — `caches.keys()` returns an
      old `medtracker-cloud-shell-vOLD` plus the current name and an unrelated
      cache; assert only the old prefixed one is deleted and the current is kept.
- [x] Run `pnpm test web/cloud/js/tests/sw.fetch-cache.test.js` (Node 20) — must
      pass. (8 tests, all green; also covers /mcp/*, cross-origin, and offline
      deep-link → `/` shell fallback beyond the required four.)

### Task 3: Verify acceptance criteria
- [ ] Re-read med-deq.1 acceptance: offline navigation renders the shell from
      cache; online is network-first and refreshes cache; `/api/*` never served
      from SW cache; push handling unchanged; old cache versions pruned on
      activate; SW unit tests cover all four.
- [ ] Confirm no changes outside `web/cloud/sw.js` and the new test file
      (`git diff --stat` shows only those two + this plan).
- [ ] Run the full `pnpm test` suite (Node 20) — all green, existing cloud SW
      tests still pass.
- [ ] Confirm no new `window.*` global was introduced (SW has no window; N/A but
      verify architecture tests pass).

## Technical Details
- **Cache name**: `medtracker-cloud-shell-<SW_VERSION>`. `SW_VERSION` is
  `CACHE_VERSION_PLACEHOLDER` at rest, rewritten to `v<BUILD_TS>` per deploy —
  the same mechanism `web/static/sw.js` uses, so cache-busting is automatic.
- **Strategy choice**: single network-first-with-cache-fallback for every
  cacheable GET (document, shell pages, `/static/*`, `/domain/*`). Rationale:
  everything cloud serves is `no-store`, so online the browser already refetches
  every asset each load; network-first changes nothing online except an added
  cache write, and it keeps the per-account CSP document fresh online while
  giving a working offline copy. Simpler + more correct than mixing cache-first
  (which would freeze the un-fingerprinted shell `/js/*` files).
- **Never cached**: `/api/*`, `/mcp/*`, non-GET, cross-origin — passed straight
  through (no `respondWith`).

## Post-Completion
*No checkboxes — informational.*

**Manual verification** (deploy-time, cannot be automated here):
- Install the cloud PWA on a device, go offline (airplane mode), tap the icon →
  the app shell renders and warm unlock completes end-to-end.
- Online reload always shows the freshest CSP/assets (network-first).

**External**:
- `.github/workflows/deploy.yml` already rewrites `CACHE_VERSION_PLACEHOLDER` in
  `web/cloud/sw.js`; no workflow change needed — the new cache name inherits it.
