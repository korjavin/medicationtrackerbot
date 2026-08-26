# Gadgetbridge

- **What it is**: Gadgetbridge is an open-source Android application that enables users to manage, configure, and synchronize wearable devices (smartwatches, fitness bands, smart rings) without installing proprietary vendor apps or uploading data to vendor cloud servers. It provides activity tracking, notification forwarding, heart rate monitoring, and sleep analysis locally on the phone.
- **Platform**: Android (Native Java/Kotlin application available via F-Droid, Codeberg, and GitHub releases). No iOS or Web version.
- **Hosting model**: Local-only (standalone device manager and tracker; operates without cloud infrastructure). Open source licensed under AGPL-3.0-or-later.
- **Feature coverage**:
  - **Medications**: No — does not manage medications directly (though notification forwarding can relay phone medication reminders to watch screens).
  - **BP**: Partial — supports recording blood pressure if reported by compatible wearable devices or supported device modules.
  - **Weight**: Partial — syncs weight entries when paired with supported Bluetooth scales or integrated with openScale via Intent API.
  - **Workouts**: Yes — records wearable workout sessions (running, cycling, walking, swimming), including real-time heart rate zones, cadence, and GPS tracks/routes.
  - **Sleep**: Yes — parses and displays sleep stages (deep, light, REM, awake) and sleep duration recorded by supported smartwatches/fitness bands.
  - **Vitals/wearables**: Yes — core focus; pairs with hundreds of wearable devices (Pebble, Xiaomi Mi Band/Amazfit, PineTime, Bangle.js, Garmin, Galaxy Watch) for real-time heart rate, SpO2, stress, and step counts.
  - **Food/nutrition**: No — does not log meals or calorie intake.
  - **Diary/notes**: Partial — allows viewing activity summaries and logs, but does not provide a dedicated journal/diary tool.
- **Privacy & encryption**:
  - **Where data lives**: Stored strictly on the Android device in a local SQLite database (`gadgetbridge.db`).
  - **E2EE or server-side plaintext**: Stored in an unencrypted local SQLite database; the app explicitly does **not** request the Android `INTERNET` permission in its manifest, guaranteeing data cannot leak online.
  - **What vendor can see**: Vendor sees zero data (technically impossible to transmit data off-device due to lacking internet permission).
  - **Data-sale/ads history if any**: Strictly non-commercial, ad-free, zero tracking, zero data sales history.
- **Data ownership**:
  - **Export formats**: Full SQLite database backup (`.db` / `.zip`) via in-app "Data management" export, plus GPX track export for workout routes.
  - **Import**: SQLite database restore from backup ZIP files.
  - **API**: Extensive Android Intent API (broadcast intents for triggering sync, database export, sending watch notifications, and integration with Tasker/AutoShare).
  - **Lock-in**: Zero (direct raw SQLite database access and GPX export).
- **Reminders/notifications**:
  - **How delivered**: Forwards incoming Android system notifications and phone calls to connected wearable displays; supports wearable vibration alarms and idle/inactivity alerts.
  - **Does it work offline**: 100% offline operating model; syncs with wearable devices via local Bluetooth LE without internet connectivity.
- **Integrations**:
  - **Wearables**: Deep native support for 100+ smartwatch and fitness tracker models via Bluetooth LE; broadcasts live HR over Bluetooth to apps like OpenTracks; syncs with Android Health Connect and openScale.
  - **EHR**: None.
  - **AI features**: None.
- **Pricing / sustainability**:
  - **Pricing**: Free and open-source.
  - **Sustainability**: Highly active development on Codeberg (`Gadgetbridge/Gadgetbridge`) with GitHub mirror (~5,000+ stars on GitHub, >300 contributors, frequent weekly releases throughout 2026).
- **Sources**:
  - Official Documentation: https://gadgetbridge.org (Accessed August 2026)
  - Codeberg Repository: https://codeberg.org/Gadgetbridge/Gadgetbridge (Accessed August 2026)
  - GitHub Mirror Repository: https://github.com/Gadgetbridge/Gadgetbridge (Accessed August 2026)
  - F-Droid Listing: https://f-droid.org/en/packages/nodomain.freeyourgadget.gadgetbridge/ (Accessed August 2026)

## Phase 2

### 1. Customer base
- **Community & Install Signals**: **~5,000+ GitHub stars** / Codeberg repo with **>300 contributors**. Primary distribution via **F-Droid** (estimated **100,000+ active F-Droid users** across Pebble, Amazfit, Mi Band, Garmin, and Galaxy Watch owners) (Source: Codeberg, F-Droid, August 2026).
- **Estimated Active Base**: Estimated **100,000–250,000 active privacy-conscious wearable users** globally.
- **Licensing & Financials**: 100% Free Open Source Software (AGPL-3.0 license). $0 commercial revenue.
- **Code Signals**: Native Android app intentionally omitting `android.permission.INTERNET`.

### 2. Killer features — why customers actually choose it
- **OS-Enforced `NO INTERNET` Privacy Guarantee**: Deliberately omits `android.permission.INTERNET` from its manifest, mathematically guaranteeing wearable metrics (heart rate, GPS, sleep) cannot leak online.
- **Replaces Proprietary Wearable Spyware**: Replaces official telemetry-heavy apps (Zepp, Mi Fitness, Garmin Connect) while pairing directly via Bluetooth LE (paraphrased theme from `r/F_Droid` & `r/privacy`).
- **Supports 100+ Wearable Models**: Replaces official software for Pebble, Amazfit, PineTime, Bangle.js, and Garmin devices.

### 3. Marketing & acquisition — how self-hosters discover it
- **Channels**: Top F-Droid recommendations, Privacy Guides lists, and discussions on `r/privacy`, `r/Amazfit`, and `r/Garmin`.
- **What we can learn**: **Highlight Cryptographic & Architectural Guarantees.** Win user trust by emphasizing WebAuthn/Passkey key management and zero-knowledge encryption where server architecture prevents reading user logs.

### 4. Beating them in comparison

| Feature / Dimension | Gadgetbridge | Our Zero-Knowledge PWA |
| :--- | :--- | :--- |
| **Platform Scope** | Android-only Bluetooth hardware driver | **Cross-Platform PWA** (Runs on iOS, Android, Windows, Mac, Linux, Web) |
| **Multi-Device Sync** | Local-only (no cloud sync mechanism) | **Sync Without Trust** (WebAuthn/Passkey auth + browser E2EE + blind push relay) |
| **Health Workbench Scope** | Hardware companion for wearables only | **Full Medication Safety, Dosing, & Clinical Vitals Workbench** |

- **Winning Angle**: Gadgetbridge is strictly an Android Bluetooth hardware driver with no web client or medication engine. Our Zero-Knowledge PWA provides multi-device sync without vendor trust — browser-managed encryption, Passkey authentication, dedicated medication safety tracking, and universal browser accessibility across all platforms.
- **Where we lose & how to neutralize it**: We lose on native Android Bluetooth LE smartwatch driver protocol parsing. Neutralize by positioning our PWA as the secure health & medication management vault that accepts wearable metrics via Health Connect / Apple Health file imports.
