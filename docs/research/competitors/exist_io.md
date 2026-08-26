# Exist.io (Exist)

- **What it is**: Exist.io is a personal data aggregation and analytics platform designed to unify metrics from fitness trackers, software services, and manual inputs to uncover unexpected correlations in daily life. Developed by Hello Code, it helps users analyze how factors like sleep, exercise, location, weather, and productivity impact mood and overall well-being.
- **Platform**: Web (full-featured desktop web application) and native mobile companion applications for iOS and Android.
- **Hosting model**: Closed-source SaaS (managed cloud service by Hello Code Pty Ltd, Australia). Proprietary license; not open-source or self-hostable.
- **Feature coverage**:
  - **Medications**: Partial — no dedicated pharmacy or prescription management module, but custom numeric/boolean attributes can be created to track medication compliance or dosage.
  - **BP**: Partial — lacks a specialized clinical BP dashboard, but blood pressure (systolic/diastolic) can be tracked via custom numerical user attributes.
  - **Weight**: Yes — logs weight and body fat percentage manually or via auto-sync from Apple Health, Fitbit, or Withings.
  - **Workouts**: Yes — aggregates steps, active time, calories, and exercise sessions from connected fitness platforms (Strava, Apple Health, Fitbit, Garmin).
  - **Sleep**: Yes — tracks sleep duration, time in bed, and sleep stages (light, deep, REM) synced from connected sleep trackers.
  - **Vitals/wearables**: Yes — logs resting heart rate, heart rate variability (HRV), max heart rate, and steps imported from Apple Health, Google Fit, Oura, Fitbit, and Garmin.
  - **Food/nutrition**: Partial — syncs calorie intake, caffeine, water, and macro totals from connected third-party services (e.g., Apple Health/Fitbit), but lacks a built-in food database or meal logger.
  - **Diary/notes**: Yes — features daily qualitative notes, custom tag tracking, daily mood ratings (1–9 scale), and evening reflection prompts.
- **Privacy & encryption**: Data is stored on secure cloud servers operated by Hello Code in Australia/US. All network traffic is encrypted via TLS/HTTPS, with data encrypted at rest. Server-side plaintext processing (not zero-knowledge E2EE) is used to perform cross-service statistical correlation calculations. Hello Code enforces a strict business model funded solely by user subscriptions, with an explicit policy never to sell user data, serve third-party ads, or include third-party tracking scripts in mobile apps.
- **Data ownership**: Export available via complete account JSON download, quantitative attribute CSV export, and PDF summary reports. Supports data import via API integrations (Fitbit, Apple Health, Strava, RescueTime, Todoist, Toggl, GitHub, Weather, etc.) and manual attribute entry. Features a public, well-documented REST API (v2) supporting full read/write access to user metrics and custom attributes via JSON payloads over OAuth2. Zero lock-in due to open REST API and full JSON/CSV export capabilities.
- **Reminders/notifications**: Delivered via native mobile push notifications and email prompts to log daily mood ratings, custom attribute values, and notes. Requires internet connectivity for sync and calculation of correlations, with temporary offline queueing for mobile entry.
- **Integrations**: Syncs with major wearables and fitness platforms (Apple Health, Google Fit/Health Connect, Fitbit, Oura, Garmin, Withings) as well as digital productivity and lifestyle tools (RescueTime, Todoist, Toggl, GitHub, Pocket, Spotify, OpenWeatherMap). No direct EHR/patient portal integration. AI features include an automated statistical correlation engine (calculating Pearson correlation coefficients and p-values between attributes), but no generative LLM AI assistant.
- **Pricing / sustainability**: Subscription-only model. Offers a 30-day free trial, then costs $6.99/month or $62.90/year. No permanent free tier. Commercial closed-source SaaS actively maintained by Hello Code Pty Ltd.
- **Sources**:
  - Exist.io Official Website & Overview: https://exist.io/ (Accessed August 2026)
  - Exist.io Privacy Policy & Data Philosophy: https://exist.io/privacy/ (Accessed August 2026)
  - Exist Developer API (v2) Documentation: https://developer.exist.io/ (Accessed August 2026)

## Phase 2

### 1. Customer base
- **User Count & Downloads**: Google Play Store bracket is **10,000+** downloads (`com.hellocode.exist`) with ~203 reviews (4.5-star rating). Apple App Store has ~12 ratings (3.9-star rating) (Source: Google Play & App Store listings, August 2026).
- **Estimated Active Base**: Estimated **1,500–2,500 active paying subscribers** globally (estimate derived from 10k+ Play Store installs, App Store ratings, and historical self-disclosures).
- **Company & Financials**: Bootstrapped 2-person indie studio Hello Code (Melbourne, Australia, founded by Josh Sharp and Belle Beth Cooper). Operates on a $6.99/mo or $62.90/yr subscription model with no free tier; historical self-disclosures indicate ~$10k–$15k MRR (~$120k–$180k ARR) (Source: Hello Code Blog / Indie Hackers, August 2026).
- **Code Signals**: Closed-source proprietary SaaS with open REST API (v2).

### 2. Killer features — why customers actually choose it
- **Automated Multi-Service Correlation Engine**: Unifies data from wearables, productivity apps, weather, and mood to automatically surface statistical correlations (e.g. "productivity drops 15% on days after poor sleep").
- **Custom Tagging & Open REST API**: Quantified Self power users choose Exist for its open REST API allowing custom webhook data ingestion (paraphrased theme from `r/QuantifiedSelf` & `r/ExistIO`).
- **No-Ad Subscription Philosophy**: Zero advertising or data monetization.

### 3. Marketing & acquisition — how they win customers
- **Channels**: Radical transparency blogging on `blog.exist.io` and Hacker News about bootstrapping, integration directory listings (RescueTime, Fitbit, Apple Health), and active outreach in Quantified Self tech circles.
- **What we can learn**: **Open-Startup Technical Transparency.** Publish articles on Hacker News and technical blogs demonstrating local-first Web Crypto architecture, attracting privacy-conscious Quantified Self users who dislike central server data aggregation.

### 4. Beating them in comparison

| Feature / Dimension | Exist.io | Our Zero-Knowledge PWA |
| :--- | :--- | :--- |
| **Privacy & Data Sovereignty** | Centralized server aggregates unencrypted OAuth data from 15+ services | **Zero-Knowledge Vault** (Passkey auth, client-side encryption, server stores ciphertext) |
| **Pricing Model** | $6.99/month ($62.90/year) with no permanent free tier | **100% Free Core PWA** |
| **Medication & Clinical Focus** | No dedicated medication scheduling or clinical vital workflows | **Dedicated Medication Safety, Dosing, & Clinical Vitals Workbench** |

- **Winning Angle**: Exist requires users to grant third-party OAuth access to their entire digital life to central servers, charging $6.99/mo without providing clinical medication adherence or drug interaction tools. Our PWA provides zero-knowledge multi-device sync without vendor trust — WebAuthn passkey security, dedicated clinical medication tracking, and zero subscription fee.
- **Where we lose & how to neutralize it**: We lose on automated cloud sync with 15+ third-party services (Spotify, RescueTime, Weather). Neutralize by positioning our PWA as a dedicated health & medication vault that intentionally avoids invasive API tracking.
