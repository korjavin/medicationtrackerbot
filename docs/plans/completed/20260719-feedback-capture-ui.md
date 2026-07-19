# Cloud feedback channel — capture UI: text + image + voice (bd med-dni.2)

## Overview

Second slice of the cloud feedback channel (epic med-dni). A **cloud-mode-only**
"Send feedback" affordance: a launcher button mounted into the live app that opens a
modal where anyone can compose feedback — free **text**, an attached **image**
(screenshot/photo), and a recorded **voice message** — and submit it. This task builds
the capture UI + bundle assembly and hands the assembled bundle to an
`enqueueFeedback(bundle)` seam. The encrypt + durable-retry + POST behind that seam is
**med-dni.3**; the server endpoint + ENV recipient meta already shipped in **med-dni.1**.

**Decided (from the user):** feedback is **anonymous** — do NOT attach account id or any
PII; only what the user types + the bundle attachments.

Two prerequisites surfaced in discovery:
1. **Voice recording is a native-capability gap.** `window.MediaCapture` exposes only
   image methods (`takePhoto`/`pickPhoto`/`openCameraStream`); its web impl hardcodes
   `audio:false` and there is no `MediaRecorder` anywhere under `native/`. CLAUDE.md
   rule 10 forbids raw `getUserMedia`/`MediaRecorder` outside `web/static/js/native/`.
   So this task **adds a `recordAudio` capability to the MediaCapture abstraction**
   (web impl + capacitor stub), used by the modal.
2. **No DOM-screenshot util exists** — "attach a screenshot" = an image file-pick via the
   existing `MediaCapture.pickPhoto({ capture:false })` (same path as food photo). A
   true "capture current view" is out of scope.

**Cloud-first.** UI lives in `web/cloud/js/`; the one shared-code touch is adding
`recordAudio` inside `web/static/js/native/` (the sanctioned home for device
capabilities — used by both bot and cloud, additive, no behavior change to existing
callers). No bot-mode feature changes.

## Context (from discovery)

- **Boot/mount seam** — `web/cloud/js/cloud-boot.js` post-unlock block (`:187` onward,
  after `installApiShim`, `:191-196`) dynamically imports cloud-only ES modules and
  mounts DOM into the live app. The auth-expired banner (`:222-244`) is the copyable
  "create a button, wait for `document.body`, dedupe by id, append" template. Mount the
  feedback launcher here, gated on `getFeedbackRecipient() !== ''`
  (`web/cloud/js/feedback-config.js`, shipped in med-dni.1). No `window.*` global — a
  dynamic `import('/js/feedback-ui.js')` calling an exported `mountFeedbackLauncher(ctx)`
  (rule 4 avoided; cloud modules are ES modules).
- **MediaCapture abstraction** — stub list `web/static/js/native/index.js:96`; web impl
  `web/static/js/native/web/media-capture.js` (`pickPhoto` `:120`, `takePhoto` `:92`,
  `getUserMedia audio:false` `:85`); capacitor impl under `native/capacitor/`. Image
  attach = `window.MediaCapture.pickPhoto({ capture:false })` (caller example
  `features/food/scanner.js:162`). Registration via the foundation's `registerImpl`.
- **Modal + tokens** — copy `web/static/js/features/trial-consent.js:66-140`:
  `<mt-modal class="wg-modal ...">` (`.open()/.close()`, a11y from
  `components/mt-elements.js:4-27`), `.wg-modal__header/__title/__body/__actions`,
  buttons `wg-gloss` / `wg-gloss wg-gloss--sun`. The main app (where the launcher mounts
  post-unlock) already loads `styles.css`, so `.wg-modal`/`.wg-gloss` tokens are
  available — **no new `cloud.css` tokens**. Rule 3: no inline styles / hardcoded colors
  (cloud guard `web/cloud/js/tests/architecture.cloud-tokens.test.js`).
- **Native-abstraction guard** — `tests/architecture.native-abstractions.test.js` bans
  `getUserMedia`/`MediaRecorder`/`mediaDevices` outside `native/`. The new `recordAudio`
  MediaRecorder code lives inside `native/web/media-capture.js` → allowed. Ship a native
  test (extend the existing MediaCapture native suite, or `tests/native.audio.test.js`).
- **Test posture** — cloud UI test at `web/cloud/js/tests/feedback-ui.test.js` (jsdom +
  vitest), co-located with the other cloud suites and with `feedback-config.js`'s owner.
  Integration-first; NO `*-branches`/`*-edges`/standalone `pin-defect` files (extend the
  one suite). Run vitest with **Node 20** (`/tmp/node-v20.18.1-linux-x64/bin` on PATH;
  `node node_modules/vitest/vitest.mjs run <file>`).

## Development Approach

- **Testing approach**: Regular. Each task ends with passing tests (Node 20 for vitest).
- The `enqueueFeedback` seam is a thin stub in this task (`web/cloud/js/feedback-submit.js`
  exporting `enqueueFeedback(bundle)`), fully implemented in med-dni.3. Tests spy on it.
- Keep the audio API minimal: a start/stop handle, since a voice message needs
  start-then-stop (unlike one-shot `takePhoto`).

## Progress Tracking
- Mark `[x]` immediately. `➕` new, `⚠️` blocker.

## Implementation Steps

### Task 1: add `recordAudio` to the MediaCapture native abstraction
- [x] Add a `recordAudio()` (or `startAudioRecording()`) method to the MediaCapture stub
      contract (`web/static/js/native/index.js:96`) returning a recording **handle**
      `{ stop(): Promise<Blob>, cancel(): void }` — start begins capture, `stop()`
      resolves an audio `Blob` (e.g. `audio/webm`), `cancel()` discards + releases the
      mic. Rationale: voice message = start→stop, not one-shot.
- [x] Web impl in `web/static/js/native/web/media-capture.js`: implement via
      `MediaRecorder` over `getUserMedia({ audio:true })` (this file is inside `native/`,
      the sanctioned place). Collect chunks, stop→`Blob`, always stop the `MediaStream`
      tracks on stop/cancel/error. Add a `requestPermissions`/availability path if the
      existing one needs audio.
- [x] Capacitor impl stub in `native/capacitor/` mirroring the web signature (may throw
      "not supported" / return null on desktop shell — the feature is web-first; keep
      parity so the registry has both).
- [x] Register the new method via the foundation's `registerImpl` the same way the
      existing MediaCapture methods are registered.
- [x] Tests: extend the MediaCapture native suite (`tests/native.media-capture.test.js`
      or add `tests/native.audio.test.js`): `recordAudio()` returns a handle; `stop()`
      resolves a Blob (mock `MediaRecorder`/`getUserMedia`); `cancel()` stops tracks and
      resolves nothing; tracks are released on stop. Confirm
      `architecture.native-abstractions.test.js` still passes (MediaRecorder only inside
      `native/`).
- [x] Run those tests (Node 20) — must pass before Task 2.

### Task 2: feedback-ui.js — modal, capture, bundle assembly, enqueue seam
- [x] Add `web/cloud/js/feedback-submit.js`: `export async function enqueueFeedback(bundle)`
      — **stub** for this task (persist nothing; log + resolve; a clear
      `// med-dni.3 implements age-encrypt + durable queue + POST` comment). Signature is
      the contract med-dni.3 fills.
- [x] Add `web/cloud/js/feedback-ui.js` exporting `mountFeedbackLauncher(ctx)`:
      - Mounts one launcher button into the live app (dedupe by element id, wait for
        `document.body` — copy the banner pattern `cloud-boot.js:222-244`). Uses `wg-*`
        classes only.
      - Opens an `<mt-modal class="wg-modal wg-feedback-modal">` (copy
        `trial-consent.js:66-140`): a `<textarea>` for text; an **Attach image** button →
        `window.MediaCapture.pickPhoto({ capture:false })` → preview + hold the Blob; a
        **Record voice** button → `window.MediaCapture.recordAudio()` handle, toggling to
        a **Stop** button → holds the audio Blob (show a "recorded ✓"/duration chip);
        **Send** and **Cancel** actions (`wg-gloss` / `wg-gloss wg-gloss--sun`).
      - On **Send**: assemble `bundle = { text, attachments: [{ type:'image'|'audio',
        mime, bytes: ArrayBuffer|Uint8Array }] }` — **no account id, no PII** (decided).
        Call `enqueueFeedback(bundle)`, then close the modal + show a brief "Thanks, sent"
        confirmation (optimistic — actual delivery reliability is med-dni.3's queue).
      - Disable Send when text is empty AND no attachment. Escape/Cancel dismiss.
- [x] Guard: everything degrades gracefully if `MediaCapture.recordAudio` is unavailable
      (older shell) — hide the Record button, keep text+image.
- [x] Tests `web/cloud/js/tests/feedback-ui.test.js` (jsdom, Node 20): modal opens from
      the launcher; typing text + (mocked) `pickPhoto`/`recordAudio` returning Blobs →
      Send calls a spied `enqueueFeedback` with a bundle carrying the text + both
      attachments and **no account/PII field**; Send disabled when empty; Cancel/Escape
      close without calling enqueue; Record→Stop toggles and captures the audio Blob.
- [x] Run `feedback-ui.test.js` (Node 20) — must pass before Task 3.

### Task 3: mount the launcher from cloud-boot (gated on configured recipient)
- [x] In `web/cloud/js/cloud-boot.js` post-unlock block (after the apishim install,
      `:191-196`): `import('/js/feedback-config.js')`; if `getFeedbackRecipient()` is
      non-empty, `import('/js/feedback-ui.js')` and call `mountFeedbackLauncher(ctx)`.
      When the recipient is unset, import nothing (feature fully absent — matches the
      med-dni.1 server 503/no-meta disabled state).
- [x] Tests: extend the cloud-boot test suite (or feedback-ui suite) to assert the
      launcher mounts only when a recipient meta is present, and is absent otherwise.
- [x] Run the affected cloud suites (Node 20) — must pass before Task 4.

### Task 4: verify + full suite
- [x] Run the full frontend suite (`node node_modules/vitest/vitest.mjs run`, **Node 20**)
      incl. `architecture.native-abstractions.test.js`, `architecture.cloud-tokens.test.js`,
      `architecture.globals.test.js` — all green (no new window global, no inline styles,
      no raw MediaRecorder outside native/). 319 test files, 3808 passed / 29 skipped.
- [x] Run `go build ./...` + `go build -tags mobile ./...` (no Go changes expected, but
      confirm the tree still builds). Both build clean.
- [x] `gofmt`-equivalent: no lint regressions on changed JS. No eslint/prettier configured
      in-repo; architecture guards are the lint-equivalent (pass) + `node --check` clean on
      all changed JS.

### Task 5: Verify acceptance criteria
- [x] Cloud mode with a configured recipient shows a "Send feedback" launcher; the modal
      captures text + an image (via `pickPhoto`) + a voice message (via the new
      `recordAudio` cap). Verified by `feedback-ui.test.js` (modal-open + capture cases).
- [x] Send assembles an anonymous bundle (no account id / PII) and calls
      `enqueueFeedback` (the med-dni.3 seam). Verified by the spy-on-`enqueueFeedback`
      test asserting text + both attachments and no account/PII field.
- [x] With no recipient configured, the whole feature is absent. Verified: launcher mount
      is gated on `getFeedbackRecipient() !== ''` in `cloud-boot.js:383-389`.
- [x] Voice recording goes through `native/` (rule 10); no inline styles / hardcoded
      colors (rule 3); no new `window.*` global (rule 4). Verified by
      `architecture.native-abstractions.test.js`, `architecture.cloud-tokens.test.js`,
      `architecture.globals.test.js` (all green in Task 4's full-suite run).

## Technical Details

- **Anonymous**: the bundle carries only user-authored content — enforced by the test
  asserting no account/PII field. Metadata like app version is added server-side/at
  submit (med-dni.3), not here.
- **Audio handle shape**: `{ stop(): Promise<Blob>, cancel() }` keeps the UI simple
  (record → stop) and guarantees mic release on every exit path.
- **Seam**: `enqueueFeedback(bundle)` is the single integration point with med-dni.3 —
  this task's stub makes the UI independently testable; med-dni.3 swaps the body for
  age-encrypt + IndexedDB durable queue + retry/backoff + `POST /api/feedback`.
- **Graceful degradation**: missing `recordAudio` (old shell) hides voice only; text +
  image still work.

## Post-Completion

**Manual verification** (cloud deploy, `FEEDBACK_AGE_RECIPIENT` set): open the app, tap
"Send feedback", type a note, attach an image, record a short voice clip, Send — confirm
the modal closes with a thanks message. Actual delivery to the server queue is wired in
med-dni.3.

**Follow-on**: med-dni.3 implements `enqueueFeedback` (encrypt + durable retry queue +
POST); med-dni.4 the decrypt CLI; med-dni.5 the Telegram channel.
