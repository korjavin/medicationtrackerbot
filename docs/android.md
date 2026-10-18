# Android app — CI build and Play internal testing

The Android app (epic `med-nt9p`) is a thin Kotlin WebView shell in `android/`,
the twin of the iOS app ([ios.md](ios.md)). It is **never built locally**:
every build, signing and Play upload runs on a GitHub-hosted ubuntu runner via
[`.github/workflows/android.yml`](../.github/workflows/android.yml).

- `android/` is a plain Gradle project (AGP 8.9, targetSdk 36, Kotlin 2.0, JDK 17,
  minSdk 34). There is no committed Gradle wrapper: the runner pins the Gradle
  version (`gradle/actions/setup-gradle`), and nothing else ever builds it.
- **Triggers:** PRs/pushes touching `android/**` or `android.yml` build a
  debug APK, run the unit tests and upload the APK as the
  `medtracker-debug-apk` workflow artifact. `workflow_dispatch` (any branch)
  also builds a release AAB signed with the upload key and uploads it to the
  Play **internal testing** track. Web and Go changes never start it.
- `deploy.yml` ignores `android/**` and `android.yml`, so an Android-only
  merge does not redeploy production.
- versionCode = the workflow run number, so every upload is unique.
- The applicationId comes from the `ANDROID_PACKAGE` variable; without it the
  build uses the placeholder `com.example.medtracker` (forks, unconfigured
  runs). The package and the base domain are never committed; the package
  may appear in the (public) Actions logs — it is public once on Play. The
  base domain must not: the workflow reads it from the `CLOUD_BASE_DOMAIN`
  **secret** (a step's `env:` block is printed before its script runs, so the
  same-named variable deploy.yml uses would show there), masks it and passes
  it to Gradle (`BuildConfig.BASE_DOMAIN`).

## Owner setup (GitHub → Settings → Secrets and variables → Actions)

The debug APK builds with none of these. On a dispatch, each missing input is
named in a notice and its step skipped while the run stays green: without the
variables or upload-key secrets no release AAB is built; without the service
account the signed AAB is kept as a run artifact but not uploaded to Play.

**Variables** (not secret):

| Name | Value |
|------|-------|
| `ANDROID_PACKAGE` | the Play app's package name (Play Console app record, bd med-nt9p.1) |
**Secrets:**

| Name | How to get it |
|------|---------------|
| `CLOUD_BASE_DOMAIN` | the deployment's base domain — the same value as the `CLOUD_BASE_DOMAIN` *variable*, kept as a secret here so it never shows in the logs. The shell accepts only accounts one label under it; without it the app builds but its first run says no service is configured |
| `ANDROID_DEBUG_KEYSTORE_BASE64` | the stable debug key for master-push and dispatch APKs (below). PR runs never get it (its fingerprint is trusted by production asset links), so a PR APK is signed with a throwaway key — it installs, but passkeys won't bind to it; same for every run until this secret exists |
| `ANDROID_UPLOAD_KEYSTORE_BASE64` | the Play **upload** keystore (below), `base64 -w0 upload.jks` |
| `ANDROID_UPLOAD_KEYSTORE_PASSWORD` | that keystore's store password |
| `ANDROID_UPLOAD_KEY_ALIAS` | the key alias inside it (`upload` if made with the command below) |
| `ANDROID_UPLOAD_KEY_PASSWORD` | that key's password |
| `ANDROID_PLAY_SERVICE_ACCOUNT_JSON` | Google Cloud service account JSON key, invited in Play Console → Users and permissions with *Release to testing tracks* on the app (bd med-nt9p.1) |

### Making the keys (once)

Both are plain JDK `keytool` commands — no Android build. Any JDK 17 works, or
`docker run --rm -it -v "$PWD:/k" -w /k eclipse-temurin:17 keytool …`.

```bash
# Debug key — Gradle's debug-keystore convention (alias/passwords are fixed by it).
keytool -genkeypair -keystore debug.keystore -alias androiddebugkey \
  -storepass android -keypass android -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=Android Debug,O=Android,C=US"
base64 -w0 debug.keystore      # → ANDROID_DEBUG_KEYSTORE_BASE64

# Upload key — you choose the passwords.
keytool -genkeypair -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 upload.jks          # → ANDROID_UPLOAD_KEYSTORE_BASE64

# SHA-256 fingerprints for ANDROID_CERT_SHA256S (asset links, bd med-nt9p.2):
keytool -list -v -keystore debug.keystore -storepass android | grep SHA256
```

`ANDROID_CERT_SHA256S` on the cloud lists every certificate that may claim the
domain: the **debug** key above (for sideloaded CI APKs) and Play's **App
Signing** key (Play Console → Test and release → App integrity — Play re-signs
the upload, so the upload key's fingerprint is *not* the installed one). Keep
both keystores in stash; never commit them or their fingerprints. Secrets are
bound only to the steps that use them; the release ones only to dispatch-gated
steps, never job-wide.

## Shipping a build

- **Sideload (spike, friends' phones):** for a passkey-capable APK, dispatch
  the workflow on the branch (Actions → **Android** → Run workflow) or take
  master's run; a PR run's APK uses a throwaway key. Open the run →
  Artifacts → `medtracker-debug-apk`, unzip, install the APK (allow *Install
  unknown apps* for the browser/files app). A debug APK and a Play install share
  the package but not the signature — uninstall one to switch to the other.
- **Play internal testing:** Actions → **Android** → Run workflow → pick the
  branch. Google requires the **first** AAB of a new app to be uploaded by hand
  in Play Console: dispatch once the upload-key secrets exist (the service
  account is not needed yet), download the run's `medtracker-release-aab`
  artifact and upload it in Test and release → Internal testing. After that,
  with `ANDROID_PLAY_SERVICE_ACCOUNT_JSON` set, every green dispatch lands there
  by itself. While the app has never passed review, Play only accepts
  draft releases — dispatch with `release_status: draft` and roll the draft
  out in the Console.

## The shell (bd med-nt9p.5)

One Android System WebView on the account origin `https://<sub>.<base>/`,
exactly like the PWA — no bundled web code
([`MainActivity.kt`](../android/app/src/main/java/com/example/medtracker/MainActivity.kt),
twin of [`ios/App/Shell.swift`](../ios/App/Shell.swift)). Nothing outside
`android/` (and `android.yml`) changes for it. JavaScript, DOM storage and
Service Workers are on; passkeys use `WEB_AUTHENTICATION_SUPPORT_FOR_APP`;
remote debugging (`chrome://inspect`) is on only in debug builds.

- **First run** (invite-only, no signup): paste an invite/claim link, a device
  hand-off link or the account address, or *Scan QR code* — the `cloud admin
  invite` QR or the Emergency Kit QR (only its first line, the account URL, is
  read; the recovery code is never touched). The scanner is Google Play
  services' code scanner: no camera permission, no bundled model; where it is
  unavailable the screen says so and pasting still works.
  [`AccountUrl.kt`](../android/app/src/main/java/com/example/medtracker/AccountUrl.kt)
  accepts only `https` hosts exactly one label under `CLOUD_BASE_DOMAIN`
  (baked in by CI, never committed); `AccountUrlTest` runs the same cases as
  `ios/Tests/main.swift` in CI. The app stores the account **host** only,
  never the claim fragment, and opens `https://<host>/` on every later launch.
  A spike install's last account is adopted once, then the spike's data is
  deleted.
- **Navigation:** the account host and the base domain load in the app; every
  other link (and `mailto:`/`tel:`) opens in the browser or its own app.
  `target=_blank` / `window.open` load in the same WebView.
- **Offline:** a cold start offline is answered by the Service Worker; a native
  "Can't open your account" screen (Try again / Switch account) appears only
  when the very first load fails with nothing cached, or the host answers an
  HTTP error (a mistyped or deleted account is a 404). Try again keeps an
  invite link's `#claim=` fragment (in memory only). Unlike WKWebView, WebView
  replaces the page on a failed navigation, so a later page load that fails
  with no Service Worker answer gets the same screen (Try again reloads it).
- **Switch account:** long-press the launcher icon → *Switch account*; also on
  the load-error screen. WebView data is per origin and is kept, so switching
  back still finds offline data and warm unlock.
- **Chrome:** edge to edge; the bands behind the status and navigation bars
  take the page's own background colour at its top and bottom edge (a
  document-start script, [`assets/chrome.js`](../android/app/src/main/assets/chrome.js),
  reports it over the bridge; it reads styles and sets none — the page CSP is
  `style-src 'self'`), bar icons are light or dark to match, and the keyboard
  shrinks the page instead of covering it. Back walks the WebView history,
  then leaves the app.
- **Storage:** the same script calls `navigator.storage.persist()`, as on iOS.
- **Renderer crash or kill** (`onRenderProcessGone`): a fresh WebView reloads
  the current URL.
- **Downloads, print, files, camera** (med-nt9p.10,
  [`Files.kt`](../android/app/src/main/java/com/example/medtracker/Files.kt), twin
  of iOS [Downloads and printing](ios.md#downloads-and-printing-bd-med-w6gx11)).
  No web code changes. A document-start script,
  [`assets/files.js`](../android/app/src/main/assets/files.js), catches
  `<a download>` of a `blob:`/`data:` URL (it keeps each `createObjectURL`
  Blob, so a URL revoked right after `click()` still works) and posts it as a
  base64 data URL over a second listener, **`window.wgFiles`** (download and
  print only; capability ops stay on `wgNative`). The shell writes it to
  `cacheDir/downloads` and asks *Save to device* (`ACTION_CREATE_DOCUMENT`,
  temp file deleted after the copy) or *Share* (FileProvider; the file stays
  until the next download or launch — Android gives no "sheet closed" signal).
  https attachments go to the system DownloadManager **without** the WebView's
  cookies (DownloadManager re-sends request headers across redirects, to any
  host); cleartext http is refused (`AccountUrl.isDownloadable`, unit-tested).
  The app's own files are built in the page and take the blob path above.
  `window.print()` prints the page (`createPrintDocumentAdapter`); the
  offscreen-iframe print in `web/cloud/js/print-doc.js` sends the frame's
  document, which prints from its own offscreen WebView (no CSP, no script, no
  network), as on iOS. `<input type=file>` opens the system picker (accept
  types mapped to MIME, unknown extensions lift the filter), plus the camera
  when images are accepted and the camera permission is allowed (asked on
  first use). `getUserMedia` camera/mic is granted only to the account
  origin, after the Android runtime prompt.

### The bridge global: `window.wgNative`

The shell registers one `WebMessageListener` named **`wgNative`**, scoped to
`https://*.<base>`; WebView injects it as `window.wgNative` (with
`postMessage` and `onmessage`). Its presence is how web code detects the
Android shell — the twin of `window.webkit.messageHandlers.wgNative` on iOS —
and what med-nt9p.6 (`native/` android platform) and med-nt9p.19 gate on.
Only the stored account host's main frame is answered. Messages are JSON
strings `{op, args, id}`; when `id` is present the reply posted back to
`wgNative.onmessage` is `{id, result}` or `{id, error}` (`"forbidden"` for
any other origin or a subframe, `"unsupported: <op>"` for an unknown op).
Ops now: `ping` → `"pong"`; `chrome` `{top, bottom}` (the colour report, no
reply). On the page side `native/index.js` selects the `android` platform
when `window.wgNative` has `postMessage` + `addEventListener` and is neither a
Window nor a DOM node (an `<iframe name=wgNative>` must not clobber it; iOS is
checked first) and `__native.call(op, args)` does the id-correlated round trip;
`window.LocalNotifications` and `window.Health` install the same impls as on
iOS, so they report `isSupported()` and the passkey shell's
Add-to-Home-Screen step is skipped. Their `notifications.*` / `health.*` ops
reject `"unsupported: <op>"` until med-nt9p.7 / med-nt9p.8 add them to
`onBridge`.

### Device check (CI debug APK)

Needs med-nt9p.14 deployed (server accepts the app's `android:apk-key-hash`
origin) and med-nt9p.19 (claim PRF-probe fix) for the claim to finish; a
claim failure before those is not a shell bug. Dispatch the workflow on the
branch (a PR run's APK has a throwaway key), install the debug APK, then with
a test invite: claim it in the app and unlock with a Google Password Manager
passkey; kill and reopen (back on the account, no first run); airplane mode,
kill, reopen (renders from the Service Worker); open an external link (leaves
the app); long-press the icon → *Switch account* (first run; reopening the
same account finds its data); bad address → 404 screen → Switch account.

## Spike (med-nt9p.4): passkey PRF, Service Worker, IndexedDB in Android System WebView

The GO/NO-GO gate for the remote-origin design, twin of the iOS spike
med-w6gx.2 ([ios.md](ios.md)). The spike app (a diagnostic `MainActivity.kt`
plus `assets/spike-checks.js` and `assets/spike-tap.js`) was replaced by the
shell (med-nt9p.5); it lives in git history (commit `83888b7f`), and the
re-run below uses an APK built from that commit — dispatch `android.yml` on a
branch at it, or reuse an earlier run's `medtracker-debug-apk` artifact.

- One WebView with `WEB_AUTHENTICATION_SUPPORT_FOR_APP` (androidx.webkit
  1.12), JavaScript + DOM storage on, remote debugging on (`chrome://inspect`).
- **No domain in the build.** The account URL comes from the panel's text
  field (an invite link or `https://<sub>.<base>/`); `<base>` is the host
  minus its first label. The `wgSpike` WebMessageListener (ping/pong) and the
  document-start WebAuthn tap are bound to `https://*.<base>` before the load.
  The tap passes the app's own `navigator.credentials.create/get` through
  unchanged and logs `tap {...}` lines saying whether PRF came back — never
  the bytes.
- Camera: `onPermissionRequest` grants `VIDEO_CAPTURE` to account hosts only,
  after the Android `CAMERA` runtime prompt. Files: `onShowFileChooser`
  launches the system chooser.
- The app relaunches to the last account URL it loaded (fragment and query
  stripped), so kill/relaunch tests the account origin.
- The **Spike** button (right edge) opens the panel. Its report survives app
  kills (not *Clear storage*) and is redacted at write time: the base domain
  becomes `<base>`, each account label `<sub-xxxxxx>`. Passkey and file ops put
  a button at the bottom of the page — tap it (WebAuthn and the chooser need
  a user gesture).

- **Origin caveat — confirmed, resolved (bd med-nt9p.14).** In `FOR_APP`
  mode the WebView signs `clientDataJSON` with the app's origin,
  `android:apk-key-hash:<base64url cert SHA-256>`, never
  `https://<sub>.<base>` (confirmed on the first device run: every create and
  get). The server's WebAuthn config (`rpForRequest`,
  `internal/cloudserver/webauthn.go`) now also accepts, by exact match, one
  such origin per fingerprint in `ANDROID_CERT_SHA256S`, on every ceremony;
  the RP ID stays the account subdomain. A build signed with a cert missing
  from that list still fails server verification. Every passkey result logs
  `clientDataOrigin` (the cert hash redacted to `<cert>`); the probe ops never
  touch the server and decide platform support on their own.

### Owner prerequisites

1. `ANDROID_DEBUG_KEYSTORE_BASE64` secret and the `ANDROID_PACKAGE` variable
   (see Owner setup above). A **PR run's APK will not work** for checks 1–2:
   it is signed with a throwaway key. Dispatch the workflow on the spike
   branch (Actions → **Android** → Run workflow), or take master's run after
   merge, and download `medtracker-debug-apk`.
2. Production env: `ANDROID_PACKAGE` = the same package as the GitHub variable
   (the APK's applicationId; `com.example.medtracker` if the variable is
   unset) and `ANDROID_CERT_SHA256S` including the **debug** key's SHA-256
   (`keytool -list -v -keystore debug.keystore -storepass android`). Check that
   `https://<sub>.<base>/.well-known/assetlinks.json` lists both. Google
   caches asset links; a fresh change can take a while to apply.
3. Two invites from `cloud admin invite` — a dedicated test account, never a
   real user's: **A** (claimed in Chrome on the phone first, so it is an
   existing vault with a passkey in Google Password Manager) and **B**
   (claimed in the app: a subdomain no build ever named).
4. Android 14+ phone with Google Play services, Google Password Manager as
   the passkey provider (Settings → Passwords & accounts), a screen lock, and
   *Install unknown apps* allowed for the app that opens the APK.

### On-device checklist

Install the dispatch APK. Copy the report (panel → *Copy report*) at the end,
and before any *Clear storage*, and paste it into the bead.

1. **Launch line (check 7).** Open the panel: the first `launch` line names
   Android version/build, WebView package + version, app versionCode, and
   `webauthn for-app (read back <n>)` (`WEB_AUTHENTICATION_SUPPORT_FOR_APP`). `UNSUPPORTED` here is already a NO-GO
   candidate — update Android System WebView from Play and retry.
2. **Claim B in the app (1, 2).** Paste B's invite link → *Open* → finish the
   claim. Expect `tap` lines `webauthn.create … ok:true` and
   `webauthn.get … ok:true, prfFirst:true`, and the app unlocked. Note the
   passkey sheet's provider (Google Password Manager or another) for check 7,
   and `clientDataOrigin`. If it is `android:apk-key-hash:<cert>` and the claim
   fails after the passkey sheet with an origin error, the APK's signing cert
   is missing from the cloud's `ANDROID_CERT_SHA256S` (Origin caveat above),
   not a platform failure: record it, fix the env, and go on to step 3. Same
   for step 9.
3. **Probe on B (1, 2).** *Passkey create + PRF* → tap the page button
   (creates "Android spike - delete me"; delete it in Password Manager
   afterwards) → *Passkey get + PRF* → tap. Expect `ok: true` on both and
   `prfFirstBytes: 32` on the get.
4. **Checks on B (3, 4, 5, 6).** *Run checks*, allow the camera. Expect
   `bridge.reply.pong: true` with `rttMs`, `serviceWorker.registrations` with an
   `activated` worker, `idb.keyUsable: true`, `keyExtractable: false`,
   `camera.videoTracks: 1`.
5. **File chooser (5).** *File chooser* → tap the page button → pick an
   image. Expect `onShowFileChooser` in the log and `files: 1`.
6. **Kill/relaunch (3, 4).** Swipe the app away from recents, reopen. Expect
   it back on B, unlocked with **no** passkey prompt (warm unlock). *Run
   checks*: `idb.markerFromEarlierLaunch: true`, `keyFromEarlierRun: true`,
   `keyUsable: true`, `serviceWorker.controlled: true`.
7. **Offline (3).** Airplane mode on, kill, reopen. Expect the app to render
   from the Service Worker, not a WebView error page; *Run checks*:
   `online: false`, `controlled: true`. Airplane mode off.
8. **APK update (4).** Dispatch the workflow again (new run = new
   versionCode), install that APK over this one (same debug key, so it
   updates in place). Reopen: still on B, warm unlock; *Run checks*:
   `markerFromOlderVersion: true`, `keyFromEarlierRun: true`, `keyUsable: true`.
9. **Cold unlock of A (2).** *Copy report* first. Android Settings → Apps →
   Med Tracker → Storage → *Clear storage* (wipes WebView data and the
   report). Open the app, paste A's account URL `https://<A>.<base>/` →
   *Open* → unlock with the passkey made in Chrome. Expect
   `tap webauthn.get … ok:true, prfFirst:true` and the vault's data.

**Step 2b: read the retry lines (med-nt9p.18).** If the claim's immediate PRF
probe `get` fails `NotReadableError`, the spike now retries it after 1, 3, 8,
20 and 45 s (about 77 s) and the claim completes on the first success. In the
report, read the `webauthn.get.first` line and each `webauthn.get.retry` line
(`attempt`, `delayMs`, `sinceFirstFailMs`, `ok`, `error` or `prfFirst`,
`allowCredentials`). Record the first `sinceFirstFailMs` with `ok:true`: that is the propagation delay. All
five failing with `allowCredentials:1` points to allowCredentials never
working in FOR_APP mode, not a delay.

**Step 3b: long-delay get.** After step 3's create, tap *Passkey get after 120 s*,
wait for the countdown, tap the page button. Compare with step 3's immediate
get: both log `webauthn.get … allowCredentials:1`. Immediate fail and 120 s
pass means delay; both fail means allowCredentials in FOR_APP mode.

### GO / NO-GO criteria

| # | Check | GO when | On failure |
|---|-------|---------|------------|
| 1 | Passkey create + get on an arbitrary subdomain | steps 2, 3, 9 `ok:true` | **NO-GO** — stop, back to the architect (a Credential Manager bridge would be the fallback) |
| 2 | PRF in the WebView | `prfFirst:true` on the claim and the cold unlock of A; probe `prfFirstBytes: 32` | **NO-GO** — same as 1 |
| 3 | Service Worker | worker activated, controlled after relaunch, offline relaunch renders | NO-GO for this design — architect |
| 4 | IndexedDB + non-extractable key survive kill and APK update | steps 6 and 8 values true, warm unlock without a prompt | NO-GO for this design — architect |
| 5 | Camera + file chooser | `videoTracks: 1`; chooser opens, `files: 1` | gotcha for med-nt9p.10 — architect decides |
| 6 | JS → Kotlin reply round trip | `bridge.reply.pong: true` | NO-GO for the bridge bead (med-nt9p.6) — architect |
| 7 | Versions; passkey provider | recorded | record only |

GO = 1–4 and 6 pass. If the probes pass (`ok:true`, `prfFirstBytes: 32`)
but `clientDataOrigin` is the app origin, 1–2 are a platform pass with a
server prerequisite — the additive server change (accept
`android:apk-key-hash:` origins derived from `ANDROID_CERT_SHA256S`,
med-nt9p.14, now in place) — and steps 2 and 9 are re-run on it.

### Results

The first device run (2026-10-18) passed the platform probes and confirmed the
app origin; its write-up lands here with the re-run of steps 2 and 9
(med-nt9p.4). Until then the table is unfilled.

| # | Check | Result |
|---|-------|--------|
| 1 | Passkey create + get on an arbitrary subdomain (+ `clientDataOrigin`) | pending device run |
| 2 | PRF (claim, probe, cold unlock of a Chrome-made passkey) | pending device run |
| 3 | Service Worker registers, controls, offline relaunch | pending device run |
| 4 | IndexedDB + non-extractable key across kill and APK update | pending device run |
| 5 | `getUserMedia` camera; `<input type=file>` chooser | pending device run |
| 6 | WebMessageListener ping/pong, rtt | pending device run |
| 7 | Android build, WebView version, passkey landed in GPM? | pending device run |

**Verdict:** pending device run.

## Reviewer access (bd med-nt9p.12)

The app is invite-only and unlocks only with a passkey bound to the account's
own subdomain, so there is no username or password to hand over. Reuse the
iOS runbook in [ios.md → Reviewer access](ios.md#reviewer-access) unchanged:
mint a sacrificial link plus three fresh ones with `./cloud admin invite` in
the real production container (Portainer exec), dry-run the sacrificial one,
check the other three with `register/begin`, re-mint or `reset-claim` on delay
or resubmission, clean up after the review is final. Claim URLs, recovery
codes and the owner's account never go in this repo.

**Play Console → App content → App access** ("All or some functionality is
restricted"; add instructions). Suggested wording, with the links filled in
privately:

> Med Tracker is invite-only; accounts have no password. Open the app, paste
> invite link A into the first-run screen and create a passkey on this device
> (Google Password Manager; a screen lock is required). The account starts
> empty. Link B is for testing account deletion (Settings → Account &
> privacy → Delete my account); link C is a spare, for a new device or a
> reinstall. Suggested walk-through: add a medication, record a dose and a
> blood-pressure reading, open History, enable reminders. Health Connect
> import needs data in the reviewer device's Health Connect. Contact for a new
> link: <phone/email answered within a day>.

Links expire 14 days after minting if unclaimed; mint just before
submission.

## Friends: install the APK

Before (or without) Play, friends sideload the release build. It is signed
with the **upload key**, so that key's SHA-256 must be listed in
`ANDROID_CERT_SHA256S` on the cloud (next to the debug key and Play's App
Signing key), or passkeys will not bind to the app:
`keytool -list -v -keystore upload.jks | grep SHA256`. Never commit it.

Owner, per build: Actions → **Android** → Run workflow → pick the branch →
tick *publish_apk_release*. Needs the upload-key secrets (without them the run
skips the release build and names what is missing). The run publishes a GitHub
pre-release `android-v0.1.<run>` with `medtracker.apk`; send friends its link
and an invite from `./cloud admin invite`.

Friend, on an Android 14+ phone:

1. Open the release link and download `medtracker.apk`.
2. Allow *Install unknown apps* for the browser or Files app when prompted,
   then open the APK and install.
3. Open Med Tracker, paste the invite link, create the passkey.

A Play install and this APK share the package but not the signature:
uninstall one before installing the other (the vault is on the server and
unlocks again with the passkey, but local-mode data would be lost). Updating
means installing the newer release over the old one.

## Known limitations

- **OEM background killers.** Xiaomi, Huawei, Oppo, Samsung and others may kill
  the app or drop its exact alarms; reminders can then arrive late or not at
  all. Allow unrestricted battery use and, where offered, autostart for the app
  (see dontkillmyapp.com for the per-vendor steps).
- **No Google Play services, no passkey PRF.** The vault key derives from the
  passkey PRF, which the Credential Manager provides only with Google Play
  services and a passkey provider (Google Password Manager or another).
  Devices without them (some de-Googled and Huawei phones) cannot create or
  unlock an account in the app.
- Minimum Android 14 (API 34).
