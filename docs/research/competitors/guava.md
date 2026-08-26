# Guava Health (Guava)

- **What it is**: Guava Health is an all-in-one personal health management platform that aggregates patient portal medical records, lab results, wearable metrics, and lifestyle tracking into a single hub. It uses statistical models and AI to analyze health trends, generate provider-ready summaries, and detect correlations between medications, lifestyle habits, and symptoms.
- **Platform**: iOS and Android (native mobile apps) and web (full-featured browser-based web application accessible on desktop).
- **Hosting model**: Closed-source SaaS (managed cloud service by Guava Health, Inc.). Proprietary license; not open-source or self-hostable.
- **Feature coverage**:
  - **Medications**: Yes — offers comprehensive scheduled and as-needed medication tracking, dosage logs, refill notifications, pill inventory/count tracking, and drug interaction checks.
  - **BP**: Yes — logs blood pressure (systolic/diastolic) manually or auto-synced from connected blood pressure monitors and health apps.
  - **Weight**: Yes — logs weight and body composition manually or via connected smart scale integrations.
  - **Workouts**: Yes — records workouts, active calories, and duration synced from wearables or logged manually.
  - **Sleep**: Yes — tracks sleep duration, sleep stages (light, deep, REM), and sleep efficiency imported from connected devices or logged manually.
  - **Vitals/wearables**: Yes — tracks vitals including heart rate, HRV, SpO2, blood glucose, temperature, and respiration rate across 30+ hardware and software integrations.
  - **Food/nutrition**: Yes — features food logging supported by AI photo nutrient detection and macronutrient tracking.
  - **Diary/notes**: Yes — supports daily qualitative notes, symptom body heatmaps, visit preparation summaries, and document attachment notes.
- **Privacy & encryption**: Data is hosted in HIPAA-compliant US cloud infrastructure. Data is encrypted using AES-256 at rest and TLS 1.3/1.2 in transit. Server-side plaintext processing is utilized rather than zero-knowledge E2EE to enable AI document extraction, patient portal aggregation, and cross-metric analytics. Guava maintains HIPAA compliance (signing BAAs with healthcare providers), explicitly refrains from selling personal data, and does not run third-party advertising.
- **Data ownership**: Export available in CSV format for log metrics and daily entries, as well as original PDF downloads for imported medical records and lab documents. High interoperability via direct patient portal import (Epic, Cerner, etc.), C-CDA file uploads, DICOM imaging, PDF lab extraction, and device sync. Offers a Developer API (early access/beta) utilizing HL7 FHIR, C-CDA, OAuth 2.1, and REST JSON. Extremely low lock-in due to FHIR support and comprehensive export capabilities.
- **Reminders/notifications**: Delivered via push notifications on mobile devices and browser notifications on web for medication schedules, refill alerts, log prompts, and provider visit prep. Basic offline logging is supported on mobile apps, though network connectivity is required for patient portal sync, lab parsing, and AI features.
- **Integrations**: Integrates with 30+ wearable and device platforms (Apple Health, Google Health Connect, Fitbit, Oura, Garmin, Withings, Dexcom, Whoop, Strava). Directly connects to 50,000+ U.S. health systems and patient portals via SMART on FHIR. AI features include "Guava Assistant" (an LLM health assistant), automatic PDF lab report data extraction, voice/photo meal logging, and automated correlation discovery engines.
- **Pricing / sustainability**: Freemium model. Free plan includes core medical record sync, wearable integrations, and basic symptom/medication tracking. Premium plan ($8/month or $78/year) unlocks the AI assistant, automated lab data extraction, Guava Emergency Card, and caregiver profile management. Provider Dashboard plans start at $60/month for up to 10 patients. Active commercial development by Guava Health, Inc.
- **Sources**:
  - Guava Health Official Website: https://guavahealth.com/ (Accessed August 2026)
  - Guava Health Privacy Policy: https://guavahealth.com/privacy (Accessed August 2026)
  - Guava Developer API & FHIR Documentation: https://guavahealth.com/developer (Accessed August 2026)

## Phase 2

### 1. Customer base
- **User Count & Downloads**: Google Play Store bracket is **100,000+** downloads (`com.guavahealth.guava`) with ~1,740+ reviews (4.6-star rating). Apple App Store has 862+ ratings (4.8-star rating) (Source: Google Play & Apple App Store listings, August 2026).
- **Estimated Active Base**: Estimated **40,000–75,000 Monthly Active Users (MAU)** across web and mobile platforms (estimate derived from >100k Play Store installs and ~2.6k aggregate store reviews).
- **Funding & Investor Signals**: Founded in 2021 by Dylan Wenzlau and Alex Yau (Santa Barbara, CA). Backed by venture capital including ScOp Venture Capital, Panasonic Well, and the AgeTech Collaborative from AARP (Source: Tracxn, PitchBook, AARP AgeTech, August 2026).
- **Code Signals**: Closed-source proprietary SaaS (React/Web + Native wrappers); registered in SMART App Gallery.

### 2. Killer features — why customers actually choose it
- **SMART-on-FHIR Patient Portal Aggregation**: Connects directly with 50,000+ clinical portals (Epic, Cerner, MyChart) alongside 20+ fitness wearables (Apple Health, Fitbit, Garmin, Oura, Dexcom). Users choose Guava because it automatically pulls lab work from MyChart and syncs HRV telemetry without manual button taps during flare-ups (paraphrased theme from `r/ChronicIllness` & `r/GuavaHealth`).
- **AI Correlation Discovery & Doctor Briefs**: Automatically calculates statistical correlations between daily logged symptoms, lifestyle factors, and lab values, generating provider-ready PDF summaries for 15-minute appointments.
- **Low-Cognitive-Load UX for Chronic Illness**: Designed specifically for users managing complex conditions (POTS, MCAS, Long COVID, Endometriosis) where daily manual logging induces cognitive fatigue ("brain fog").

### 3. Marketing & acquisition — how they win customers
- **Channels**: Organic community word-of-mouth in subreddits (`r/ChronicIllness`, `r/POTS`, `r/LongCovid`, `r/Bearable`), SMART App Gallery provider directories, SEO articles explaining lab values and chronic symptom tracking, and AARP AgeTech accelerator partnerships.
- **What we can learn**: **The "Doctor Visit Summary PDF" Hook.** Build a single-click local PDF export generator optimized for 15-minute doctor appointments. Position our zero-knowledge PWA as the privacy-safe tool that converts offline symptom/medication logs into clean clinical briefs without cloud server processing.

### 4. Beating them in comparison

| Comparison Dimension | Guava Health | Our Zero-Knowledge PWA |
| :--- | :--- | :--- |
| **Architecture & Privacy** | Centralized SaaS; server processes vendor-readable health records (encrypted at rest, but vendor-readable for AI & sync) | **Zero-Knowledge Vault** (browser holds keys & plaintext; server stores ciphertext it cannot read + blind push relay) |
| **Multi-Device Sync** | Standard cloud login to vendor server | **Sync Without Trust** (WebAuthn/Passkey key management with encrypted multi-device sync) |
| **Pricing** | Freemium ($8/mo or $78/yr for Premium AI/lab features) | **100% Free & Open Source** |
| **Deployment** | Vendor-hosted cloud SaaS only | **Single-Operator Self-Hosted Server** or client PWA |

- **Winning Angle**: Guava processes your vendor-readable medical records, lab reports, and symptom histories on central cloud servers for $96/year. Our PWA provides encrypted multi-device sync without vendor trust — browser-managed zero-knowledge encryption, Passkey authentication, blind server notification relay, and zero subscription fee.
- **Where we lose & how to neutralize it**: We lose on direct cloud OAuth connections to 50,000+ EHR portals (SMART-on-FHIR). Neutralize this by supporting client-side JSON/CSV/HealthKit file imports and running local Web-Worker correlation algorithms directly inside the browser.
