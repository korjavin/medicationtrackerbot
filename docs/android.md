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
| `ANDROID_PLAY_CLOUD_PROJECT_NUMBER` | the Google Cloud project number linked to the app for Play Integrity ([Play Integrity setup](#play-integrity-setup-owner)); becomes `BuildConfig.PLAY_CLOUD_PROJECT_NUMBER`. Unset (forks, QA): the local-mode free trial reports unsupported and its Settings row stays hidden |
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
  deleted. Below the buttons, as on iOS (bd med-nt9p.31): the "not a medical
  device" footnote (same wording as `ios/App/App.swift` and the store listing)
  and a *Privacy policy* link that opens `docs/privacy-policy.md` in the browser.
  Layout and states are N1 of `docs/design/claude-design/ui_kits/app-v2/screens-native.html`
  (bd med-ckm5.14): **Continue** is the only sun and stays enabled; an empty
  or unknown address, a failed scan and "There is no account at <host>." are
  inline field errors (danger line, icon, and a second line saying what to
  do), and the gone account's address stays in the field. At font scales
  ≥ 1.5 the placeholder shortens to "Invite link"; the column scrolls and
  fades at the bottom while more is below.
- **Invite links** (bd med-ta2n.12.1, twin of iOS med-ta2n.11; contract in
  `bd show med-ta2n.7` design §§1–7, A1–A7): `InviteLinkActivity`
  ([`Invite.kt`](../android/app/src/main/java/com/example/medtracker/Invite.kt))
  owns two filters — the App Link `https://<base>/i/<sub>#<token>`
  (`autoVerify`; the host is the `baseDomain` manifest placeholder from
  `CLOUD_BASE_DOMAIN`; the server's `assetlinks.json` already lists
  `handle_all_urls`) and `medtracker://i/<sub>#<token>` (the landing page's
  "Open in the app") — and forwards them to `MainActivity` the way a reminder
  tap arrives (`CLEAR_TOP | SINGLE_TOP`: `onNewIntent` when running, else a
  cold start), so `MainActivity` keeps launch mode standard and no second shell
  stacks up. `AccountUrl.parseInvite` turns either form (or an old claim link)
  into the claim URL `https://<sub>.<base>/#claim=<token>`, checking the raw
  path and fragment (`java.net.URI`): sub `^[a-z0-9-]+$` after lowercasing,
  token `^[0-9a-f]+$`, no port, userinfo or query; `AccountUrlTest` runs iOS's
  `inviteVectors` unchanged. The claim URL goes into the **pending slot**
  (`shell` prefs `wgPendingInvite` + `wgPendingInviteAt`, epoch ms, written
  with `commit()`; newest wins, never expired by the shell) — only on a fresh
  delivery (`savedInstanceState == null`, not `FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`),
  and the intent is consumed. A capture never opens anything (any app can fire
  the scheme): the native first run prefills its field and the user taps
  Continue; with a page up (either mode) the shell reloads that mode's home with
  `?invite=1` (history cleared, deferred under the lock); on a cold start
  nothing more — the booting page reads the slot.
  **Play Install Referrer** (`installreferrer:2.2`): on a true first install
  only (no `accountHost`, no `wgLocalMode`, flag `wgInstallReferrerDone` unset —
  an upgrade sets the flag without reading) the shell reads `installReferrer`
  once, takes `invite=<landing URL>` (decoded once, then `parseInvite`) and
  fills the slot only if it is still empty, dated by Play's click time. The
  emulator has no Play: the hand-off is an owner internal-track check.
  Bridge ops (both modes): `invite.pending` → `{url, receivedAt}` or `null`;
  `invite.clear` → `true`; `clipboard.read` (Android only) → the primary clip's
  text or `null`; `local.reset` also clears the slot. `local.leave {url}` /
  `account.leave {url}` validate with `AccountUrl.parse` (fragment kept,
  `&kit=1` included; else error `invalid url`, nothing changes — a present
  `url` that is `null`, empty or not a string included, A3), then
  `enterAccount`: store the host, leave local mode, drop `leaveHost`, the leave
  stash and the slot, and load the URL (`then` ignored). `local.leave {url}`
  keeps the move stash for the new account; `account.leave {url}` drops it.
  Without a url both keep their pre-v3 behaviour until phase 2 (med-ta2n.12)
  removes the native first run. QA scenario `invite-link`.
- **Native token mirror** (bd med-ckm5.14, the "Native token mirror" table):
  `res/values/colors.xml` (`wg_*`, values from the kit's `tokens.css`),
  `res/color/wg_fg_{2,3,4}.xml` (alpha state lists), `res/values/dimens.xml`,
  `res/values/styles.xml` (`Widget.Wg.Button[.Primary|.Ghost|.Back]`,
  `Widget.Wg.IconButton`, `Widget.Wg.EditText`, `Widget.Wg.Switch`,
  `Widget.Wg.Row`, `Widget.Wg.Note.{Info,Warn,Danger}`, `Widget.Wg.Text.*`),
  gradient drawables and the kit icons as vectors (`res/drawable/wg_*`,
  `ic_wg_*`), and the fonts in `res/font` — Space Grotesk 400/500/600 (the
  upstream variable TTF pinned per weight in `wg_ui.xml`) and JetBrains Mono
  500 (`wg_mono.xml`), both OFL, licences in `assets/licenses/`. Type is in
  sp, so Android's non-linear font scaling applies. Plain Views only, no
  Material/appcompat: [`Wg.kt`](../android/app/src/main/java/com/example/medtracker/Wg.kt)
  builds them for MainActivity and `PermissionsRationaleActivity`.
- **Icon and splash** (bd med-nt9p.26): the launcher icon is an adaptive icon
  whose foreground is the PWA's `web/static/icons/icon-512.png` (same bytes,
  inset 1/6 so the maskable safe zone fits) on `#132D29` (`--wg-bg-screen`);
  `icon-192.png` is the legacy `mipmap-xxxhdpi` fallback. `Theme.MedTracker`
  (`res/values/themes.xml`) is **pinned dark, no DayNight** (bd med-ckm5.14):
  the window, the Android 12+ splash, `colorBackground`, the WebView
  background, the system-bar bands and every native screen are `wg_screen`
  in light and dark mode alike, so a cold start never shows a white or grey
  frame. The splash icon is the mark tile (`wg_splash_mark`, sized so the
  system's icon scaling lands it at the lock screen's 96dp `wg_mark_lg`, in
  the same spot); MainActivity holds the first
  frame (an `OnPreDrawListener`) until the page posts its first `chrome`
  sample or commits a visible frame, or a native screen shows (capped at
  5 s), then the mark fades out over 180 ms (N6, bd med-ckm5.16). A new icon means
  replacing both PNGs from `web/static/icons`.
- **Navigation:** the account host and the base domain load in the app; every
  other link (and `mailto:`/`tel:`) opens in the browser or its own app.
  `target=_blank` / `window.open` load in the same WebView.
- **Offline:** a cold start offline is answered by the Service Worker; a native
  load-error screen (N4, bd med-ckm5.16: "Can't reach your account" with Try
  again / Switch account / Copy diagnostics and a mono status line; a bare 404
  is "We can't find this account" with Use another invite first) appears only
  when the very first load fails with nothing cached, or the host answers an
  HTTP error. Only the server's own "no such account" 404 — marked
  `X-Account-Gone: 1` by `internal/cloudserver/router.go` (a mistyped account,
  or one deleted here, on another device or by the operator) — on the stored
  host before any page of the account showed forgets the host and returns to
  the first run with "There is no account at <host>." (bd med-nt9p.32.14,
  `AccountUrl.accountGone`). A bare 404 (the proxy's while the server
  redeploys, or an older server) keeps the account and this screen. Try again keeps an
  invite link's `#claim=` fragment (in memory only). Unlike WKWebView, WebView
  replaces the page on a failed navigation, so a later page load that fails
  with no Service Worker answer gets the same screen (Try again reloads it).
- **Switch account:** long-press the launcher icon → *Switch account*; also on
  the load-error screen. WebView data is per origin and is kept, so switching
  back still finds offline data and warm unlock.
- **Use another invite** (bd med-nt9p.20; web-owned since med-ckm5.2/.16): on
  a ceremony page (`/unlock`, `/claim`, `/recover`) the page draws its own exit
  bar at the top (`web/cloud/js/exitbar.js`, "Not your account?"); after an
  in-page confirm it calls `account.leave` with no args, which does Switch
  account. The shell has no bar or dialog of its own any more;
  `AccountUrl.isCeremony` only clears Back history on leaving the ceremony. A bad or already-claimed invite
  otherwise has no way back (the host is stored the moment the link parses).
  Passive: a returning user unlocks as before.
- **Use this phone without an account** (bd med-nt9p.32.15, iOS twin in
  [ios.md](ios.md)): Settings → Account shows the row only once `shell.ops`
  lists `account.leave` (settings.js `nativeHas`, one probe per page; an APK
  without `shell.ops` rejects the probe and never shows it). After a
  `safeConfirm` it calls `CloudVault.leaveAccount({ then: 'local' })` → bridge
  op `account.leave {then: "local"}`: the shell forgets the account host and
  opens local mode directly. Nothing is erased (the account on the server, the
  account origin's WebView data on the phone). A shell that rejects the op
  makes the page point at Google Play or the launcher's *Switch account*
  (`LocalNotifications.copy.leaveFallback`).
- **After account deletion** (bd med-nt9p.32.15): once the server delete and
  the local wipe finish, the page calls `leaveAccount()` with no args and the
  shell shows its native first run, not the base-domain page (which the shell
  renders in-app with no way out). An APK without the op rejects and the page
  keeps that redirect. `android-qa.yml` scenario `delete-account` drives both
  paths end to end.
- **Chrome:** edge to edge; the bands behind the status and navigation bars
  take the page's own background colour at its top and bottom edge (a
  document-start script, [`assets/chrome.js`](../android/app/src/main/assets/chrome.js),
  reports it over the bridge; it reads styles and sets none — the page CSP is
  `style-src 'self'`), bar icons are light or dark to match, and the keyboard
  shrinks the page instead of covering it. Back walks the WebView history,
  then leaves the app (the manifest's `enableOnBackInvokedCallback="true"`
  makes this work on Android 14/15, not only 16+). Portrait only, like iOS
  (Android 16 still rotates on large screens).
- **WebView settings** (iOS parity, bd med-nt9p.28): `textZoom` fixed at 100
  (the system font size does not scale the page; pinch-zoom is on instead,
  as in Safari), no overscroll glow, and Safe Browsing off (manifest
  meta-data) — only own hosts load, so no URL checks go to Google.
  `VIBRATE` is declared so `navigator.vibrate` (rest timer) buzzes.
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
reply); `diag.append` (the passkey log, no reply; below); `health.authorize` / `health.query` (below). On the page side `native/index.js` selects the `android` platform
when `window.wgNative` has `postMessage` + `addEventListener` and is neither a
Window nor a DOM node (an `<iframe name=wgNative>` must not clobber it; iOS is
checked first) and `__native.call(op, args)` does the id-correlated round trip;
`window.LocalNotifications` and `window.Health` install the same impls as on
iOS, so they report `isSupported()` and the passkey shell's
Add-to-Home-Screen step is skipped. Their `notifications.*` and `health.*`
ops are answered (below).

### Passkey gets are discoverable in the shell (bd med-nt9p.19)

A passkey created inside the WebView (`FOR_APP` mode sets no web origin on
the Credential Manager request) is filed by Google Password Manager as an
**app** credential: GPM lists it under the bare account label, and no
`get` carrying `allowCredentials` ever matches it (the sheet falls back to
"another device", or Credential Manager throws `NotReadableError`), while a
discoverable get finds it. Chrome-created passkeys are web credentials and
match either way. So every `get` in the cloud shells goes through
[`web/cloud/js/passkey-get.js`](../web/cloud/js/passkey-get.js), which, only
when `window.wgNative` is the bridge (same detection as `native/index.js`),
sends `allowCredentials: []` and retries `NotReadableError` (1 s, 2 s, 4 s).
Callers: the post-create PRF probe in `signup.js` / `claim.js` (`prfProbe`,
which then requires the returned `rawId` to be the one just created), cold
unlock / session renewal (`unlock.js`) and account delete. The rpId is the
account host, so the sheet lists only that account's passkeys; the server
still verifies the asserted credential belongs to the account
(`login/finish`, `DELETE /api/account`). On web and iOS the request is
unchanged and sent once.

Device logs showed the probe right after create fails once every time
(`NotReadableError`, sometimes `NotAllowedError`) and succeeds ~1 s later;
what broke the claim was a tap landing as the Credential Manager sheet closed,
which started a second `register/begin` + create mid-backoff ("A request is
already pending"; finish then 400'd on the superseded challenge). So under the
bridge: the probe waits 1.5 s after create and also retries `NotAllowedError`
once (it is also a user cancel, so the sheet reopens at most once;
`NotReadableError` keeps 1/2/4 s), and `passkeyCeremony` (signup, claim/recover
enrollment, cold unlock) holds one ceremony from begin to finish — a steady
busy step with no button and no intermediate errors, extra taps dropped — and
turns a browser error into one plain message whose button restarts with a
fresh begin.

### Passkey diagnostics log (bd med-nt9p.22)

Inside the shell only, every passkey ceremony is logged so a failure on a
real phone can be pasted into a bead. [`web/cloud/js/passkey-diag.js`](../web/cloud/js/passkey-diag.js)
(the same shell detection; on the web it returns before doing anything, and
iOS logs the same entries to its own shell — docs/ios.md, bd med-w6gx.24) posts one `diag.append {entry}` per server step (`register/begin`
/ `finish`, `login/begin` / `finish`, `account/reauth` / `delete`: HTTP
status) and per `navigator.credentials` call — `create`, `get`, or the
post-create `probe`, one entry per retry attempt: ms since the ceremony's
begin, page path, rp id, the caller's `allowCredentials` length (the shell
sends `[]`), userVerification, residentKey / authenticatorAttachment, PRF
requested; then ok + a 3-byte SHA-256 tag of the rawId, whether it is in the
caller's allowlist, PRF length — or the error name and message. Never logged:
credential IDs, user handles, PRF output, challenges, invite tokens, URL
fragments. The shell ([`Diag.kt`](../android/app/src/main/java/com/example/medtracker/Diag.kt),
`DiagTest`) timestamps each entry, redacts it at write time like the spike
(base → `<base>`, account label → `<sub-xxxxxx>`, cert hash → `<cert>`) and
keeps the last 200 lines in its own SharedPreferences file, so the log
survives reloads, kills and Switch account (not *Clear storage*). It also logs
the WebView's WebAuthn mode (`for-app` …) whenever it creates one.

**Copying it:** long-press the launcher icon → **Copy diagnostics**, or
**Copy diagnostics** on the load-error screen (N4). The clipboard gets a header (app version + versionCode, Android
version / SDK, device model, WebView package + version, the credential and
autofill providers where Android exposes them, WebAuthn mode) followed by the
log; paste it into the bead.

### Reminders: local notifications (bd med-nt9p.7)

WebView has no Web Push, so reminders are exact local alarms from the
client-computed horizon — the twin of iOS
([`Notifications.kt`](../android/app/src/main/java/com/example/medtracker/Notifications.kt),
[`ios/App/Notifications.swift`](../ios/App/Notifications.swift)). No web or
server change, no FCM. The page (`web/cloud/js/reminders.js`) sends the same
replace-all list it sends on iOS — at most 64 rows `{fireAtUnix, title, body,
section}`, the last one the "Open the app to keep reminders running" notice.

- **Ops:** `notifications.permission` / `requestPermission` → `granted`
  only when **both** grants exist, else `default` (or `denied` once the
  notification prompt was refused); `schedule {items}` → how many alarms are
  armed; `test` → one notification now; `openSettings` (no args, bd
  med-ckm5.16: the denied note's *Open Android Settings*, web #1218) → the
  app's notification settings, then *Alarms & reminders* while that is
  missing too (straight to it when notifications are on), replying
  `permission()` once the user is back.
- **Enable** (Settings → Notifications) walks both system grants: the
  `POST_NOTIFICATIONS` prompt (or the app's notification settings once it was
  refused), then *Alarms & reminders* (`ACTION_REQUEST_SCHEDULE_EXACT_ALARM`;
  `SCHEDULE_EXACT_ALARM` is off by default for new installs on Android 14+).
  The reply waits until the user is back from each screen. `USE_EXACT_ALARM`
  is not used (Play keeps it for alarm and calendar apps).
- **Schedule** cancels the previous alarms, stores the rows in app-private
  storage (plaintext, like iOS's pending requests; capped at 200) and arms
  **one** `setExactAndAllowWhileIdle` alarm at the next row; when it fires it
  posts every row now due and arms the next. Doze rate-limits allow-while-idle
  alarms per app, so same-time reminders share one wake and a late wake still
  posts what it missed (rows missed by over an hour, e.g. while the phone was
  off, are dropped). Without both grants it stores the rows and arms nothing;
  granting *Alarms & reminders* later arms them, as do a reboot and an app
  update (alarms survive neither). Notifications post on the high-importance
  **Reminders** channel; switching that channel off counts as `denied`, and
  Enable opens its settings.
- **Tap** opens the reminder's section (`/?tab=<section>`, stable ids), in the
  open page or by loading the account on it. Switching account clears the
  previous account's alarms; the newly opened page schedules its own.
- **Not in v1:** Confirm/Snooze actions. The web copy around the toggle still
  says iPhone/iOS Settings.

### Health Connect import (bd med-nt9p.8, med-nt9p.9)

The twin of the Apple Health import ([ios.md](ios.md)): Health Connect → the
page → the encrypted vault, like a hand-entered reading. READ-ONLY; Health
Connect is part of the Android 14 framework, so there is no provider app to
install. [`HealthConnect.kt`](../android/app/src/main/java/com/example/medtracker/HealthConnect.kt)
answers the same `health.authorize {types}` / `health.query {type, anchor,
limit}` (and `{type: 'sleep', from, to}`) ops as `ios/App/Health.swift` with
the same sample shapes (`bp` `{uuid, start, systolic, diastolic}`, `weight`
`{uuid, start, kg}`, `sleep` `{uuid, start, end, value, source, tz?}`,
`workout` `{uuid, start, end, activity, duration, hr?, energy?, distance?}`),
so `web/cloud/js/health-import.js` and `web/domain/healthimport.js` run
unchanged (same `-hk-<uuid>` / `sleep-hk-<day>` record ids and `source:
'apple_health'` marker — the existing shapes, which every client already
reads). The Settings row reads its name ("Health Connect") and access hint off
the capability (`window.Health.label` / `accessHint`, `native/health.js`).

- **Permissions:** `READ_BLOOD_PRESSURE`, `READ_WEIGHT`, `READ_SLEEP`,
  `READ_EXERCISE`, and a workout's totals `READ_HEART_RATE`,
  `READ_TOTAL_CALORIES_BURNED`, `READ_DISTANCE` — the Play declaration must
  list exactly these. `health.authorize` requests the missing ones (a runtime
  permission dialog on Android 14) and answers `true` whenever Health Connect
  exists, `false` when it doesn't (work profile, no service); like HealthKit, a
  denied type just returns no samples.
- **Upgrade from the .8 build:** it answered `authorize` for sleep/workout
  without asking, and the page recorded all four kinds as asked
  (`wg.health.asked`), so the web re-ask never fires. The shell keeps its own
  record of requested kinds (SharedPreferences `health`/`asked`); the first
  `query` of a kind it never requested asks, in one dialog, for every such
  kind. On a fresh install `authorize` records them, so this never re-asks.
- **Anchor:** `hc1:` + a Health Connect Changes token. No anchor reads the
  last **30 days** (`READ_HEALTH_DATA_HISTORY` for older data is out of v1)
  and starts a token; later queries return only upserts since it. An expired
  token (unused for 30 days) re-reads the 30 days; known readings are skipped
  by id.
- **Sleep:** each `SleepSessionRecord` becomes HealthKit-style
  `HKCategoryValueSleepAnalysis` samples, one per stage (sleeping/unknown → 1
  asleep, awake/awake-in-bed → 2, light → 3 core, deep → 4, REM → 5;
  out-of-bed dropped, like inBed), or one "asleep" sample for a session
  without stages; `source` is the writing app's package. A page answers every
  session overlapping the new ones ± 48 h with that `{from, to}` window, as
  Health.swift does. `tz` is `Etc/GMT±h` for a whole-hour end offset (the
  page needs only the offset), else the `+05:30` offset form — from the
  session's own offset, never this device's zone, so rescans agree.
- **Workouts:** `ExerciseSessionRecord`; `activity` is the
  `HKWorkoutActivityType` raw value (a small map in `hkActivity`; unmapped →
  3000, shown as "Workout") so the page's name table and strength rule apply.
  `duration` (active, pauses excluded), `hr` (average bpm), `energy` (total
  kcal) and `distance` (m) aggregate the
  session's own app over its window, each only when its permission is granted.
  Note: `energy` is *total* calories, iOS reads *active* energy.
- **Foreground only:** reads run only when the page asks (unlock, return to
  the app); no background reads, no background permission.
- **Rationale screen:** `PermissionsRationaleActivity` answers Health
  Connect's `ACTION_SHOW_PERMISSIONS_RATIONALE` and Android 14's
  `VIEW_PERMISSION_USAGE` (activity alias), and links the privacy policy
  ([privacy-policy.md](privacy-policy.md)).
- **Device check:** Settings → Health Connect on, allow all types; add a BP
  reading and a weight in Health Connect (or a fitness app) → they appear in
  Vitals; add one more and reopen the app → only the new one is added; deny a
  type → no samples, no error. A night and a workout recorded by a fitness
  app → the sleep day and the workout appear (sleep ~3 h after waking, once
  settled); updating from a .8 build shows one dialog for the new types.

### Device check (CI debug APK)

Needs med-nt9p.14 deployed (server accepts the app's `android:apk-key-hash`
origin) and med-nt9p.19 (claim PRF-probe fix) for the claim to finish; a
claim failure before those is not a shell bug. Dispatch the workflow on the
branch (a PR run's APK has a throwaway key), install the debug APK, then with
a test invite: claim it in the app and unlock with a Google Password Manager
passkey; kill and reopen (back on the account, no first run); airplane mode,
kill, reopen (renders from the Service Worker); open an external link (leaves
the app); long-press the icon → *Switch account* (first run; reopening the
same account finds its data); bad address → first run with "There is no
account at …" (no error screen); paste an already-claimed or garbage
invite → "Not your account?" at the top of the page → confirm →
first run → a valid invite claims (also after kill + relaunch while stuck).

## Agent QA harness (emulator) (bd med-nt9p.23)

[`android-qa.yml`](../.github/workflows/android-qa.yml) (manual dispatch only,
no secrets, separate from `android.yml`) builds a debug APK with the public
placeholder base `qa.test` and package `com.example.medtracker`, boots an
API-34 `google_apis` x86_64 emulator, and drives
[`android/qa/scenarios/`](../android/qa/scenarios) with Playwright for Android
([`run.mjs`](../android/qa/run.mjs); UiAutomator selectors for the native
screens, `device.screenshot()` for the full screen incl. bars and keyboard).
**Emulator results are discovery evidence, never sign-off** — the owner's phone
stays the acceptance device.

```bash
gh workflow run android-qa.yml --ref <branch> -f scenario=all            # or firstrun, native-screens, native-dark, native-lock, native-fontscale, back-exit, claim-page, not-found, external-link, authn-probe, local-smoke, smoke, local-visual, local-app, local-backup, local-spike, local-to-cloud, local-to-cloud-seamless, move-ops
gh workflow run android-qa.yml --ref <branch> -f scenario=firstrun -f font_scale=1.3 -f dark=true -f landscape=true
gh run download <run-id> -n android-qa-<scenario> -D /tmp/qa             # then Read the PNGs
```

Playwright attaches to the shell's WebView on the runner (the CDP fallback is
not needed). The emulator is flaky right after boot (Play services restarts can
kill the app, the launcher ANRs), so `run.mjs` waits 45 s, dismisses "isn't
responding" dialogs, and retries a failed scenario once; the failed attempt
stays in the summary marked *retried*. A whole run takes ~8 min.

Artifact `android-qa-<scenario>`: `screenshots/<scenario>-<name>.png` (plus
`<scenario>-FAILED<attempt>.png` where one stopped), `qa-summary.json` (inputs, every
step's pass/fail, screenshot list — also the run's step summary), `logcat.txt`
(`adb logcat -d`; WebView console lines are under the `chromium` tag), and
`diag.xml` (the shell's passkey log, `run-as … cat shared_prefs/diag.xml`).

`native-screens` (on its own, no invite; bd med-ckm5.14) shoots N1 and N2 for
reading against the kit frames: first run, the empty-field error, Scan, the
gone-account error (`nobody.qa.test`), the intro, the lock switch on (a
throwaway `locksettings` PIN, removed after), the move hint and the
pending-move intro (a fake `run-as` stash file, removed after), and the
Health Connect rationale. Dispatch it again with `-f font_scale=2.0` for
N1 · 2×. `native-dark` now differs from `firstrun` in nothing but the
system setting: the theme is pinned dark.

A scenario is `android/qa/scenarios/<name>.mjs` exporting one
`async (ctx) => {}`; add its name to `SCENARIOS` in `run.mjs` and to the
workflow's `scenario` options. `ctx`: `device` (Playwright `AndroidDevice`),
`shell(cmd)`, `shot(name)`, `step(name, fn)` (reported; a throw stops the
scenario), `launch()` (cold start on first run), `openAccount(url)`,
`inForeground()`, `attachPage()` (Playwright `page` on the shell's WebView, for
DOM/console/CDP), `openLink(url)`, `openClaim({ softAuthn })` (cold start → the run's
invite → `page` on the `/unlock` signup wizard), `launchLocal(scene?, { extra })`
(below), `stableShot(name)` (shoots once two frames a second apart match — the
software GPU paints seconds behind the DOM), `tapElement(page, selector)` (a
real touch on a DOM element), `imeShown()`, `claimUrl`, `results` (named
findings for the summary), `log`. The dispatch inputs are re-applied after
every scenario, so a scenario may change them freely.

### Local-mode scenarios (bd med-nt9p.32.6)

Every unlocked-vault path in cloud mode needs a passkey; local mode needs none.
**A passkey-free full-app run is `gh workflow run android-qa.yml -f
scenario=local-smoke`.** The QA APK carries a `QA=1` bundle (prefix
`android-qa`, so the build id tells it apart): the visual QA driver
([`tests/visual/driver.js`](../tests/visual/driver.js)) at `/qa/*`, which on
`?qa=<scene>` seeds the golden vault into the empty local store, navigates and
publishes `#wg-qa-ready`. `ctx.launchLocal(scene?, { extra = true })` =
force-stop + `am start … --ez wgLocalMode true [--es wgQAScene <scene>]` (the
debug + `qa.test` extras of [Local mode: the shell](#local-mode-the-shell-bd-med-nt9p324);
`extra: false` relaunches on the persisted pref alone), then waits for
`#wg-qa-ready` (scene) or the bottom nav. The QA bundle never ships:
`android.yml` bundles without `QA=1`, its debug-APK check fails on any
`assets/web/cloud/qa/`, and a release dispatch checks the release APK and AAB
the same way.

- **`local-smoke`** (in `all`, before `smoke`): `pm clear`, notifications
  granted → cold start on scene `today` → every tab (Today, Meds, Vitals,
  Food, Settings; each a stable shot after its content and the bottom nav are
  in the DOM) → the add-BP sheet, a real tap on systolic, typed `128`,
  keyboard up (`local-smoke-bp-sheet-keyboard.png`) → Back hides the
  keyboard, the next closes the sheet, the app stays open → a med added
  (through `/api/medications`) → force-stop → relaunch with no extras → the
  med is still listed (`local-smoke-relaunch-meds.png`) → Settings: the
  Health Connect row and the reminder state in Android wording ("phone").
  `results.local = { durable, networkRequests, egress, paint, keyboard, … }`:
  `networkRequests` counts every page request and websocket (Playwright's CDP
  Network events) to a host other than `appassets.androidplatform.net` over
  both boots (Playwright attaches after a launch's first load, so the first
  boot is replayed under the listener: a same-origin non-app document (`/qa/scenes.json`) wipes the origin's
  storage, then `/?qa=today` boots on the empty store and seeds; the relaunch
  is reloaded with the listener attached) — **must be 0**, the
  whole-app zero-egress check; `paint` is the seconds each shot waited for a
  stable frame.
- **`local-visual`** (on its own; ~20 cold starts): the Android twin of
  `ios/UITests/VisualQATests.swift` for [visual QA](design/ios-visual-testing.md)
  (med-y5xx.9 consumes it). `pm clear`, then per scene of
  [`tests/visual/scenes.json`](../tests/visual/scenes.json): web scenes
  launch with `--es wgQAScene <name>`, wait for `#wg-qa-ready`, run the
  scene's `native` steps on the device (`tap` = a real touch on the DOM id,
  `type` = `adb input text`, `clear`, `tapButton` / `waitFor` = UiAutomator
  text, `keyboard` = the IME is up); native-only scenes (`native-*`) open
  first run. Artifact `visual/android/<scene>.png` (full device) +
  `visual/android/<scene>.json` (the ready node's report: probes, `failed`). Dark,
  font scale and landscape are the dispatch inputs, applied to every scene.
  As on iOS only lost ready content fails a scene (one retry each, from
  a fresh `pm clear`; `firstError` keeps attempt 1's failure); the probes are
  findings. First full run 39257278592: every scene shot, all passing on
  retry; the Settings-page scenes lost their page on a seeded cold start
  (bd med-nt9p.39: WebView landed the app's own `history.back()` 3-4 s late
  and it popped the page pushed meanwhile; `MessengerAdapter.historyPush` /
  `historyBack` now hold pushes until it lands — run 39265321642 passes every
  scene on attempt 1). The scenario fails at the end if any scene did.
  **Visual tier (bd med-y5xx.9):** a `local-visual` dispatch also uploads
  `visual/` as its own artifact, `android-visual` (90 days), suffixed by each
  non-default input (`-api35`, `-font1.3`, `-dark`, `-landscape`), and runs
  `tests/visual/compare.sh` against master's latest dispatch carrying the same
  name, so a variant only compares with its own kind. Diffs land in the
  artifact's `compare/`. Evidence only, never a gate. The master reference is
  `gh workflow run android-qa.yml --ref master -f scenario=local-visual`;
  rerun it after an intended UI change. Shots are Playwright's
  `AndroidDevice.screenshot()`, which is `adb` `screencap` underneath.

### Local cloud on the runner (bd med-nt9p.24)

The web scenarios need a real account origin over https without touching
production, so the job runs its own:

```
cmd/cloud :8080 (CLOUD_BASE_DOMAIN=qa.test, throwaway SESSION_SECRET + DB, one `admin invite` per run)
  ← android/qa/tlsfront :443 (sudo; fresh CA + leaf for qa.test, *.qa.test and the invite host)
  ← emulator: WebView flag --host-resolver-rules="MAP *.qa.test 10.0.2.2" (/data/local/tmp/webview-command-line)
              + the CA in the user store (/data/misc/user/0/cacerts-added/<subject_hash_old>.0, via adb root)
```

`qa.test`, not `*.localhost`: `AccountUrl.parse` accepts https without a port
only, and `schemeForHost` makes the WebAuthn origin http for `*.localhost`. The
server itself is unchanged. The app trusts user CAs only through the
**debug-source-set** `network_security_config.xml` (`<debug-overrides>`, merged
in by `android/app/src/debug/AndroidManifest.xml`): release builds do not
contain it, and debug-overrides are ignored by non-debuggable builds anyway. A
debug APK sideloaded on a phone therefore trusts CAs the user installed
themselves; release does not. `run.sh` writes the logcat count of DNS/TLS
error lines to the step summary (expected 0); `cloud.log` and `tlsfront.log`
are in the artifact.

Scenarios on it: `claim-page` (invite → signup wizard with the page-coloured
bands and the web exit bar at the top, no native bar → its in-page confirm →
Cancel; default, font 1.3, then dark, which confirms → the first run with
`accountHost` gone), `not-found` (`nobody.qa.test`, which `tlsfront` answers with
the server's marked 404 → the first run with "There is no account at …", no
Try again, `accountHost` gone from `shell.xml`; `stale.qa.test`, a bare 404 →
N4 · 404, `accountHost` kept; the other error-screen scenarios open
`down.qa.test`, which `tlsfront` answers 503), `load-error` (N4's 503, bare-404
and local variants with their meta line; local via the debug-only
`--ez wgQALocalError true`), `native-lock` (the splash, N3 light/dark, and the
failed note via `--ez wgQALockFailed true`),
`external-link` (a `_blank` anchor and `location.href` to example.com leave the
WebView URL unchanged and fire ACTION_VIEW — the image has Chrome, which takes
it), `authn-probe` (below).

**CDP virtual authenticator probe: FAIL** (run 2026-10-19):
`WebAuthn.enable` → *"'WebAuthn.enable' wasn't found"* — Android WebView's
DevTools does not expose the WebAuthn domain at all, so a CDP virtual
authenticator cannot stand in for a passkey here. Part 3 (bd med-nt9p.25)
therefore takes the debug-only soft-authenticator route. The probe stays in the
suite (`results.authnProbe` in `qa-summary.json` and the step summary) so a
WebView update that adds the domain shows up.

### Unlocked account: the QA soft authenticator (bd med-nt9p.25)

Every way into an unlocked vault is a WebAuthn ceremony, and Google Password
Manager cannot run headless. So debug builds carry
[`src/debug/assets/qa-softauthn.js`](../android/app/src/debug/assets/qa-softauthn.js):
a document-start script that replaces `navigator.credentials.create/get` with a
WebCrypto software authenticator the **unchanged** server verifies (ES256,
`none` attestation, flags UP|UV|BE|BS, sign count 0, discoverable; PRF =
HMAC-SHA256 over a per-credential secret with the spec's `"WebAuthn PRF" || 0x00
|| salt` input; credentials in the origin's localStorage so a relaunch finds
them). It also polyfills `PublicKeyCredential.parse*OptionsFromJSON`, which
the emulator image's WebView 113 lacks. The web code has no QA branches.

The gate is [`src/debug/.../DebugHooks.kt`](../android/app/src/debug/java/com/example/medtracker/DebugHooks.kt):
injected only when `BuildConfig.DEBUG`, the build's base is the placeholder
`qa.test` (the QA APK), **and** the launch intent carries `--ez qaSoftAuthn
true`, which the harness sets with `adb shell am start` (a launcher tap never
does; `MainActivity` is exported, so the base check is what stops another app
from sending the extra to a real-deployment debug build); diag.xml then says
`shell qa soft authenticator ON`. Release
builds compile [`src/release`'s no-op twin](../android/app/src/release/java/com/example/medtracker/DebugHooks.kt)
and have neither the code nor the asset; android-qa.yml builds the release APK
alongside and fails unless it has 0 `qa-softauthn` files and 0 dex mentions
(step summary: *Release APK QA-hook check*). The owner's sideloaded **debug**
APK also carries the asset, inert: its base is the real deployment, not `qa.test`.

**`smoke`** (the agent's default scenario; it claims the run's one invite, so
`all` runs it last and it has no retry): soft-authenticator launch → invite → signup wizard →
passkey → loss-ack → Emergency Kit (the native Save/Share dialog is
screenshotted, dismissed with Back) → vault → onboarding wizard (screenshotted, Skip all) → Today, Meds, Vitals (`health`),
Food, Settings → Backup & import: passphrase export through the real button
to the Save/Share dialog, the same at ~45 MB of vault JSON (stubbed
`exportAll`), and a 25 MB blob probe (`results.smoke.export`: phase times,
status timeline, click → dialog ms; bd med-nvd4) → the add-BP sheet, a real tap on systolic → keyboard
(`smoke-bp-sheet-keyboard.png`; `results.smoke.keyboard` says whether the
focused input sits inside the visual viewport) → rotated with the sheet open
(portrait lock: expected unchanged) → Back (the first hides the keyboard) closes
the sheet → one Back on Today leaves the app → cold relaunch reopens the vault
from the warm cache. The Back steps record PASS/FAIL and the press counts
(`results.smoke.backPressesToCloseSheet`, `backPressesToLeave`, and `backTrail`: the page path after each Back on Today) without
stopping the scenario.

**Agent how-to.**

```bash
B=<branch>   # android-qa.yml must exist on it (it is on master)
gh workflow run android-qa.yml --ref $B -f scenario=smoke                    # defaults
gh workflow run android-qa.yml --ref $B -f scenario=smoke -f font_scale=1.3
gh workflow run android-qa.yml --ref $B -f scenario=smoke -f font_scale=2.0
gh workflow run android-qa.yml --ref $B -f scenario=smoke -f dark=true
gh workflow run android-qa.yml --ref $B -f scenario=smoke -f landscape=true
gh run list --workflow android-qa.yml -L 5                                    # run ids
gh run watch <run-id>
gh run download <run-id> -n android-qa-smoke -D <empty-dir>                   # then Read the PNGs, delete after
```

One dispatch per combination, one at a time (the workflow's concurrency group is
per ref and holds only one pending run — a third dispatch cancels the second). Read `qa-summary.json` first: `ok` (no scenario threw after its
retry), `steps[]` (`ok`, `error`, `retried`), `results.smoke` (keyboard
geometry, Back press counts, relaunch path), `screenshots[]` in order; then
look at every screenshot yourself — a green run with a broken screen is still a
finding. Emulator runs are **discovery, not sign-off**: WebView 113, software
GPU, no Play sign-in; the owner's phone decides.

Filing a finding: one bead under `med-nt9p` (`bd create … --parent med-nt9p`)
with the screenshot name, the dispatch inputs (scenario, font_scale, dark,
landscape, api_level), the run id, and the matching `logcat.txt` excerpt
(`chromium` tag for page console lines) or `diag.xml` entry.

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
2. **Claim B in the app (1, 2).** Paste B's invite link → *Continue* → finish the
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
   *Continue* → unlock with the passkey made in Chrome. Expect
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

## Spike: local mode on the asset origin (bd med-nt9p.32.1)

The GO/NO-GO gate for Android local mode (epic `med-nt9p.32`): does a page the
APK serves on `https://appassets.androidplatform.net` behave like a real https
origin in Android System WebView, and does Auto Backup bring its IndexedDB
back? Twin of the iOS spike ([ios.md → Spike: local mode](ios.md#spike-local-mode-on-a-custom-scheme-origin-bd-med-o7zq1)),
same page, same check numbers.

- **What runs (debug builds only):**
  [`LocalSpikeActivity.kt`](../android/app/src/debug/java/com/example/medtracker/LocalSpikeActivity.kt)
  in the **debug source set** — its own WebView, its own launcher icon
  *Local spike*; `MainActivity` and the release APK are untouched. It serves
  [`ios/LocalSpike/`](../ios/LocalSpike/) (copied into the debug variant's
  assets as `localspike/` by a Gradle task in `app/build.gradle.kts`) from
  `shouldInterceptRequest`: MIME by extension (`text/javascript` for modules),
  the CSP as a response header on HTML (`LocalOrigin.csp` shape, connect-src
  `'self'` + the two BYOK probe hosts), `/env.json` from native, and a 404 for
  any miss — nothing on that host reaches the network. The page's bridge is a
  `wgSpike` WebMessageListener scoped to the asset origin (`{id, op}` →
  `{id, value}`), plus a document-start script on the same rule (chrome.js's
  mechanism). Camera: `VIDEO_CAPTURE` granted to that origin only, after the
  runtime prompt.
- **Backup:** the spike ran on a debug-only rules file; the shipped rules
  replaced it ([Local mode backup](#local-mode-backup-bd-med-nt9p325)), and the
  spike now runs on those. The install id the page shows as `vendor` lives in
  `no_backup`, so a restore shows the old launches under a new vendor id.
- **Page changes are Android-only branches** in `ios/LocalSpike/js/main.js`
  (iOS bridge first, unchanged): the Android bridge, #8 compares against
  `env.host`, #4/#12 are INFO (blob downloads are Files.kt's; no
  isExcludedFromBackup on Android), and a new **#13**: `pushState('/?spike=reload')`
  + reload must come back on the same origin.

### Emulator run (QA scenario `local-spike`)

```bash
gh workflow run android-qa.yml --ref <branch> -f scenario=local-spike -f api_level=34   # and 35
```

Not part of `all` (it ends with `pm clear`). Steps: grant CAMERA → launch →
automatic checks → *Test camera* (the emulator gets `-camera-back emulated`
for this scenario only) → force-stop + relaunch → `install -r` of the same
APK + relaunch → `bmgr enable true`, `bmgr transport
com.android.localtransport/.LocalTransport`,
`backup_local_transport_parameters is_encrypted=true` → `bmgr backupnow` →
`pm clear` → `bmgr restore 1 <pkg>` → relaunch. Every row lands in
`results.localSpike` of `qa-summary.json` (also in the step summary); the
full page + native report is in the run log. Gotcha found on the first run:
`bmgr backupnow` refuses a **stopped** package ("Backup is not allowed") — do
not force-stop before it.

### Owner run on the phone

Install the CI debug APK (Actions → **Android** on the branch or master →
`medtracker-debug-apk`), then the *Local spike* icon:

1. Wait for "Automatic checks done" → *Test camera* (allow) → *Copy report*.
2. Swipe the app away, reopen *Local spike*: #2 and #2k PASS.
3. Install a newer CI debug APK over it (a new run = new versionCode): #2
   lists the older build number.
4. Backup → restore: Settings → Google → Backup → *Back up now* (Google One),
   then either a second phone set up from that backup, or uninstall →
   reinstall the same APK (Play-less sideloads restore only if the backup
   carries the package; note which path ran), open *Local spike*: #2 lists the
   old launches, #10 shows two vendor ids. Device-to-device transfer to a new
   phone is the other path, if one is at hand.
5. Paste the report(s) into bd `med-nt9p.32.1` and record GO or NO-GO.

### Results

Emulator = discovery evidence; the owner's phone is the GO.

| # | Check | Emulator API 34 (WebView 113) | Emulator API 35 (WebView 124) | Phone |
|---|-------|-------------------------------|-------------------------------|-------|
| 1 | `isSecureContext`, AES-GCM + PBKDF2 | PASS | PASS | pending |
| 2 | IndexedDB across force-stop + relaunch | PASS | PASS | pending |
| 2 | … across `install -r` (same versionCode; a real version update is phone step 3) | PASS | PASS | pending |
| 2k | Non-extractable AES key in IndexedDB survives (also after restore) | PASS | PASS | pending |
| 3 | Modules: nested, `/static/`, `../../domain/`, dynamic, MIME `text/javascript` | PASS | PASS | pending |
| 5 | `getUserMedia` + readable frame | PASS (480×640) | PASS (480×640) | pending |
| 6 | CSP from the intercept header: inline, eval, connect-src blocked + violation event | PASS | PASS | pending |
| 7 | Origin data dir | `app_webview/Default/IndexedDB/https_appassets.androidplatform.net_0.indexeddb.leveldb` (no `.blob` dir until a Blob is stored) | same | pending |
| 8 | Bridge on the asset origin (`https`, host, mainFrame) + document-start script | PASS | PASS | pending |
| 9 | BYOK: OpenAI 401, Anthropic `x-api-key` 401 (Bearer form CORS-rejected, as on the web) | PASS | PASS | pending |
| 10 | Auto Backup → `pm clear` → restore keeps IndexedDB | PASS (`bmgr`, ~11 KB) | PASS (~11 KB) | pending (real backup) |
| 11 | `storage.persist()` / estimate (record only) | persist()=false, quota ~3.5 GB | same | pending |
| 13 | pushState + reload stay on the origin | PASS | PASS | pending |

QA runs: API 34 `39197391342`, API 35 `39198183410`.

**Verdict:** emulator GO candidate; GO/NO-GO is the owner's after the phone run.

## Local mode backup (bd med-nt9p.32.5)

Owner decision (b): the app opts into Auto Backup (`allowBackup="true"`) with
**include-only** rules, so Android backs up exactly what is listed and
nothing else —
[`data_extraction_rules.xml`](../android/app/src/main/res/xml/data_extraction_rules.xml)
(Android 12+, both `<cloud-backup disableIfNoEncryptionCapabilities="true">`
and `<device-transfer>`) and the same list in
[`backup_rules.xml`](../android/app/src/main/res/xml/backup_rules.xml)
(`fullBackupContent`, so no older-rules path backs up the whole data dir):

| In the backup set | Why |
|---|---|
| `app_webview/Default/IndexedDB/https_appassets.androidplatform.net_0.indexeddb.leveldb` (+ `.blob`) | the "Only on this device" records (dir names from the spike's `run-as` listing) |
| `shared_prefs/wg_trial.xml` | the Android trial pass + counter (bd med-nt9p.32.8.4): Keystore keys never restore, so a reinstall rejoins its trial bucket only through this file |

Everything else is **out**: every account origin's WebView data (decrypted
records, the warm-unlock key — cloud mode's posture is unchanged), the shared
`Local Storage` leveldb (all origins write it), every other prefs file
(`shell` = account host, `diag` = PII log, `reminders`, `health` anchors), and
the local → cloud move stash (`no_backup/move/`, bd med-nt9p.32.17 — the
platform never backs up `no_backup/` either). So
a restore loses UI prefs and Health Connect anchors; the import re-reads from
scratch on missing anchors, as after an iOS restore. The `wgLocalMode` flag
lives in `shell` too, so a restored phone opens on first run: *Only on this
device* → **Start** finds the restored records (Start never wipes the local
origin). Never widen the rules to
`app_webview` or `shared_prefs`.

Limits the copy states: Google's cloud backup needs the phone's backup
encryption (screen lock) and **silently skips an app over 25 MB**; a
device-to-device transfer has no cap. The weekly export nudge stays.

**Emulator proof** — QA scenario `local-backup` (not in `all`, it ends with
`pm clear`), run once per rule section (local transport with
`is_encrypted=true` = cloud backup, `is_device_transfer=true` = D2D): a cloud
session writes an IndexedDB db + Local Storage key on the account origin (the
shell writes its prefs), the bundled local app (`--ez wgLocalMode true`)
writes a marker on the local origin; the scenario checks all of these exist,
then `bmgr backupnow` → the backup set (the transport's tar under
`com.android.localtransport/files/1/_full/<pkg>`): every tar entry on the
include list, no hit of the account host / `Local Storage` / `Cookies` / the
prefs file names → `pm clear` → `bmgr restore` → the restored data dir holds
only included paths (allowlist; empty standard dirs only) → the local marker
reads back. Fail closed: an unreadable set or a missing store fails.

```bash
gh workflow run android-qa.yml --ref <branch> -f scenario=local-backup
```

| Run | Result |
|---|---|
| Emulator API 34 (run `39245263862`) | PASS, cloud backup and D2D: set = `_manifest` + the local origin's leveldb only (~24 KB); restored dir = that dir + empty standard dirs; local marker back |
| Owner phone (D2D or Google One restore) | pending — owner action, record here |
## Local mode: the bundled app (bd med-nt9p.32.2)

The Android half of local mode (epic `med-nt9p.32`, the twin of
[ios.md → Local mode](ios.md#local-mode-the-bundled-app-on-wgapplocal-bd-med-o7zq4)):
the APK carries the web app and the shell serves it on
`https://appassets.androidplatform.net`, a separate origin from every account,
so local IndexedDB never mixes with an account's. The mode switch, first run
and bridge ops are below ([Local mode: the shell](#local-mode-the-shell-bd-med-nt9p324)).

- **Bundle (CI only):** `android.yml` (and `android-qa.yml`, with `QA=1` and
  prefix `android-qa`) runs [`ios/bundle-web.sh`](../ios/bundle-web.sh) before Gradle with
  `WG_BUNDLE_OUT=android/app/src/main/assets/web` and
  `WG_BUNDLE_PREFIX=android`: `web/static`, `web/cloud` and `web/domain` from
  the checked-out revision, `index.html` with the fingerprints set to
  `android-<run number>` and the classic `<script src="/js/local-boot.js">`
  first. The dir is git-ignored and never committed; debug, release and the
  AAB all carry it (~11 MB). A web change therefore re-runs `android.yml`
  (path filter: `web/static|cloud|domain/**`, `ios/bundle-web.sh`) — build
  and tests only, releases stay dispatch-only and `deploy.yml` ignores it.
- **Verify step:** *Check local-mode bundle in the debug APK* fails the run
  unless `unzip -l` lists `assets/web/index.html`,
  `cloud/js/local-boot.js`, `cloud/js/apishim.js`, `domain/bp.js` and
  `static/js/core/utils.js`, the document loads `local-boot.js` and not
  `cloud-boot.js`, and no `cloud/qa/` driver or test suite came along.
- **Serving:** [`LocalApp.kt`](../android/app/src/main/java/com/example/medtracker/LocalApp.kt)
  answers MainActivity's `shouldInterceptRequest` while local mode is on and
  the host is the asset host (any other host: `null`, the normal network —
  cloud mode is unchanged). GET only (else 405); the path routes like an
  account host via `LocalOrigin.file`: `/` → `web/index.html`, `/static/*` and
  `/domain/*` their trees (so `apishim.js`'s `../../domain/` imports resolve),
  everything else → `web/cloud/` (`/js`, `/css`, `/vendor`, and `/qa/` only in a
  QA bundle); `..`, `.`, a trailing slash or a missing asset → an explicit 404,
  never the network. MIME by extension (`text/javascript` for `js`/`mjs`),
  `Cache-Control: no-store` so a new build never serves stale assets from the
  WebView cache. Not `WebViewAssetLoader`: its root mapping does not fit the
  three-tree layout.
- **CSP:** every response carries `LocalOrigin.csp(hosts)` = cmd/cloud's
  `cspPolicy` with `connect-src 'self'` plus `https://<h>` and `wss://<h>` per
  host — never a wildcard (the account-document invariant). `hosts` is the
  native mirror in the `shell` SharedPreferences under `wgLocalEgressHosts`
  (space-separated; `.4`'s `setEgressHosts` writes it with the `egress.go`
  rules: ≤ 8 bare lowercase DNS names, a list accepted or rejected whole); an
  invalid stored value reads as no hosts.
- **Routing/CSP/MIME** live in Android-free
  [`LocalOrigin.kt`](../android/app/src/main/java/com/example/medtracker/LocalOrigin.kt),
  checked by `LocalOriginTest` (the `ios/Tests/main.swift` cases) in
  `testDebugUnitTest`.
- **Debug entry:** the QA launch extras of `.4` (`--ez wgLocalMode true`,
  below) replaced the temporary `wgLocalApp` extra.

### Emulator run (QA scenario `local-app`)

```bash
gh workflow run android-qa.yml --ref <branch> -f scenario=local-app
```

Launches with `--ez wgLocalMode true`, reloads with request listeners attached, waits for
`MedTrackerCloudReady` and `#app`, screenshots the shell, then fetches `/`,
`/js/apishim.js`, a missing path and `https://example.com/` from the page: the
CSP header (`connect-src 'self'`, no wildcard), `no-store`, the JS MIME, the
404 and the refused cross-origin fetch are asserted; any other failed or
≥ 400 load fails the scenario. Everything lands in `results.localApp`. Not in
`all` (`local-smoke` is the local scenario there).

## Local mode: the shell (bd med-nt9p.32.4)

Twin of iOS `Shell.swift` / `LocalIntroView` (bd med-o7zq.5, .9), in
[`MainActivity.kt`](../android/app/src/main/java/com/example/medtracker/MainActivity.kt):

- **Mode:** the `shell` SharedPreferences boolean `wgLocalMode`
  (`LocalOrigin.MODE_KEY`) wins over a stored account host. Local: home is
  `https://appassets.androidplatform.net/`, `shouldInterceptRequest` serves
  it from `LocalApp`, only that host navigates inside the app, and a load
  error or 404 on it is logged to the diagnostics log and keeps the page —
  except a miss of the app document itself, which shows N4 · local (*Can't
  open Med Tracker*, *Use an account instead*, never Switch account).
- **First run (N1):** the boxed *Only on this device* row comes first (owner
  decision 2026-10-19 — the Play build's reviewer path needs no invite); then
  "or" and the invite field under "Have an invite?" with the Scan icon button
  in its row and **Continue**, then the store footnote, the privacy link and a
  **How to get an invite** link to the service landing page
  `https://<BuildConfig.BASE_DOMAIN>/` (absent when the build has no base).
  The row opens the native intro (N2): *Back* in the top bar (system Back
  too), four facts (stored here, nowhere else; you make the backups — Google
  backup keeps up to 25 MB, export a file for the rest; lose the phone, lose
  the records, in warn; move to an account later), the optional
  **Lock** switch row ([Lock](#local-mode-lock-bd-med-nt9p329)) and
  **Start** docked at the bottom (stores `wgLocalMode=true`, clears
  reminders, opens the bundled app).
- **One vault at a time:** reminders (`Notifications`), their taps
  (`https://<vault>/?tab=…`), file grants and camera/mic (`Files`) and the
  bridge all follow the open vault: the account host, or the asset host in
  local mode. **Every mode change clears the alarms**, so a reminder of the
  other vault never fires or opens the wrong origin. Leaving local mode (the
  page's *Move to a cloud account*, or the launcher *Switch account*
  shortcut) sets `wgLocalMode=false` and shows first run; each origin keeps
  its own WebView data, so *Only on this device* again (or the account
  address) finds it. The only thing carried across is the move stash
  (`move.stash` → `move.take`, below): one file, never backed up, deleted
  after the import or when local mode is entered again.
- **Bridge:** `wgNative`, `wgFiles`, `chrome.js` and `files.js` are injected
  on `https://*.<base>` and `https://appassets.androidplatform.net`; a
  message is answered only from the open vault's top-level https page
  (`LocalOrigin.bridgeCaller`, else `forbidden`). Local-only ops — an account
  page gets `unsupported: <op>` (`LocalOrigin.opAllowed`):

  | op | does |
  |---|---|
  | `setEgressHosts {hosts}` | `LocalOrigin.validHosts` (≤ 8 bare DNS names, whole list or `invalid hosts`), stored under `wgLocalEgressHosts`; replies `{changed}` — the page reloads itself when true and the next document's CSP `connect-src` lists the hosts |
  | `local.reset` | the page erased its storage: removes the host mirror, clears reminders, deletes the move and leave stashes and the invite slot (A4), replies `true` |
  | `local.leave {url?}` | without `url`: replies `true`, then Switch account (first run). With `url` (bd med-ta2n.12.1): `AccountUrl.parse` or `invalid url` (nothing changes; a `null`/empty/non-string `url` too), else `true` and `enterAccount` — the account opens on that URL, the move stash is **kept** for it, the leave stash and the invite slot go |
  | `move.stash {vault}` | the local → cloud move (bd med-nt9p.32.17, [`Move.kt`](../android/app/src/main/java/com/example/medtracker/Move.kt)): writes the vault v1 JSON string to `no_backup/move/vault.json` (temp file + rename, one stash at a time, replaces the old one); `invalid vault` when missing, empty or not a string, `too large` above 64 MB (UTF-8 bytes); replies `true` |
  | `leave.take` | local pickup (bd med-o7zq.36.3): replies `{vault}` or `null`; does not delete (same as `move.take`) |
  | `leave.clear {back?}` | deletes the leave stash, replies `true`; with `back: true` (the page's pickup was cancelled, bd med-o7zq.42) and an account remembered by `account.leave {then: "local"}` (`leaveHost`), replies `{back: true}` and reopens that account |
  | `lock.status` | `{on, available}`: the lock's state, and whether the phone has a screen lock ([Lock](#local-mode-lock-bd-med-nt9p329)) |
  | `lock.set {on}` | the phone's own check, then the choice; `true` once applied, `false` when refused or cancelled |

  The `attest.*` ops are local-only too
  ([Free trial](#local-mode-free-trial-bd-med-nt9p3284)). Account-only — the
  bundled app gets `unsupported: <op>` (`LocalOrigin.ACCOUNT_OPS`):

  | op | does |
  |---|---|
  | `account.leave {then?}` | replies `true`, then forgets the account host (bd med-nt9p.32.13, iOS twin PR #1179): with `{then: "local"}` straight into local mode (Settings → Account *Use this phone without an account*), without args the first run (after an account delete). Nothing is erased: the account and its origin's WebView data stay. With `{url}` (bd med-ta2n.12.1): as `local.leave {url}`, `then` ignored, and the move stash is **deleted** (a stale one must not land in the next account) |
  | `move.take` | the new account's pickup (bd med-nt9p.32.17): replies `{vault}` (the stashed string) or `null` when there is none; does not delete, so a failed import retries on the next open |
  | `move.clear` | deletes the stash once the page imported it, replies `true` |
  | `leave.stash {vault}` | account → local (bd med-o7zq.36.3, a second `Move` over `no_backup/leave/vault.json`): same contract and errors as `move.stash` (`invalid vault`, `too large`, `write failed`), but **account mode only** |

  **The move stash** (`Move.kt`, `MoveTest`): the two origins share no
  storage, so the shell carries the local vault to the new account in one
  app-private file, `noBackupFilesDir/move/vault.json`. It is plaintext in the
  same app sandbox as the local origin's plaintext IndexedDB (the epic's
  decision: no local encryption layer), so no new exposure; it never leaves the
  device (no egress, no privacy-manifest row) and is **never backed up**:
  `no_backup/` is excluded from every backup by the platform, and the Auto
  Backup include-list never names it either. It is deleted by `move.clear`
  (after the import), `local.reset`, `account.leave {url}`, and whenever local mode is entered again
  (*Start*, `account.leave {then: "local"}`: the move was abandoned, the next
  one stashes afresh); Switch account keeps it, since that is the hand-off.
  While it exists the first run leads with an info note, *Your records are
  ready to move.*, and puts the invite above *Only on this device* (N1 · move);
  the intro shows a warn note, *Start and cancel the move* and *Open the new
  account instead* (N2 · move). Its contents never reach the diagnostics log or an error
  reply. Emulator proof at the bridge: QA scenario `move-ops` (not in `all`, it
  claims the run's invite) — mode gates, `invalid vault`, the file in the
  `run-as` listing after the stash, the hint, deleted on *Start*, and in the
  new account the pickup clears it, then a seeded stash: `move.take` returns
  it and keeps the file, `move.clear` deletes it. The user path end to end is
  `local-to-cloud-seamless` ([Moving to a cloud account](#moving-to-a-cloud-account-bd-med-nt9p3210)).

  **The leave stash** (account → local, bd med-o7zq.36.3): the mirror image in
  `noBackupFilesDir/leave/vault.json`, a second `Move` instance with the same
  plaintext/never-backed-up/no-leak rules and error strings. The account page
  writes it (`leave.stash`, account mode only) just before
  `account.leave {then: "local"}`; the local page picks it up (`leave.take`,
  `leave.clear`, local mode only). It is deleted by `leave.clear`,
  `local.reset` and opening an account (`open()`, `local.leave`/`account.leave {url}`); a cancelled pickup sends
  `leave.clear {back: true}`, which also reopens the account the leave came
  from (bd med-o7zq.42). It is **kept** across
  `setLocal(true)` and `forget(thenLocal)` (that is the hand-off) and across
  `local.leave`. The `move.*` ops are unchanged. `move-ops` also covers it
  (gates, stash, kept into local mode, take/clear, `local.reset`, `open()`).

  Both modes: `ping`, `chrome`, `diag.append`, `notifications.*`, `health.*`,
  `invite.pending` / `invite.clear` / `clipboard.read` ([Invite links](#the-shell-bd-med-nt9p5)),
  and `shell.ops`, which replies the array of op names this shell answers in
  the current mode (`LocalOrigin.ops`, one source with `opAllowed`) — the
  page's capability probe, so a row whose op an older APK lacks stays hidden
  (an APK before it answers `unsupported: shell.ops`).
- **QA extras (debug + `qa.test` base only, `DebugHooks`):**
  `--ez wgLocalMode true` enters local mode as Start does (persisted, no
  first-run tap); `--es wgQAScene <name>` opens `/?qa=<name>` (1–64 of
  `[a-z0-9-]`, `LocalOrigin.qaHome`, else the root). Release compiles the
  no-op twin; `android-qa.yml`'s release check counts `wgQAScene` in its dex.
  `LocalOriginTest` covers the scene parser and the bridge gating (including
  the `move.*` ops and `shell.ops` per mode).

### Local mode: lock (bd med-nt9p.32.9)

Optional and **off by default** — the twin of iOS `LocalLock.swift`
(med-o7zq.8), in
[`LocalLock.kt`](../android/app/src/main/java/com/example/medtracker/LocalLock.kt)
(pure state, `LocalLockTest`) and `MainActivity.kt`. A UI lock, not
encryption; reminders on the lock screen still show. Local mode only: an
account has its passkey, and cloud mode never shows or checks it.

- **Turning it on/off:** the intro's *Lock with fingerprint or face* switch
  row (shown when the phone has a screen lock, or the lock is already on; the
  full "fingerprint, face or screen lock" wording is the system prompt's), and **Settings → App lock** in the app (`local-policy.js`
  `mountLocalLockRow`, Android shell only; iOS keeps its toggle in iPhone
  Settings). Either way the change applies only after the phone's own check
  (framework `BiometricPrompt`, `BIOMETRIC_WEAK | DEVICE_CREDENTIAL`, no new
  dependency); turning on needs a screen lock. Stored as the `shell` pref
  `wgLocalLock`: absent on every install before it, so an upgrade never
  locks anyone out. Not in the backup rules, so a restored phone starts off.
- **Lifecycle:** locked at launch and on every `onStop` (Home, Recents, a
  call, another app, the browser, the screen going off) except, while the
  screen is on, the app's own screens — what it starts through
  `startActivityForResult` / `startIntentSender` (file picker, save, share,
  print, the exact-alarm Settings page) — and the phone's screen-lock check.
  Permission screens are not exempt (`requestPermissions` is final): the
  return from Health Connect's asks to unlock. The next `onResume` prompts
  **once**; a cancel
  leaves the lock screen (N3: the mark tile at the splash's spot, *Med Tracker
  is locked* → *Unlock*), no prompt loop; a failed check (any prompt error but
  a cancel) adds the warn note "Not recognised. Try again, or use your screen
  lock."; a result from before a background is dropped.
- **While locked:** the WebView is detached from the window (the page is
  hidden, so `visibilitychange` work waits), every load is deferred, a
  reminder tap is kept and opened after the unlock, Files' bridge ignores
  the page, and every `wgNative` op answers `locked`. While the lock is on,
  `setRecentsScreenshotEnabled(false)` keeps the app-switcher snapshot
  blank; no `FLAG_SECURE`, so screenshots (and the QA harness) still work.
- **No screen lock any more** (removed after the lock went on): the check
  passes — the lock never strands the only copy of the records.
- **Known gap:** leaving the app *from* one of its own picker/print/share
  screens with the screen on locks only at the next stop (a ponytail note
  in `onStop`); the screen going off there still locks (an `ACTION_SCREEN_OFF`
  receiver, registered only while the lock is on). A share sheet over the
  page is not dismissed.

### Device check (CI debug APK, local mode)

1. Fresh install, airplane mode → *Only on this device* (top button) → read
   the intro (*Back* returns to first run) → *Start*: the bundled app renders
   offline, `wg-local-vault` on `<html>`, no network requests in
   `chrome://inspect`.
2. Add a med, kill and reopen: still there, no first run.
3. Settings → Reminders → Allow → a reminder fires; its tap opens Meds in
   local mode.
4. Save a BYOK key in Settings → AI & integrations: the page reloads once
   and the provider host is in the document CSP (`chrome://inspect`).
5. Settings → Backup → *Move to a cloud account* → first run; *Only on this
   device* again finds the data.
6. Erase → empty app, BYOK hosts gone from the CSP.
7. Long-press → *Switch account* → a test account, then back to *Only on
   this device*: both data sets intact; no reminder of the other vault fires.
8. *How to get an invite* opens the service landing page in the browser.
9. Settings home → *Move to a cloud account* → *Continue* → the first run's
   *ready to move* hint → claim a test invite → the account shows the records
   with no Restore, and the toast once → *Switch account* → no hint → *Only
   on this device* → *Start*: the local records are intact. Once more with
   the file fallback: Backup & import → Export backup → *Save to device* →
   *Switch account* → claim → Restore the file
   ([Moving to a cloud account](#moving-to-a-cloud-account-bd-med-nt9p3210)).
10. Lock (a phone with a screen lock): intro switch on → *Start* asks for the
    fingerprint/PIN; Home and back → one prompt, cancel → lock screen, no
    loop; *Unlock* opens it. App switcher shows no data. Settings → App lock
    off asks once more. A reminder tap while locked opens its section after
    the unlock.

### Moving to a cloud account (bd med-nt9p.32.10)

The upgrade from local mode carries the records across the two origins in
the shell's **move stash** (bd med-nt9p.32.16-.19, shared design with iOS
med-o7zq.35; the web side is
[cloud-mode.md → C2e implementation notes](cloud-mode.md#c2e-implementation-notes)). Vault
format v1, no server change.

1. Local mode: Settings home → **Move to a cloud account** (opens Backup &
   import's Move section, kit S7) → its **Move to a cloud account** button →
   *Continue*. Row and section show only when `shell.ops` lists `move.stash`
   (the web and older shells keep only the file steps below). The page exports the vault
   (`exportAll`, API keys included) and sends `move.stash {vault}` then
   `local.leave`; the shell writes the stash and shows first run with the
   *Your records are ready to move.* note, the invite first. A rejected stash
   (`too large`, `write failed`, an old shell) stops before the leave and
   shows the file steps.
2. Paste or scan the invite, create the passkey, finish the wizard.
3. The account picks the records up by itself, right after the unlock
   (`pickUpMovedVault`: `move.take` → `restoreVault` → `move.clear` → reload).
   An empty account asks nothing; one with data asks the typed *Replace all
   your data?* (cancel keeps the stash and asks again on the next open). The
   import waits for the snapshot upload; one that did not land says why
   (*Not uploaded yet*) before the reload. After the reload a toast says *Sync
   is on · N records are on your account* once (N = the user records the
   stash carried). A stash with no user records is never offered as a
   Replace: an account with records drops it (`move.clear`) without a
   dialog; an empty one imports it silently (settings, keys).
4. The local records stay: *Switch account* → *Only on this device* →
   *Start* opens them again. Nothing prompts to erase them.

**With an invite (P3, bd med-ta2n.7).** On a v3 shell (`shell.ops` lists
`invite.pending`) an invite that reaches the app lands in the pending slot and
the page routes it at boot (one `invite.pending` read per page, before W1):
local mode with records → the *Turn on sync?* sheet (*Your N records move to
your account*); local with none → *Your invite is here* (the Play-referrer
first launch: *Sign in with fingerprint* / *Use without sync*, ahead of W1);
account mode → the *Switch account?* dialog (*Switch* = `account.leave {url}`,
*Keep this account* = `invite.clear`). *Turn on sync* / *Sign in* is
`CloudVault.moveToCloud({url})`: `move.stash {vault}` **always** (records or
not — `local.leave {url}` keeps the move stash, so skipping it could leave an
abandoned older stash for the new account), then `local.leave {url}`. Every
such tap is gated on `navigator.onLine !== false` (offline → an in-page error,
nothing stashed, no op). The shell clears the slot after the leave. A slot
older than 14 days (`receivedAt`) is cleared and ignored. **Older shells**:
no `invite.pending` in `shell.ops` → the page never reads a slot and never
sends `{url}` (a pre-v3 shell would ignore it and land on its native first
run after the stash was written); the Move row and file steps stay.

**The stash** is one app-private file, `noBackupFilesDir/move/vault.json`
(`Move.kt`): the vault v1 JSON in plain text, in the same app sandbox as the
local origin's plaintext IndexedDB (no new exposure), never backed up
(`no_backup/`), never sent anywhere, never logged. It is deleted after the
import (`move.clear`), by `local.reset`, and whenever local mode is entered
again — *Only on this device* → *Start* abandons the move (the next one
stashes afresh). While a stash exists the local intro shows the warn note *A
move to a cloud account is waiting.* and *Start and cancel the move* (N2 ·
move); unlike iOS, which hides its one-tap *Continue on
this iPhone*, Android keeps *Only on this device* reachable: it is the only
way back to local mode, and *Back* on the intro keeps the stash. Op contract:
[Local mode: the shell](#local-mode-the-shell-bd-med-nt9p324) above.

**Fallback: the file** (bd med-nt9p.32.10, the file-based Move iOS ships,
[ios.md → Backup, restore, move to cloud](ios.md#local-mode-the-bundled-app-on-wgapplocal-bd-med-o7zq4)),
for shells without `move.stash` and when the stash is refused:

1. Settings → Backup & import → **Export backup** → the passphrase sheet (a
   passphrase is optional; without one the API keys are in plain text and the
   page asks first) → *Backup ready* → **Save to device** → the shell's *Save
   to device* (Downloads) or *Share*.
2. The shell's **Switch account**: first run. (The page's *I have an invite*,
   which sent `local.leave`, is gone since bd med-ckm5.7: one Move control.)
3. Claim the invite; in the new account Settings → Backup & import → Restore
   → choose the file (an empty account skips the confirm).

Accounts are **invite-only** ([architecture.md](architecture.md), no
self-serve signup): the intro says *To move to an account later: Settings →
Move to a cloud account. Accounts are invite-only.* and ends with the *How to
get an invite* link — the service landing page
`https://<BuildConfig.BASE_DOMAIN>/`, the build's own address, never committed.
The privacy policy has no contact e-mail (its contact is the issue tracker and
in-app feedback), so the landing page is the invite contact for now.

**Emulator proof, seamless** — QA scenario `local-to-cloud-seamless` (not in
`all`: it claims the run's one invite, which `smoke` takes there; no retry).
`pm clear` → local mode seeded with the golden vault → Settings home → *Move
to a cloud account* → *Continue* → first run with the hint → the stash is
read back (`run-as … cat no_backup/move/vault.json`, plain JSON) and checked
against `tests/fixtures/vault-v1.json` (`format`/`version`, every data
section) and the store's counts → *Only on this device* shows the pending-move
note, *Back* keeps the stash → the runner's invite, claimed with the soft
authenticator (`smoke`'s `claimAccount`) → **without** Backup & import the
pickup's toast shows (no *Not uploaded yet*, no *Records not moved*) → the
stash is gone and the account's per-list counts are at least the local
store's (the `GATED` lists of `local-to-cloud`) → Switch account → *Only on
this device* → *Start* → the local counts are unchanged.
`results.localToCloudSeamless` has the counts and whether the replace confirm
showed (`pickupConfirm`).

**Emulator proof, file fallback** — QA scenario `local-to-cloud` (same
invite rule): Backup & import → Export backup → *Backup ready* → Save to
device → the gzipped file under `cache/downloads/` checked against the
fixture → *Save to device* through DocumentsUI → *Switch account* → claim →
Restore via the system picker
(or injected bytes; `results.localToCloud.restorePicker`) → account ⊇ local →
back to local, unchanged.

```bash
gh workflow run android-qa.yml --ref <branch> -f scenario=local-to-cloud-seamless
gh workflow run android-qa.yml --ref <branch> -f scenario=local-to-cloud
```

| Run | Result |
|---|---|
| `local-to-cloud-seamless`, emulator API 34 (runs `39335690786`, `39345504891`) | PASS, 14 steps: the row → first run with the hint, stash = plain vault v1 (fixture shape, counts = store), intro note + *Back* keeps the stash, claim (soft authenticator), pickup with **no** confirm on the empty account and no Backup & import, the toast, stash gone, account ⊇ local (`workouts.sessions` 1 → 2, the planned session), local unchanged after *Only on this device* → *Start*. The onboarding *Skip all* step times out (the pickup reloads the page under it; best-effort, not gated) |
| `local-to-cloud`, emulator API 34 (run `39273862148`) | PASS, 16 steps: export 4.5 KB vault v1 (fixture shape, counts = store), saved to Downloads, *I have an invite* → first run, claim, Restore via the **system picker** (no injection), uploaded (no *Not uploaded yet*), account ⊇ local (`workouts.sessions` 1 → 2: the account materialized today's planned session), local unchanged after *Only on this device* → *Start* |
| Owner phone | pending — release gate `med-nt9p.32.7`, check 9 below |

### Local mode: free trial (bd med-nt9p.32.8.4)

The anonymous trial (AI, the operator's food database, voice calls) in local
mode — the twin of iOS `Attest.swift`, in
[`Attest.kt`](../android/app/src/main/java/com/example/medtracker/Attest.kt)
(bytes in `AttestWire.kt`). The page side is unchanged: `local-policy.js`
keys on `window.Attest` (`native/attest.js`'s android impl), `local-trial.js`
sends the Android enroll body. Server: [cloud-mode.md → Android — Play
Integrity](cloud-mode.md#android--play-integrity).

| op (local mode only) | does |
|---|---|
| `attest.status` | `{supported, base, attested}`, no network. `supported`: Google Play services available **and** the build has `PLAY_CLOUD_PROJECT_NUMBER` **and** a base domain. `attested`: the current key was handed to the page by an enroll |
| `attest.enroll {challenge}` | `{kind:"android", keyId, publicKey, integrityToken, pass?}`. The current AndroidKeyStore EC P-256 key (alias `wg-attest-<n>`, sign-only, SHA-256, no user auth) or a new one when none is usable; `keyId` = base64url-nopad(SHA256(SPKI DER)), `publicKey` the SPKI DER (std base64); the Play Integrity **standard** request's `requestHash` = base64url-nopad(SHA256(challenge ‖ keyId ‖ SPKI DER)). The token provider is prepared once per process, lazily in the first enroll (re-prepared once on `INTEGRITY_TOKEN_PROVIDER_INVALID`). A failure rejects with the Play error constant name only |
| `attest.setPass {pass}` | stores the server's trial pass; `""` deletes it |
| `attest.assert {challenge, bodySha256}` | `{keyId, assertion}`: counter + 1 is stored **before** signing; assertion = counterBE32 ‖ SHA256withECDSA(SHA256(challenge ‖ bodySha256) ‖ counterBE32). `no_key` when there is no usable key — the page enrolls again |

- **State:** SharedPreferences `wg_trial` (pass, key alias, attested alias,
  counter). Nothing is logged: the diagnostics log is user-copyable, and
  neither the token nor the pass may reach it.
- **Reinstall:** Keystore keys never restore, so a reinstall rejoins its
  trial bucket only through the pass: `shared_prefs/wg_trial.xml` is in the
  Auto Backup include rules ([Local mode backup](#local-mode-backup-bd-med-nt9p325)).
  A restored file brings the pass and counter back but not the key, so the
  first enroll makes a new key and presents the pass. Without a backup (off,
  or no encryption) a reinstall founds a fresh bucket, so the Android consent
  copy (`Attest.copy.trialTransit`) does not promise a rejoin.
- **Play-installed build:** the server accepts `PLAY_RECOGNIZED` by default,
  which only a build installed from Play gets; a sideloaded CI APK reads
  `UNRECOGNIZED_VERSION` and needs the server's
  `PLAY_INTEGRITY_ACCEPT_APP_VERDICTS` window.
- **QA / emulator:** android-qa.yml builds without the project number, so
  `attest.status` answers `supported:false`: the trial row is hidden and there
  is zero egress. Play Integrity cannot pass on the emulator anyway. The
  `local-smoke` scenario (bd med-nt9p.32.6) should assert exactly that.
- **Tests:** `AttestTest.kt` pins the derivations against the same vectors as
  `internal/playintegrity/vectors_test.go`, the assertion layout and the
  counter.

## Play Integrity setup (owner)

Owner-only Google Cloud setup for the Android free trial (bd med-nt9p.32.8.1, a human bead). Nothing from this goes into the repo or chat; do it whenever suits.

1. **Google Cloud Console** → pick the project you used for Play (or create one) → note its **project number** (Dashboard → Project info).
2. **APIs & Services → Library** → search "Google Play Integrity API" → **Enable**.
3. **IAM & Admin → Service accounts → Create service account**, name it `play-integrity-verifier`. No roles needed. Open it → **Keys → Add key → JSON** → a file downloads.
4. Store that JSON in stash: `~/stash/kv put secrets/play-integrity-sa-json "$(cat <file>.json)"`, then delete the downloaded file. Never paste it into chat or Zulip.
5. **Play Console** → the app → **Test and release → App integrity → Play Integrity API** → **Link a Cloud project** → choose the project from step 1.
6. **GitHub** → repo → Settings → Secrets and variables → Actions → **Variables** → new variable `ANDROID_PLAY_CLOUD_PROJECT_NUMBER` = the project number. Either a variable or a secret of that name works (the workflow reads the variable first, then the secret).

Later, after the server part merges (owner approval asked then): the JSON goes onto the production server as `/app/data/secrets/play-integrity.json`, and the stack gets `PLAY_INTEGRITY_PACKAGE_NAME` and `PLAY_INTEGRITY_SERVICE_ACCOUNT_FILE=/app/data/secrets/play-integrity.json`. If prod then answers 403, grant the service account **Service Usage Consumer**. See [environment.md](environment.md) for the variables.

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

A reviewer without an invite can use **Only on this device** (no account,
no passkey); its upgrade path to an account is
[Moving to a cloud account](#moving-to-a-cloud-account-bd-med-nt9p3210).

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
  (see dontkillmyapp.com for the per-vendor steps). A force-stop (Settings →
  Force stop, or some OEM "clean" buttons) cancels every alarm until the app
  is opened again.
- **No Google Play services, no passkey PRF.** The vault key derives from the
  passkey PRF, which the Credential Manager provides only with Google Play
  services and a passkey provider (Google Password Manager or another).
  Devices without them (some de-Googled and Huawei phones) cannot create or
  unlock an account in the app.
- Minimum Android 14 (API 34).
