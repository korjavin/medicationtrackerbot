# Dosecast

- **What it is**: Dosecast is a standalone medication management application developed by Montuno Software, LLC. It provides flexible medication scheduling algorithms (such as fixed intervals or schedules calculated from the time of the last taken dose), dose tracking, and multi-device synchronization.
- **Platform**: iOS (iPhone/iPad), Android, Amazon Fire OS. Native mobile applications. No web, PWA, or desktop applications exist.
- **Hosting model**: Local-only by default in the Free edition; SaaS in the Pro edition via Montuno CloudSync servers. Proprietary closed-source software.
- **Feature coverage**:
  - **Medications**: Yes — offers advanced flexible scheduling, dosage tracking, pill quantities, adherence recording, and refill alerts.
  - **BP**: No — does not support blood pressure tracking.
  - **Weight**: No — does not support weight logging.
  - **Workouts**: No — does not include workout or exercise tracking.
  - **Sleep**: No — does not support sleep logging.
  - **Vitals/wearables**: No — does not track vital signs or integrate with biometric wearables.
  - **Food/nutrition**: No — does not log food/calories (only displays "take with food/water" instructional tags).
  - **Diary/notes**: Partial — allows attaching custom notes, instructions, and doctor contacts to specific medication profiles.
- **Privacy & encryption**:
  - **Where data lives**: Stored locally on the user device in the Free edition; synced to Montuno cloud servers if using Pro CloudSync.
  - **E2EE or server-side plaintext**: Encrypted in transit (SSL/TLS) and encrypted at rest; NOT end-to-end encrypted.
  - **What vendor can see**: Montuno Software states no personally identifiable information (PII) is collected; server logs retain de-identified aggregate usage statistics.
  - **Data-sale/ads history if any**: 100% ad-free; no history of selling user data to third parties.
- **Data ownership**:
  - **Export formats**: None directly built-in (no automated CSV/PDF report generation; manual SD card database backup available on Android).
  - **Import**: Local database restore between devices; no generic CSV/health data import tool.
  - **API**: No public consumer API.
  - **Lock-in**: High lock-in due to the absence of standard CSV/PDF export options.
- **Reminders/notifications**:
  - **How delivered**: Native iOS/Android local notifications with custom alerts, smart silencing, intelligent snooze, and automatic timezone adjustments.
  - **Does it work offline**: Yes — core local alarms trigger offline without an internet connection.
- **Integrations**:
  - **Wearables**: Wear OS / Android Wear smartwatch notification support.
  - **EHR**: No EHR integration.
  - **AI features**: None (rule-based interval scheduling and timezone engine).
- **Pricing / sustainability**:
  - **Pricing**: Freemium. Free Edition includes core local reminders; Pro Edition with CloudSync costs ~$2.99/month or ~$19.99/year via in-app subscription.
  - **Sustainability**: Proprietary commercial software actively maintained by Montuno Software, LLC.
- **Sources**:
  - Montuno Software Official Site: https://www.montunosoftware.com/ (Accessed August 2026)
  - Dosecast Official Site: https://www.dosecast.com/ (Accessed August 2026)
  - Montuno Software Privacy Policy: https://www.montunosoftware.com/privacy/ (Accessed August 2026)

## Phase 2

### 1. Customer base
- **User Count & Downloads**: Google Play Store bracket is **500,000+** downloads (`com.montuno.dosecast`) with ~5,000+ user reviews (3.8-star rating). Apple App Store has ~4.1-star rating across hundreds of ratings (Source: Google Play & App Store listings, August 2026).
- **Estimated Active Base**: Estimated **700,000–1,000,000 cumulative downloads** and ~20,000–50,000 active monthly users/subscribers.
- **Developer Background & Financials**: Developed independently by Montuno Software, LLC (Jason L. Tibbitts, founded 2010). Self-funded via Pro subscriptions ($2.99/mo or $27.99/yr) and B2B clinical trial partnerships.
- **Code Signals**: Closed-source commercial software.

### 2. Killer features — why customers actually choose it
- **Rolling Interval Dosing ("X Hours After Last Dose")**: Automatically recalculates the next dose based on when the previous dose was actually taken (e.g. "take 6 hours after last dose"), essential for PRN (as-needed) pain medications where delayed intake shifts subsequent doses.
- **Persistent Nagging Alarms**: Repeated notifications until confirmed taken or snoozed. Users managing chronic pain choose Dosecast for its rolling interval recalculation on PRN meds (paraphrased theme from `r/ChronicIllness` & `r/ChronicPain`).
- **Timezone Adjustment Engine**: Adjusts schedules automatically when traveling across timezones.

### 3. Marketing & acquisition — how they win customers
- **Channels**: Organic ASO for specialized terms ("interval medication reminder", "PRN pill tracker"), doctor referrals via B2B clinical trial partnerships, and chronic pain forum recommendations.
- **What we can learn**: **Target PRN & Rolling Interval Search Terms.** Build a rolling interval dosing mode and create SEO content for "PRN Medication Interval Tracker".

### 4. Beating them in comparison

| Feature / Dimension | Dosecast | Our Zero-Knowledge PWA |
| :--- | :--- | :--- |
| **Pricing & Multi-Device Sync** | Paywalled Pro Tier ($2.99/mo or $27.99/yr for cloud sync) | **100% Free Zero-Knowledge Sync** (Passkey auth + E2EE + blind push relay) |
| **UI & Experience** | Outdated 2010s enterprise interface | **Modern Responsive PWA Workbench** |
| **Data Export** | Paywalled / minimal export capabilities | **Clean 1-Click CSV/JSON Exports** |

- **Winning Angle**: Dosecast locks cloud sync, multi-device access, and adherence logs behind a $2.99/month subscription and uploads plaintext to Montuno servers. Our PWA offers zero-knowledge multi-device sync without vendor trust — browser-managed encryption, Passkey authentication, rolling interval dosing, and clean 1-click CSV exports completely free.
- **Where we lose & how to neutralize it**: We lose on native Android persistent nagging alarms bypassing system DND. Neutralize with Service Worker Web Push notification snooze/retry actions and client-side audio reminder prompts.
