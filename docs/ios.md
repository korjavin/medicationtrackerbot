# iOS app — CI build and TestFlight

The iOS app (epic `med-w6gx`) is a thin Swift WKWebView shell in `ios/`. It is
**never built locally**: every build, signing and TestFlight upload runs on a
GitHub-hosted macOS runner via [`.github/workflows/ios.yml`](../.github/workflows/ios.yml).

- `ios/project.yml` is an [XcodeGen](https://github.com/yonaskolb/XcodeGen) spec;
  the runner generates the `.xcodeproj` from it. Nothing generated is committed.
- **Triggers:** PRs/pushes touching `ios/**`, `ios.yml`, or the web app the
  build bundles for local mode (`web/static/**`, `web/cloud/**`,
  `web/domain/**`) run an unsigned simulator build only. `workflow_dispatch`
  (any branch) also archives, signs and uploads to TestFlight. Go-only changes
  never start it (macOS minutes cost ~10x Linux).
- `deploy.yml` ignores `ios/**` and `ios.yml`, so an iOS-only merge does not
  redeploy production.
- Build number = the workflow run number, so every upload is unique.

## Owner decisions & testing

- **Shape:** a thin Swift WKWebView shell over the remote account origin, not
  Capacitor and not a local bundle (passkeys are bound to the account
  subdomain; `window.Capacitor` is banned by CLAUDE.md rule 10). See
  [The shell](#the-shell-bd-med-w6gx3).
- **Product:** free (no in-app purchase), invite-only, iOS 18+, HealthKit
  read-only in v1.
- **No local iOS builds.** Every build comes from
  [`.github/workflows/ios.yml`](../.github/workflows/ios.yml) and goes to
  TestFlight.
- **Zero impact on the web.** Changes outside `ios/` are additive and inert on
  the web (behind the `ios` platform of `web/static/js/native/`), and get a
  breakage review before merge (CLAUDE.md rule 15).
- **Device testing** is done by the owner on their own iPhone via TestFlight
  (the owner is Admin in App Store Connect).
- **Crash logs:** App Store Connect → TestFlight → Crashes (or Feedback).

### App Store justification

Guideline 4.2 (minimum functionality) rejects thin web wrappers, so the app
must justify being an app. The owner's floor is the Apple Health (HealthKit)
integration as core native value. Native capabilities today:

- **Apple Health import** of blood pressure, weight, sleep and workouts
  ([Apple Health import](#apple-health-import-bd-med-w6gx6)).
- **Local notifications** for reminders, offline, no Web Push
  ([Reminders as local notifications](#reminders-as-local-notifications-bd-med-w6gx5)).
- **Native share sheet and print** for downloads and printouts
  ([Downloads and printing](#downloads-and-printing-bd-med-w6gx11)).
- **Passkeys** through the system sheet (Associated Domains).

The App Review notes lead with these, before reviewer access.

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
  | `NSFaceIDUsageDescription` | local mode's optional lock (`LocalAuthentication`) |

  Local notifications need no Info.plist string (iOS asks at runtime). Photo
  picking goes through the system picker, which needs no permission; passkeys
  use the system sheet (the Face ID string is for local mode's lock only).
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
  | Health & Fitness → Health | `vault` (incl. Apple Health imports), `trial-ai`, `trial-chat`, `trial-voice`, `voice-llm-relay`, `mcp-hosted`, `telegram-relay`, `rxnav`, `local-voice` |
  | Health & Fitness → Fitness | `vault`, `nxk-import`, the same AI/voice/MCP rows |
  | Identifiers → User ID | `account-existence` (account subdomain), `telegram-relay` (chat id) |
  | User Content → Photos or Videos | `trial-ai` (meal photos) |
  | User Content → Audio Data | `trial-voice`, `local-voice`, `feedback` (voice notes) |
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
  ([privacy-policy.md](privacy-policy.md); the first-run screen links it, iOS
  Settings → Med Tracker → Privacy names it, and
  the signed-in app shows its disclosures under Settings → Account & privacy;
  a clickable link there would change the web app, so it is not added).
  Nothing on the cloud
  domain serves a policy: the base domain serves only the landing page and
  the AASA.
- **Support URL:** <https://github.com/korjavin/medicationtrackerbot/issues>.
- **Medical disclaimer** — end of the description, and the first-run footer:

  > Med Tracker is a personal log, not a medical device, and does not give
  > medical advice. Talk to your doctor before changing a treatment.

- **Account deletion** (guideline 5.1.1(v)): in the app, Settings → Account &
  privacy → Delete my account (passkey re-check, then `DELETE /api/account`,
  [`internal/cloudserver/account.go`](../internal/cloudserver/account.go)).
  It is immediate; no web form needed. Afterwards the app returns to its
  native first-run via `account.leave` (bd med-o7zq.33); a shell without the
  op gets the old redirect to the base domain.

### Reviewer access

Accounts are invite-only and unlock only with a passkey bound to the
account's own subdomain, so there is no username/password to hand over. The
reviewer gets **fresh, unused invite links** and signs up their own account
with their own passkey. No new server code, and no shared account:

- A claim link is single-use: claiming it again returns
  `409 claim already used or expired`.
- A pre-claimed demo account would hold the owner's passkey, which the
  reviewer cannot use. Its Emergency Kit code is burned on first use, so a
  second device or a resubmission would be locked out.
- Device transfer needs an unlocked device to start it, and its slot lives
  10 minutes.

**Never** put a recovery code, the owner's account, or a claim URL in this
repo. Claim URLs go only into the private ASC review notes. The accounts start
empty; that is fine, and there is no demo-data seeding.

#### Mint the links (owner, just before submitting)

Run the operator command in the **real production container**, never a
throwaway container or a copy of the DB. Use Portainer's exec (Containers →
`medtracker-cloud` → Console, or the Docker exec API through Portainer), not
SSH:

```bash
./cloud admin invite      # run 4 times: 1 sacrificial + 3 for the reviewer
```

Each run prints `subdomain:`, `expires:` and `claim URL:`. Note each link's
subdomain and expiry somewhere private.

1. **Dry run, sacrificial link (#0):** claim it end-to-end on your own device:
   open the link, create the passkey, save the kit, see the empty Today
   screen. Then remove it: `echo <sub> | ./cloud admin delete <sub>`. This
   proves the claim path on prod without spending a reviewer link.
2. **Check the 3 reviewer links without spending them:** for each one,
   `POST https://<sub>.<base>/api/webauthn/register/begin` with
   `{"claim_token":"<token from the #claim= fragment>"}` returns `200`
   (the token is valid and unclaimed; begin does not consume it). `403` means
   expired or wrong; `409 already_claimed` means it was used.
3. Put the 3 links in the ASC notes (below) as **A** (main), **B** (account
   deletion test) and **C** (spare).

Claimed accounts do not expire. Only an **unclaimed** link does, after
`CLOUD_CLAIM_TTL` days (default 14). That is a default, not a review SLA:

- **Review delayed:** if the submission is still waiting a few days before
  the earliest `expires:`, run `./cloud admin reset-claim <sub>` for each
  unclaimed link. It prints a new URL with a fresh TTL and kills the old one,
  so update the ASC notes with the new URLs.
- **Resubmission:** run `./cloud admin list`. Keep A if it is claimed (the
  reviewer can sign in to it again). Reset-claim or re-mint any link that is
  unclaimed or close to expiry. Mint a new spare if C was used.
- **Reviewer contact:** put a phone number and email in ASC → App Review
  Information → Contact Information that you answer within a day, so a
  reviewer stuck on a link can get a new one.

**Cleanup, after the review is final (not while it is open):** find the
reviewer subdomains in `./cloud admin list`. Remove a claimed one with
`echo <sub> | ./cloud admin delete <sub>` and an unclaimed one with
`./cloud admin revoke <sub>`. Keep A until the app is approved and no
resubmission is pending.

**ASC → App Review Information:** Sign-in required: **on**, because the app
needs an account. ASC demands both fields, so fill them as pointers: User name
= account A's address (`<sub>.<base>`); Password = `passkey - see notes`.
Notes (fill in the links):

```text
Med Tracker is an invite-only, end-to-end encrypted health log. Sign-in uses
passkeys only (no passwords), so there is no demo username/password. Instead,
here are fresh invite links that create your own account. Please use a device
with iCloud Keychain turned on.

Sign up:
1. Open the app and paste invite link A: <LINK A>
2. Create a passkey when asked (Face ID creates it). Save the Emergency Kit:
   tap "Download Emergency Kit", save it anywhere, tick "I saved my Emergency
   Kit", and continue. The account starts empty.

Suggested walkthrough:
- Add a medication, then record a dose from Today.
- Record a blood pressure reading (Vitals).
- Open the history of both to see the entries.
- Enable reminders: Settings > Notifications > Enable, then "Send test".

Link B: <LINK B> - a second account; please use it to test account deletion
so account A stays available.
Link C: <LINK C> - spare. Use it only if account A becomes unreachable
(for example the app was reinstalled on a device without the same iCloud
Keychain). After a reinstall on the same device, open the app, enter
account A's address and sign in with the same passkey instead.
Each link works once. If a link fails, contact us at the details in Contact
Information and we will send a new one the same day.

Native features:
- Apple Health (read-only): Settings > Apple Health. Blood pressure, weight,
  sleep and workouts are imported into the encrypted vault. The import only
  finds data that is already in this device's Health app, so add a blood
  pressure or weight sample in Health first if it is empty. The app never
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

When a build with on-device local mode is submitted (epic `med-o7zq`; the
first-run "Only on this device" button is bd med-o7zq.5), add one line to the
notes so the reviewer can test both modes: `No-account mode: on first run tap
"Only on this device"; data stays on the device.` Leave it out of a
submission that is cloud-only.

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
- [ ] Screenshots (6.9" iPhone at least) from a TestFlight install on your
      own account; description ends with the medical disclaimer.
- [ ] Reviewer links minted and checked per *Reviewer access* (sacrificial
      #0 claimed and deleted, A/B/C return `200` from register/begin, expiries
      noted). App Review Information filled in as above, contact details set.
- [ ] Export compliance: answers match `ITSAppUsesNonExemptEncryption: false`.
- [ ] Select the build, submit for review. While it waits, renew unclaimed
      links before they expire. On resubmission, re-check the links. After
      the review is final, clean up the reviewer accounts.

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
- **Use another invite** (bd med-w6gx.21): while the committed page is a
  ceremony (`/unlock`, `/claim`, `/recover` — `AccountURL.isCeremony`), a
  native bar under the page offers "Not your account? Use another invite";
  after a confirmation it does Switch account. An invalid, expired or
  already-claimed invite otherwise leaves no way back (the host is stored the
  moment the link parses, so relaunch reopens `/unlock`). The bar is passive:
  a returning user unlocks as before. Coming from local mode (Move to a cloud
  account), the user picks "Only on this device" again to return; its data
  is kept.
- **Use this iPhone without an account** (bd med-o7zq.30, moved by
  med-o7zq.32): Settings → Account shows the row inside the iOS app only
  (account origin, `CloudVault.leaveAccount` present, platform `ios`). The
  account's own first-run (`WGFirstRun` welcome) offers only *Get started* /
  *Skip all* on every platform — choosing local belongs to the app's native
  first-run. After a `safeConfirm` the row calls
  `CloudVault.leaveAccount({ then: 'local' })` → bridge op `account.leave`
  with args `{then: "local"}` (account origin only), which forgets the account
  host and opens local mode directly (`forget(thenLocal: true)`, bd
  med-o7zq.34) — no stop at the native first-run. Local mode shows whatever
  the local origin already holds from an earlier device-only period, or starts
  empty with its own first-run. Nothing is erased (account on the server, the
  account origin's website data on the phone). A shell built before .34 has
  the op but ignores the args, so it lands on the native first-run as before;
  a shell without the op answers `unsupported` and the page points at iOS
  Settings → *Switch account*. When the shell lists `leave.stash` in
  `shell.ops` (bd med-o7zq.36), the page first hands it
  `CloudVault.exportAll({ includeSecrets: true })` so a copy of the records
  comes along into local mode; if the export or the stash fails, a second
  confirm offers to continue without them (Cancel stays in the account). An
  older shell without the op leaves as before and local mode starts empty — a
  backup file brings the records.
- **After account deletion** (bd med-o7zq.33): once the server delete and the
  local wipe finish, the iOS app calls `leaveAccount()` with no args and lands
  on the native first-run instead of the base-domain page (which has no way
  back into the app). If the op is missing it falls back to that redirect.
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

### Keyboard and focus zoom (bd med-pe9g)

The web view ignores the keyboard safe area (`.ignoresSafeArea(.keyboard)` in
`App.swift`), so it keeps its full frame and WebKit handles the keyboard as in
Mobile Safari: the visual viewport shrinks and pans, the layout viewport does
not. The page's one keyboard dock (`web/static/js/components/wg-sheet.js`,
[frontend.md → Sheets](frontend.md)) follows the visual viewport, and the same
code path serves Safari and the app.

That dock only works at page scale 1. iOS WebKit zooms the page in when a
field under 16px takes focus and keeps the zoom after the keyboard closes;
the food search (`.wg-input--text`, 14px) zoomed to 16/14 ≈ 1.14. TestFlight
178 showed the result: the sheet was 366pt wide on screen against its 320px
cap. With the dock off and the sheet at the bottom of the full-height layout
viewport, the header sat above the top of the screen with the keyboard closed,
the list ran under the keyboard with the header panned away, and an emptied
search left the sheet entirely below the visible area. `noFocusZoom()` adds
`maximum-scale=1` to the viewport on iOS only, which stops the focus zoom.

The shell does not set `ignoresViewportScaleLimits` (med-r6sh). With it on
(PR #1115 to build 351) the app pinch-zoomed as in Safari, but the page was
scalable again and a double-tap on a card (Settings → On this device only)
zoomed it, `touch-action: manipulation` on `html, body` (PR #1177)
notwithstanding. Honouring the cap makes the scroll view's minimum and maximum
zoom equal, and WebKit turns double-tap gestures off for a page it cannot scale.
The cost: no pinch-zoom in the app. Mobile Safari still ignores the cap for
gestures, so pinch works there.

jsdom cannot show any of this. It has no zoom, no keyboard and no visual
viewport. The tests pin the viewport cap and the dock's arithmetic
(`modals.header-actions.test.js`); only a device proves the layout.

#### Device check (TestFlight, and Mobile Safari)

1. Food → Add (Log food). Tap the search field. The page must not zoom. The
   sheet stays full width, with its corners and side edges where they were
   before the tap.
2. Type `Bana` with the keyboard up. The eyebrow, the Log food title, the Now
   chip, the X and the search field all stay visible. Only the result list
   scrolls, and the last row ends at the keyboard's accessory bar, not under it.
3. Clear the search with the keyboard still up. The sheet stays visible above
   the keyboard and the Food page behind it does not show through.
4. Tap ✓ to close the keyboard. The sheet drops back to the bottom of the
   screen with its header fully visible.
5. Repeat step 1 with a 15px field, for example a Settings
   number field. It must not zoom either.
6. App: double-tap Settings → On this device only, and any other card. The
   page must not zoom. Pinch does not zoom in the app either (Mobile Safari
   still pinch-zooms).

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
- **Tap** (bd med-w6gx.20): opens the reminder's `url`, the same
  `reminderDeeplink` a Web Push carries — a dose's take sheet
  (`/?action=medication_confirm&ids=…&scheduled=…`), else its section
  (`/?tab=<section>`). `ReminderPath.swift` allowlists it like `sw.js`
  `reminderOpenUrl` (root, keys tab/action/ids/scheduled, no fragment; else
  `/?tab=today`); a reminder without a url (older page or build) maps its
  `section`. The open app gets `history.replaceState` + `handleDeepLinks()`,
  a cold start loads the path.
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
   **Use another invite** (med-w6gx.21), no reinstall in any of these:
   a. Fresh install → paste an already-claimed invite → the "already claimed"
      page shows "Not your account? Use another invite" under it → tap →
      confirm → first-run → scan a valid invite QR → claims.
   b. Same with an expired or garbage `#claim=` token.
   c. Kill and relaunch while stuck on `/unlock` → the bar is still there.
   d. Local mode: Settings → Backup → Move to a cloud account → bad invite →
      the bar → "Only on this device" → local data intact.
   e. A returning user at `/unlock` ignores the bar and unlocks as before.
7. Claiming in the app goes from the Emergency Kit (and Telegram, when
   offered) straight into the app: no "Add to your Home Screen" step.
8. Settings → Notifications → Enable → iOS asks → Allow; Send test → a
   notification arrives within seconds, also with the app open.
9. Add a med due in ~3 minutes, kill the app, airplane mode → the reminder
   fires; tapping it opens the take sheet for that dose.
10. Edit that med's time → only the new time fires (pending notifications are
    replaced).

## Local mode: the bundled app on `wgapp://local/` (bd med-o7zq.4)

Local mode (epic `med-o7zq`) runs the web app with no account: the shell's one
web view loads the copy bundled in the app from its own origin, so its
IndexedDB never mixes with an account's. Cloud mode is unchanged. The web side
(`local-boot.js`, `local-policy.js`) is shared with the Android app's local
mode, gated on the bridge platform being `ios` or `android`
([docs/android.md](android.md), bd med-nt9p.32).

- **Bundle:** [`ios/bundle-web.sh`](../ios/bundle-web.sh) runs in `ios.yml`
  before `xcodegen generate` and copies `web/static`, `web/cloud` and
  `web/domain` from the checked-out revision into `ios/LocalApp/` (git-ignored;
  test suites and Go files left out). It writes `index.html` from
  `web/static/index.html` with the `?v=` fingerprints set to `ios-<run number>`
  and, after `<head>`, only what the local entry needs of `injectCloudBoot`
  (`internal/cloudserver/router.go`): the `medtracker-build-id` meta and a
  classic `<script src="/js/local-boot.js">` (the local entry, bd med-o7zq.2;
  `web/cloud/js/local-boot.js`, which must run before every web/static script,
  as `cloud-boot.js` does). No food-DB URL, no trial flags, no
  `update-check.js`, no Service Worker. `android.yml` reuses the same script
  for the APK (bd med-nt9p.32.2) via `WG_BUNDLE_OUT` / `WG_BUNDLE_PREFIX`,
  both unset here ([android.md → Local mode](android.md#local-mode-the-bundled-app-bd-med-nt9p322)).
- **Serving:** [`LocalApp.swift`](../ios/App/LocalApp.swift), a
  `WKURLSchemeHandler` for `wgapp`, routes like an account host: `/` → the
  local `index.html`, `/static/*` → `web/static`, `/domain/*` → `web/domain`
  (so `apishim.js`'s `../../domain/` imports resolve), everything else →
  `web/cloud` (`/js/*`, `/css/*`, `/vendor/*`). Routing, MIME types and the
  rest are in [`LocalOrigin.swift`](../ios/App/LocalOrigin.swift), checked by
  `ios/Tests/main.swift` in CI.
- **CSP:** every response carries cmd/cloud's policy with `connect-src 'self'`
  plus `https://<host>` and `wss://<host>` for each host the page registered —
  never a wildcard (both schemes per host, like `router.go` lists
  `wss://api.elevenlabs.io`: WebKit's CSP3 https→wss matching is not relied on). The header is sent before the page can read its own
  settings, so the shell keeps a native mirror: the page
  (`web/cloud/js/local-policy.js` `registerLocalEgress`) calls the bridge op
  `setEgressHosts` with `{hosts: [...]}` (same rules as `PUT
  /api/egress-hosts`: at most 8 bare lowercase DNS names; an invalid list is
  rejected whole and the stored one kept) at boot and after each Settings →
  AI & integrations save. The reply is `{changed}`; a change applies on the
  next document load, so the page reloads when it is `true` (once: the next
  load's list matches). `api.elevenlabs.io` (always allowed in
  cloud) is in the list only while the anonymous trial is on (voice calls,
  below).
- **Egress and side effects** (bd med-o7zq.3, `web/cloud/js/local-policy.js`):
  nothing leaves the phone except calls to the providers the user added with
  their own key. Reminders are computed on the device and go to the iOS
  scheduler only, on every write, open and return to the front (no relay upload, no Telegram re-fire calls; the lock-screen
  text is generic unless Settings → Reminders & notifications → Reminder text
  says Detailed); RxNav lookups are off (`rxnorm: null`); the account trial
  and the operator food DB are off because the bundle carries no trial /
  food-DB meta. The **anonymous trial** (bd med-o7zq.16) is the one opt-in
  exception: Settings → AI & integrations → "Try the AI, food database and
  voice calls without your own keys" is the `anon` trial consent; while it is
  on (and the shell supports App Attest) `registerLocalEgress` adds the base
  domain and `api.elevenlabs.io` to `setEgressHosts`, installs
  `web/cloud/js/local-trial.js` as aiclient's trial transport, which signs
  each request with `attest.assert`, and swaps `window.CloudVoiceLLM` for a
  responder that mints each voice call through it (bd med-o7zq.23;
  [cloud-mode.md → Anonymous trial](cloud-mode.md)); `<html>` then carries
  `wg-local-trial`, which shows the call trigger. Off, neither host is in the
  CSP and the call bar says to turn the trial on.
  **Microphone:** a call uses WebKit's default per-origin capture prompt on
  `wgapp://local` (`NSMicrophoneUsageDescription` is in `project.yml`); there
  is no `WKUIDelegate` media-capture handler. If TestFlight shows WebKit
  refusing capture on the custom scheme, add
  `webView(_:requestMediaCapturePermissionFor:initiatedByFrame:type:decisionHandler:)`
  in `Shell.swift`, granting only the local origin's main frame `.microphone`.
  **Face ID lock:** no voice-specific plumbing — a call cannot start while
  locked (`attest.assert` is refused like every bridge op), and a lock
  mid-call behaves as backgrounding does in the cloud shell.
  `local-boot.js` puts `wg-local-vault` on `<html>`, and `styles.css` hides
  `.wg-cloud-only` (Mi Band import, voice, plan/gym sharing, restore and sync
  reset) and shows `.wg-local-only`. Telegram, feedback, devices and the
  update check are never loaded. `push.js` and `mcp-responder.js` are loaded
  (apishim and reminders.js import them statically) but never started or
  called: `LOCAL_EFFECTS` replaces the push effects, `relay: false` skips the
  schedule upload, and no relay socket is opened. Privacy rows:
  `local-*` in `web/cloud/js/privacy-manifest.js`.
- **Bridge:** in local mode only the main frame of `wgapp://local` reaches
  `wgNative` (an account origin does not); `setEgressHosts`, `local.reset`,
  `local.leave`, `move.stash`, `leave.take`, `leave.clear` and `attest.*` (`ios/App/Attest.swift`: `status`, `enroll`,
  `assert`, `setPass` — the anonymous trial's pass in the Keychain,
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, not iCloud-synced, so a
  reinstall rejoins the same trial budget (bd med-o7zq.26); entitlement `com.apple.developer.devicecheck.appattest-environment`,
  checked on the signed archive in `ios.yml`) exist only there, `notifications.*` and `health.*` serve both modes.
  The scheme is app-bound (`"wgapp:"` in `WKAppBoundDomains`), so the shell
  keeps `limitsNavigationsToAppBoundDomains` on in both modes.
- **Backup flag:** WebKit excludes a new origin's data dir from backup for its
  first 24 h (spike step 7, bd med-o7zq.11). In local mode the shell clears
  `isExcludedFromBackup` on that dir and its parents up to `WebsiteData` at
  launch, after each page load and on going to the background.
- **Mode:** persisted in `UserDefaults` `wgLocalMode`; it wins over a stored
  account host. Set by the first-run screen's secondary button *Only on this
  device* (bd med-o7zq.5; the invite form stays primary), after a native intro
  (`LocalIntroView` in `App.swift`): records only on this iPhone and in its
  own backup, no other copy, deleting the app loses them, export regularly,
  BYOK only. *Start* stores the choice; *Back* returns to the invite form.
  iPhone Settings → Med Tracker → *Local mode* is the same switch. *Switch
  account* leaves local mode too; the origin's data is kept either way.
  When first-run shows (no account, not local) while `LocalOrigin.dataDirs()`
  still finds the `wgapp://local` origin's data — local mode left on purpose,
  or its flag lost across an update (bd med-o7zq.31) — it leads with
  *Continue on this iPhone*, which reopens local mode directly
  (`LocalOrigin.offersResume`, checked in `ios/Tests/main.swift`). A button,
  not a silent resume, so someone who left for an invite still reaches the
  invite form. The first-run screen scrolls, so *Only on this device* stays
  reachable with the keyboard up. At launch the shell logs (`os_log`,
  category `shell`) the mode, whether a host is stored and the local data
  dir count — no host name.
  Settings opens on an *On this device only* row in local mode.
- **Lock** (bd med-o7zq.8, [`LocalLock.swift`](../ios/App/LocalLock.swift)):
  optional, off by default; opted into on the local intro (*Lock with Face
  ID*, shown when the phone has a passcode and starting on when a lock is
  still on from an earlier stay; *Start* turns it on, or that one off, only
  after a successful check) or iPhone Settings → Med Tracker → *Lock*. Local mode
  only — an account has its passkey unlock. A UI lock, not encryption, and
  Lock Screen reminders still show (their text is Settings → Reminder text);
  both are said where it is turned on. `LocalAuthentication`
  `.deviceOwnerAuthentication` (biometrics, passcode fallback). States
  locked / unlocking / unlocked: it locks at launch and on going to the
  background (not on inactive — Control Center and the Face ID sheet itself
  pass through inactive), and prompts once on the next activation; a cancel
  leaves the lock screen with an *Unlock* button and no re-prompt. While it
  holds: the web view is out of the window (the page is hidden, so the
  `visibilitychange` work — Health import, reminder refresh, backup nudge —
  waits for the unlock), every load is deferred (launch, Try again, mode
  switch, content-process restart; a mode switch blanks the old page first),
  a notification tap is kept and opened after the unlock, any share or print
  sheet is dismissed (its temp file deleted) and a download or print that
  finishes meanwhile is dropped, and every bridge op answers `locked`. Whenever the lock is on and the app is not active, a plain cover
  is drawn over the window, so the app-switcher snapshot shows no data.
  Turning it off in Settings applies only after the next successful unlock
  in local mode; turning it on applies at once. With the passcode removed
  from the phone, the lock lets the user in (nothing to check against; it
  must not strand the only copy of their records). The lifecycle is checked
  in CI by `ios/Tests/main.swift`.
- **Export reminder** (bd med-o7zq.5, `local-policy.js` `nudgeLocalBackup`):
  at most once a week, counted from the first open, the last reminder or the
  last export, and only once something is stored, a toast suggests exporting
  a backup file (*Back up* opens Settings → Backup & import). Checked at boot
  and on every return to the front.
- **Backup, restore, move to cloud** (bd med-o7zq.6, `local-policy.js`
  `LOCAL_VAULT`): Settings → Backup & import exports the same vault v1 file
  as the cloud (`recordsToVault`, pinned against `tests/fixtures/vault-v1.json`
  in `cloud.local-mode.test.js`) and restores one, replace-only, into the
  on-device store; a restore resets the Apple Health anchors so the next run
  re-reads the whole history. *Move to a cloud account* is that file, not a
  hand-off between origins: *I have an invite* sends `local.leave` (the shell's
  *Switch account*), the user claims the invite and restores the file in the
  new account's Settings. The local records stay until the user erases them;
  nothing prompts to. A shell that lists `move.stash` also gets Settings home →
  *Move to a cloud account*, which carries the records without the file (the
  move stash below; shared contract in
  [android.md → Moving to a cloud account](android.md#moving-to-a-cloud-account-bd-med-nt9p3210)). A cloud restore not yet on the server says why before
  the reload (`importAll` → `{ upload }`, sync.js `forceSnapshot`: retrying
  offline, paused until a passkey re-auth, or refused for size/quota and never
  landing by itself), so the other copy is kept until then. A failed local
  restore resumes the Health import; a successful one keeps its tally.
  The account → local move (bd med-o7zq.36.4) needs no file: the local boot
  takes the leave stash below and restores it through the same `restoreVault`
  (Merge / Replace / Cancel when records are already here), clears the stash
  whatever the outcome (the account copy is the retry), and the reloaded app
  toasts once that the account's records are on this iPhone.
- **Move stash** (bd med-o7zq.35, twin of Android `Move.kt`, med-nt9p.32.17;
  the web side that calls it is med-nt9p.32.16/.18): the shell carries the
  vault v1 JSON across the two origins in one file,
  `Application Support/move/vault.json` (`ios/App/Move.swift`), the directory
  marked `isExcludedFromBackup`. Plaintext in the same sandbox as the local
  origin's website data, never leaves the device, never logged; error replies
  never carry the contents or the path. Ops: `move.stash {vault}` (local mode
  only; `invalid vault` when missing, empty or not a string, `too large` above
  64 MB of UTF-8, atomic write replacing any older stash, replies `true`);
  `move.take` (account mode only; `{vault}` or `null`, does not delete, so a
  failed import retries on the next open); `move.clear` (account mode only,
  replies `true`). Deleted by `move.clear`, `local.reset` and whenever local
  mode is entered again (*Only on this device*, *Continue on this iPhone*,
  `account.leave {then: "local"}`, the Settings toggle); `local.leave` and
  Switch account keep it. While it exists the native first-run says *Your
  records are ready to move: paste or scan your invite.* and hides *Continue
  on this iPhone*. `shell.ops` replies the op names this shell answers in the
  current mode (`LocalOrigin.ops`), the page's capability probe; a shell
  before it answers `unsupported: shell.ops`. `Tests/main.swift` covers the
  file lifecycle and the per-mode op lists.
- **Leave stash** (bd med-o7zq.36.2, the reverse of the move stash; the web
  sides are med-o7zq.36.1 and .36.4): the same `Move` on a second directory,
  `Application Support/leave/vault.json`, also excluded from backup, carries
  the account's vault v1 JSON into local mode. Same validation, errors and
  privacy as `move.*`:

  | Op | Mode | Reply |
  |----|------|-------|
  | `leave.stash {vault}` | account only | `true`; `invalid vault` / `too large` / `write failed` |
  | `leave.take` | local only | `{vault}` or `null`; does not delete |
  | `leave.clear` | local only | `true` |

  Lifecycle: the account page stashes before `account.leave {then: "local"}`,
  so the stash survives entering local mode (`forget(thenLocal:)` and the
  `local` didSet leave it alone); the local page takes it and clears it once
  restored. Deleted by `leave.clear`, `local.reset` and opening an account
  (`open(_:)`: the move was abandoned). Independent of the move stash: one
  never clears the other (`Tests/main.swift`).
- **One vault at a time** (bd med-o7zq.9): the shell's open vault is `local`
  or the account host. Each reminder carries it (`userInfo.vault`, id
  `wg-<n>-<vault>`); switching mode or account removes every pending reminder
  (the newly opened page schedules its own), a schedule call still running
  from the previous page adds nothing, and a tap on another vault's
  delivered reminder is ignored. Switching is navigation between the two
  origins' own stores: nothing is merged or copied.
- **Notifications** (local mode): Settings → Reminders & notifications →
  Notifications shows the iOS permission state, asks for it (*Allow
  notifications*), says where to turn it on when it is denied, and sends a
  test. Allowing it reschedules at once. It says "on" only when the
  permission is granted AND the last device schedule took; a failed schedule
  (bridge error, the 10 s timeout, or iOS adding none of the reminders) is
  shown there with its reason (`reminders.js` → `local-policy.js`
  `lastReminderSchedule` / `wg:local-reminders-scheduled`).
- **Apple Health** (local mode): the same Settings row and import run as the
  cloud (`health-import.js`), writing into the on-device store with no flush,
  then rescheduling reminders (`startLocalHealthImport`).
- **Erase:** Settings → Backup & import → *Erase data on this device* (typed
  confirm) deletes this origin's databases, caches and local/session storage
  (`clearLocalVault`, so only `wgapp://local`), then `local.reset` makes the
  shell drop local mode's pending and delivered reminders and the BYOK host
  mirror, and the app reloads empty. An account's data on the phone is not
  touched.
- **Visual testing:** runbook, probe reading and bead-filing protocol in [ios-visual-testing.md](ios-visual-testing.md). Device testing by the owner comes after the Simulator matrix.
- **Visual QA hook** (bd med-y5xx.2, [design](design/ios-visual-testing.md)):
  Debug builds only (`#if DEBUG` in `Shell.swift` / `LocalOrigin.qaHome`),
  launch argument `-wgQAScene <name>` opens local mode on
  `wgapp://local/?qa=<name>` and the web view is `isInspectable`. The
  TestFlight archive is Release; its step in `ios.yml` fails if the binary
  carries the hook. `ios/UITests/VisualQATests.swift` (target
  `MedTrackerUITests`, compiled by the build job's `build-for-testing`)
  launches each scene of `tests/visual/scenes.json` with `-wgLocalMode 1
  -wgLocalLockOn 0 -wgQAScene <name>`, waits for `#wg-qa-ready`, runs the
  scene's native steps and attaches `<scene>.png` + `<scene>.json`.

### Device check (TestFlight)

1. Fresh install, airplane mode, open the app → *Only on this device* → read
   the intro → *Start*: the app renders from the bundle with no network.
   (*Back* on the intro returns to the invite form.)
2. Safari Web Inspector (Mac): no failed module or asset loads; the main
   document's response has the `Content-Security-Policy` header; a `fetch` to
   a host not registered via `setEgressHosts` is refused by CSP.
3. Kill and reopen: still local, data still there.
4. Settings → Reminders & notifications → *Allow notifications* → Allow; add
   a med due in two minutes: it fires; tapping it opens Meds in local mode.
5. With a reminder pending in local mode, switch *Local mode* off (back to
   the account): only the account's reminders remain pending; tapping a
   local reminder delivered earlier does nothing.
6. Apple Health on, airplane mode: a Health BP reading appears in BP.
7. Erase data on this device: the app reopens empty; switching to the
   account shows its data untouched.
8. Lock (fresh install): *Only on this device* → *Lock with Face ID* on →
   *Start* → Face ID → the app opens. Then: the app switcher shows the plain
   cover; returning from the background, killing and reopening, and tapping a
   reminder each ask for Face ID first (the tap then opens its section);
   cancel → lock screen, no second prompt until *Unlock*; Safari Web
   Inspector on the hidden page: `window.webkit.messageHandlers.wgNative`
   calls reject with `locked`. Settings → Med Tracker → *Lock* off → back in
   the app: still asks once, then stays open on the next return.
9. Account → local (bd med-o7zq.36): an account with records → Settings →
   Account → *Use this iPhone without an account* → local mode shows the
   records and a one-time toast that they came from the account (with records
   already in local mode: a Merge / Replace / Cancel choice first. Merge keeps
   them and adds the account's; Replace asks one more confirm, then erases
   them; Cancel keeps them and says how to retry) → *Switch account* → the account address → the
   account's records are still there.

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
  the shell) on `wgapp://local/`, served from the bundled test page
  [`ios/LocalSpike/`](../ios/LocalSpike/) with the CSP as a response header.
  The page ([`js/main.js`](../ios/LocalSpike/js/main.js)) runs every check it
  can decide and shows a PASS/FAIL/MANUAL/INFO table; the native side adds the
  data-directory scan (7, 12) and the bridge's view of the origin (8). No
  private WebKit API, no Service Worker. The shell's normal path never creates
  any of it; it is throwaway, kept until checks 10 and 11 have run (release gate), and shares the `wgapp://local` origin with local mode (separate database).
- **Why `wgapp:` is in `WKAppBoundDomains`** (bd med-o7zq.10): once Info.plist
  lists app-bound domains, WebKit refuses a non-app-bound load under the limit
  (`WKErrorDomain` 13) and drops script message handlers from any web view
  that is not app-bound, so check 8 failed on build 62. An entry ending in a
  colon is an app-bound *scheme*
  (`WebsiteDataStoreCocoa.mm`, `initializeAppBoundDomains`), so
  [`ios/project.yml`](../ios/project.yml) lists `wgapp:` next to the two
  account-domain entries and the scheme name in `LocalSpike.swift` is fixed to
  match. The cloud shell is unchanged.
- **Open it:** iPhone Settings → Med Tracker → *Local mode diagnostic* on →
  back to the app. *Close* (top left) turns it off again. *App-bound* (keep it
  ON) reloads without the app-bound limit, only to compare if the page fails
  to load with it.
- **Get the report out:** the page's *Share report* (that is check 4) or
  *Copy report*; or the native *Report* button (Copy / share), which also
  carries the page's report when the bridge works. Account host names are
  redacted; only the first 8 characters of the vendor id appear.
- **Build:** Actions → **iOS** → Run workflow on the spike branch (or master
  after merge), then install from TestFlight (see *Shipping a build*).

### Owner run on the device

1. Fresh install of the build (or the update over an existing one) → open the
   diagnostic with *App-bound* ON: the page must load and #8 must show the
   bridge origin (`wgapp`, `local`) → wait for "Automatic checks done" → tap
   *Test camera* (allow) → *Share report* (the share sheet must open: check 4)
   → save the report, and the native *Report* too.
2. **Kill/relaunch (2, 2k):** swipe the app away, reopen, open the diagnostic:
   #2 and #2k turn PASS and list the earlier launch.
   - **2a. Quick kill:** on a launch, wait for the line "Launch … persisted"
     (shown only after the IndexedDB transaction completes), kill the app
     within 5 seconds, relaunch: #2 must list that launch.
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
7. **Backup flag (12):** nothing to do on the device beyond opening the
   diagnostic — the build clears the flag itself; the report carries the
   result. Background (bd med-o7zq.11): on iOS WebKit excludes a *new* origin
   directory from backup when it first writes the origin's `origin` file
   (`NetworkStorageManager::writeOriginToFileIfNecessary`) and includes it
   again only on a storage access 24 h later
   (`includeOriginInBackupIfNecessary`, `defaultBackupExclusionPeriod`). Build
   73 read `excluded=true` on a fresh install for that reason, not a build-62
   leftover. A backup inside that window drops the origin's data, so local mode
   must clear it (it does: see *Local mode* above). The spike, at diagnostic start
   and on every native scan, sets `isExcludedFromBackup` back to false on the
   origin dir and on any excluded parent up to `WebsiteData`, reads it back,
   and appends each dir's first sighting per launch (`found=`, `cleared
   ok`/`FAILED`) to a history file in Application Support. The Report's `#12`
   lines are that history plus `#12 now:`; the page's #12 is PASS when nothing
   is excluded now and no clear failed. A FAIL there makes the backup →
   restore check (step 5) invalid.
8. Paste the reports (Share or the native Report) into the bead; the table
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
| 2 | IndexedDB records survive kill/relaunch (incl. a kill right after "persisted") and a TestFlight update | auto + steps 2, 2a, 3 | pending device run |
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
| 12 | `isExcludedFromBackup` on the origin's data dir and parents: WebKit's exclusion of a new origin is cleared every launch; must read `false` now, per-launch history | auto (native) | pending device run |

**Verdict:** pending device run.
