# MedM (MedM Health / MedM Diabetes / MedM Care)

- **What it is**: MedM is a comprehensive suite of digital health monitoring platforms developed by MedM Inc., consisting of consumer health diary apps (MedM Health, MedM Diabetes) and a cloud-based remote patient monitoring platform (MedM Care). It enables automated data collection from over 750 Bluetooth medical devices alongside medication reminder tracking.
- **Platform**: iOS, Android, Windows (Microsoft Store), macOS (via Apple Silicon / iPad app), and Web (MedM Health Cloud portal). Native mobile/desktop apps plus web platform.
- **Hosting model**: SaaS (MedM Health Cloud hosted on AWS / HIPAA-compliant infrastructure) with full Local-only offline operating mode. Closed-source proprietary software.
- **Feature coverage**:
  - **Medications**: Yes — includes medication intake scheduling, dosage tracking, pill reminders, and refill notifications.
  - **BP**: Yes — full blood pressure and heart rate monitoring with automatic Bluetooth device sync and trend analysis.
  - **Weight**: Yes — tracks weight, BMI, body fat percentage, and syncs with smart scales.
  - **Workouts**: Yes — syncs physical activity, step counts, and exercise data via Garmin, Fitbit, Apple Health, and Google Health Connect.
  - **Sleep**: Yes — tracks sleep duration and sleep quality metrics via connected sensors and health platforms.
  - **Vitals/wearables**: Yes — extensive vital tracking (blood glucose, SpO2, ECG, body temp, spirometry) connecting over 750 Bluetooth medical devices and wearables.
  - **Food/nutrition**: Partial — includes blood glucose meal tags (pre-prandial / post-prandial) and notes, but not full meal calorie tracking.
  - **Diary/notes**: Yes — supports health journal entry notes, symptom logging, and historical record tagging.
- **Privacy & encryption**:
  - **Where data lives**: Stored locally on device in offline mode, or hosted in MedM Health Cloud (AWS servers in U.S. or EU).
  - **E2EE or server-side plaintext**: Encrypted in transit (HTTPS/TLS) and encrypted at rest (AES-256) on cloud servers; NOT end-to-end encrypted (cloud holds keys to facilitate doctor/caregiver data sharing).
  - **What vendor can see**: User profile info, connected sensor measurement data, medication logs, and shared report histories (accessible to authorized caregivers/clinicians).
  - **Data-sale/ads history if any**: 100% ad-free; privacy policy guarantees personal health data is never sold or monetized for advertising.
- **Data ownership**:
  - **Export formats**: PDF and XLSX (Excel) reports for Premium users; CSV export available; offline raw database backup.
  - **Import**: Supports CSV file import for importing historical health metric records into MedM Cloud.
  - **API**: MedM Cloud API and Device Connectivity SDK available for enterprise/RPM integrations.
  - **Lock-in**: Low lock-in due to robust CSV/XLSX export and CSV import capabilities.
- **Reminders/notifications**:
  - **How delivered**: Native push notifications and local device alerts for medication schedules, missed measurement reminders, and threshold warnings.
  - **Does it work offline**: Yes — the app and local database operate fully offline without requiring account registration or internet access.
- **Integrations**:
  - **Wearables**: 750+ Bluetooth medical sensors (Omron, A&D, Roche, Beurer, etc.) and wearables; syncs with Apple Health, Google Health Connect, Fitbit, Garmin, and Samsung Health.
  - **EHR**: MedM Care RPM platform integrates with hospital EHR systems via HL7, FHIR, and REST APIs.
  - **AI features**: Automated threshold monitoring and trend detection rules; no generative AI LLM features.
- **Pricing / sustainability**:
  - **Pricing**: Freemium for consumer apps (MedM Health / MedM Diabetes: Free offline and basic logging; MedM Premium subscription costs ~$0.99–$4.99/month or ~$9.99–$29.99/year for cloud sync, PDF/XLSX export, and caregiver sharing). MedM Care is a B2B SaaS priced per patient/month.
  - **Sustainability**: Proprietary commercial software suite operated and maintained by MedM Inc.
- **Sources**:
  - MedM Official Website: https://www.medm.com/ (Accessed August 2026)
  - MedM Privacy Policy: https://www.medm.com/privacy-policy.html (Accessed August 2026)
  - MedM Health Cloud Portal: https://health.medm.com/ (Accessed August 2026)

## Phase 2

### 1. Customer base
- **User Count & Downloads**: Google Play Store metrics show **100,000+** downloads for MedM Health (`com.medm.phone.health`) with ~4.96k reviews (4.7-star rating) and **500,000+** downloads for MedM Blood Pressure (4.5-star rating). Apple App Store has 152 ratings for MedM Health (Source: Google Play & Apple App Store listings, August 2026).
- **Estimated Active Base**: Combined across MedM Health, MedM BP, MedM Diabetes, and white-label enterprise hubs: **>1,000,000 cumulative downloads** globally. Estimated **80,000–150,000 Monthly Active Users (MAU)** across the MedM app ecosystem.
- **Funding & Financials**: Bootstrapped by MedM Inc. (Sunnyvale, CA, founded 2012) with zero VC funding; ~20 employees, estimated ~$2.2M ARR (Source: Latka, MedM corporate filings, August 2026).
- **Code Signals**: Closed-source commercial software; offers white-label SDKs and "MedM Soft Hub" for RPM hardware vendors.

### 2. Killer features — why customers actually choose it
- **Unrivaled Medical Bluetooth Compatibility (1,000+ Monitors)**: Connects wirelessly with over 1,000 Bluetooth medical devices (BP cuffs, oximeters, glucometers, ECGs, scales) from 100+ hardware vendors (Omron, A&D, Beurer, Roche). Users on `r/QuantifiedSelf` state: *"MedM just connects to generic or cheap Bluetooth BP cuffs when native vendor apps fail or force cloud logins."*
- **Sensor-Agnostic Offline Logging**: Records 20+ physiological parameters locally without requiring a persistent internet/cloud connection during measurements.
- **B2B Remote Patient Monitoring (RPM)**: Highly trusted by clinical providers due to turn-key CPT code reimbursement tracking and EHR API integration.

### 3. Marketing & acquisition — how they win customers
- **Channels**: B2B hardware vendor bundling (recommended by device manufacturers whose native apps are unmaintained), Remote Patient Monitoring (RPM) hospital sales, and organic App Store Optimization (ASO) searches like *"Bluetooth blood pressure log"*.
- **What we can learn**: **Web Bluetooth GATT Standard Pairing.** Implement browser-native Web Bluetooth for standard GATT profiles (Blood Pressure `0x1810`, Glucose `0x1808`, Heart Rate `0x180D`). Market our PWA as a zero-install utility that pairs directly with hardware devices in the browser without charging $35/yr for CSV exports.

### 4. Beating them in comparison
- **Winning Angle**: MedM charges users **$35/year or $99 lifetime** just to export data to CSV/Excel and pushes legacy enterprise software. Our PWA gives users 100% free, instant CSV/JSON exports, a modern responsive UI, and zero-knowledge local encryption.
- **Where we lose & how to neutralize it**: We lose on MedM's driver library for 1,000+ proprietary/legacy Bluetooth devices. Neutralize by implementing Web Bluetooth for standard GATT BLE profiles and offering an ultra-fast 2-tap manual entry interface (<5 seconds per measurement).
