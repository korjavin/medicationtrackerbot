# MyHealthBot — Privacy Policy

Effective 2026-10-25. This policy covers the MyHealthBot web app at
`{{HOST}}` and the MyHealthBot iPhone and Android apps (shown as
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
- **Optional features send data off your device when you turn them on or use
  them**: AI, voice, Telegram, AI-assistant connectors, food lookups, imports,
  sharing, feedback. One thing is automatic: saving a medication with an
  account sends its name to a drug database (section 3e). Each category is
  listed below. In the app: **Settings → Account & privacy → What the operator
  can see**.
- **You can use the app with no account at all.** In "Only on this device"
  mode nothing is synced and we receive nothing, unless you add your own
  provider key, switch on the free trial, or send us feedback or an invite
  request.
- **Deleting is immediate** in our live database; encrypted backups, where
  they run, expire within 30 days; a copy of your records exported to your
  device, or sent to a third party by a feature you used, is yours or theirs,
  not ours.

## Who we are, and how to reach us

MyHealthBot is a small, invite-only service run by its developer. The server
runs in the European Union (Finland). Questions and requests about your data:
**Settings → Feedback** inside the app (encrypted to the developer), or write to
<{{CONTACT}}>.

## Two ways to use the app

| | With an account | Only on this device |
|---|---|---|
| Where your records live | Encrypted on each of your devices, synced through our server as ciphertext | In the app's storage on this phone only |
| What we receive | Ciphertext plus the operational metadata in section 2 | Nothing, unless you use your own provider key, the free trial, feedback or an invite request (section 4) |
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
| Reminders | When a reminder should fire, and an encrypted payload we cannot read; for the phone apps, a push token issued by Apple or Google, held only for a content-free wake-up, not to carry reminder content | The payload is erased when the reminder is sent and Telegram tap ids after 48 hours; the row with its fire and sent times stays with the account; tokens until you remove the device or they expire |
| Hosted AI-assistant connector (if enabled) | The connector's credentials (access token and pairing key), stored encrypted under a server key; backups made before the conversion on 2026-10-25 hold the token in clear until they expire within 30 days | Until you disconnect it |
| Free trial | Usage counters, on the account or on the anonymous install record of section 4 | Account counters for the life of the account; install records have no automatic expiry today; Erase data on this device deletes this phone's current record (section 4) |
| Telegram (if linked) | Your chat id and your bot's token, stored encrypted on the server under a server key (this is server-side encryption, not vault-grade) | Until you unlink |
| Invite request | The email address and note you sent us, or your Telegram name and id, and our decision | Deleted within an hour after 90 days; the copy shown to the developer in their Telegram chat stays there (section 3h) |
| Feedback | What you write and attach, encrypted on your device to the developer; the app version and feedback kind are readable | Until the developer collects it |
| Logs | Structured application logs: account address, timestamps, request outcomes, fingerprints. Secrets, provider keys, tokens and request bodies are never logged (enforced by tests). The reverse proxy's access log is off | Bounded by size, not time: the server keeps about 30 MB of recent log lines and drops older ones; a redeploy wipes them |

We do not build profiles, do not correlate metadata with content (we have no
content), and do not share this metadata with anyone except the service
providers in section 7, each for its own narrow job.

## 3. Optional features that send data off your device

Each category below is **off until you turn it on or use it** — with one
exception, the automatic drug lookup in 3e — sends **what that feature needs
and no more**, never the whole vault, and is listed in the app under
**Settings → Account & privacy → What the operator can see**. Data sent
to another company is then under that company's privacy policy, which we do
not control.

**a. AI features** (describing a meal from text or a photo, tagging exercises,
the assistant chat, weekly summaries). What reaches the AI provider depends on
the feature: for a meal or an exercise, the text or photo of that request; for
the assistant chat, your message, the conversation so far, your assistant
preferences, and the records the assistant fetches from your vault to answer
you — a question about your blood pressure sends your blood pressure
readings; for a weekly summary, that week's figures. With **your own AI key**,
requests go directly from your device to the provider you chose; we never see
them. With the **free trial**, the same content passes through our server to
our AI provider account (OpenAI or Anthropic). We do not store prompts,
photos or answers; the provider's own retention applies. You consent in the app before
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
and handles each query and answer in memory while it is enabled; the only
thing stored is the connector's own credentials (section 2), until you
disconnect it.

**e. Lookups.** Food search terms and barcodes go to a food database — ours,
through our server, unless you set your own, in which case they go directly
there. Drug names go through our server to RxNav, a U.S. National Library of
Medicine service, to normalise the name and check interactions. **This
happens automatically whenever you save or edit a medication with an
account**; there is no separate switch for it today. We do not store or log
either kind of lookup.

**f. Imports.** A Mi Band backup file you import is parsed on our server in a
temporary file, encrypted into your vault, and the temporary file deleted when
the import finishes.

**g. Sharing.** A workout plan or gym you share by link is stored encrypted on
our server and deleted within an hour after 30 days; the key is in the link
itself and never reaches us.
Anyone with the link can read the plan.

**h. Feedback and invite requests** are in section 2. An invite request's
address and note (or your Telegram name and id) are copied to the developer's
own Telegram chat for review and stay there; our decision reaches you by email
(approval or decline) or through the bot. Feedback sent through the Telegram
bot, rather than the in-app form, is handled by our server in the clear and
copied to the developer's Telegram the same way.

## 4. Only on this device (iPhone and Android apps, no account)

If you choose **Only on this device**, there is no account and nothing syncs.
Your records are stored in the app's storage on the phone, protected by the
phone's lock. We never receive them and cannot recover them: deleting the app
or losing the phone deletes them, so export a copy regularly. The phone's own
backup (iCloud or a computer on iPhone; Google's encrypted backup and
device-to-device transfer on Android) may include them under Apple's or
Google's rules.

In this mode three things can leave the phone, each your choice:

- **Your own provider keys** (AI, food database): requests go directly from
  the phone to that provider.
- **The free trial**, which gives the AI, food and voice features of section 3
  without an account. It is anonymous: our server keeps an **install record**,
  not a person — a device-generated key, usage counters, the platform and a
  hash of the trial pass — and keeps no prompts, photos or health data. To tell
  installs apart the app uses Apple App Attest and DeviceCheck on iPhone and
  one Google Play Integrity token on Android; no health data and no account
  are involved. The install record has no automatic expiry today; **Erase data on
  this device** (below) deletes this phone's current record. It holds no health data.
- **Feedback and invite requests**, which reach us as in section 2. Sending
  feedback from this mode creates the same anonymous install record, without
  the trial.


**Settings → Backup & import → Erase data on this device** deletes everything
this mode stored on the phone except the anonymous trial pass, which the app
keeps (on Android it is part of the phone's backup, as above). If the app holds
the key to an anonymous install record on the operator's server, it first asks
the server to delete that record and its trial budget (an Android phone restored
from this phone's backup shares that record, so its remaining trial goes too).
If the server can't be reached (you're offline, or the app needs an update), you
are told and can cancel. If you erase anyway, the install record stays on the
server. After a successful erase, the server still keeps:

- daily usage counts, with nothing left that links them to this phone
- anonymous feedback you sent that the operator hasn't collected yet, until it
  is collected
- an older install record from before a reinstall, if the phone still holds a
  pass for it, until the trial is switched on again and the phone is erased
  again

Apple's DeviceCheck flags, and Google's device recall if the operator switches
it on, are kept by Apple or Google and the operator can't clear them. They limit
how many free trials one phone can get after erasing.

## 5. Apple Health and Health Connect

If you switch them on, the app **reads** the listed measurements (blood
pressure, weight, sleep and workouts) and stores them in
your vault like a reading you typed in. It never writes back. Health data is
never used for advertising or sold, and leaves your vault only through the
optional features in section 3, when you use them. You can withdraw access at
any time in the Health app or Health Connect.

## 6. Reminders

Reminders are composed on your device. With an account, a browser gets
reminders through our relay: it stores only the fire time and an encrypted
payload, and the browser vendor's push service carries that opaque blob. The
phone apps schedule reminders on the phone itself; what Apple or Google
deliver to them is a content-free wake-up. Without an account, reminders are
scheduled on the phone itself. You choose
what a reminder shows on the lock screen: only "Medication time", or
**Detailed**, which adds the medication name, visible to anyone holding the
phone. The app asks when you turn reminders on; you can change it in Settings.

## 7. Where your data is, and who processes it

Our server runs on rented infrastructure in the European Union (Finland). The
categories of service providers that handle data on our behalf are:

| Provider category | What reaches them | When |
|---|---|---|
| Hosting | The encrypted database and the metadata in section 2 | Always |
| Backup storage | A copy of the encrypted database; ciphertext and metadata only, expiring within 30 days | Where backups are enabled |
| Push services (Apple, Google, browser vendors) | Browsers: reminder times and an opaque encrypted payload. Phone apps: a content-free wake-up only | When you enable reminders |
| Email relay | The email address and our approval or decline notice | When we decide an emailed invite request |
| AI providers (OpenAI, Anthropic, or the one you chose) | The content of that feature's request: a meal's or exercise's text or photo; for the assistant, your message, the conversation so far, your preferences and the records fetched to answer you; for a summary, that week's figures | Section 3a, 3b |
| Voice provider (ElevenLabs) | Audio, transcript, records read aloud | Section 3b |
| Telegram | Reminder and message text; invite requests and bot feedback shown in the developer's chat | Sections 3c, 3h |
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
  removes your account and all its data from our live database at once, in
  one transaction, and wipes this device's copy. Encrypted backups, where
  they run, expire within 30 days; in the rare case we restore an older
  backup, a deleted account could reappear until we delete it again. Freed
  database pages are reused, not scrubbed. Invite-request rows and the
  developer's Telegram copy follow section 2 and 3h. Data already sent to a
  third party through a feature you used stays under that party's policy.
- **After deletion:** the keys were only ever yours, so we cannot read what a
  backup still holds. Another device you still have unlocked keeps its own
  copy until you erase it there. Export first.
- Residents of the EU/EEA, the UK and similar jurisdictions have the rights
  described in their law (access, rectification, erasure, restriction,
  portability, objection). The app exercises most of them directly; for
  anything else, contact us (above). Our basis for processing the metadata in
  section 2 is providing the service you asked for; for the optional features
  in section 3, your consent, which you can withdraw in Settings.

## 9. Security

Accounts are protected by passkeys (no passwords to leak). Your vault key is
generated at random on your device and wrapped with a key derived from your
passkey; the server holds only encrypted envelopes it cannot open. Transport is TLS. If an incident ever
exposes our database or a provider's slice, we will notify affected account
holders and say plainly what class of data was involved — ciphertext,
metadata, or a specific provider's slice — and what it can and cannot reveal.

## 10. Children

MyHealthBot is not directed at children under 13, and we do not knowingly
create accounts for them.

## 11. Changes

- 2026-10-25: rewritten by data category; product name, contact address, metadata and retention tables, provider categories and your rights added.

Changes to this policy are published at this address: we update the
effective date at the top and summarise material changes here. A feature that
creates a new category of data leaving your device asks for your consent in
the app before it runs, as the optional features in section 3 do today (the
automatic drug lookup in 3e predates this rule and is disclosed there).
