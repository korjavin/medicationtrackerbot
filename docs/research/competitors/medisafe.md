# Medisafe

- **What it is**: Medisafe is a consumer medication management and pill reminder mobile application developed by Medisafe Inc. It helps individuals and caregivers manage complex medication regimens through customized schedule alerts, dose logging, refill reminders, and caregiver escalation. The platform also offers health measurement logging and adherence reporting for medical appointments.
- **Platform**: iOS, Android, Wear OS, Apple Watch. Native mobile and wearable applications. No standalone consumer web app or PWA (web portals are restricted for enterprise/healthcare provider programs).
- **Hosting model**: SaaS (cloud-backed via Medisafe AWS infrastructure). Proprietary closed-source software.
- **Feature coverage**:
  - **Medications**: Yes — offers flexible intake schedules, time/dosage alerts, pill inventory tracking, and low-refill notifications.
  - **BP**: Yes — allows manual logging of blood pressure readings and target ranges.
  - **Weight**: Yes — supports manual weight logging with historical trend graphs.
  - **Workouts**: No — does not include native exercise or workout tracking capabilities.
  - **Sleep**: No — does not provide native sleep tracking features.
  - **Vitals/wearables**: Yes — tracks blood glucose, pulse, and temperature, and syncs vital measurements via Apple Health and Google Fit.
  - **Food/nutrition**: No — does not feature meal, calorie, or nutrition logging.
  - **Diary/notes**: Yes — supports adding text notes, symptom notes, and mood tracking to dose entries.
- **Privacy & encryption**:
  - **Where data lives**: Stored locally on the mobile device and backed up to Medisafe AWS cloud servers (US/EU).
  - **E2EE or server-side plaintext**: Server-side encryption (256-bit AES encryption in transit and at rest); NOT end-to-end encrypted (Medisafe servers maintain decryption keys).
  - **What vendor can see**: Medisafe can access account information, medication schedules, and aggregated/anonymized health data used for analytics and operational services.
  - **Data-sale/ads history if any**: Privacy policy states personal data is not sold; however, the free tier displays third-party advertisements and integrates analytics tracking SDKs (e.g. Meta/Google).
- **Data ownership**:
  - **Export formats**: Excel (.xlsx) and CSV for medication histories; PDF format for doctor status reports.
  - **Import**: Can import health records via Apple Health on iOS; no direct CSV/JSON file import mechanism.
  - **API**: No public developer/consumer API.
  - **Lock-in**: Moderate lock-in; exports exist (CSV/PDF) but lack full structured database export/import for easy migration.
- **Reminders/notifications**:
  - **How delivered**: Delivered via native device local push notifications with custom sound effects, with optional escalation push alerts to designated "Medfriend" caregivers if a dose is missed.
  - **Does it work offline**: Yes — core scheduled alarms are registered locally with the mobile operating system and fire without an active internet connection.
- **Integrations**:
  - **Wearables**: Apple Watch and Wear OS smartwatches (native companion app and mirrored alerts).
  - **EHR**: Syncs with U.S. Health Records via Apple Health to import prescription lists.
  - **AI features**: Rule-based drug interaction checker and schedule optimization insights; no LLM generative AI features.
- **Pricing / sustainability**:
  - **Pricing**: Freemium model. Free tier limits users to 2 medications and includes ads; Medisafe Premium costs ~$4.99/month or ~$39.99/year to unlock unlimited medications, unlimited Medfriends, custom themes, and ad-free usage.
  - **Sustainability**: Commercial closed-source product maintained by Medisafe Inc.
- **Sources**:
  - Medisafe Official Website: https://medisafeapp.com/ (Accessed August 2026)
  - Medisafe Privacy Policy: https://medisafeapp.com/privacy-policy/ (Accessed August 2026)
  - Medisafe Terms of Service: https://medisafeapp.com/terms-of-service/ (Accessed August 2026)

## Phase 2

### 1. Customer base
- **User Count & Downloads**: Google Play Store bracket is **5,000,000+** downloads (`com.medisafe.android.client`) with ~150,000+ reviews (4.7-star rating). Apple App Store has ~101,000+ ratings in US storefront (~150,000+ globally, 4.7-star rating) (Source: Google Play & Apple App Store listings, August 2026).
- **Estimated Active Base**: Company press releases claim **>10 million registered users** globally and **>7 million Monthly Active Users (MAU)** (Source: Medisafe Press Releases 2022/2025).
- **Funding & Financials**: Raised **$51.5 Million** total VC funding across Series A ($6M, 2015), Series B ($14.5M, 2017), and Series C ($30.0M, Feb 2021 led by Sanofi Ventures and ALIVE Israel HealthTech Fund, with Pitango, Merck, and Qualcomm) (Source: Crunchbase / PitchBook, August 2026).
- **Code Signals**: Closed-source proprietary software; B2B enterprise platform "Medisafe Maestro" and "Medisafe Care".

### 2. Killer features — why customers actually choose it
- **"Medfriend" Caregiver Escalation**: Sends automated push/SMS alerts to designated family members if a user misses a dose window. Users on `r/ElderCare` and `r/ChronicIllness` highlight: *"Medisafe gives my family peace of mind—if I miss my morning dose because of illness, my son gets an alert within 30 minutes."*
- **Automated Refill Reminders & Inventory Tracking**: Automatically decrements pill inventory upon logging and alerts users days before running out. Users on `r/adhd` state: *"The refill tracker alerts me 5 days before I run out so I actually have time to call the pharmacy before ADHD brain leaves me unmedicated."*
- **Visual Pill Box Customization**: Offers customizable pill shapes, colors, and textures to mirror real-life pill organizer boxes.

### 3. Marketing & acquisition — how they win customers
- **Channels**: Pharma-sponsored companion app programs ("Medisafe Maestro" with Sanofi, Merck, Pfizer), physician recommendation pads in clinics ("Medisafe Care"), and aggressive App Store Optimization (ASO) for terms like *"pill reminder"*.
- **What we can learn**: **Target Medisafe's Free-Tier Paywall Backlash.** Medisafe instituted a strict **2-medication cap on the free tier**, forcing users into a $39.99/year subscription. Build targeted landing copy for *"Medisafe Free Alternative"* emphasizing **"100% Free Unlimited Medications, No Subscription, No Account, 100% Private."**

### 4. Beating them in comparison
- **Winning Angle**: Medisafe caps free medications at 2, charges $39.99/year for unlimited meds, requires cloud account creation, and shares telemetry with pharma networks. Our PWA provides **100% free unlimited medications**, zero subscriptions, zero accounts, and 100% zero-knowledge local storage.
- **Where we lose & how to neutralize it**: We lose on server-side SMS caregiver push escalation ("Medfriend"). Neutralize by offering Web Share API / QR code export or optional client-side P2P notification hooks without storing records on a central server.
