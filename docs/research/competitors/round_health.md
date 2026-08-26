# Round Health

- **What it is**: Round Health was a minimalist medication reminder app designed by Blythe Medical / Circadian Design and later acquired by digital pharmacy startup Alto Pharmacy. It was known for its clean aesthetic and "reminder windows" feature, which allowed users to set flexible time frames for taking medication rather than precise, rigid alarms.
- **Platform**: iOS (iPhone) and Apple Watch native application. No Android, web, PWA, or desktop apps were created.
- **Hosting model**: SaaS (cloud sync via account), though primarily local-first in operation. Closed-source proprietary software.
- **Feature coverage**:
  - **Medications**: Yes — offered flexible schedule windows, persistent push notifications, dose logging history, and pill refill counts.
  - **BP**: No — did not track blood pressure.
  - **Weight**: No — did not track weight.
  - **Workouts**: No — did not track workouts or physical activity.
  - **Sleep**: No — did not include sleep tracking.
  - **Vitals/wearables**: Partial — synced basic pill intake history with Apple Health, but lacked vital measurement inputs.
  - **Food/nutrition**: No — did not track food or nutrition.
  - **Diary/notes**: No — lacked a symptom diary or general health notes feature.
- **Privacy & encryption**:
  - **Where data lives**: Stored locally on iOS device with optional cloud backup to Alto Pharmacy servers.
  - **E2EE or server-side plaintext**: Standard TLS in transit and server-side encryption at rest; NOT end-to-end encrypted.
  - **What vendor can see**: Account email, device identifiers, and logged medication schedules under Alto Pharmacy's privacy terms.
  - **Data-sale/ads history if any**: Ad-free interface; no record of selling personal user data.
- **Data ownership**:
  - **Export formats**: None (did not provide CSV, PDF, or file export features).
  - **Import**: None.
  - **API**: None.
  - **Lock-in**: High lock-in due to complete lack of data export capabilities.
- **Reminders/notifications**:
  - **How delivered**: iOS local push notifications with persistent nudges throughout the configured time window, mirrored to Apple Watch.
  - **Does it work offline**: Yes — reminder windows were handled via local iOS notification scheduling and functioned offline.
- **Integrations**:
  - **Wearables**: Apple Watch native app and notifications.
  - **EHR**: No EHR integration.
  - **AI features**: None.
- **Pricing / sustainability**:
  - **Pricing**: 100% Free with no in-app purchases.
  - **Sustainability**: Delisted / abandoned following its acquisition by Alto Pharmacy in August 2017. No longer active for new users.
- **Sources**:
  - Alto Pharmacy Acquisition Release: https://medcitynews.com/2017/08/alto-buys-round-health/ (Accessed August 2026)
  - Alto Pharmacy Official Site: https://alto.com/ (Accessed August 2026)
  - Cadence Health Review / Round Health: https://cadencehealth.app/ (Accessed August 2026)

## Phase 2

### 1. Customer base
- **User Count & Downloads**: Delisted from App Store (approx. 2021–2023) post-acquisition by Alto Pharmacy in August 2017. Prior to delisting, maintained ~13,000+ iOS user reviews with a 4.5-star rating (Source: MedCity News August 2017, PitchBook, August 2026).
- **Estimated Active Base**: Estimated **250,000–600,000 lifetime iOS installs** prior to sunset (estimate derived from 13k+ App Store reviews). Currently abandoned/delisted.
- **Funding & Acquisition**: Developed by Circadian Design (Stanford Product Design alumni). Acquired in August 2017 by Alto Pharmacy (which raised $500M+ VC funding before merging with LetsGetChecked in 2025 to form Fuze Health) (Source: MedCity News 2017, LetsGetChecked Press Release 2025).
- **Code Signals**: Closed-source proprietary software; sunset iOS app.

### 2. Killer features — why customers actually choose it
- **Flexible "Reminder Windows" (Anti-Alarm Fatigue)**: Instead of rigid alarms at an exact minute, Round configured windows (e.g. 7 AM–9 AM) with subtle notifications, eliminating alarm anxiety and guilt over delayed doses.
- **Visual Clock Dial UI**: Minimalist circular clock interface visualizing scheduled doses throughout the day (paraphrased theme from `r/iOSSetups` & `r/adhd`).
- **Frictionless Onboarding**: Allowed immediate dose logging upon install without mandatory account registration.

### 3. Marketing & acquisition — how they win customers
- **Channels**: Design publication showcases (Medium UX breakdowns, Fast Company awards) and organic word-of-mouth on Reddit as the "pretty, non-stressful pill app" before being acquired as a top-of-funnel customer retention tool by Alto Pharmacy in 2017.
- **What we can learn**: **Adopt Flexible Dosing Windows.** Implement flexible dose windows alongside fixed alarms and market directly to neurodivergent (ADHD) and chronic illness communities alongside visual schedule components.

### 4. Beating them in comparison

| Feature / Dimension | Round Health | Our Zero-Knowledge PWA |
| :--- | :--- | :--- |
| **Availability & Status** | Sunset & Delisted (iOS only, abandonware) | **Active, Cross-Platform Zero-Knowledge PWA** |
| **Multi-Device Sync** | Server backup to pharmacy cloud (unencrypted) | **Sync Without Trust** (WebAuthn/Passkey auth + browser E2EE + blind push relay) |
| **Data Ownership** | Zero export/import features | **Clean 1-Click CSV/JSON Exports** |

- **Winning Angle**: Round Health is dead abandonware that locked users into a pharmacy startup cloud without data exports. Our Zero-Knowledge PWA is actively maintained across all platforms (iOS, Android, Web, Desktop), providing flexible dose windows, WebAuthn passkey authentication, zero-knowledge multi-device sync, and clean CSV exports.
- **Where we lose & how to neutralize it**: We lose on native iOS Metal/Swift clock animations. Neutralize with responsive SVG schedule wheels and fast offline-first PWA animations.
