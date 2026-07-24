# Cloud SW: precache ceremony/secondary pages for offline (med-gvk.3)

## Overview

In cloud mode the service worker `web/cloud/sw.js` warm-crawls only the `/`
(index.html) app shell and its module graph. The ceremony/secondary documents
served at `/unlock`, `/claim`, `/recover`, `/devices`, `/connectors` are a
DIFFERENT document (`web/cloud/signup.html`, whose entry module is
`/js/app.js`), and are never precached. So a warm-unlock user who is offline and
taps Settings → Devices / Connectors gets a DEAD page: `cachedNavigationDoc`
finds no exact cache entry, refuses the `/` app shell for ceremony paths
(anti-ping-pong, med-eas.16), and falls through to the network which is down.

**Fix**: extend the warm precache to ALSO warm the ceremony document
(`signup.html`) and its transitive subresource + ES-module graph, caching the
document under EVERY ceremony path so an offline navigation to any of them is an
exact cache hit. The ceremony warm is BEST-EFFORT (it never rejects the
primary-shell install), mirroring med-gvk.1's core-vs-optional resilience: the
`/` app shell stays CORE-strict, the secondary ceremony shell is log-and-skip.

Approach chosen: **warm-precache** (not a cache-first fetch-handler change).
Reason: caching the ceremony document under each of the 5 ceremony paths makes
the EXISTING exact-match branch in `cachedNavigationDoc` serve them offline with
ZERO fetch-handler logic change — the anti-ping-pong `/`-shell fallback stays
intact for the still-uncached case. The fetch handler already has a test proving
"a ceremony page with its own cached copy still renders it".

## Context (from discovery)

- `web/cloud/sw.js`:
  - `warmShell()` (~L91): fetches `/`, extracts `<script src>`/`<link href>`
    refs via `SHELL_REF_RE`, CORE wave via `Promise.all` (rejects install on
    miss), then OPTIONAL module-graph waves via `Promise.allSettled`
    (log+skip). `cacheAndCrawl()` (~L55) fetches one asset, caches it, returns
    its module deps (`moduleDeps` via `MODULE_IMPORT_RE`, which already matches
    dynamic `import('./x.js')`). `CRAWLABLE_RE` skips vendor bundles.
  - `CEREMONY_PATHS` (~L177) = `/unlock /claim /recover /devices /connectors`.
  - `cachedNavigationDoc()` (~L183): exact `caches.match(request)` wins first;
    else ceremony paths return undefined (no `/`-shell), non-ceremony fall back
    to cached `/`.
- Router: `internal/cloudserver/router.go` L334-337 rewrites all 5 ceremony
  paths to `/signup.html` internally (same served document).
- `web/cloud/signup.html`: `<link href="/css/cloud.css">` + `<script
  src="/js/app.js" type="module">` (+ `/static/manifest.json`,
  `/static/icons/icon-192.png`). Entry `web/cloud/js/app.js` dynamically
  imports `claim.js`, `recover.js`, `unlock.js`, `devices.js`, `connectors.js`,
  `signup.js` — the whole ceremony graph, reachable via `MODULE_IMPORT_RE`.
- Tests: `web/cloud/js/tests/sw.fetch-cache.test.js` — the owning integration
  suite. The disk-backed real-repo install test (~L408) currently asserts
  ceremony paths are NOT cached (~L457) and routes ceremony paths to a
  nonexistent `web/cloud/<path>` (404); both must change. Two synthetic install
  tests (~L307 complete-shell, ~L340 flaky) will now trigger a best-effort
  ceremony-doc fetch that 404s in their mocks — must stay green.
- Console rule (`web/static/js/tests/helpers/setup.js`): any `console.warn`
  fails a test unless it calls `allowConsoleNoise()`.

## Development Approach

- **Testing approach**: Regular (code + tests together per task).
- Integration-first per CLAUDE.md rule 8: extend the existing
  `sw.fetch-cache.test.js` describe block. NO new `*-branches`/`*-edges` files.
- Smallest coherent diff: reuse the existing `cacheAndCrawl` / `moduleDeps` /
  `SHELL_REF_RE` / `MODULE_IMPORT_RE` machinery — do NOT hand-maintain a
  divergent ceremony asset list.
- Keep med-gvk.1 per-asset OPTIONAL tolerance intact (no regression).
- Do NOT touch `web/cloud/js/apishim.js` or any `web/static/js/features/*`
  (sibling executor owns med-gvk.4 there) — merge-disjoint.
- All tests pass before finishing.

## Testing Strategy

- **Unit/integration tests**: extend `web/cloud/js/tests/sw.fetch-cache.test.js`.
- No E2E harness for the SW; the disk-backed real-repo install test is the
  authoritative guard that the ceremony module graph resolves against real files.

## Progress Tracking
- Mark completed items `[x]` immediately.
- ➕ for newly discovered tasks, ⚠️ for blockers.

## Implementation Steps

### Task 1: Warm the ceremony document + module graph in sw.js
- [ ] In `web/cloud/sw.js`, refactor the subresource+module-graph crawl out of
      `warmShell()` into a reusable helper `warmDocGraph(cache, docUrl, html,
      seen, strict)`: when `strict` (the `/` app shell) the DIRECT-subresource
      wave uses `Promise.all` (reject on miss = CORE, unchanged behavior); when
      not strict the direct refs fold into the `Promise.allSettled` best-effort
      loop. Module-graph waves stay `allSettled` in both. `seen` is shared
      across calls so an asset cached by an earlier document is not re-fetched.
- [ ] Have `warmShell()` build the shared `seen` set, warm `/` CORE-strict via
      the helper (identical semantics to today), then call a new best-effort
      `warmCeremony(cache, seen)` guarded so its failure NEVER rejects the
      primary-shell install (`.catch(log)`), and does not emit an
      always-on `console.warn` at the top level (keep the existing per-asset
      skip warnings only; a ceremony-doc miss returns quietly) so the two
      synthetic install tests without a ceremony route stay green.
- [ ] Implement `warmCeremony(cache, seen)`: fetch one ceremony path
      (`/unlock`; the router serves signup.html for all five). If not ok,
      return (skip). Otherwise cache the response under EVERY path in
      `CEREMONY_PATHS` (a fresh `.clone()` per `cache.put`), then
      `warmDocGraph(cache, '/unlock', html, seen, false)` to crawl
      `/css/cloud.css` + `/js/app.js` and app.js's dynamic-import ceremony graph.
- [ ] Confirm no fetch-handler / CSP / document-header change is needed
      (exact-match in `cachedNavigationDoc` already serves the cached ceremony
      docs; anti-ping-pong fallback unchanged).
- [ ] `export PATH` Node 20; run `npx vitest run web/cloud/js/tests/sw.fetch-cache.test.js`
      — expect the two ceremony-affected tests (below) to fail until Task 2.

### Task 2: Update + extend the cloud SW tests
- [ ] Update the disk-backed real-repo install test (~L408): route the 5
      ceremony paths to `web/cloud/signup.html` in the fetch mock (mirroring
      router.go's rewrite), so `warmCeremony` resolves against real files.
- [ ] In that test, replace the "ceremony paths NOT cached" assertion with:
      each of the 5 ceremony paths IS now cached, AND signup's boot-critical
      module graph is warmed (`/js/app.js`, `/js/unlock.js`, `/js/devices.js`,
      `/js/connectors.js`, `/js/claim.js`, `/js/recover.js`, `/js/signup.js`).
- [ ] Verify the two synthetic install tests (complete-shell ~L307, flaky
      ~L340) stay green — their mocks 404 `/unlock`, ceremony warm skips
      silently, `cached.size` assertions unaffected. Adjust only if the
      best-effort ceremony catch emits console noise (prefer making the catch
      quiet over sprinkling `allowConsoleNoise`).
- [ ] Add a focused synthetic `it()` in the same describe: install warms the
      ceremony shell under EVERY ceremony path plus its css/module graph, when
      the mock serves signup content for a ceremony path. Assert all 5 paths +
      `/css/cloud.css` + `/js/app.js` + a dynamically-imported ceremony module
      are cached, and that the primary `/` shell is still cached.
- [ ] Add an `it()`: a ceremony-warm failure (ceremony doc fetch rejects/404s)
      does NOT reject install and the primary `/` shell + its assets are still
      cached — pins the best-effort guarantee.
- [ ] Run `npx vitest run web/cloud/js/tests/sw.fetch-cache.test.js` — all green.

### Task 3: Verify acceptance criteria
- [ ] Re-read med-gvk.3: warm precache now includes the ceremony document(s) +
      module graph so Settings sub-pages (`/devices`, `/connectors`) open
      offline; sw tests extended. Confirm.
- [ ] Node 20 on PATH: `npx vitest run` (full frontend suite) — green.
- [ ] `go build ./...` — green (no Go changed, sanity).
- [ ] `go test ./internal/cloudserver/...` — green (router/CSP tests undisturbed).
- [ ] Confirm the diff touches ONLY `web/cloud/sw.js` and
      `web/cloud/js/tests/sw.fetch-cache.test.js` (+ this plan) — no apishim.js,
      no web/static/js/features/*.

## Technical Details

- `warmDocGraph(cache, docUrl, html, seen, strict)`:
  - collect direct refs from `html.matchAll(SHELL_REF_RE)` (new URLs, dedup via
    shared `seen`);
  - if `strict`: `const deps = await Promise.all(direct.map(u =>
    cacheAndCrawl(cache, u)))`; seed the wave from `deps.flat()`;
  - else: seed the wave from `direct` directly;
  - loop: `Promise.allSettled(wave.map(cacheAndCrawl))`, collect fulfilled deps,
    `console.warn` + skip rejected, dedup next wave via `seen`.
- `warmCeremony` caches the SAME document body under 5 keys (~1 KB doc; trivial
  duplication, avoids a fetch-handler fallback branch). `CEREMONY_PATHS` is a
  module-scope `const` initialized before install fires, so referencing it in
  `warmCeremony` is safe.

## Post-Completion

**Manual verification** (optional, not automatable here):
- In a deployed cloud account: warm-unlock online once, go offline (DevTools),
  tap Settings → Devices and Settings → Connectors — both should render from
  cache instead of the browser offline error.
