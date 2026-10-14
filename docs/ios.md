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
