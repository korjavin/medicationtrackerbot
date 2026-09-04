# Architecture

**Status:** normative and current. **Last verified against the code:**
2026-07-31.

This is the shipped system: a cloud service (`cmd/cloud`) built around a
**zero-knowledge vault**, serving one installable PWA per account over
per-account subdomains. All health logic runs in the browser; the server stores
ciphertext and operates relays.

That guarantee is scoped to the vault. A handful of **optional integrations**
deliberately reach outside it and carry plaintext past the operator by design —
they are enumerated with code evidence in the generated
[privacy boundary table](cloud-mode.md#privacy-boundary--the-vault-promise-and-its-carve-outs),
and §8 below explains why that table is generated rather than written. Never
describe the whole service as zero-knowledge.

Companions: [threat-model.md](security/threat-model.md) (trust boundaries and
residual risks), [cloud-crypto.md](cloud-crypto.md) (key formats and
ceremonies), [cloud-mode.md](cloud-mode.md) (per-subsystem detail and the
generated privacy boundary table),
[cloud-deployment.md](cloud-deployment.md) (running it),
[frontend.md](frontend.md) (the browser app's own structure).

## 1. Shape of the system

```
┌──────────────────────── the user's device ─────────────────────────┐
│  Installed PWA, served from https://<petname>-<rand>.app.<domain>  │
│                                                                    │
│  web/static/         the UI — screens, design system, offline      │
│        │  /api/* (in-process, never a network call)                │
│  web/cloud/js/apishim.js   routes /api/* into the domain layer     │
│        │                                                           │
│  web/domain/*.js     the domain layer: pure ES modules, injected   │
│        │             ports (records, now, timeZone) — no globals   │
│  web/cloud/js/sync.js + localdb.js                                 │
│        │             encrypted oplog client + IndexedDB mirror     │
│  web/cloud/js/crypto.js    DEK, envelopes, record AEAD             │
│  web/cloud/sw.js           service worker: push decrypt under NK   │
└───────────────────────────────┬────────────────────────────────────┘
                                │ TLS. On the vault path every body
                                │ is ciphertext the server cannot open.
┌───────────────────────────────▼────────────────────────────────────┐
│  cmd/cloud → internal/cloudserver                                  │
│    · wildcard host routing, per-account CSP                        │
│    · WebAuthn registration / login, envelopes, device lifecycle    │
│    · encrypted oplog + snapshot compaction (ciphertext in, out)    │
│    · blind push relay: (fire_at, ciphertext) → Web Push            │
│    · sealed inbound mailbox                                        │
│    · optional Telegram relay, optional MCP relay                   │
│    · plaintext-carrying proxies, each disclosed: trial AI/voice,   │
│      operator-default food DB, RxNav                               │
│  internal/cloudstore → cloud.db (SQLite)                           │
└───────────────────────────────┬────────────────────────────────────┘
                                │
        push services · Telegram · AI/voice providers · RxNav · food DB
```

The load-bearing property: **`/api/*` is not a network protocol here.** The UI
issues the same calls it always did, and `apishim.js` answers them in-process
from the local decrypted mirror. The network is used only to move ciphertext.

## 2. Code layout

**Entry point**

- `cmd/cloud/` — the service. Also carries the admin CLI subcommands
  (`invite`, `list`, `inspect`, `reset-claim`, `revoke`, `delete`); there is no
  admin HTTP surface.

Other `cmd/` directories exist for developer and operator tooling — notably
`cmd/mcpshim` (the local MCP shim users run on their own machine),
`cmd/genmcpcatalog` and `cmd/genvapid` (code/key generation), and
`cmd/feedbackpull` (drains the blind feedback queue on the developer's machine,
the only place the age private key lives). What a published image contains is a
build-and-release question, not an architectural one — see
[cloud-deployment.md](cloud-deployment.md).

**Server** (`internal/`)

- `cloudserver/` — all HTTP handling: host routing and security headers
  (`router.go`), WebAuthn ceremonies (`webauthn.go`), envelopes and device
  lifecycle (`device.go`, `transfer.go`, `recovery.go`), encrypted sync
  (`sync.go`), push subscriptions + the relay loop (`push.go`, `relay.go`),
  the sealed inbox (`inbox.go`), invites (`invite.go`, `provision.go`),
  Telegram (`telegram.go`, `tg_token.go`), MCP (`mcp_relay.go`,
  `mcp_remote.go`, `mcp_endpoint.go`), and the disclosed plaintext proxies
  (`trial_proxy.go`, `food_proxy.go`, `rxnav_proxy.go`,
  `vitals_import_api.go`).
- `cloudstore/` — `cloud.db` repository: accounts, credentials, envelopes,
  recovery verifiers, oplog + snapshots, push queues, inbox events, invites,
  feedback. **Own migrations.** It imports `internal/store/db` and *never*
  `internal/store` — the two register goose migrations into the same global
  registry, so importing both would try to run one schema against the other's
  database.
- `webpush/`, `tzlookup/`, `mcp/registry` (the operation catalog that the
  browser MCP responder is generated from), `nxk` (Mi Band backup parser).

**Browser** (`web/`)

- `web/domain/*.js` — the domain layer. **Runtime-agnostic by rule**: injected
  ports only, no `window`/`document`/`fetch`/`indexedDB`. Enforced by
  `architecture.domain-purity.test.js`. `bp`, `weight`, `medications`,
  `intake`, `medschedule`, `reminders`, `tzplan`, `food`, `foodai`, `workout`,
  `vitals`, `notes`, `settings`, `tgcommand`, `vault`.
- `web/cloud/js/` — the cloud runtime: `crypto.js`, `sync.js`, `localdb.js`,
  `apishim.js` (the `/api/*` router), `cloud-boot.js` (boot + warm unlock),
  `unlock.js`, `signup.js`, `devices.js`, `push.js`, `aiclient.js`,
  `fooddb.js`, `mcp-responder.js`, `privacy-manifest.js`, `privacy.js`.
- `web/static/` — the UI: screens, the Wandergeek design system, offline
  plumbing. It talks only to `/api/*`.
- `web/cloud/sw.js` — service worker. Decrypts push payloads under NK. It
  never holds the DEK, which is why notification actions are handed to a page
  rather than POSTed by the worker.

## 3. Data model

### 3.1 In the vault (the browser's authority)

The vault is a set of **records**, each `{recordType, recordId, body}`. Bodies
use the same field names the UI already spoke, so there is no third dialect
between the UI, the domain layer, and the export format
([vault-format.md](vault-format.md)).

Conventions that carry real weight:

- **Deterministic record ids where multi-device dedup matters.**
  `intake-<medId>-<slotUnix>`, `session-<groupId>-<date>`,
  `rotation-<groupId>`. Two devices racing the same materialization write the
  same id; last-writer-wins picks one body and both converge.
- **Singletons** carry a fixed recordId — settings, feature flags, tab order,
  food targets, integrations keys, reminder prefs, trial consent.
- **Day-batched vitals.** `hrsample` / `spo2sample` / `stresssample` store one
  record per stream-day holding that day's samples, so a 90-day import does
  not explode into thousands of ops. The domain layer expands them in memory.

### 3.2 On the server (`cloud.db`)

Accounts and subdomains, WebAuthn credentials, DEK envelopes, the recovery
verifier hash, the append-only encrypted oplog and its snapshots, push
subscriptions and the scheduled-push queue, sealed inbox events, transfer
slots, invites, egress-host allowlists, and the blind feedback queue.

Everything in envelopes, oplog, snapshots, and scheduled pushes is ciphertext
under keys derived from secrets the server never sees.

**Migrations** live in `internal/cloudstore/migrations/`, run with goose,
numbered sequentially, and are applied on startup. Never modify an existing
migration; add a new one.

## 4. Sync

- **Encrypted oplog.** Each write produces `{account_seq, device_id,
  record_type_tag, nonce, ciphertext}`. The server assigns the monotonic
  `account_seq`; clients push local ops and pull `since=<cursor>`.
  `account_seq` is bound into the record AAD, so server-side reordering or
  replay is detectable at decrypt time.
- **The type tag is plaintext.** It is what lets a reading device bind the AAD
  without a schema negotiation — and it is a real inference channel, treated as
  such in [threat-model.md §6.1](security/threat-model.md#61-the-plaintext-record-type-channel).
- **Conflict resolution is client-side** — the server cannot merge what it
  cannot read. Last-writer-wins per record on `clientTs`, which is a *merge
  token, not a wall clock*: writes subtract a server-referenced clock offset,
  and a write to a record this device can already see is stamped
  `max(correctedNow, existing.clientTs + 1)` so editing what you can see always
  beats what you are overwriting.
- **Snapshots + compaction.** The server cannot compact ciphertext, so clients
  periodically upload a full encrypted snapshot (`gzip(utf8(JSON))` before
  AES-GCM) and the server drops ops below that seq. Caps: 64 KiB per op, 64 MiB
  decoded snapshot ciphertext (`internal/cloudserver/sync.go:22,35`).
- **Local durability.** Writes queue to a `pending` store first. Three
  consecutive *permanent* 4xx failures set `syncWedged`, which pauses the
  re-post loop rather than retrying forever; transient failures never wedge.
  "Reset local sync" clears `records`/`pending`/`sync_meta` in one IDB
  transaction and re-bootstraps from the server snapshot.

## 5. Reminders

The server is a **blind alarm clock**. It cannot compute "when is the next
dose" — the client does:

1. The client computes every reminder for the next horizon and uploads
   `(fire_at, app_ciphertext)` rows, replace-all per sync.
2. At `fire_at` the relay wraps that ciphertext in RFC 8291 Web Push
   encryption per subscription and sends. Two independent layers: the push
   service cannot read RFC 8291 payloads, and the server cannot read the app
   layer.
3. The service worker decrypts the app layer under NK and shows a rich
   notification; with no NK available it shows a generic one.
4. Every app open refreshes the horizon. If the user never opens the app the
   horizon lapses — the server *does* know last-sync time, so it sends a
   generic escalating warning rather than silently stopping.

**Telegram dose reminders and the re-fire chain.** A med reminder sent over
Telegram carries `Confirm`/`Snooze` buttons whose `callback_data` is the slot
stem `s:<slotUnix>`, and the relay re-arms an hourly re-fire after every send
until ~6h past the slot. Because 64 bytes of `callback_data` cannot hold a set
of medication ids, the identity of the meds a reminder names rides on the
**queued row** instead (`scheduled_pushes.tg_med_ids`, cleartext like
`tg_text`), is copied down the re-fire chain, and is sealed into the tap event.
So (bd med-kbpf):

- a **Confirm tap cancels the chain server-side, immediately** — the tap is the
  user's explicit statement, and the event names the doses;
- the **drain confirms by identity**: per named med, the deterministic
  `intake-<medId>-<slotUnix>` row, else that med's nearest PENDING dose within
  its own `minDoseInterval` (the drift fallback);
- the drain **re-arms one re-fire** (`POST /api/telegram/rearm-refire`) only if
  a named med is still due afterwards. An in-app confirm, which produces no
  tap, still cancels via `POST /api/telegram/cancel-refire`.

An in-app terminal transition (dose confirm, workout complete/skip/start, a BP
or weight reading logged in the app) calls
`cancel-refire` with the reminder's own stem, which drops the pending re-fire
**and** best-effort deletes the last live message for `s:`/`w:`/`bp:`/`wt:`
alike — the stem is validated with `tgclient.ValidCallbackStem`, and the message
id comes from the sent row's `tg_message_id` (recorded by `MarkPushSent`, and
scrubbed on the same 48h sweep, which is also Telegram's bot-delete window).
For the measure reminders the shim rebuilds the stem from the pref itself
(`measureReminderStem`, `web/domain/reminders.js`): today's slot at the
configured local hour, and only once that hour has passed — a slot still ahead
has not been sent, so there is nothing live to cancel. It also applies the
horizon's own satisfaction window (12h for BP, 7d for weight) to the reading's
`measured_at`, so backdating a catch-up entry does not delete a reminder the
user never answered (med-9bmb).

The sent row keeps the callback stem and the ids (only `ct`/`tg_text` are
scrubbed on send), so a tap resolves for 48h after the last send —
`ScrubSentPushIdentity`, run by the relay's hourly sweep, expires them at the
same window the retired `slotmeds` records used. A tap with no ids (a reminder
pushed before this shipped, or one older than that window) applies nothing and
says so, rather than guessing from a time band.

**Subscription eviction** is reconciled on every boot: `ensurePushSubscription()`
demands a live `pushManager.getSubscription()` and re-subscribes if it is gone,
which also heals the server row. A `pushsubscriptionchange` handler is the
belt; it is not reliable enough to be the only layer.

**Per-account VAPID keys** mean a relay bug that misrouted account A's payload
to account B's endpoint is rejected by the push service itself — a third
enforcement layer.

## 6. Identity and account lifecycle

- **Registration is invite-only, always.** There is no public signup surface.
  An invite pre-provisions the account and yields a one-time claim URL.
- **The subdomain and `account_id` are server-assigned** at provisioning time
  (`internal/cloudserver/provision.go:83`, `:87`). Only *key* material — DEK,
  KEKs, PRF outputs, recovery code — is client-generated; the client reads the
  server-assigned id out of the WebAuthn options
  (`web/cloud/js/signup.js:141-144`).
- **Per-account origin.** Browser storage, service workers, and push
  subscriptions are per-origin, so each install is isolated by the platform
  with no multi-account state to manage. The unguessable name is a moat, not
  authentication.
- **Unlock** is a passkey ceremony; warm unlock uses a per-device
  non-extractable key so sync does not demand a biometric per launch. Full
  ceremonies in [cloud-crypto.md](cloud-crypto.md).
- **Account deletion** removes every account-keyed row in one transaction
  (coverage discovered from the schema, not a hand-kept list) and wipes the
  local vault twice — before the server call, so a blocked wipe fails while the
  account is still intact, and after, as the load-bearing erase.

## 7. MCP

The operation catalog in `internal/mcp/registry` is generated into
`web/cloud/js/mcp-catalog.generated.js` by `cmd/genmcpcatalog`; a drift test
fails CI when the checked-in file is stale or an op is neither catalogued nor
explicitly excluded.

Every catalogued op is dispatched **through the same router the UI uses** —
`createDispatcher({ router })` over `apishim.js`'s `createApiRouter`, keyed by
the catalog entry's own `method` + `path`. There is no second dispatch table
and no domain logic in the responder: an op needing behavior the domain layer
lacks gets it added to `web/domain/*.js`, shared with the UI.

Two connection tiers, and the difference is a trust decision:

- **Tier 1** — a local shim (`cmd/mcpshim`) over a blind WebSocket relay.
  Frames are opaque; the relay sees sizes, timing, and pairing ids.
- **Tier 2** — the operator runs the shim so hosted clients can connect
  directly. The server therefore sees query and response content in transit.
  Off by default, per-account, consent-gated.

Both require a live, unlocked tab to answer. There is no server-side fallback,
by construction — the server has nothing to read.

## 8. Privacy boundaries are generated, not written

`web/cloud/js/privacy-manifest.js` is the single source of truth for what
leaves the vault. The boundary table in
[cloud-mode.md](cloud-mode.md#privacy-boundary--the-vault-promise-and-its-carve-outs)
is generated from it (`pnpm privacy:docs`) and Settings → *What can the
operator see?* is rendered from it.

`web/cloud/js/tests/architecture.privacy-claims.test.js` scans the real call
sites — outbound HTTP, `proxyUpstream`, `webpush.Send`, `tgclient.`,
`SealAndQueue`, `nxk.` in `internal/cloudserver/*.go`, plus every literal
third-party host in the Go and browser sources — and fails CI on anything no
manifest entry claims. Adding an egress path means adding a manifest entry with
real `file:line` evidence and user-facing copy, then regenerating.

Do not flatten the three activation classes when summarizing: the
operator-default food DB and RxNav have **no toggle**, and RxNav has **no
bring-your-own alternative at all**.

## 9. Conventions

- **Logging.** `log/slog` with contextual args (`slog.Error("msg", "error",
  err)`), never `log.Printf`. Never log message content, provider keys, claim
  or recovery secrets, raw push endpoints (fingerprint them —
  `internal/cloudserver/log_redact.go`), or drug-name query strings.
- **Frontend tests are integration-first**, driven through the owning feature
  suite. See [frontend.md → Testing posture](frontend.md#testing-posture).
- **The domain layer stays pure.** No browser globals in `web/domain/`. This is
  the seam that keeps the layer embeddable outside a browser, and it is
  test-enforced.
- **Server tests** use `httptest` against the real `cloudstore` on an in-memory
  SQLite database.
