# Loop Habit Tracker

- **What it is**: Loop Habit Tracker (uhabits) is an open-source Android application designed to help users establish and maintain positive habits over long time horizons. It calculates a habit strength score based on consistency, presents detailed progress charts, and provides customizable reminders without cloud dependency.
- **Platform**: Android (Native Java/Kotlin application with Material Design UI available on Google Play, F-Droid, and GitHub). No official iOS, web, or desktop app.
- **Hosting model**: Local-only (runs entirely on-device; no cloud servers or online accounts). Open source licensed under GPL-3.0-only.
- **Feature coverage**:
  - **Medications**: Partial — can be configured as recurring daily/weekly habit reminders for medication intake, but lacks dosage/inventory management.
  - **BP**: No — no direct blood pressure tracking (unless set up as a custom binary habit entry).
  - **Weight**: Partial — supports numerical habit tracking (e.g., daily target numbers), but lacks dedicated weight charting/BMI tools.
  - **Workouts**: Partial — tracks workout frequency and consistency as habits (e.g., "Gym 3x/week"), but does not record workout sets, weights, or exercise routines.
  - **Sleep**: Partial — tracks sleep consistency as numerical or boolean habits (e.g., "Slept >7 hours"), but lacks sleep stage detection or wearables analysis.
  - **Vitals/wearables**: No — no direct wearable device integration or vitals monitoring.
  - **Food/nutrition**: Partial — tracks dietary habits (e.g., "Eat 5 vegetables", "No soda"), but does not log detailed food/calories/macros.
  - **Diary/notes**: Yes — allows adding free-form notes and reason logs to each habit completion entry.
- **Privacy & encryption**:
  - **Where data lives**: Local SQLite database stored securely on Android internal storage.
  - **E2EE or server-side plaintext**: Stored in a local plaintext SQLite database; does not use network or request cloud access.
  - **What vendor can see**: Vendor sees zero data; no user tracking, analytics, or central accounts.
  - **Data-sale/ads history if any**: Completely free, ad-free, open-source, with zero history of selling data.
- **Data ownership**:
  - **Export formats**: CSV spreadsheet export and raw SQLite database export (`.db`).
  - **Import**: CSV import (for restoring habits or migrating from other habit apps) and SQLite database import.
  - **API**: Android Intent API and third-party automation integration (Tasker, Automate).
  - **Lock-in**: Zero (full CSV and SQLite DB import/export).
- **Reminders/notifications**:
  - **How delivered**: Customizable Android local notifications per habit with actionable buttons (check off, snooze, or skip directly from the notification shade).
  - **Does it work offline**: Operates 100% offline; all habit notifications and calculations run locally without network access.
- **Integrations**:
  - **Wearables**: Historical notification interaction support on Wear OS / Android Wear; no standalone wearable app.
  - **EHR**: None.
  - **AI features**: None.
- **Pricing / sustainability**:
  - **Pricing**: Free and open-source; no ads or paid subscriptions.
  - **Sustainability**: Highly active repository (`iSoron/uhabits`) with ~10,200+ GitHub stars, 57 code contributors (70+ lifetime community translators/contributors), active development and updates throughout 2026.
- **Sources**:
  - GitHub Repository: https://github.com/iSoron/uhabits (Accessed August 2026)
  - F-Droid Listing: https://f-droid.org/en/packages/org.isoron.uhabits/ (Accessed August 2026)
  - Google Play Listing: https://play.google.com/store/apps/details?id=org.isoron.uhabits (Accessed August 2026)

## Phase 2

### 1. Customer base
- **User Count & Downloads**: Google Play Store bracket is **5,000,000+** downloads (`org.isoron.uhabits`) with ~50,000+ reviews (4.7-star rating). GitHub has **~10,200+ stars** and 57 contributors on `iSoron/uhabits`. Top featured habit app on F-Droid (Source: Google Play Store, GitHub, August 2026).
- **Estimated Active Base**: Estimated **250,000–500,000 Monthly Active Users (MAU)** globally.
- **Licensing & Financials**: 100% Free Open Source Software (GPL-3.0 license). $0 commercial revenue.
- **Code Signals**: Native Android app (Java/Kotlin) operating 100% offline.

### 2. Killer features — why customers actually choose it
- **Exponential Smoothing Streak Formula ("Habit Strength")**: Calculates habit score (0–100%) using exponential smoothing so missing a single day after months of consistency does not reset progress to zero.
- **100% Offline Local Zero-Ad FOSS**: Completely free with zero ads, tracking, or account walls (paraphrased theme from `r/QuantifiedSelf` & `r/androidapps`).
- **Flexible Scheduling & Notification Shade Actions**: Check off or snooze habits directly from Android system notifications.

### 3. Marketing & acquisition — how self-hosters discover it
- **Channels**: Top F-Droid catalogue recommendations, organic advocacy on `r/QuantifiedSelf`, `r/selfhosted`, `r/F_Droid`, `r/androidapps`, and inclusion in open-source app roundups.
- **What we can learn**: **Open-Source Directory Listings.** Position as a privacy-respecting, zero-telemetry utility in FOSS catalogues and privacy directories to drive viral word-of-mouth adoption.

### 4. Beating them in comparison

| Feature / Dimension | Loop Habit Tracker | Our Zero-Knowledge PWA |
| :--- | :--- | :--- |
| **Platform Scope** | Android-only local app (No iOS, Web, PWA, or Desktop access) | **Cross-Platform PWA** (Runs on iOS, Android, Windows, Mac, Linux, Web) |
| **Multi-Device Sync** | Local single-device storage only (no cloud sync mechanism) | **Sync Without Trust** (WebAuthn/Passkey auth + browser E2EE + blind push relay) |
| **Medication Safety Workflow** | Generic binary habit checklist (no pill doses, refill alerts, interaction warnings) | **Dedicated Medication Safety, Dosing, & Clinical Vitals Workbench** |

- **Winning Angle**: Loop is an Android-only habit app with no multi-device sync, no web interface, and zero medication features. Our Zero-Knowledge PWA provides multi-device sync without vendor trust — WebAuthn passkey security, dedicated medication safety tracking, and universal web browser access across all platforms.
- **Where we lose & how to neutralize it**: We lose on Loop's Android notification shade quick-check buttons. Neutralize with service worker push notifications and mobile-optimized single-tap logging buttons.
