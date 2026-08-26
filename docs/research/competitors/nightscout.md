# Nightscout (cgm-remote-monitor)

- **What it is**: Nightscout (`cgm-remote-monitor`) is a community-created open-source web application designed to monitor and display Continuous Glucose Monitor (CGM) and insulin pump data in real time. Born out of the `#WeAreNotWaiting` movement, it enables patients with diabetes and their caregivers to remotely view real-time blood glucose trends, treatments, and alarms from any web browser or connected device.
- **Platform**: Web app / PWA, accessible on iOS, Android, desktop browsers, smartwatches (Apple Watch, Wear OS, Pebble), and custom display hardware.
- **Hosting model**: Self-hosted (Node.js web application deployed via Docker, Heroku, Railway, Fly.io, or home servers) connecting to a MongoDB database; Open source under the GNU Affero General Public License v3.0 (AGPL-3.0).
- **Feature coverage**:
  - **Medications**: Yes — logs insulin bolus and basal dosages, carb ratios, and custom medication administration events with precise timestamps.
  - **BP**: No — does not log or chart blood pressure data.
  - **Weight**: No — body weight tracking is not included.
  - **Workouts**: Partial — allows logging physical exercise duration and intensity markers to provide context for glucose fluctuations.
  - **Sleep**: No — does not track sleep stages or duration (though overnight glucose curves are visible continuously).
  - **Vitals/wearables**: Partial — highly specialized vital tracking for real-time continuous blood glucose telemetry, trend arrows, delta values, and sensor diagnostic data from CGMs and closed-loop pumps.
  - **Food/nutrition**: Partial — logs carbohydrate intake grams and meal timestamps specifically for insulin calculation and postprandial glucose tracking.
  - **Diary/notes**: Yes — supports custom treatment notes, sensor/cannula insertion site changes, and event annotations.
- **Privacy & encryption**: Data lives in a self-managed MongoDB instance (e.g. MongoDB Atlas or local MongoDB) and the self-hosted Node.js server. Data in transit is secured via HTTPS/TLS, while API secret tokens restrict endpoint access; database storage relies on MongoDB access controls (server-side plaintext within DB). Zero vendor access or advertising/data-selling history.
- **Data ownership**: 
  - **Export formats**: CSV, JSON via REST API, reporting tool PDFs (Nightscout Reports), and raw database exports (`mongodump`).
  - **Import**: REST API endpoints (`/api/v1/entries`, `/api/v1/treatments`), xDrip+, Loop, AndroidAPS, OpenAPS, Nightscout Connect, and Dexcom Share bridge.
  - **API**: Comprehensive REST API and real-time WebSocket feeds.
  - **Lock-in**: Zero lock-in; open data model with raw database access.
- **Reminders/notifications**: 
  - **How delivered**: High/low blood glucose alarms, urgent glucose drop sirens, sensor expiry alerts, and missed reading warnings delivered via web push notifications, Pushover, Pushbullet, Telegram, IFTTT, and smartwatch apps.
  - **Does it work offline**: Browser UI caches recent data offline, but real-time telemetry updates require network connection between CGM uploader and Nightscout server.
- **Integrations**: 
  - **Wearables**: Integrates with Dexcom G4/G5/G6/G7, FreeStyle Libre 1/2/3, Medtronic Enlite/Guardian, Apple Watch, Garmin, and Wear OS.
  - **EHR**: Connects directly with DIY Automated Insulin Delivery (AID) systems (Loop, AndroidAPS, OpenAPS); limited direct hospital EHR sync.
  - **AI features**: Built-in deterministic predictive algorithms (Autotune, COB/IOB decay curves, and glucose trend forecasting).
- **Pricing / sustainability**: 100% Free and open-source software; hosting costs depend on deployment choice (free self-hosted locally, or low-cost cloud hosting on Railway/MongoDB Atlas). Activity level: Extremely active development, ~2,600+ GitHub stars, 150+ contributors, active v15.0.x release series (e.g., v15.0.7), maintained by global volunteer community.
- **Sources**:
  - https://github.com/nightscout/cgm-remote-monitor (Accessed August 2026)
  - https://www.nightscout.info/ (Accessed August 2026)
  - https://nightscout.github.io/ (Accessed August 2026)

## Phase 2

### 1. Customer base
- **Community & Install Signals**: **~2,800+ GitHub stars**, **73,300+ GitHub forks** (high fork ratio due to cloud deployment workflow on Railway/Fly.io/Heroku), and **>1,000,000 Docker pulls** on `nightscout/cgm-remote-monitor` (Source: GitHub, Docker Hub, August 2026).
- **Estimated Active Base**: Estimated **40,000–60,000 active continuous glucose monitoring setups** globally.
- **Licensing & Financials**: 100% Free Open Source Software (AGPL-3.0 license). $0 commercial software fees.
- **Code Signals**: Node.js web server + MongoDB database + WebSockets API.

### 2. Killer features — why customers actually choose it
- **Real-Time CGM Remote Telemetry**: Streams Continuous Glucose Monitor readings (Dexcom, FreeStyle Libre) in real time to any browser or smartwatch so parents can monitor T1D children overnight.
- **DIY Closed-Loop Artificial Pancreas Integration**: Bidirectional sync with automated insulin delivery algorithms (OpenAPS, AndroidAPS, iOS Loop) displaying Insulin on Board (IOB) and Carbs on Board (COB) (paraphrased theme from `r/diabetes_t1` & `r/diabetes`).
- **Grassroots #WeAreNotWaiting Community**: Patient-led open-source movement for diabetes tech.

### 3. Marketing & acquisition — how self-hosters discover it
- **Channels**: Grassroots **#WeAreNotWaiting** movement, T1D communities (`r/diabetes`, `r/diabetes_t1`), "CGM in the Cloud" Facebook groups, and pediatric endocrinologist referrals.
- **What we can learn**: **The Power of Emotional Community Advocacy (#WeAreNotWaiting).** Build high-reliability notification features that solve severe daily patient/caregiver anxiety to generate passionate word-of-mouth advocacy.

### 4. Beating them in comparison

| Feature / Dimension | Nightscout | Our Zero-Knowledge PWA |
| :--- | :--- | :--- |
| **Target Scope & Domain** | T1D Diabetes CGMs & artificial pancreas loops only | **Universal Medication Safety, Dosing, & Multi-Metric Health Workbench** |
| **Server & Database Security** | Server-side plaintext MongoDB database on cloud hosts | **Zero-Knowledge Vault** (Passkey auth, client-side encryption, server holds ciphertext) |
| **Deployment Complexity** | Node.js + MongoDB cloud setup (73k+ forks to deploy) | **Zero-Setup Instant PWA Access** (Runs in browser with WebAuthn auth) |

- **Winning Angle**: Nightscout is hyper-focused on T1D diabetes CGMs and requires maintaining a Node.js/MongoDB cloud server storing plaintext glucose readings. Our Zero-Knowledge PWA provides browser-managed zero-knowledge encryption, Passkey authentication, and universal medication & health safety tracking without server maintenance or unencrypted cloud databases.
- **Where we lose & how to neutralize it**: We lose on real-time DIY artificial pancreas insulin loop telemetry. Neutralize by positioning our PWA as the universal medication, vital, and symptom safety tool for all health conditions.
