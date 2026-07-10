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
| **Inbound** Telegram message content, at rest — sealed to the inbox key on arrival | **Outbound** Telegram reminder text *and* command confirmations, at the user's chosen verbosity (client-composed, forwarded verbatim) |
| What an inbound message *means* — the relay never parses it and never calls AI on it | **Inbound** Telegram message content, **transiently in memory** — Telegram delivers bot updates in the clear; the relay cannot un-see them before sealing |
| Meal photo pixels, at rest — only the Telegram `file_id` is sealed | That an inbound message arrived, its size, and its timestamp |

The last three rows are the **inbound** posture, decided in `med-eas.29.1` and specified under [Inbound plaintext — what the relay may do](#inbound-plaintext--what-the-relay-may-do). The distinction that carries the whole design: *transiently in memory* is not the same exposure as *at rest*, *logged*, or *sent to a third party*. Telegram already sees every inbound message; the relay's job is to add nothing to that.

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

**The wizard ends by entering the app, not on a confirmation screen** (`enterApp` in `web/cloud/js/signup.js`, bd `med-8eh`). It establishes the LDK warm cache from the ceremony's DEK and navigates to `/`; the real `web/static` app boots, `/api/bootstrap` reports `needs_first_run: true`, and the first-run overlay mounts on top of it (see [docs/onboarding-wizard.md](onboarding-wizard.md)). The warm cache is written at that moment rather than right after passkey registration, so a user who abandons at the Emergency Kit does not reload into an unlocked app with no recovery code. If the cache cannot be written (storage-blocked browser) the failure is swallowed and we navigate anyway: `cloud-boot`'s `warmUnlock` fails and routes to `/unlock`, where the just-created passkey signs in. Degraded, never dead-ended.

**A claim link that was already claimed routes to unlock, never to passkey creation.** `POST /api/webauthn/register/begin` returns `409 {"error":"already_claimed"}` when the account's claim token has been consumed *and* at least one credential is registered; expired, swept, or mismatched tokens on an account that is **not** claimed still get the plain-text `403 invalid or expired claim`. Once a claim is consumed its token hash is `NULL`, so there is nothing left to compare a presented token against — *any* non-empty `claim_token` on a claimed account answers `409`. Nothing leaks: reaching the subdomain at all already reveals the account exists, and the wizard's own probe replays the same token. The wizard probes that endpoint on load (before rendering anything) and shows an "already claimed" screen — unlock with your existing passkey, or open the app on your former device and share access from there. Edge case: an account whose claim was consumed but whose credentials were *all* later deleted (possible once recovery material exists) has no credentials to discriminate on, so it falls back to the `403` expired-link copy.

**The wizard is stateless — no stored step counter.** iOS Safari tabs and installed PWAs have separate storage, so locally-persisted progress dies at the install boundary. Every step is instead derived from observable facts: passkey exists (server credential list), loss-protection acknowledged (server-side flag), running installed (`display-mode: standalone`), push subscription exists (server). Opening the app in any context computes the first unmet step and resumes there; passkeys carry across the boundary via the platform keychain, so re-unlock works even though local caches don't transfer.

### User-mintable invites

Invites are not admin-only: any signed-in account can mint one for a friend from its own subdomain via `POST /api/invite` (session-authed, same host-routed `/api/*` mux as devices/sync/push). It runs the same `Provision()` path as `cloud admin invite` — server-assigned subdomain, one-time claim token, per-account VAPID keypair — and returns `{"subdomain", "claim_url", "expires_at"}`. The token exists only in that response body and travels in the claim URL's fragment; the store keeps only its hash. Settings → "Invite a friend" shows the claim URL with a copy button and a client-rendered QR code.

**Quota: 100 invites per account per rolling 30 days**, counted in SQL, not memory — `accounts.created_by_account_id` (migration `010`, NULL for admin-CLI invites) records the minter, and the endpoint counts that account's rows with `created_at_unix` inside the window. Over quota: `429 {"error":"invite limit reached","limit":100,"window_days":30}`. Counting rows rather than mints means `SweepExpiredClaims` reaping an unclaimed invite gives the quota back — deliberate, since the limit is about *users* created, not links clicked. `ponytail:` a patient abuser can therefore recycle expired invites; swap in an append-only mint log if that ever happens. Note that `created_by_account_id` also holds `tg:<uid>` rows minted by the managebot — not every value is an account id, see [Managebot onboarding](#managebot-onboarding--invites-over-chat).

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
- **Conflict resolution is client-side** (server can't merge what it can't read): last-writer-wins per record on `clientTs`, same semantics the offline write queue (`SyncManager`) already implements for server mode.

  `clientTs` is a **merge token, not a wall clock** (bd med-d5t.6). It used to be the writing device's raw `Date.now()`, which made LWW obey whichever device's clock ran fastest: a phone ten minutes fast would win against a correctly-clocked laptop's *later* edit, and the laptop's fix was dropped silently. On a medication tracker that is the worst failure mode there is — quiet, plausible, and about dosage. Two local guards, neither touching the envelope format nor the server:

  1. **Server-referenced time.** Every sync response already carries a `Date` header — the server's own clock, for free. `noteServerDate` measures the offset into `sync_meta.clockSkewMs` and writes subtract it, so every device stamps on one scale.
  2. **A per-record monotonic guard.** A write to a record this device can already see is stamped `max(correctedNow, existing.clientTs + 1)`, so editing what you can see always beats what you are overwriting, whatever either clock says. This is what fixes the phone-then-laptop case outright.

  Neither orders two *blind concurrent* writes made on skewed devices; that needs a hybrid logical clock (deferred with the envelope's `format_version`, bd med-jb7.5). But a device whose clock is more than two minutes out now says so in the sync status line rather than losing edits quietly.
- **Snapshots + compaction**: the server cannot compact ciphertext, so clients periodically upload a full encrypted snapshot; the server then drops ops below that seq. Bounds both restore time on a new device and storage growth. The snapshot plaintext is **gzip-then-encrypt** (`gzip(utf8(JSON))` before AES-GCM), shrinking a large vault's POST body ~10x; the decrypt path sniffs the `0x1f 0x8b` gzip magic so legacy uncompressed snapshots still read. Server cap is a **64 MiB decoded ciphertext** (the request body is capped at 96 MiB to hold its base64 expansion). See [docs/cloud-crypto.md](cloud-crypto.md).
- Local layer stays Dexie/IndexedDB (already vendored); plaintext lives only in memory and IndexedDB on the user's device, cloud copy is authoritative.

## Push relay & reminder lifecycle

The server is a **blind alarm clock**. It cannot compute "when is the next dose" — the client pre-computes and uploads the schedule:

1. Client (which has the domain logic + data) computes all reminders for the next horizon (default 30 days, configurable; ~KBs even at many-meds scale) and uploads `(fire_at, app_ciphertext)` rows, replace-all per sync — the same replace-all pre-schedule semantics as the Capacitor `Reminders` loop.
2. At `fire_at`, the server wraps `app_ciphertext` in standard Web Push encryption (RFC 8291) per registered subscription and sends. Two layers: the push services (FCM/APNs) can't read RFC 8291 payloads, and our server can't read the app layer.
3. The service worker decrypts the app layer if the vault key is available and shows a rich notification ("BP pill — 10 mg"); if the vault is locked, it shows a generic "Medication reminder". Notification tap deep-links via the existing `handleDeepLinks()` surface.
4. Every app open refreshes the horizon; multiple devices each hold a subscription; the relay prunes subscriptions on `410 Gone`.

**Settings entry point**: the main app's Settings screen (`web/static`, not just the `/unlock` shell) surfaces a cloud-only Notifications block (`features/settings.js`, gated on `window.__MEDTRACKER_CLOUD__`) with Enable/Disable and "Send test push" controls. It calls the same DOM-free `web/cloud/js/push.js` (`subscribe`/`unsubscribe`) helpers the shell uses, reached via `window.MedTrackerCloud.ctx` (published by `cloud-boot.js` once the vault is unlocked). The `/unlock` shell's own push screen remains for the pre-app flow (before the vault has ever been unlocked in the main app).

**Test push is a separate, immediate, this-device-only send** — distinct from the scheduled-reminder path above, which always fans out to every subscribed device. `sendTestPush(ctx)` (`web/cloud/js/reminders.js`) reads the current device's own subscription, encrypts a fixed test payload with the account NK, and `POST`s `{ endpoint, ct }` to `/api/push/test`. The handler (`internal/cloudserver/push.go`) resolves that endpoint to a subscription on the caller's account (404 if none/foreign), loads the account's VAPID keys, and calls `WebPushSender.Send` immediately — no relay tick, no schedule mutation, so it can never clobber the real replace-all reminder schedule. Same blind shape as the relay: the server sees only the endpoint (already-stored routing metadata) and the client-encrypted `ct`, never content.

**Notification actions (Snooze / Don't-bug)** — implemented, bd med-9b8.3. BP and weight reminders carry the same two action buttons bot mode shows. The `kind` that selects them (`bp` / `weight` / `medication`) rides *inside* the NK ciphertext, so the relay never learns what sort of reminder it is forwarding.

The tap path differs from bot mode by necessity. Bot mode's service worker POSTs `/api/bp/reminder/snooze` straight to the server. The cloud service worker **cannot**: those routes are served by the apishim, which lives in the page and needs the DEK, and a service worker never holds the DEK. So a tap is handed to an unlocked page instead — `postMessage({type:'reminder-action', route})` to a focused tab, or `openWindow('/?reminder_action=<action>')` on a cold start, which `cloud-boot.js` drains *after* the vault opens (and strips from the URL, so a refresh can't replay the mute). `cloud-boot.js` allowlists the four routes it will replay, so a stale or hostile same-origin worker message can't drive arbitrary shim writes.

Snooze (2h) and don't-bug (24h) are **mute-until instants on the `bpreminderpref` / `weightreminderpref` vault records**, not flags — `enabled` stays true and the schedule resumes on its own, matching `internal/store/{bp,weight}/reminders.go`. Because the horizon is *precomputed and already queued server-side*, muting only takes effect once a horizon omitting the muted targets is re-uploaded; the shim fires that recompute undebounced but does not await it, so a snooze tapped on a flaky connection still succeeds (the next unlock re-uploads anyway). Bot mode's `POST /api/bp/reminder/test` — which fans a card out through every notifier — maps in cloud onto `sendTestPush(ctx)`, the this-device-only encrypted push described above.

**Dry-queue safety net**: if the user doesn't open the app within the horizon, reminders stop — and the server can't extend them. The server *does* know last-sync time (inherent metadata), so it sends a generic escalating warning push ("Open the app to keep reminders running — schedule expires in 5 days") and, if an email is on file, an email fallback. This is the E2EE analogue of the adherence safety net.

**Subscription eviction (implemented, bd med-d5t.3)**: Safari drops the push subscription of a PWA left unopened for a few days, and iOS gives no signal when it does. The stale-sync warning is *not* the countermeasure — it is itself a server-composed web push, so once the subscription is evicted it cannot arrive either. That reasoning was circular, and reminders stopped forever with nothing to show for it.

The countermeasure is a two-layer reconcile. The load-bearing half is `ensurePushSubscription()` (`web/cloud/js/push.js`), called on every app boot from `cloud-boot.js`: if notification permission is still granted, it demands a live `pushManager.getSubscription()` and re-subscribes when it finds none — no user gesture is needed once permission exists. Re-uploading the endpoint also *heals the server row*, because `POST /api/push/subscriptions` upserts with `disabled = 0`. The belt is a `pushsubscriptionchange` handler in `web/cloud/sw.js`, which re-subscribes with the same (never-rotated, per-account) `applicationServerKey` and re-uploads; Safari's support for that event is unreliable, which is exactly why it cannot be the only layer. When neither can restore the subscription, Settings says "Reminders are not armed on this device" rather than showing a bare Enable button that reads like a fresh device.

Server side needs nothing new: the relay already disables a subscription on a 410/404 from the push service (`Relay.send` → `Repo.Disable`), and `Repo.List` skips disabled rows, so a dead endpoint is never retried forever.

Remaining platform caveat: iOS web push requires the installed (home-screen) PWA and has occasional delivery quirks.

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

**Status: C3a implemented; C3b outbound implemented** — managed-bot provisioning + BYO fallback + chat linking + consent screen + wizard step + test notification all ship in `cmd/cloud` (endpoints under `/api/telegram/*` and webhooks under `/tg/*`; token sealed at rest via HKDF-from-`SESSION_SECRET` + AES-GCM). **Outbound reminder delivery now ships too** (med-76c.1): `scheduled_pushes` carries a per-entry `delivery` flag (`webpush|telegram|both`) and, for Telegram entries, a `tg_text` the client composes at its chosen verbosity; the relay branches on the flag and sends via the sealed bot token. **Inbound now ships too** (med-76c.2): medication reminders carry inline Confirm/Snooze buttons whose `callback_data` is `s:<slotUnix>:<action>` (`tgclient.CallbackSlotPrefix`), a tap is sealed to the account's inbox key by `ChildWebhook` and queued, and an unlocked client applies it through the intake domain at drain time. The stem is **slot-scoped, not intake-scoped**, because one cloud dose reminder bundles every medication due at the same instant into a single message — so one Confirm means "I took the 08:00 meds", and the client expands the slot to its intakes. The relay learns nothing new from the stem: the slot instant is already the row's `fire_at_unix`. Real-Telegram empirics (managed-bot count limits, edited-username binding, user-revocation semantics) remain open and are gated to Post-Completion validation — the fake-API integration tests cover the contract but not Telegram's live behavior.

Zero-knowledge server vs. a chat bot is a real tension: the bot must exchange plaintext with Telegram, but the server can't read the vault. Resolution — the bot is a **channel**, not a brain:

- **One-tap provisioning via Managed Bots (Bot API 9.6, April 2026)** — no BotFather chat, no token pasting. One-time operator setup: create a manager bot and enable "Bot Management Mode" in BotFather's MiniApp. The onboarding step then shows a deep link `https://t.me/newbot/{manager_bot}/{suggested_username}?name=…`; the user taps it, confirms a pre-filled creation dialog, and owns a **personal** bot; the manager bot receives a `managed_bot` update and the cloud fetches the child bot's token via `getManagedBotToken` (`replaceManagedBotToken` for rotation). Account binding: the suggested username carries a random per-invite suffix the server remembers (or a `/start` pairing code fallback). Verified against the [official changelog](https://core.telegram.org/bots/api-changelog) + [features docs](https://core.telegram.org/bots/features); open items: undocumented managed-bot count limits and user-revocation semantics — test empirically at C3. Manual **BYO token stays as the fallback** for users who want a bot outside the manager's control (and it's the same server-side code path — a token is a token). Because Telegram never re-sends a lost `managed_bot_created` update, the pending page always exposes the BYO form and a "Start over" control (`POST /api/telegram/reset`, clears the `tg_pending` row → status `none`) — a lost bind update never strands the account waiting out the 1h pending TTL.
- **Opt-in with eyes open**: either way the bot token (and chat id) is a *channel credential*, not health data — server-visible by necessity, stored encrypted at rest with a server-side key, and clearly flagged in the UI as the one server-visible secret. Anyone holding it can send messages as that bot — the consent screen says exactly that.
- **Outbound = the same blind queue.** The pre-computed reminder queue grows a per-entry delivery flag (`webpush` / `telegram` / both) and, for Telegram entries, client-chosen plaintext at the user's chosen verbosity: generic ("Medication time") or detailed ("BP pill 10 mg") — the user decides what transits Telegram. Inline `Confirm` / `Snooze` buttons ride along.
- **Inbound = sealed mailbox.** Button callbacks and simple commands arrive at the server, which cannot apply them (it can't write ciphertext it can't produce). Instead it seals each event to the account's X25519 inbox public key with a server-side timestamp and appends it to a pending queue. On next open, the client drains the mailbox, decrypts, and applies through the normal domain layer — a `Confirm` tapped at 09:00 is recorded as taken at 09:00 even if the app opens at noon. (Push can nudge the SW to drain sooner when a device is reachable.)
- **Inbound foundation (implemented, med-76c.2 part 1).** The sealed-box format is `mt/v1/inbox`: anonymous ephemeral-static **X25519**, `ephPub(32) ‖ nonce(12) ‖ AES-256-GCM(K, plaintext, aad)` with `K = HKDF-SHA256(ikm=X25519(ephPriv, inboxPub), salt=ephPub‖inboxPub, info="mt/v1/inbox")` and `aad = encodeFields("mt/v1/inbox", accountId)`. Salting with both public keys binds a ciphertext to its (ephemeral, recipient) pair; the AAD binds it to the account, so a mailbox row copied between accounts fails to open rather than decrypting into the wrong vault.

  Both sides use their platform's native X25519 — Go's stdlib `crypto/ecdh`, WebCrypto's `X25519` — so **neither language takes a new crypto dependency**. `internal/cloudserver/testdata/inbox_sealed_vector.json` pins the wire format: the Go suite regenerates it from fixed randomness and the Vitest suite decrypts that exact file, so the two implementations cannot drift apart silently. (WebCrypto X25519 needs Chrome 133+ / Firefox 132+ / Safari 17.4+; `inboxCryptoSupported()` probes for it and the client refuses to half-provision a mailbox it could never open.)

  The account's inbox **public** key lives on `accounts.inbox_public_key`; there is deliberately no private column. The private key is an ordinary vault record (`inboxkey`), so it syncs to every device and any unlocked client can drain. `ensureInboxKey` writes it to the vault *before* publishing the public half — publishing first would let the server seal to a key a crash could stop us from persisting, stranding those events forever. Until a key is published, `SealAndQueue` returns `ErrNoInboxKey` and the event is **dropped, never stored in the clear**. Endpoints: `PUT /api/inbox/key`, `GET /api/inbox`, `DELETE /api/inbox/{id}` (per-event, account-scoped, idempotent).

  The ack barrier the protocol below demands now exists: `flushPending` (and its `flushConfirmed` wrapper in `web/cloud/js/sync.js`) returns **true only when every pending op is confirmed persisted server-side**, and false when writes were left pending — offline, un-bootstrapped, or a concurrent-writer collision. Before this it returned identically in both cases, so a drain could not have told "applied" from "deferred".

- **Drain protocol (binding requirements for C3b).** The failure to design out: an event acked as processed that never landed in the vault. Rules:
  1. **Ack strictly after flush**: per event — decrypt → apply through the domain layer → wait for the resulting ops to be *confirmed flushed* to the sync log → only then delete from the mailbox. A client crashing mid-drain leaves the event queued for the next drain. Never batch-ack ahead of the flush barrier.
  2. **At-least-once + idempotent apply**: re-draining an already-applied event must converge, not duplicate — guaranteed by deterministic record ids (e.g. a `Confirm` targets `intake-<medId>-<slotUnix>`) + LWW. Free-text events (`/food two eggs`) get a deterministic id derived from the mailbox event id, so a re-parse after a crash overwrites its own earlier result instead of double-logging.
  3. **Concurrent drainers are expected, not an error**: several unlocked clients may drain at once — including physical devices sharing one synced passkey (iCloud/Google-synced credentials look like a single device to the server; sync correctness never keys on credential identity — cursors and pending queues are per-client-local). Mailbox delete is per-event; the first ack wins, a second delete of the same event is a no-op, and duplicate applies converge per rule 2.
  4. **Apply in server-timestamp order** within a drain, and backdate records from the sealed server timestamp (not drain time) — that's what makes the 09:00 tap record 09:00.
- **Free-text logging works through the same mailbox**: `/bp 120/80`, `/food two eggs`, `/weight 81.5` are sealed as raw text and parsed *client-side at drain time* by the same JS domain layer the app uses — including AI food parsing, since provider keys live in the vault and the drain runs on an unlocked client. The bot's immediate reply is necessarily generic ("saved — recorded next time you open the app"): the server can't confirm what it can't parse. Richer confirmation can arrive after drain, composed by the client (user-chosen verbosity). This is now ratified policy, not just a sketch — see [Inbound plaintext — what the relay may do](#inbound-plaintext--what-the-relay-may-do) for what the relay is and is not permitted to do, and why relay-side parsing was rejected.

  **Implemented for commands (`med-eas.29.2`).** `ChildWebhook` answers `/start` and `/help` locally and seals every other `/command` verbatim, replying `⏳ Queued`, which the client later edits into a confirmation. **Free text is still silently dropped** — routing it is `med-vcv`'s work. AI food parsing at drain time is designed for but not built.
- **Not supported in cloud mode**: conversational queries ("what's my BP trend?") — answering requires reading data, which only clients can do; a live reply would need an online unlocked client anyway, at which point the user has the app open. That stays a server-mode feature.

### Inbound plaintext — what the relay may do

**Status: decided (`med-eas.29.1`), gates `med-eas.29.2` / `med-vcv` / `med-eas.30`.** The bullets above describe the mechanism; this section is the *policy*, and the constraint every downstream bead must implement against.

**The tension.** Outbound is already settled: the client composes the reminder text at a verbosity it chose, and the relay forwards it verbatim (`SendReminder`, `internal/cloudserver/telegram.go` — "Nothing here derives text from account data"). Inbound is different in kind. Telegram delivers bot updates as **plaintext over a webhook**; there is no bot API that is end-to-end encrypted. The moment full chat management exists, food descriptions, BP numbers and diary text land in the relay's memory. The question was never *can we avoid the relay seeing it* — we cannot — but **what the relay is permitted to do with it once it has.**

**Decision: seal-only. The relay never parses inbound content and never sends it to an AI provider.**

Per inbound message the relay may:

1. Read the leading command token, only to distinguish what it answers locally (`/start`, `/help`) from what it seals. It does **not** inspect arguments.
2. `SealAndQueue` the **raw message text, verbatim** to the account's X25519 inbox public key, and append the ciphertext to `inbox_events`.
3. Reply with a **fixed server constant** — "Queued — recorded when you next open the app." The reply is necessarily generic: the relay cannot confirm what it cannot parse. That is the feature, not a limitation.
4. Forget the plaintext. It is never written to disk, never logged, never re-read.

Everything else happens on an unlocked client: `drainInbox` decrypts, the existing JS domain layer parses (including AI food parsing, since provider keys live in the vault), and writes land through the normal domain path with an ack-after-flush barrier.

**What this costs, stated plainly.** The sealed mailbox is drained only after a **tab unlocks** — the service worker never holds the DEK, so `web/cloud/sw.js` cannot drain (it has no fetch handler and never touches the vault). The push→drain nudge described above is *aspirational, not implemented*. So a `/bp 120 80` sent on the bus is recorded when the app is next opened, and the bot cannot echo the value back in the meantime. This matches the availability constraint MCP already lives with: **no live tab, no processing.** Accepted deliberately.

**Alternatives rejected.**

- **(a) Relay-side AI parse** (relay calls OpenAI with the operator trial key so the bot can reply "Logged 2 eggs, 12 g protein"). Rejected. It gives the relay the plaintext *and* the intent *and* a provider key, converting an honest-but-curious operator from someone who sees ciphertext and metadata into someone who reads every meal, reading, and diary line. The relay today holds **no** per-account key capable of decrypting anything (`accounts` stores only a VAPID keypair and the inbox **public** key — `012_inbox.sql` has no private column, deliberately). Option (a) would be the first thing in the system to break that, in exchange for a nicer bot reply. Not a trade worth making. The one existing carve-out — the trial AI proxy — stays what it is: an explicit, consent-gated, *outbound-initiated* choice the user makes in the app, not a silent property of receiving a text message.
- **(c) Hybrid** (seal, reply "queued", relay later relays a client-composed answer back). **Adopted in `med-eas.29.2`** — see [Closing the loop](#closing-the-loop--queued--recorded) below. It needs no new trust: the answer is composed by the client and forwarded verbatim, exactly like `tg_text`. The original objection ("only pays off once a push→drain nudge exists") turned out to be wrong — a visible tab polling the mailbox is enough, and needs no notification permission.
- **Structured-commands-only** (relay regex-parses `/bp 120 80` itself to reply exactly). Rejected: it buys a better reply by making the relay read the values, which is precisely the exposure the seal-only rule exists to prevent — and it cannot generalize to food or diary text anyway.

**Photos — proxy, never store.** A photo is worse: the relay must download it, because only the relay holds the bot token. The rule:

- Seal only the Telegram **`file_id`** (plus `mime`/`size`) into the mailbox. Never seal the bytes: multi-MB blobs in `inbox_events` would bloat every `GET /api/inbox` drain, and the mailbox is a control channel, not a blob store.
- On drain, the client requests the image through a **session-gated, account-scoped relay endpoint** that resolves the `file_id` via `getFile` and **streams the bytes through** to the browser. Nothing is written to disk; nothing is logged but the status code. The vision parse then runs browser-side with the user's own key.
- This is durable, contrary to first appearances: a Telegram **`file_id` is stable and re-usable** — it is the `file_path` returned by `getFile` that expires (~1h). The relay re-resolves on demand at drain time, so a photo sent on Monday and drained on Friday still fetches, as long as the file exists on Telegram's servers and the bot token is unchanged. A `getFile` failure is surfaced to the client as a normal error and the event is acked, not retried forever.

#### Closing the loop — "Queued" → "Recorded"

Seal-only forces the immediate reply to be generic: the relay cannot confirm what it cannot parse. But it does not force the reply to *stay* generic.

1. The relay sends `⏳ Queued — recorded when you next open the app.` and keeps the `message_id` Telegram returns, sealing it into the event alongside the raw text (`tgCommandEvent.reply_message_id`).
2. An unlocked client drains, parses, writes through the domain layer, and waits for the flush barrier.
3. It then composes the confirmation *itself* — `✅ Recorded BP 128/84.` — and POSTs it to `POST /api/telegram/reply-edit`, which calls `editMessageText` on that exact message.

**This adds no trust.** The relay forwards a string it never derived, from vault data it cannot read — the identical contract it already has for outbound `tg_text` (`SendReminder`: *"Nothing here derives text from account data"*). The chat is taken from the stored bot row, never from the request, so a session can only edit messages in its own chat. The confirmation honours the same `generic`/`detailed` verbosity as reminders: a user on `generic` gets `✅ Recorded.` with no health value crossing Telegram.

**Latency.** Nothing in cloud mode polled — no SSE, no change stream — so a drain only happened on page load. `startInboxPolling` now drains every 5s **while the tab is visible**, and immediately on `visibilitychange`. A hidden tab does not poll (battery), and the drain-on-becoming-visible covers the gap. With the app open, "Queued" becomes "Recorded" in a few seconds; with it closed, on next unlock — exactly as the copy promises.

*ponytail: a poll, not a push.* A silent web push waking the service worker would be lower-latency and lower-traffic, but it needs notification permission and browsers penalize pushes that show no notification. `GET /api/inbox` on an empty mailbox is one indexed lookup. Revisit if the mailbox gets chatty.

**Commands implemented** (`web/domain/tgcommand.js` parses; the relay never does): `/bp 120 80 [pulse]`, `/weight 81.2`, `/note …`, `/intake` (confirms every dose already due). `/food` and `/workout` parse to `unsupported` and say so. An unknown command is answered too — and note that the *client* composes that refusal, because the relay is forbidden from telling `/bp` from `/bogus`.

**Idempotency.** Writes use a deterministic `recordId` of `tg-<mailboxEventId>`, so a crash between flush and ack re-applies the event onto the same row instead of logging a second reading (drain rule 2). `/intake` needs no id — the domain's `PENDING` check is its own guard.

**Retention and logging invariants** (test these, don't trust them):

- **Never `slog` message content.** Not the text, not a typo'd command, not a caption, not the sealed ciphertext. Permitted fields: `ref`/account id, `update_id`, byte length, status codes. This extends the existing trial-proxy invariant (`slog.Info("trial chat proxy", …, "status", N)` logs a status, never a body) and the child-webhook rule already in the code: *"Do not log the raw Telegram payload, as it can contain PII."*
- **No inbox key → drop, never store clear.** `SealAndQueue` returns `ErrNoInboxKey` when `accounts.inbox_public_key` is NULL; the caller must discard the event and reply "Open the app once to finish setting up." Already implemented for callback taps; free-text must follow it.
- **No plaintext column, ever.** `inbox_events` holds `ct` and an ordering timestamp. Any bead proposing a `text` column has misread this section.
- **The relay keeps no copy after the response is written.** Message text lives in the request goroutine and dies with it.

**Consent copy implications** (feeds `med-eas.30`, which is blocked on this). Today's consent screen (`web/cloud/js/telegram.js` → `renderConsent`) covers *outbound* only: "it reads your reminder text." It says nothing about inbound, because inbound was two buttons. Once chat management ships, the copy must add, in the same plain register:

- that messages you send the bot are **read by Telegram and pass through this server in the clear** — because Telegram bots cannot be end-to-end encrypted;
- that the server **seals them immediately and never reads what they mean** — no parsing, no AI, no logs;
- that this is why the bot answers "queued" instead of telling you what it recorded, and that the record appears **when you next open the app**;
- for photos: that the image is **fetched through the server but never stored there**.

The honest one-liner for the consent screen: *"Telegram sees your messages. This server passes them along sealed, and never reads them."*

### Managebot onboarding — invites over chat

The manager bot is also the front door: an ordinary private message to it starts an onboarding conversation (`handleManagerMessage`, `internal/cloudserver/telegram.go`), reached from `ManagerWebhook`'s "not a `managed_bot_created` update" branch. Group chats and messages from bots are ignored — a group adding the managebot must not trigger onboarding — and the handler always answers 200, logging and swallowing every reply/mint failure, because a non-200 makes Telegram retry the update.

Flow, keyed on the sender's Telegram user id:

```
already claimed an account?  yes -> "you already have an account, unlock it with your passkey"   [no mint]
                             no  -> "yes"/"ok"/…      -> mintMu | sweep | live invites >= 3 ? wait message : Provision -> claim URL
                                    /start|hi|help    -> explain + offer
                                    anything else     -> one-line nudge
```

**Provenance: `created_by_account_id` is overloaded.** A managebot mint stores `"tg:<telegram_user_id>"` in that column — do not read every value there as an account id. The column is `TEXT` with **no foreign key** (migration `010`), so three value shapes coexist: a real account id (user-mintable invites), `NULL` (admin-CLI invites), and `tg:<uid>` (managebot). They cannot collide — account ids are opaque and never carry a `tg:` prefix — so the 100/30d per-account quota above and the managebot's own counter are provably invisible to each other (asserted by `TestInviteQuotaIgnoresManagebotProvenance`). One column then serves provenance, the rate limit, and the already-connected check, with no migration and no new table. `ponytail:` promote to a `tg_invite_mints` table only if a second non-account minter ever needs provenance.

**Quota: 3 *live* invites per Telegram user**, hardcoded (`managerInviteQuota`), refused with a plain-language wait message. It mirrors `POST /api/invite`: take `mintMu`, `SweepExpiredClaims`, *then* count — sweeping first because a user sitting at the cap never reaches `Provision`, so their own expired unclaimed invites would otherwise hold slots forever. An invite that expires unclaimed frees a slot.

The counting window is **the claim TTL, not a rolling day**: post-sweep, every surviving row attributed to that user is still claimable, and anything older was minted with an already-passed expiry. A per-day window would only cap the mint *rate*, not the number of claim links a user holds — since claiming happens out-of-band (passkey registration on the subdomain, nothing the bot sees), an abuser could say "yes" three times a day for the whole TTL and bank `3 × TTL/day` claimable links against the one-account-per-person promise. Pinned by `TestManagerOnboarding/day-old_unclaimed_invites_still_occupy_the_quota`.

**Already-connected check is a separate query, not the counter.** The sweep deletes expired *unclaimed* accounts, so a count cannot tell "claimed an account" from "has a pending invite". A claimed account has `claim_token_hash IS NULL` and survives the sweep — `HasClaimedAccountCreatedBy` tests exactly that. Without it, a returning user saying "yes" again would silently collect a second, empty account. A pending invite's link cannot be re-sent (the token is hash-only at rest), so a user with a live unclaimed invite who asks again gets a fresh one — up to the cap of 3 — and the old ones expire on their own.

**No `update_id` dedupe** exists anywhere in this codebase, so a Telegram retry of a `"yes"` mints again. The blast radius is bounded by the two gates: a user who never claims can hold at most `managerInviteQuota` empty accounts (which then expire and sweep), and one who has claimed can mint nothing at all. `ponytail:` a dedupe table isn't worth that.

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
- **The device leg presents its pairing id** (`?pairing=<id>`) and the relay checks it against the
  account's current pairing. A browser `WebSocket` cannot read a handshake HTTP status — a reject and
  a network drop both surface as `onclose` — so both failures accept the upgrade and then close with
  an application code the responder can branch on. The two codes are **not** interchangeable:

  | code | meaning | responder |
  |---|---|---|
  | `4404` `StatusNoPairing` | the account has no pairing at all (relay table is in-memory, 24h TTL, lost on redeploy) | stop, and **purge** the vault record — it is a tombstone pointing at nothing |
  | `4409` `StatusPairingReplaced` | the account has a live pairing, but this leg is not the one serving it | stop, and **do not purge** — release the Web-Lock election so the tab holding the current key takes over |

  The `mcppairing` vault record is CRDT-synced across devices, so a tab that purges on `4409` would
  delete the pairing every other device just adopted. A leg presenting *no* pairing id (an old
  responder from a previous deploy) takes the `4409` path: it cannot prove which pairing it holds.
  Without this check a stale tab reconnects onto the current pairing's device slot, evicts the tab
  holding the right key (`pairingRecord.join` is last-writer-wins), and silently drops every frame it
  cannot decrypt — the connector looks alive and every `mcp_call` times out.

  `4409` is sent from **two** places, and both need it. `DeviceSocket` rejects a leg whose pairing id
  is stale or absent (above), and `pairingRecord.join` closes the leg it evicts when a newer one takes
  the device slot. The eviction case is not the stale-tab case: two *legitimate* devices (phone and
  laptop, both unlocked, both synced to the current pairing) each pass the id check, so they take turns
  evicting each other. An abrupt `CloseNow` there reaches the browser as `1006`, which the responder
  reads as a transient drop and retries — re-evicting its replacement, forever. Closing with `4409`
  makes the loser step aside. (One device leg per pairing is the standing limitation; per-device
  pairings are full-C4 scope.)
- The device answers using the *same operation catalog* as `internal/mcp/registry`, served by
  `web/cloud/js/mcp-responder.js` — `mcp_help` (discover) and `mcp_call` (executed by the
  in-browser domain layer against local data, same construction path as `apishim`).
- **Cloud MCP is a two-tool surface — `mcp_help` + `mcp_call` — by design, not by omission.**
  Bot mode's third tool, `mcp_execute`, forks `python3` subprocesses server-side
  (`internal/mcp/executor/service.go`). That is structurally impossible here: the cloud server
  never sees vault plaintext, so a server-side script runner would have nothing to read. Making
  it work would mean shipping plaintext to the server, which is the one property this whole mode
  exists to prevent. Calling `mcp_execute` against a cloud connector returns an explicit error
  saying so (`web/cloud/js/mcp-responder.js`), rather than an opaque "unknown method" an agent
  would retry; `USAGE_PROTOCOL` also states it up front. Multi-step work is done by chaining
  `mcp_call`, one operation per call.
- **Availability**: every cloud MCP call requires a live, unlocked browser tab. There is no
  server-side fallback — by design, for the same reason. If no device is unlocked and online,
  the call returns an actionable error instead of hanging.
- Running the Python sandbox **in the browser** via Pyodide is the only route that would preserve
  zero-knowledge. It is recorded as a future research spike (see Open questions), deliberately not
  opened: it would ship a ~10 MB WASM runtime into the DEK-bearing page, which interacts with the
  strict-CSP work in med-7e7.1.
- **The catalog is generated, not hand-written.** `web/cloud/js/mcp-catalog.generated.js` is
  emitted from `registry.DefaultOperations()` by `cmd/genmcpcatalog` (logic in
  `internal/mcp/catalogjs`); regenerate with `go run ./cmd/genmcpcatalog`. Nine of the 106
  registry ops are excluded, each listed individually with a `Reason` in `catalogjs.Excluded`:
  the 8 **gamification** ops (deferred project-wide, clamped out of `apishim.js`'s `PORTED_SET`)
  and **`workouts.miband.gps`** (cloud vaults carry no GPS tracks — `vaultToRecords` drops
  `workouts.miband[].gps` on import, so the op could only ever return an empty track; see
  [docs/vault-format.md](vault-format.md)). That leaves **97 ops, every one of them
  dispatchable**. `internal/mcp/catalogjs/drift_test.go` fails CI when a registry op is neither
  in the checked-in catalog nor excluded, and when the checked-in file is stale — the same
  reasoned-exemption shape as `internal/server/mcp_coverage_exempt.go`.
- **`mcp_help` is compact-by-default because of the 64 KiB relay frame cap.** Full entries for
  all ops are ~106 KB, over `mcp_relay.go`'s `maxRelayFrameBytes`; the compact projection
  (`id/topic/method/risk/description/required`) is ~30 KB. Precedence mirrors
  `internal/mcp/help.go`: `operation_id(s)` → full entries, `query` → compact matches (never
  auto-expanded), `topic`/no-args → compact catalog + `usage_protocol`.
- **The `mcp_call` envelope matches bot mode** (`internal/mcp/call.go`): `operation_id` (with
  `op` kept as a back-compat alias), `params`, `path_params`, `body`, `mode`, `intent`. The three
  definitions that must stay in lockstep are `web/cloud/js/mcp-responder.js`,
  `cmd/mcpshim/main.go`'s `callInput`, and `internal/cloudserver/mcp_endpoint.go`'s
  `mcpEndpointCallInput` — `TestMCPCallEnvelopeLockstep` fails CI on drift. `path_params` are
  allowlisted against the op's catalog entry and URL-encoded into the op's `{slot}`s. `params` and
  `body` merge (`body` wins on a key collision) for validation and relative-date repair, then split
  back apart by schema: a key the op declares in `params_schema` but not `body_schema` becomes a
  querystring param, everything else is the request body (GET/DELETE take no body, so all of it is
  query). Arrays repeat their key (`tags=a&tags=b`), objects encode as JSON — the only lossless
  option a flat querystring affords. Schema mismatches produce warn-only `warnings` on the
  response, exactly as `registry.ValidateInput` does — they never block a call. The success
  response is bot mode's `CallResponse`
  (`{status, result, api_calls, warnings?}`) unconditionally: the shape must not depend on the
  input, or an agent that learned where `health.bp.list` puts its rows loses them on the one call
  that happened to trip a warning.
- **Write ops require `mode: 'write'` plus a non-empty `intent`.** Any catalog op with
  `risk: 'write'` is refused otherwise, with an error naming both fields so an agent
  self-corrects. This means an old shim calling `bp.create` with a bare `{op, params}` is now
  refused — intended, not a regression; reads are unaffected. The in-tab callers must state their
  intent too: `features/elevenlabs-call.js`'s voice tools (`log_blood_pressure`, `log_weight`,
  `add_note`) send `mode: "write"` plus an intent, and its generic `mcp_call` forwards whatever
  `mode`/`intent` the agent stated rather than stripping them.
- **Write frames are deduped by GCM nonce.** The sender draws a fresh random nonce per frame, so
  a byte-identical nonce is always a replay (or a catastrophic sender bug). The responder keeps a
  bounded FIFO ring (4096 entries) of seen write-frame nonces, per pairing, persisted in
  `localdb.js`'s local-only never-synced `device` store — so a tab reload does not reopen the
  hole. A duplicate is answered with a JSON-RPC `-32600` rather than dropped silently, keeping
  id-correlation intact. The ring is keyed by `pairing_id`, and every `connectClaude` mints a new
  one, so `disconnectClaude`/`purgePairing` delete the ring alongside the vault record — otherwise
  each connect/disconnect cycle would strand one ring key forever (the FIFO cap bounds one ring's
  size, not how many rings exist). **Residual gaps**, all closed by the same durable fix (a counter
  bound into the frame AAD), deliberately left to future work:
  - Read frames are not deduped (a replayed read is idempotent).
  - A relay that floods distinct nonces can eventually evict and replay a very old write frame.
  - The ring is per-pairing **but also per-device** — `device` is a local-only store, never synced.
    An honest relay keeps one device leg per pairing, but a *malicious* one can answer a captured
    write frame on device A and then replay it to device B, whose ring has never seen that nonce.
    Single-device use (the common case) is fully protected; two simultaneously-unlocked devices are
    not. Sharing the ring through the oplog would replicate every nonce and is not worth it.
- **Every catalogued op is dispatchable, through the router the UI already uses** (med-csu.3).
  `createDispatcher({ router })` takes `apishim.js`'s `createApiRouter` — the same
  `(endpoint, method, body)` function `window.offlineAwareApiCall` is assigned to — and dispatches
  by *catalog coordinates*: the entry's `method` + `path` are exactly what the router is keyed by,
  so `mcp_call` is a `BY_ID` lookup, a path-param substitution, a querystring build, and one
  `router(...)` call. There is **no second dispatch table** to drift from the first, and no domain
  logic in the responder — an op that needs behavior `web/domain/*` lacks gets it added *there*,
  shared with the UI, never branched into `mcp-responder.js`. MCP and the cloud frontend are one
  code path, which is the JS-side statement of CLAUDE.md's domain-service rule.
  - Because dispatch routes by path, `apishim.js:678`'s unmapped-route `throw` doubles as the
    coverage assertion: a catalogued op the router cannot serve surfaces as a JSON-RPC `-32603`
    naming the missing `METHOD /path`. The sweep in `web/cloud/js/tests/mcp-responder.test.js`
    drives **all 97 ops** (63 of them writes, with payloads synthesized from each op's `required`)
    through the real router and fails naming any op that 404s. A companion test asserts the 35 ops
    carrying a `response_example` return that shape. Do not soften that 404 — it is load-bearing.
  - `food.log.from_description` (AI parse) and `food.products.search` (food DB) reach outside the
    vault. Both reuse C2c's **direct-from-browser** path (the same `foodAI`/`food` instances behind
    `CloudFoodAI`/`CloudFoodSearch`), never the relay — routing them through it would hand the
    server plaintext and break the property cloud mode exists to provide.
- **The honest constraint: a device must be online with an unlocked vault.** A phone with the PWA backgrounded is not reliably reachable (iOS SW execution on push is too constrained to serve queries silently). Realistic availability = a desktop tab left open, or an old phone plugged in at home with the PWA foregrounded — at which point the user has voluntarily re-invented a tiny server, but it's *their* device, zero config, and the guarantee holds. When no device is online, the shim's tools return an actionable MCP error naming the E2E architecture and telling the user to open and unlock their app.
- **PoC ceilings** (each `ponytail:`-marked in code): in-memory pairings, single pairing per
  account, no QR pairing, no packaged shim binary/release artifact.

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
| TG bot token, chat id, TG message text at user-chosen verbosity | cloud + Telegram | opt-in; **the relay reads `tg_text` in plaintext by construction** — a bot channel cannot be end-to-end encrypted. Verbosity defaults to `detailed` (names the medication); Settings → Notifications → *Telegram Reminder Detail* switches it to `generic` ("Medication time", no names). Only entries with `delivery` of `telegram`/`both` carry any text at all; `ct` stays opaque. Sealed inbound is C3b part 2 |
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
- **Food-DB direct + operator proxy**: `web/cloud/js/fooddb.js` searches/looks up barcodes with `X-API-Key` from the vault (may be empty) against `integrations.food.url` browser-direct when set. Otherwise, it falls back to the operator default. The operator default is `CLOUD_FOOD_DB_URL` on `cmd/cloud`, injected into the served page via `cloud-boot.js`'s config path — a URL, not a secret. Requests to the operator default are routed through a same-origin proxy on the cloud server (`/api/food/search`, `/api/food/barcode/`) to bypass CORS restrictions, while BYO configurations remain strictly browser-direct. The proxy authenticates to a keyed upstream with `CLOUD_FOOD_DB_API_KEY`, forwarded as `X-API-Key` (same header bot mode sends from `FOOD_API_KEY`); that key is operator-owned and carries TrialConfig's security invariant — never a meta tag, response body/header, or log line. Absent env = remote search degrades to local-only; `search()` still returns `[]` rather than throwing, but `remoteConfigured()` reports false so `products.js` renders an explicit "Food database not configured" status instead of "Found 0 result(s)." (med-1j1). Settings → Integrations shows the effective default as the food-URL field's placeholder (visible-but-unadvertised override).
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
- **Route table** (`web/cloud/js/apishim.js`): the query-param CRUD style (`/create`, `/update`, `/delete`, `?id=`) is preserved verbatim rather than folded into a combined GET+POST base path like bp/weight/food. `rotation/state`, `rotation/initialize`, `exercises/unique` and `sessions/schedule` have no frontend caller but are catalogued MCP ops, so med-csu.3 routed them too. Still intentionally unmapped, falling through to the unmapped-route warning (a code comment in the shim lists them so the warn stays interpretable): the legacy `session/snooze`/`session/skip` compat routes and the external Mi Band Notify webhook.
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
- **Explicitly not exported** (skip list, `docs/vault-format.md`): push subscriptions (device-bound), login nonces, `intake_reminders` (Telegram message ids), `change_events`, download cursors, `workout_schedule_snapshots` (write-only — `ListGroupSnapshots` has zero callers, so nothing can read the data back), the cloud `nk` record, voiceprovisioning. **Exported but sensitive**: the `integrations` provider keys and the `api_tokens` rows — see the secrets toggle below.
- **Coverage is guarded both ways** (`internal/server/vault_coverage_test.go`): `seeddemo.WipedTables()` is the authoritative "what belongs to one user" manifest, and the test pins it against a declared `vaultCovered` set + a `vaultSkipped` map of table → Reason. Anything wiped but not exported is silent data loss on restore; anything exported but not wiped doubles up on import. Both directions fail with the offending table name.
- **A vault is a server migration, not just a backup.** Post-C2e follow-up (`docs/plans/2026-07-08-vault-coverage-gaps.md`) added the four blocks a restore needed to reproduce the install: `settings.bp_reminder` / `settings.weight_reminder` (the bp/weight reminder-state siblings of the already-carried `med_reminder_pref` — enabled flag, snooze, don't-remind-until, preferred hour), `data.gamification` (targets + ledger + state; also added to `WipeUserTx`, which previously left a prior user's HP in place), `tz.transition_plans` (**all** plans oldest-first, not just the latest active/pending — past plans are history), and `data.api_tokens` (`token_hash` only; exporting the hash is exactly what makes an existing MCP/API token keep working on the new server). Cloud carries gamification, api_tokens and non-current tz plans as passthrough records (verbatim body, never read by a cloud feature) exactly like `tzhistory`.
- **Secrets toggle** — "Include API keys and external provider settings", checked by default. Bot: `GET /api/export?include_secrets=0`; cloud: `CloudVault.exportAll({ includeSecrets: false })`. Off → `settings.integrations` and `api_tokens` are **absent** (not `{}` with empty strings — the two are distinguishable, and only *absent* means "leave alone"). On import, absent → the target's existing keys/tokens survive untouched; present → replaced. The only asymmetric path in an otherwise pure-replace format, so that a secrets-free vault can't silently unconfigure the destination. Cloud's `managedTypesForImport(vault)` narrows `VAULT_MANAGED_TYPES` per file to encode the same rule.
- **Merge-mode import is a documented non-goal** — v1 is replace-only (deterministic ids make a later merge feasible, but nobody asked). Filed follow-ups: merge mode, scheduled/automatic backups, age identity-file (keypair) recipients.

## Voice (ElevenLabs)

Cloud mode runs the ElevenLabs conversational agent **browser-direct**, provisioning the agent and its tools **entirely from code** — the user sets only their ElevenLabs API key, nothing touches the ElevenLabs dashboard (bd med-eas.26). Plans: `docs/plans/2026-07-06-cloud-voice-elevenlabs-mcp-poc.md` (the in-tab-dispatch spike), `docs/plans/2026-07-06-cloud-voice-auto-provision-agent.md` (from-code provisioning).

- **Provisioned from code, key is enough.** `web/cloud/js/elevenlabs-agent.js` `createElevenLabsAgentProvisioner({ settingsDomain })` reads the vault `elevenlabs.api_key` and calls the ElevenLabs Agents/Tools API browser-direct (CORS-open). `provision()` orchestrates `ensureTools()` → `ensureAgent()`: `ensureTools()` lists `GET /v1/convai/tools`, matches our fixed spec list by name, and `POST /v1/convai/tools` (the `{tool_config:{type:"client",...}}` shape) for any missing → `{name→id}` map; `ensureAgent(toolIds)` `POST /v1/convai/agents/create` with `tool_ids`, a strong system prompt (always call a tool for any bp/weight/notes question, never claim no access), `tts.voice_id`, and `tool_call_sound:'typing'` + `tool_call_sound_behavior:'always'` for the audible tool-call cue. **Idempotent by `TOOLSET_VERSION`**: the provisioned `{agentId, toolsetVersion, toolIds}` is persisted to a dedicated `voiceprovisioning` vault singleton (`settingsDomain.get/setVoiceProvisioning`) and reused on a matching version — reprovision only on first run or a version bump, never per call. If the user pre-set `elevenlabs.agent_id`, that agent is `PATCH`ed instead of creating one. Published as `window.CloudElevenLabsAgent` from `apishim.js`. The concrete tools are: `get_blood_pressure`(days?)/`log_blood_pressure`(systolic,diastolic,pulse?), `get_weight`/`log_weight`(kg), `get_notes`/`add_note`(text,tag?) — flat typed params, one per catalog op, which voice LLMs call more reliably than a generic `mcp_call`.
- **Signed URL is minted in the browser, not the server.** Bot mode hits `GET /api/elevenlabs/signed-url` (server-side, to hide the operator key); cloud has no such route, which is why "Call Agent" 404'd. `web/cloud/js/elevenlabs-signed-url.js` `createElevenLabsClient({ settingsDomain })` `fetchSignedURL(agentId)` takes the provisioned agent id (falling back to the vault `agent_id` if set) and calls `GET https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=<id>` with the `xi-api-key` header directly. Published as `window.CloudElevenLabs` from `apishim.js`; `startCall()` in `web/static/js/features/elevenlabs-call.js` cloud branch calls `window.CloudElevenLabsAgent.provision()` first, then `fetchSignedURL(agentId)`, surfacing provisioning errors as the call status. **The BYO ElevenLabs key never crosses `/api`** — it goes browser→ElevenLabs only.
- **Concrete tools dispatch in-tab, no relay.** At `startSession`, cloud mode registers `clientTools` whose names match the provisioned tools; each callback dispatches into `window.CloudMCPDispatcher.handle(...)` (the `createDispatcher({ router })` catalog the Claude connector uses) — e.g. `log_blood_pressure({systolic,diastolic,pulse})` → `bp.create {measured_at:<now ISO>, ...}`, `get_blood_pressure({days})` → `bp.list`. Writes stamp `measured_at`/timestamps = now client-side to match the catalog op schemas. The generic `mcp_help`/`mcp_call` stay registered too (harmless), but the concrete tools are the used path. No relay hop, no crypto — the tab is both the voice client and the MCP responder host, online + unlocked during its own call. Bot mode passes no `clientTools` (unchanged); nothing goes to the cloud server.
- **No manual dashboard steps.** The user sets only the ElevenLabs API key in Settings → Integrations (the Agent ID field is optional — blank means the app creates the agent). Leakage note: ElevenLabs' cloud sees tool names, results, and transcripts (inherent to any cloud voice agent); under BYO keys that's strictly user↔ElevenLabs — the zero-knowledge server sees nothing, and the key is used only against `api.elevenlabs.io`, never `/api`.
- **CSP**: the account-app CSP (`internal/cloudserver/router.go` `setSecurityHeaders`) keeps `script-src 'self'` — **no third-party script executes on the DEK-bearing page**. The `@elevenlabs/client` SDK is vendored (`web/static/vendor/elevenlabs-client.min.js`, re-vendor with `esbuild --bundle --format=esm --minify`) rather than loaded from esm.sh (bd med-7e7.1). `script-src`/`worker-src`/`media-src` still allow `blob:`/`data:` on account subdomains because the SDK builds its AudioWorklets from blob: URLs; those are same-origin-authored blobs, and an attacker able to mint one already has script execution. `TestRouter_HostVariants` asserts no host ever reappears in `script-src`. The remaining accepted weakening on this page is `connect-src 'self' https:` (browser-direct BYO provider calls) — sandboxing those into a worker/iframe without DEK access is tracked separately.
- **Scope**: the *concrete* voice tools stay the 6 flat-param ones (bp/weight/notes list/create) — voice LLMs call those more reliably than a generic `mcp_call`. The generic `mcp_call` the agent may also reach for now dispatches the full 97-op catalog, since med-csu.3 gave the in-tab dispatcher the same router. Server-initiated / off-device voice is the separate med-65c relay path.

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
- **C3b — Telegram delivery + inbound** (after C0c):
  - **Outbound (implemented, med-76c.1)** — delivery flags on the scheduled queue (`webpush|telegram|both`) with client-composed verbosity (`detailed` default / `generic`), relay-side Telegram sending through the sealed bot token, honest consent copy. Delivery is **at-most-once**: the relay marks a row sent whatever either channel returned, so an unlinked chat or revoked token can never re-fire a reminder forever, and a `both` entry can never double-send its Telegram half. Migration `011_push_delivery.sql`.
  - **Inbound (implemented, med-76c.2)** — inline Confirm/Snooze buttons plus the sealed inbound mailbox, in two parts. Part 1 (PR #511) shipped the `mt/v1/inbox` sealed box, `accounts.inbox_public_key` + `inbox_events`, the `PUT/GET/DELETE /api/inbox*` endpoints and the `SealAndQueue` write seam. Part 2 added `tgclient` `CallbackQuery`/`answerCallbackQuery`/inline keyboards, the `callback_query` branch in `ChildWebhook`, a per-entry `tg_callback` stem on the queue (migration `013_push_tg_callback.sql`), and the client drain. The drain protocol is implemented as specified above:
    1. **Ack after flush** — `drainInbox` awaits `sync.js flushConfirmed(ctx)` and only then `DELETE`s the event. An unconfirmed flush leaves it queued.
    2. **Idempotent re-apply** — a Confirm targets the deterministic `intake-<medId>-<slotUnix>` ids at that slot; a re-drain finds them already `TAKEN` and the domain's `not_pending` guard (swallowed by `inbox-apply.js`) prevents a second inventory decrement.
    3. **Concurrent drainers** — the mailbox `DELETE` is per-event and account-scoped, so the first ack wins and a second is a no-op; a losing drainer's `confirm()` raises `not_pending`, which converges.
    4. **Server-timestamp order** — events are sorted by the sealed `at_unix` (not mailbox arrival order) and intakes are backdated to it, so a Confirm tapped at 09:00 records `taken_at` 09:00 even when the app first opens at noon.

    A tap on an account that has never unlocked a client has no inbox key to seal to; it is **dropped**, never stored readable, and the user is told to open the app once. Free-text commands (`/bp 120/80`, `/food two eggs`) ride the same mailbox and remain future work (med-vcv, med-eas.29).
- **C4 — MCP tier 1 + tier 2 PoC (implemented)** — tier 1: blind relay (`internal/cloudserver/mcp_relay.go`) + Go shim (`cmd/mcpshim`, crypto/framing in `internal/mcpshim`) + browser responder (`web/cloud/js/mcp-responder.js`), originally with a hardcoded `bp`/`weight`/`notes` catalog (`docs/plans/2026-07-05-cloud-c4-poc-mcp-blind-relay.md`), now serving the 97-op catalog generated from `internal/mcp/registry` by `cmd/genmcpcatalog` (`docs/plans/20260710-cloud-mcp-catalog-codegen.md`), every op of it dispatched through the shared `apishim` router (`docs/plans/20260710-cloud-mcp-dispatcher-wiring.md`). Tier 2: consented hosted-relay mode — persistent `mcp_remote` registry + streamable-HTTP endpoint (`internal/cloudserver/mcp_remote.go`, `mcp_endpoint.go`) + devices-page mode picker (`docs/plans/2026-07-06-cloud-c4-poc-remote-mcp-endpoint.md`). See "MCP" section above. Multi-pairing (remote + local simultaneously), OAuth 2.1 + DCR, `mcp_execute` (no cloud path — med-csu.4), and shim binary distribution are the identified full-C4 follow-ups; go/no-go decided at the PoC's exit review.
- **C5 — trial provider pool**: metered OpenAI-compatible relay, ElevenLabs signed-URL minting + client-tools voice agent, trial-consent wizard screen, quota admin. Depends on C2 (the PWA needs AI features to call it).
- **C6 — bot-mode domain unification** (after C2 parity; optional but intended): embed the JS domain layer in the server build (goja preferred, Node sidecar fallback) behind a SQLite storage port; shadow-mirror real traffic (Go serves, JS diffs, divergences logged); flip per-domain when quiet; deprecate the Go domain layer. Ends the double maintenance — see "The client: porting the domain layer" §3.

Open questions: trial quota sizing; Managed-Bots empirics (per-manager bot limits, user revocation/takeover semantics, library vs raw Bot API HTTP); end-to-end validation of ElevenLabs SDK client tools (designed in `docs/plans/2026-05-18-elevenlabs-dynamic-mcp-client-tools.md`, never implemented); ElevenLabs agents-API coverage of tool/agent provisioning; Pyodide for `mcp_execute`; account deletion + full-vault export format; oplog schema versioning across client updates; how far to take SW-pinned-code / reproducible-build mitigations for the code-serving caveat.
