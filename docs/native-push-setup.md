# Native push setup (owner checklist)

Click-by-click steps to switch on native push (APNs for iOS, FCM for Android) for the app shells. Written for the owner, doable from a phone or laptop; no repo checkout needed. Background: [docs/environment.md](environment.md) (`APNS_*` / `FCM_*`), [docs/android.md](android.md), [docs/ios.md](ios.md).

Push carries a fixed, content-free notification ("Open the app to ..."); no account data leaves the vault.

**Secret hygiene.** Paste keys and key files only into GitHub repository secrets/variables and the cloud stack's secret env. Never into chat, issues, commits or the compose file.

Order: do section 1 and 2 (they are independent), then section 3, then the device check in section 4. Nothing breaks if you do only one platform: each platform is independent and stays off until all of its settings exist.

## 1. Apple (iOS)

You need the paid Apple Developer account that owns the app.

1. Open developer.apple.com/account, sign in. **Membership details** shows your **Team ID** (10 characters). Note it. It must equal the repo variable `IOS_TEAM_ID`.
2. **Keys** (Certificates, Identifiers & Profiles → Keys) → the **+** button.
   - Key Name: anything (e.g. `push`). Tick **Apple Push Notifications service (APNs)**; if Apple asks for the key's environment, choose **Sandbox & Production** (or Production): a Sandbox-only key is refused for TestFlight and App Store builds. Continue → Register.
   - Note the **Key ID** (10 characters) shown on the page.
   - **Download** the `.p8` file now: Apple lets you download it only once. Keep it safe; you paste its content in section 3.
3. **Identifiers** → open the app's App ID. Its Bundle ID is the repo variable `IOS_BUNDLE_ID` (GitHub → Settings → Secrets and variables → Actions → Variables). Under Capabilities tick **Push Notifications** → Save (confirm the prompt).
4. **Profiles** → open the **App Store** distribution profile of that App ID. The release build uses a *manual* profile stored as the GitHub secret `IOS_APPSTORE_PROFILE_BASE64`, so the old profile does not know about Push until regenerated:
   - Edit (or Generate a new one for the same App ID and the same distribution certificate) → Save → **Download** the `.mobileprovision`.
   - Base64 it on a computer: `base64 -i <file>.mobileprovision | pbcopy` (macOS) or `base64 -w0 <file>.mobileprovision` (Linux).
   - GitHub repo → Settings → Secrets and variables → Actions → **Secrets** → `IOS_APPSTORE_PROFILE_BASE64` → Update → paste → Save.
5. The next TestFlight build is the first with push: ask the iOS developer to start it (a manual dispatch of the iOS workflow). `.github/workflows/ios.yml` adds the `aps-environment` entitlement only when the profile carries Push.
6. Check in that run's log, step "Archive and upload to TestFlight":
   - Good: line `aps-environment production`.
   - Not yet: `::notice::The App Store profile has no Push capability: built without aps-environment ...` means the profile from step 4 was not regenerated, or the wrong profile was uploaded. Repeat step 3-4.

Values to carry to section 3: the `.p8` file content, Key ID, Team ID, Bundle ID.

## 2. Google (Android)

The Android app id is the value of the repo variable `ANDROID_PACKAGE` (GitHub → Settings → Secrets and variables → Actions → Variables). Do not use `com.example.medtracker`: that is only the Kotlin namespace, not the app id.

1. Open console.firebase.google.com, sign in with the Google account that should own push. **Create a project** (Google Analytics may stay off: the app uses no analytics and no google-services plugin).
2. Project overview → **Add app** → Android icon. Package name: the `ANDROID_PACKAGE` value. App nickname optional. **SHA-1 is not needed** for push. Register app.
3. Download `google-services.json` (or open Project settings → General → Your apps → the Android app → Download). **Do not commit it** and do not add it to the repo: the build reads four values instead (`android/app/build.gradle.kts`, "Native push" block). You only copy the values, then delete the file.
4. GitHub repo → Settings → Secrets and variables → Actions → **Variables** (a secret of the same name also works) → New repository variable, four times:

   | Variable | Value in `google-services.json` |
   |---|---|
   | `FIREBASE_APP_ID` | `client[0].client_info.mobilesdk_app_id` |
   | `FIREBASE_API_KEY` | `client[0].api_key[0].current_key` |
   | `FIREBASE_PROJECT_ID` | `project_info.project_id` |
   | `FIREBASE_SENDER_ID` | `project_info.project_number` |

   **All four or none**: with one missing the build has no FCM at all and `push.token` answers null. Then delete the downloaded JSON.
5. Firebase → Project settings (gear) → **Service accounts** → **Generate new private key** → Generate. A JSON file downloads: this is the server credential for section 3. Keep it safe.
6. Firebase → Project settings → **Cloud Messaging** tab: **Firebase Cloud Messaging API (V1)** must show **Enabled** (enable it via the three-dot menu / Google Cloud link if not). The legacy Cloud Messaging API stays disabled.
7. **A new Play build is needed.** The four values are baked in at build time, so Android push works only from the first Play build made after they are set. Ask the Android developer to schedule that build.

Values to carry to section 3: the service-account JSON, and the project id (same as `FIREBASE_PROJECT_ID`).

## 3. Cloud stack env

Set these in the Portainer stack's **secrets / environment** for the cloud service, not in the compose file, then redeploy the stack. Reference: [docs/environment.md](environment.md) (native push block).

| Variable | Value |
|---|---|
| `APNS_KEY_P8` | **base64** of the `.p8` file: `base64 -i AuthKey_XXXX.p8` (macOS) or `base64 -w0 AuthKey_XXXX.p8` (Linux). Do not paste the multi-line PEM: Portainer's field is single-line and drops the newlines, which breaks the key |
| `APNS_KEY_ID` | Key ID from section 1 step 2 |
| `APNS_TEAM_ID` | Team ID from section 1 step 1 |
| `APNS_BUNDLE_ID` | the app's Bundle ID (`IOS_BUNDLE_ID`) |
| `APNS_SANDBOX` | leave unset (or `0`) for TestFlight and App Store builds; `1` only for Xcode-run development builds |
| `FCM_PROJECT_ID` | Firebase project id (same as `FIREBASE_PROJECT_ID`) |
| `FCM_SERVICE_ACCOUNT_JSON` | content of the service-account JSON from section 2 step 5: **base64** of the file (same command as above); raw JSON also parses, base64 is the safe paste |

A platform is on only when all its variables are set. A partial or unparseable set never stops the server; it only keeps that platform off.

Check in the cloud service's startup log:

- `level=INFO msg="native push" ios=true android=true` (search for `msg="native push"`; a platform you did not configure shows `false`).
- Errors name the variables, never values: `native push: APNs config invalid, iOS push off` or `native push: FCM config invalid, Android push off`. Re-check the paste (a truncated key is the usual cause) and redeploy.

## 4. Final device check (per platform)

1. Install the build made after the steps above: TestFlight build for iOS, Play build for Android.
2. Open the app, sign in in account (cloud) mode.
3. Allow notifications when the system asks (Settings → the app → Notifications if you declined earlier).
4. In the app, Settings shows `Wake-ups: on` once the device token is registered. `Wake-ups: off (not connected yet)` or `Wake-ups: off (allow notifications)` means it is not.
5. Close the app fully (swipe it away).
6. Send any message to the account's Telegram bot: a notification "Open the app to record what you sent" arrives. Without Telegram: before closing the app, open Settings → Add a device and note the link/code, close the app, then open that link/code on another device (e.g. a laptop browser); the phone gets "Approve the new device?".

Do not use a reminder as the test. Reminders are not sent through native push (iOS uses local notifications, other channels use web push or Telegram), so a reminder arriving proves nothing about APNs/FCM.

If it does not arrive: confirm the startup log line in section 3 shows that platform `true`, the build is the new one (sections 1.6 and 2.7), and notifications are allowed for the app.
