# MyTherapy (by smartpatient)

- **What it is**: MyTherapy is an ad-free medication management and health diary application developed by smartpatient GmbH (a subsidiary of Redcare Pharmacy N.V. / Shop Apotheke Europe). It assists patients in adhering to treatment plans by providing pill reminders, tracking vitals and symptoms, and generating printable progress reports for healthcare providers.
- **Platform**: iOS and Android native mobile applications, with wearable companion apps for Apple Watch and Android smartwatches. No standalone consumer web app or PWA.
- **Hosting model**: SaaS (cloud sync backed by smartpatient servers in Germany/EU). Proprietary closed-source software.
- **Feature coverage**:
  - **Medications**: Yes — includes flexible daily/weekly schedule reminders, intake logging, pill stock tracking, and refill reminders.
  - **BP**: Yes — supports logging blood pressure, heart rate, and hypertension metrics.
  - **Weight**: Yes — enables weight tracking with visual trend charts over time.
  - **Workouts**: No — does not feature native workout or physical activity logging.
  - **Sleep**: No — does not include native sleep duration or quality tracking.
  - **Vitals/wearables**: Yes — logs blood glucose, oxygen saturation (SpO2), body temperature, and syncs vitals with Apple Health and Google Health Connect.
  - **Food/nutrition**: No — does not support food, meal, or calorie tracking.
  - **Diary/notes**: Yes — features a comprehensive symptom diary, mood tracker, and custom notes per entry.
- **Privacy & encryption**:
  - **Where data lives**: Stored on smartpatient ISO 27001-certified servers in Germany (EU), fully GDPR and HIPAA compliant.
  - **E2EE or server-side plaintext**: Encrypted in transit (TLS) and at rest (AES-256) on cloud servers; NOT end-to-end encrypted (smartpatient holds encryption keys for cloud syncing).
  - **What vendor can see**: Account data and health entries; smartpatient processes anonymized and aggregated data for medical research and brand digital patient support programs.
  - **Data-sale/ads history if any**: 100% free of commercial ads; privacy policy guarantees no selling of personal data to third parties.
- **Data ownership**:
  - **Export formats**: PDF health report generation (designed to be printed or emailed to doctors).
  - **Import**: Syncs measurements from Apple Health and Google Health Connect; no direct CSV/JSON file import interface.
  - **API**: No public consumer API.
  - **Lock-in**: Moderate-to-high lock-in due to the absence of a direct CSV/JSON structured data export tool.
- **Reminders/notifications**:
  - **How delivered**: Delivered via native iOS/Android push notifications with snooze options, discreet reminder text modes, and optional escalation to "MyTherapy Team" caregivers.
  - **Does it work offline**: Yes — alarm schedules are stored locally on the device OS and trigger reliably without an internet connection.
- **Integrations**:
  - **Wearables**: Apple Watch and Wear OS smartwatches via notification mirroring and health sync.
  - **EHR**: No direct EHR integration.
  - **AI features**: None (rule-based reminder scheduling and adherence logging engine).
- **Pricing / sustainability**:
  - **Pricing**: 100% Free for end-users with no subscriptions or in-app purchases.
  - **Sustainability**: Funded through B2B digital patient support programs and partnerships between parent company Redcare Pharmacy N.V. and pharmaceutical manufacturers. Closed-source enterprise-backed app.
- **Sources**:
  - MyTherapy Official Site: https://www.mytherapyapp.com/ (Accessed August 2026)
  - MyTherapy Privacy Policy: https://www.mytherapyapp.com/privacy (Accessed August 2026)
  - smartpatient Corporate Site: https://www.smartpatient.eu/ (Accessed August 2026)

## Phase 2

### 1. Customer base
- **User Count & Downloads**: Google Play Store bracket is **5,000,000+** downloads (`eu.smartpatient.mytherapy`) with ~239,000+ reviews (4.5-star rating). Apple App Store has ~15,000+ ratings across EU/US storefronts (4.8-star rating) (Source: Google Play & Apple App Store listings, August 2026).
- **Estimated Active Base**: Company press releases claim over **12 million patients globally** have used MyTherapy or its integrated pharma companion modules (Source: smartpatient / Redcare Pharmacy Financial Reports 2024/2025).
- **Corporate Ownership & Financials**: Acquired 100% in 2021 by **Redcare Pharmacy N.V.** (formerly Shop Apotheke Europe, Frankfurt Stock Exchange: `RDC`). Operates as Redcare's digital health hub, generating ~$25M–$30M ARR through B2B pharma partnerships and e-pharmacy integration.
- **Code Signals**: Closed-source enterprise platform.

### 2. Killer features — why customers actually choose it
- **All-in-One Health Journal (Vitals + Mood + Meds)**: Allows users to log medication doses alongside blood pressure, blood glucose, weight, and mood symptoms in a single daily loop. Users on `r/ChronicIllness` praise: *"I don't just log my pills; I log my morning blood pressure and pain levels. Printing out the monthly trend chart for my doctor visit makes appointments 10x faster."*
- **Persistent Alarms & Flexible Snoozing**: Features persistent full-screen alerts that re-trigger until explicitly confirmed. Users on `r/adhd` note: *"MyTherapy is one of the few apps where the alarm doesn't easily dismiss itself. It keeps bugging me until I actually get up and take the pill."*
- **100% Free Core App without Medication Caps**: Maintained completely free without capping the number of allowed medications or forcing subscriptions.

### 3. Marketing & acquisition — how they win customers
- **Channels**: Direct integration with Redcare Pharmacy / Shop Apotheke online pharmacy ecosystem (DACH/EU users can reorder prescriptions inside the app), B2B pharma brand support programs, and physical doctor recommendation pads distributed across European clinics.
- **What we can learn**: **Printable Doctor Recommendation Cards.** Adopt MyTherapy's offline channel success by creating a downloadable/printable flyer for independent physicians and pharmacists: *"Recommend a 100% private, zero-signup medication tracker to your privacy-conscious patients."*

### 4. Beating them in comparison
- **Winning Angle**: MyTherapy is owned by an online pharmacy giant (Redcare Pharmacy) and transmits background telemetry to third-party tracking endpoints. Our PWA is an independent, zero-knowledge tool that **never sends a single byte of personal health data to any server or pharmacy**.
- **Where we lose & how to neutralize it**: We lose on direct e-commerce prescription reordering and native EU pharmacy integration. Neutralize by framing independence as a core privacy feature: users maintain full control over where they fill prescriptions without being funneled into a corporate pharmacy pipeline.
