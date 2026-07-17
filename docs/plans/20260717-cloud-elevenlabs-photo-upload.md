# Cloud: browser-direct "Send photo" for the ElevenLabs voice assistant

## Overview

In bot/server mode, a user in an ElevenLabs voice call can tap **"Send photo"** to
send an image to the voice assistant. That control is hidden in cloud mode because
`sendPhoto()` posts to the bot-mode-only `/api/elevenlabs/upload-file` proxy route,
which cloud does not serve (it would 404). This is a bot↔cloud feature-parity gap
(bd med-eas.55).

This change gives cloud mode a **browser-direct** ElevenLabs file-upload path using
the user's BYO key from the vault — exactly the pattern cloud already uses for the
signed-URL/voice path — then removes the `!window.__MEDTRACKER_CLOUD__` guard so the
button renders in both modes. The upload goes browser → `api.elevenlabs.io` directly;
the operator relay stays blind (nothing through `/api`). Bot mode is unchanged.

**Problem solved:** cloud voice users can send a photo (meal, label) to the assistant mid-call.

## Context (from discovery)

- **Shared feature file:** `web/static/js/features/elevenlabs-call.js`
  - Photo UI (button + hidden `<input type=file capture>`) gated behind `if (!window.__MEDTRACKER_CLOUD__)` at ~line 501.
  - `uploadFileViaProxy(conv, file)` at ~line 306 POSTs multipart (`file` field) to `/api/elevenlabs/upload-file?conversation_id=…` via global `fetch` with `window.makeAuthHeaders()`, parses `{file_id}`.
  - `sendPhoto(file)` at ~line 344 validates image, calls `uploadFileViaProxy`, then `conv.sendMultimodalMessage({ fileId })`.
  - Cloud seam already used for signed URL: `fetchSignedURL()` at ~line 99 branches on `window.__MEDTRACKER_CLOUD__ && window.CloudElevenLabs` and calls `window.CloudElevenLabs.fetchSignedURL(agentId)`.
- **Cloud client factory:** `web/cloud/js/elevenlabs-signed-url.js` → `createElevenLabsClient({ settingsDomain })` returns `{ fetchSignedURL, hasKey }`, reading the key via `settingsDomain.readIntegrationsUnmasked()` → `elevenlabs.api_key`. Wired onto `window.CloudElevenLabs` in `web/cloud/js/apishim.js:885`.
- **Server route (reference for the upstream shape, unchanged):** `internal/server/elevenlabs_handlers.go` `handleElevenLabsUploadFile` forwards multipart to `https://api.elevenlabs.io/v1/convai/conversations/{conversation_id}/files` with header `xi-api-key`, returns `{file_id}` verbatim.
- **CSP:** `api.elevenlabs.io` is a fixed-allowed connect target for cloud accounts (see `internal/cloudserver` CSP invariant), so a browser-direct POST is permitted.
- **Tests:** `web/static/js/tests/features.elevenlabs-call.test.js` has a `sendPhoto` describe block (~line 363) and a cloud describe block (~line 599) with a `window.CloudElevenLabs = { fetchSignedURL, hasKey }` stub pattern (~line 765). New behavior extends these existing blocks (docs/frontend.md testing posture — no standalone/coverage files).

Related patterns: `web/cloud/js/elevenlabs-signed-url.js` (browser-direct BYO fetch to `api.elevenlabs.io`, CORS `allow-origin:*`).

Dependencies: none new. Reuses existing `settingsDomain`, `window.CloudElevenLabs` seam.

## Development Approach

- **Testing approach:** Regular (code first, then extend the owning feature suite).
- Small, focused changes across two files + one test file.
- Every task ends with tests that must pass before the next.
- Maintain backward compatibility: bot mode path (`/api/elevenlabs/upload-file`) stays byte-for-byte.

## Testing Strategy

- **Unit/integration tests:** extend `web/static/js/tests/features.elevenlabs-call.test.js` (Vitest + jsdom via the frontend harness) — the owning ElevenLabs call suite. No new standalone test files.
- Cover: cloud path calls `window.CloudElevenLabs.uploadFile` (not the proxy fetch) and forwards the returned fileId to `sendMultimodalMessage`; cloud upload failure surfaces "Photo upload failed"; bot path still POSTs to `/api/elevenlabs/upload-file` unchanged.
- The `web/cloud/js/elevenlabs-signed-url.js` `uploadFile` method: if that module has a sibling unit suite, add a case there; otherwise its behavior is covered through the call-feature integration test with a `CloudElevenLabs.uploadFile` stub (its real fetch shape mirrors the existing `fetchSignedURL`, already covered by that module's tests if present).

## Progress Tracking

- Mark completed items `[x]` immediately.
- `➕` newly discovered tasks, `⚠️` blockers.

## Implementation Steps

### Task 1: Add browser-direct uploadFile to the cloud ElevenLabs client
- [x] In `web/cloud/js/elevenlabs-signed-url.js`, add an `uploadFile(conversationId, file)` method to the object returned by `createElevenLabsClient`: read `elevenlabs.api_key` via `settingsDomain.readIntegrationsUnmasked()` (throw the same "Set your ElevenLabs API key in Settings → Integrations" error when absent); build a `FormData` with `file` field (filename `file.name || 'photo.jpg'`); `fetch` POST to `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}/files` with header `xi-api-key`; on non-2xx throw an `Error` carrying `.status`; parse JSON and return the `file_id` (throw if missing).
- [x] Guard `conversationId` the same way the server does — reject if it contains `/`, `?`, or `#` (path-safety), throwing a clear error.
- [x] Export `uploadFile` from the returned client object alongside `fetchSignedURL` and `hasKey`.
- [x] If `web/cloud/js/` has a test suite for this module, add success + error (no key, non-2xx, missing file_id) cases; otherwise note coverage is via Task 3's integration tests. (No sibling suite exists — coverage deferred to Task 3.)
- [x] Run `pnpm test` for touched suites — must pass before Task 2. (features.elevenlabs-call: 44 passed.)

### Task 2: Route sendPhoto browser-direct in cloud mode and remove the guard
- [x] In `web/static/js/features/elevenlabs-call.js`, make the upload mode-aware: when `window.__MEDTRACKER_CLOUD__ && window.CloudElevenLabs?.uploadFile`, call `window.CloudElevenLabs.uploadFile(conversationId, file)` to get the fileId; otherwise keep the existing `uploadFileViaProxy` (bot) path. Preserve the existing conversation-id resolution, hang-up-during-await guard, and status-message behavior in `sendPhoto`. (Added `uploadFile(conv, file)` dispatcher + shared `resolveConversationId`.)
- [x] Remove the `if (!window.__MEDTRACKER_CLOUD__)` wrapper around the "Send photo" button + input in `buildCard` (~line 501) so the control renders in both modes; delete the now-stale bot-only-proxy comment / update it to describe the mode-aware path. Keep the `ponytail:` note only if still accurate (removed — no longer accurate).
- [x] Confirm no new `window.*` global is introduced (reuses existing `window.CloudElevenLabs`); no hardcoded colors or inline `.style.` assignments added (rule 3); no direct `navigator`/`getUserMedia` use (rule 10 — file input is already the existing mechanism).
- [x] Update the `sendPhoto` describe block in `web/static/js/tests/features.elevenlabs-call.test.js`: add a cloud case asserting `window.CloudElevenLabs.uploadFile` is called (with conversationId + file) and its returned fileId is passed to `sendMultimodalMessage`, and that the `/api/elevenlabs/upload-file` proxy fetch is NOT called in cloud mode.
- [x] Add a cloud error case: `CloudElevenLabs.uploadFile` rejects → status surfaces "Photo upload failed" and `sendPhoto` rejects.
- [x] Keep/verify the existing bot-mode happy-path test (posts to `/api/elevenlabs/upload-file`) still passes unchanged.
- [x] Run `pnpm test` for the call suite — must pass before Task 3. (features.elevenlabs-call: 46 passed.)

### Task 3: Verify acceptance criteria
- [ ] Verify: cloud mode renders "Send photo"; cloud upload goes browser-direct to `api.elevenlabs.io` with the vault key; no `/api/elevenlabs/upload-file` dependency in the cloud branch.
- [ ] Verify: bot mode still proxies through the server route (test + code read).
- [ ] Verify: the `!window.__MEDTRACKER_CLOUD__` guard around the photo UI is gone.
- [ ] Run full `pnpm test` (frontend) and `go build ./...` + `go build -tags mobile ./...` (no Go changes expected, but confirm nothing broke) — all must pass.
- [ ] Run the frontend architecture tests (globals allowlist, native-abstractions, no-hardcoded-style) — must pass.

### Task 4: [Final] Docs
- [ ] If `docs/features.md` or a cloud-parity note references the photo-in-cloud gap, update it to reflect parity is now closed. No new doc required.

## Technical Details

- **Upstream call (browser-direct):** `POST https://api.elevenlabs.io/v1/convai/conversations/{conversationId}/files`, multipart body field `file`, header `xi-api-key: <vault key>`; response `{ "file_id": "..." }`. Mirrors `handleElevenLabsUploadFile` exactly but from the browser with the user's own key.
- **Mode branch point:** inside `sendPhoto`/`uploadFileViaProxy` in `elevenlabs-call.js`. Cloud detection reuses the existing `window.__MEDTRACKER_CLOUD__ && window.CloudElevenLabs` pattern already used by `fetchSignedURL`.
- **Key never crosses /api:** the fetch targets `api.elevenlabs.io` directly; `makeAuthHeaders()` is NOT used on the cloud path (that is bot-mode session auth). Only `xi-api-key` from the vault is sent, to ElevenLabs.

## Post-Completion

**Manual verification** (requires a real cloud account + ElevenLabs key — cannot be automated here):
- Start a cloud voice call, tap "Send photo", pick an image, confirm the assistant can reference it and that the network request went to `api.elevenlabs.io/.../files` (not `/api/...`).
- Confirm bot mode still works end-to-end (proxy path).
