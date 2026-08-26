# openScale

- **What it is**: openScale is an open-source Android application that connects directly to Bluetooth smart scales to record body weight and body composition metrics. It provides offline tracking, trend analysis, and synchronization capabilities without requiring proprietary vendor cloud backends or account registration.
- **Platform**: Android (Native application built with Kotlin and Jetpack Compose; available on Google Play, F-Droid, and GitHub). No iOS, Web, PWA, or Desktop versions.
- **Hosting model**: Local-only (standalone mobile application with optional companion app `openScale-sync` for remote server syncing). Open source licensed under GPL-3.0-only.
- **Feature coverage**:
  - **Medications**: No — contains no medication tracking functionality.
  - **BP**: Partial — permits manually logging blood pressure (systolic/diastolic/pulse) and body temperature alongside weight entries.
  - **Weight**: Yes — extensive tracking of weight, BMI, body fat %, muscle mass, water %, bone mass, and visceral fat from Bluetooth scales or manual entries.
  - **Workouts**: No — does not track exercises or workout routines.
  - **Sleep**: No — does not track sleep durations or sleep quality.
  - **Vitals/wearables**: Partial — pairs directly via Bluetooth LE with over 50 smart scale models (Xiaomi, Beurer, Sanitas, Yunmai, etc.) and records weight/fat/BP, but does not pair with smartwatches.
  - **Food/nutrition**: No — does not log food intake or calories.
  - **Diary/notes**: Yes — supports attaching custom comments/notes to individual measurement entries.
- **Privacy & encryption**:
  - **Where data lives**: Stored entirely on-device inside a local SQLite database.
  - **E2EE or server-side plaintext**: Stored in a local plaintext SQLite database; no vendor cloud backend exists.
  - **What vendor can see**: Vendor sees zero data (the core openScale app does not request Android `INTERNET` permission).
  - **Data-sale/ads history if any**: Completely ad-free, no telemetry, no tracking, zero history of selling data.
- **Data ownership**:
  - **Export formats**: CSV file export (weight and body metrics history) and full SQLite database backup.
  - **Import**: CSV import with customizable column mapping (supports importing from other commercial scale apps).
  - **API**: Inter-process integration via `openScale-sync` companion app, Android intents, and direct sync with MQTT, InfluxDB, Webhooks, Google Fit, wger, and Health Connect.
  - **Lock-in**: Zero (full CSV export/import and direct SQLite database access).
- **Reminders/notifications**:
  - **How delivered**: Local Android push notifications for daily or custom measurement reminders.
  - **Does it work offline**: Operates 100% offline; Bluetooth scale reading and notification reminders function without internet connectivity.
- **Integrations**:
  - **Wearables**: Pairs via Bluetooth LE with smart scales; syncs metrics to Android Health Connect, Google Fit, MQTT, and InfluxDB via `openScale-sync`.
  - **EHR**: None.
  - **AI features**: None.
- **Pricing / sustainability**:
  - **Pricing**: Free and open-source (no ads, in-app purchases, or subscriptions).
  - **Sustainability**: Active development (`oliexdev/openScale`) with ~2,500+ GitHub stars, >220 contributors, major v3.0 Kotlin/Jetpack Compose rewrite in late 2025 and active release cycle (v3.1+) in 2026.
- **Sources**:
  - GitHub Main Repository: https://github.com/oliexdev/openScale (Accessed August 2026)
  - GitHub Sync Companion Repo: https://github.com/oliexdev/openScale-sync (Accessed August 2026)
  - F-Droid Listing: https://f-droid.org/en/packages/com.health.openscale/ (Accessed August 2026)

## Phase 2

### 1. Customer base
- **Community & Install Signals**: **~2,500+ GitHub stars** and **>220 contributors** on `oliexdev/openScale`. Primary distribution via **F-Droid** (estimated **50,000–100,000 active F-Droid installations**, inferred from GitHub star ratios and F-Droid category popularity ranking; F-Droid does not publish official download metrics) and Play Store (`openScale sync` ~2,500+ downloads) (Source: GitHub, F-Droid, AppBrain, August 2026).
- **Estimated Active Base**: Estimated **50,000–100,000 active privacy-focused users** globally.
- **Licensing & Financials**: 100% Free Open Source Software (GPL-3.0 license). $0 commercial revenue.
- **Code Signals**: Native Android app (Kotlin / Jetpack Compose) without `INTERNET` permission.

### 2. Killer features — why customers actually choose it
- **Bypassing Vendor Scale Cloud Accounts**: Directly reads Bluetooth LE data from 50+ cheap smart scales (Xiaomi, Beurer, Yunmai, Sanitas) without installing vendor cloud apps (paraphrased theme from `r/F_Droid` & `r/selfhosted`).
- **Zero-Internet Local Privacy**: Core openScale app does not request Android `INTERNET` permission.
- **Home Assistant & MQTT Integration**: Syncs scale weight data directly to home automation MQTT brokers via `openScale-sync`.

### 3. Marketing & acquisition — how self-hosters discover it
- **Channels**: F-Droid catalogue recommendations, privacy subreddits (`r/F_Droid`, `r/selfhosted`, `r/QuantifiedSelf`), and Home Assistant forum tutorials.
- **What we can learn**: **Zero-Account Local Utility.** Market our PWA's instant local start and privacy guarantees to users looking for local-first health logging without cloud vendor tracking.

### 4. Beating them in comparison

| Feature / Dimension | openScale | Our Zero-Knowledge PWA |
| :--- | :--- | :--- |
| **Platform Scope** | Android-only local app (No iOS, Web, PWA, or Desktop access) | **Cross-Platform PWA** (Runs on iOS, Android, Windows, Mac, Linux, Web) |
| **Multi-Device Sync** | Local-only (requires custom MQTT setup for sync) | **Sync Without Trust** (WebAuthn/Passkey auth + browser E2EE + blind push relay) |
| **Health Domain Scope** | Weight/body composition only (No medication or symptom tracking) | **Full Medication Safety, Dosing, & Clinical Vitals Workbench** |

- **Winning Angle**: openScale is an Android-only app strictly focused on Bluetooth scales with no web interface or medication tracking. Our Zero-Knowledge PWA provides multi-device sync without vendor trust — WebAuthn passkey security, full medication adherence, symptom correlation, and universal web browser access.
- **Where we lose & how to neutralize it**: We lose on direct Web Bluetooth LE smart scale decoding. Neutralize by supporting CSV import of openScale weight logs.
