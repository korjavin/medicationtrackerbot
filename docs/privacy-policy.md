# MyHealthBot — Privacy Policy

Effective 2026-10-24. This policy covers the MyHealthBot web app at
`cloud.myhealthbot.ai` and the MyHealthBot iPhone and Android apps (shown as
"Med Tracker" on your home screen), which open the same web app. "We" is the
operator of that service. The policy is written by category: what kind of data
exists, who can read it, and how long it stays. Feature details change often;
these categories do not, and a new feature only changes this page if it
creates a new category of data leaving your device.

## The short version

- **Your health records are end-to-end encrypted.** They are encrypted on your
  device with keys that exist only on your devices. Our server stores
  ciphertext. We cannot read your records, and we cannot recover them for you
  if you lose every device and your recovery material.
- **No ads, no tracking, no analytics, nothing sold.** There is no advertising
  or analytics code in the app, and we do not sell or share data for
  marketing.
- **We do see operational metadata** that an encrypted sync service needs: that
  your account exists, when devices sync, how large the encrypted blobs are,
  the IP address a request came from, when a reminder should fire. Never the
  contents.
- **Optional features send one request's data off your device, only when you
  turn them on or use them**: AI, voice, Telegram, AI-assistant connectors,
  food and drug lookups, imports, sharing, feedback. Each category is listed
  below. In the app: **Settings → Account & privacy → What the operator can
  see**.
- **You can use the app with no account at all.** In "Only on this device"
  mode nothing is synced and we receive nothing, unless you add your own
  provider key or switch on the free trial.
- **Deleting is real and immediate** on our server; backups, where they run,
  expire within 7 days; a copy of your records exported to your device, or
  sent to a third party by a feature you used, is yours or theirs, not ours.

## Who we are, and how to reach us

MyHealthBot is a small, invite-only service run by its developer. The server
runs in the European Union (Finland). Questions and requests about your data:
**Settings → Feedback** inside the app (encrypted to the developer), or email
<dev@myhealthbot.ai>.

## Two ways to use the app

| | With an account | Only on this device |
|---|---|---|
| Where your records live | Encrypted on each of your devices, synced through our server as ciphertext | In the app's storage on this phone only |
| What we receive | Ciphertext plus the operational metadata in section 2 | Nothing, unless you use your own provider key or the free trial (section 4) |
| Sync between devices, reminders delivered while the app is closed, Telegram, AI-assistant connectors, sharing | Yes | No |
| AI with your own key, free trial AI, on-device reminders, export and import | Yes | Yes |

## 1. Your health records

Everything you track — medications and doses, blood pressure, weight, food,
workouts, sleep, vitals, diary notes, anything imported from Apple Health or
Health Connect — is one **vault**.

- The vault is encrypted on your device before it is sent anywhere. The
  encryption key is generated on your device, is protected by your passkey,
  and never leaves your devices. The server stores the encrypted vault and
  cannot decrypt it. There is no operator key, no support back door.
- A decrypted copy stays on each unlocked device so the app works offline; it
  is under that device's protection (screen lock, the phone's own backup).
- Beside each encrypted record the server stores its **kind** (medication,
  blood pressure, diary, …) and an opaque record id, so devices can sync. Not
  its contents.
- Because only you hold the keys, **we cannot reset or recover your data**.
  Keep a recovery copy: **Settings → Backup & import → Export**.

## 2. What we do see: account and operational metadata

Running an encrypted sync service needs some metadata. This is the complete
list of categories; each is stored only as long as stated.

| Category | What it is | Kept |
|---|---|---|
| Account | That an account exists, its address (subdomain), creation date, your passkeys' public keys, and for each device whether it is a browser, an Android phone or an iPhone | Life of the account |
| Sync | When each device synced, the size of each encrypted blob, the IP address it came from, and each record's kind and id | Timestamps with the data; request logs per the log retention below |
| Reminders | When a reminder should fire, and an encrypted payload we cannot read; for the phone apps, a push token issued by Apple or Google | Queue entries deleted once sent; tokens until you remove the device or they expire |
| Telegram (if linked) | Your chat id and your bot's token, stored encrypted on the server under a server key (this is server-side encryption, not vault-grade) | Until you unlink |
| Invite request | The email address and note you sent us, or your Telegram name and id, and our decision | 90 days |
| Feedback | What you write and attach, encrypted on your device to the developer; the app version and feedback kind are readable | Until the developer collects it |
| Logs | Structured application logs: account address, timestamps, request outcomes, fingerprints. Secrets, provider keys, tokens and request bodies are never logged (enforced by tests). The reverse proxy's access log is off | Bounded by log rotation on the server, measured in days or megabytes, not months |

We do not build profiles, do not correlate metadata with content (we have no
content), and do not share this metadata with anyone except the service
providers in section 7, each for its own narrow job.

## 3. Optional features that send data off your device

Each category below is **off until you turn it on or use it**, sends **only
that request's data**, never the vault behind it, and is listed in the app
under **Settings → Account & privacy → What the operator can see**. Data sent
to another company is then under that company's privacy policy, which we do
not control.

**a. AI features** (describing a meal from text or a photo, tagging exercises,
the assistant chat, weekly summaries). With **your own AI key**, requests go
directly from your device to the provider you chose; we never see them. With
the **free trial**, the text or photo you submit passes through our server to
our AI provider account (OpenAI or Anthropic). We do not store prompts or
photos; the provider's own retention applies. You consent in the app before
first use and can withdraw it in Settings → AI & integrations.

**b. Voice assistant.** Your voice, the transcript, and the records the
assistant reads aloud to answer you go to the voice provider (ElevenLabs),
through your own ElevenLabs account or, on the free trial, ours. The
assistant's spoken answers are written by an AI model; each turn passes through
our server in transit (not stored) to your device and then to your AI provider
or, without one, ours. This relay sees that turn's transcript and the records
it quotes. There is no way to make a voice call to a third party end-to-end
encrypted.

**c. Telegram.** If you link your own Telegram bot, reminder and message text
passes through our server to Telegram in the clear (a chat bot cannot be
end-to-end encrypted). We erase reminder text from our queue when it is sent
and keep only opaque ids for 48 hours so a tap on "Taken" still works. A
message you send the bot is sealed to your devices the moment it arrives and
is never stored unsealed. Telegram keeps the chat under its own policy.

**d. AI-assistant connectors** (letting Claude or ChatGPT read your records).
The **local connector** runs on your own computer and reaches your unlocked
app through a blind pipe: we see sizes and timing, never content. The
**hosted connector**, which you must switch on separately, runs on our server
and handles each query and answer in memory while it is enabled; nothing is
stored.

**e. Lookups.** Food search terms and barcodes go to a food database — ours,
through our server, unless you set your own, in which case they go directly
there. Drug names you look up or check for interactions go through our server
to RxNav, a U.S. National Library of Medicine service. We do not store or log
either.

**f. Imports.** A Mi Band backup file you import is parsed on our server in a
temporary file, encrypted into your vault, and the temporary file deleted when
the import finishes.

**g. Sharing.** A workout plan or gym you share by link is stored encrypted on
our server for 30 days; the key is in the link itself and never reaches us.
Anyone with the link can read the plan.

**h. Feedback and invite requests** are in section 2. Feedback sent through
the Telegram bot, rather than the in-app form, is handled by our server in the
clear and copied to the developer's Telegram.

## 4. Only on this device (iPhone and Android apps, no account)

If you choose **Only on this device**, there is no account and nothing syncs.
Your records are stored in the app's storage on the phone, protected by the
phone's lock. We never receive them and cannot recover them: deleting the app
or losing the phone deletes them, so export a copy regularly. The phone's own
backup (iCloud or a computer on iPhone; Google's encrypted backup and
device-to-device transfer on Android) may include them under Apple's or
Google's rules.

In this mode only two things can leave the phone, both your choice:

- **Your own provider keys** (AI, food database): requests go directly from
  the phone to that provider.
- **The free trial**, which gives the AI, food and voice features of section 3
  without an account. It is anonymous: our server keeps an **install record**,
  not a person — a device-generated key, usage counters, the platform and a
  hash of the trial pass — and keeps no prompts, photos or health data. To tell
  installs apart the app uses Apple App Attest and DeviceCheck on iPhone and
  one Google Play Integrity token on Android; no health data and no account
  are involved.

Feedback and invite requests from this mode reach us as in section 2.
**Settings → Backup & import → Erase data on this device** deletes everything
stored in this mode.

## 5. Apple Health and Health Connect

If you switch them on, the app **reads** the listed measurements (blood
pressure, weight, and on iPhone also sleep and workouts) and stores them in
your vault like a reading you typed in. It never writes back. Health data is
never used for advertising or sold, and leaves your vault only through the
optional features in section 3, when you use them. You can withdraw access at
any time in the Health app or Health Connect.

## 6. Reminders

Reminders are composed on your device. With an account, our relay stores only
the fire time and an encrypted payload and wakes the device through Apple,
Google or your browser vendor's push service, which carries an opaque blob.
Without an account, reminders are scheduled on the phone itself. By default a
reminder on the lock screen says only "Medication time"; if you choose
**Detailed**, the medication name is shown there too, visible to anyone
holding the phone.

## 7. Where your data is, and who processes it

Our server runs on rented infrastructure in the European Union (Finland). The
categories of service providers that handle data on our behalf are:

| Provider category | What reaches them | When |
|---|---|---|
| Hosting | The encrypted database and the metadata in section 2 | Always |
| Backup storage | A copy of the encrypted database; ciphertext and metadata only, expiring within 7 days | Where backups are enabled |
| Push services (Apple, Google, browser vendors) | Reminder times and an opaque encrypted payload | When you enable reminders |
| Email relay | The email address and the invite email | When we approve an emailed invite request |
| AI providers (OpenAI, Anthropic, or the one you chose) | The text or photo of one request | Section 3a, 3b |
| Voice provider (ElevenLabs) | Audio, transcript, records read aloud | Section 3b |
| Telegram | Reminder and message text | Section 3c |
| Food database, RxNav | Search terms, drug names | Section 3e |

No provider in this table can read your vault, because none of them has the
key.

## 8. Your rights, and deleting your data

- **Access and portability:** **Settings → Backup & import → Export** gives you
  every record in a documented file format, at any time, with no request to
  us.
- **Correction:** edit or delete any record in the app; the change syncs to
  all your devices.
- **Deleting your account:** **Settings → Account & privacy → Delete account**
  removes your account and all its data from our server immediately, in one
  transaction, and wipes this device's copy. Backups, where they run, expire
  within 7 days. Invite-request rows expire on their own schedule (section
  2). Data already sent to a third party through a feature you used stays
  under that party's policy.
- **No recovery after deletion:** the keys were only ever yours, so neither we
  nor anyone else can restore a deleted account. Export first.
- Residents of the EU/EEA, the UK and similar jurisdictions have the rights
  described in their law (access, rectification, erasure, restriction,
  portability, objection). The app exercises most of them directly; for
  anything else, contact us (above). Our basis for processing the metadata in
  section 2 is providing the service you asked for; for the optional features
  in section 3, your consent, which you can withdraw in Settings.

## 9. Security

Accounts are protected by passkeys (no passwords to leak). Your vault key is
derived with your passkey and encrypted on your devices; the server holds only
encrypted envelopes it cannot open. Transport is TLS. If an incident ever
exposes our database or a provider's slice, we will notify affected account
holders and say plainly what class of data was involved — ciphertext,
metadata, or a specific provider's slice — and what it can and cannot reveal.

## 10. Children

MyHealthBot is not directed at children under 13, and we do not knowingly
create accounts for them.

## 11. Changes

Changes to this policy are published at this address with a new effective
date. If a change creates a new category of data leaving your device, the app
tells you before it applies to you.
