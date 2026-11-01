# iOS visual testing: runbook and agent QA

Normative how-to. Design and rationale: [design/ios-visual-testing.md](design/ios-visual-testing.md). Ordinary full visual runs report scene/probe failures as warning evidence. Explicit `visual_scenes` runs and the native HealthKit diagnostic fail their jobs on XCTest errors; image diffs remain informational.

Flow tests (first run, relaunch, and later lock, stash, backup), which are a gate, are a separate job: see [ios.md → Flow QA (Simulator)](ios.md#flow-qa-simulator-bd-med-w6gx23) (label `ios-qa`).

## Trigger

- **On a PR:** add the label `ios-visual`. It starts both `ios.yml` → `visual` (Simulator, XCUITest) and `visual-web.yml` (Playwright). New pushes to the labeled PR re-run them.
- **Dispatch on a branch:** `gh workflow run ios.yml --ref <branch> -f visual=true` (skips the build and TestFlight); `gh workflow run visual-web.yml --ref <branch>`.
- **Dispatch on `master` only to refresh the compare reference.** Compare uses the newest master `workflow_dispatch` run that has the artifact. The visual job has its own concurrency group (`ios.yml-visual-<ref>`, cancel-in-progress) and does not touch the TestFlight build. Never dispatch or cancel a master run while another master visual run is in flight: the shared group cancels it.
- macOS minutes are expensive: label only when the change can move layout.
- A default dispatch still runs the intentional TestFlight build. Any Simulator flag or non-default modifier (`health_sign` or `visual_scenes`) excludes that build, including an incomplete modifier-only dispatch; enable the owning diagnostic/visual flag to actually run its job.

## Native HealthKit diagnostic

When the browser reports Health unavailable, capture the native result before changing signing:

```bash
gh workflow run ios.yml --ref <branch> -f health_diagnostic=true
gh workflow run ios.yml --ref <branch> -f health_diagnostic=true -f health_sign=true
```

Run one variant at a time. The first reproduces the former unsigned visual build; the second lets Xcode sign for the Simulator, as the visual job now does. Both skip TestFlight. `health_sign` only affects the diagnostic job. The default Debug/Simulator-only diagnostic requests read access to Steps and executes a real sample query, without the browser's error translation; it never writes samples. Ordinary flow QA excludes this experiment.

For the populated native scene, dispatch `-f visual=true -f visual_scenes=health-kit-import`. Both widths run with a strict XCTest exit status. This scene separately opts into a Debug/Simulator-only seed that saves real Steps/HR/SpO2/sleep samples to Health, clears fixture vitals, imports through the actual native bridge and local importer, and asserts the resulting overview values. Release does not compile the seed or request write permissions. Playwright skips this native-only proof.

Download `health-native-baseline`: `xctest.log`, the result bundle with a screenshot and native JSON report, requested entitlements, actual executable signature/entitlements and load commands, build log and Simulator Health system logs. Check native `available`, authorization errors and `queryCompleted`, plus XCTest's actual failure count. An empty successful query proves API access, not populated-card acceptance. Inspect the permission screenshot if authorization remains pending. Simulator entitlements may be in a Mach-O `__entitlements` section even when the code-signature entitlement dictionary is empty.

The unsigned baseline on 2026-10-30 returned `available: true` and HealthKit error 4, `Missing com.apple.developer.healthkit entitlement.` Xcode Simulator signing subsequently launched the real Health Access sheet. These observations distinguish the original entitlement failure from a missing Health store; they do not establish seeded visual scenes.

## Duration

iOS Simulator job about 35-50 min (devices boot one after the other; job timeout 60). Web tiers about 5 min. Watch: `gh run watch <run>`.

## Download

```bash
gh run download <run> -n ios-visual -D /tmp/claude-vw/<run>
gh run download <run> -n ios-visual-web -D /tmp/claude-vw/<run>-web
gh run download <run> -n ios-visual-web-compare -D /tmp/claude-vw/<run>-webcmp
```

## What is inside

- `ios-visual`: `shots/<device>/<scene>.png` plus `<scene>.json` (probe report) for `iPhone 16e` (390pt) and `iPhone 17 Pro Max` (440pt); `shots/compare/summary.md`, `summary.json` and `diff/<device>/<scene>.png` against master's latest dispatched run.
- `ios-visual-web`: the same scenes from Playwright WebKit (390 and 440pt), Chromium desktop and Pixel 7, and the cloud tier. `ios-visual-web-compare`: the diff against master's `ios-visual-web`.
- Read `summary.md` first. Never diff web PNGs against Simulator PNGs. Linux WebKit is not WKWebView: no focus-zoom, keyboard, safe areas or shell bands; only the Simulator tier would have caught `med-pe9g`.

## Reading probes (`<scene>.json`)

`ok`, `failed[]`, `probes{}`, `paint`. Scene passes only if `failed` is empty.

| Probe | Means | Known false-positive patterns |
|---|---|---|
| `scale` | `visualViewport.scale` is not 1: focus-zoom happened | none; real bug (input under 16px) |
| `hOverflow` | `scrollWidth > innerWidth` | an off-canvas element that is clipped by an ancestor; look at the PNG |
| `clippedTop` | a sheet/app/page header sits above the visible top | page behind an open sheet panned by the keyboard (driver already ignores headers outside the top `mt-modal`, and in-flow headers the document scrolled past); compare with the PNG |
| `canvasOverflow` | a `canvas`/chart `svg` over 64px wider than its parent | an intentionally scrollable chart strip |
| `focusUnderKeyboard`, `bottomNavCovered` | focused field behind the keyboard / tab bar below the viewport | `bottomNavCovered` is meaningless in scenes where the keyboard is up |
| `readyLost` (`failed` has `ready`) | a ready selector vanished before the shot: the app switched away | race with a late redraw; re-run once before filing |
| `paint` | rect the XCUITest waits on to be non-blank | a blank-frame failure means boot starvation or a crash, not a layout bug |

`keyboardShown` is inferred from viewport shrink against the pre-focus height, including WKWebView shrinking both viewport heights. It is informational; inspect the screenshot for the actual software keyboard. `focusContext` records the target, active modal and coordinate data. Only a visible editable field in the top modal can be classified as keyboard-occluded; a focused field outside the viewport without keyboard evidence instead fails `focusOutsideViewport`. A keyboard scene captured without a keyboard (for example `ConnectHardwareKeyboard` enabled) remains unverified.

For a targeted four-profile web rerun, build the QA bundle and set `WG_QA_SCENES` to comma-separated exact names when running `tests/visual/playwright/run.mjs`, for example `meds-take-reminder-hint,trial-consent,settings-ai-key-keyboard`. Unknown/ineligible or empty names (including an explicitly empty variable) fail before execution; leaving it unset preserves the ordinary full run. `--list-scenes` validates and lists the selection without Playwright or starting a browser/server. Web keyboard steps still do not show a software keyboard, so native keyboard screenshots remain required.

## Add a scene

1. Add an entry to `tests/visual/scenes.json`: `name`, `steps` (`tab` / `click` / `tag` / `settingsPage` / `consent` — opens `TrialConsent.request(<scope>)`, a sheet with no tap path on CI), `ready` (selectors that must be visible), optional `native` (XCUITest `tap`, `type`, `clear`, `tapButton`, `waitFor`, `keyboard`, `allowNotifications`, `notification` — tap a real local notification's banner, as `reminder-stale-*` do; their Allow leaves notifications granted on that Simulator, so a local re-run on it shows `settings-notifications` granted) and `mask` (fraction rects blanked in diffs for volatile pixels). Names starting `native-` are SwiftUI-only.
2. No Swift change: `ios/UITests/VisualQATests.swift` and `driver.js` read the same file. The Playwright tiers pick it up too.
3. Label a PR and check the new PNG by eye before trusting it.

## Agent visual-QA checklist

For a PR that moves UI, or when asked to QA a branch:

1. Download the run (above); read `compare/summary.md` and every `failed` probe.
2. **Look at every changed scene yourself** with an image viewer (the Read tool on the PNG). A diff or green probe is not a look. Open the diff PNG and the reference (master) shot beside the new one.
3. Check **both widths**: 390pt (`iPhone 16e`) and 440pt (`iPhone 17 Pro Max`), not one.
4. Keyboard scenes (`*-keyboard*`): header visible, focused field above the keyboard, no zoom, list not hidden, sheet still present after clearing.
5. Run the ten heuristics on every shot:
   1. Header or app bar clipped at the top or under the status bar.
   2. Horizontal scroll, or a row cut at the right edge (chips, chart legends, long med names).
   3. Content under the keyboard or home-indicator band; tab bar overlapping content; a sheet's primary button behind the keyboard.
   4. Page wider than the screen (zoomed): sheet side margins gone.
   5. Chart wider than its card, overlapping axis labels, legend wrapping onto the plot.
   6. Text truncated mid-word; two-line labels in single-line chips.
   7. Touch targets visibly under 44pt (tiny close buttons, chevrons).
   8. Sheet taller than the screen with no scroll affordance.
   9. Dialog or toast off-screen or behind the keyboard.
   10. Empty state where the seeded fixture should show data (seeding or routing bug; file it anyway).
6. Developer fixing a bug: attach before/after PNGs to the PR. The owner's phone is only for what the Simulator cannot do (Face ID, App Attest, push, camera, Watch data).

## Filing beads

- `bd create "<scene> on <device>: <symptom>" --type bug --labels visual-qa,ios`
- Labels: `visual-qa` always; add `ios` if it reproduces only on the Simulator; add `cloud` if the web tiers show it too (shared web bug). No parent bead unless the bug is in the tooling itself (then parent to the visual-testing epic).
- Evidence line in the description: `run <id> (<url>), artifact ios-visual, shots/<device>/<scene>.png (+ .json)`. State which probe or what you saw.
- **One bead per root cause**, not per scene or device: group screenshots that share a cause (same CSS rule, same component).
- Before filing a probe-only failure, check the known false-positive patterns above and re-run once.

## Needs the owner's device

The Simulator cannot verify these. When a change touches one, finish the Simulator checks first, then **batch** everything into one owner request (TestFlight build plus a short list of what to try), not one ask per bead.

- Real keyboard accessory bar, dictation, third-party keyboards.
- Microphone and voice input; camera and barcode scan, meal photo.
- Push notifications (APNs delivery; `simctl push` only injects a payload). Local notifications do work in the Simulator.
- HealthKit data from Apple Watch (manual Health entries work).
- Passkeys, Face ID / Touch ID lock, App Attest / DeviceCheck.
- TestFlight update-in-place path.
- Backups: iCloud backup and restore, share sheet into real Files/iCloud, storage eviction.
- Real-device performance.
- Scenarios in `testscenarios/` whose `covered_by` for iOS is `manual` are the release device checks ([testscenarios/README.md](../testscenarios/README.md)).
