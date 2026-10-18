# Android app — CI build and Play internal testing

The Android app (epic `med-nt9p`) is a thin Kotlin WebView shell in `android/`,
the twin of the iOS app ([ios.md](ios.md)). It is **never built locally**:
every build, signing and Play upload runs on a GitHub-hosted ubuntu runner via
[`.github/workflows/android.yml`](../.github/workflows/android.yml).

- `android/` is a plain Gradle project (AGP 8.7, Kotlin 2.0, JDK 17,
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
  runs). The package and the base domain are never committed.

## Owner setup (GitHub → Settings → Secrets and variables → Actions)

The debug APK builds with none of these. Until **all** the release ones exist,
a dispatch logs a notice naming what is missing, skips the Play upload and
stays green.

**Variables** (not secret):

| Name | Value |
|------|-------|
| `ANDROID_PACKAGE` | the Play app's package name (Play Console app record, bd med-nt9p.1) |
| `CLOUD_BASE_DOMAIN` | already set for deploy verification; the app accepts accounts at `<sub>.<it>` |

**Secrets:**

| Name | How to get it |
|------|---------------|
| `ANDROID_DEBUG_KEYSTORE_BASE64` | the stable debug key for PR/push APKs (below). Optional: without it each run signs with a throwaway key — the APK installs, but passkeys won't bind to it |
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

- **Sideload (spike, friends' phones):** open the PR's or master's Android run →
  Artifacts → `medtracker-debug-apk`, unzip, install the APK (allow *Install
  unknown apps* for the browser/files app). A debug APK and a Play install share
  the package but not the signature — uninstall one to switch to the other.
- **Play internal testing:** Actions → **Android** → Run workflow → pick the
  branch. Google requires the **first** AAB of a new app to be uploaded by hand
  in Play Console; after that every green dispatch lands in Test and release →
  Internal testing. While the app has never passed review, Play only accepts
  draft releases — dispatch with `release_status: draft` and roll the draft
  out in the Console.
