# Cloud operations security, retention, and deletion policy

Operator-facing policy for the zero-knowledge cloud deployment (`cmd/cloud`).
It answers, without reverse-engineering code or infrastructure, three
questions about any account's data: **what remains after deletion, for how
long, and where was data sent.**

Scope: the self-hosted cloud (`cmd/cloud`) — the small trusted beta described
in [cloud-deployment.md](cloud-deployment.md). It is a companion to that
deployment guide (secrets, TLS, restore runbook live there) and to
[cloud-crypto.md](cloud-crypto.md) (key formats). It records the operator's
decisions of 2026-07-13; where a production choice was never confirmed, this
document marks it as a **required deployment decision** with a safe default,
not as a settled fact.

> **One-line reality check.** The vault ciphertext, the wrapped-DEK envelopes,
> and the recovery verifier are all the server ever holds; the DEK/NK exist
> only inside an unlocked browser tab. Nothing in this document — no log, no
> backup, no subprocessor — ever holds a decryptable copy of a user's health
> data. Retention below is about *ciphertext and metadata*, not plaintext.

## 1. Logs

### 1.1 What the application logs (and does not)

The app emits structured `slog` key=value lines. Redaction is enforced by
tests, not convention:

- **Provider keys, claim/recovery secrets, Telegram tokens, plaintext request
  bodies** — never logged. `trial.go` / `trial_proxy.go` redaction invariants
  are test-guarded.
- **Push subscription endpoints** — a durable per-device bearer capability —
  are logged only as a truncated-SHA256 fingerprint (`endpoint_fp=fp_…`), never
  the raw URL (`log_redact.go`, `TestNoRawPushEndpointInLogs`). See med-yor.6.
- **RxNav drug-name queries** — the blind RxNav proxy (`/api/rxnav/*`) carries
  drug names in the request **query string**. The app never logs them: the
  proxy uses a fixed-string log invariant and `urlErrCause` sanitization in
  `rxnav_proxy.go` / `proxy_upstream.go`, so an upstream error is logged
  without its URL. **The application log is clean; the reverse-proxy access
  log is the exposure — see §1.3.**
- **Account id** appears in most operational lines (it is not secret; it is
  the subdomain). It is deliberately *not* correlated to any plaintext.

### 1.2 Application-log retention

The `medtracker-cloud` container logs to Docker's default `json-file` driver.
**That driver does not rotate on its own** — an unconfigured host grows
`*-json.log` without bound until the disk fills. Retention is therefore
whatever bound the operator sets, in one of two places:

- **Docker daemon default** (`/etc/docker/daemon.json` `log-opts`) — applies to
  every container on the host.
- **Per-service `logging:` block** in `docker-compose.cloud.yml` — explicit and
  version-controlled, and the recommended posture:

  ```yaml
  services:
    cloud:
      logging:
        driver: json-file
        options:
          max-size: "10m"   # recommended bound — tune to disk + audit needs
          max-file: "3"     # ~30 MB of history retained, older lines dropped
  ```

  The `10m` / `3` figures above are a **recommended default**, not a mandated
  retention period; raise them if you need a longer operational window, lower
  them to shed history faster. Whatever you pick, it is the effective
  retention for anything in the application log (which, per §1.1, is metadata
  and fingerprints — no plaintext health data, no raw capabilities).

### 1.3 Reverse-proxy access logs — required decision

The app's own log is redacted; **your reverse proxy's access log is not**, and
two URL shapes carry sensitive material *in the request line* that most proxies
record verbatim:

- **`/mcp/<token>/…`** — hosted MCP capability tokens travel in the **path**. A
  raw access log becomes a file of live MCP bearer tokens.
- **`/api/rxnav/*?…`** — drug-name lookups travel in the **query string**. A raw
  access log becomes a queryable record of what medications users searched.

**Required deployment decision — safe default OFF / redacted.** Traefik's
access log is off by default and the app stack does not enable it, so out of
the box there is no proxy log to leak. If you enable it:

- **Prefer dropping the path and query entirely.** Set Traefik's access-log
  `fields` to `drop` (or `redact`) `RequestPath` — which covers both the
  `/mcp/<token>` segment and the `?…` RxNav query — while keeping
  `RequestHost`/status/duration for ops signal.
- **The same rule binds every intermediary.** A CDN, WAF, or L7 load balancer
  that logs paths or query strings must not retain `/mcp/*` or `/api/rxnav/*`.
  A capability or drug name in a URL is logged by *any* hop that logs URLs.

Full config guidance and rationale live in
[cloud-deployment.md → Proxy access logs](cloud-deployment.md#7-operating-it-health-disk-3am).
This is the required-decision + retention half; that section is the keep-it-out-
of-the-log-in-the-first-place half.

## 2. SQLite storage reality — deleting a row is not erasing bytes

`DELETE FROM …` marks rows free; it does not zero the pages. Cloud mode opens
`cloud.db` with `PRAGMA journal_mode=WAL` (unconditional, see
[cloud-deployment.md §6](cloud-deployment.md#6-backups-and-restore)), and
`secure_delete` is **not** enabled. Concretely, immediately after an account is
deleted:

- **Free pages** in `cloud.db` may still contain the old ciphertext bytes until
  those pages are reused by later writes or a `VACUUM`.
- **The WAL file** (`cloud.db-wal`) may hold recently-deleted ciphertext until
  the next checkpoint folds it into the main file (and even then, as free
  pages).
- No routine `VACUUM` or `PRAGMA secure_delete` runs. Reclaiming the bytes is
  incidental (page reuse over time), not immediate.

This is acceptable **because the freed bytes are ciphertext**: recovering a
free page yields wrapped-DEK envelopes and vault ciphertext, not plaintext, and
the account's recovery verifier is deleted in the same transaction, so nothing
that could unwrap them survives. If an operator ever needs prompt physical
reclamation (e.g. a contractual erasure SLA), the levers are `PRAGMA
secure_delete=ON` (write cost) or a post-deletion `VACUUM` — neither is enabled
today, and neither is required by the current threat model.

## 3. Backups

**Today: no server-side backups run.** The reference deployment does not
currently run litestream or any other `cloud.db` replication. (The optional
litestream setup documented in
[cloud-deployment.md §6](cloud-deployment.md#6-backups-and-restore) is available
but not enabled in the current beta.) Consequently there is no backup copy,
snapshot, or off-box replica of any account's ciphertext.

**If backups are ever enabled**, this policy binds them:

- **Maximum retention 7 days.** Any backup / replication target must expire
  every object within 7 days (e.g. an S3/R2 lifecycle rule on the litestream
  prefix). A backup that outlives 7 days violates this policy.
- **Ciphertext-only, isolated credentials.** As
  [cloud-deployment.md → Bucket security](cloud-deployment.md#6-backups-and-restore)
  requires: a private bucket, its own scoped credentials, not shared with the
  bot stack.
- **No plaintext, no keys.** A backup holds exactly what `cloud.db` holds —
  ciphertext, wrapped envelopes, verifiers — and never a DEK/NK.

## 4. Deletion propagation

`DELETE /api/account` (session **+ fresh passkey**) removes every account-keyed
row in one transaction and tears down the Telegram webhook and MCP pairings.
What that means for each place data can live:

| Location | When it is gone |
|---|---|
| **Server database (logical)** | **Immediately.** One transaction removes every account-keyed row; the recovery verifier goes with it. |
| **Server database (physical bytes)** | **Incrementally.** Freed ciphertext pages are reclaimed by later page reuse, not zeroed on delete (§2). |
| **Backups** | **Today: N/A — none exist, so deletion is physically immediate.** Once backups are enabled: by **expiry only** (≤ 7 days, §3). There is **no proactive purge** of backups on account deletion — the operator does not reach into a replica to scrub a deleted account; the object simply ages out within the retention window. |
| **Local device (browser vault)** | Client-side responsibility; the server cannot reach an unlocked tab's IndexedDB/PRF material. Covered by device-side deletion work (med-yor.1 / med-yor.4). |
| **Third parties (§5)** | Governed by each subprocessor's own retention — the server cannot delete data already transmitted to Telegram, an AI provider, RxNav, a food DB, or a push service. |

The user-facing takeaway the deletion UI must convey: **logical server deletion
is immediate; backup removal (once backups exist) is by expiry within 7 days;
and data already sent to a third party is retained per that party's policy, not
ours.** (Exact in-app copy is out of scope here — see the PR handoff to
med-yor.4 / med-yor.1.)

## 5. Subprocessors — who sees what

Every external party sees **only its own small slice**, listed below. **None of
them can ever access the vault, the DEK, or the NK** — those exist only inside
an unlocked browser tab and are never transmitted. There is no row in this
table that implies vault access, because none exists.

| Subprocessor | Feature | Exactly the data slice it sees | Activation |
|---|---|---|---|
| **Trial OpenAI (operator key)** | Food AI parse, chat | The specific prompt text and/or food **photo** the user submits for that request. Routed through the operator's trial key. | Only when the user uses the operator-provided trial AI and has not supplied their own key. |
| **ElevenLabs** | Voice | The **audio / transcript** for that voice interaction. | Only when the user invokes voice. |
| **Telegram** | Reminders, chat interface | The **reminder / chat text** delivered to or from the user's Telegram. | Only if the user links Telegram (optional). |
| **RxNav (via blind proxy)** | Drug interaction / lookup | The **drug-name query** for that lookup. Reaches RxNav through the server's blind `/api/rxnav/*` proxy; the app never logs it (§1.1), but RxNav receives the query to answer it. | Only when a medication lookup / interaction check runs. |
| **Food database** | Product search | The **search terms** the user types. | Only when the user searches products (degrades to local-only if unset — [cloud-deployment.md](cloud-deployment.md)). |
| **Push services** (browser vendor endpoints, e.g. FCM/Mozilla/Apple) | Web Push reminders | An **encrypted, opaque push payload** and the subscription endpoint. Payloads are app-layer encrypted in addition to Web Push encryption; the push service relays ciphertext it cannot read. | Whenever the user has an active push subscription. |

Each slice is scoped to the moment of use — a subprocessor sees a single
request's data, not the account's history, and never the vault behind it. Data
transmitted is thereafter governed by **that party's** retention and privacy
terms, which the operator does not control (§4, third-parties row).

### 5.1 Hosted MCP — limited data horizon

Hosted MCP (Claude pairing) carries an additional guardrail beyond "no vault
access": a **limited data horizon.** A pairing exposes only the scoped window
the connection is set up to answer — the live queries the unlocked tab chooses
to serve — not the full vault and not historical data outside that scope.
Content is answered by the unlocked browser tab over the blind relay and never
reaches the server as plaintext; closing the tab ends the horizon entirely.

### 5.2 Feedback channel — decrypt CLI (`cmd/feedbackpull`)

User feedback is end-to-end encrypted: the browser age-encrypts each submission
to `FEEDBACK_AGE_RECIPIENT` (a public key) before `POST /api/feedback`, and the
server stores only the ciphertext in `feedback_queue`. Plaintext is recovered
**only** on the developer's machine, never on the server.

Setup (one-time):

```bash
age-keygen -o dev.key            # prints the recipient (age1…) to stderr
# set FEEDBACK_AGE_RECIPIENT=age1… on the cloud server (see docs/environment.md)
# keep dev.key OFF the server host — it is the only key that can read feedback
```

Drain + decrypt (developer machine, against a copy of the cloud sqlite DB):

```bash
go run ./cmd/feedbackpull -db cloud.db -identity dev.key -out ./inbox -delete
```

- `-db` (required) cloud sqlite path; `-identity` age private-key file (default
  `$FEEDBACK_AGE_IDENTITY`); `-out` attachment dir (default `./feedback`);
  `-limit` (default 100); `-delete` acks items after a successful decrypt+save;
  `-json` emits one JSON line per item instead of the human render.
- **Fail-open:** an item that fails to decrypt/parse (key rotation, corruption)
  is logged to stderr and skipped — never deleted — so one bad row can't block
  the drain or hide the rest. `-delete` acks **only** successfully-processed
  items.

## 6. Incident response and user notification

- **Log discipline first.** The redaction invariants (§1.1) and the proxy
  required-decision (§1.3) mean a leaked application log, or a correctly
  configured proxy, exposes metadata and fingerprints — not plaintext health
  data, capabilities, or keys. Preserving that property is the primary
  incident-avoidance control.
- **What a database/backup compromise exposes.** Ciphertext plus everything
  needed for an **offline** brute force against every account at once (no rate
  limit, no server in the way). The mitigation is the high-entropy recovery
  material and passkey-PRF DEK, not secrecy of the ciphertext — but a bucket or
  volume disclosure is still a reportable incident.
- **User notification.** On any incident that plausibly exposed account
  ciphertext, metadata, or a subprocessor's slice, notify affected account
  holders. State plainly what class of data was involved (ciphertext vs.
  metadata vs. a specific subprocessor slice) and what, given zero-knowledge
  encryption, it does and does not reveal. Do not overclaim safety ("it was
  encrypted, nothing to worry about") — the offline-brute-force exposure above
  is real and belongs in the notice.
- **Subprocessor incidents.** A breach at a subprocessor (§5) is governed by
  that party's obligations; the operator's duty is to relay any notice that
  affects the slice users routed through the operator's trial keys or proxies.

## 7. What this document does not cover

- **In-app deletion copy.** The exact user-facing wording in the deletion /
  settings UI is owned by med-yor.4 / med-yor.1; this document defines the
  semantics that copy must reflect (§4).
- **The full `docs/cloud/` documentation restructure** (audit's recommended
  doc set) is med-yor.7. This file is the flat-namespace precursor to that
  set's `operations-security.md` + `deletion.md`.
