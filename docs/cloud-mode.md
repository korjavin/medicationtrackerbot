# E2EE Cloud Mode — zero-knowledge cloud + browser PWA

**Status: design proposal; C0a (service foundation + passkey signup/unlock) and C0b (device lifecycle: QR/typed-code add-device, recovery redemption + forced rotation, revocation) are implemented — see `cmd/cloud`, `internal/cloudstore`, `internal/cloudserver`, `web/cloud/`, [docs/cloud-deployment.md](cloud-deployment.md). Everything below C0b in Phasing is still design-only.**

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

Deliberately PII-free: no names, no emails in listings (the optional URL-recovery email is the single stored exception). The admin sees pseudo-secret subdomains, claim status, created / last-sync timestamps, storage usage. Capabilities: mint an invite (pre-provision + print claim link/QR), re-issue a claim link, withdraw an unclaimed invite, delete an account.

`ponytail:` admin is CLI subcommands on the same binary (`cloud admin invite|list|reset-claim|revoke|delete`) — self-hosters have shell access, and it keeps the HTTP surface free of admin auth. A web admin page is a later nicety. Self-hosting the whole cloud stays a first-class goal: one binary + one compose block (see [docs/cloud-deployment.md](cloud-deployment.md)).

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

**Dry-queue safety net**: if the user doesn't open the app within the horizon, reminders stop — and the server can't extend them. The server *does* know last-sync time (inherent metadata), so it sends a generic escalating warning push ("Open the app to keep reminders running — schedule expires in 5 days") and, if an email is on file, an email fallback. This is the E2EE analogue of the adherence safety net.

Known platform caveats: iOS web push requires the installed (home-screen) PWA and has occasional delivery quirks; Safari may drop subscriptions for long-unused web apps — the stale-sync warning doubles as the countermeasure.

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

Zero-knowledge server vs. a chat bot is a real tension: the bot must exchange plaintext with Telegram, but the server can't read the vault. Resolution — the bot is a **channel**, not a brain:

- **One-tap provisioning via Managed Bots (Bot API 9.6, April 2026)** — no BotFather chat, no token pasting. One-time operator setup: create a manager bot and enable "Bot Management Mode" in BotFather's MiniApp. The onboarding step then shows a deep link `https://t.me/newbot/{manager_bot}/{suggested_username}?name=…`; the user taps it, confirms a pre-filled creation dialog, and owns a **personal** bot; the manager bot receives a `managed_bot` update and the cloud fetches the child bot's token via `getManagedBotToken` (`replaceManagedBotToken` for rotation). Account binding: the suggested username carries a random per-invite suffix the server remembers (or a `/start` pairing code fallback). Verified against the [official changelog](https://core.telegram.org/bots/api-changelog) + [features docs](https://core.telegram.org/bots/features); open items: undocumented managed-bot count limits and user-revocation semantics — test empirically at C3. Manual **BYO token stays as the fallback** for users who want a bot outside the manager's control (and it's the same server-side code path — a token is a token).
- **Opt-in with eyes open**: either way the bot token (and chat id) is a *channel credential*, not health data — server-visible by necessity, stored encrypted at rest with a server-side key, and clearly flagged in the UI as the one server-visible secret. Anyone holding it can send messages as that bot — the consent screen says exactly that.
- **Outbound = the same blind queue.** The pre-computed reminder queue grows a per-entry delivery flag (`webpush` / `telegram` / both) and, for Telegram entries, client-chosen plaintext at the user's chosen verbosity: generic ("Medication time") or detailed ("BP pill 10 mg") — the user decides what transits Telegram. Inline `Confirm` / `Snooze` buttons ride along.
- **Inbound = sealed mailbox.** Button callbacks and simple commands arrive at the server, which cannot apply them (it can't write ciphertext it can't produce). Instead it seals each event to the account's X25519 inbox public key with a server-side timestamp and appends it to a pending queue. On next open, the client drains the mailbox, decrypts, and applies through the normal domain layer — a `Confirm` tapped at 09:00 is recorded as taken at 09:00 even if the app opens at noon. (Push can nudge the SW to drain sooner when a device is reachable.)
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

## MCP

Three tiers, because "MCP" and "server that can't read data" genuinely conflict — the server cannot answer a single registry op. The user's suggestion (server proxies MCP *to client devices*) is the right shape; the question is who can read the frames.

**Tier 0 — MVP: no MCP in cloud mode.** Server-mode installs keep the full registry/executor. Cloud mode ships without it.

**Tier 1 — blind relay + local shim (preserves zero knowledge).** For Claude Desktop / Claude Code, which can run a local stdio MCP server:

```
Claude Desktop ──stdio── medtracker-mcp-shim ──wss:// ciphertext ──► cloud relay ──► user's device (PWA)
                          (holds a pairing key)      (blind pipe)        (decrypts, runs op, answers)
```

- Pairing: the PWA shows a one-time code encoding the relay endpoint + a shared session key; the user pastes it into the shim config (`npx medtracker-mcp-shim`). Frames are E2E encrypted shim↔device; the relay sees only sizes and timing.
- The device answers using the *same operation catalog semantics* as `internal/mcp/registry` — `mcp_help` (the catalog is static, ships with the client) and `mcp_call` (executed by the in-browser domain layer against local data). `mcp_execute` (Python) has no browser sandbox; Pyodide is a conceivable stretch, parked as an open question.
- **The honest constraint: a device must be online with an unlocked vault.** A phone with the PWA backgrounded is not reliably reachable (iOS SW execution on push is too constrained to serve queries silently). Realistic availability = a desktop tab left open, or an old phone plugged in at home with the PWA foregrounded — at which point the user has voluntarily re-invented a tiny server, but it's *their* device, zero config, and the guarantee holds.

**Tier 2 — hosted-relay convenience mode (explicit consent, reduced guarantee).** claude.ai's remote MCP cannot run a shim, so the relay would have to terminate the MCP connection and see requests/responses **in transit** (never stored). This is a deliberate, per-account, clearly-labelled downgrade switch ("Claude can query your data through the cloud; the cloud sees answers while relaying them"), off by default. Ship order: 0 → 1, and decide on 2 only if demand is real.

## The client: porting the domain layer

This is the dominant cost of the proposal and it must be stated, not hidden: the Go domain layer (~9.1K lines), store semantics (~9.8K), scheduler (~2.8K), and the validation slice of the HTTP handlers must be reimplemented in JS, and ~33K lines of Go tests re-earned. Two structural decisions keep this tractable and stop the fork from rotting:

1. **Port behind the `/api/*` contract, keep the UI byte-identical.** The existing frontend already speaks only `/api/*`. Cloud mode inserts a fetch shim (SW or wrapper around `apiCall`) that routes `/api/*` to an in-browser router → JS domain services → Dexie stores. `web/static` feature code, the design system, offline plumbing, and all Vitest feature suites are shared verbatim with server mode. The fork is confined to a `web/static/js/localdomain/` layer; the HTTP contract becomes the enforced seam (the same contract-first contingency `docs/local-mode.md` names for a `gomobile bind` fallback).
2. **Cross-implementation contract tests.** A shared fixture corpus (seed ops → API call sequence → expected JSON responses) runs in CI against both the Go server and the JS domain layer. A behavior change that lands in one implementation fails the other's contract run. This is the drift alarm that makes double maintenance survivable; without it, this proposal should be rejected.
3. **Write the JS layer runtime-agnostic (design constraint for C1, cheap now, expensive to retrofit).** Domain services must depend on injected ports — a storage port (Dexie in the browser; something else elsewhere) and a crypto port — never on browser globals directly. This keeps the **unification endgame** open: the double maintenance is intended as a *migration cost, not a permanent tax*. Once C2 reaches parity, bot mode can host the same JS domain layer server-side — preferred embedding is **goja** (pure-Go JS engine: keeps `CGO_ENABLED=0`, the single binary, and the mobile cross-compile; Node sidecar as fallback if goja performance disappoints) with a SQLite-backed storage port. The migration proof is **shadow mirroring** (C6): the Go handler serves the response while the JS layer computes it in parallel and divergences are logged; per-domain flips happen only after the diff log stays quiet on real traffic. End state: one domain implementation (JS), Go keeps transport (bot, HTTP, push, scheduler ticks, MCP).

Port order tracks user value: meds + intakes + reminder computation first (C1 below), then the remaining domains.

## Migrating an existing server-mode install

Server-mode users with real history move by **export → client-side import** — the zero-knowledge property forbids anything else: plaintext can never be uploaded, so the data must enter through an unlocked client that encrypts it locally.

1. **Full-vault export from server mode.** A canonical one-user-all-domains JSON format (meds + intake log, BP, weight, food, workouts, vitals, sleep, diary, tz history, settings). Nothing like it exists yet — `cmd/importer` reads a third-party app's format and there is no `/api/export`. v1 is a `cmd/exporter` CLI against the server DB (the operator has DB access); a Settings → "Download my data" button can follow.
2. **Import on an unlocked cloud client** (requires C2 — every domain in the export must already be ported). Settings → Import → file picker; records flow through the same JS domain services and validation as live writes, so an import can't create states the app couldn't.
3. **Bulk lands as a snapshot, not an op flood.** Months of history is thousands of records; the importer writes local Dexie state and uploads one encrypted snapshot (the C0c compaction path), then normal op-based sync resumes. Reminder schedules recompute client-side from the imported plans.
4. **The same format is the exit door.** The cloud client can export its decrypted vault back to identical JSON — enabling cloud → server migration, plain offline backups, and honest data portability. (Resolves the "full-vault export format" open question: one format, both directions.)

## Metadata leakage summary

| Signal | Who learns it | Mitigation |
|---|---|---|
| Reminder timing | cloud | inherent to a blind alarm clock; content stays sealed |
| Subdomain (≈ account existence) | network observers (DNS/SNI), cloud | wildcard cert+zone keep it out of CT/zone files; DoH/ECH close the rest over time |
| Sync cadence, blob sizes, IPs | cloud | standard for any sync service; no content |
| TG bot token, chat id, TG message text at user-chosen verbosity | cloud + Telegram | opt-in; generic-text mode; sealed inbound |
| MCP query content | nobody (tier 1) / cloud in transit (tier 2) | tier 2 off by default, explicit consent |
| Food/barcode search terms | operator's food-DB instance (default) | same exposure class as public Open Food Facts; endpoint swappable in settings |

## Phasing

- **C0 — cloud service MVP**: signup + subdomain provisioning, wildcard host, blob sync API (oplog/snapshot/cursors), push relay, Emergency Kit + key hierarchy + unlock UX in the PWA shell. No domain logic yet — validate crypto, sync, and push end-to-end with a toy record type.
  - **C0a (implemented)** — service foundation + passkey signup/unlock: `cloudstore`/`cloudserver` packages, wildcard host routing, admin-invite provisioning, WebAuthn registration/login, envelope API, client crypto module (suite v1), signup wizard + Emergency Kit, cold/warm unlock. See `docs/plans/2026-07-03-cloud-c0a-foundation-passkey-signup.md`.
  - **C0b (implemented)** — device lifecycle: transfer slots + QR/typed-code add-device (Path B), enrollment-token-gated registration, device list + envelope-audit UI, revocation (credential+envelope removal; DEK rotation on theft not yet implemented), recovery redemption + forced rotation. Plan: `docs/plans/2026-07-03-cloud-c0b-device-lifecycle.md`.
  - **C0c** — sync + push relay (oplog/snapshot/cursors, Web Push). Plan: `docs/plans/2026-07-03-cloud-c0c-sync-push-relay.md`.
- **C1 — core loop**: JS domain layer for medications + intake log + reminder computation behind the `/api` shim; contract-test harness against the Go server. A user can fully run medication tracking on cloud mode.
- **C2 — remaining domains**: BP, weight, food (incl. direct-from-browser AI/vision/barcode), workouts, vitals, sleep, diary, tz handling. Closes with the **server-mode migration pair**: `cmd/exporter` (full-vault JSON) + cloud-client import landing as one encrypted snapshot — see "Migrating an existing server-mode install".
- **C3a — Telegram bot provisioning + onboarding** (plan: `docs/plans/2026-07-04-cloud-c3a-telegram-managed-bot-onboarding.md`; depends on C0a only, parallel-safe with C0b/C0c): Managed-Bots one-tap creation, BYO token fallback, chat linking, consent screen, wizard step 5, test notification.
- **C3b — Telegram delivery + inbound** (after C0c): delivery flags on the scheduled queue (`webpush|telegram|both`, client-composed verbosity), sealed inbound mailbox for Confirm/Snooze.
- **C4 — MCP tier 1** (blind relay + shim).
- **C5 — trial provider pool**: metered OpenAI-compatible relay, ElevenLabs signed-URL minting + client-tools voice agent, trial-consent wizard screen, quota admin. Depends on C2 (the PWA needs AI features to call it).
- **C6 — bot-mode domain unification** (after C2 parity; optional but intended): embed the JS domain layer in the server build (goja preferred, Node sidecar fallback) behind a SQLite storage port; shadow-mirror real traffic (Go serves, JS diffs, divergences logged); flip per-domain when quiet; deprecate the Go domain layer. Ends the double maintenance — see "The client: porting the domain layer" §3.

Open questions: trial quota sizing; Managed-Bots empirics (per-manager bot limits, user revocation/takeover semantics, library vs raw Bot API HTTP); end-to-end validation of ElevenLabs SDK client tools (designed in `docs/plans/2026-05-18-elevenlabs-dynamic-mcp-client-tools.md`, never implemented); ElevenLabs agents-API coverage of tool/agent provisioning; Pyodide for `mcp_execute`; account deletion + full-vault export format; oplog schema versioning across client updates; iOS push-subscription eviction cadence in practice; how far to take SW-pinned-code / reproducible-build mitigations for the code-serving caveat.
