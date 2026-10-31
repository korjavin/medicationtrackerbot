# Design: iOS autonomous visual testing

**Epic:** iOS autonomous visual testing (label `ios`) · **Date:** 2026-10-19 · **Status:** proposal, MVP tasks filed
**Owner ask:** agents must be able to screenshot, compare and test the iOS app without the owner's phone.

## Problem

The only device test today is the owner installing a TestFlight build and sending
screenshots. bd `med-pe9g` (food sheet under the keyboard) burned three TestFlight
rounds because every hypothesis was tested by a human: the first two fixes targeted
the sheet's keyboard dock; the real cause was iOS focus-zoom on a 14px input
(PR #1115, `docs/ios.md → Keyboard and focus zoom`). Nothing in CI could have
shown it: Vitest + jsdom has no layout, zoom, keyboard or `visualViewport`, and
the macOS job only compiles the app.

The owner expects "a million" more of these: workout pages, charts, settings,
sheets. They are all **layout** bugs, which means they are all visible in a
screenshot taken on a real WebKit with a real keyboard at a real iPhone width.
That is what this design produces, as CI artifacts an agent can read.

## Goals / non-goals

- An agent can get a full screenshot matrix of the app on the iOS Simulator for
  any branch with one `gh` command, read the PNGs, and file beads with evidence.
- A developer agent can verify an iOS layout fix on the Simulator before the
  owner is asked for anything.
- Cheap Linux checks catch the pure-CSS share of the bugs on every PR.
- Not a goal: replacing the owner's phone for native-only paths (list at the end),
  pixel-exact goldens across OS updates, or testing cloud mode in the Simulator
  (needs a passkey + account; local mode exercises the same web UI).

## Tiers

| Tier | Where | Trigger | Catches | Misses |
|---|---|---|---|---|
| 0. Static iOS-hazard lint | ubuntu, Vitest architecture test | every web PR | `100vh`, fixed-bottom without `env(safe-area-inset-bottom)`, `user-scalable=no`, inputs styled under 16px | anything dynamic |
| 1. Playwright WebKit, iPhone emulation | ubuntu | opt-in: PR label `ios-visual`, `workflow_dispatch` | CSS layout at iPhone widths, horizontal overflow, clipped headers, chart overflow, modal stacking, DOM probes | focus-zoom, the keyboard, `visualViewport` panning, safe-area bands, rubber-band, WKWebView-only behaviour, iOS fonts |
| 2. iOS Simulator, XCUITest | `macos-26` | opt-in: PR label `ios-visual`, `workflow_dispatch`, nightly on master | everything in tier 1 **plus** focus-zoom, real keyboard, visual viewport, safe areas, the native first-run screens, the shell's bands | Face ID, App Attest, push, camera, Watch data |
| 3. Owner's phone | TestFlight | after tiers pass | native-only paths | — |

Tier 2 is the MVP; it is the only tier that would have caught `med-pe9g`. Tiers
0 and 1 are cheap follow-ups that reuse the tier-2 scene driver.

## Tier 2: the Simulator matrix (MVP)

### Pieces

1. **QA bundle** — `QA=1 ios/bundle-web.sh <id>` additionally copies
   `tests/visual/driver.js`, `driver.css`, `scenes.json` and
   `tests/fixtures/vault-v1.json` to `ios/LocalApp/cloud/qa/` (served at
   `/qa/*`: `LocalOrigin.file(for:)` maps every path outside `/static/` and
   `/domain/` to `cloud/`), and adds `<link rel="stylesheet"
   href="/qa/driver.css"><script src="/qa/driver.js">` to the local
   `index.html` right after the local entry, before every app script, so the
   driver pins the page clock at document start (CSP is `script-src 'self'` /
   `style-src 'self'`, so no CSP change). Without `QA=1` nothing changes:
   `/qa/*` is a 404 on `wgapp://local`, the script fails if a non-QA bundle
   carries any of it, and the TestFlight archive is built without it.
2. **In-page QA driver** (`tests/visual/driver.js`, classic script): reads
   `?qa=<scene>` from `location.search`, waits for the app's boot (the first
   `switchTab` has set `AppStore.currentTab`), refuses to run outside local
   mode, and
   - **seeds** the vault once: if the local store holds no user content
     (`CloudVault.hasUserContent`, i.e. `hasUserContent` in
     `web/domain/vault.js`), it fetches `/qa/vault-v1.json`, shifts every
     whole-string ISO date by whole days `(today − exported_at)` so Today /
     Food / charts show data, sets the fixture's timezone to the device's (no
     timezone confirm over the shots), marks first-run complete
     (`POST /api/firstrun/complete`; that record is not vault-managed, so it
     survives the import), and imports through Settings → Backup & import
     itself: a `DataTransfer`-built file on `#importexport-import-file`, then
     `SettingsImportExport.import()`. The store is empty, so the import's
     replace confirm never shows. The import reloads the page; the next load
     finds content and runs the scene, so seeding happens once per install;
   - **navigates** with the app's own entry points: scene `steps` are
     `{"tab": <section>}` (`switchTab`), `{"click": <selector>}` (sub-tab
     buttons, `#add-food-inline-btn`, a history row) and `{"settingsPage":
     <name>}` (`SettingsView.openSettingsPage`); then it waits for every
     selector in the scene's `ready` list to be visible, and for the store to
     go quiet (no `datastore:changed` for 400 ms, capped at 5 s);
   - runs **probes** and publishes the result: a visually hidden (class
     `wg-qa-hidden`, from `driver.css`) but accessible node
     `<div role="status" id="wg-qa-ready" aria-label="<json>">` where the JSON
     is `{"scene", "ok", "rev", "failed": [...], "probes": {...}}` (`scene`
     first, so the label starts with `{"scene"`; a driver error publishes
     `{"scene", "ok": false, "error"}`). XCUITest and Playwright both wait for
     that node; XCUITest reads the label as the probe report **after** its
     native steps, so the driver re-runs the probes and re-publishes the label
     (`rev` + 1) on every `visualViewport` resize/scroll and focus/input change.
   - Probes (all pure DOM arithmetic, no screenshots):
     `scale = visualViewport.scale` (must be 1), `hOverflow =
     documentElement.scrollWidth − innerWidth` (must be ≤ 0), `clippedTop` =
     any visible `.wg-sheet__header, .wg-sheethead, .wg-appbar, .wg-pagebar`
     whose top is above the visible top (a `position:fixed; top:0` marker's
     top plus `visualViewport.offsetTop`, so it holds whether the engine
     measures client rects from the layout viewport, as Chromium does, or the
     visual one, as iOS WKWebView does; a keyboard-panned viewport counts).
     While a sheet or page (`mt-modal`) is open only headers inside it count:
     the page behind the scrim may be panned off by the keyboard (med-m1x5),
     `canvasOverflow` = any `canvas` or chart `svg` (wider
     than 64px) wider than its parent, `focusUnderKeyboard` = the focused
     element's bottom beyond the visible top + `visualViewport.height`,
     `bottomNavCovered` = `.wg-tabbar` bottom beyond `innerHeight`, and
     `keyboardShown = visualViewport.height < innerHeight − 100`, which is
     reported but never fails `ok`.
   - `window.__wgQA` is the one new global (CLAUDE.md rule 4: allowlist entry
     with justification; it only exists in the QA bundle).
3. **Shell hook** (`ios/App/Shell.swift`, `#if DEBUG` only): when the launch
   argument `-wgQAScene <name>` is present, `home` becomes
   `wgapp://local/?qa=<name>`; `webView.isInspectable = true` under the same
   `#if DEBUG`. Local mode itself needs no change: `UserDefaults` reads launch
   arguments, so `-wgLocalMode 1` opens the bundled app, and `-wgLocalLockOn 0`
   keeps the lock off. The simulator build is `Debug`; `xcodebuild archive` is
   `Release`, so none of this ships.
4. **UI test target** (`ios/project.yml` → `MedTrackerUITests`,
   `type: bundle.ui-testing`, `ios/UITests/VisualQATests.swift`). One test per
   scene, generated from the scene list in `tests/visual/scenes.json` (the
   same file the driver reads; the Swift side reads it from the test bundle).
   For each scene: `app.launchArguments = ["-wgLocalMode","1","-wgQAScene",
   name]`, `app.launch()`, wait for `app.webViews.otherElements["wg-qa-ready"]`
   (XCUITest exposes WKWebView DOM as accessibility elements), perform the
   scene's **native steps** (the scene's `native` list, in order:
   `{"tap": "#<dom id>", "placeholder": "<text>"}` taps a web element by id
   or placeholder, `{"type": "<text>"}` types into it with the real keyboard,
   `{"clear": true}`, `{"tapButton": "<label>"}`, `{"waitFor": "<label or
   id>"}`, `{"keyboard": true}`; after `type`/`keyboard` it waits for
   `app.keyboards.firstMatch` before the shot), then `XCUIScreen.main.screenshot()` as an attachment with
   `lifetime = .keepAlways`, named `<scene>.png`, plus the probe JSON as a
   `.json` attachment. Native-only scenes (first-run, local intro) launch
   without `-wgLocalMode` and tap SwiftUI buttons by label.
5. **Workflow** — a second job `visual` in `.github/workflows/ios.yml`:
   - `on.workflow_dispatch.inputs.visual` (boolean), `pull_request.types:
     [opened, synchronize, labeled]` with `if: contains(labels, 'ios-visual')`,
     and `schedule` nightly on master. The existing `build` job is untouched.
   - Steps: checkout → `QA=1 ios/bundle-web.sh` → `xcodegen generate` →
     `defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool
     false` (otherwise the software keyboard may never appear) → for each
     device in the matrix: `xcrun simctl boot`, `simctl status_bar <udid>
     override --time 9:41 --batteryState charged --batteryLevel 100 --wifiBars
     3 --cellularBars 4`, `simctl ui <udid> appearance dark`, `xcodebuild test
     -scheme MedTracker -only-testing:MedTrackerUITests -destination
     'platform=iOS Simulator,id=<udid>' -resultBundlePath
     build/<device>.xcresult CODE_SIGNING_ALLOWED=NO` → `xcrun xcresulttool
     export attachments --path build/<device>.xcresult --output-path
     shots/<device>` → compare step (below) → `actions/upload-artifact`
     named `ios-visual` (`retention-days: 90`) → `$GITHUB_STEP_SUMMARY` table.
   - Devices: `iPhone 16e` (390×844, the smallest current width) and
     `iPhone 17 Pro Max` (440×956). The owner's phone is an iPhone 11-class
     414×896 on iOS 18.7, which the iOS 26 runtime shipped with Xcode 26 does
     not simulate; see the owner decision on installing the iOS 18 runtime.
   - Appearance: the app is dark in both system appearances
     (`project.yml`, `UIStatusBarStyle`), so there is no light/dark axis. The
     axes are **scene × device × keyboard state**.
6. **Compare step** (`tests/visual/compare.mjs`, `pixelmatch` + `pngjs`, two
   small dev deps): downloads the latest successful master artifact of this
   workflow (`gh run download` with `actions: read`), diffs each
   `<device>/<scene>.png`, writes `diff/<device>/<scene>.png` and
   `summary.json` (`changedRatio` per scene) and `summary.md`. No goldens in
   git: the reference is always master's last run. First run on a branch with
   no master artifact just reports "no reference". Probe failures become
   `::warning` annotations with the scene name; the job stays green (a
   screenshot run is evidence for an agent, not a gate — see owner decisions).
   As built (bd med-y5xx.4): `tests/visual/compare.sh <artifact> <shots>
   <out>` takes the artifact of that name from the newest
   `workflow_dispatch` run of the same workflow on master that has one
   (only dispatches on master make one; never the current run), runs `compare.mjs`
   and appends `summary.md` to the job summary. The iOS job ships the result
   inside `ios-visual` (`shots/compare/`); `visual-web.yml` runs it in a
   `compare` job (the Playwright container has no `gh`) as the
   `ios-visual-web-compare` artifact.

   **Quieter diffs** (bd med-y5xx.8): on `?qa=` the driver replaces `Date`
   with a clock that starts at today 23:00 local, after every (day-shifted)
   fixture entry, and ticks from there, so "Now" chips, countdowns and
   past/future splits do not depend on the time of day the job runs. Dates
   still move with the calendar day. A scene may list `mask` rectangles
   (fractions of the image) that `compare.mjs` blanks in both images.

   **Blank frames** (bd med-y5xx.11): two identical boot frames passed the
   "two shots a second apart match" rule. The report now carries `paint`,
   the last ready element's rect in web view points, and XCUITest shoots
   only once that screen region holds content (≥ 0.5 % of its pixels off
   the region's median luminance), else the scene fails with the shot
   attached. A view that undoes a step after the ready check (workouts-stats
   shot Plans with `ok:true`, run 39214150540) is caught too: the driver
   redoes the steps once if a ready selector is gone after the settle, and
   every report (re-published on class/`hidden` mutations) re-checks them,
   failing with `ready` and `probes.readyLost`. Boot time is unchanged:
   overlapping the first boots with the build (both devices at once, run
   39215981748, or one after the other, run 39221955387) left the first
   device's scenes starved (the first scene took 6-9 min, then it timed
   out), so a device never boots alongside another or the build.

   **One device per job** (bd med-y5xx.12): `visual` is a two-entry matrix
   (`width` 390 / 440, `fail-fast: false`, a concurrency group per width so
   the two never cancel each other), each building, booting and shooting its
   own device and uploading `ios-visual-<width>` (1-day retention). The
   Linux job `visual-merge` downloads both into `shots/`, runs the compare
   step once and uploads the single `ios-visual` artifact with the same
   `<device>/<scene>.png|json` + `compare/` layout. It also runs when a
   device job failed (the other device's shots still count), not when a
   newer run cancelled this one.

### Scenes (MVP, 15)

`tests/visual/scenes.json` is the source of truth. Steps are the driver's
unless marked *native*. Every scene starts from a fresh launch of the seeded
vault, so order does not matter and one failure does not poison the rest.

| # | Scene | Steps | Why |
|---|---|---|---|
| 1 | `native-firstrun` | *native*: launch with no args on a fresh install, screenshot | SwiftUI invite screen, Only-on-this-device button, disclaimer footer at small heights |
| 2 | `native-local-intro` | *native*: tap "Only on this device", screenshot | long ScrollView with the lock toggle |
| 3 | `today` | `switchTab('today')` | hero, next-up, vitals strip, tab bar over the home indicator |
| 4 | `food-log` | `switchTab('food')` | daynav, macros card, meal rows |
| 5 | `food-add-sheet` | 4 + click `#add-food-inline-btn` | sheet at rest: header, width, corners |
| 6 | `food-add-sheet-keyboard` | 5 + *native*: tap `#food-add-search`, type the fixture product's first letters, wait for keyboard | the `med-pe9g` bug: zoom, header, list under the keyboard |
| 7 | `food-add-sheet-keyboard-empty` | 6 + *native*: clear the field | the third `med-pe9g` screenshot (sheet vanished) |
| 8 | `meds-schedule` | `switchTab('meds')`, sub-tab `schedule` | schedule rows, time chips |
| 9 | `workouts-plans` | `switchTab('workouts')`, sub-tab `groups` | plan cards, rotation rows ("scaling on workout pages") |
| 10 | `workouts-stats` | sub-tab `stats` | `wg-workout-chart` canvas width in a narrow view |
| 11 | `workout-session-log` | open the fixture's session from History + *native*: tap a set's Reps cell | the set prompt's numeric input + the real numeric keyboard |
| 12 | `health-bp` | `switchTab('bp')` | `wg-bp-chart`, range chips, reading list |
| 13 | `health-vitals` | `switchTab('health')` | sleep/steps charts stacked |
| 14 | `settings-home` | `switchTab('settings')` | grouped rows, pagebar back |
| 15 | `settings-backup` | 14 + `openSettingsPage('backup')` | file inputs, long copy, local-only rows |

Phase 2 adds (bd med-y5xx.8): `weight`, `meds-schedule-take` (Schedule with
the take-dose sheet open; was `meds-history-take` until bd med-wi09.3 retired
History for `meds-timeline`), `meds-timeline-pending` (edits yesterday's
taken dose to Not taken through the MT3 sheet, so that day lists it with its
own Take / Skip) and `meds-timeline-bulk-undo` (the MT4 bulk pair needs 2+
listed pending doses on a day; the golden fixture has one dose a day, so the
driver's seed adds a pending 09:00 to the day two back, next to the fixture's
undone dose — bd med-ry7b.4 — and the scene taps that day's "Mark all taken",
with the undo toast; the write stays, so later scenes see that day taken),
`settings-targets-keyboard` (number fields at
15px with the keyboard — focus-zoom regression check),
`settings-ai-key-keyboard` (the BYOK key form), `settings-erase-confirm` (the
in-page `safeConfirm` dialog; the phrase is never typed) and `journey`
(turns gamification on, so it runs last). Landscape is out (portrait-only
app). `today-snoozed` (bd med-ry7b.7) snoozes the newest due dose for 30
minutes (`snoozePending`), so Today's Next up shows the neutral "Snoozed
until HH:MM" row with a plain Take; it runs before `meds-timeline-done`,
whose `takePending` clears the snooze again.

### Runtime and cost

`macos-26` is billed at 10× Linux. Per run: `brew install xcodegen` ~1 min
(cache the bottle), `xcodebuild test` builds the app + UI test bundle ~4–6
min, simulator boot ~1 min per device, 15 scenes × ~8 s (launch, seed on the
first scene, settle, shot) ≈ 2 min per device, export + compare + upload ~1
min. **≈ 12–16 min per run, ≈ $1–1.5** at list price. Hence opt-in only; the
nightly master run is the one unconditional spend (~$40/month).

### Flake risks and mitigations

- **Software keyboard does not show** (hardware keyboard connected): the
  `defaults write` above, plus `app.keyboards.firstMatch.waitForExistence(5)`
  and a probe `keyboardShown` so a keyboard scene without a keyboard is a
  reported failure, not a silent wrong screenshot.
- **First launch slow / seed still running**: the ready node is published only
  after the seed's `datastore:changed` settles; XCUITest waits up to 30 s.
- **Time-dependent text** ("Now" chip, relative days, status bar): status bar
  is overridden; in-page time is left as diff noise in MVP (threshold
  `changedRatio > 0.5 %` to flag), Phase 2 freezes `Date` from the driver.
- **Simulator boot hangs** on the runner: `simctl bootstatus -b` with a
  timeout; `timeout-minutes: 40` on the job; `cancel-in-progress` already set.
- **Accessibility ids drift**: the driver uses app entry points, not CSS
  paths, and the only selectors XCUITest needs are the search field and the
  set-row input; scenes.json carries them in one place.
- **xcresult format changes** across Xcode: `xcresulttool export attachments`
  is the Xcode 16+ API; pin by asserting the export produced ≥ 1 PNG.

## Tier 1: Playwright WebKit on Linux (implemented, bd med-y5xx.6)

- `tests/visual/playwright/run.mjs` (`playwright@1.56.0`, as `e2e/`) runs in
  `.github/workflows/visual-web.yml` on `ubuntu-latest` inside the
  `mcr.microsoft.com/playwright:v1.56.0-noble` image (WebKit preinstalled).
  Runs on PR label `ios-visual`, `workflow_dispatch`
  (`gh workflow run visual-web.yml --ref <branch>`), and on any PR touching
  `web/static/css/**`, `web/static/js/components/**`, `web/cloud/**`,
  `tests/visual/**` or the workflow (a `gate` job checks the diff).
- Two jobs (bd med-y5xx.10). `local`: the QA bundle below, in WebKit
  (`iphone-390`, `iphone-440`) and Chromium (`desktop-1280` at 1280×800,
  `pixel-7`), artifact `ios-visual-web`. `cloud`: `run.mjs <out> cloud` with
  `CLOUD_BIN` starts the real `cmd/cloud` (`CLOUD_BASE_DOMAIN=localhost`, temp
  DB, random `SESSION_SECRET`, no external services), mints an invite per
  device with `cloud admin invite`, signs up through the real claim wizard
  with Chromium's CDP virtual authenticator (PRF, resident key, UV), and runs
  the same scenes at `http://<sub>.localhost:<port>/?qa=<scene>` (cloud
  apishim, server CSP) as `cloud-desktop-1280` / `cloud-pixel-7`, artifact
  `visual-web-cloud`. The cloud never serves the driver: it is injected with
  `addInitScript` together with `window.__wgQAFiles` (scenes + golden vault,
  in place of `/qa/*`) and `window.__wgQACloud` (lets the driver seed a
  non-local, still-empty vault through Settings → Backup's import). One page
  per device so the per-page virtual authenticator outlives the scenes.
- A built-in static server over the `QA=1` bundle (`ios/LocalApp`) with the
  routing and MIME table of `LocalOrigin.file(for:)` / `mime()` (`/` →
  `index.html`, `/static/*`, `/domain/*`, else `cloud/*`, so `/qa/*` →
  `cloud/qa/`) and the shell's CSP with no BYOK hosts.
- An `addInitScript` stub for `window.webkit.messageHandlers.wgNative.postMessage`
  (`ping` → `pong`, `setEgressHosts` → `{changed:false}`, `notifications.*` →
  ok/`granted`, `local.*` → ok, `health.*` / `attest.*` / the rest →
  `unsupported`), so `native/index.js` picks the `ios` platform and the page
  takes the shell's code paths, including `noFocusZoom`.
- Devices: the `iPhone 13` descriptor (mobile, touch, iOS UA, DPR 3) at
  390×844 and 440×956, dark `colorScheme`, `reducedMotion: 'reduce'` (chart
  draw-ins settle, so shots are deterministic). One browser context per device: the
  first scene seeds the vault (the driver imports and reloads), later scenes
  open on the seeded store. Per scene: `/?qa=<scene>`, wait for
  `#wg-qa-ready`, a web stand-in for the scene's `native` steps (`tap` →
  click, `type` → typed text, `clear` → empty the field; `keyboard` is a
  no-op), then `<device>/<scene>.png` (viewport), `<scene>.full.png` (full
  page) and `<scene>.json` (the probe report plus console errors).
  Native-only scenes (`native-*`: SwiftUI screens) are skipped and listed as
  such in the summary.
- Artifact `ios-visual-web` (`<device>/…`, `summary.md`, `summary.json`), the
  summary table in the job summary, probe failures as `::warning`. The job
  fails only when no screenshot was produced. Linux WebKit renders with
  different fonts, so its images are never diffed against tier 2.
- **What this tier cannot catch:** iOS focus-zoom on sub-16px inputs, the
  software keyboard and the `visualViewport` shrink / pan it causes
  (`keyboardShown` and `focusUnderKeyboard` stay false here), safe-area
  insets and the shell's native bands, rubber-band scrolling, WKWebView-only
  behaviour and iOS fonts. `med-pe9g` (focus-zoom under the keyboard) would
  **not** have been caught. It catches horizontal overflow, clipped headers,
  chart widths, stacking and empty states at iPhone widths in a few Linux
  minutes.

## Tier 0: static iOS-hazard lint (follow-up, P2)

`web/static/js/tests/architecture.ios-hazards.test.js`, same shape as the
other architecture tests (scan `web/static/css`, `web/cloud/css`,
`web/static/index.html`), no allowlist unless a rule needs one:

- no `100vh` / `100svh` in sheet and overlay rules (use `100dvh` with the
  visual-viewport dock), reported with file:line;
- `position: fixed` + `bottom: 0` only together with
  `env(safe-area-inset-bottom)` in the same rule or its token;
- the viewport meta never carries `user-scalable=no` or `maximum-scale` in
  markup (the iOS-only cap is applied at runtime by `noFocusZoom`);
- input selectors (`input`, `select`, `textarea`, `.wg-input*`) whose
  resolved `font-size` token is under 16px get a comment pointing at
  `noFocusZoom` — informational, since the runtime cap makes it safe.

## The review step: from PNGs to beads

Automated probes cover the measurable half. The other half is an agent reading
the images. A **visual QA pass** is a reviewer agent (opus-class is enough;
it reads images) with this checklist, applied to every scene × device:

1. Header or app bar clipped at the top, or sitting under the status bar.
2. Any horizontal scroll or a row whose right edge is cut (chips, chart
   legends, long med names).
3. Content under the keyboard or under the home-indicator band; the tab bar
   overlapping content; a sheet's primary button hidden behind the keyboard.
4. Page wider than the screen (zoomed): the sheet's side margins disappear.
5. Chart canvas wider than its card, axis labels overlapping, legend wrapping
   onto the plot.
6. Text truncated mid-word, two-line labels in single-line chips.
7. Touch targets visibly under 44pt (tiny close buttons, chevrons).
8. Sheet taller than the screen with no visible scroll affordance.
9. Dialog or toast off-screen or behind the keyboard.
10. Empty state where the seeded fixture should have shown data (a seeding or
    routing bug, not a layout bug — file it anyway).

Each finding becomes a bead: `bd create "<scene> on <device>: <symptom>"
--type bug --labels ios,visual --parent <epic> -p 2` with the artifact path,
run URL and the scene name in the description, and the PNG saved under the
scratchpad like the `med-pe9g` shots. Group by root cause, not by scene:
the three `med-pe9g` screenshots were one bead.

## How the orchestrator uses it

- **Get a matrix for a branch:** `gh workflow run ios.yml --ref <branch> -f
  visual=true`, then `gh run watch <id>` (or `gh run list --workflow ios.yml
  --branch <branch>`), then `gh run download <id> -n ios-visual -D
  <scratchpad>/ios-visual/<id>`. Read `summary.md` first (probe failures and
  the biggest diffs), then the PNGs.
- **On a PR:** add the `ios-visual` label; the artifact lands on the PR's
  run and the job summary shows the table. The job never blocks merge.
- **Developer verification of an iOS layout fix** (replaces "ask the owner
  for a TestFlight round"): label the PR, wait for green, download, read the
  scene(s) the bead names and their master diffs, attach the before/after
  PNGs to the PR description. Only then does the orchestrator consider the
  bead done; the owner's phone is asked for only if the fix touches something
  in the list below.
- **Nightly master run** gives the reviewer agent a standing matrix to audit
  (a `/orchestrate` grooming task: "run the visual QA pass on last night's
  artifact and file what you see").

### What still needs the owner's device

- Face ID / Touch ID for the local lock (the Simulator can enrol a face, but
  only from the Simulator app's menu, not from `simctl`).
- App Attest / DeviceCheck (no Simulator support — the anonymous trial path).
- Push: no APNs delivery to a Simulator; `simctl push` only injects a payload.
  Local notifications **do** work in the Simulator and are covered.
- Camera and microphone (barcode scan, meal photo, voice): no capture device.
- Apple Watch data in HealthKit (manual Health entries work in the Simulator;
  the Watch-sourced sleep and workout overlap rules do not).
- Share sheet into real Files/iCloud, iCloud backup → restore, storage
  eviction, TestFlight update-in-place, third-party keyboards, real device
  performance.

## Staging

- **MVP (filed as P1):** QA driver + fixture seeding; shell hooks + UI test
  target; the `visual` job with two devices and the artifact; the compare
  step; the runbook + checklist in `docs/`.
- **Phase 2 (P2):** Playwright WebKit tier; static hazard lint; frozen in-page
  clock and masked regions for quieter diffs; the extra scenes.
- **Phase 3 (P3):** the same driver on the Android shell with
  `reactivecircus/android-emulator-runner` on ubuntu (cheap); Dynamic Type /
  larger text axis if the owner wants it.
  The Android tier exists: `android-qa.yml -f scenario=local-visual` (bd med-nt9p.32.6,
  [android.md → Local-mode scenarios](../android.md#local-mode-scenarios-bd-med-nt9p326)).
  It uploads the `android-visual` artifact and compares it with master's latest
  dispatch, as the iOS tiers do (bd med-y5xx.9). Dispatch only, no PR label yet.

## Decisions for the owner

1. **Spend:** opt-in (label / dispatch) plus one nightly master run, ≈ $1–1.5
   per run on `macos-26`. Alternative: no nightly, agents dispatch on demand.
2. **Reference images:** compare against master's latest artifact (no files in
   git, 90-day retention) — recommended — or commit goldens (git LFS, needs a
   policy for updating them on every intended UI change).
3. **Debug-only QA hooks in the shell** (`#if DEBUG` launch argument and
   `isInspectable`): acceptable, given the TestFlight archive is Release and
   never carries them?
4. **Your phone's width:** add the iOS 18 runtime to the runner (+3–5 min and
   a multi-GB download per run, or a cached install) to simulate an iPhone
   11-class 414pt screen, or accept 390pt + 440pt as the bracket.
5. **Gate or evidence:** the job stays green on probe failures and diffs (MVP).
   Should probe failures (`scale ≠ 1`, horizontal overflow) fail the job once
   the baseline is clean?

### Defaults taken (2026-10-19)

Defaulted by the orchestrator while the owner was away; the owner may revisit
any of them.

1. **Spend:** opt-in only — PR label `ios-visual` plus `workflow_dispatch`.
   The nightly master run is deferred.
2. **Reference images:** master's latest `ios-visual` artifact; no goldens in git.
3. **Debug-only QA hooks:** acceptable (`#if DEBUG` launch argument and
   `isInspectable`; the Release archive never carries them).
4. **Devices:** 390pt (`iPhone 16e`) + 440pt (`iPhone 17 Pro Max`) on the
   runner's default runtime; the iOS 18 runtime (414pt) is deferred.
5. **Gate or evidence:** evidence only — probe failures and diffs never fail
   the job in the MVP.

### Qualification (2026-10-31)

The 2026-10-19 defaults above record the historical MVP decision. The
[current visual runbook](../ios-visual-testing.md) distinguishes ordinary
full runs, which remain evidence-only, from explicit `visual_scenes`
dispatches, which fail on XCTest/probe failure (introduced by med-y5xx.17).
Native filtered runs validate every requested name before any scene activity;
unknown, ineligible or blank entries reject the complete request. Image diffs
remain informational in both modes.
