# Cronometer

- **What it is**: Cronometer is a high-precision nutrition, dietary, and biometric tracking application designed to monitor macronutrients, micronutrients, biometrics, and physical activity. It is widely used by health-conscious individuals, athletes, dietitians, and medical researchers to track detailed nutritional intake and overall physical health.
- **Platform**: iOS and Android (native mobile applications) and web (full-featured browser-based desktop application).
- **Hosting model**: Closed-source SaaS (managed cloud service by Cronometer Software Inc., Canada). Proprietary license; not open-source or self-hostable.
- **Feature coverage**:
  - **Medications**: Partial — no dedicated pharmacy medication module or prescription reminder workflow, but users can create custom foods/supplements for dosage or record intake in diary notes.
  - **BP**: Yes — logs systolic and diastolic blood pressure within the dedicated biometrics module.
  - **Weight**: Yes — logs body weight, body fat %, BMI, and body measurements manually or via smart scale sync.
  - **Workouts**: Yes — records exercise duration, activity type, and calories burned using an internal exercise database or connected fitness apps.
  - **Sleep**: Yes — logs sleep duration and sleep quality metrics imported from connected wearables (Oura, Fitbit, Apple Health, Garmin, Whoop).
  - **Vitals/wearables**: Yes — logs biometrics including blood pressure, blood glucose, heart rate, body temperature, SpO2, ketones, and GKI manually or via device sync.
  - **Food/nutrition**: Yes — industry-leading food/nutrition coverage featuring verified lab databases (NCCDB, USDA), tracking for 80+ micronutrients, barcode scanning, recipe importer, custom food builder, and intermittent fasting timers.
  - **Diary/notes**: Yes — daily food and biometric diary supporting timestamped entries, notes, photo attachments, and custom diary group categories.
- **Privacy & encryption**: Stored in secure cloud infrastructure (AWS/Google Cloud) in North America. Self-certified HIPAA compliant for Cronometer Pro accounts. Encrypted in transit via TLS/HTTPS and at rest using AES-256 encryption. Server-side plaintext processing (not zero-knowledge E2EE) is required to parse nutrient calculations, execute recipe analysis, and generate reports. Cronometer explicitly pledges not to sell personal user data. The free plan displays third-party advertisement banners; Gold and Pro tiers are completely ad-free.
- **Data ownership**: Export available in CSV format via the web interface (includes raw daily food servings, daily nutrition summaries, exercise logs, biometric records, and diary notes). Imports custom foods, recipes, and device biometrics. No public/consumer REST API available for individual users (API access is restricted to enterprise/clinical B2B partners like Practice Better, Kalix, and Everfit). Moderate lock-in due to lack of a consumer API, offset by comprehensive CSV export capabilities.
- **Reminders/notifications**: Delivered via native mobile push notifications for meal logging, logging targets, and fasting timer start/stop alerts. Mobile app supports offline entry and cached diary logging, which automatically syncs to cloud servers once network access is restored.
- **Integrations**: Integrates with major wearables and health apps (Apple Health, Google Health Connect, Fitbit, Garmin, Oura, Whoop, Withings, Dexcom, Suunto, Polar, Strava). Provides clinical EHR and practitioner integration via Cronometer Pro / B2B partner portals with signable HIPAA Business Associate Agreements (BAAs). AI features include AI-powered photo food logging, voice meal entry, AI web recipe importer, and the "Nutrient Oracle" recommendation engine.
- **Pricing / sustainability**: Freemium model. Free plan includes core nutrition, barcode scanning, and biometric logging with ads. Cronometer Gold ($9.99/month or $49.99/year) provides an ad-free experience, timestamped entries, custom charts, fasting timer, AI features, and advanced reports. Cronometer Pro for healthcare practitioners starts at $29–$49+/month. Active commercial development by Cronometer Software Inc.
- **Sources**:
  - Cronometer Official Website & Pricing: https://cronometer.com/ (Accessed August 2026)
  - Cronometer Privacy Policy & Security: https://cronometer.com/privacy/ (Accessed August 2026)
  - Cronometer Support & Data Export Documentation: https://support.cronometer.com/ (Accessed August 2026)

## Phase 2

### 1. Customer base
- **User Count & Downloads**: Google Play Store bracket is **5,000,000+** downloads (`com.cronometer.android.gold`) with ~57,200 reviews (4.6-star rating). Apple App Store has >89,000 ratings (4.8-star rating) (Source: Google Play & App Store listings, August 2026).
- **Estimated Active Base**: Over 3.5 million registered users total. Estimated **500,000–1,000,000 Monthly Active Users (MAU)**.
- **Company & Financials**: Bootstrapped by Cronometer Software Inc. (Revelstoke/Canmore, BC, Canada, founded 2005 by Aaron Davidson). Reported ARR is **~$3.8 Million** with no VC funding raised (Source: Latka, Revelstoke Mountaineer, August 2026).
- **Code Signals**: Closed-source commercial SaaS with B2B Cronometer Pro clinical platform.

### 2. Killer features — why customers actually choose it
- **80+ Verified Micronutrients & NCCDB Accuracy**: Tracks 84 micronutrients (vitamins, minerals, amino acids, lipids) using verified lab databases (NCCDB, USDA) rather than unvetted user entries.
- **Free Barcode Scanning & Net Carbs**: Kept barcode scanning free when MyFitnessPal paywalled its scanner, making it the top choice for Keto, Low-Carb, and Carnivore dieters (paraphrased theme from `r/keto` & `r/Cronometer`).
- **Cronometer Pro Dietitian Integration**: Dietitians require clients to track food logs inside Cronometer Pro for clinical dietary compliance.

### 3. Marketing & acquisition — how they win customers
- **Channels**: Capturing MyFitnessPal paywall refugees, organic dominance in dietary subreddits (`r/keto`, `r/nutrition`, `r/carnivore`), and B2B dietitian affiliate networks.
- **What we can learn**: **Capturing Paywall Refugees.** Highlight zero paywalls on essential features (medication reminders, dosage logs, data exports) to capture users fleeing bloated, ad-filled commercial apps.

### 4. Beating them in comparison

| Feature / Dimension | Cronometer | Our Zero-Knowledge PWA |
| :--- | :--- | :--- |
| **Privacy & Storage** | Centralized AWS/Google Cloud storage; unencrypted server food logs | **Zero-Knowledge Vault** (Passkey auth, client-side encryption, blind push relay) |
| **User Focus & Friction** | Heavy macro/calorie logging interface; overwhelming for med tracking | **Lightweight Adherence & Symptom Safety Workbench** |
| **Pricing & Ads** | Display ads on free tier; $9.99/mo ($49.99/yr) Gold for timestamped exports | **100% Free, Ad-Free Zero-Knowledge Sync** |

- **Winning Angle**: Cronometer stores unencrypted food logs on central cloud servers, displays ads on the free tier, and locks timestamped exports behind Cronometer Gold ($49.99/yr). Our PWA provides zero-knowledge multi-device sync without vendor trust — WebAuthn passkey security, blind push notification relay, ad-free UI, and dedicated medication/symptom safety tracking.
- **Where we lose & how to neutralize it**: We lose on Cronometer's 800,000+ food database and 80+ micronutrient NCCDB calculations. Neutralize by positioning our PWA as a specialized medication, supplement, and symptom safety tool that complements food trackers without exposing medical history.
