# Med Tracker — Privacy Policy

Effective 2026-10-18. This policy covers the Med Tracker web app and the Med
Tracker iOS app, which opens the same web app. "The operator" is whoever runs
the Med Tracker service your account lives on.

## The short version

- Your health records are **end-to-end encrypted** on your device. The server
  stores them only as ciphertext; the operator cannot read them.
- No ads, no tracking, no analytics SDKs, and no data is sold.
- A few optional features (AI, voice, Telegram, hosted AI-assistant access,
  food and drug lookups, Mi Band backup import, feedback) send a specific
  request's data off your device. Each is listed below, and in the app under
  **Settings → Account & privacy → What the operator can see**.

## What is stored, and who can read it

| Data | Where | Who can read it |
|---|---|---|
| Your health records (medications and doses, blood pressure, weight, food, workouts, sleep, vitals, diary notes, and anything imported from Apple Health) | Encrypted on your device, synced to the server | Only your unlocked devices. The server holds ciphertext. |
| A decrypted copy for offline use | On your device only | Your device |
| Account address, creation date, passkey public keys, which kind of record each sync item is (never its contents), sync times, sizes and IP addresses | Server | The operator (operational metadata) |
| Reminder fire times (and an encrypted payload) | Server push relay | The operator sees the times only |

## Optional features that send data off your device

Each one runs only when you use it; AI, Telegram-assistant and voice
features ask for your explicit consent before they use the operator's AI or
voice accounts, which you can revoke in Settings → AI &
integrations.

- **Built-in AI** (meal parsing from text or photos, exercise tagging): the
  text or photo you submit goes through the operator's server to the
  operator's AI provider (OpenAI or Anthropic).
- **Telegram** (if you link your own bot): reminder and message text passes
  through the operator's server to Telegram; your bot token is stored on the
  server.
- **Voice assistant**: your voice, the transcript, and the records the
  assistant reads to answer you go to ElevenLabs. Each turn of the
  conversation then passes through the operator's server (in transit, not
  stored) to your device, which asks your own AI provider or, without one, the
  operator's AI provider for the answer. This is so even with your own keys.
- **Your own AI key** (outside voice calls): meal, activity and assistant
  requests go directly from your device to the provider you configured.
- **Hosted AI-assistant access (MCP)**: queries and answers pass through the
  operator's server in memory while it is enabled.
- **Food search and barcode scans**: search terms go to a food database,
  through the operator's server unless you set your own.
- **Medication lookups and interaction checks**: drug names go to the U.S.
  National Library of Medicine's RxNav, through the operator's server.
- **Mi Band backup import**: the backup is parsed on the operator's server
  before it is encrypted into your vault.
- **Feedback** you send from the app: what you write and attach, encrypted to
  the developer.

Data sent to a third party is then governed by that party's privacy policy.

## Only on this device (iOS app, no account)

If you choose **Only on this device** on the first screen, there is no
account and nothing is synced: your records are stored only in the app's
storage on your iPhone, protected by iOS data protection, and the operator
never receives them. They are included in your iPhone's own backup (iCloud
or your computer), like other app data; the operator keeps no other copy and
cannot recover them. Deleting the app, or losing the iPhone without a
backup, deletes them — export a copy regularly under Settings → Backup &
import. In this mode only your own AI key and your own food database reach
outside the device; the operator's AI, voice, Telegram, food and drug lookup
features are off. **Settings → Backup & import → Erase data on this device**
deletes everything stored in this mode.

## Apple Health (iOS app)

If you switch on Apple Health in Settings, the app **reads** blood pressure,
weight, sleep and workouts and stores them in your encrypted vault, like a
reading you typed in. It never writes to Apple Health. Health data is never
used for advertising or sold, and leaves your vault only through the optional
features above, when you use them.

## Notifications (iOS app)

Reminders are scheduled on your iPhone as local notifications. Their content
is computed on the device.

## Deleting your data

**Settings → Account & privacy → Delete my account** erases your account and all
its data from the server immediately and wipes this device's copy. Server
backups, where the operator keeps them, expire within 7 days. Data already
sent to a third party through an optional feature stays under that party's
policy. Because your data is encrypted with keys only you hold, no one can
recover it after deletion — export a copy first under Settings → Backup & import.

## Children

Med Tracker is not directed at children under 13.

## Changes and contact

Changes to this policy are published at this address, with the history in the
public repository. Questions: open an issue at
<https://github.com/korjavin/medicationtrackerbot/issues> or send feedback from
inside the app.

Technical detail, generated from the code: [cloud-mode.md → Privacy
boundary](cloud-mode.md#privacy-boundary--the-vault-promise-and-its-carve-outs).
