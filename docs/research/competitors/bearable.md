# Bearable

- **What it is**: Bearable is a comprehensive health and symptom-tracking mobile application designed to help individuals managing chronic illnesses, complex health conditions, or unexplained symptoms. It enables users to log daily health metrics, habits, and symptoms to discover correlations between treatments, environmental factors, and overall well-being.
- **Platform**: iOS and Android (native mobile applications); macOS (via Apple Silicon / Mac App Store running the mobile app). No web app, PWA, or dedicated desktop version available.
- **Hosting model**: Closed-source SaaS (managed cloud service by Bearable App Ltd, UK). Proprietary license; not open-source or self-hostable.
- **Feature coverage**:
  - **Medications**: Partial — supports scheduling, custom dosage, dose logging, and time-based reminders, but does not offer pill inventory or supply tracking.
  - **BP**: Yes — logs systolic and diastolic blood pressure within the customizable Health Measurements section.
  - **Weight**: Yes — logs weight entries manually or auto-syncs via Apple Health, Google Health Connect, or Fitbit.
  - **Workouts**: Yes — tracks exercise type, duration, and intensity alongside health correlation analytics.
  - **Sleep**: Yes — records sleep quantity, quality, and sleep factors manually or imports from wearable integrations.
  - **Vitals/wearables**: Yes — imports heart rate, resting heart rate, HRV, steps, and body temperature via one-way sync from Apple Health, Google Health Connect, and Fitbit.
  - **Food/nutrition**: Partial — includes a basic food/drink entry diary and water tracker, but lacks a full micronutrient database or barcode scanner.
  - **Diary/notes**: Yes — features daily notes, mood tracking, emotion logs, symptom severity ratings, and gratitude journaling.
- **Privacy & encryption**: Data is stored on Google Cloud Platform (Cloud Firestore) servers located in the EU. Data is encrypted in transit using TLS/HTTPS, client-side encrypted before cloud transmission using 256-bit AES, and encrypted at rest on Google Cloud. However, it is not zero-knowledge E2EE, as Bearable manages the cloud architecture and encryption infrastructure. The vendor collects user email addresses linked to an anonymized user ID and states that personnel cannot view user health entries except during user-consented debugging. Bearable has a strict policy against selling user data or using data for targeted advertising.
- **Data ownership**: Export available in CSV format containing all logged entries and symptom scores. No native CSV import tool exists to bring historical data into Bearable. No public/consumer API is provided (API access is restricted to research and clinical partners). Moderate lock-in due to lack of import options.
- **Reminders/notifications**: Delivered via native local push notifications on iOS and Android for meds, symptoms, habits, and check-ins. Supports full offline functionality with local device storage, syncing to Google Cloud once an internet connection is established.
- **Integrations**: Integrates with Apple Health, Google Health Connect, and Fitbit for one-way metric reading. No direct EHR/patient portal integration. AI features include an automated statistical correlation engine (calculating percentage correlations between factors and symptoms), but no generative LLM chat assistant.
- **Pricing / sustainability**: Freemium model. Free version includes core logging features; Premium subscription (~$6.99/month or ~$34.99/year) unlocks advanced correlation reports, custom factor charts, and passcode lock. A subscription sponsorship program exists for users facing financial hardship. Active commercial software with regular app updates by Bearable App Ltd.
- **Sources**:
  - Bearable Official Website & Features: https://bearable.app/ (Accessed August 2026)
  - Bearable Privacy Policy: https://bearable.app/privacy-policy/ (Accessed August 2026)
  - Bearable Support / Knowledge Base: https://bearable.app/support/ (Accessed August 2026)

## Phase 2

### 1. Customer base
- **User Count & Downloads**: Google Play Store bracket is **500,000+** downloads (`com.bearable.app`) with ~10,300 reviews (4.6-star rating). Apple App Store has ~6,200 ratings (4.8-star rating) (Source: Google Play & Apple App Store listings, August 2026).
- **Estimated Active Base**: Company claims >900,000 registered users total. Estimated **50,000–90,000 Monthly Active Users (MAU)** (estimate derived from 500k+ Play Store installs and ~9k monthly downloads).
- **Funding & Financials**: Bootstrapped / minimally funded by Bearable App Ltd (UK, founded 2019 by James S.); raised small grant/seed (~$200k) with no major VC investment. Estimated app store revenue is ~$30,000/month (~$360k ARR) (Source: Sensor Tower / Adapty estimates, August 2026).
- **Code Signals**: Closed-source proprietary SaaS.

### 2. Killer features — why customers actually choose it
- **Deep Customization for Chronic Illness**: Allows creation of custom symptom categories, severity ratings (1–5 scale), and daily lifestyle factors (weather, sleep quality, foods).
- **Visual Factor & Symptom Correlation Grid**: Plots symptom flare-ups against habits, meds, or environmental factors. Users choose Bearable to print visual evidence for doctors managing complex conditions like ME/CFS, POTS, Long COVID, and Fibromyalgia (paraphrased theme from `r/ChronicIllness` & `r/Bearable`).
- **Low-Brain-Fog Timestamped Logging**: Fast logging for preventative and PRN emergency relief meds during symptom flare-ups.

### 3. Marketing & acquisition — how they win customers
- **Channels**: Founder-led community building in subreddits (`r/Bearable`, `r/cfs`, `r/longcovid`, `r/POTS`), open user-voted feature roadmaps (FeatureUpvote/Trello), and chronic illness social media advocates.
- **What we can learn**: **Founder-Led Subreddit Community Building.** Engage chronic illness and neurodivergent subreddits by highlighting a zero-knowledge privacy guarantee (protecting sensitive medical data from cloud leaks) while allowing community input into feature priorities.

### 4. Beating them in comparison

| Feature / Dimension | Bearable | Our Zero-Knowledge PWA |
| :--- | :--- | :--- |
| **Privacy & Storage** | Centralized Google Cloud Firestore (unencrypted server DB) | **Zero-Knowledge Vault** (Browser holds keys & plaintext; server holds ciphertext + blind push relay) |
| **Multi-Device Sync** | Standard cloud login | **Sync Without Trust** (WebAuthn/Passkey authentication with E2EE sync) |
| **Pricing & Analytics** | $6.99/mo or $35.99/yr for long-term correlation insights | **100% Free Unlocked Analytics & Correlation Tools** |

- **Winning Angle**: Bearable stores sensitive health histories on central cloud servers and paywalls long-term correlation analytics behind Bearable Premium ($35.99/yr). Our PWA provides zero-knowledge multi-device sync without vendor trust — browser-managed encryption, Passkey authentication, and full correlation analytics completely free.
- **Where we lose & how to neutralize it**: We lose on Bearable's visual correlation UI polish. Neutralize by focusing on fast medication adherence, supplement logging, and client-side correlation tools.
