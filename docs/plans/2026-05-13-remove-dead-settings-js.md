# Remove dead `features/settings.js`

## Overview

`web/static/js/features/settings.js` (252 lines) is precached by the
Service Worker (`web/static/sw.js:57`) but **not** loaded by
`web/static/index.html`. It is downloaded on first SW install, re-
downloaded on every `BUILD_REVISION` bump, and its 252 lines never
execute. `docs/frontend.md` already documents this:

> *"the in-tree `features/settings.js` is dead code; not loaded by
> `index.html`"*

The canonical `loadSettings()` lives in `app.js:1926`. The shadow file
attaches a different `window.loadSettings` and `window.loadFeatureSettings`
that get clobbered or never reached.

`architecture.sw-precache.test.js` checks the precache list against
`STATIC_ASSETS` for completeness (no missing files) but does not reject
the inverse — a precached file that nothing loads.

This plan deletes the file outright, removes the SW precache entry,
and adds an architecture test that scans for precache entries with no
matching `<script src>` in `index.html`.

**Out of scope:**
- Refactoring the canonical `loadSettings()` in `app.js:1926-…`
  itself (that lives in the
  [app.js split plan](2026-05-13-split-app-js.md)).

From the [2026-05-13 frontend review §12](../2026-05-13-frontend-code-review.md#12-service-worker-ships-dead-code)
and recommended-priority item #4.

## Context (from discovery)

- **The file**: `web/static/js/features/settings.js` — 252 lines,
  defines `window.loadFeatureSettings` (line 22), `window.loadFoodTargets`
  (line 62), `window.loadSettings` (line 151).
- **The shadow definitions in app.js**: `loadSettings` at
  `app.js:1926`. The cross-file globals `loadFeatureSettings`,
  `loadFoodTargets` are also defined elsewhere (verified by grep).
- **Precache entry**: `web/static/sw.js:57`
  `'/static/js/features/settings.js',`
- **Index.html scripts**: 52 `<script src>` tags at lines 1529-1576.
  None reference `features/settings.js`. Confirmed by file read.
- **Architecture tests** that touch script lists:
  `web/static/js/tests/architecture.sw-precache.test.js` — currently
  validates SW assets are reachable on disk. Need to extend it (or add
  a sibling test) to check the inverse direction.
- **Cross-file callers of the dead file's exports**:
  `features/settings.js:103` calls `window.loadFoodLogs` — but since
  this file never loads, this branch is unreachable. Dead.

## Development Approach

- **Testing approach**: Regular.
- Single PR; small. Bumping `BUILD_REVISION` in `sw.js:6` is part of
  the PR so existing clients pick up the new SW (otherwise old clients
  keep precaching the deleted file's URL until next install).
- Architecture test extension catches future occurrences.

## Testing Strategy

- **Unit tests**: not required (deleting a file).
- **Architecture test**: required — new sub-assertion in
  `architecture.sw-precache.test.js` (or new sibling file) that every
  precached `/static/js/...` path appears either in `index.html` as a
  `<script src>` OR in the SW's own `importScripts` list.
- **Smoke test**: full `pnpm test` to confirm no test was reaching into
  the deleted file's exports.

## Progress Tracking

- Mark completed items with `[x]` immediately.
- Add ➕ for new tasks; ⚠️ for blockers.

## Implementation Steps

### Task 1: Confirm no live caller exists

- [x] grep for `'features/settings.js'` and `"features/settings.js"`
  across the repo (`grep -rn "features/settings.js" .`) — expected
  hits: only `web/static/sw.js:57`, `docs/frontend.md` and any commit
  messages — confirmed: only `web/static/sw.js:57` plus docs/plans
  and tests/architecture allowlist references. `web/static/index.html`
  has zero references (only `components/wg-settings.js` matches).
- [x] grep for explicit references to the file's exported function
  names *only as they would resolve from the dead file*:
  `loadFeatureSettings` / `loadFoodTargets` / `loadSettings` —
  confirm callers resolve to the `app.js` definitions, not the dead
  file (read first definition order in load chain) — confirmed:
  `loadSettings` callers (`app.js:1208`, `app.js:2426`) resolve to
  `app.js:1926`; `loadFoodTargets` callers (`features/food.js:1759`)
  resolve to local definition at `features/food.js:2528`;
  `loadFeatureSettings` has zero live callers outside the dead file
  and its tests (the bundle apply path in `app.js:1926` reads
  `/api/settings/features` directly).
- [x] confirm `web/static/js/features/settings.js:103`'s call to
  `window.loadFoodLogs` is the *only* feature-side call to that
  global; any other caller (e.g. inside `app.js`) is unaffected —
  confirmed: all other callers (`app.js:1206`, `app.js:2420`,
  `features/food.js` body) call the local `loadFoodLogs()` directly,
  not via `window.`; deletion has no live effect.
- [x] write a one-line note in `docs/2026-05-13-frontend-code-review.md`
  §12 closing this finding once the file is deleted — note added at
  end of §12 pointing back to this plan.

### Task 2: Delete the file and remove SW precache entry

- [ ] `git rm web/static/js/features/settings.js`
- [ ] remove line `'/static/js/features/settings.js',` from
  `web/static/sw.js:57`
- [ ] bump `BUILD_REVISION` in `web/static/sw.js:6` from `'2'` to `'3'`
  (or whatever the current value is — increment by 1)
- [ ] grep for `features/settings` across the repo returns zero hits
- [ ] run full `pnpm test` to confirm nothing regresses

### Task 3: Architecture test prevents recurrence

- [ ] extend `web/static/js/tests/architecture.sw-precache.test.js`
  with a new sub-assertion: for every precache entry matching
  `/^\/static\/js\/.+\.js$/` (excluding the SW's own
  `sw-api-helper.js` family — see SW unification plan), assert the
  same path appears as a `<script src>` in `web/static/index.html`;
  on failure, suggest either deleting the file or wiring it into
  index.html
- [ ] verify the new assertion fails when run against the pre-fix
  state (manually check by re-adding the line and running test) —
  document this in the test file's comment block
- [ ] run `pnpm test architecture.sw-precache` — must pass

### Task 4: Verify acceptance

- [ ] full `pnpm test` clean
- [ ] grep for `features/settings.js` in the repo returns hits only
  in `docs/` (history references) and changelog/commit messages
- [ ] `docs/frontend.md` either drops the "dead code" note or updates
  it to record the deletion — pick one based on existing doc tone
- [ ] manually open the app in a browser and confirm Settings tab
  still loads (proves `app.js`'s `loadSettings()` was always the
  canonical path)

## Technical Details

### Inverse precache assertion shape

```javascript
test('every precached /static/js/*.js is loaded by index.html', () => {
    const indexHtml = readFileSync('web/static/index.html', 'utf8');
    const scriptSrcs = [...indexHtml.matchAll(/<script src="([^"?]+)/g)]
        .map(m => m[1]);
    const swSelfImports = ['/static/js/sw-api-helper.js']; // SW-loaded; never in index
    const orphans = STATIC_ASSETS.filter(p =>
        p.startsWith('/static/js/') &&
        !scriptSrcs.includes(p) &&
        !swSelfImports.includes(p)
    );
    expect(orphans).toEqual([]);
});
```

The `swSelfImports` allowlist exists for files the SW loads via
`importScripts` (e.g. the helper from the SW unification plan). Keep
the list short and document the reason inline.

## Post-Completion

**Manual verification** (optional):
- After deploy, check browser DevTools → Application → Service
  Workers → Cache Storage to confirm `/static/js/features/settings.js`
  is no longer in `medtracker-static-...`.

**No external system updates needed.**
