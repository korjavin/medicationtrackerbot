# Call Widget — Mute Toggle and Photo Send

## Overview

The ElevenLabs voice-call experience currently surfaces two pieces of UI during an active call:

- **Today screen call card** (`web/static/js/features/elevenlabs-call.js`) — primary "Call agent" / "End call" button + status line.
- **Floating call indicator pill** (`web/static/js/features/call-indicator.js`) — persistent pill above the bottom nav, visible across tab switches, with an "End call" button.

This plan adds two capabilities to **both** surfaces:

1. **Mute / Unmute toggle** — a button that mutes the user's microphone without ending the call. Toggle: tap mutes, tap again unmutes. Visual state reflects current mute state. Mute state is part of the live call state (so it survives a Today re-render mid-call and is mirrored between pill and card).

2. **Send photo** — a button that opens the system file picker (camera-capable on mobile via `capture="environment"`), uploads the chosen image to the in-flight ElevenLabs conversation via the SDK's `uploadFile()`, then emits a `multimodal_message` referencing the new `file_id` so the agent's multimodal LLM can see it.

### Why these features

- During a real conversation about a med dose or BP reading, the user often needs to step away briefly (cough, talk to someone, wait for the agent to finish). Hanging up and re-dialing breaks context. Mute is the standard solution.
- For health questions about a pill bottle, a rash, a BP cuff display, or a food label, dictating what's in the picture is slow and error-prone. Sending the photo lets the agent reason about the image directly.

## Context (from discovery)

**Files involved:**

- `web/static/js/features/elevenlabs-call.js` — call controller; owns `activeConversation`, the `wg-call-state` event broadcast, and the Today card markup (`buildCard` / `applyState`). Adds new state, methods, and card buttons here.
- `web/static/js/features/call-indicator.js` — floating pill; subscribes to `wg-call-state`. Adds new buttons here that read mirrored state.
- `web/static/css/styles.css` — `.wg-call-card`, `.wg-call-card__btn`, `.wg-call-indicator`, `.wg-call-indicator__hang-up` already exist (lines 4328–4470). New token-driven classes for mute/photo buttons live alongside them.
- `web/static/js/tests/features.call-indicator.test.js` — existing test pattern (jsdom + raw script eval). Extend for new buttons.
- New file: `web/static/js/tests/features.elevenlabs-call.test.js` — currently no test file for elevenlabs-call.js; add coverage for new APIs.
- `tests/architecture.globals.test.js` — only matters if we expose a new `window.*`; we extend existing `window.WGCallAgent` rather than add a new global, so no allowlist change needed.

**Related patterns found:**

- State broadcast via `window.dispatchEvent(new CustomEvent('wg-call-state', { detail }))` in `elevenlabs-call.js:91`. Detail today: `{ state, message }`. We extend with `muted` and `uploading`.
- Out-of-DOM state mirrors (`activeState`, `activeMessage`) at `elevenlabs-call.js:62-63` keep the UI consistent through Today re-renders. Add `activeMuted`, `activeUploading` to this list.
- The pill's `render()` reads `WGCallAgent.getState()` on mount (`call-indicator.js:86-90`) so it picks up state when mounted mid-call. Extend `getState()` return shape.
- Hidden `<input type="file" accept="image/*" capture="environment">` is the project's existing photo-picker pattern (used in `food.js`).

**Dependencies / external prerequisites:**

- `@elevenlabs/client@1.7.0` is loaded dynamically from `https://esm.sh/@elevenlabs/client` (no version pin). Confirmed methods on the Conversation instance:
  - `setMicMuted(isMuted: boolean): void`
  - `uploadFile(file: Blob): Promise<{ fileId: string }>` — POSTs to `/v1/convai/conversations/{id}/files` using session auth from the signed_url; no API key in browser.
  - `sendMultimodalMessage({ text?: string, fileId?: string }): void` — emits `multimodal_message` over the live WebSocket.
- Server-side ElevenLabs agent config must have `file_input: true` on `ConversationConfig` and a multimodal-capable LLM (e.g., GPT-4o, Claude 3.5 Sonnet). Configured in the ElevenLabs dashboard, not in this repo.
- Backend changes: **none required**. `internal/server/elevenlabs_handlers.go` already proxies the signed-URL fetch; the upload goes browser → ElevenLabs directly.

## Development Approach

- **Testing approach**: Regular (code first, then tests) — matches the existing project convention; the existing call-indicator test file is post-hoc, not TDD.
- Complete each task fully before moving to the next.
- Make small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task.
- **CRITICAL: all tests must pass before starting next task** — `pnpm test` for frontend, `go test ./...` if backend is touched.
- **CRITICAL: update this plan file when scope changes during implementation.**
- Run `pnpm test` after each frontend change, `go test ./...` if backend is touched.
- Maintain backward compatibility: existing event detail shape stays a superset; existing `window.WGCallAgent` API gains methods, doesn't lose any.

## Testing Strategy

- **Unit tests (Vitest + jsdom)**: required for every task. Pattern follows `web/static/js/tests/features.call-indicator.test.js` — load script via `window.eval`, dispatch synthetic `wg-call-state` events, assert DOM.
- **No e2e suite** in this project for the call widget — manual smoke testing in browser is the verification path (covered in Post-Completion).
- **Architecture tests**: `tests/architecture.globals.test.js` runs as part of `pnpm test`; we don't add new globals, so it should continue passing without changes. Re-verify after Task 2.
- **Backend Go tests** are not in scope (no backend changes), but `go test ./...` should be run once at the end as a sanity check that nothing in the bundled assets test broke.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): code, tests, CSS — all automatable.
- **Post-Completion** (no checkboxes): ElevenLabs dashboard config (file_input + multimodal LLM), manual browser smoke test on desktop and mobile, manual photo-from-camera test on mobile.

## Implementation Steps

### Task 1: Extend `elevenlabs-call.js` with mute and photo controller logic

- [x] add module-scope state: `let activeMuted = false;` and `let activeUploading = false;` next to existing `activeState` / `activeMessage` (around line 62)
- [x] include `muted` and `uploading` in the `wg-call-state` event detail emitted by `setState` (line 91-93) and in the value returned by `getState()` (line 97-99)
- [x] reset `activeMuted = false` and `activeUploading = false` whenever the call enters `idle` or `error` state (so a fresh call starts unmuted)
- [x] add `function setMute(muted)`: when there's no `activeConversation`, no-op. Otherwise call `activeConversation.setMicMuted(Boolean(muted))`, update `activeMuted`, broadcast via `setState` (re-using the existing state/message — only `muted` changes). Wrap in try/catch to swallow SDK errors (mute is non-critical).
- [x] add `function toggleMute()`: calls `setMute(!activeMuted)`
- [x] add `async function sendPhoto(file)`: validates `file instanceof Blob` and `file.type.startsWith('image/')`; rejects if outside `in_call`. Sets `activeUploading = true` + broadcasts; calls `await activeConversation.uploadFile(file)` then `activeConversation.sendMultimodalMessage({ fileId })`. Always clears `activeUploading` in `finally`. On error, calls `setState('in_call', 'Photo upload failed')` while keeping `activeConversation` alive (do NOT transition to `error` state — that's reserved for fatal call errors).
- [x] extend `applyState(card, state, message)` to also receive (or read from `activeMuted` / `activeUploading`) and update the card's mute/photo button states (label, `aria-pressed`, `disabled`). Driven by `data-muted` and `data-uploading` attributes on the card so CSS can style them.
- [x] extend `buildCard()` to render a `<button class="wg-call-card__mute" type="button" aria-pressed="false">Mute</button>` and a `<button class="wg-call-card__photo" type="button">Send photo</button>` plus a hidden `<input type="file" accept="image/*" capture="environment">` with handlers wired to `toggleMute()` / triggering the file input / `sendPhoto()`. Both buttons are hidden via CSS when `data-state` is `idle` or `error`; disabled when `connecting` or while `data-uploading="true"`.
- [x] export the new functions on `window.WGCallAgent`: add `toggleMute`, `setMute`, `sendPhoto`, and surface `muted`/`uploading` via `getState()`
- [x] write tests in new file `web/static/js/tests/features.elevenlabs-call.test.js` covering: (a) `setMute(true)` calls `setMicMuted(true)` on the conversation and broadcasts `muted: true`; (b) `toggleMute` flips state; (c) `getState()` returns the `muted` / `uploading` fields; (d) `sendPhoto` rejects when not in call; (e) `sendPhoto` happy path calls `uploadFile` then `sendMultimodalMessage` with the returned `fileId` and broadcasts `uploading: true` then `false`; (f) `sendPhoto` failure leaves `activeConversation` alive, sets a status message, and clears `uploading`; (g) idle transition resets `muted` to `false`. Mock `Conversation.startSession` to return a fake conversation with stub methods.
- [x] write tests for error/edge cases: (a) `setMute` when `activeConversation` is null is a no-op; (b) `sendPhoto` rejects non-image blobs; (c) SDK throwing inside `setMicMuted` is swallowed and doesn't crash state.
- [x] run `pnpm test` — must pass before Task 2

### Task 2: Add mute and photo buttons to the floating call-indicator pill

- [x] in `call-indicator.js`, add two buttons inside `mount()` next to the existing hang-up button: `.wg-call-indicator__mute` (text starts as `Mute`, `aria-pressed="false"`) and `.wg-call-indicator__photo` (text `Photo`). Insert them before `hangUpEl` so the visual order is `[mute] [photo] [end call]`.
- [x] add a hidden `<input type="file" accept="image/*" capture="environment">` appended to `rootEl`; clicking the photo button calls `input.click()`, and the input's `change` handler calls `window.WGCallAgent?.sendPhoto(file)` then resets `input.value = ''` so re-picking the same file fires `change` again
- [x] mute button click handler calls `window.WGCallAgent?.toggleMute()`
- [x] extend `render(state, message, muted, uploading)` to: (a) hide both buttons when state is `idle` or `error`; (b) disable both when `state === 'connecting'`; (c) disable photo button when `uploading === true` and update its label to `Sending…`; (d) reflect mute state on the mute button via `aria-pressed` and a `Mute` / `Unmute` label
- [x] update the `wg-call-state` listener to read `detail.muted` and `detail.uploading` and pass them to `render`
- [x] update the initial-state read on mount (current line 86-90) to also pull `muted`/`uploading` from `getState()`
- [x] write tests in `features.call-indicator.test.js`: (a) mute and photo buttons exist after mount; (b) both hidden when state is `idle`; (c) both visible & enabled when `in_call`; (d) both disabled when `connecting`; (e) mute button shows `aria-pressed="true"` after a `wg-call-state` with `muted: true`; (f) photo button shows `Sending…` and is disabled when `uploading: true`; (g) clicking the mute button invokes `WGCallAgent.toggleMute`; (h) the file input's change event invokes `WGCallAgent.sendPhoto` with the chosen file; (i) inline-style assertion still passes for the new elements
- [x] write tests for edge cases: (a) mounting mid-call with `getState()` returning `{ state: 'in_call', muted: true }` renders the mute button as pressed/Unmute; (b) destroy() removes the new buttons too
- [x] run `pnpm test` — must pass before Task 3

### Task 3: Style the new buttons via CSS tokens

- [x] add `.wg-call-card__mute`, `.wg-call-card__photo`, `.wg-call-indicator__mute`, `.wg-call-indicator__photo` to `web/static/css/styles.css` near the existing call styles (around line 4395 / 4470). Use existing `--wg-*` design tokens for color, spacing, and radius — no hardcoded values, no inline `style.` assignments.
- [x] visually distinguish muted state: `.wg-call-card__mute[aria-pressed="true"]` and `.wg-call-indicator__mute[aria-pressed="true"]` use a danger-tinted token (mirror how `[data-state="in_call"] .wg-call-indicator__hang-up` already shifts to clay/danger tones)
- [x] hide the buttons when the parent card/pill is in `idle` or `error` state via attribute selectors (`.wg-call-card[data-state="idle"] .wg-call-card__mute { display: none; }` etc.) — use `display: none` rather than the `hidden` attribute, since the parent is what toggles state
- [x] hide the file input via the existing `wg-visually-hidden` utility (or `display: none` if no util exists)
- [x] write a CSS architecture sanity check: load the relevant test file (or extend an existing one in `web/static/js/tests/`) to assert no inline style attributes appear on the new buttons after a state cycle
- [x] run `pnpm test` — must pass before Task 4

### Task 4: Verify acceptance criteria

- [x] verify all requirements from Overview: mute toggle works, mute survives Today re-render, photo button opens picker, photo upload calls the SDK and the agent receives it, both surfaces stay in sync
- [x] verify edge cases: rapid mute toggling, picking same photo twice, picking non-image (blocked), photo while `connecting` (button disabled)
- [x] run full frontend test suite: `pnpm test` — 1606/1606 pass
- [x] run `go test ./...` as a sanity check (no backend changes, but bundled-assets/build tests should still pass) — 2 pre-existing failures (`TestMedicationCheckerTZAware/cancelled_plan:_normal_scheduling_resumes`, `TestListDiaryNotes_Since`) reproduce on a clean tree with no local changes; date-dependent and unrelated to this branch
- [x] run linter — fix any issues — `go vet ./...` clean; no frontend lint script (architecture tests in `pnpm test` cover inline-styles, design-tokens, globals)
- [x] verify no new `window.*` global was introduced (extending `WGCallAgent` only); confirm `tests/architecture.globals.test.js` still passes — only `window.WGCallAgent` (extended in place) and pre-existing `window.WGCallIndicator` exist; test passes

### Task 5: [Final] Update documentation

- [x] add a brief paragraph to `docs/features.md` (or whichever section covers the agent call) noting mute and photo controls and the agent-side prerequisites (`file_input: true` + multimodal LLM)
- [x] no `CLAUDE.md` change required (no new architectural pattern)

*Note: ralphex automatically moves completed plans to `docs/plans/completed/`*

## Technical Details

### Data flow — Mute

```
[user clicks Mute on pill]
  → call-indicator.js: button.onclick → WGCallAgent.toggleMute()
  → elevenlabs-call.js: toggleMute() → setMute(!activeMuted)
  → activeConversation.setMicMuted(true)            // SDK does the WebRTC work
  → activeMuted = true
  → setState(activeState, activeMessage)            // re-broadcasts with muted:true
  → window dispatches 'wg-call-state' { state, message, muted, uploading }
  → both call-indicator.js and applyState() (Today card) update aria-pressed and label
```

### Data flow — Photo

```
[user clicks Photo on card]
  → hidden <input type="file"> .click()
  → user picks image
  → input 'change' event → WGCallAgent.sendPhoto(file)
  → elevenlabs-call.js: validate (blob + image/* + in_call)
  → activeUploading = true; setState(...) re-broadcasts
  → const { fileId } = await activeConversation.uploadFile(file)
        // SDK POSTs to /v1/convai/conversations/{id}/files using the signed session
  → activeConversation.sendMultimodalMessage({ fileId })
        // SDK emits multimodal_message over the live WebSocket
  → activeUploading = false; setState(...)
  → ElevenLabs agent's multimodal LLM receives the image as part of conversation context
```

### Event detail shape

Before:
```js
{ state: 'idle' | 'connecting' | 'in_call' | 'error', message: string }
```

After (additive, backward compatible):
```js
{
  state:   'idle' | 'connecting' | 'in_call' | 'error',
  message: string,
  muted:    boolean,   // false outside in_call/connecting
  uploading: boolean,  // true while uploadFile() is in flight
}
```

### `window.WGCallAgent` surface

Before:
```
{ mountCard, startCall, endCall, fetchSignedURL, getState }
```

After:
```
{ mountCard, startCall, endCall, fetchSignedURL, getState,
  toggleMute, setMute, sendPhoto }
```

### Mute approach — note on the original choice

The user originally selected "Always toggle `track.enabled` directly" because the SDK was assumed to lack a built-in mute method. The shipped SDK (`@elevenlabs/client@1.7.0`) **does** expose `setMicMuted(isMuted: boolean)` on the Conversation instance (confirmed in `dist/BaseConversation.d.ts:81`). This plan uses `setMicMuted` because:

- It is the SDK's intended path; it handles WebRTC track state correctly across whichever transport the SDK selects (LiveKit vs raw WebSocket — `livekit-client` is now a dep).
- The current code never holds the input `MediaStreamTrack` itself (the SDK calls `getUserMedia` internally), so a `track.enabled` approach would require monkey-patching `navigator.mediaDevices.getUserMedia` before calling `Conversation.startSession`, which is fragile and bypasses the SDK's lifecycle (worklets, gain nodes).

If we later need SDK-version independence, switching to a `getUserMedia`-intercept fallback is a localized change inside `setMute` (one branch).

### Photo: required ElevenLabs agent config

For `sendMultimodalMessage({ fileId })` to actually reach the agent's LLM:

1. In the ElevenLabs dashboard, on the agent used by this app: enable **`file_input`** on the agent's `ConversationConfig`.
2. The agent's underlying LLM must support image input (e.g., GPT-4o, Claude 3.5 Sonnet, Gemini 1.5 Pro). Check the LLM dropdown.

Without (1), `uploadFile` may still succeed but `sendMultimodalMessage` will be ignored by the platform. Without (2), the agent will receive the message but cannot reason about the image content.

These are deployment-time settings, not in-repo. They go in Post-Completion.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only.*

**ElevenLabs dashboard config (one-time):**
- Enable `file_input: true` on the agent's `ConversationConfig`.
- Verify the agent's LLM is multimodal (GPT-4o / Claude 3.5 Sonnet / Gemini 1.5 Pro / similar).

**Manual browser verification:**
- Desktop Chrome: start a call from the Today card → mute / unmute (status reflects on both pill and card). Send a photo from disk → confirm agent reacts to the image content.
- Desktop Chrome: start a call → switch to BP tab mid-call → confirm pill shows mute and photo controls → mute from pill, switch back to Today → mute state visible on card.
- Mobile Safari + Chrome: tap photo button → camera capture sheet appears → take photo → upload + agent response.
- Edge case: pick a non-image file via "Other" / "Files" — confirm rejected with a status message, call stays alive.
- Edge case: pick the same photo twice in a row — confirm both uploads happen (input value is reset after each pick).
- Edge case: trigger a network failure mid-upload (DevTools throttle / offline toggle) — confirm status shows the failure, mute still works, call still alive.
