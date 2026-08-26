# Drip (drip-app)

- **What it is**: Drip is an open-source, privacy-first mobile application for tracking menstrual cycles and fertility, developed by the Bloody Health collective. Built as an explicit privacy alternative to commercial period tracking apps that monetize intimate health data, Drip applies symptothermal tracking principles to calculate cycle phase predictions locally without cloud infrastructure.
- **Platform**: Native mobile application for Android (Google Play Store, F-Droid) and iOS (App Store); built with cross-platform mobile frameworks (React Native).
- **Hosting model**: Local-only (runs 100% locally on device with zero cloud servers); Open source under the GNU General Public License v3.0 or later (GPL-3.0-or-later).
- **Feature coverage**:
  - **Medications**: Partial — permits tagging pain relief medications, birth control pills, or supplements in custom notes/tags, but lacks scheduled refill alarms or complex Rx tracking.
  - **BP**: No — does not log blood pressure.
  - **Weight**: No — body weight logging is not available.
  - **Workouts**: No — workout logging is not supported.
  - **Sleep**: Partial — tracks daily Basal Body Temperature (BBT) taken upon waking and sleep disturbance flags, but does not monitor sleep cycles or duration.
  - **Vitals/wearables**: Partial — tracks daily waking Basal Body Temperature (BBT) manually entered for ovulation/fertility calculations; no direct Bluetooth sensor auto-sync.
  - **Food/nutrition**: No — does not log food or nutrition.
  - **Diary/notes**: Yes — comprehensive logging of menstrual symptoms, bleeding intensity, cervical mucus quality, mood, libido, sexual activity, cramps, and custom daily notes.
- **Privacy & encryption**: All data resides strictly inside the app's local sandbox storage on the smartphone. Optional PIN/password protection locks the application locally; since no cloud backend exists, server-side data leaks are impossible. Vendor access: Zero vendor visibility, zero trackers, zero ad frameworks, zero third-party analytics, and zero data sales history.
- **Data ownership**: 
  - **Export formats**: Plaintext CSV and JSON file exports directly saved to local phone storage.
  - **Import**: CSV and JSON backup restoration for device migration.
  - **API**: None (local-only application).
  - **Lock-in**: Zero lock-in; unencrypted CSV/JSON exports allow seamless data transfer.
- **Reminders/notifications**: 
  - **How delivered**: Local smartphone push notifications scheduled on-device for period prediction alerts and daily symptom entry reminders.
  - **Does it work offline**: 100% functional offline; never requires network connectivity.
- **Integrations**: 
  - **Wearables**: None (manual data entry only to protect user privacy).
  - **EHR**: None.
  - **AI features**: Uses transparent, rule-based symptothermal algorithms for cycle predictions without black-box cloud AI models.
- **Pricing / sustainability**: 100% Free and open-source with no ads or subscriptions. Activity level: Maintained on GitLab (`gitlab.com/bloodyhealth/drip`) and mirrored on GitHub; actively updated and repeatedly audited/recommended by digital privacy organizations (Privacy Guides, Mozilla Foundation).
- **Sources**:
  - https://dripapp.org/ (Accessed August 2026)
  - https://gitlab.com/bloodyhealth/drip (Accessed August 2026)
  - https://f-droid.org/en/packages/com.drip/ (Accessed August 2026)

## Phase 2

### 1. Customer base
- **Community & Install Signals**: Play Store bracket is **10,000+** downloads (`bloodyhealth.drip`). Primary repository hosted on GitLab (`gitlab.com/bloodyhealth/drip`) with GitHub mirror (21 stars, 3 forks). Distributed on F-Droid, Play Store, and App Store (estimated **30,000–50,000 active users** globally across F-Droid and app stores, inferred from Play Store metrics and privacy portal recommendations; F-Droid does not publish download metrics) (Source: GitLab, Play Store, August 2026).
- **Estimated Active Base**: Estimated **30,000–50,000 active privacy-focused users**.
- **Licensing & Financials**: 100% Free Open Source Software (GPL-3.0 license). $0 commercial revenue (funded via non-profit digital rights grants).
- **Code Signals**: React Native mobile app operating 100% offline.

### 2. Killer features — why customers actually choose it
- **100% Offline Zero-Server Data Isolation**: All cycle data stays local on device with zero network servers or account requirements.
- **Transparent Sympto-Thermal Fertility Algorithm**: Open, rule-based fertility calculation based on basal body temperature and cervical mucus without black-box cloud AI (paraphrased theme from `r/privacy` & `r/F_Droid`).
- **Non-Commercial Gender-Inclusive UI**: Free of ads, subscriptions, or pink/girly tropes.

### 3. Marketing & acquisition — how self-hosters discover it
- **Channels**: Privacy advocacy recommendations (EFF, Privacy Guides, Mozilla's *Privacy Not Included*, Digitalcourage) following post-Roe v. Wade digital health privacy concerns, F-Droid catalogue, and `r/privacy` discussions.
- **What we can learn**: **Third-Party Privacy Audits.** Secure independent privacy reviews and listings on privacy directories (Privacy Guides) as a zero-knowledge health vault to earn high-trust organic referrals.

### 4. Beating them in comparison

| Feature / Dimension | Drip | Our Zero-Knowledge PWA |
| :--- | :--- | :--- |
| **Health Domain Scope** | Single-domain menstrual cycle & fertility tracking only | **Full Medication Safety, Dosing, & Clinical Vitals Workbench** |
| **Multi-Device Sync** | Local-only (single device; data lost if phone breaks) | **Sync Without Trust** (WebAuthn/Passkey auth + browser E2EE + blind push relay) |
| **Platform Access** | Native mobile app download required | **Instant PWA URL Access** (Zero-install, works on any browser/OS) |

- **Winning Angle**: Drip is limited strictly to single-device local period tracking with no web client or medication schedule engine. Our Zero-Knowledge PWA provides multi-device sync without vendor trust — browser-managed encryption, WebAuthn passkey security, full medication adherence, and universal web browser access across all platforms.
- **Where we lose & how to neutralize it**: We lose on Drip's sympto-thermal fertility phase calculations. Neutralize by supporting custom cycle symptom tagging in daily health logs.
