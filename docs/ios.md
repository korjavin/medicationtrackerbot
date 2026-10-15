# iOS app — CI build and TestFlight

The iOS app (epic `med-w6gx`) is a thin Swift WKWebView shell in `ios/`. It is
**never built locally**: every build, signing and TestFlight upload runs on a
GitHub-hosted macOS runner via [`.github/workflows/ios.yml`](../.github/workflows/ios.yml).

- `ios/project.yml` is an [XcodeGen](https://github.com/yonaskolb/XcodeGen) spec;
  the runner generates the `.xcodeproj` from it. Nothing generated is committed.
- **Triggers:** PRs/pushes touching `ios/**` or `ios.yml` run an unsigned
  simulator build only. `workflow_dispatch` (any branch) also archives, signs
  and uploads to TestFlight. Web/Go changes never start it (macOS minutes cost
  ~10x Linux).
- `deploy.yml` ignores `ios/**` and `ios.yml`, so an iOS-only merge does not
  redeploy production.
- Build number = the workflow run number, so every upload is unique.

## Owner setup (GitHub → Settings → Secrets and variables → Actions)

Until **all** of these exist, a dispatch logs a notice naming what is missing,
skips the upload and stays green.

**Variables** (not secret):

| Name | Value |
|------|-------|
| `IOS_BUNDLE_ID` | the App ID of the App Store Connect app record |
| `IOS_TEAM_ID` | Apple Developer Team ID (10 chars, Membership page) |
| `CLOUD_BASE_DOMAIN` | already set for deploy verification; the app accepts accounts at `<sub>.<it>` |

**Secrets:**

| Name | How to get it |
|------|---------------|
| `IOS_DIST_CERT_P12_BASE64` | Apple Distribution certificate + private key exported from Keychain Access as `.p12`, then `base64 -i dist.p12 \| pbcopy` |
| `IOS_DIST_CERT_PASSWORD` | the password set on that `.p12` export |
| `IOS_APPSTORE_PROFILE_BASE64` | developer portal → Profiles → **+** → *App Store Connect* → the App ID → that Apple Distribution certificate → download, then `base64 -i <name>.mobileprovision \| pbcopy` |
| `ASC_KEY_ID` | App Store Connect → Users and Access → Integrations → Team Keys: create a key (App Manager is enough — it only uploads); its Key ID |
| `ASC_ISSUER_ID` | the Issuer ID shown above that key list |
| `ASC_KEY_P8_BASE64` | the downloaded `AuthKey_<id>.p8`, `base64 -i AuthKey_<id>.p8 \| pbcopy` |

Signing is **manual** (bd med-w6gx.12): the archive runs with
`CODE_SIGN_STYLE=Manual`, the `Apple Distribution` identity from the `.p12` and
the App Store profile from the secret, and gets no Apple account at all; the
export is manual too (`ios/ExportOptions.plist`) and uses the API key only to
upload. So CI never creates a certificate or a profile. (Automatic signing on
an ephemeral runner minted a fresh *Apple Development* certificate on every
run until the account hit its certificate limit.) The profile and the
certificate expire after a year: renew both, then update the secrets. A new
capability on the App ID (e.g. HealthKit) invalidates the profile — re-generate
it (Profiles → the profile → Edit → Save) and update the secret. Signing
material goes into a throwaway keychain on the runner and is deleted at the
end of the job. Secrets are bound only to the dispatch-gated signing steps, never
job-wide, so PR and push builds cannot read them. Optional hardening: move them
into a GitHub environment with required reviewers.

### Cleaning up leaked certificates (once)

Earlier runs each left an *Apple Development* certificate behind. Developer
portal → Certificates: revoke every **Apple Development** certificate created
by CI (one per dispatched run, created on those run dates, by the API key
rather than by you); keep the **Apple Distribution** certificate in
`IOS_DIST_CERT_P12_BASE64` and any development certificate of your own Mac.
Revoking a development certificate does not affect TestFlight or App Store
builds. Then create the App Store profile above and add
`IOS_APPSTORE_PROFILE_BASE64`.

## Shipping a build

Actions → **iOS** → Run workflow → pick the branch. When the run is green the
build appears in App Store Connect → TestFlight after Apple's processing
(minutes); install it on the device through the TestFlight app.

## Downloads and printing (bd med-w6gx.11)

WKWebView ignores `<a download>` and `window.print()` on its own. The
`Downloads` class in [`ios/App/App.swift`](../ios/App/App.swift) saves every
download (blob:/data: links, `Content-Disposition: attachment`) to a temp file,
opens the share sheet (Save to Files), and deletes the file when the sheet
closes (a file left by a killed app is swept at the next launch). A page script sends `window.print()`, and the offscreen-iframe print in
`web/cloud/js/print-doc.js`, to the iOS print sheet. No web code changes.

## Apple Health import (bd med-w6gx.6)

Read-only: Health → the page → the encrypted vault, like a hand-entered reading;
the app never writes to Health and nothing new leaves the device (no privacy
manifest entry: there is no egress).

- **Native:** [`ios/App/Health.swift`](../ios/App/Health.swift) answers
  `health.authorize` and `health.query` (anchored queries, raw samples) over the
  `wgNative` bridge; `window.Health` on iOS is
  [`native/health.js`](../web/static/js/native/health.js).
- **Mapping:** [`web/domain/healthimport.js`](../web/domain/healthimport.js)
  writes the existing `bp` / `weight` record shapes plus optional
  `source: "apple_health"` and `source_id` (older clients ignore both). recordId =
  `bp-hk-<uuid>` / `weight-hk-<uuid>` from the HealthKit sample, written at the
  LWW floor (`putIfAbsent`, `clientTs: 0`), so re-imports and a second iPhone
  never duplicate, overwrite an edit or resurrect a delete.
- **Runner + Settings row:**
  [`web/cloud/js/health-import.js`](../web/cloud/js/health-import.js), loaded by
  `cloud-boot.js` only when `window.Health.isSupported()` (never on the web).
  Settings → *Apple Health* toggle asks for read access, then imports at unlock
  and on every return to the foreground (no background delivery in v1). Toggle,
  anchors and "last imported" are device-local (`localStorage`).
  An anchor is kept only after a page that returned something, so history
  hidden while access was denied is still read once it is granted; switching
  the toggle on again rescans from the start.
  A vault backup keeps the `-hk-` ids (`source_id`) and their tombstones, and
  the importer also recognises a reading by `source_id` (an older client's
  restore re-mints ids), so neither a restore nor a rescan duplicates or
  resurrects; deleting such a re-minted reading also tombstones its `-hk-` id
  ([`healthsource.js`](../web/domain/healthsource.js)). A derived weight stores
  no `weight_trend`, so every device writes the same body; `weight.js` reads a
  history that holds a Health row by recomputing the whole EMA in time order,
  and restore keeps Health rows trend-less, so the trend shown matches the
  trend after a restore. A history without Health rows
  reads exactly as stored.
- **Known residuals:** a backup restored and re-exported by a client that
  predates the `-hk-` tombstones loses them (it skips the unknown tombstone
  types), so a later full Health rescan brings deleted readings back. A client
  that predates this change sees Health weights without a trend and seeds a
  new entry's trend from the raw weight. Neither can be fixed from this side.
- **Not in v1:** deleting a sample in Health does not delete it here.

### Sleep and workouts (bd med-w6gx.7)

Same toggle, same anchored queries. A build that switched the toggle on for BP
and weight only asks once, at the next open, for the new types.

- **Sleep** → the existing `sleep` record (Vitals), **one per sleep day**.
  `Health.swift` answers a sleep page with *every* sleep sample (all sources)
  from 48h before the page's earliest new sample to 48h after its latest, plus
  that window; `healthimport.js` groups them into nights per source (gaps ≤ 1h,
  *In Bed* ignored), keeps only nights whole inside the window, and maps
  Core/Deep/REM/Awake to light/deep/rem/awake minutes (`total_minutes` = asleep
  time). Overlapping samples of one night count each minute once, as the
  highest of deep > REM > core > awake > unspecified, so the minutes never
  exceed the night's span.
  - A **sleep day** runs 18:00–18:00 local by when a night *ends*: the night
    ending at 07:00 and a nap at 15:00 are that date's; it is the record's
    `day` (the wake day for a normal night). Local = the samples' own zone
    (HealthKit's `HKTimeZone`), else **UTC** — never the iPhone's zone.
  - recordId `sleep-hk-<day>` (`source_id` = the day). The record holds every
    night and nap of that day from **one source** — the one with the most
    asleep minutes — with `start_time`/`end_time` spanning them. Naps are
    therefore merged into the day's record rather than kept as sessions.
  - Written once, `putIfAbsent` at `clientTs: 0` like every other import
    (CLAUDE.md rule 12): the **first settled version of a day wins**, an edit
    always outranks it, and a deleted day stays deleted (its tombstone also
    rides in vault backups). Manual and Mi Band entries live under other ids.
- **Settling:** a sleep day is written only once its last sample ended **3h**
  ago (`SLEEP_SETTLE_MS`), so a night still being written is not frozen as a
  fragment. A night still settling when its samples were read leaves its
  start in `wg.health.sleepPending` (saved before the anchor moves past it);
  every later run first re-reads sleep by time window (`health.query {type:
  "sleep", from: start − 48h, to: now}`, no anchor), until nothing is left
  settling.
- **Workouts** → the existing `miband` activity record (Workouts → History,
  labelled *Apple Health*): type name, start/end, duration, distance, active
  energy, average heart rate. recordId `miband-hk-<uuid>`, body `id` from the
  UUID. A Health workout **never** creates or edits a strength session, set,
  rotation or progression (docs/workout-depth.md) — it is a history row only.
- **Overlap rule:**
  - an entry already in the vault wins — a Mi Band night or ride, a manual
    entry, or (workouts) one imported earlier from another Health source — and
    the Health copy that overlaps it in time is skipped;
  - among new overlapping Health workouts (Watch + a third-party app writing
    the same run), the longest wins, ties to the smaller UUID, so every iPhone
    picks the same one; Health sleep sources compete per sleep day, as above;
  - a Health *strength* workout (traditional / functional strength training)
    that overlaps an in-app workout session is skipped: the per-set log is the
    record of that visit. Other Health workouts during a session (a treadmill
    run) are kept;
  - a deleted Health workout stays deleted: a rescan does not bring it back.
- **Known residuals:** the rule is applied once, against what this iPhone has
  synced at that moment — an entry that arrives later (a Mi Band `.nxk` import
  of a night already imported from Health) does not displace the Health copy,
  so that night counts twice until one is removed (sleep has no delete in the
  app yet), and a skipped Health entry stays skipped after the entry that beat
  it is deleted, until the toggle is switched off and on (a rescan). A night
  whose samples carry no time zone takes its sleep day in UTC; for a morning
  wake-up that is the local date nearly everywhere, but a zone-less and a
  zoned source can file one night on different days (and so show it twice)
  for wake-ups before ~05:00 east of UTC+10 or after ~10:00 west of UTC−8.
  The first settled version of a sleep day wins: if a device writes a day
  while its Health copy is still incomplete (Health sync lag across devices
  beyond the 3h settle), a later fuller version is not applied. Deleting the
  day does not re-import it — the tombstone keeps it deleted (the safe
  direction). A backup restored and re-exported by a client that predates the
  `miband-hk-` / `sleep-hk-` tombstones loses them, as for BP and weight
  above, so a later rescan brings a deleted Health workout or night back.
  A deleted Health workout leaves only a bodyless tombstone, so another
  source's copy of it (Strava writing the same run later, or a rescan that
  reads the copy on a different page) can still appear and needs deleting too.
  A sleep page reads every sleep sample from 48h before the page's earliest
  new sample to 48h after its latest, so a page of out-of-order backfill can
  read a long stretch of history at once (slow, not wrong).

### Device check — sleep and workouts (TestFlight)

1. Wear an Apple Watch for a night (or add a sleep sample in Health), record a
   Watch workout, and a strength workout during an in-app session.
2. Open the app (the Health sheet now also lists Sleep, Workouts, Heart Rate,
   Active Energy and distances) → allow → once 3h have passed since waking
   (reopen then), the night shows in Vitals on its wake day with its stages; the workout shows in Workouts → History as *Apple
   Health*; the strength workout during the session does not.
3. Kill/reopen and toggle off/on: no duplicates. Delete the imported workout,
   toggle off/on: it stays deleted.
4. A Mi Band ride already in the app at the same time as a Health ride: only
   the Mi Band one shows.
5. A web browser on the same account shows the same night and workout.
- **Signing:** an earlier automatic-signing run enabled the *HealthKit*
  capability on the App ID. Signing is now manual, so the App Store profile in
  `IOS_APPSTORE_PROFILE_BASE64` must be generated (or re-saved) after that, or
  the archive fails on the HealthKit entitlement. Upload validation demands `NSHealthUpdateUsageDescription` even
  for a read-only app, so `project.yml` carries one saying the app never writes.

### Device check (TestFlight)

1. Health app: add a blood-pressure reading and a weight.
2. App → Settings → Apple Health on → the Health sheet lists Blood Pressure
   (systolic, diastolic) and Weight → allow → both readings appear in BP and
   Weight once, at their Health time.
3. Kill and reopen, and background/foreground: no duplicates; a new Health
   reading appears after returning to the app.
4. Edit one imported reading and delete another in the app, then toggle off/on:
   the edit stays, the deleted one does not come back.
5. iPhone Settings → Health → Data Access & Devices → Med Tracker → turn all
   off → add a Health reading → reopen: nothing new, no error; the row says
   where to check access if nothing was ever imported.
6. A web browser on the same account: the imported readings show there too.

## The shell (bd med-w6gx.3)

One WKWebView on the account origin `https://<sub>.<base>/`, exactly like the
PWA — no bundled web code ([`ios/App/Shell.swift`](../ios/App/Shell.swift),
UI in [`ios/App/App.swift`](../ios/App/App.swift)). Nothing outside `ios/`
changes for it.

- **First run** (invite-only, no signup): paste an invite/claim link, a device
  hand-off link or the account address, or scan a QR — the `cloud admin
  invite` QR or the Emergency Kit QR (only its first line, the account URL, is
  read; the recovery code is never touched).
  [`AccountURL.swift`](../ios/App/AccountURL.swift) accepts only `https` hosts
  exactly one label under `CLOUD_BASE_DOMAIN`; CI runs its check
  (`ios/Tests/main.swift`). The app stores the account **host** only, never
  the claim fragment, and opens `https://<host>/` on every later launch.
- **Navigation:** the account host and the base domain load in the app; every
  other link (and `mailto:`/`tel:`) opens in Safari or its own app.
- **Offline:** a cold start offline is answered by the Service Worker; a native
  "Can't open your account" screen (Try again / Switch account) appears only
  when the very first load fails with nothing cached, or the host answers an
  HTTP error (a mistyped or deleted account is a 404). Try again keeps an
  invite link's `#claim=` fragment (in memory only).
- **Switch account:** iOS Settings → Med Tracker → *Switch account*, then return
  to the app; also on the load-error screen. Website data is per origin and is
  kept, so switching back still finds offline data and warm unlock.
- **Chrome:** the page sits inside the safe area; the status-bar and
  home-indicator bands take the page's own background colour at its top and
  bottom edge (a page script reports it), the status bar is light, and the page
  does not rubber-band past its edges.
- **Storage:** the same page script calls `navigator.storage.persist()` — the
  spike saw `persisted: false`, so WebKit may evict website data under storage
  pressure; the vault re-syncs from the server, unsynced offline writes are
  what eviction would lose.
- **No install prompts:** the web app's "Add to Home Screen" steps do not show
  inside the app (bridge below).

### The native bridge (bd med-w6gx.4)

The shell registers a `wgNative` `WKScriptMessageHandlerWithReply`; its presence
makes `web/static/js/native/index.js` pick the `ios` platform, so
`window.LocalNotifications` / `window.Health` report supported (they report
unsupported on the web). `__native.call(op, args)` posts `{op, args}` and
resolves with the Swift reply; only the account host's main frame is answered.
Ops: `ping` → `"pong"`; `notifications.*` (below); HealthKit ops come with med-w6gx.6.
Details: [docs/frontend.md → Device-Capability Abstractions](frontend.md#device-capability-abstractions).

### Reminders as local notifications (bd med-w6gx.5)

WKWebView has no Web Push. Whenever the web app computes the reminder horizon
([architecture.md §5](architecture.md#5-reminders)) — every unlock, every return
to the app (the page stays alive across app switches), every
reminder-affecting edit, every inbox drain — `recomputeAndPush`
(`web/cloud/js/reminders.js`) also hands it to `window.LocalNotifications`,
which `ios/App/Notifications.swift` schedules with `UNUserNotificationCenter`,
replace-all. iOS keeps at most 64 pending: the earliest 63 reminders plus an
"Open the app to keep reminders running" notice a minute after the last, the
device-side twin of the relay's dry-queue warning. No server change, no APNs;
it works offline. The relay upload is unchanged (Telegram, other devices);
Telegram-only delivery schedules nothing on the phone, and the app never makes
a Web Push subscription.

- **Permission:** Settings → Notifications → Enable asks iOS (once); Disable
  points to iOS Settings, since an app cannot revoke its own permission.
  Send test posts a local notification a second later.
- **Tap:** opens the reminder's section (meds, bp, weight, workouts, else
  today): `switchTab` on the open app, `/?tab=<section>` on a cold start.
- **Not in v1:** Confirm/Snooze buttons on the notification; a cold start onto
  a locked vault lands on Today after unlock (`/unlock` drops the query).

### Device check (TestFlight)

1. Fresh install → first-run. Paste a claim link from `cloud admin invite`
   (test account) → claim with Face ID → unlocked app.
2. Kill and reopen → back on the account, warm unlock without a prompt.
3. Airplane mode, kill, reopen → the app renders from the Service Worker.
4. Tap an external link (e.g. a Telegram link) → Safari opens; the app stays put.
5. No white bands at the top/bottom or when dragging past the page edge; the
   header does not scroll behind the status bar or an open sheet.
6. Settings → Med Tracker → Switch account on → back in the app: first-run.
   Scan the Emergency Kit QR → the same account opens.
7. Claiming in the app goes from the Emergency Kit (and Telegram, when
   offered) straight into the app: no "Add to your Home Screen" step.
8. Settings → Notifications → Enable → iOS asks → Allow; Send test → a
   notification arrives within seconds, also with the app open.
9. Add a med due in ~3 minutes, kill the app, airplane mode → the reminder
   fires; tapping it opens Meds.
10. Edit that med's time → only the new time fires (pending notifications are
    replaced).

## Spike: passkey PRF, Service Worker, IndexedDB in WKWebView (bd med-w6gx.2)

The GO/NO-GO gate for the remote-origin design. Its throwaway diagnostic panel
was removed by the shell bead; what the build sets up stays (all in
[`ios/project.yml`](../ios/project.yml)):

- **Associated Domains** `webcredentials:*.<base>` — passkeys for every
  account subdomain, confirmed by the server's AASA route (med-w6gx.1).
- **`WKAppBoundDomains`** `<base>` and `*.<base>`, with
  `limitsNavigationsToAppBoundDomains = true` — the precondition for Service
  Workers in WKWebView. A host outside the list fails to load with a
  `WKErrorDomain` "app-bound" error.
- `NSCameraUsageDescription` and inline media playback (camera via
  `getUserMedia`).

Production must serve the AASA: set `IOS_TEAM_ID` / `IOS_BUNDLE_ID` in the
cloud env (docs/environment.md) and check that
`https://<base>/.well-known/apple-app-site-association` and the same path on an
account subdomain return `{"webcredentials":{"apps":["<TEAM>.<bundle>"]}}`.
Apple fetches it through its CDN
(`https://app-site-association.cdn-apple.com/a/v1/<host>`), which can lag by
hours after the first deploy. If an archive fails on the Associated Domains
entitlement, enable *Associated Domains* on the App ID (developer portal →
Identifiers), then re-generate the App Store profile and update
`IOS_APPSTORE_PROFILE_BASE64` (signing is manual, see Owner setup).

### Findings

**GO** — device run 2026-10-14/15, iPhone on iOS 18.7, TestFlight builds 10
and 15, against a dedicated test account.

| # | Check | Result |
|---|-------|--------|
| 1 | Passkey create + get on an arbitrary subdomain | Claim of a fresh invite in the app on a subdomain no build named: `webauthn.create ok`, `webauthn.get ok`. Probe passkey create/get on it: ok |
| 2 | PRF in WKWebView | `prfFirst: true` on the claim; probe get `prfFirstBytes: 32`; cold unlock in the app of a passkey made in Safari on another subdomain (after resetting web data): `webauthn.get ok, prfFirst: true` |
| 3 | Service Worker + wildcard app-bound domain | worker activated and controlling; offline relaunch renders (`online: false`, `controlled: true`) |
| 4 | IndexedDB + non-extractable key survive kill | marker and non-extractable AES key survive an app kill **and** an app update (10 → 15); warm unlock without a prompt |
| 5 | `getUserMedia` camera | `videoTracks: 1` |
| 6 | JS → Swift reply round trip | `pong` in 0–4 ms |

Gotchas:

- `navigator.storage.persisted()` is `false`: WebView data is evictable under
  storage pressure. The shell requests persistence (above).
- Resetting web data logs a benign `-999` (navigation cancelled).

## Spike: local mode on a custom-scheme origin (bd med-o7zq.1)

The GO/NO-GO gate for iOS local mode (epic `med-o7zq`): is a
`WKURLSchemeHandler` origin in WKWebView a usable app origin on iOS 18? The
med-w6gx.2 results above were on `https` origins and do not carry over.

- **What runs:** [`ios/App/LocalSpike.swift`](../ios/App/LocalSpike.swift)
  opens its own WKWebView (default website data store, app-bound limit on like
  the shell) on `app://local/`, served from the bundled test page
  [`ios/LocalSpike/`](../ios/LocalSpike/) with the CSP as a response header.
  The page ([`js/main.js`](../ios/LocalSpike/js/main.js)) runs every check it
  can decide and shows a PASS/FAIL/MANUAL/INFO table; the native side adds the
  data-directory scan (7, 12) and the bridge's view of the origin (8). No
  private WebKit API, no Service Worker. The shell's normal path never creates
  any of it; it is throwaway and goes with med-o7zq.4.
- **Open it:** iPhone Settings → Med Tracker → *Local mode diagnostic* on →
  back to the app. *Close* (top left) turns it off again. *App-bound* reloads
  without the app-bound limit if the page fails to load with it.
- **Get the report out:** the page's *Share report* (that is check 4) or
  *Copy report*; or the native *Report* button (Copy / share), which also
  carries the page's report when the bridge works. Account host names are
  redacted; only the first 8 characters of the vendor id appear.
- **Build:** Actions → **iOS** → Run workflow on the spike branch (or master
  after merge), then install from TestFlight (see *Shipping a build*).

### Owner run on the device

1. Fresh install of the build (or the update over an existing one) → open the
   diagnostic → wait for "Automatic checks done" → tap *Test camera* (allow) →
   *Share report* (the share sheet must open: check 4) → save the report.
2. **Kill/relaunch (2, 2k):** swipe the app away, reopen, open the diagnostic:
   #2 and #2k turn PASS and list the earlier launch.
3. **Update (2):** dispatch a new build, install it over this one from
   TestFlight, open the diagnostic: #2 lists launches from the older build number.
4. **BYOK (9):** the dummy-key probes run by themselves; for a *successful*
   request paste a real key in the form (it is never stored or reported) →
   *Test with my key* → `HTTP 200`.
5. **Backup → restore (10):** with launches recorded, make an iCloud (or
   encrypted Finder) backup, restore it onto a second iPhone (or erase this one
   and restore), install the app from TestFlight if it is not restored, open the
   diagnostic: #2 must still list the old launches (with the old vendor id).
6. **Eviction (11):** note #11 (persisted, usage), fill the phone until iOS
   warns that storage is almost full (e.g. download large videos), leave it a
   few hours, open the diagnostic: the launch history must still be there. Also
   iPhone Settings → General → iPhone Storage → Med Tracker → *Offload App*,
   reinstall from TestFlight, reopen: same check.
7. Paste the reports (Share or the native Report) into the bead; the table
   below is filled from them.

**GO** needs 1, 2, 2k, 3, 6, 8, 10 PASS and IndexedDB not evicted (11).
A FAIL on 4, 5 or 9 is a feature gap to plan around, not a NO-GO. **NO-GO**
→ back to the architect: the fallback (a loopback HTTP asset server, or native
storage behind the records port) is a separate spike, not improvised.

### Results

Pending a device run — nothing below has been observed yet.

| # | Check | How | Result |
|---|-------|-----|--------|
| 1 | `isSecureContext`, `crypto.subtle` AES-GCM (+ PBKDF2) | auto | pending device run |
| 2 | IndexedDB records survive kill/relaunch and a TestFlight update | auto + steps 2–3 | pending device run |
| 2k | Non-extractable AES key stored in IndexedDB still decrypts | auto + step 2 | pending device run |
| 3 | ES modules: nested static, root-relative `/static/`, `../../domain/`, dynamic `import()`, JS MIME | auto | pending device run |
| 4 | Blob download → share sheet (med-w6gx.11 path) | step 1 | pending device run |
| 5 | `getUserMedia` camera + readable frame (barcode path) | step 1 | pending device run |
| 6 | CSP from the scheme-handler header enforced (inline, eval, connect-src) | auto | pending device run |
| 7 | Where WebKit stores the origin's data; file protection class | auto (native) | pending device run |
| 8 | Native bridge on the custom origin (`frameInfo.securityOrigin`) | auto | pending device run |
| 9 | BYOK fetch + CORS preflight to OpenAI / Anthropic; a successful request | auto + step 4 | pending device run |
| 10 | Real backup → restore keeps IndexedDB | step 5 | pending device run |
| 11 | Eviction under storage pressure / offload; `storage.persisted()` | step 6 | pending device run |
| 12 | `isExcludedFromBackup` settable on the origin's data dir (set, read back, reverted) | auto (native) | pending device run |

**Verdict:** pending device run.
