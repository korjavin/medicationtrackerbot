# Cloud-mode deployment

Self-hosted deployment guide for the `cloud` binary (`cmd/cloud`): a zero-knowledge
cloud service on wildcard subdomains. See [cloud-mode.md](cloud-mode.md) for the
design and [cloud-crypto.md](cloud-crypto.md) for the crypto spec.

Two-layer setup: a static infra layer (Traefik + Portainer) run once with plain
`docker compose`, and the app stack deployed as a Portainer gitops stack —
mirroring this repo's existing bot deployment pattern.

## 1. DNS

Point both `<base>` and `*.<base>` at the server's IP. On Cloudflare, set the
wildcard record to **DNS only (grey cloud)**, not proxied — Cloudflare's proxy
only covers `*.<apex>` wildcards on paid plans, and proxying would terminate
TLS at Cloudflare instead of the origin's wildcard cert.

## 2. Infra layer (once, on the fresh server)

Mint a scoped Cloudflare API token: Zone → DNS → Edit, restricted to the single
zone containing your base domain.

```bash
cp .env.infra.cloud.example .env
# fill in CLOUD_BASE_DOMAIN, ACME_EMAIL, CF_DNS_API_TOKEN
docker compose -f docker-compose.infra.cloud.yml up -d
```

Verify the wildcard cert issues on first request (`docker compose -f
docker-compose.infra.cloud.yml logs traefik`) and that individual subdomains
don't leak into public CT logs (DNS-01 issuance for the wildcard doesn't log
per-subdomain names).

## 3. App stack (Portainer gitops)

Open `https://portainer.<base>`, finish the initial admin setup, then:

1. Create a stack from a Git repository: this repo, `deploy` branch,
   compose path `docker-compose.cloud.yml`.
2. Set stack env vars: `CLOUD_BASE_DOMAIN`, `SESSION_SECRET` (≥32 chars,
   Shannon entropy ≥3.5 — same rule as the bot's session secret). Push is
   zero-config: each account gets its own VAPID keypair generated
   server-side at invite provisioning, no `genvapid` step and no
   `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` to set. Optionally set
   `VAPID_SUBJECT` (defaults to `mailto:noreply@<CLOUD_BASE_DOMAIN>`) to
   change the operator contact identifier in the push JWT. Other optional
   tuning: `CLOUD_ACCOUNT_QUOTA_BYTES` (per-account oplog+snapshot storage
   cap, default 50MB, 0 disables) and `CLOUD_DRY_QUEUE_WARN_HOURS` (default
   120 — how close the last unsent reminder must be before the hourly sweep
   warns a stale-synced account). See [environment.md](environment.md).
3. Enable the stack's redeploy webhook and append its URL as a new line in
   the `PORTAINER_REDEPLOY_HOOK` GitHub secret (multiline — one URL per line,
   same secret the bot stack already uses).

Operators who don't want gitops can instead run
`docker compose -f docker-compose.cloud.yml up -d` directly against the same
external `proxy` network.

## 4. Mint the first invite

```bash
docker exec -it medtracker-cloud ./cloud admin invite
```

Prints the claim URL (and a terminal QR) for the operator to hand to the
first user. See [cloud-mode.md](cloud-mode.md) for the claim → passkey →
Emergency Kit flow this link starts.

## 5. Admin commands

`docker exec -it medtracker-cloud ./cloud admin <subcommand>` — every
subcommand opens its own DB handle, so these are safe to run at any time
against a live container:

- `invite` — pre-provision an account and print its claim URL + QR (above)
- `list` — one line per account: subdomain, claimed?, created, device count,
  op count, last sync activity
- `inspect <subdomain>` — full read-only debug view of one account: devices,
  envelopes, sync state, push queue. Answers "did the phone's write reach the
  server?", "does device 2 have an envelope?", "did snapshot compaction run?",
  "is the push queue draining?" without sqlite3 spelunking. Never prints
  secrets — claim tokens, nonces, MACs, and ciphertext bytes are omitted;
  only sizes, counts, and timestamps. Credential ids and envelope refs share
  the same 8-char prefix so device↔envelope pairings are eyeball-able.
- `reset-claim <subdomain>` — issue a fresh claim token for an unclaimed
  account
- `revoke <subdomain>` — delete an unclaimed account (withdraw an unused
  invite)
- `delete <subdomain>` — delete an account and all its data (asks for
  confirmation)

Sample `inspect` output (trimmed to one credential per section for brevity —
a real account can have more devices, a bigger record-type histogram, etc.):

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

An empty/unclaimed account renders every section explicitly (`devices: none`,
`envelopes: none`, `sync: ops: 0`, `snapshot: none`, `push: no
subscriptions`) rather than omitting them — a silently vanished section would
hide exactly the bugs this tool exists to surface.

## Serving (C1)

Account subdomains now serve the full `web/static` app (BP + weight ported to
the in-browser `web/domain/` layer, see [cloud-mode.md](cloud-mode.md)), not
just the signup/unlock shell. Routing: `/` → the app's `index.html`; the
unlock/claim/recovery wizard moved to explicit paths — `/unlock`, `/claim`,
`/recover` — still rewriting to the embedded `web/cloud` shell's
`signup.html`; `/api/*` unchanged.

## Local dev loop

`CLOUD_BASE_DOMAIN=localhost` works without any DNS or infra: `*.localhost`
subdomains are secure contexts and resolve without configuration, giving a
full local loop including passkeys on desktop.

## API endpoints (`internal/cloudserver`)

All routes are host-routed off the account's subdomain except where noted.
Full ceremony details: [cloud-crypto.md](cloud-crypto.md).

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/webauthn/register/begin`, `POST /api/webauthn/register/finish` | claim token, enrollment token, or session | Register a passkey — first device (C0a), transfer/recovery target, or an additional local passkey |
| `POST /api/webauthn/login/begin`, `POST /api/webauthn/login/finish` | none | Cold-unlock assertion; issues a session token bound to `credential_id` |
| `GET /api/envelopes`, `GET /api/envelopes/{credential_ref}`, `PUT /api/envelopes/{credential_ref}` | session | Fetch/upload wrapped-DEK envelopes. `credential_ref` is a credential id; `GET` also accepts `"recovery"`, but `PUT` of `"recovery"` is rejected (409) — write the recovery envelope via `PUT /api/recovery-material` |
| `PUT /api/recovery-material` | session | Atomically upload the recovery envelope + its verifier hash in one write (signup, and forced rotation after redemption) — the only write path for recovery material |
| `POST /api/loss-ack` | session | Record the "I understand data is unrecoverable" onboarding acknowledgment |
| `POST /api/transfer` | session | Old device: create a transfer slot (`{ct}`) → `{slot_id, expires_at}`; the enrollment token is minted at claim time, not here |
| `POST /api/transfer/{slot_id}/claim` | none | New device: single-fetch claim → `{ct, enrollment_token}`; 410 once fetched or expired |
| `POST /api/recover` | none | Redeem a recovery-code verifier (rate-limited 5/hour/account) → recovery envelope + enrollment token |
| `GET /api/devices` | session | List credentials joined with their envelopes, for the device-list/audit UI |
| `DELETE /api/devices/{credential_id}` | session | Revoke a device: deletes credential + envelope in one tx; rejects removing the last verified credential unless usable recovery material (recovery envelope + verifier) exists |
| `POST /api/sync/ops`, `GET /api/sync/ops?since=<seq>` | session | Append a batch of encrypted oplog entries (server assigns contiguous `seq`) / page through ops since a cursor. Per-op and per-batch size caps + per-account quota (413 on breach) |
| `POST /api/sync/snapshot`, `GET /api/sync/snapshot` | session | Upload a compacting snapshot (deletes oplog rows `seq <= snapshot_seq`) / fetch the latest snapshot (204 when none) — new-device bootstrap is snapshot + ops-since |
| `POST /api/push/subscriptions`, `DELETE /api/push/subscriptions` | session | Register/remove a Web Push subscription for the relay |
| `GET /api/push/vapid-public-key` | none | Public VAPID key for the browser's `PushManager.subscribe` call |
| `PUT /api/push/schedule` | session | Replace-all: clears this account's unsent future entries, inserts a batch of `{fire_at_unix, ct}` (app-layer-encrypted payloads the sender goroutine fires blindly) |
