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
| `CLOUD_BASE_DOMAIN` | already set for deploy verification; the app opens `https://<it>/` |

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

## Spike: passkey PRF, Service Worker, IndexedDB in WKWebView (bd med-w6gx.2)

The GO/NO-GO gate for the remote-origin design. The app the workflow ships
carries a throwaway diagnostic ([`ios/App/Spike.swift`](../ios/App/Spike.swift),
removed by the shell bead): a stethoscope button on the right edge opens a
panel that opens URLs, runs checks against the page currently loaded, and
keeps a report across app kills, host names redacted before they are stored
(`<base>`, `<sub-xxxxxx>` = short hash per account) so it can be pasted into a bead.

What the build sets up (all in [`ios/project.yml`](../ios/project.yml)):

- **Associated Domains** `webcredentials:*.<base>` — passkeys for every
  account subdomain, confirmed by the server's AASA route (med-w6gx.1).
- **`WKAppBoundDomains`** `<base>` and `*.<base>`, with
  `limitsNavigationsToAppBoundDomains = true` — the precondition for Service
  Workers in WKWebView. A host outside the list fails to load with a
  `WKErrorDomain` "app-bound" error in the report.
- `NSCameraUsageDescription`, inline media playback, a `wgSpike` reply message
  handler, and a passive tap on `navigator.credentials.create/get` that logs
  (as `tap {...}`) whether the app's **own** ceremonies returned PRF results —
  never the bytes.
- The app relaunches to the last base/account URL it loaded (fragment stripped),
  so kill/relaunch tests the account origin.

### Prerequisites

1. Everything in [Owner setup](#owner-setup-github--settings--secrets-and-variables--actions).
   If the archive step fails on the Associated Domains entitlement, enable
   *Associated Domains* on the App ID (developer portal → Identifiers) and
   re-run.
2. Production serves the AASA: set `IOS_TEAM_ID` / `IOS_BUNDLE_ID` in the
   cloud env (docs/environment.md) and check that
   `https://<base>/.well-known/apple-app-site-association` and the same path on
   an account subdomain return `{"webcredentials":{"apps":["<TEAM>.<bundle>"]}}`.
   Apple fetches it through its CDN
   (`https://app-site-association.cdn-apple.com/a/v1/<host>`), which can lag
   by hours after the first deploy.
3. Two invites from `cloud admin invite` — a dedicated test account, never a
   real user's: **A** (claimed in iPhone Safari first, so it is an existing
   vault) and **B** (claimed in the app — a subdomain no build ever named).
4. iPhone on iOS 18+, passcode/Face ID on, iCloud Keychain on.

### Device run

Actions → **iOS** → Run workflow on the spike branch (or master once merged);
install from TestFlight. Tap **Copy report** at the end and paste it into the
bead.

1. **Claim B in the app.** Panel → paste B's claim link → Open → finish the
   claim. Expect `tap` lines `webauthn.create ok:true` then
   `webauthn.get ok:true prfFirst:true`, and the app unlocked on a `<sub-…>` host.
2. **Probe on B.** Panel → *Passkey create + PRF* (creates a passkey named
   "iOS spike - delete me"; delete it in Passwords afterwards) → *Passkey get
   + PRF*. Expect `ok:true` and `prfFirstBytes: 32` on the get.
3. **Checks on B.** *Run checks*. Expect `bridge.reply.pong: true`,
   `serviceWorker.registrations` with an `activated` worker, `idb.keyUsable:
   true`, `camera.videoTracks: 1` (allow the camera prompt).
4. **Kill/relaunch.** Swipe the app away, reopen. Expect it back on B,
   unlocked with **no** passkey prompt (warm unlock). *Run checks*: expect
   `idb.markerFromEarlierLaunch: true`, `keyFromEarlierRun: true`,
   `keyUsable: true`, `serviceWorker.controlled: true`.
5. **Offline.** Airplane mode on, kill, reopen. Expect the app to render (from
   the Service Worker), not a load error; *Run checks* shows `online: false`,
   `controlled: true`. Airplane mode off.
6. **Cold unlock of A.** Panel → open A's account URL (`https://<A>.<base>/`)
   → unlock with the passkey made in Safari. Expect `tap webauthn.get ok:true
   prfFirst:true` and the vault's data. *Reset web data* then reload repeats a
   cold unlock if needed.

### GO / NO-GO criteria

| # | Check | GO when | On failure |
|---|-------|---------|------------|
| 1 | Passkey create + get on an arbitrary subdomain | steps 1, 2, 6 `ok:true` on both A and B | **NO-GO** — stop, hand back to the architect (native ASAuthorization PRF bridge) |
| 2 | PRF in WKWebView | `prfFirst:true` on the real claim and cold unlock; probe get `prfFirstBytes: 32` | **NO-GO** — same as 1 |
| 3 | Service Worker + wildcard app-bound domain | B loads at all, worker activated, controlled after relaunch, offline relaunch renders | NO-GO for this design — architect |
| 4 | IndexedDB + non-extractable key survive kill | step 4 values all true, warm unlock without a prompt | NO-GO for this design — architect |
| 5 | `getUserMedia` camera | `videoTracks: 1` | recorded gotcha; architect decides (native camera) |
| 6 | JS → Swift reply round trip | `bridge.reply.pong: true` | NO-GO for the bridge bead (med-w6gx.4) — architect |

GO = 1–4 and 6 pass. The verdict and the pasted (redacted) report go into a
**Findings** section here: iOS version, what worked, gotchas.

### Findings

Pending the device run.
