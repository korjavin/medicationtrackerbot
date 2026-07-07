# E2EE Cloud Mode — zero-knowledge cloud + browser PWA

**Status: design proposal; C0 is complete — C0a (service foundation + passkey signup/unlock), C0b (device lifecycle: QR/typed-code add-device, recovery redemption + forced rotation, revocation), and C0c (encrypted oplog sync + snapshot compaction + blind web-push relay) are implemented — see `cmd/cloud`, `internal/cloudstore`, `internal/cloudserver`, `web/cloud/`, [docs/cloud-deployment.md](cloud-deployment.md). C1 is also implemented (scope deviation from the original phasing below: it ports BP + weight, not medications — see "C1 implementation notes"). C2a (diary/notes, settings incl. integrations-keys-in-vault, vitals read side) is also implemented — see "C2a implementation notes". C2b (medications + intake state machine + tz handling + reminder compute-and-upload) is also implemented — see "C2b implementation notes". C2c (food logs/products/stats/meals, direct-from-browser AI parsing, direct-from-browser food-DB search with an operator default) is also implemented — see "C2c implementation notes". C2d (workouts — groups/variants/exercises/library CRUD, next-workout + rotation engine, session lifecycle, exercise logs, stats, mi-band read/edit) is also implemented — see "C2d implementation notes". C2e (full-vault export/import in both modes: Settings → Import/Export UI, optional age passphrase encryption, `/api/export` + `/api/import` in bot mode) is also implemented, closing the C2 series — see "C2e implementation notes". Plan: `docs/plans/2026-07-06-cloud-c2e-vault-export-import.md`.**

C0a deviations from this spec, discovered during implementation: subdomain and `account_id` are **server-assigned** at invite time, not client-generated at signup — a deliberate clarification, only key material (DEK, KEK, passkey PRF, recovery code) must be client-generated. Registration is invite-only from day one (admin CLI `cloud admin invite`), matching the Onboarding section below.

Third install story, alongside server mode (`docs/architecture.md`) and the Capacitor mobile build (`docs/local-mode.md`):

> Visit the signup page → get `https://amber-falcon-8k3q9x.app.<cloud-domain>` → create a passkey (Face ID / fingerprint) → save the Emergency Kit → Add to Home Screen. Done. Reminders fire, data syncs across devices, camera/AI/voice features unlock as the user adds their own provider keys. The cloud operator is *cryptographically unable* to read any of it.

The cloud provides exactly three things: **hosting** (a trusted HTTPS origin per user), **storage** (encrypted blobs), and a **push relay** (a blind alarm clock). Everything else — all domain logic, all provider API calls — runs in the browser.

## Goals / non-goals

Goals:

- Zero install effort: no server, no DNS, no certs, no app store. One URL, one passkey — no passphrase to memorize.
- Zero knowledge: a full server breach, subpoena, or malicious operator yields ciphertext and timing metadata, nothing else.
- Full PWA capabilities on iOS ≥ 16.4 and Android: installed home-screen app, offline, camera, barcode, web-push reminders.
- Multi-device with durable backup — the cloud copy is the source of truth; browser storage is a cache.
- BYO keys: OpenAI(-compatible), vision, ElevenLabs, food DB — stored inside the encrypted vault, used directly from the browser.
- Optional Telegram channel when the user brings their own bot token.

Non-goals:

- Replacing server mode. Self-hosted installs keep Telegram-rich bot UX, server-side MCP, importers.
- Server-side AI proxying or any server feature that requires plaintext.
- Multi-user accounts / sharing (future work, needs asymmetric sharing crypto).

## Architecture

```
┌────────────────────────────── user's devices ─────────────────────────────┐
│  Installed PWA (per-user origin)                                          │
│  ├─ existing web/static UI (unchanged, byte-identical to server mode)     │
│  ├─ /api/* shim → in-browser domain layer (JS port) → Dexie/IndexedDB     │
│  ├─ WebCrypto vault (DEK; unlocked via passkey PRF envelopes)             │
│  └─ direct calls: api.openai.com, ElevenLabs, food DB (user's own keys)   │
└──────────────┬─────────────────────────────────────────────────────────────┘
               │ TLS; bodies are ciphertext
┌──────────────▼──────────────── the cloud ──────────────────────────────────┐
│  static host  *.app.<domain>  (one PWA bundle, wildcard cert)              │
│  blob sync API      — encrypted oplog + snapshots, per-account cursors     │
│  push relay         — (fire_at, ciphertext) queue → Web Push (RFC 8291)    │
│  telegram sender    — optional, BYO token; sealed inbound mailbox          │
│  mcp relay          — optional, blind WebSocket pipe (see MCP section)     │
└──────────────┬──────────────────────────────────────────────────────────────┘
               │
        FCM / APNs / api.telegram.org
```

## Trust model — what the server can and cannot see

Model the cloud as honest-but-curious **and** breachable. Design so that even a hostile operator learns nothing beyond metadata.

| Server **never** sees | Server **necessarily** sees (metadata) |
|---|---|
| Health data (meds, BP, weight, food, sleep, diary, workouts) | Account exists; subdomain name; creation date |
| Provider API keys (OpenAI, ElevenLabs, food DB) | Blob counts/sizes, sync timestamps, client IPs |
| DEK, passkey PRF outputs, recovery code | Reminder **timing** (when pushes fire, not what) |
| Reminder content (two-layer encrypted) | Push subscription endpoints (reveals browser vendor) |
| Any plaintext record, ever | Optional: email (URL recovery only), TG bot token + chat id (opt-in) |

**The honest caveat — code serving.** E2EE fully protects data at rest and in transit against the server. It cannot protect against the origin serving *poisoned JavaScript* that exfiltrates the key on next unlock — the fundamental limit of web-delivered cryptography (why Signal ships signed binaries). Mitigations, in increasing strength: subresource integrity + versioned immutable assets; service-worker-pinned bundles with update prompts (an installed PWA runs cached code — a hostile update requires the SW to accept it, which narrows the attack to update time); reproducible builds published to a transparency log; and ultimately, users who need stronger guarantees use the Capacitor store build against the same cloud (the cloud then serves only blobs + push, never code). The proposal accepts this residual risk for the PWA tier and documents it in user-facing security notes.

## Accounts, subdomains, hosting

- Per-user origin: `https://<petname>-<random>.app.<cloud-domain>` (e.g. `amber-falcon-8k3q9x`), generated client-side at signup, ≥ 48 bits of entropy in the random suffix.
- **Why per-user subdomains** (not one origin + accounts):
  - Browser storage, service workers, and push subscriptions are *per-origin* — each user's install is fully isolated by the platform, no multi-account state to manage.
  - The unguessable name is a capability-style outer moat (defense in depth — real auth still applies; see key hierarchy).
  - The home-screen icon is inherently "your instance"; no login-switching UX inside one origin.
- **Wildcard everything so individual names never leak**: wildcard DNS record (`*.app.<domain>` — names absent from the zone) and wildcard TLS cert via DNS-01 (names absent from Certificate Transparency logs). Residual leak: DNS queries and TLS SNI expose the subdomain to network observers (mitigated over time by DoH and ECH). This is why the subdomain is a moat, not the auth.
- One static bundle served for every subdomain; the API resolves the account from the `Host` header.
- Rate limits + storage quotas per account. Registration is **invite-only, always**: accounts exist only when the operator mints one (see Onboarding). No public signup surface exists — which also deletes the signup-abuse problem outright.
- **Local dev without DNS or certs**: `*.localhost` subdomains resolve without any `/etc/hosts` entry and are treated as a secure context by browsers, so `CLOUD_BASE_DOMAIN=localhost` gives a full local dev loop — including WebAuthn/passkeys — against `http://<sub>.localhost:<port>`.

## Onboarding — invite → wizard → installed PWA

**The invitation IS the claim link.** Minting an invite (`cloud admin invite`) pre-provisions the account (subdomain + one-time claim token) and yields `https://<sub>.<base>/#claim=<token>` — delivered by email, link, or QR. There is no public signup page; the base host serves only a static landing/education page with an "invitations only" note. Unclaimed accounts expire and can be re-issued.

The claim link lands on a minimal, picture-first education wizard:

1. **Trust model in plain language** — "your data is encrypted on your device; this server only stores an encrypted bundle it cannot read, and rings your reminders." (When trials are enabled, the trial-keys caveat gets its own explicit consent screen — see Trial provider keys.)
2. **Create a passkey** (Face ID / fingerprint).
3. **Protect against device loss** — we *cannot* recover data, so offer, in order: confirm the passkey is synced (iCloud / Google Password Manager), add a second device now (QR flow), save the Emergency Kit. Skippable only through an explicit "I understand my data is unrecoverable if I lose this device" acknowledgment. Never ask for two passkeys on the *same* device — a second same-device platform passkey may silently replace the first (same RP + user handle) and dies with the device anyway.
4. **Install + notifications, platform-aware** — detect iOS/Android/desktop and show matching add-to-homescreen steps. Ordering is load-bearing on iOS: **install first, then enable push** — web push only works inside the installed app and the permission prompt needs a user gesture there.
5. **Telegram (optional, ships with C3)** — one tap on a Managed-Bots deep link creates the user's personal bot with a pre-filled dialog (see the Telegram section); explicitly skippable, with the channel-credential consent screen.

**The wizard is stateless — no stored step counter.** iOS Safari tabs and installed PWAs have separate storage, so locally-persisted progress dies at the install boundary. Every step is instead derived from observable facts: passkey exists (server credential list), loss-protection acknowledged (server-side flag), running installed (`display-mode: standalone`), push subscription exists (server). Opening the app in any context computes the first unmet step and resumes there; passkeys carry across the boundary via the platform keychain, so re-unlock works even though local caches don't transfer.

## Operating the cloud — admin surface

Deliberately PII-free: no names, no emails in listings (the optional URL-recovery email is the single stored exception). The admin sees pseudo-secret subdomains, claim status, created / last-sync timestamps, storage usage. Capabilities: mint an invite (pre-provision + print claim link/QR), re-issue a claim link, withdraw an unclaimed invite, delete an account, and `inspect <subdomain>` a single account's full debug view (devices, envelopes, sync state, push queue — see [docs/cloud-deployment.md](cloud-deployment.md) for the command reference and a sample output; the same output doubles as the ground-truth metadata-leakage illustration below).

`ponytail:` admin is CLI subcommands on the same binary (`cloud admin invite|list|inspect|reset-claim|revoke|delete`) — self-hosters have shell access, and it keeps the HTTP surface free of admin auth. A web admin page is a later nicety. Self-hosting the whole cloud stays a first-class goal: one binary + one compose block (see [docs/cloud-deployment.md](cloud-deployment.md)).

## Key hierarchy

**Passkey-only — no passphrases anywhere.** Full specification (exact formats, HKDF domains, ceremonies, security analysis): [docs/cloud-crypto.md](cloud-crypto.md).

```
passkey₁ ──WebAuthn PRF──► KEK₁ ──► envelope₁ ┐
passkey₂ ──WebAuthn PRF──► KEK₂ ──► envelope₂ ├──► DEK (random 256-bit) — encrypts all data
recovery code (160-bit, Emergency Kit) ──► KEK_rec ──► envelope_rec ┘
account inbox keypair (ECDH) — public half on server, private half in vault
```

- **DEK** is random, generated at signup; all records are AES-256-GCM under keys derived from it. Enrolling/removing a passkey = add/delete one envelope; data is never re-encrypted except on deliberate rotation.
- **Each device enrolls its own passkey** (device-local, non-synced passkeys fully supported) and gets its own DEK envelope via the WebAuthn PRF extension — biometric-gated, high-entropy, phishing-resistant. Synced passkeys (iCloud/Google) make one envelope serve a whole device fleet, but are never required.
- **Auth** to the API is standard WebAuthn assertion verification → per-device session tokens. PRF outputs are client-side only and never transmitted.
- **Recovery code** (printed in the Emergency Kit) wraps the DEK as the last-resort envelope; a domain-separated verifier lets the server rate-limit recovery attempts without learning anything that decrypts.
- **No low-entropy secret exists anywhere** — nothing server-side is offline-crackable, an upgrade over any passphrase design.
- **Inbox keypair**: lets the server (or the Telegram path) append events *sealed to the user* that only the client can read — see Telegram and MCP sections.

## Sync protocol

- **Encrypted oplog**: each write produces `{account_seq, device_id, record_type_tag, nonce, ciphertext}`. Server assigns the monotonic `account_seq`; clients push local ops and pull `since=<cursor>`. This mirrors the existing change-events + download-cursor design (`internal/store/settings`), with ciphertext bodies.
- **Conflict resolution is client-side** (server can't merge what it can't read): last-writer-wins per record with vector timestamps, same semantics the offline write queue (`SyncManager`) already implements for server mode.
- **Snapshots + compaction**: the server cannot compact ciphertext, so clients periodically upload a full encrypted snapshot; the server then drops ops below that seq. Bounds both restore time on a new device and storage growth.
- Local layer stays Dexie/IndexedDB (already vendored); plaintext lives only in memory and IndexedDB on the user's device, cloud copy is authoritative.

## Push relay & reminder lifecycle

The server is a **blind alarm clock**. It cannot compute "when is the next dose" — the client pre-computes and uploads the schedule:

1. Client (which has the domain logic + data) computes all reminders for the next horizon (default 30 days, configurable; ~KBs even at many-meds scale) and uploads `(fire_at, app_ciphertext)` rows, replace-all per sync — the same replace-all pre-schedule semantics as the Capacitor `Reminders` loop.
2. At `fire_at`, the server wraps `app_ciphertext` in standard Web Push encryption (RFC 8291) per registered subscription and sends. Two layers: the push services (FCM/APNs) can't read RFC 8291 payloads, and our server can't read the app layer.
3. The service worker decrypts the app layer if the vault key is available and shows a rich notification ("BP pill — 10 mg"); if the vault is locked, it shows a generic "Medication reminder". Notification tap deep-links via the existing `handleDeepLinks()` surface.
4. Every app open refreshes the horizon; multiple devices each hold a subscription; the relay prunes subscriptions on `410 Gone`.

**Settings entry point**: the main app's Settings screen (`web/static`, not just the `/unlock` shell) surfaces a cloud-only Notifications block (`features/settings.js`, gated on `window.__MEDTRACKER_CLOUD__`) with Enable/Disable and "Send test push" controls. It calls the same DOM-free `web/cloud/js/push.js` (`subscribe`/`unsubscribe`) helpers the shell uses, reached via `window.MedTrackerCloud.ctx` (published by `cloud-boot.js` once the vault is unlocked). The `/unlock` shell's own push screen remains for the pre-app flow (before the vault has ever been unlocked in the main app).

**Test push is a separate, immediate, this-device-only send** — distinct from the scheduled-reminder path above, which always fans out to every subscribed device. `sendTestPush(ctx)` (`web/cloud/js/reminders.js`) reads the current device's own subscription, encrypts a fixed test payload with the account NK, and `POST`s `{ endpoint, ct }` to `/api/push/test`. The handler (`internal/cloudserver/push.go`) resolves that endpoint to a subscription on the caller's account (404 if none/foreign), loads the account's VAPID keys, and calls `WebPushSender.Send` immediately — no relay tick, no schedule mutation, so it can never clobber the real replace-all reminder schedule. Same blind shape as the relay: the server sees only the endpoint (already-stored routing metadata) and the client-encrypted `ct`, never content.

**Dry-queue safety net**: if the user doesn't open the app within the horizon, reminders stop — and the server can't extend them. The server *does* know last-sync time (inherent metadata), so it sends a generic escalating warning push ("Open the app to keep reminders running — schedule expires in 5 days") and, if an email is on file, an email fallback. This is the E2EE analogue of the adherence safety net.

Known platform caveats: iOS web push requires the installed (home-screen) PWA and has occasional delivery quirks; Safari may drop subscriptions for long-unused web apps — the stale-sync warning doubles as the countermeasure.

**Per-account VAPID keys** (implemented, see `docs/plans/2026-07-05-cloud-c2-push-vapid-per-account.md`): each account gets its own VAPID keypair, generated server-side at invite provisioning. Push services bind a subscription to the `applicationServerKey` used at `subscribe()` time and reject sends signed with a different key — so a relay bug that misrouted account A's payload to account B's endpoint gets rejected by Apple/Google themselves, a third enforcement layer on top of RFC 8291 per-subscription encryption and NK app-layer encryption. The VAPID *subject* stays service-wide (it identifies the relay operator per RFC 8292, never the user — a per-user subject would leak identity to Google/Apple): `VAPID_SUBJECT` env, defaulting to `mailto:noreply@<CLOUD_BASE_DOMAIN>`, with `https://<CLOUD_BASE_DOMAIN>` substituted for Apple endpoints. Key rotation is unsupported by design — push services bind subscriptions to the subscribe-time key, so rotating would orphan every subscription for that account.

## Lost device / recovery — the reliability matrix

Zero knowledge means **no account reset**; recovery must be designed in, not bolted on. There is no passphrase to forget — recovery paths are other passkeys, other devices, and the recovery code.

**Emergency Kit** (mandatory, generated client-side at signup, before the app opens): a printable page/PDF with the instance URL, account id, recovery code, and a QR code encoding all three. Signup UX requires an explicit "I saved it" confirmation (1Password/Ente pattern). The server can optionally hold an email address for **URL re-delivery only** — never key material.

| Lost | Still has | Outcome |
|---|---|---|
| Phone | synced passkey (iCloud/Google) | New device asserts with the restored passkey; PRF unwraps the DEK. Non-event. |
| Phone (device-local passkey) | a second enrolled device | **Implemented (C0b)**: enroll replacement via QR hand-off / typed fallback ([cloud-crypto.md](cloud-crypto.md) Path B — Path A cross-device ceremony stays deferred); revoke the lost device from the surviving one. Key rotation on theft is a documented gap, not yet implemented. |
| Phone (device-local passkey) | Emergency Kit | **Implemented (C0b)**: recovery code unwraps DEK → enroll a new passkey → code force-rotated. Full restore. |
| Phone + forgot URL | email on file | Server emails the URL; then any row above applies. |
| All devices + all passkeys + Kit | nothing | **Data unrecoverable — by design.** Stated plainly in onboarding. |

Two cheap habits the onboarding pushes hard, because they collapse the loss matrix: (a) enroll a second device (a desktop browser tab counts — it gets its own passkey and envelope), (b) keep the Emergency Kit. A synced passkey does both jobs at once for users who accept iCloud/Google in the loop.

Ongoing safety: the client periodically (and after every schema migration) verifies it can decrypt the latest snapshot end-to-end — a backup that was never restore-tested is not a backup.

## Telegram (optional, BYO bot token)

**Status: C3a implemented** — managed-bot provisioning + BYO fallback + chat linking + consent screen + wizard step + test notification all ship in `cmd/cloud` (endpoints under `/api/telegram/*` and webhooks under `/tg/*`; token sealed at rest via HKDF-from-`SESSION_SECRET` + AES-GCM). Outbound reminder delivery and the sealed inbound mailbox (everything below the provisioning bullet) are **C3b**, still unimplemented. Real-Telegram empirics (managed-bot count limits, edited-username binding, user-revocation semantics) remain open and are gated to Post-Completion validation — the fake-API integration tests cover the contract but not Telegram's live behavior.

Zero-knowledge server vs. a chat bot is a real tension: the bot must exchange plaintext with Telegram, but the server can't read the vault. Resolution — the bot is a **channel**, not a brain:

- **One-tap provisioning via Managed Bots (Bot API 9.6, April 2026)** — no BotFather chat, no token pasting. One-time operator setup: create a manager bot and enable "Bot Management Mode" in BotFather's MiniApp. The onboarding step then shows a deep link `https://t.me/newbot/{manager_bot}/{suggested_username}?name=…`; the user taps it, confirms a pre-filled creation dialog, and owns a **personal** bot; the manager bot receives a `managed_bot` update and the cloud fetches the child bot's token via `getManagedBotToken` (`replaceManagedBotToken` for rotation). Account binding: the suggested username carries a random per-invite suffix the server remembers (or a `/start` pairing code fallback). Verified against the [official changelog](https://core.telegram.org/bots/api-changelog) + [features docs](https://core.telegram.org/bots/features); open items: undocumented managed-bot count limits and user-revocation semantics — test empirically at C3. Manual **BYO token stays as the fallback** for users who want a bot outside the manager's control (and it's the same server-side code path — a token is a token). Because Telegram never re-sends a lost `managed_bot_created` update, the pending page always exposes the BYO form and a "Start over" control (`POST /api/telegram/reset`, clears the `tg_pending` row → status `none`) — a lost bind update never strands the account waiting out the 1h pending TTL.
- **Opt-in with eyes open**: either way the bot token (and chat id) is a *channel credential*, not health data — server-visible by necessity, stored encrypted at rest with a server-side key, and clearly flagged in the UI as the one server-visible secret. Anyone holding it can send messages as that bot — the consent screen says exactly that.
- **Outbound = the same blind queue.** The pre-computed reminder queue grows a per-entry delivery flag (`webpush` / `telegram` / both) and, for Telegram entries, client-chosen plaintext at the user's chosen verbosity: generic ("Medication time") or detailed ("BP pill 10 mg") — the user decides what transits Telegram. Inline `Confirm` / `Snooze` buttons ride along.
- **Inbound = sealed mailbox.** Button callbacks and simple commands arrive at the server, which cannot apply them (it can't write ciphertext it can't produce). Instead it seals each event to the account's X25519 inbox public key with a server-side timestamp and appends it to a pending queue. On next open, the client drains the mailbox, decrypts, and applies through the normal domain layer — a `Confirm` tapped at 09:00 is recorded as taken at 09:00 even if the app opens at noon. (Push can nudge the SW to drain sooner when a device is reachable.)
- **Drain protocol (binding requirements for C3b).** The failure to design out: an event acked as processed that never landed in the vault. Rules:
  1. **Ack strictly after flush**: per event — decrypt → apply through the domain layer → wait for the resulting ops to be *confirmed flushed* to the sync log → only then delete from the mailbox. A client crashing mid-drain leaves the event queued for the next drain. Never batch-ack ahead of the flush barrier.
  2. **At-least-once + idempotent apply**: re-draining an already-applied event must converge, not duplicate — guaranteed by deterministic record ids (e.g. a `Confirm` targets `intake-<medId>-<slotUnix>`) + LWW. Free-text events (`/food two eggs`) get a deterministic id derived from the mailbox event id, so a re-parse after a crash overwrites its own earlier result instead of double-logging.
  3. **Concurrent drainers are expected, not an error**: several unlocked clients may drain at once — including physical devices sharing one synced passkey (iCloud/Google-synced credentials look like a single device to the server; sync correctness never keys on credential identity — cursors and pending queues are per-client-local). Mailbox delete is per-event; the first ack wins, a second delete of the same event is a no-op, and duplicate applies converge per rule 2.
  4. **Apply in server-timestamp order** within a drain, and backdate records from the sealed server timestamp (not drain time) — that's what makes the 09:00 tap record 09:00.
- **Free-text logging works through the same mailbox**: `/bp 120/80`, `/food two eggs`, `/weight 81.5` are sealed as raw text and parsed *client-side at drain time* by the same JS domain layer the app uses — including AI food parsing, since provider keys live in the vault and the drain runs on an unlocked client. The bot's immediate reply is necessarily generic ("saved — recorded next time you open the app"): the server can't confirm what it can't parse. Richer confirmation can arrive after drain, composed by the client (user-chosen verbosity).
- **Not supported in cloud mode**: conversational queries ("what's my BP trend?") — answering requires reading data, which only clients can do; a live reply would need an online unlocked client anyway, at which point the user has the app open. That stays a server-mode feature.

## BYO provider keys

All provider keys live as ordinary records inside the encrypted vault (synced across devices, invisible to the cloud). Calls go **directly from the browser** to the provider:

- OpenAI(-compatible) chat + vision endpoints support browser CORS; the existing first-run → integrations flow and `***`-masked settings UX carry over as-is.
- ElevenLabs conversational voice uses their browser SDK (WebRTC/WS) — replacing the server-side proxy handlers. **A voice agent without data access is useless** — operating on the user's data is its entire purpose. Cloud mode solves this with **SDK client tools**: tools registered at `startSession` execute in the browser session itself, backed by the in-browser domain layer — no MCP relay involved, and the availability constraint is trivially satisfied because the device is online and unlocked during its own call. **Status caveat**: this pattern was designed for server mode in `docs/plans/2026-05-18-elevenlabs-dynamic-mcp-client-tools.md` but **never implemented or verified** — no `clientTools` code exists in the repo; today's server-mode voice runs on a manually dashboard-configured MCP server. Validating client tools end-to-end is a prerequisite spike for cloud voice, ideally proven in server mode first where the plan already exists. ElevenLabs' cloud sees tool names, results, and transcripts — inherent to any cloud voice agent; under BYO keys that's strictly user↔ElevenLabs, the zero-knowledge server sees nothing. Open item: agent provisioning (tool definitions must exist on an agent) — programmatic via the ElevenLabs agents API where it covers tool config, dashboard instructions as fallback.
- **Food DB is the exception to "bring your own": too niche to ask users about.** The operator hosts an instance and cloud mode points at it silently as the built-in default — no setup step, no wizard mention, no expiring trial, no BYO nagging (it's excluded from the trial-pool CTA mechanics below). The URL stays visible-but-unadvertised in Settings → Integrations for the rare user who wants their own (Open Food Facts and self-hosted instances are CORS-open). Honest note: food/barcode lookups necessarily reveal query terms to whoever hosts the DB — same exposure as public Open Food Facts, no health-record content.
- The existing graceful degradation contract is unchanged: no key → feature shows its "configure to enable" empty state; key added → capability appears immediately.

The pricing/consent story is clean: AI costs are the user's own, on their own keys; the cloud never proxies (and so never sees prompts, photos, or voice). The trial-keys pool below is the one deliberate, consent-gated exception.

## Trial provider keys (pooled, metered)

New users get AI features working immediately from a pooled set of operator keys (DeepSeek/OpenAI-compatible chat + vision, ElevenLabs) for a trial period — then bring their own keys, or the trial features degrade to their existing "configure to enable" empty states with a bring-your-own-key CTA. No hard account gate.

Design rules:

- **Pool keys never reach the device** (one extraction drains the pool). Two mechanisms instead:
  - **OpenAI-compatible chat/vision: a metered relay** that mimics the OpenAI API surface so the client is unaltered — trial mode is just the default base URL pointing at the relay with session auth; BYO is a settings change to the provider's real URL. Per-account quotas (requests/tokens per day), per-feature budgets, a global circuit breaker — the demo-mode rate-limit pattern this repo already has.
  - **ElevenLabs: server-minted signed session URLs** (the existing `get_signed_url` pattern from server mode) — the cloud mints the session with the pooled key; audio then flows device↔ElevenLabs directly and never transits our server.
- **The honest carve-out, stated on its own consent screen**: on trial keys, AI request content (food photos, prompts; ElevenLabs conversations under the *operator's* provider account) is visible to the relay in transit and to the provider under the operator's account. Nothing is stored and relay bodies are never logged — but it is a real, explicit downgrade from the BYO posture, and the user chooses it or enters their own keys on day one. The vault stays E2EE regardless; only in-flight AI content is affected.
- **Sequencing**: the relay ships only when the PWA has AI features to call it — alongside C2 (see phasing), not in C0.

Implementation (med-eas.25): trial keys are `TRIAL_*` envs on `cmd/cloud` (see [environment.md](environment.md#cloud-service-cmdcloud)), loaded into `cloudserver.TrialConfig`. Two account-authenticated proxy routes on the account subdomain: `POST /api/trial/openai/chat/completions[?vision=1]` (body forwarded verbatim, `model` forced server-side to the trial model) and `GET /api/trial/elevenlabs/signed-url` (server-minted with the operator's shared agent). Client precedence: vault BYO key (browser-direct, unchanged) → trial proxy route → "set your key" error. Availability is advertised to the client as booleans only (`<meta name="medtracker-trial-ai|medtracker-trial-voice">`); no key, URL, or model ever appears in a response, meta tag, or log. Per-account sliding-window rate limit (`TRIAL_RATE_PER_MIN`, default 10/min) shared across both routes; on limit: `429 {"error":"trial_rate_limit","retry_after_seconds":60}`. Unconfigured routes return `503 {"error":"trial_not_configured"}` and the client degrades to today's pure-BYO behavior.

## MCP

Three tiers, because "MCP" and "server that can't read data" genuinely conflict — the server cannot answer a single registry op. The user's suggestion (server proxies MCP *to client devices*) is the right shape; the question is who can read the frames.

**Tier 0 — MVP: no MCP in cloud mode.** Server-mode installs keep the full registry/executor. Cloud mode ships without it.

**Tier 1 — blind relay + local shim (preserves zero knowledge). PoC implemented**, see
`docs/plans/2026-07-05-cloud-c4-poc-mcp-blind-relay.md`. For Claude Desktop / Claude Code,
which can run a local stdio MCP server:

```
Claude Desktop ──stdio── cmd/mcpshim ──wss:// ciphertext ──► cloud relay ──► user's device (PWA)
                          (holds a pairing key)  (blind pipe)   (decrypts, runs op, answers)
```

- **The shim is a Go binary** (`cmd/mcpshim`, built from the repo — `go build ./cmd/mcpshim`),
  not an npm package; it uses the already-vendored `modelcontextprotocol/go-sdk` stdio
  transport and the `internal/mcpshim` package for dial/crypto/request-correlation. No
  config file — reads `MEDTRACKER_MCP_CODE` from the environment, reconnects on drop, logs
  to stderr only.
- **Pairing code**: the PWA's Settings → "Connect Claude" screen POSTs `/api/mcp/pairings`
  (session-authed) to mint a `{pairing_id}`, generates 32 random key bytes client-side, and
  shows a one-time code `mtmcp1.<base64url(json{relay_url, pairing_id, key})>` — the key
  never touches the server. The user pastes the code into the shim's `MEDTRACKER_MCP_CODE`
  env var. "Disconnect" issues a DELETE and drops the stored key (kept in a vault record
  `mcppairing` so any unlocked device can answer).
- **Frame format** (both directions): `nonce(12) ‖ AES-GCM(key, payload, aad="mt/v1/mcp"‖pairing_id)`,
  payload = one JSON-RPC MCP message. The relay (`internal/cloudserver/mcp_relay.go`) pipes
  opaque binary frames between the shim leg (`GET /api/mcp/relay/shim?pairing=<id>`,
  authenticated by possession of the single-use pairing id) and the device leg
  (`GET /api/mcp/relay/device`, authenticated by the existing session cookie) — no
  inspection, no buffering beyond one in-flight frame per direction, 64 KiB frame cap,
  closes both ends when either drops. Pairings are in-memory (die with process restart) and
  currently one shim + one device per pairing.
- The device answers using the *same operation catalog semantics* as `internal/mcp/registry`,
  via a hardcoded PoC catalog in `web/cloud/js/mcp-responder.js` (`bp.*`, `weight.*`,
  `notes.*`) — `mcp_help` (catalog + `usage_protocol`) and `mcp_call` (executed by the
  in-browser domain layer against local data, same construction path as `apishim`). The full
  catalog generated from `internal/mcp/registry` (with drift guard + ported-set filtering)
  is full-C4 scope, not the PoC. `mcp_execute` (Python) has no browser sandbox and stays
  parked, as does its Pyodide alternative.
- **The honest constraint: a device must be online with an unlocked vault.** A phone with the PWA backgrounded is not reliably reachable (iOS SW execution on push is too constrained to serve queries silently). Realistic availability = a desktop tab left open, or an old phone plugged in at home with the PWA foregrounded — at which point the user has voluntarily re-invented a tiny server, but it's *their* device, zero config, and the guarantee holds. When no device is online, the shim's tools return an actionable MCP error naming the E2E architecture and telling the user to open and unlock their app.
- **PoC ceilings** (each `ponytail:`-marked in code): in-memory pairings, single pairing per
  account, hardcoded catalog, no QR pairing, no packaged shim binary/release artifact.

**Tier 2 — hosted-relay convenience mode (explicit consent, reduced guarantee). PoC implemented**, see
`docs/plans/2026-07-06-cloud-c4-poc-remote-mcp-endpoint.md`. claude.ai's remote MCP cannot run a shim, so the server runs the shim itself: it dials the relay on the account's behalf and exposes a plain streamable-HTTP MCP endpoint that hosted clients connect to directly. The server therefore terminates the client's MCP connection and sees requests/responses **in transit** (never stored); vault data at rest stays E2EE. This is a deliberate, per-account, clearly-labelled downgrade switch, off by default.

```
claude.ai / ChatGPT ──https── cloud server ──wss:// ciphertext ──► cloud relay ──► user's device (PWA)
                      (sees traffic in transit) (holds pairing key, at rest while enabled)
```

- **Connecting claude.ai / ChatGPT**: Settings → "Claude connector" → Devices → "Claude connector" section → **Enable** on the remote connector. A consent dialog spells out the downgrade (the server can read requests/answers while relaying; nothing is stored; the pairing key is kept server-side, at rest, until Disconnect). Confirming mints a pairing (same `mcp-pairing.js` as Tier 1) and POSTs the pairing code to `POST /api/mcp/remote`, which returns a one-time 6-character token (`xxx-xxx`, Crockford base32, shown once). The devices page then shows the connector URL `https://<account-subdomain>/mcp/<token>` with a copy button and per-client instructions (claude.ai: Settings → Connectors → Add custom connector, paste the URL; ChatGPT: Settings → Connectors → Add MCP, paste the URL). Keep an unlocked PWA tab open somewhere — that's what actually answers queries. The URL is stable across server restarts/deploys and changes only on Disconnect + re-enable (which rotates the token). Disconnect tears down the hosted client and the URL stops working immediately.
- **Auth is a capability URL, not OAuth.** The 6-char token (~30 bits) is short enough to type/paste reliably across devices; the real security boundary is a per-account failed-token throttle (100 failed attempts/min, then 429 backoff) rather than token entropy — brute-forcing the token space past that cap takes decades. Constant-time compare; wrong or revoked tokens 404 without revealing whether the account exists. Full OAuth 2.1 + dynamic client registration is out of scope for this PoC.
- **Mutually exclusive with Tier 1 per account** — the relay's PoC ceiling is one pairing per account, so enabling the remote connector disconnects a local shim pairing (and vice versa). The devices page states this inline.
- **Set-up-once-and-forget**: enablement is persisted (`internal/cloudstore` migration adding `mcp_remote`), so the token and connector URL survive process restarts — on startup the server re-registers each enabled account's pairing with the (in-memory) relay and restarts its hosted shim client. The honest cost of this convenience: the pairing key now sits at rest in the server DB while remote mode is enabled, not just in memory during a live relay session.
- **Token-in-path access-log caveat** (same shape as `initData` in [docs/sse-traefik.md](sse-traefik.md#initdata-exposure-in-traefik-access-logs)): the token travels in the URL path (`/mcp/<token>`), so Traefik's default access log writes it to disk on every request. The leak is bounded by the same throttle that bounds guessing it, but treat Traefik logs as sensitive for this route and consider the same mitigations (drop query/path logging for `/mcp/*`, or a redaction filter) if that's a concern for your deployment.

## The client: porting the domain layer

This is the dominant cost of the proposal and it must be stated, not hidden: the Go domain layer (~9.1K lines), store semantics (~9.8K), scheduler (~2.8K), and the validation slice of the HTTP handlers must be reimplemented in JS, and ~33K lines of Go tests re-earned. Two structural decisions keep this tractable and stop the fork from rotting:

1. **Port behind the `/api/*` contract, keep the UI byte-identical.** The existing frontend already speaks only `/api/*`. Cloud mode inserts a fetch shim (SW or wrapper around `apiCall`) that routes `/api/*` to an in-browser router → JS domain services → Dexie stores. `web/static` feature code, the design system, offline plumbing, and all Vitest feature suites are shared verbatim with server mode. The fork is confined to a `web/static/js/localdomain/` layer; the HTTP contract becomes the enforced seam (the same contract-first contingency `docs/local-mode.md` names for a `gomobile bind` fallback).
2. **Cross-implementation contract tests.** A shared fixture corpus (seed ops → API call sequence → expected JSON responses) runs in CI against both the Go server and the JS domain layer. A behavior change that lands in one implementation fails the other's contract run. This is the drift alarm that makes double maintenance survivable; without it, this proposal should be rejected.
3. **Write the JS layer runtime-agnostic (design constraint for C1, cheap now, expensive to retrofit).** Domain services must depend on injected ports — a storage port (Dexie in the browser; something else elsewhere) and a crypto port — never on browser globals directly. This keeps the **unification endgame** open: the double maintenance is intended as a *migration cost, not a permanent tax*. Once C2 reaches parity, bot mode can host the same JS domain layer server-side — preferred embedding is **goja** (pure-Go JS engine: keeps `CGO_ENABLED=0`, the single binary, and the mobile cross-compile; Node sidecar as fallback if goja performance disappoints) with a SQLite-backed storage port. The migration proof is **shadow mirroring** (C6): the Go handler serves the response while the JS layer computes it in parallel and divergences are logged; per-domain flips happen only after the diff log stays quiet on real traffic. End state: one domain implementation (JS), Go keeps transport (bot, HTTP, push, scheduler ticks, MCP).

Port order tracks user value: meds + intakes + reminder computation first (C1 below), then the remaining domains.

## Migrating an existing server-mode install

Migration is a special case of the general **no-lock-in guarantee (C2e)**: one canonical one-user-all-domains JSON format (meds + intake log, BP, weight, food, workouts, vitals, sleep, diary, tz history, settings), exportable **and** importable in **both** modes — a full 2×2 matrix, so any instance pair can migrate in either direction and a plain file on the user's disk is always an exit door.

1. **One shared Settings → Import/Export screen** in `web/static` serves both modes — no CLI. In bot mode, export is `GET /api/export` (plaintext JSON over the authed session) and import is a bulk `POST /api/import`; in cloud mode both sides run entirely client-side against the unlocked vault. The zero-knowledge property forces the cloud arrangement — plaintext can never be uploaded, so data must enter through an unlocked client that encrypts it locally — and bot mode simply reuses the same screen with HTTP instead of the records port.
2. **Optional password protection via age, browser-side in both modes.** The downloaded file is plaintext JSON, or — if the user supplies a passphrase — an [age](https://age-encryption.org) scrypt-recipient file (`.json.age`, decryptable anywhere with `age -d`). Encryption/decryption happens in the browser via a vendored single-file `typage` build; the server never sees the passphrase or performs any backup crypto in either mode. No custom crypto layer.
3. **Import flows through the domain services, not raw table writes.** Records enter via the same validation as live writes, so an import can't create states the app couldn't. Cloud-side, bulk lands as **a snapshot, not an op flood**: the importer writes local Dexie state and uploads one encrypted snapshot (the C0c compaction path), then normal op-based sync resumes; reminder schedules recompute client-side from the imported plans.
4. **Round-trip is the contract.** bot export → cloud import → cloud export → bot import must be identity (modulo id/timestamp normalization); a CI test enforces it so the two implementations of the format can't drift.

## Metadata leakage summary

| Signal | Who learns it | Mitigation |
|---|---|---|
| Reminder timing | cloud | inherent to a blind alarm clock; content stays sealed |
| Subdomain (≈ account existence) | network observers (DNS/SNI), cloud | wildcard cert+zone keep it out of CT/zone files; DoH/ECH close the rest over time |
| Sync cadence, blob sizes, IPs | cloud | standard for any sync service; no content |
| TG bot token, chat id, TG message text at user-chosen verbosity | cloud + Telegram | opt-in; generic-text mode; sealed inbound |
| MCP query content | nobody (tier 1) / cloud in transit (tier 2) | tier 2 off by default, explicit consent |
| MCP frame sizes + timing | cloud (tier 1) | inherent to a blind relay; pairing ids only, content stays sealed |
| MCP pairing key at rest (tier 2 only) | cloud, while remote mode is enabled | opt-in only; deleted on Disconnect; token itself is never logged (mind Traefik access logs — it travels in the URL path) |
| Food/barcode search terms | operator's food-DB instance (default) | same exposure class as public Open Food Facts; endpoint swappable in settings |
| Drug-name search + interaction queries | RxNav (NIH), from the client IP | direct-from-browser by design (never proxied through the cloud operator); same exposure class as food-DB search; nothing persisted beyond `rxcui`/`normalized_name` on the med record |
| Meal descriptions + photos (AI parsing) | the user's own OpenAI(-compatible) provider, direct from the client | BYO key + BYO consent — never proxied through the cloud operator; same never-see guarantee as the vault keys that authorize it |

**Ground truth, not a claim**: `cloud admin inspect <subdomain>` (see
[docs/cloud-deployment.md](cloud-deployment.md#5-admin-commands)) is the
read-only debug view over an account's health-data-bearing surfaces —
devices, DEK envelopes, the sync log, and the push queue — reading the same
tables the server queries at runtime and printing sizes/timestamps/counts/
tags, never plaintext, nonces, MACs, or ciphertext bytes. It is *not* a dump
of every column an operator with shell access could `sqlite3` out: purely
account-lifecycle metadata that carries no health signal — claim expiry,
loss-ack, recovery-attempt counters (`recovery_auth`), transfer slots, and
stale-sync warning timestamps — lives in other tables and is out of scope
here. Sample output against a seeded account:

```
$ ./cloud admin inspect amber-falcon-8k3q9x
account: amber-falcon-8k3q9x
  created: 2026-06-05T11:56:34Z
  claimed: true

devices:
  ref       transports       synced  sign_count  created               last_unlock
  cGhvbmUt  internal,hybrid  true    43          2026-06-05T11:56:34Z  2026-07-05T11:56:34Z
  bGFwdG9w  internal         false   7           2026-06-15T11:56:34Z  never

envelopes:
  ref       v  size
  bGFwdG9w  1  412B
  cGhvbmUt  1  412B

sync:
  ops: 140
  seq range: 501..640
  last append: 2026-07-05T05:56:34Z (device cGhvbmUt)
  record types:
    bp: 93
    weight: 47
  snapshot: seq 500, 47.1KiB, written 2026-07-05T05:56:34Z

push:
  subscriptions: 1 active, 0 disabled
  pending scheduled: 1
  next fire: 2026-07-05T12:41:34Z
```

This is the devices/envelopes/sync/push view: two devices identified only by
a short credential prefix (not names), ciphertext sizes, a sync op count +
record-type histogram (`bp`/`weight` — the type tag is plaintext metadata,
not new leakage), and push queue state. No health data, no keys, no message
content.

## C1 implementation notes

C1 shipped as **BP + weight through the real `web/static` frontend**, not medications as originally scoped below — a deliberate reorder (see `docs/plans/2026-07-05-cloud-c1-bp-weight-real-frontend.md`) because BP/weight's domain logic (AHA category buckets, EMA trend, daily-weighted stats) is small, pure, and self-contained, making it the cheapest full vertical slice to prove the shim architecture end-to-end.

- **`web/domain/`**: runtime-agnostic ES modules (`bp.js`, `weight.js`) with injected ports (`records`, `now`, `timeZone`) — no `window`/`document`/`fetch`/`indexedDB`/`navigator`, enforced by `architecture.domain-purity.test.js`. This is the C6 portability seam: goja can host the same modules server-side later.
- **The shim (`web/cloud/js/apishim.js`)**: `installApiShim(ctx)` assigns `window.offlineAwareApiCall`, the single slot `web/static/js/core/api.js`'s `apiCall` already delegates through — no frontend call sites changed. A route table maps `/api/bp*` + `/api/weight*` to the domain modules; every other `/api/*` path either returns a stub (boot-path endpoints the frontend calls unconditionally — `/auth/status`, `/api/bootstrap`, reminder status, settings reads) or rejects with a console-warned "unknown route" — that warning list is the deliberate C2 scoping mechanism (see Post-Completion in the plan).
- **Record types** synced via the C0c oplog (`recordsPort(ctx)` = `{list, put, del}` over `sync.js`'s generic `writeRecord`/`listRecords`): `bp` (one per reading), `weight` (one per log), `bpgoal` (singleton, fixed recordId), `weightgoal` (append-only history, mirrors the `weight_goals` table).
- **Cloud boot path**: `cloud-boot.js` runs before `app.js`, sets `window.__MEDTRACKER_CLOUD__`, warm-unlocks via the LDK cache, installs the shim, and kicks `pullOnOpen`. `app.js`'s `checkAuth()` short-circuits on that flag exactly like the mobile build's `__MEDTRACKER_BOOTSTRAP__` (CLAUDE.md rule 11) — the Telegram login screen never renders in cloud mode. No change stream (SSE/poller) in cloud mode; repaint is optimistic-write + pull-then-`invalidateTags`.
- **Serving**: `cmd/cloud` now serves the full `web/static` app (embedded FS reused from `internal/server`) on account subdomains; the unlock/claim/recovery shell moved to `/unlock` (`/claim`, `/recover` still rewrite to `signup.html`).
- **Contract test strategy**: no new unit tests. The existing BP/weight Vitest feature suites are re-run under a shim-mode harness (in-memory records port, no crypto/IndexedDB) as additive `cloud.shim-contract.*.test.js` files — a divergence there is a Go↔JS drift bug, not a gap needing new test scaffolding.

## C2a implementation notes

C2a shipped **diary/notes, settings (incl. the Integrations BYO-provider-keys screen), and the vitals read side** — the three cheapest remaining domains, following the C1 pattern exactly. Plan: `docs/plans/2026-07-05-cloud-c2a-diary-settings-vitals.md`.

- **`web/domain/`**: `notes.js` (`createNotesDomain({records, now})` — `list`/`create`/`remove`), `settings.js` (`createSettingsDomain({records, now})` — singleton records for general settings, feature flags, tab order, food targets, and integrations keys), `vitals.js` (`createVitalsDomain({records, now, timeZone})` — `overview()`/`sleep()` reproducing `internal/domain/vitals.go` + `health_handlers.go` aggregation). Same purity guard, same injected-port shape as `bp.js`/`weight.js`.
- **Record types**: `note` (one per entry), `settings`/`features`/`taborder`/`foodtargets`/`integrations` (singletons, fixed recordId — the C1 `weightunitpref` pattern), and the vitals streams — `sleep` (one per session), `daystats` (one per day), `hrsample`/`spo2sample`/`stresssample` (**day-batched**: one record per stream-day, body `{day, samples: [{date_time, tz_offset, value[, info]}]}`, to keep a 90-day Mi-Band history from exploding the oplog into ~9k individual records). `web/domain/vitals.js` expands the batched arrays in-memory before bucketing/averaging.
- **Integrations keys move into the vault**: the OpenAI/food-DB/ElevenLabs provider keys the Settings → Integrations screen manages are now an encrypted `integrations` record instead of the server-mode settings-table row — strictly better than server mode (E2EE at rest), and the prerequisite for C2c's client-side food AI. No consumer wired yet (client-side AI calls are C2c) — this task only makes the keys live encrypted. Bodies are never logged; the shim's unknown-route warn logs only paths.
- **Feature-flag clamp**: effective flags = (stored `features` record ∨ defaults) ∧ `PORTED_SET` — a user can never toggle on a domain the shim can't yet serve, in both the nav and the Settings toggle list.
- **Vitals is empty until C2e**: ingestion (mi-band webhook, sleep import) has no cloud path yet; the overview/sleep aggregates render correct empty-state shapes and populate once C2e's migration importer lands historical records.
- **Toy notes retired**: the C0c cloud-shell demo screen (`web/cloud/js/notes.js`'s UI, `recordType 'note'` with `{text, deleted}` bodies) is replaced by the real diary feature through `web/static`; `sync.js`'s generic record functions are unchanged and reused.
- **Contract test strategy**: same as C1 — additive shim-mode Vitest suites (`cloud.shim-contract.notes/settings/vitals.test.js`) re-running the real feature UI paths against an in-memory records port, plus a vitals fixture asserting aggregates match the Go handler semantics for a seeded week of samples.

## C2b implementation notes

C2b shipped **medications + the intake state machine + tz handling + reminder compute-and-upload** — the app's core feature and largest hard-logic port, following the C1 pattern. Plan: `docs/plans/2026-07-05-cloud-c2b-medications-tz-reminders.md`.

- **`web/domain/`**: `medschedule.js` (pure `ValidSchedule`/`ScheduleConfig` parsing + `PlanDoses` fire/forecast, doses/day + low-stock math), `medications.js` (`createMedicationsDomain({records, now, timeZone, rxnorm})` — CRUD, restock, low-stock list), `intake.js` (the intake state machine — confirm/skip/log-past/bulk-update/cancel/delete/snooze/trigger-next/next-intake, due-dose materialization), `tzplan.js` (ported `GeneratePlan` + shift-policy caps, suggestion flow, one-record plan lifecycle), `reminders.js` (pure horizon computation: forecast slots + re-reminds). Same purity guard, same injected-port shape as `bp.js`/`weight.js`/`vitals.js`.
- **Record types**: `medication` (server field names incl. `rxcui`/`normalized_name`/`tz_shift_policy`), `intake` (deterministic id `intake-<medId>-<slotUnix>` for scheduled doses — the multi-device dedup mechanism; random id for manual log-past), `restock` (one per restock event), `tzplan` (one record per proposed/active shift — steps live inside the record, no pre-materialization into intake rows), `medreminderpref` (singleton, reminder enable/disable).
- **No pre-materialized future intake rows, one-record tz plans, inventory-with-flip**: the three deliberate simplifications vs. the server (see the plan's Overview + Technical Details) — dose targets are computed on the fly from `PlanDoses` and materialized only when due or acted on; a tz plan is one vault record instead of the server's 7-status/SQL-suppression machinery; inventory decrement/increment happens inline with the status flip instead of split across a store/handler boundary. All are safe specifically because there's exactly one user per vault (see Technical Details in the plan for the LWW/derivability argument).
- **RxNorm direct-from-browser** (`web/cloud/js/rxnorm.js`): the three RxNav lookup calls run from the browser, never proxied through the cloud operator — see the metadata-leakage table above. The interaction-list endpoint has been decommissioned by NLM (403s on every call); `checkInteractions()` degrades to `[]` on any non-OK response, so med save still succeeds without an interaction warning.
- **Reminders = compute-and-upload**: `computeReminderHorizon` (in `reminders.js`) walks a 7-day window one day at a time (working around `PlanDoses`'s "today + tomorrow" forecast cap without touching `medschedule.js`), producing `{fire_at_unix, text}` entries; the shim debounce-recomputes and PUTs the replace-all schedule via the existing C0c `pushSchedule` after intake/med/tzplan mutations and on unlock.
- **Shim timers**: due-dose materialization and tz-plan status refresh run once on shim install and then on a 60s interval owned by the shim (not `web/domain/`), matching the plan's "the timer lives in the shim" rule.
- **Contract test strategy**: same as C1/C2a — additive shim-mode Vitest suites (`cloud.shim-contract.meds/meds-history/tz-plan.test.js`) re-running the real meds/meds-history/tz-banner feature UI paths against an in-memory records port, plus a reminder-horizon test asserting the uploaded schedule shrinks after a confirm.

## C2c implementation notes

C2c shipped **food logs + products + stats + meals, direct-from-browser AI parsing (text + photo), and direct-from-browser food-DB search with an operator default** — the first C2 slice where an external provider is called straight from the client. Plan: `docs/plans/2026-07-06-cloud-c2c-food-client-ai.md`.

- **`web/domain/`**: `food.js` (`createFoodDomain({records, now, timeZone, foodDb})` — log CRUD with the server's side effects (name-keyed product upsert with COALESCE-preserve + usage bump), ported `CalculateMacros` (int truncation, calories recomputed as `4*carbs + 4*protein + 9*fat`, never trusted from input) and `groupFoodLogs` (hour-bucket meal naming, 30-min same-day clustering, multi-day calendar grouping), window-SUM stats, products list/sort/filter, `createMealFromLogs`), `foodai.js` (`createFoodAIDomain({aiClient, foodDomain, now})` — `MealSystemPrompt`/`MealPhotoSystemPrompt`/`mealSchema` copied verbatim from `internal/ai/openai.go` with a pinning comment, `convertParsedMeal` validation, auto-create-log + `{status:"created", items, failed}` response shape identical to the Go handlers). Same purity guard, same injected-port shape as the other C2 domains; `foodDb` is an injected remote-search port (browser impl in `web/cloud/js/fooddb.js`, fakeable in tests).
- **Record types**: `foodlog` (frozen total macros, `eaten_at` UTC-normalized like the server) and `foodproduct` (per-100g floats, `usage_count`, `is_meal`, `total_weight_g`, unique per name — `is_meal` on a log is resolved from the referenced product at read time, matching the server's JOIN).
- **Browser AI client** (`web/cloud/js/aiclient.js`): chat completions with strict `json_schema` response_format + the response_format-rejection fallback + fence stripping, ported from `internal/ai/openai.go`; photo path converts the picked File to a data URL (8 MB cap, `image/*` sniff) and sends the two-part content array; vision credentials fall back to text-provider credentials. Reads keys via a narrowly-named unmasked reader (`readIntegrationsUnmasked` in `web/domain/settings.js`) consumed module-to-module — never reachable via any shim route; the masked `getIntegrations` shape is the only one any `/api` route returns.
- **`food_intake_enabled` → key-presence collapse**: the server-side feature flag that gates the two AI handlers has no cloud analog; in cloud mode "AI available" simply means "an OpenAI key is present in the vault". Missing key = no provider call attempted, AI entry points return an "add a key in Settings → Integrations" hint the UI renders inline.
- **Four guarded bypass sites**: `features/food/photo.js`, `features/food/log.js` (description flow), `features/food/products.js` (search), and `features/food/ai-undo.js` each get a `__MEDTRACKER_CLOUD__` branch — the only frontend call sites that used raw `fetch` instead of `apiCall`/`offlineAwareApiCall`. The bot-mode path is byte-identical in all four. Photo and description route to the cloud AI module; search delivers local results immediately and remote results in a second pass (no NDJSON stream — that framing has no shim equivalent, see Technical Details in the plan) through the same render callbacks + `AbortController` semantics; ai-undo's delete routes through `apiCall` to hit the shim instead of a raw DELETE.
- **Food-DB direct + operator default**: `web/cloud/js/fooddb.js` searches/looks up barcodes with `X-API-Key` from the vault (may be empty) against `integrations.food.url` when set, else the operator default. The operator default is `CLOUD_FOOD_DB_URL` on `cmd/cloud`, injected into the served page via `cloud-boot.js`'s config path — a URL, not a secret. Absent env = remote search silently degrades to local-only, never an error. Settings → Integrations shows the effective default as the food-URL field's placeholder (visible-but-unadvertised override). See [docs/cloud-deployment.md](cloud-deployment.md) for the CORS requirement this depends on.
- **Metadata leakage**: meal descriptions/photos go straight to the user's own AI provider (BYO consent, never proxied); food/barcode search terms go to the operator's food-DB instance by default (same exposure class as the pre-existing Open Food Facts row) — see the leakage table above.
- **Contract test strategy**: same as C1/C2a/C2b — additive shim-mode Vitest suites re-running the real food/products/AI feature UI paths against an in-memory records port plus a faked provider/food-DB fetch at the boundary (log add/edit/delete + grouping, stats strip, products list/edit/delete + meal-from-logs, search local+remote, description/photo AI happy path + fallback + missing-key hint + oversized-photo rejection), plus a grep-assertion that no shim route response contains a raw stored key.

## C2d implementation notes

C2d shipped **workouts** — groups/variants/exercises/exercise-library CRUD, the next-workout resolver + rotation engine, session lifecycle, exercise logs, stats, and the mi-band read/edit side — the most relational port so far (7 entity types, a rotation state machine, lazy session materialization). Plan: `docs/plans/2026-07-06-cloud-c2d-workouts.md`.

- **`web/domain/workout.js`**: `createWorkoutDomain({records, now, timeZone})` — groups/variants/exercises/library CRUD (`days_of_week` JSON-array round-trip, library-name uniqueness, delete cascades mirroring the handlers); `getNext` (three-priority resolution — P0 active-today, P1 expired snooze, P2 two-week tz-aware scan with rotation-cursor variant selection — lazily creating the `pending` session through the records port); `advanceRotation`/`initializeRotation` (circular by `rotation_order`, reset-on-invalid, best-effort on complete/skip/next-variant); session lifecycle (start/snooze/skip/preskip/cancel-preskip/`setSessionStatus`/ad-hoc create/`deleteSession`); exercise logs (non-negative validation, `logged_at` bump only while placeholder, propagate-to-schedule for non-library sources, auto-promote at `sets_completed>=1`, the `(session_id, exercise_id, source)` uniqueness guard); `SessionView`/`SessionDetails`; stats (30-day totals/completion rate, 12-week Monday heatmap, `top_exercises`). Same purity guard, same injected-port shape as the other C2 domains.
- **Numeric-id strategy** (Decision 1 in the plan): unlike `medications.js` (where the recordId itself doubles as the numeric id), workout records carry a separate client-minted numeric `id` field in the body — `web/domain/workout.js`'s header documents why (sessions need a deterministic recordId for multi-device dedup, while frontend sentinels like `sessions.js:559`'s `log.id > 0` and the `group_id == -1`/`variant_id == -1` ad-hoc markers need a plain positive number). Foreign keys store those numeric ids; lookups always re-resolve "record of type T whose body.id == n" against the live records port, so a stale id from a losing LWW write self-heals on the next list() rather than needing a migration.
- **Deterministic recordIds where multi-device dedup matters**: `session-<groupId>-<scheduledDate>` for schedule-materialized sessions (ad-hoc sessions get random recordIds — no natural slot); `rotation-<groupId>` for the per-group rotation cursor. Two devices racing `getNext` for the same group+date write the same recordId; LWW picks one body and both converge.
- **Record types**: `workoutgroup`, `workoutvariant`, `workoutexercise`, `exerciselibrary`, `workoutsession`, `exerciselog`, `workoutrotation` (one per group), `miband` (fields per the enriched GET shape incl. `source_start_ms` + tz offset for local-time rendering; list with limit, PATCH diff-semantics over the six editable fields, DELETE → tombstone). Bodies use server JSON field names verbatim.
- **The `apiCallDirect` wrapper** (`web/cloud/js/cloud-boot.js`): three frontend call sites (`groups.js:55`, `next-card.js:179`, `stats.js:40`) plus `today-loader.js:154`'s `workout_next` SWR fetch bypass `offlineAwareApiCall` and call `window.apiCallDirect` directly. Cloud-boot wraps `window.apiCallDirect` to route `/api/*` paths into the same shim dispatch as `offlineAwareApiCall`, so all four call sites work with zero `web/static` edits; non-`/api` URLs pass through to the original implementation untouched.
- **`workout_next` bootstrap cache**: neither the native nor shim `/api/bootstrap` bundles a `res.workout` key, so cloud-boot warms the Today card's cache directly — one `apiCallDirect('/api/workout/sessions/next')` call piped through `cacheApiSnapshot('workout_next', ..., ['workout'])`, the same mechanism `applyBootstrapPayload` uses for bp/weight.
- **Route table** (`web/cloud/js/apishim.js`): the query-param CRUD style (`/create`, `/update`, `/delete`, `?id=`) is preserved verbatim rather than folded into a combined GET+POST base path like bp/weight/food. Intentionally left unmapped, falling through to the unmapped-route warning (a code comment in the shim lists them so the warn stays interpretable): `rotation/state`, `rotation/initialize`, `exercises/unique`, `sessions/schedule`, the legacy `session/snooze`/`session/skip` compat routes, and the external Mi Band Notify webhook — all MCP/bot-only per the plan's scope decision.
- **`workout` joins `PORTED_SET`**: the feature-flag clamp (C2a) now serves workouts end-to-end; the shim-contract settings test's unported-feature-clamp example moved to `gamification` since `workout` is no longer a valid example of an unported domain.
- **Deferred by design** (mirrors the server split): the background scheduler loop (lazy `getNext` materialization covers a UI-only client — a session appears when the app computes "next" rather than at a scheduled tick, a UX difference not a data bug); workout reminders (compute-and-upload joins the C2b pattern in a later slice; the shim keeps returning disabled reminder shapes); Telegram/notification transport; the mi-band GPS route (no UI caller); the bot/MCP idempotent log-upsert (`internal/domain/exercise.go`) and name-resolver (`workout_resolver.go`) — neither is the web path, so neither is ported.
- **Contract test strategy**: same as C1/C2a/C2b/C2c — additive shim-mode Vitest suites re-running the real workout feature UI paths (groups/variants/exercises/library CRUD, next-card resolution across all three priorities with seeded rotation state, start/snooze/skip/preskip/cancel-preskip/next-variant incl. rotation-cursor assertions, session-detail multi-call save with update-vs-create id gating, ad-hoc flow, stats shapes incl. `weekly_activity: null` when empty, mi-band list/patch/delete) against an in-memory records port, plus a two-domain-instance convergence case: concurrent lazy `getNext` on a shared in-memory store yields one merged session record.
- **With C2d done, C2e (full-vault export/import, both modes) was the only unported C2 piece** — now implemented (see below), closing C2.

## C2e implementation notes

C2e shipped the **no-lock-in guarantee**: one canonical one-user-all-domains JSON format, exportable **and** importable in **both** runtimes (bot export, bot import, cloud export, cloud import — the full 2×2), with optional passphrase encryption. A plain `.json` (or `.json.age`) file on disk is always an exit door. Plan: `docs/plans/2026-07-06-cloud-c2e-vault-export-import.md`. Format spec: `docs/vault-format.md`.

- **Canonical format = the API wire shape, not the DB shape** (`docs/vault-format.md`): `{"format":"medtracker-vault","version":1,"exported_at":<RFC3339>,"data":{...}}`, one key per domain, field names/value formats matching each domain's existing `/api` contract (which is also what cloud record bodies store verbatim). This keeps the Go exporter a repo-walk + marshal and the cloud exporter a records-walk + regroup — no third dialect. The only true conversions are at the Go storage boundary (mi-band millisecond columns stay raw `int64`; intake unix-seconds and vitals unix-millis are already `time.Time` on their store structs so they marshal as RFC3339 for free).
- **Bot side is fully additive** (no bot regression): `GET /api/export` (`internal/server/vault_export.go`) walks the store for the authed user and marshals the canonical struct set (`vault_format.go`, shared with the importer); `POST /api/import` (`internal/server/vault_import.go`) parses+validates version/format/mode, then in **one transaction** runs `seeddemo.WipeUserTx` → raw explicit-id INSERTs per domain (FK order: meds → intakes/restocks; groups → variants → exercises → sessions → logs; products → food logs). Import is **replace-only** and all-or-nothing — a rejected import (400 + `{"ok":false,"errors":[...]}`) never touches the DB. Both routes get `mcpCoverageExempt` entries in the "Bulk import / export" bucket. A `store *store.Store` field was added to `Server` so the exporter reaches every domain repo without widening a dozen narrow interfaces.
- **Cloud side is fully client-side** (zero-knowledge forbids anything else — plaintext never touches the server): `web/domain/vault.js` (pure, ports-injected, purity-guarded) is `recordsToVault`/`vaultToRecords`, encoding every record convention — singleton recordIds, deterministic ids (`intake-<medId>-<slotUnix>`, `session-<groupId>-<date>`, `rotation-<groupId>`), numeric body-`id` preservation, vitals day-batch pack/unpack, and the skip set (`nk` never crosses). `window.CloudVault.{exportAll,importAll}` (`cloud-boot.js`) reads unmasked integrations module-to-module (never via the `/api` shim), and import lands as **one snapshot** via `replaceAllRecords` + a new exported `forceSnapshot` in `sync.js` — never an op flood.
- **Optional age passphrase encryption, browser-only in both modes**: vendored single-file `typage` ESM (`web/static/vendor/age.min.js`, bundled from `age-encryption@0.3.0` with all `@noble/*` deps inlined) behind `web/static/js/core/backup-crypto.js` (`window.BackupCrypto` — `encryptBackup`/`decryptBackup`/`isAgeFile`). scrypt recipient, binary `.age`, decryptable anywhere with `age -d`. The server never sees the passphrase and Go never links an age library. Interop with the reference `age` CLI is pinned by a checked-in known-answer file.
- **Shared UI** (`web/static/js/features/settings/importexport.js` + `.wg-settings-importexport` block): one Settings → Import/Export screen serves both modes — export branches on `window.__MEDTRACKER_CLOUD__` (`CloudVault.exportAll()` vs `apiCall('/api/export')`), import likewise (`CloudVault.importAll` vs `POST /api/import` with `mode:replace`). Empty-passphrase export shows a one-line nudge (the backup carries provider API keys); import shows a destructive-action confirm and reloads the UI on success. `/api/export`|`/api/import` are never fetched in cloud mode.
- **The round-trip is the contract**: a single golden fixture `tests/fixtures/vault-v1.json` is consumed by both the Go pin (`TestVaultFixtureRoundTrips` — strict unmarshal→remarshal) and the Vitest pin (`cloud.vault-roundtrip.test.js` — `vaultToRecords`→`recordsToVault` deep-equal), so any field-name drift on either side fails CI. A second fixture `tests/fixtures/vault-v1-botexport.json` (real Go export output — DESC ordering, integer-formatted floats, no cloud-only `med_reminder_pref`) is canonicalized back through the cloud transforms to prove bot export → cloud import → cloud export identity.
- **Explicitly not exported** (skip list, `docs/vault-format.md`): push subscriptions, API tokens/login nonces, `change_events`, download cursors, bp/weight reminder-state, workout schedule snapshots, the cloud `nk` record, gamification (derived), voiceprovisioning. **Exported but sensitive**: the `integrations` provider keys — the user's own keys, restored on import, which is why the UI nudges toward a passphrase.
- **Merge-mode import is a documented non-goal** — v1 is replace-only (deterministic ids make a later merge feasible, but nobody asked). Filed follow-ups: merge mode, scheduled/automatic backups, gamification once it ships, age identity-file (keypair) recipients.

## Voice (ElevenLabs)

Cloud mode runs the ElevenLabs conversational agent **browser-direct**, provisioning the agent and its tools **entirely from code** — the user sets only their ElevenLabs API key, nothing touches the ElevenLabs dashboard (bd med-eas.26). Plans: `docs/plans/2026-07-06-cloud-voice-elevenlabs-mcp-poc.md` (the in-tab-dispatch spike), `docs/plans/2026-07-06-cloud-voice-auto-provision-agent.md` (from-code provisioning).

- **Provisioned from code, key is enough.** `web/cloud/js/elevenlabs-agent.js` `createElevenLabsAgentProvisioner({ settingsDomain })` reads the vault `elevenlabs.api_key` and calls the ElevenLabs Agents/Tools API browser-direct (CORS-open). `provision()` orchestrates `ensureTools()` → `ensureAgent()`: `ensureTools()` lists `GET /v1/convai/tools`, matches our fixed spec list by name, and `POST /v1/convai/tools` (the `{tool_config:{type:"client",...}}` shape) for any missing → `{name→id}` map; `ensureAgent(toolIds)` `POST /v1/convai/agents/create` with `tool_ids`, a strong system prompt (always call a tool for any bp/weight/notes question, never claim no access), `tts.voice_id`, and `tool_call_sound:'typing'` + `tool_call_sound_behavior:'always'` for the audible tool-call cue. **Idempotent by `TOOLSET_VERSION`**: the provisioned `{agentId, toolsetVersion, toolIds}` is persisted to a dedicated `voiceprovisioning` vault singleton (`settingsDomain.get/setVoiceProvisioning`) and reused on a matching version — reprovision only on first run or a version bump, never per call. If the user pre-set `elevenlabs.agent_id`, that agent is `PATCH`ed instead of creating one. Published as `window.CloudElevenLabsAgent` from `apishim.js`. The concrete tools are: `get_blood_pressure`(days?)/`log_blood_pressure`(systolic,diastolic,pulse?), `get_weight`/`log_weight`(kg), `get_notes`/`add_note`(text,tag?) — flat typed params, one per catalog op, which voice LLMs call more reliably than a generic `mcp_call`.
- **Signed URL is minted in the browser, not the server.** Bot mode hits `GET /api/elevenlabs/signed-url` (server-side, to hide the operator key); cloud has no such route, which is why "Call Agent" 404'd. `web/cloud/js/elevenlabs-signed-url.js` `createElevenLabsClient({ settingsDomain })` `fetchSignedURL(agentId)` takes the provisioned agent id (falling back to the vault `agent_id` if set) and calls `GET https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=<id>` with the `xi-api-key` header directly. Published as `window.CloudElevenLabs` from `apishim.js`; `startCall()` in `web/static/js/features/elevenlabs-call.js` cloud branch calls `window.CloudElevenLabsAgent.provision()` first, then `fetchSignedURL(agentId)`, surfacing provisioning errors as the call status. **The BYO ElevenLabs key never crosses `/api`** — it goes browser→ElevenLabs only.
- **Concrete tools dispatch in-tab, no relay.** At `startSession`, cloud mode registers `clientTools` whose names match the provisioned tools; each callback dispatches into `window.CloudMCPDispatcher.handle(...)` (the `createDispatcher({ bp, weight, notes })` catalog the Claude connector uses) — e.g. `log_blood_pressure({systolic,diastolic,pulse})` → `bp.create {measured_at:<now ISO>, ...}`, `get_blood_pressure({days})` → `bp.list`. Writes stamp `measured_at`/timestamps = now client-side to match the catalog op schemas. The generic `mcp_help`/`mcp_call` stay registered too (harmless), but the concrete tools are the used path. No relay hop, no crypto — the tab is both the voice client and the MCP responder host, online + unlocked during its own call. Bot mode passes no `clientTools` (unchanged); nothing goes to the cloud server.
- **No manual dashboard steps.** The user sets only the ElevenLabs API key in Settings → Integrations (the Agent ID field is optional — blank means the app creates the agent). Leakage note: ElevenLabs' cloud sees tool names, results, and transcripts (inherent to any cloud voice agent); under BYO keys that's strictly user↔ElevenLabs — the zero-knowledge server sees nothing, and the key is used only against `api.elevenlabs.io`, never `/api`.
- **CSP**: the account-app CSP (`internal/cloudserver/router.go` `setSecurityHeaders`) relaxes `script-src`/`worker-src`/`media-src` for account subdomains to load the `@elevenlabs/client` SDK from esm.sh and run its blob: AudioWorklets (mirroring bot mode). This is a further weakening of the zero-third-party-script defense on the DEK-bearing page (esm.sh script now executes on-origin); vendoring the SDK locally to restore `script-src 'self'` is the follow-up.
- **Scope**: the in-tab catalog is the existing 6 ops (bp/weight/notes list/create); more ops are a follow-up. Server-initiated / off-device voice is the separate med-65c relay path.

## Phasing

- **C0 — cloud service MVP**: signup + subdomain provisioning, wildcard host, blob sync API (oplog/snapshot/cursors), push relay, Emergency Kit + key hierarchy + unlock UX in the PWA shell. No domain logic yet — validate crypto, sync, and push end-to-end with a toy record type.
  - **C0a (implemented)** — service foundation + passkey signup/unlock: `cloudstore`/`cloudserver` packages, wildcard host routing, admin-invite provisioning, WebAuthn registration/login, envelope API, client crypto module (suite v1), signup wizard + Emergency Kit, cold/warm unlock. See `docs/plans/2026-07-03-cloud-c0a-foundation-passkey-signup.md`.
  - **C0b (implemented)** — device lifecycle: transfer slots + QR/typed-code add-device (Path B), enrollment-token-gated registration, device list + envelope-audit UI, revocation (credential+envelope removal; DEK rotation on theft not yet implemented), recovery redemption + forced rotation. Plan: `docs/plans/2026-07-03-cloud-c0b-device-lifecycle.md`. Entry point: a cloud-only "Devices" row in the real app's Settings screen (`web/static/js/features/settings.js`, gated on `window.__MEDTRACKER_CLOUD__`) links to `/devices`, a dedicated shell page that warm-unlocks silently via the same LDK cache path as `cloud-boot.js` and renders the existing device list — no separate ceremony. No-warm-cache falls back to `/unlock`. Plan: `docs/plans/2026-07-05-cloud-devices-settings-entry.md`.
  - **C0c (implemented)** — sync + push relay: append-only oplog with per-account cursors, snapshot compaction, toy encrypted-notes record type, service worker + NK-decrypted rich push, client-scheduled blind firing loop, hourly stale-sync warning sweep. Plan: `docs/plans/2026-07-03-cloud-c0c-sync-push-relay.md`.
- **C1 (implemented)** — core loop, BP + weight: `web/domain/` JS modules for BP + weight behind the `/api` shim (`web/cloud/js/apishim.js`), served through the real `web/static` frontend on account subdomains; shim-mode contract runs of the existing Vitest feature suites as the drift alarm. Medications + intake log + reminder computation, originally scoped as C1, are deferred into C2. See "C1 implementation notes" above and `docs/plans/2026-07-05-cloud-c1-bp-weight-real-frontend.md`.
- **C2 — remaining domains**: medications + intake log + reminder computation, food (incl. direct-from-browser AI/vision/barcode), workouts, vitals, sleep, diary, tz handling. Closes with **C2e — full-vault export/import in both modes** (canonical JSON, Settings → Import/Export UI, optional age encryption, cloud import landing as one encrypted snapshot) — see "Migrating an existing server-mode install".
  - **C2a (implemented)** — diary/notes, settings (incl. integrations BYO-provider-keys in the vault), vitals read side (record shapes + empty-until-import aggregates). See "C2a implementation notes" above and `docs/plans/2026-07-05-cloud-c2a-diary-settings-vitals.md`.
  - **C2b (implemented)** — medications, intake state machine, tz handling (suggestion + one-record plans), reminder compute-and-upload, direct-from-browser RxNorm. See "C2b implementation notes" above and `docs/plans/2026-07-05-cloud-c2b-medications-tz-reminders.md`.
  - **C2c (implemented)** — food logs/products/stats/meals, direct-from-browser AI parsing (text + photo), direct-from-browser food-DB search with an operator default. See "C2c implementation notes" above and `docs/plans/2026-07-06-cloud-c2c-food-client-ai.md`.
  - **C2d (implemented)** — workouts: groups/variants/exercises/library CRUD, next-workout + rotation engine, session lifecycle, exercise logs, stats, mi-band read/edit side. See "C2d implementation notes" above and `docs/plans/2026-07-06-cloud-c2d-workouts.md`.
  - **C2e (implemented)** — full-vault export/import in both modes: canonical one-user JSON (`docs/vault-format.md`), shared Settings → Import/Export UI, optional age passphrase encryption (browser-only), `GET /api/export` + `POST /api/import` (replace-only) in bot mode, client-side `CloudVault` landing one snapshot in cloud mode. Closes C2. See "C2e implementation notes" above and `docs/plans/2026-07-06-cloud-c2e-vault-export-import.md`.
- **C3a — Telegram bot provisioning + onboarding** (plan: `docs/plans/2026-07-04-cloud-c3a-telegram-managed-bot-onboarding.md`; depends on C0a only, parallel-safe with C0b/C0c): Managed-Bots one-tap creation, BYO token fallback, chat linking, consent screen, wizard step 5, test notification.
- **C3b — Telegram delivery + inbound** (after C0c): delivery flags on the scheduled queue (`webpush|telegram|both`, client-composed verbosity), sealed inbound mailbox for Confirm/Snooze. The plan MUST implement the drain protocol above (ack-after-flush, idempotent re-apply via deterministic ids, concurrent drainers, server-timestamp ordering).
- **C4 — MCP tier 1 + tier 2 PoC (implemented)** — tier 1: blind relay (`internal/cloudserver/mcp_relay.go`) + Go shim (`cmd/mcpshim`, crypto/framing in `internal/mcpshim`) + browser responder (`web/cloud/js/mcp-responder.js`) with a hardcoded `bp`/`weight`/`notes` catalog (`docs/plans/2026-07-05-cloud-c4-poc-mcp-blind-relay.md`). Tier 2: consented hosted-relay mode — persistent `mcp_remote` registry + streamable-HTTP endpoint (`internal/cloudserver/mcp_remote.go`, `mcp_endpoint.go`) + devices-page mode picker (`docs/plans/2026-07-06-cloud-c4-poc-remote-mcp-endpoint.md`). See "MCP" section above. Full catalog codegen, multi-pairing (remote + local simultaneously), OAuth 2.1 + DCR, and shim binary distribution are the identified full-C4 follow-ups; go/no-go decided at the PoC's exit review.
- **C5 — trial provider pool**: metered OpenAI-compatible relay, ElevenLabs signed-URL minting + client-tools voice agent, trial-consent wizard screen, quota admin. Depends on C2 (the PWA needs AI features to call it).
- **C6 — bot-mode domain unification** (after C2 parity; optional but intended): embed the JS domain layer in the server build (goja preferred, Node sidecar fallback) behind a SQLite storage port; shadow-mirror real traffic (Go serves, JS diffs, divergences logged); flip per-domain when quiet; deprecate the Go domain layer. Ends the double maintenance — see "The client: porting the domain layer" §3.

Open questions: trial quota sizing; Managed-Bots empirics (per-manager bot limits, user revocation/takeover semantics, library vs raw Bot API HTTP); end-to-end validation of ElevenLabs SDK client tools (designed in `docs/plans/2026-05-18-elevenlabs-dynamic-mcp-client-tools.md`, never implemented); ElevenLabs agents-API coverage of tool/agent provisioning; Pyodide for `mcp_execute`; account deletion + full-vault export format; oplog schema versioning across client updates; iOS push-subscription eviction cadence in practice; how far to take SW-pinned-code / reproducible-build mitigations for the code-serving caveat.
