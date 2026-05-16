# MessengerAdapter — decouple frontend from Telegram WebApp SDK

## Overview

The frontend assumes "we have a Telegram user, and their identity is
`userInitData`" in many places. Direct reaches into
`window.Telegram.WebApp` from:

- `web/static/js/core/utils.js:5, 18` — `safeAlert`, `safeConfirm`
  use Telegram popup APIs
- `web/static/js/app.js:5-9` — `window.tg = Telegram.WebApp`, then
  `tg.ready()`, `tg.expand()`
- `web/static/js/features/back-button.js:17` — `BackButton.onClick`
  wiring
- `web/static/js/features/modal-history.js:15` — modal-history
  MutationObserver hook
- `web/static/js/features/deeplink-router.js:89` —
  `Telegram.WebApp.initDataUnsafe.start_param`

Plus 11+ HTTP call sites that put `userInitData` into the auth header
(handled by the
[auth-header consolidation plan](2026-05-13-auth-header-consolidation.md);
this plan picks up where that one ends).

For "Telegram-optional" to be a true property of the app — i.e. the
same client code can serve a non-Telegram browser PWA, OIDC-logged-in
desktop browser, or future messenger embed — every reach-in needs to
go through a thin adapter interface. None of the call sites above
actually need the raw `Telegram.WebApp` object; they need one of four
behaviours:

1. **Identity token** — `adapter.identityToken()` returns the auth
   credential to put in HTTP requests (today: `initData` string;
   browser fallback: `null`, relying on cookie).
2. **Lifecycle** — `adapter.ready()`, `adapter.expand()` (no-ops in
   browser).
3. **Native UI dialogs** — `adapter.alert(msg)`, `adapter.confirm(msg)`,
   `adapter.showPopup(opts)` (browser fallback uses `window.alert`).
4. **Deep-link / start-param** — `adapter.startParam()` (browser
   fallback reads from URL hash / query).
5. **BackButton** — `adapter.onBack(handler)`,
   `adapter.showBack()`, `adapter.hideBack()` (browser fallback uses
   `popstate` + an in-app back button).

This plan introduces `web/static/js/core/messenger-adapter.js` with two
implementations (`TelegramAdapter`, `BrowserAdapter`), routes every
reach-in through it, and adds an architecture test that bans direct
`window.Telegram` access outside the adapter file.

This is the **client-side half** of the messenger-pluggability work.
The server-side identity refactor (Go review §1: `users` +
`messenger_accounts` tables) is the other half — the two can be done
in either order, but the full benefit lands only when both are in.

**Out of scope:**
- The server-side identity refactor (separate Go-side plan).
- Web fallbacks for bot-only features (sleep import, TZ-from-geolocation
  — Go review §1, separate plan).
- Implementing a non-Telegram-Mini-App deployment configuration — this
  plan makes it *possible*; actually shipping is a product decision.

From the [2026-05-13 frontend review §5](../2026-05-13-frontend-code-review.md#5-telegram-identity-coupling-on-the-client)
and recommended-priority item #8.

## Context (from discovery)

- **6 reach-in sites** (verified by grep for `window.Telegram` /
  `Telegram.WebApp`):
  - `core/utils.js:5, 18` — `safeAlert`, `safeConfirm`
  - `app.js:5-9` — bootstrap (`ready`, `expand`, `initData`)
  - `features/back-button.js:17` — back-button handler
  - `features/modal-history.js:15` — modal-history hook
  - `features/deeplink-router.js:89` — start-param read
- **`userInitData` global** (`window.userInitData`) — set in
  `app.js:13` from `Telegram.WebApp.initData`; read by 10+ files. After
  the auth-header plan ships, all reads go through `makeAuthHeaders()`;
  this plan moves the *source* (`window.userInitData = adapter.identityToken()`)
  behind the adapter.
- **`safeAlert` / `safeConfirm`** in `core/utils.js` already do half
  the abstraction job — they branch on `window.Telegram` presence.
  Promote to the adapter so the branch happens in one place.
- **Modal-history MutationObserver** at `features/modal-history.js`
  is purely Telegram-specific (works around how Telegram WebApp's
  back button interacts with modal stack); needs a no-op browser
  implementation that uses `popstate` instead.
- **No CSP changes needed** — the adapter is pure JS; the existing
  CSP allows `https://telegram.org` for the SDK script, browser
  fallback uses zero external resources.

## Development Approach

- **Testing approach**: Regular.
- One PR. Backwards-compatible: in a Telegram WebApp environment, the
  `TelegramAdapter` is selected and behaviour is identical. In a
  browser without `window.Telegram`, the `BrowserAdapter` activates
  cleanly and the app works on the cookie-based auth path.
- Strongly recommend landing **after** the
  [auth-header consolidation plan](2026-05-13-auth-header-consolidation.md)
  so the auth-token plumbing is already centralized. Without that
  ordering, this plan would touch all 11 auth-header call sites too,
  doubling the diff.

## Testing Strategy

- **Unit tests**: required per adapter — Telegram adapter forwards to
  the SDK methods; Browser adapter uses native APIs and
  hash-based-routing for deep links.
- **Integration test**: load the app in jsdom (already the test
  environment) without `window.Telegram` set; verify boot sequence
  completes, modals work, back-button works.
- **Architecture test**: scan for `window.Telegram` /
  `Telegram.WebApp` outside `core/messenger-adapter.js` — fail with
  pointer to the adapter.

## Progress Tracking

- Mark completed items with `[x]` immediately.
- Add ➕ for new tasks; ⚠️ for blockers.

## Implementation Steps

### Task 1: Define the adapter interface and Telegram implementation

- [x] create `web/static/js/core/messenger-adapter.js` with the
  interface contract documented at the top of the file (one comment
  block enumerating every method below)
- [x] implement `TelegramAdapter` with the following surface:
  - `init()` — calls `Telegram.WebApp.ready()`, `expand()`; returns
    `Promise<void>`
  - `identityToken()` → `Telegram.WebApp.initData` (string or empty)
  - `authHeaderName()` → `'X-Telegram-Init-Data'` (canonicalized in
    auth-header plan)
  - `alert(msg)` → uses `Telegram.WebApp.showAlert` if available,
    falls back to native `alert`
  - `confirm(msg)` → uses `Telegram.WebApp.showConfirm`, returns
    Promise<boolean>
  - `showPopup(opts)` → forwards to `Telegram.WebApp.showPopup`
  - `startParam()` → `Telegram.WebApp.initDataUnsafe.start_param ||
    null`
  - `onBack(handler)` → registers via `Telegram.WebApp.BackButton.onClick`
  - `showBack()` / `hideBack()` → `Telegram.WebApp.BackButton.show()` /
    `.hide()`
  - `isPresent()` → `true`
- [x] implement adapter selection: `window.MessengerAdapter` is set
  to either `TelegramAdapter` or `BrowserAdapter` (Task 2) at the
  *very* top of the bootstrap chain, before any other module reads
  it
- [x] add `core/messenger-adapter.js` to `index.html` (immediately
  after `core/utils.js`) and to `web/static/sw.js` `STATIC_ASSETS`
- [x] add `window.MessengerAdapter` to
  `architecture.globals.test.js` allowlist
- [x] write tests in `web/static/js/tests/core.messenger-adapter.telegram.test.js`
  using a mock `window.Telegram.WebApp` object: each method forwards
  to the SDK; missing SDK methods fall through to native fallbacks
- [x] run `pnpm test core.messenger-adapter.telegram` — must pass
  before next task

### Task 2: Browser fallback implementation

- [x] implement `BrowserAdapter` in the same file:
  - `init()` → no-op resolved Promise
  - `identityToken()` → `null` (cookie-only auth)
  - `authHeaderName()` → `null` (auth-header helper sees null and
    omits the header)
  - `alert(msg)` → native `window.alert`
  - `confirm(msg)` → wraps native `window.confirm` in
    `Promise.resolve(...)`
  - `showPopup(opts)` → falls back to a styled DOM modal (use the
    existing `wg-modal` primitive); for v1 may simply be a multi-line
    `alert`
  - `startParam()` → reads from `new URLSearchParams(location.search).get('start')`
    OR from `location.hash` (`#start=foo`); returns string or null
  - `onBack(handler)` → registers a `popstate` listener; stores
    `handler` for the manual `.show()` path
  - `showBack()` → renders an in-app back button into the existing
    bottom-nav row (or shows a header chevron; design pick documented
    in the plan)
  - `hideBack()` → hides the in-app back button
  - `isPresent()` → `false` (callers can use this to skip
    Telegram-specific UX)
- [x] adjust the auth-header helper from the
  [auth-header plan](2026-05-13-auth-header-consolidation.md) Task 1:
  if `MessengerAdapter.authHeaderName()` returns null, omit the
  header entirely (cookie path); otherwise use the returned header
  name with `MessengerAdapter.identityToken()` as the value
- [x] write tests in
  `web/static/js/tests/core.messenger-adapter.browser.test.js`
  with no `window.Telegram` defined: each method exercises its
  native fallback; `startParam()` reads URL params correctly; back
  button uses popstate
- [x] run `pnpm test core.messenger-adapter.browser` — must pass
  before next task

### Task 3: Migrate the 6 reach-in sites

- [x] `core/utils.js:5, 18` — replace `const tg = window.Telegram &&
  window.Telegram.WebApp` with `const adapter = window.MessengerAdapter`;
  rewrite `safeAlert(msg)` to call `adapter.alert(msg)`; rewrite
  `safeConfirm(msg, cb)` to `adapter.confirm(msg).then(cb)`
- [x] `app.js:5-13` — replace the direct `window.tg = ...` /
  `tg.ready()` / `tg.expand()` block with
  `await window.MessengerAdapter.init()`; replace `userInitData =
  window.tg ? window.tg.initData : null` with
  `userInitData = window.MessengerAdapter.identityToken()`; preserve
  `window.userInitData` global for backwards compat
- [x] `features/back-button.js:17` — replace `const webApp =
  window.Telegram && window.Telegram.WebApp` with
  `const adapter = window.MessengerAdapter`; rewrite the BackButton
  registration to use `adapter.onBack(handler)`,
  `adapter.showBack()`, `adapter.hideBack()`
- [x] `features/modal-history.js:15` — replace the direct WebApp
  reach with adapter-based wiring; if `adapter.isPresent()` is
  false, replace the MutationObserver-on-Telegram-modal logic with
  the popstate-based browser equivalent
- [x] `features/deeplink-router.js:89` — replace the inline
  `Telegram.WebApp.initDataUnsafe.start_param === 'bp_add'` check
  with `window.MessengerAdapter.startParam() === 'bp_add'`; keep the
  same routing behaviour
- [x] verify each migrated file's existing tests still pass; add
  one regression test per migrated site that exercises the adapter
  path (mock `window.MessengerAdapter`)
- [x] run `pnpm test` — must pass before next task

### Task 4: Architecture test prevents recurrence

- [x] add `web/static/js/tests/architecture.no-direct-telegram.test.js`
  that scans every file under `web/static/js/` (excluding
  `core/messenger-adapter.js`, `tests/`, and `vendor/`) for the
  literal strings `window.Telegram`, `Telegram.WebApp` (case-
  sensitive); assert zero matches; on failure, point at the adapter
- [x] run `pnpm test architecture.no-direct-telegram` — must pass

### Task 5: Verify acceptance

- [ ] grep for `window.Telegram` in `web/static/js/` (excluding
  `core/messenger-adapter.js` and tests) returns zero matches
- [ ] grep for `Telegram.WebApp` in `web/static/js/` (same exclusions)
  returns zero matches
- [ ] full `pnpm test` clean
- [ ] manually load the app in a real Telegram WebApp client and
  verify: alerts appear via Telegram popup; back button works;
  start_param deep-link works; meds/BP/weight saves work
- [ ] manually load the app in a desktop browser at `localhost:8080`
  with no Telegram SDK present (block the SDK URL via DevTools
  network throttling or hosts-file redirect) and verify: app boots,
  alerts appear via native `alert()`, back button uses in-app chevron,
  cookie-based auth works (requires user to log in via OIDC first)

## Technical Details

### Selection logic (very early in boot)

```javascript
window.MessengerAdapter = (typeof window.Telegram !== 'undefined' && window.Telegram.WebApp)
    ? TelegramAdapter
    : BrowserAdapter;
```

This must run *before* `app.js` and any feature file. Place at the
top of `core/messenger-adapter.js` and load it second in `index.html`
(after `core/utils.js` since `utils.js` is loaded first today; or
swap the order so adapter is first — pick consistently and document).

### Where the auth-header helper checks the adapter

After the auth-header consolidation plan lands:

```javascript
function makeAuthHeaders(extra) {
    const headers = { ...(extra || {}) };
    const headerName = window.MessengerAdapter?.authHeaderName?.();
    const token = window.MessengerAdapter?.identityToken?.();
    if (headerName && token) {
        headers[headerName] = token;
    }
    return headers;
}
```

`BrowserAdapter` returns `null` for `authHeaderName()`, so the header
is simply omitted; the request goes out cookie-only.

### Browser back-button shape (Task 2)

The simplest in-app back button: a small chevron rendered at the
top-left of `wg-bottom-nav` slot 1, hidden by default, shown when
`adapter.showBack()` is called. Tap fires the registered handler.
This is one CSS class + one DOM node + one event listener — keep it
minimal in v1; iterate if a non-Telegram deployment actually ships.

### What about the `userInitData` global?

`window.userInitData` is read by 10+ files. After this plan, its
value comes from `MessengerAdapter.identityToken()` (which returns
`null` in the browser case). The global is preserved for backwards
compatibility; a follow-up could route every read through the
adapter, but that's not required.

## Post-Completion

**Manual verification** (recommended pre-merge):
- Telegram path: open Mini App, exercise every modal (BP, weight,
  food, med, workout, settings); verify Telegram popups appear, not
  native `alert()`.
- Browser path: open `localhost:8080` in Chrome with Telegram SDK
  blocked (DevTools → Network → block telegram.org), confirm app
  boots cleanly, native `alert()` appears for `safeAlert`,
  in-app back chevron works on non-Today screens.

**External system updates** (required to fully realize the benefit):
- The Go-side identity refactor (Go review §1: `users` +
  `messenger_accounts` tables) — separate plan, not blocking the
  client work but the full "non-Telegram deployment" benefit lands
  only when both ship.
- Web fallbacks for sleep import and TZ-from-geolocation (Go review
  §1) — separate plan.
