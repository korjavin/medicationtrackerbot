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

## App Store submission (bd med-w6gx.8)

Everything in the binary is in `ios/`; the store listing is filled in App
Store Connect (ASC) by the owner from this section.

- **Icon:** `ios/App/Assets.xcassets/AppIcon.appiconset/icon.png` is the brand
  icon (`web/static/icons/icon.png`, 1024², no alpha); Xcode derives every
  size from it.
- **Launch screen:** `UILaunchScreen` → `LaunchBackground` colour
  (`--wg-bg-screen`, `#132D29`), so there is no white flash before the dark app.
  No logo: Apple asks for a launch screen that looks like the first screen.
- **Bundle id / team:** the `IOS_BUNDLE_ID` / `IOS_TEAM_ID` repo variables
  (Owner setup above).
- **Usage strings** (`ios/project.yml`):

  | Key | Why |
  |-----|-----|
  | `NSCameraUsageDescription` | barcode scan, meal photos, first-run QR |
  | `NSMicrophoneUsageDescription` | voice assistant, voice notes in feedback |
  | `NSHealthShareUsageDescription` | Apple Health read import |
  | `NSHealthUpdateUsageDescription` | demanded by upload validation; says the app never writes |

  Local notifications need no Info.plist string (iOS asks at runtime). Photo
  picking goes through the system picker, which needs no permission; passkeys
  use the system sheet, so no Face ID string.
- **Privacy manifest:** `ios/App/PrivacyInfo.xcprivacy` — no tracking, the
  `UserDefaults` required-reason API (`CA92.1`, the stored account host), and
  the collected types below. Keep it in step with the label.
- **Encryption export:** `ITSAppUsesNonExemptEncryption: false` — the only
  crypto is the system's (WebCrypto, TLS, passkeys).

### Privacy label (ASC → App Privacy)

Derived from [`web/cloud/js/privacy-manifest.js`](../web/cloud/js/privacy-manifest.js)
plus HealthKit (read-only, into the vault) and local notifications (no data
leaves the device). Conservative: the vault is end-to-end encrypted, but
several opt-in features send a request's plaintext through the operator's
server or to its AI/voice providers, so the types they carry are declared.

- **Tracking:** No. **Data used to track you:** none.
- **Data linked to you**, every one for **App Functionality** only (no
  analytics, no advertising, no product personalisation):

  | ASC type | From (manifest ids) |
  |----------|---------------------|
  | Health & Fitness → Health | `vault` (incl. Apple Health imports), `trial-ai`, `trial-chat`, `trial-voice`, `voice-llm-relay`, `mcp-hosted`, `telegram-relay`, `rxnav` |
  | Health & Fitness → Fitness | `vault`, `nxk-import`, the same AI/voice/MCP rows |
  | Identifiers → User ID | `account-existence` (account subdomain), `telegram-relay` (chat id) |
  | User Content → Photos or Videos | `trial-ai` (meal photos) |
  | User Content → Audio Data | `trial-voice`, `feedback` (voice notes) |
  | User Content → Customer Support | `feedback`, `feedback-telegram` |
  | User Content → Other User Content | `trial-ai` (meal text), `trial-chat`, `food-operator` (search terms) |

- **Not declared:** contact info (no email, name or phone is ever asked),
  location, contacts, browsing history, purchases, diagnostics. Sync IPs and
  timings (`sync-metadata`) are server operations metadata, not used for any
  of Apple's purposes.

A new manifest entry that carries a new kind of data means a new row here and
in `PrivacyInfo.xcprivacy`.

### Listing text

- **Privacy policy URL:** <https://github.com/korjavin/medicationtrackerbot/blob/master/docs/privacy-policy.md>
  ([privacy-policy.md](privacy-policy.md); the first-run screen links it, and
  the signed-in app shows Settings → Account & privacy). Nothing on the cloud
  domain serves a policy: the base domain serves only the landing page and
  the AASA.
- **Support URL:** <https://github.com/korjavin/medicationtrackerbot/issues>.
- **Medical disclaimer** — end of the description, and the first-run footer:

  > Med Tracker is a personal log, not a medical device, and does not give
  > medical advice. Talk to your doctor before changing a treatment.

- **Account deletion** (guideline 5.1.1(v)): in the app, Settings → Account &
  privacy → Delete my account (passkey re-check, then `DELETE /api/account`,
  [`internal/cloudserver/account.go`](../internal/cloudserver/account.go)).
  It is immediate; no web form needed.

### Reviewer access

Accounts are invite-only and unlock only with a passkey bound to the
account's own subdomain, so there is no username/password to hand over.
Two existing paths give a reviewer access on their own device, no new server
code:

1. **Seeded demo account** — the reviewer redeems the demo account's Emergency
   Kit (`/recover`) and creates their own passkey on it, then sees seeded data.
   A redeemed code is **burned**: the app makes the redeemer save a new kit. So
   each review round needs a fresh code, which the owner makes from their own
   passkey on the demo account (Settings → Devices & connectors → Emergency
   Kit).
2. **Fresh account** — an unclaimed invite link (Settings → Devices &
   connectors → Invite a friend, or `cloud admin invite`); claiming it creates
   the reviewer's own empty account. Valid `CLOUD_CLAIM_TTL` days (default 14);
   `cloud admin reset-claim <sub>` re-issues an expired, unclaimed one. This is
   the one to test **account deletion** on, so the demo account survives.

Both need iCloud Keychain on the review device (passkeys).

**Preparing the demo account (owner, before each submission):**

1. Create an invite, claim it on your own device (this passkey is how you
   regenerate the kit later), save the Emergency Kit.
2. Seed it: Settings → Backup & import → import
   [`tests/fixtures/vault-v1.json`](../tests/fixtures/vault-v1.json) (every
   domain, mid-2026 dates), then log a few entries for today and add a
   medication with a reminder in the next hour, so Today, charts and
   reminders all have content.
3. Settings → Devices & connectors → Emergency Kit → regenerate; copy the
   Account ID and recovery code into ASC (below). Do this again before every
   resubmission.
4. Make a second invite link for the fresh-account path.
5. After review: Settings → Devices & connectors → revoke the reviewer's
   passkeys.

**ASC → App Review Information:** Sign-in required: on; User name: the demo
account address (`<sub>.<base>`); Password: the recovery code; Notes:

```text
Med Tracker is an invite-only, end-to-end encrypted health log. Sign-in uses
passkeys only (no passwords), so please use the steps below on a device with
iCloud Keychain turned on.

Demo account with sample data:
1. Open the app, enter the account address from "User name", tap Continue.
2. Tap "Recover with your Emergency Kit".
3. Enter Account ID: <ACCOUNT ID> and the recovery code from "Password".
4. Create a passkey when asked (Face ID). The app then shows a new Emergency
   Kit: tap "Download Emergency Kit", save it anywhere, tick "I saved my
   Emergency Kit", and continue. You are now in the demo account.

Fresh account (please use this one to test account deletion):
open the app and paste this invite link: <INVITE LINK>
Then create a passkey and save the Emergency Kit as above.

Native features:
- Apple Health (read-only): Settings > Apple Health. Blood pressure, weight,
  sleep and workouts are imported into the encrypted vault. The app never
  writes to Health and never uses Health data for advertising.
- Reminders: Settings > Notifications > Enable, then "Send test". Medication
  reminders are scheduled on the device as local notifications.
- Camera: food barcode scanning and meal photos (Food), QR scan on first run.
- Downloads and printing (backups, Emergency Kit) via the share and print sheets.

Account deletion: Settings > Account & privacy > Delete my account.

AI and voice features are optional and off until the user enables them; each
asks for explicit consent before any data is sent to an AI provider.

Med Tracker is a personal log, not a medical device, and does not give
medical advice.
```

### Submission checklist

Repo side (done in this bead): icon, launch colour, usage strings, privacy
manifest, privacy policy, first-run disclaimer and policy link, this section.

Owner only:

- [ ] Apple Developer Program agreements and (free app) the Free Apps
      agreement accepted in ASC → Business.
- [ ] ASC app record with the `IOS_BUNDLE_ID` App ID; name, subtitle,
      category **Medical** or **Health & Fitness**, age rating questionnaire
      (medical/treatment information: yes — the app records it, gives no
      advice), price Free.
- [ ] Owner setup secrets and variables present; App Store profile
      regenerated after the HealthKit / Associated Domains capabilities.
- [ ] Production serves the AASA (`IOS_TEAM_ID`, `IOS_BUNDLE_ID` in the cloud
      env) on the base domain and an account subdomain.
- [ ] Actions → iOS → Run workflow on `master`; the build reaches TestFlight;
      install it and run the device checks in this file (shell, notifications,
      Health).
- [ ] App Privacy filled in as above; privacy policy and support URLs set.
- [ ] Screenshots (6.9" iPhone at least) from a TestFlight install on the demo
      account; description ends with the medical disclaimer.
- [ ] Demo account prepared and App Review Information filled in as above,
      with a fresh recovery code and invite link.
- [ ] Export compliance: answers match `ITSAppUsesNonExemptEncryption: false`.
- [ ] Select the build, submit for review. After approval or rejection:
      revoke the reviewer's passkeys; regenerate the kit before resubmitting.

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
