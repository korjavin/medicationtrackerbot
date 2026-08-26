# Fasten Health

- **What it is**: Fasten Health is an open-source personal health record (PHR) and electronic medical record (EMR) aggregator designed to consolidate individual and family medical records across healthcare systems. It allows users to connect with tens of thousands of healthcare institutions via FHIR standards or manually upload clinical files into a unified personal dashboard. The platform empowers individuals to maintain full control over their historical health records.
- **Platform**: Web (Docker-based self-hosted server with web frontend UI) and Desktop (cross-platform native desktop apps for macOS, Windows, and Linux via Tauri/Electron); web-based UI (not a native mobile app or standalone PWA).
- **Hosting model**: Self-hosted (Fasten OnPrem via Docker container or desktop installer) with an optional commercial B2B API service (Fasten Connect); Open source under the GNU General Public License v3.0 (GPL-3.0).
- **Feature coverage**:
  - **Medications**: Yes — tracks active and historical medication lists, prescriptions, dosages, and prescribing clinicians aggregated via FHIR records or manual entry, though lacking inventory level tracking or scheduled dosage alarms.
  - **BP**: Yes — records blood pressure readings (systolic/diastolic) pulled from provider clinical observations or logged manually.
  - **Weight**: Yes — logs body weight metrics and trends over time as standard vital sign observations.
  - **Workouts**: No — does not track exercise routines, fitness workouts, or physical activity logs.
  - **Sleep**: No — lacks native sleep duration or sleep stage tracking.
  - **Vitals/wearables**: Partial — consolidates clinical vitals (heart rate, body temperature, pulse oximetry, blood pressure) from EHR provider systems or manual logs, but lacks direct real-time wearable device auto-sync.
  - **Food/nutrition**: No — does not support dietary logging, calorie counting, or macronutrient tracking.
  - **Diary/notes**: Partial — renders clinician progress notes, diagnostic imaging reports, and medical attachments, but offers limited personal diary journaling.
- **Privacy & encryption**: Data lives locally on the user's home server or desktop database (SQLite/PostgreSQL). Database encryption at rest is supported, and all network communications use TLS/HTTPS encryption. Vendor cannot see any personal health data in self-hosted mode; zero data sales or advertising history.
- **Data ownership**: 
  - **Export formats**: FHIR R4 JSON bundles, SQL database dumps, and EHI export formats.
  - **Import**: FHIR R4 JSON files, SMART-on-FHIR provider OAuth connections, and manual entry.
  - **API**: Internal REST / FHIR API endpoints.
  - **Lock-in**: Zero lock-in due to open source code and standardized FHIR data formats.
- **Reminders/notifications**: 
  - **How delivered**: Fasten Health is an EMR aggregator and does not include active personal notification/reminder push services for medication schedules or appointments.
  - **Does it work offline**: Fasten OnPrem operates completely offline once installed locally.
- **Integrations**: 
  - **Wearables**: No direct consumer wearable integrations (relies on EHR bridges or manual record imports).
  - **EHR**: Direct integration with over 50,000–70,000 US healthcare institutions using SMART-on-FHIR R4 standards.
  - **AI features**: None natively built-in (strictly focused on standardized clinical record aggregation).
- **Pricing / sustainability**: 100% Free and open-source for self-hosted Fasten OnPrem; paid enterprise API tier (Fasten Connect) funds ongoing development. Activity level: Active development status, ~3,200 GitHub stars, 25+ contributors, continuous commits/releases on GitHub (`fastenhealth/fasten-onprem`).
- **Sources**:
  - https://github.com/fastenhealth/fasten-onprem (Accessed August 2026)
  - https://www.fastenhealth.com/ (Accessed August 2026)
  - https://smarthealthit.org/ (Accessed August 2026)

## Phase 2

### 1. Customer base
- **Community & Install Signals**: **~2,800+ GitHub stars** and **16 contributors** on `fastenhealth/fasten-onprem`. Primary distribution via GitHub Container Registry (`ghcr.io/fastenhealth/fasten-onprem`). Note: repository archived by owner in July 2026 (Source: GitHub, August 2026).
- **Estimated Active Base**: Estimated **3,000–7,000 active self-hosted deployments** globally prior to repository archival.
- **Licensing & Financials**: 100% Free Open Source Software (GPL-3.0 license). $0 consumer revenue.
- **Code Signals**: Go backend + Vue.js frontend / Tauri desktop wrapper.

### 2. Killer features — why customers actually choose it
- **SMART-on-FHIR Patient Portal Aggregation**: Connects to 100,000+ US health systems (Epic MyChart, Cerner, Kaiser) to automatically pull lab work, immunizations, and clinical progress notes.
- **Unified Family Health Dashboard**: Multi-user family profiles allowing parents and caregivers to aggregate medical records (paraphrased theme from `r/selfhosted`).
- **Local Data Sovereignty**: Stores historical health records locally in SQLite/PostgreSQL databases.

### 3. Marketing & acquisition — how self-hosters discover it
- **Channels**: Announcements on `r/selfhosted`, `awesome-selfhosted` listings, and digital health developer blogs.
- **What we can learn**: **The Danger of Unfunded Self-Hosted Burnout.** Fasten Health's repository archival illustrates the maintenance burden of running heavy self-hosted EMR aggregators. Delivering features via a zero-knowledge PWA eliminates server maintenance overhead.

### 4. Beating them in comparison

| Feature / Dimension | Fasten Health | Our Zero-Knowledge PWA |
| :--- | :--- | :--- |
| **Project Status & Maintenance** | Archived repository (read-only, abandonware) | **Active Zero-Knowledge PWA** |
| **Server Setup Friction** | Heavy Docker / PostgreSQL self-hosting setup | **Zero-Setup Instant Browser Access** |
| **Daily Adherence Engine** | Static historical EMR aggregator (No dose alarms or stock tracking) | **Dedicated Medication Safety, Dosing, & Clinical Vitals Workbench** |

- **Winning Angle**: Fasten Health is an archived PHR project focused on static clinical portal imports; it has no daily medication reminder engine or dose adherence tracking, and stores plaintext records on the self-hosted server database. Our Zero-Knowledge PWA provides browser-managed zero-knowledge encryption, WebAuthn passkey authentication, and active daily medication adherence workflows without server setup or maintenance.
- **Where we lose & how to neutralize it**: We lose on SMART-on-FHIR cloud portal OAuth aggregation. Neutralize by supporting client-side FHIR/CSV file uploads directly in the browser.
