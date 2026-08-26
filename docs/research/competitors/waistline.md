# Waistline

- **What it is**: Waistline is a privacy-focused, open-source calorie counter and weight tracker application for Android. It enables users to manage a daily food diary, track macronutrients, scan food barcodes via Open Food Facts, and monitor body weight completely offline.
- **Platform**: Android (Hybrid mobile application built using Apache Cordova and Framework7 with JavaScript; available on Google Play, F-Droid, and GitHub). No native iOS app.
- **Hosting model**: Local-only (stores all food database and user logs locally on the device with no cloud server). Open source licensed under GPL-3.0.
- **Feature coverage**:
  - **Medications**: No — contains no medication management features.
  - **BP**: No — does not track blood pressure.
  - **Weight**: Yes — logs body weight over time with interactive graphs and target weight lines.
  - **Workouts**: Partial — allows logging exercise entries to calculate net daily calories burned, but lacks workout routine tracking.
  - **Sleep**: No — does not track sleep logs.
  - **Vitals/wearables**: No — no wearable sensors or heart rate monitor integrations.
  - **Food/nutrition**: Yes — comprehensive food diary with barcode scanner, macro breakdown (carbs, protein, fat, fiber), custom recipe builder, and Open Food Facts integration.
  - **Diary/notes**: Yes — daily food log serves as a meal diary with custom note support.
  - **Privacy & encryption**:
  - **Where data lives**: Stored strictly on local Android device storage within the app's internal database.
  - **E2EE or server-side plaintext**: Stored in unencrypted local application storage; network requests are made only to fetch barcode data from public Open Food Facts API endpoints over HTTPS.
  - **What vendor can see**: Vendor sees zero data; no central accounts, telemetry, or analytics servers exist.
  - **Data-sale/ads history if any**: Ad-free, no telemetry, no tracking, zero history of selling data.
- **Data ownership**:
  - **Export formats**: Export user data, food logs, and custom recipes to JSON and CSV formats.
  - **Import**: Import food databases, custom recipes, and log history from JSON files.
  - **API**: No REST API; local file import/export and community tools (e.g. `waistline-api`).
  - **Lock-in**: Minimal (full JSON/CSV export allows migrating food logs and recipes to other tools).
- **Reminders/notifications**:
  - **How delivered**: Basic local Android push notifications for meal logging reminders.
  - **Does it work offline**: Operates fully offline (uses a local food database; network connectivity is required only when querying unknown barcodes).
- **Integrations**:
  - **Wearables**: None.
  - **EHR**: None.
  - **AI features**: None.
- **Pricing / sustainability**:
  - **Pricing**: Free and open-source.
  - **Sustainability**: Maintained repository (`davidhealey/waistline`) with ~700+ GitHub stars, >20 contributors, with regular maintenance updates in 2026.
- **Sources**:
  - GitHub Repository: https://github.com/davidhealey/waistline (Accessed August 2026)
  - F-Droid Listing: https://f-droid.org/en/packages/com.waist.line/ (Accessed August 2026)
  - Official Website: https://waist-line.com (Accessed August 2026)

## Phase 2

### 1. Customer base
- **Community & Install Signals**: **~700+ GitHub stars** and **>20 contributors** on `davidhealey/waistline`. Distributed via **F-Droid** and Play Store (estimated **20,000–50,000 active users** across F-Droid and Play Store) (Source: GitHub, F-Droid, August 2026).
- **Estimated Active Base**: Estimated **20,000–50,000 active privacy-conscious users**.
- **Licensing & Financials**: 100% Free Open Source Software (GPL-3.0 license). $0 commercial revenue.
- **Code Signals**: Apache Cordova / JavaScript hybrid Android app.

### 2. Killer features — why customers actually choose it
- **FOSS Barcode Scanner (MyFitnessPal Alternative)**: Free food barcode scanning via Open Food Facts without ads, paywalls, or accounts (paraphrased theme from `r/fossdroid`).
- **100% Offline Local Food Diary**: Stores food logs locally on the device without requiring cloud registration.
- **Custom Recipe Builder**: Calculates total macros and portion sizes for custom home-cooked recipes.

### 3. Marketing & acquisition — how self-hosters discover it
- **Channels**: F-Droid catalogue features, Privacy Guides recommendation lists, and `r/fossdroid` / `r/selfhosted` discussions.
- **What we can learn**: **Target Free Barcode Scanning Refugees.** Market the zero-knowledge PWA's privacy features to users seeking open-source alternatives to commercial subscription paywalls.

### 4. Beating them in comparison

| Feature / Dimension | Waistline | Our Zero-Knowledge PWA |
| :--- | :--- | :--- |
| **Platform Scope** | Android-only local app | **Cross-Platform PWA** (Runs on iOS, Android, Windows, Mac, Linux, Web) |
| **Multi-Device Sync** | Local-only (no cloud sync mechanism) | **Sync Without Trust** (WebAuthn/Passkey auth + browser E2EE + blind push relay) |
| **Health Domain Scope** | Calorie/macro food tracking only | **Full Medication Safety, Dosing, & Clinical Vitals Workbench** |

- **Winning Angle**: Waistline is an Android-only calorie tracker with no web interface or medication workflow. Our Zero-Knowledge PWA provides multi-device sync without vendor trust — Passkey authentication, browser E2EE, dedicated medication safety tracking, and universal web browser access.
- **Where we lose & how to neutralize it**: We lose on Open Food Facts barcode food lookup. Neutralize by positioning our PWA as the specialized medication & symptom vault.
