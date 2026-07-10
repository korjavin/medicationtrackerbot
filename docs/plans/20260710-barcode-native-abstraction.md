# Route the food scanner's browser live-scan through the native abstractions (med-9lq)

## Overview

`web/static/js/features/food/scanner.js` reaches around the `web/static/js/native/`
device-capability layer that CLAUDE.md rule 10 exists to enforce. Its browser
live-scan path:

1. decides the platform itself, via a local `isNativeShell()` helper that reads
   `window.Capacitor.isNativePlatform()` — rule 10 says the *abstraction* picks a
   web or Capacitor impl at runtime, feature code must not;
2. calls `navigator.mediaDevices.getUserMedia(...)` directly instead of going
   through `window.MediaCapture`;
3. probes `window.BarcodeDetector` directly as a live-scan capability check
   instead of asking `window.Barcode`.

Nothing is broken today — the branch happens to be correct. This is exactly the
drift the rule was written to prevent ("bypassing it silently works in the
browser and silently doesn't in the Android shell"), and **no architecture test
catches it**.

This is a routing/ownership refactor. **No user-visible behavior change on
either platform.**

Benefits: the platform decision lives in one place (the abstraction), a new
device capability (`openCameraStream`) becomes available to any feature, and a
guard test stops the next bypass from landing.

## Context (from discovery)

**Files/components involved:**
- `web/static/js/features/food/scanner.js` — the offender (`startFoodScanner`,
  `isNativeShell`, `stopFoodScanner`)
- `web/static/js/native/index.js` — foundation, `registerImpl`, impl selection
- `web/static/js/native/web/barcode.js` — has `{ scan }`; already decodes a
  video-element source via `BarcodeDetector`, ZXing fallback for image/canvas/blob
- `web/static/js/native/capacitor/barcode.js` — has `{ scan }`; owns a
  full-screen MLKit scanner UI, takes no `source`
- `web/static/js/native/web/media-capture.js` — `{ takePhoto, pickPhoto,
  requestPermissions }`; `takePhoto` already contains the exact
  `getUserMedia({audio:false, video:{facingMode:{ideal:...}}})` + `stopStream`
  code we need to factor out
- `web/static/js/native/capacitor/media-capture.js` — same surface, Capacitor plugins
- `web/static/js/tests/native.barcode.test.js`,
  `web/static/js/tests/native.media-capture.test.js` — pure-unit suites for the
  native layer (this is the sanctioned exception to the integration-first rule)
- `web/static/js/tests/architecture.globals.test.js` — the allowlist-with-
  justification style to mirror

**Already compliant — do not touch:**
- `scanFrameLoop()` already calls `window.Barcode.scan({ source: video, ... })`
- `openPhotoPickerAndDecode()` already uses `window.MediaCapture.pickPhoto` +
  `window.Barcode.scan`

**Discovery finding that changes the guard's scope.** `Capacitor.isNativePlatform`
is read in more places than the bead names:

| File | Line | What it is |
|---|---|---|
| `core/native-bootstrap.js` | 32-41 | bootstrap; legitimately probes the shell |
| `core/messenger-adapter.js` | 286 | decides whether to load the Telegram SDK (CLAUDE.md rule 11) |
| `features/firstrun/permissions.js` | 29 | shows/hides a native-only permission screen |
| `features/firstrun/screens/permissions.js` | 48 | same |
| `features/settings/integrations.js` | 139 | shows/hides a native-only settings row |
| `features/food/scanner.js` | 99 | **the violation — routes a device capability** |

The last three are *shell-presence* checks that gate UI, not device-capability
routing. Forcing them behind an abstraction is out of scope for med-9lq. So the
guard must distinguish the two:

- **device-capability globals** (`navigator.mediaDevices`, `getUserMedia`,
  `BarcodeDetector`) — banned outside `native/`, **no exceptions**. This is the
  real rule-10 invariant.
- **`Capacitor.isNativePlatform`** — allowlisted to the five files above (minus
  scanner.js, which this plan removes), each with a justification. New drift fails.

**Dependencies:** none new. No new `window.*` global is created — the change adds
*methods* to the existing `window.Barcode` / `window.MediaCapture` globals, so
`tests/architecture.globals.test.js` needs no new entry.

## Development Approach

- **Testing approach**: NO unit tests for feature code. The `native/` layer's
  existing `native.*.test.js` suites are pure-unit by design (no integration
  entry point) — extending them is correct and expected here.
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: if a task adds a test, it must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Maintain backward compatibility: `Barcode.scan` and `MediaCapture.takePhoto` /
  `pickPhoto` / `requestPermissions` keep their exact current signatures

## Testing Strategy

- **Unit tests**: only within `web/static/js/tests/native.*.test.js`, which is the
  established home for the `native/` layer (it has no integration entry point).
- **Integration tests**: the food scanner's existing feature suite must stay green.
  Extend it only if an existing case does not already cover the start/stop flow.
- **Architecture test**: one new `architecture.*.test.js` — this *is* the
  deliverable for the "no test catches it" half of the bead.
- **E2E tests**: none. The project has no e2e suite.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope
- Keep plan in sync with actual work done

## Implementation Steps

### Task 1: Add `openCameraStream` to the MediaCapture abstraction

- [x] in `web/static/js/native/web/media-capture.js`, add
      `openCameraStream(opts)` returning a `Promise<MediaStream>`: guard on
      `navigator.mediaDevices.getUserMedia` availability exactly as `takePhoto`
      does, then `getUserMedia({ audio: false, video: { facingMode: { ideal:
      opts.facingMode || 'environment' } } })`; reject via the existing
      `normalizeError` so callers see `{ name: 'MediaCaptureError', code }`
- [x] refactor the existing `takePhoto` to acquire its stream via
      `openCameraStream` so there is exactly one `getUserMedia` call site in the
      file (keep `stopStream`/`captureFrameFromVideo` behavior byte-for-byte)
- [x] export `openCameraStream` on the web `impl` object
- [x] in `web/static/js/native/capacitor/media-capture.js`, add
      `openCameraStream` that rejects with a normalized
      `{ name: 'MediaCaptureError', code: 'UNAVAILABLE' }` — the Capacitor shell
      never opens the in-app video modal (MLKit owns the scanner UI). Comment
      the *why*, not the what.
- [x] extend `web/static/js/tests/native.media-capture.test.js`: web impl
      resolves with the stream and requests `facingMode: environment`; web impl
      rejects `UNAVAILABLE` when `getUserMedia` is absent; capacitor impl always
      rejects `UNAVAILABLE`

### Task 2: Let Barcode own the platform decision

- [ ] in `web/static/js/native/web/barcode.js`, add `hasNativeScanner()`
      returning `false` (the web impl has no full-screen UI of its own) and
      `supportsLiveScan()` returning `!!window.BarcodeDetector` (probe at call
      time, not module load — tests and real browsers install it late)
- [ ] in `web/static/js/native/capacitor/barcode.js`, add `hasNativeScanner()`
      returning `true` and `supportsLiveScan()` returning `false` (MLKit needs no
      video element; the in-app frame loop must never run there)
- [ ] export both from each `impl` object
- [ ] extend `web/static/js/tests/native.barcode.test.js` to pin both methods on
      both impls, including `supportsLiveScan()` flipping with
      `window.BarcodeDetector` presence

### Task 3: Route scanner.js through the abstractions

- [ ] in `web/static/js/features/food/scanner.js` `startFoodScanner()`, replace
      the `isNativeShell() && window.Barcode && ...` branch with a
      `window.Barcode.hasNativeScanner()` check (defensively: treat a missing
      method as `false` so an old cached bundle degrades to the web path)
- [ ] replace the direct `window.BarcodeDetector` probe with
      `window.Barcode.supportsLiveScan()`; keep the identical user-facing string
      ("Live scan is unavailable on this browser. Use \"Use Photo\".")
- [ ] replace the `!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia`
      probe and the `navigator.mediaDevices.getUserMedia(...)` call with
      `await window.MediaCapture.openCameraStream({ facingMode: 'environment' })`,
      mapping its rejection onto the existing "Camera access denied or
      unavailable." / "Camera is unavailable." status strings. Preserve the
      `window.isSecureContext` check (that is not a device capability).
- [ ] delete the now-unused local `isNativeShell()` helper
- [ ] leave `stopFoodScanner()` semantics untouched: tracks stopped, `srcObject`
      nulled, `pagehide`/`beforeunload` listeners intact
- [ ] run the food scanner's existing feature suite — must pass unchanged

### Task 4: Add the architecture guard that catches the next bypass

- [ ] create `web/static/js/tests/architecture.native-abstractions.test.js`
      following the `architecture.globals.test.js` style (read files off disk,
      assert on source text, document every allowlist entry with a reason)
- [ ] fail if any file under `web/static/js/` outside `web/static/js/native/`
      references `navigator.mediaDevices`, `getUserMedia`, or `BarcodeDetector`.
      No allowlist — these are device capabilities and `native/` owns them.
- [ ] fail if any file outside `web/static/js/native/` references
      `isNativePlatform`, except an explicit allowlist of
      `core/native-bootstrap.js`, `core/messenger-adapter.js`,
      `features/firstrun/permissions.js`,
      `features/firstrun/screens/permissions.js`,
      `features/settings/integrations.js` — each with a one-line justification
      naming it a shell-presence UI gate, not device-capability routing.
      `features/food/scanner.js` must NOT be on this list (Task 3 removes it).
- [ ] assert the allowlist has no stale entries (every listed file still exists
      and still matches), so it can't rot into a rubber stamp
- [ ] confirm the guard actually fails by temporarily reintroducing a
      `navigator.mediaDevices` reference in `scanner.js`, then revert

### Task 5: Verify acceptance criteria

- [ ] verify all requirements from Overview are implemented
- [ ] verify `scanner.js` contains no `navigator.`, `BarcodeDetector`, or
      `Capacitor` reference at all
- [ ] verify no new `window.*` global was introduced (methods only) — if one was,
      add it to `tests/architecture.globals.test.js` with justification per rule 4
- [ ] run `pnpm test` (vitest) — the full frontend suite must pass
- [ ] verify no Go source changed (`git diff --name-only` shows no `.go` files)

### Task 6: [Final] Update documentation

- [ ] update `docs/frontend.md` -> "Native Platform Abstractions": document
      `Barcode.hasNativeScanner()` / `Barcode.supportsLiveScan()` /
      `MediaCapture.openCameraStream()`, and name the new architecture test as
      the guard, alongside the existing `tests/native.<cap>.test.js` requirement
- [ ] if the new guard changes what rule 10 promises, reflect it in `CLAUDE.md`
      rule 10 (one sentence: the invariant is now enforced by a test)

## Technical Details

**New abstraction surface** (methods on existing globals; no new global):

| Global | Method | web impl | capacitor impl |
|---|---|---|---|
| `MediaCapture` | `openCameraStream({facingMode})` | `Promise<MediaStream>` via `getUserMedia` | rejects `UNAVAILABLE` |
| `Barcode` | `hasNativeScanner()` | `false` | `true` |
| `Barcode` | `supportsLiveScan()` | `!!window.BarcodeDetector` | `false` |

**Resulting control flow in `startFoodScanner()`:**

```
Barcode.hasNativeScanner()?  -> scanWithNativeBarcode()          [capacitor]
!window.isSecureContext      -> "Camera requires HTTPS..."
!Barcode.supportsLiveScan()  -> "Live scan is unavailable..."
MediaCapture.openCameraStream({facingMode:'environment'})
  ok      -> video.srcObject = stream; play(); scanFrameLoop()
  reject  -> "Camera access denied or unavailable. Use \"Use Photo\"."
```

**Error contract:** `openCameraStream` rejects with the existing normalized
`MediaCaptureError` shape (`code` in `PERMISSION_DENIED` | `UNAVAILABLE`), so
`startFoodScanner`'s catch can keep using the same two status strings.

**Backward compatibility:** a stale cached `barcode.js` without the new methods
must not hard-fail. Feature code calls them defensively
(`typeof window.Barcode.hasNativeScanner === 'function' && ...`), degrading to the
web live-scan path — the historical default.

## Post-Completion

*Items requiring manual intervention or external systems — informational only*

**Manual verification:**
- Browser: open the Food screen -> Scan -> camera prompt appears, live scan decodes
  a barcode, closing the modal stops the camera LED.
- Browser without `BarcodeDetector` (e.g. Firefox): Scan shows "Live scan is
  unavailable on this browser. Use \"Use Photo\"." and "Use Photo" still decodes
  via the ZXing fallback.
- Android APK: Scan opens the full-screen MLKit scanner, not the in-app video
  modal; cancel returns cleanly with no stranded empty modal.

**External system updates:** none.
