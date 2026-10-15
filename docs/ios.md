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
  chain that holds one by recomputing the whole EMA exactly as a vault restore
  does, so the trend shown matches the trend after a restore (a manual-only
  history keeps its stored trends).
- **Known residuals:** a backup restored and re-exported by a client that
  predates the `-hk-` tombstones loses them (it skips the unknown tombstone
  types), so a later full Health rescan brings deleted readings back. A client
  that predates this change sees Health weights without a trend and seeds a
  new entry's trend from the raw weight. Neither can be fixed from this side.
- **Not in v1:** deleting a sample in Health does not delete it here. Sleep and
  workouts are med-w6gx.7.
- **Signing:** automatic signing enabled the *HealthKit* capability on the App
  ID by itself. Upload validation demands `NSHealthUpdateUsageDescription` even
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
