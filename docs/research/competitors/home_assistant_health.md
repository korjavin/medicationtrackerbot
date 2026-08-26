# Home Assistant Health Integrations

- **What it is**: Home Assistant Health Integrations encompass the native integration components, HACS custom repositories, and local BLE proxy sensors within the open-source Home Assistant smart home ecosystem. They aggregate personal health telemetry — such as body weight, blood pressure, sleep cycles, activity levels, and bed presence — into Home Assistant entities for visualization and home automation routines.
- **Platform**: Web dashboard (Lovelace UI), native iOS app (Home Assistant Companion), Android app (Home Assistant Companion with Health Connect integration), and desktop browsers.
- **Hosting model**: Self-hosted on local hardware (Raspberry Pi, x86 NUC, Docker, Home Assistant OS); Open source under the Apache License 2.0 (Home Assistant Core).
- **Feature coverage**:
  - **Medications**: Partial — managed via custom entities, input_booleans, local scripts, and HACS components (e.g. `lovelace-medication-tracker`) for dashboard reminder popups and adherence logging, but no native clinical Rx database.
  - **BP**: Yes — reads blood pressure metrics (systolic, diastolic, pulse) via cloud integrations (Withings, Omron) or local Bluetooth sensors.
  - **Weight**: Yes — tracks body weight, body fat %, muscle mass, and BMI history via smart scales (Withings, Xiaomi Scale, Eufy, ESPHome BLE proxies).
  - **Workouts**: Partial — imports workout sessions, daily steps, active calories, and exercise duration from Fitbit, Google Fit, Apple Health, or Garmin.
  - **Sleep**: Yes — monitors sleep duration, sleep stages, and real-time bed presence using Withings Sleep Analyzer mats or Apple Health/Fitbit sleep sensors.
  - **Vitals/wearables**: Yes — captures real-time heart rate, blood oxygen (SpO2), body temperature, blood glucose (via native Nightscout HA integration), and step count from connected wearables and smart sensors.
  - **Food/nutrition**: Partial — imports daily water intake, calorie consumption, and macronutrient totals from Google Fit or custom REST endpoints.
  - **Diary/notes**: Partial — supports persistent text inputs, todo lists, and logbook history entries tied to person entities and timestamps.
- **Privacy & encryption**: Data is stored locally in Home Assistant's SQLite/MariaDB database on the home server; local BLE proxies process data without leaving the LAN. Cloud integrations store data on respective vendor clouds (Withings, Google, Fitbit). Encrypted local communication via TLS/HTTPS, and encrypted cloud remote connection via Nabu Casa. Zero vendor access for local Home Assistant Core data; cloud integrations depend on vendor privacy policies.
- **Data ownership**: 
  - **Export formats**: SQLite/MariaDB database export, CSV exports via History page, InfluxDB / Prometheus long-term storage integration, and REST/WebSocket API endpoints.
  - **Import**: Native integration webhooks, REST API (`/api/states`), Android Health Connect sync, and HACS components.
  - **API**: Comprehensive REST API and WebSocket API.
  - **Lock-in**: Zero lock-in; open-source state engine allowing raw database extraction or live streaming to open TSDBs.
- **Reminders/notifications**: 
  - **How delivered**: Delivered via Home Assistant Companion App (iOS/Android push notifications with actionable buttons), local smart speaker announcements (TTS via Sonos/Alexa/Google Home), persistent dashboard popups, Telegram, or Matrix messages.
  - **Does it work offline**: Local BLE sensors, ESPHome proxies, and local automations work 100% offline without internet; cloud vendor integrations (Fitbit, Withings Cloud API) require active internet connectivity.
- **Integrations**: 
  - **Wearables**: Fitbit (native), Withings (native), Apple Health (via bridge apps like Health Auto Export), Google Fit / Health Connect (native Companion app), Garmin (HACS), Nightscout (native HA integration).
  - **EHR**: Indirect via Nightscout or custom REST/FHIR bridge sensors; not a native clinical EHR.
  - **AI features**: Supports local AI LLM integrations (Home Assistant Assist with Ollama, LocalAI, or OpenAI API) for natural language querying of health state history.
- **Pricing / sustainability**: 100% Free and open-source core; optional $6.50/mo Nabu Casa cloud subscription for remote access and voice assistant support. Activity level: Extremely high activity, #1 most active open-source Python project on GitHub, ~78,000+ GitHub stars, 4,000+ contributors, bi-weekly major releases, backed by Nabu Casa company.
- **Sources**:
  - https://www.home-assistant.io/integrations/withings/ (Accessed August 2026)
  - https://www.home-assistant.io/integrations/fitbit/ (Accessed August 2026)
  - https://companion.home-assistant.io/docs/core/sensors/#health-connect-sensors (Accessed August 2026)
  - https://github.com/home-assistant/core (Accessed August 2026)

## Phase 2

### 1. Customer base
- **User Count & Server Base**: **671,689 opted-in active Home Assistant instances** (analytics.home-assistant.io, August 2026; ~33% opt-in rate yields an estimated **>2,000,000 active Home Assistant instances** total). GitHub has **~78,000+ stars** and >4,000 contributors on `home-assistant/core` (Source: Home Assistant Analytics, GitHub, August 2026).
- **Estimated Active Base**: Estimated **200,000–300,000 active health-tracking smart home setups** (10–15% of HA instances integrating scales, Dexcom, or BLE vitals).
- **Licensing & Financials**: 100% Free Open Source Software (Apache 2.0 license). Backed by Nabu Casa ($6.50/mo optional cloud subscription).
- **Code Signals**: Python backend + Lovelace JS frontend.

### 2. Killer features — why customers actually choose it
- **Local BLE Health Sensor Integration**: Directly pairs with Bluetooth scales, blood pressure cuffs, and ESPHome proxies without cloud vendor accounts.
- **Unified Smart Home & Health Dashboard**: Places weight, sleep, blood pressure, and glucose charts alongside room controls and light scenes.
- **Cross-Device Automation Triggers**: Triggers physical home events based on health telemetry (e.g. low Dexcom glucose reading flashes smart lights or speaks audio alert) (paraphrased theme from `r/homeassistant`).

### 3. Marketing & acquisition — how self-hosters discover it
- **Channels**: Home Assistant Integration Directory (`home-assistant.io/integrations`), HACS, YouTube home automation creators, and `r/homeassistant` (400k+ members).
- **What we can learn**: **Slick Interactive Health Dashboards & Push Alerts.** Match Home Assistant's dashboard convenience and real-time push alerts without forcing users to manage home automation servers or YAML code.

### 4. Beating them in comparison

| Feature / Dimension | Home Assistant Health | Our Zero-Knowledge PWA |
| :--- | :--- | :--- |
| **Server & Setup Friction** | Requires dedicated hardware (Raspberry Pi/NUC), YAML coding, & reverse proxies | **Zero-Setup Instant PWA Access** (Runs in any browser; zero server installation) |
| **Database Encryption** | Plaintext local SQLite/MariaDB database on home server | **Zero-Knowledge Vault** (Passkey auth, client-side encryption, server holds ciphertext) |
| **Medication Safety Scope** | Generic input_boolean entities or custom YAML scripts (no clinical Rx database) | **Dedicated Medication Safety, Dosing, & Clinical Vitals Workbench** |

- **Winning Angle**: Home Assistant Health requires setting up dedicated server hardware (Raspberry Pi/NUC), writing YAML scripts, and storing plaintext health logs in a home database. Our PWA provides zero-knowledge multi-device sync without vendor trust — instant browser access, WebAuthn passkey authentication, dedicated clinical medication safety, and zero hardware requirements.
- **Where we lose & how to neutralize it**: We lose on physical smart light/speaker automation triggers. Neutralize with browser Web Push alerts and Web Share API exports.
