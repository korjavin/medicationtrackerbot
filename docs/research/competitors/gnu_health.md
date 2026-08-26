# GNU Health

- **What it is**: GNU Health is a free, open-source Libre Health and Hospital Information System (HIS / EMR / LIS) backed by GNU Solidario. Designed for public health organizations, hospitals, clinics, and health professionals, it offers comprehensive clinical, administrative, epidemiological, and genetic record management. It also features MyGNUHealth, a companion personal health record (PHR) application for individuals.
- **Platform**: Multi-platform ecosystem — GNU Health Server (Python/Tryton framework on Linux/BSD), GNU Health Desktop Client (GTK/Tryton desktop client for Linux, Windows, macOS), Web Client (gnuhealth-web), and MyGNUHealth Mobile/Desktop app (Qt/KDE Plasma/Kirigami for Linux mobile, Android, and Desktop).
- **Hosting model**: Self-hosted on dedicated servers or local infrastructure; Open source under the GNU General Public License v3.0 or later (GPL-3.0+).
- **Feature coverage**:
  - **Medications**: Yes — complete clinical pharmacy management including prescriptions, drug interactions, inventory control, dosage schedules, administration logs, and pharmacy tracking.
  - **BP**: Yes — full blood pressure charting, vital sign monitoring, and historical medical charting.
  - **Weight**: Yes — tracks body weight, height, BMI calculations, and pediatric growth charts.
  - **Workouts**: Partial — MyGNUHealth tracks physical activity levels and lifestyle habits within its bio-psycho-social sphere model.
  - **Sleep**: Partial — MyGNUHealth logs sleep duration and subjective sleep quality metrics.
  - **Vitals/wearables**: Yes/Partial — tracks all clinical vitals (heart rate, BP, SpO2, respiratory rate, temperature); MyGNUHealth logs personal vitals, though consumer wearable auto-sync requires custom bridge scripts.
  - **Food/nutrition**: Yes — clinical dietetics, nutritional evaluations, eating habits, and hospital meal planning modules.
  - **Diary/notes**: Yes — clinical progress notes, consultation logs, psychological assessments, patient diary entries, and bio-psycho-social evaluations.
- **Privacy & encryption**: Data lives in self-hosted PostgreSQL database servers managed by the institution or individual; MyGNUHealth stores personal data on-device. Encrypted connections via SSL/TLS; Thalamus federation server uses secure REST/JSON APIs; PostgreSQL supports encryption at rest; GNU Project guidelines guarantee zero commercial tracking or telemetry. Zero vendor access or data-sale history.
- **Data ownership**: 
  - **Export formats**: Standard CSV, XML, JSON, PDF medical reports, and PostgreSQL database dumps (`pg_dump`).
  - **Import**: CSV and XML import wizards via Tryton framework, HL7 / FHIR data mapping via Thalamus federation hub.
  - **API**: RESTful API hub via the Thalamus federation module.
  - **Lock-in**: Zero lock-in due to open SQL database schema and standard open formats.
- **Reminders/notifications**: 
  - **How delivered**: Institutional desktop alerts, appointment calendars, medication dosage schedules, and email/SMS triggers via server plugins; MyGNUHealth uses local mobile/system notifications.
  - **Does it work offline**: MyGNUHealth operates offline locally; desktop clients require network connection to the self-hosted GNU Health server, which can run on an isolated local LAN without internet.
- **Integrations**: 
  - **Wearables**: Integrates via Thalamus REST API gateway; custom telemetry bridge scripts can feed data into patient records.
  - **EHR**: Native, end-to-end EMR/HIS/LIS system with HL7 FHIR and DICOM medical imaging compatibility capabilities.
  - **AI features**: Built-in statistical epidemiology tools, bio-informatics, and medical genetics analysis (no external proprietary AI required).
- **Pricing / sustainability**: 100% Free and open-source (official GNU Project package). Activity level: Highly sustainable 15+ year project funded by GNU Solidario non-profit, active major releases (GNU Health 4.x series), international deployments worldwide, active developer mailing lists and Savannah/GitLab repositories.
- **Sources**:
  - https://www.gnuhealth.org/ (Accessed August 2026)
  - https://savannah.gnu.org/projects/gnuhealth (Accessed August 2026)
  - https://en.wikipedia.org/wiki/GNU_Health (Accessed August 2026)

## Phase 2

### 1. Customer base
- **Deployments & Institutional Reach**: Official GNU package hosted on Codeberg (`codeberg.org/gnuhealth/his`). Deployed across **hundreds of public hospital facilities, health ministries, and primary care clinics** globally (Jamaica Ministry of Health, Suriname Academic Hospital, Argentina Entre Ríos public health system, Cameroon Bafia Hospital) managing **millions of patient EMRs** (Source: GNU Solidario, UN/WHO DPGA Registry, August 2026).
- **Estimated Active Base**: Institutional hospital system scale (millions of patients managed by healthcare professionals).
- **Licensing & Financials**: 100% Free Open Source Software (GPL-3.0+ license). Certified UN Digital Public Good (DPG).
- **Code Signals**: Python / Tryton ERP framework + PostgreSQL server.

### 2. Killer features — why customers actually choose it
- **Enterprise Hospital ERP & LIS**: Complete open-source hospital management covering inpatient care, pharmacy, laboratory (LIS), and epidemiology.
- **Social Determinants of Health (SDoH)**: Prioritizes socio-economic conditions, sanitation, and living environment alongside bio-medical data.
- **Thalamus Federation Engine**: Multi-node sync between rural health posts and regional hospital servers.

### 3. Marketing & acquisition — how self-hosters discover it
- **Channels**: GNU Solidario advocacy, UN Digital Public Goods Alliance, WHO partnerships, and international medical informatics conferences (IWEEE, GNUHealthCon).
- **What we can learn**: **Standardized Clinical Data Models.** Implement open FHIR/CSV data exports to ensure personal vaults can bridge into clinical environments.

### 4. Beating them in comparison

| Feature / Dimension | GNU Health | Our Zero-Knowledge PWA |
| :--- | :--- | :--- |
| **System Complexity** | Heavy enterprise hospital ERP system (requires Python/Tryton/PostgreSQL sysadmin setup) | **Zero-Setup Instant PWA Access** (Runs in any browser; no server installation needed) |
| **Target User & Scope** | Hospital administrators, doctors, and nurses managing institutional patients | **Individuals & Caregivers** managing personal medication adherence & daily vitals |
| **Privacy & Keys** | Server-side database access (unencrypted server DB plaintext for medical staff) | **Zero-Knowledge Vault** (Passkey auth, client-side encryption, server holds ciphertext) |

- **Winning Angle**: GNU Health is a heavy multi-user enterprise hospital management ERP system requiring complex server infrastructure; it is not designed for individual personal health/medication self-management. Our PWA provides an instant, zero-setup zero-knowledge vault for personal health and medication management in any web browser.
- **Where we lose & how to neutralize it**: We lose on hospital-wide inpatient billing and Laboratory Information System (LIS) workflows. Neutralize by maintaining focused individual medication safety and daily vital tracking.
