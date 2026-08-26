# wger (wger Workout Manager)

- **What it is**: wger (Workout Manager) is a free, open-source web and mobile application designed to manage personal fitness routines, body measurements, and dietary intake. It features an extensive exercise database, a workout planner with set/rep tracking, a meal plan creator, and progress visualization.
- **Platform**: Web (Python/Django responsive web application), Mobile (Android via F-Droid/Google Play and iOS via App Store, built with Flutter).
- **Hosting model**: Self-hosted (Docker container or manual Django server setup) with an optional hosted SaaS instance at `wger.de`. Open source licensed under AGPL-3.0-or-later.
- **Feature coverage**:
  - **Medications**: No — wger focuses strictly on fitness and nutrition and has no medication tracking features.
  - **BP**: Partial — allows logging generic body measurements, but lacks dedicated blood pressure tracking fields (systolic/diastolic).
  - **Weight**: Yes — logs body weight over time with interactive trend charts and CSV import/export.
  - **Workouts**: Yes — comprehensive workout routine management, set/rep/weight logging, exercise wiki/diagrams, and rest timers.
  - **Sleep**: No — does not track sleep hours or sleep quality.
  - **Vitals/wearables**: No — no direct integration with wearable heart rate monitors or clinical vital signs.
  - **Food/nutrition**: Yes — meal planning and daily food log with calorie/macro breakdown integrated with the Open Food Facts database.
  - **Diary/notes**: Yes — supports adding free-form notes to workout sessions and day entries.
- **Privacy & encryption**:
  - **Where data lives**: Stored in a relational database (SQLite/PostgreSQL) on the user's self-hosted server or on `wger.de` servers if using the public instance.
  - **E2EE or server-side plaintext**: Server-side plaintext stored in standard database tables; syncs over HTTPS/TLS using REST API JWT tokens; no end-to-end encryption (E2EE).
  - **What vendor can see**: Zero visibility on self-hosted instances; for `wger.de` hosted accounts, instance administrators have server-side access to database records.
  - **Data-sale/ads history if any**: Ad-free, non-commercial, no history of selling user data.
- **Data ownership**:
  - **Export formats**: CSV (for weight and measurement logs) and JSON (via REST API endpoints and database fixtures/dumps).
  - **Import**: CSV import for body weight entries; JSON fixtures for exercise/food data.
  - **API**: Full REST API with API token / JWT authentication.
  - **Lock-in**: Minimal (open database schema, standard REST API, and full export capabilities).
- **Reminders/notifications**:
  - **How delivered**: Rest timer alerts and workout schedule notifications via mobile app local notifications.
  - **Does it work offline**: Mobile app supports offline logging (with local caching via PowerSync/Flutter local storage) which syncs when connected to the server.
- **Integrations**:
  - **Wearables**: None natively.
  - **EHR**: None natively.
  - **AI features**: None.
- **Pricing / sustainability**:
  - **Pricing**: Free and open-source; public `wger.de` instance is free to use (supported by donations/sponsors).
  - **Sustainability**: Highly active repository (`wger-project/wger`) with ~6,700+ GitHub stars, >100 contributors, active 2026 development (v2.6+ series with PowerSync offline sync).
- **Sources**:
  - GitHub Repository: https://github.com/wger-project/wger (Accessed August 2026)
  - Documentation: https://wger.readthedocs.io/ (Accessed August 2026)
  - Official Web Portal: https://wger.de (Accessed August 2026)

## Phase 2

### 1. Customer base
- **Community & Install Signals**: **~6,700+ GitHub stars** and **100+ contributors** on `wger-project/wger`. **27,000+ total downloads** on Google Play Store (`de.wger.flutter`) with primary distribution via Docker Hub (**>1,000,000 pulls** across wger server images) and F-Droid (Source: GitHub, AppBrain, Docker Hub, August 2026).
- **Estimated Active Base**: Estimated **10,000–25,000 active self-hosters and app users** globally.
- **Licensing & Financials**: Free open-source software (AGPL-3.0 license); funded via Open Collective donations and public `wger.de` sponsorships.
- **Code Signals**: Python/Django backend + Flutter mobile app + REST API.

### 2. Killer features — why customers actually choose it
- **Self-Hosted Gym & Meal Management**: Complete self-hosted alternative to proprietary gym workout planners (Hevy, Strong) and calorie counters (MyFitnessPal).
- **Comprehensive REST API**: Quantified Self power users choose wger because of its open REST API to push workout data into personal dashboards (paraphrased theme from `r/selfhosted` & `r/QuantifiedSelf`).
- **Open Food Facts Integration**: Pulls nutritional data from open-source databases without paywalls.

### 3. Marketing & acquisition — how self-hosters discover it
- **Channels**: Recommendations on `r/selfhosted`, `awesome-selfhosted` curated lists, and homelab YouTube setup guides.
- **What we can learn**: **Targeting Self-Hosted Curated Directories.** Ensure our PWA is listed in `awesome-selfhosted` and privacy directories as a zero-knowledge health tracking vault.

### 4. Beating them in comparison

| Feature / Dimension | wger | Our Zero-Knowledge PWA |
| :--- | :--- | :--- |
| **Server Deployment Complexity** | Complex Docker/Django/PostgreSQL self-hosting setup required | **Zero-Setup PWA Instant Access** (Runs in any browser; optional single-container server) |
| **Data Encryption Architecture** | Plaintext database on server (no E2EE) | **Zero-Knowledge Vault** (Passkey auth, client-side encryption, server holds ciphertext) |
| **Medication & Clinical Scope** | 100% focused on gym workouts/macros (No meds or clinical vitals) | **Full Medication Safety, Dosing, & Clinical Vitals Workbench** |

- **Winning Angle**: wger requires setting up complex Docker/PostgreSQL containers, stores plaintext data on the server, and has no medication or clinical health features. Our PWA provides zero-knowledge multi-device sync without vendor trust — instant browser access, WebAuthn passkey authentication, and full medication/symptom tracking.
- **Where we lose & how to neutralize it**: We lose on wger's built-in exercise wiki database. Neutralize by offering flexible custom workout metric logging.
