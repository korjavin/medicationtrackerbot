# Persistent Call Indicator Overlay

## Overview

Currently the ElevenLabs voice-call control lives only inside the Today screen's `wg-call-card`. Switching to any other tab hides it, so the user cannot see call status or hang up without navigating back. This plan adds a small floating pill anchored above the bottom nav that becomes visible whenever the call state is `connecting` / `in_call` / `error`, and is hidden when `idle`. The pill shows status text plus a hang-up button and is mounted once at app-shell level so it survives tab switches.

## Context

- Files involved:
  - `web/static/js/features/elevenlabs-call.js` — owns the call state machine (`idle`/`connecting`/`in_call`/`error`) and exposes `window.WGCallAgent`. State currently lives in module-scope closures (`activeState`, `activeMessage`) and is applied to a single DOM card via `applyState()`. Today's render rebuilds the card and re-binds state.
  - `web/static/js/features/bootstrap.js` — app bootstrap; mounts `WGBottomNav` before initial `switchTab`. Right place to also mount the new persistent indicator.
  - `web/static/js/features/today.js` — currently calls `window.WGCallAgent.mountCard(root)` at line ~924 (unchanged by this plan).
  - `web/static/css/styles.css` — design-token-based styling; existing `.wg-call-card` rules around lines 4325–4386. New `.wg-call-indicator` rules go here. Bottom-nav reservations: `--wg-bottom-nav-reserved` (~line 325), `--wg-bottom-nav-z = 40` (~line 317).
  - `web/static/index.html` — script tag at line 1523 for `elevenlabs-call.js`. New script tag added next to it.
  - `web/static/sw.js` — service worker precache list; add the new file so it loads offline.
  - `web/static/js/tests/architecture.globals.test.js` — allowlist for `window.*` globals; add `window.WGCallIndicator`.
  - `web/static/js/tests/` — new render test file for the indicator.
- Related patterns:
  - Module-IIFE + `window.NamedModule` export, mirroring `elevenlabs-call.js`.
  - State-outside-DOM pattern: keep last known state in module scope so re-renders restore correctly.
  - `CustomEvent` on `window` for cross-module signalling (already used elsewhere in the codebase).
  - Strict design-token usage (no inline `.style.` assignments, no hardcoded colors) — enforced by architecture tests.
- Dependencies: none new. Reuses existing ElevenLabs SDK integration.

## Development Approach

- Testing approach: Regular (code first, then tests). No unit tests; add integration-level frontend tests (vitest + jsdom) that exercise the rendered DOM.
- Complete each task fully before moving to the next.
- Use design tokens only (`--wg-*` variables) and class-driven styling — never inline styles or hardcoded colors.
- CRITICAL: all tests must pass before starting next task.

## Implementation Steps

### Task 1: Emit call-state events from elevenlabs-call.js

**Files:**
- Modify: `web/static/js/features/elevenlabs-call.js`

- [x] In `setState()`, after `applyState()`, dispatch `window.dispatchEvent(new CustomEvent('wg-call-state', { detail: { state, message } }))` so other modules can subscribe without coupling to the DOM card.
- [x] Export a `getState()` helper on `window.WGCallAgent` that returns `{ state, message }` so a late-mounting indicator can render the current state immediately on attach (avoids a missed event race).
- [x] Run `pnpm test` to confirm no existing tests regressed. (2 pre-existing date-dependent failures in sleep/steps chart tests confirmed unrelated to this change.)

### Task 2: Build the CallIndicator component

**Files:**
- Create: `web/static/js/features/call-indicator.js`

- [x] Implement `(function () { ... })()` module that exposes `window.WGCallIndicator = { mount, destroy }`.
- [x] `mount(parent)` builds a hidden `<div class="wg-call-indicator" hidden>` element with: a status dot span, a status-text span, and a hang-up `<button class="wg-call-indicator__hang-up">`. Append to `document.body` (or the supplied parent) so it lives outside any tab container.
- [x] Subscribe to window `'wg-call-state'` event; on update, toggle `hidden` based on state (hidden when `'idle'`, visible otherwise), set status text from `{ state, message }`, and apply a state-variant data attribute (`data-state="connecting|in_call|error"`) so CSS can color the dot.
- [x] On mount, immediately call `window.WGCallAgent.getState()` and render initial state (covers the case where the indicator mounts after a call was already started — though normal flow has it mounted at app start).
- [x] Hang-up button click calls `window.WGCallAgent.endCall()`.
- [x] No inline `.style.` assignments; visibility done via the `[hidden]` attribute and CSS classes.

### Task 3: Wire the indicator into the app shell

**Files:**
- Modify: `web/static/index.html`
- Modify: `web/static/sw.js`
- Modify: `web/static/js/features/bootstrap.js`

- [x] Add `<script src="/static/js/features/call-indicator.js?v=TIMESTAMP_PLACEHOLDER"></script>` immediately after the `elevenlabs-call.js` script tag in `index.html` (line ~1523).
- [x] Add `/static/js/features/call-indicator.js` to the precache list in `sw.js` so it is available offline alongside `elevenlabs-call.js`.
- [x] In `bootstrap.js`, after `WGBottomNav.mount(...)`, call `window.WGCallIndicator && window.WGCallIndicator.mount(document.body)`.

### Task 4: Style the floating pill with design tokens

**Files:**
- Modify: `web/static/css/styles.css`

- [ ] Add a `.wg-call-indicator` block: `position: fixed`, `bottom: calc(var(--wg-bottom-nav-reserved) + var(--space-sm))`, centered horizontally (`left: 50%; transform: translateX(-50%)`), `max-width ~360px`, z-index just above `--wg-bottom-nav-z` (e.g. 41 or a new `--wg-call-indicator-z` token defined alongside).
- [ ] Use `--wg-bg-card` for background, `--wg-border-hairline` for border, `--wg-radius-pill` for shape, `--wg-fg-1`/`--wg-fg-2` for text, existing shadow token for elevation.
- [ ] Style `.wg-call-indicator__hang-up` using the existing `wg-gloss-bg-clay` (danger) tokens / classes — consider applying `wg-gloss` + `wg-gloss--clay` class combo from the existing system instead of new color values.
- [ ] Add a small status dot rule that switches color per `data-state` (`connecting` → `--wg-sun`, `in_call` → success token, `error` → `--color-danger`). All values come from `--wg-*` tokens — no hardcoded colors.
- [ ] `[hidden]` selector ensures the element is fully removed from the layout when idle.

### Task 5: Tests and global-allowlist update

**Files:**
- Modify: `web/static/js/tests/architecture.globals.test.js`
- Create: `web/static/js/tests/features.call-indicator.test.js`

- [ ] Add `'window.WGCallIndicator'` to `ALLOWED_GLOBALS` in `architecture.globals.test.js` with a one-line justification.
- [ ] In `features.call-indicator.test.js`: load `call-indicator.js`, mount into a fresh jsdom body, then dispatch `CustomEvent('wg-call-state', { detail: { state: 'idle' } })` and assert the element is `[hidden]`.
- [ ] Dispatch `'connecting'`, `'in_call'`, `'error'` events and assert visibility, status text, and `data-state` attribute.
- [ ] Click the hang-up button with `window.WGCallAgent` stubbed via `vi.stubGlobal('WGCallAgent', { endCall: vi.fn(), getState: () => ({ state: 'idle', message: '' }) })` and assert `endCall` was called.
- [ ] Run `pnpm test` and ensure all suites pass (architecture.globals must pass with the new allowlist entry).

### Task 6: Verify acceptance criteria

- [ ] Run `pnpm test` (full frontend suite must pass).
- [ ] Run `go test ./...` (backend suite — unchanged but verify nothing broke incidentally).
- [ ] Run `go vet ./...` (project lint).

### Task 7: Update documentation

- [ ] If user-facing behaviour worth noting, update `README.md` (likely not needed — feature is a UI affordance).
- [ ] Update `docs/frontend.md` call-out section if it documents the call card, noting the new persistent indicator.
- [ ] Move this plan to `docs/plans/completed/`.
