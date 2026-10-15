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
| `ASC_KEY_ID` | App Store Connect → Users and Access → Integrations → Team Keys: create a key with the Admin role (Xcode creates the provisioning profile through it); its Key ID |
| `ASC_ISSUER_ID` | the Issuer ID shown above that key list |
| `ASC_KEY_P8_BASE64` | the downloaded `AuthKey_<id>.p8`, `base64 -i AuthKey_<id>.p8 \| pbcopy` |

The API key lets Xcode create and download the App Store provisioning profile
itself (`-allowProvisioningUpdates`); no profile secret is needed. Signing
material goes into a throwaway keychain on the runner and is deleted at the
end of the job. Secrets are bound only to the dispatch-gated signing steps, never
job-wide, so PR and push builds cannot read them. Optional hardening: move them
into a GitHub environment with required reviewers.

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
- **Not here:** the web app's "Add to Home Screen" prompts still show inside the
  app until the web side can tell it runs in the shell (`native/` ios platform,
  med-w6gx.4).

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
Identifiers).

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
