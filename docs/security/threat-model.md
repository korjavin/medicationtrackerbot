# Threat model

**Status:** normative and current. **Scope:** the deployed product — the cloud
service built around a **zero-knowledge vault** (`cmd/cloud`,
`internal/cloudserver`, `internal/cloudstore`) and the browser PWA it serves
(`web/cloud/`, `web/domain/`, `web/static/`). Zero-knowledge is a property of
the vault, not of the whole service; §6.4 enumerates the paths that
deliberately carry plaintext past the operator.

**Last verified against the code:** 2026-07-31. Every claim below cites a file
(and a line where the line is load-bearing). Where something could not be
verified from the repository, it says so rather than guessing.

Companions, all normative:
[architecture.md](../architecture.md) (components and data flows),
[cloud-crypto.md](../cloud-crypto.md) (key formats and ceremonies),
[cloud-mode.md → Privacy boundary](../cloud-mode.md#privacy-boundary--the-vault-promise-and-its-carve-outs)
(the generated, code-derived enumeration of what leaves the vault),
[cloud-operations-security.md](../cloud-operations-security.md) (logs,
retention, deletion, subprocessors, incident response), and
[release-integrity.md](release-integrity.md) (the client-code boundary).

---

## 1. The claim being defended

> Your vault — every health record you store and sync — is end-to-end
> encrypted. The keys never leave your devices, and the server holds only
> ciphertext it cannot open. Optional integrations you turn on reach outside
> that vault and have separately disclosed boundaries.

This threat model exists to say precisely **what that does and does not
cover**, and what is left over when it is all working as designed.

Four promises are deliberately kept apart, because conflating them is the
failure mode this document is written against:

| # | Promise | Held by |
|---|---|---|
| P1 | **Vault confidentiality** — the server cannot read stored or synced health records | Cryptography. Strong. |
| P2 | **Feature confidentiality** — a feature's data is not readable by the operator or a third party | *Not* universally held. Enumerated carve-outs. |
| P3 | **Metadata privacy** — nothing sensitive is inferable from timing, sizes, identifiers | *Not* held. Explicitly accepted leakage. |
| P4 | **Client integrity** — the origin cannot serve code that reads an unlocked vault | *Not* held. The dominant residual risk. |

P1 is cryptographic. P2 is a per-feature product decision. P3 and P4 are
accepted limitations with no technical fix inside this architecture.

## 2. Assets

| Asset | Where it lives | Consequence of disclosure |
|---|---|---|
| **DEK** (random 256-bit vault root key) | memory of an unlocked tab; on the server only inside AES-GCM envelopes | Total: decrypts every record, past and future. |
| **Passkey PRF output** | authenticator → client JS only; never transmitted (`docs/cloud-crypto.md` §"The enabling primitive") | Derives a KEK, unwraps the DEK. |
| **Recovery code** (160-bit, Emergency Kit) | printed/saved by the user; server holds only `SHA-256(verifier)` | Unwraps the DEK from `envelope_rec`. |
| **LDK** (per-device warm-unlock key) | non-extractable WebCrypto key in IndexedDB | Reopens the vault on that device with no biometric prompt. |
| **NK** (push payload key) | encrypted vault record + plaintext in device IndexedDB, so the service worker can read it | Reveals reminder text — not vault records (`docs/cloud-crypto.md` §"The push key (NK)"). |
| **Inbox private key** (X25519) | vault record; only the **public** half is on the server (`internal/cloudserver/inbox.go`) | Opens sealed inbound messages. |
| **Health records** | ciphertext in the oplog/snapshots; plaintext in an unlocked tab and its IndexedDB mirror | The thing being protected. |
| **Provider API keys** (OpenAI, ElevenLabs, food DB) | encrypted vault records | Third-party account abuse at the user's expense. |
| **Session token** | per-device, HMAC over `SESSION_SECRET` (`internal/cloudserver/session.go`) | API access to *ciphertext* and metadata — never plaintext. |
| **Telegram bot token** | server DB, sealed under a key derived from `SESSION_SECRET` (`internal/cloudserver/tg_token.go`) | Send/receive as that bot. **Not vault-grade** — a server holding `SESSION_SECRET` recovers it. |
| **Hosted-MCP pairing key + capability token** | server DB while hosted mode is enabled (`internal/cloudserver/mcp_remote.go`) | Read/write the vault *through an unlocked tab*, for as long as one is open. |
| **Operational metadata** | server DB and logs | See §6 — this is real signal, not noise. |

## 3. Trust boundaries

```
        ┌──────────────────────── TRUSTED ────────────────────────┐
        │  B1  The unlocked browser tab                            │
        │      DEK, plaintext records, provider keys, LDK          │
        │      Trusted because it is the only place that can       │
        │      decrypt. Compromise here is total.                  │
        └──────────────────────────┬──────────────────────────────┘
                                   │  ← B2: the code-delivery boundary
                                   │     (the operator SERVES this tab)
        ┌──────────────────────────▼──────────────────────────────┐
        │  B3  The device / OS                                     │
        │      IndexedDB plaintext mirror, NK, LDK, passkey        │
        │      Protected by device unlock + FDE, not by us.        │
        └──────────────────────────┬──────────────────────────────┘
                                   │  ← B4: TLS. Bodies are ciphertext
                                   │     on the vault path.
        ┌──────────────────────────▼──────────────────────────────┐
        │  B5  The cloud server — UNTRUSTED for confidentiality    │
        │      Honest-but-curious AND breachable. Holds            │
        │      ciphertext, envelopes, verifiers, metadata.         │
        │      TRUSTED for availability and for serving code (B2). │
        └──────────────────────────┬──────────────────────────────┘
                                   │  ← B6: named third parties
        ┌──────────────────────────▼──────────────────────────────┐
        │  B7  Subprocessors — push services, Telegram, AI/voice   │
        │      providers, RxNav, food DB. Each sees only its own   │
        │      slice (cloud-operations-security.md §5).            │
        └──────────────────────────────────────────────────────────┘
```

**B2 is the boundary that does not close.** The server is untrusted for
confidentiality *of data* (B5) but is unavoidably trusted to deliver the
JavaScript that handles the DEK. That contradiction is inherent to
web-delivered cryptography and is treated as a first-class residual risk in
§7.1, not a footnote.

## 4. Attacker model

### 4.1 Capabilities assumed

| Actor | Assumed able to |
|---|---|
| **A1 — Honest-but-curious operator** | Read every byte of `cloud.db`, every log line, every request in flight at the edge. Correlate timing across accounts. |
| **A2 — Malicious or coerced operator** | Everything A1 can do, **plus** serve modified JavaScript to everyone or to one targeted account, and add rows to any table. |
| **A3 — Database / backup thief** | An offline copy of `cloud.db` (and any replica). Unlimited offline compute against it. |
| **A4 — Network observer** | See DNS queries, TLS SNI, packet sizes and timing. Cannot read TLS payloads. |
| **A5 — On-origin script (XSS)** | Execute in the account's origin for the life of a page: read the in-memory DEK, use (not export) the LDK, call any same-origin endpoint. |
| **A6 — Thief of an unlocked device** | Everything the user can do on that device, including the warm-unlock cache. |
| **A7 — Thief of a locked device** | The browser profile on disk. Needs the OS credential to make it useful. |
| **A8 — Malicious subprocessor** | Whatever slice was sent to it (§6.4), retained per its own policy. |

### 4.2 Capabilities NOT assumed

Stating these matters as much as the list above — a model that assumes an
omnipotent adversary makes no useful distinctions.

- **Breaking AES-256-GCM, HKDF-SHA-256, X25519, or P-256.** All constructions
  are conventional (`docs/cloud-crypto.md` §"Exact formats").
- **Extracting a passkey's per-credential secret from the authenticator.**
- **Guessing high-entropy material.** Every wrap key in the system carries
  ≥160 bits of true entropy; there is no password hash to grind and nothing
  server-side is offline-crackable (`docs/cloud-crypto.md` R5).
- **Compromising the user's OS or authenticator hardware.**
- **Silently and undetectably substituting the served build** — see §7.1: an
  operator *can* serve modified code, but SLSA provenance and published
  `SHA256SUMS` make a divergence detectable to anyone who checks
  ([release-integrity.md](release-integrity.md)).

## 5. What holds, and why

Each row names the mechanism, not just the outcome.

| Threat | Outcome | Mechanism |
|---|---|---|
| A3 steals the whole database | Ciphertext, envelopes, `SHA-256(verifier)`, metadata. No offline attack path. | Envelope encryption; every KEK ≥160 bits (`docs/cloud-crypto.md` R5) |
| A1/A2 reads the sync tables | AES-GCM ciphertext with `account_seq` bound into the AAD | `internal/cloudserver/sync.go`; AAD spec in `docs/cloud-crypto.md` §"Oplog record" |
| A2 reorders or replays synced ciphertext | Detected at decrypt time | `account_seq` in the record AAD |
| A2 injects its own credential into an account | Gets a session, which grants ciphertext. Cannot mint a valid envelope (needs the DEK) and cannot forge the envelope-audit MAC (needs `K_mac`) — the device list renders it **unverified — remove?** | `docs/cloud-crypto.md` §"Security analysis"; `web/cloud/js/devices.js` |
| A2 tampers with a device-transfer slot | AEAD failure under the transfer key `TK`, which never reaches the server → client aborts | `docs/cloud-crypto.md` Path B |
| A1 reads reminder queue rows | An instant and an opaque blob. Payloads are app-layer encrypted under NK *on top of* RFC 8291 | `internal/cloudserver/push.go`, `relay.go` |
| Push service (B7) reads a payload | Ciphertext at two layers | as above |
| A2 misroutes account A's push to account B | Rejected by Apple/Google — subscriptions are bound to the per-account VAPID key used at `subscribe()` time | per-account VAPID keypair, minted at provisioning |
| Phishing / look-alike origin | Passkeys are origin-bound to the account subdomain; neither an assertion nor a PRF output is obtainable off-origin | `docs/cloud-crypto.md` §"RP ID" |
| A7 steals a locked device | Passkey needs user verification; the LDK cache needs the unlocked profile. Revocable from any surviving device. | OS boundary + `DELETE /api/devices/{id}` |
| Clock rollback extends a session | Rejected: verification bounds the timestamp in **both** directions | `internal/cloudserver/session.go:27` (`sessionMaxFutureSkew = 5m`), `:71-72`; `session_test.go:24` |
| Brute-forcing the recovery code online | 5 attempts per window per account, enforced in SQL against a domain-separated verifier that cannot unwrap anything (a 160-bit code makes this hygiene, not the real defense) | `internal/cloudstore/repo.go:1012` (`recoveryMaxAttempts = 5`), `:1057`; handler `internal/cloudserver/recovery.go:81-84` |
| Brute-forcing a hosted-MCP capability token | Per-account failed-attempt throttle at 100/min; the token space takes decades at that rate. Wrong/revoked tokens 404 without confirming the account exists. | `internal/cloudserver/mcp_endpoint.go:30` (`mcpEndpointFailLimitMax = 100`) |
| A5 exfiltrates the DEK to an arbitrary host | Blocked by a per-account `connect-src` allowlist — no document on the origin serves a bare `https:`/`wss:` token | `internal/cloudserver/router.go:295-305`; pinned by `TestRouter_HostVariants` |
| A2 slips a third-party script onto the DEK page | `script-src 'self'` on every document — no `blob:`, no `data:`, no `unsafe-*`. Voice-SDK worklets are self-hosted. | `internal/cloudserver/router.go:286-288`; pinned by `TestSecurityHeaders_NoBlobOrDataScript` |
| Server refuses to seal an inbound message it has no key for | Dropped, never stored readable — `SealAndQueue` returns `ErrNoInboxKey` | `internal/cloudserver/inbox.go` |
| A resource-exhaustion write wedges an account forever | Bounded: 64 KiB per op, 64 MiB per snapshot, 1 MiB / 200 events per inbox drain, and a client-side write-error budget that pauses rather than loops | `internal/cloudserver/sync.go:22,34,35`, `inbox.go:20,26`; `web/cloud/js/sync.js` |

## 6. What leaks by design

Nothing in this section is a bug. Each item is a deliberate trade recorded so
it can be argued with.

### 6.1 The plaintext record-type channel

Every synced op carries `record_type:record_id` **in the clear** beside its
ciphertext, so a reading device can bind the AAD without a schema negotiation
(`web/cloud/js/sync.js`). A record-type histogram plus arrival times is a
health-inference channel, not neutral plumbing: a BP-heavy, twice-daily
profile reads as hypertension monitoring, and vitals record ids embed the
calendar day (`hrsample-2026-07-08`). **No mitigation is implemented** —
padding or batching would be the fix and neither exists.

### 6.2 Timing, sizes, cadence

Reminder fire times, sync cadence, blob sizes, inbox arrival times, and client
IPs are all visible to A1 and partly to A4. Together they sketch a routine and
how much of what a user tracks. Treat them as **potentially sensitive
metadata**, never as categorically harmless.

### 6.3 Account existence and subdomain

Wildcard DNS and a DNS-01 wildcard certificate keep individual subdomains out
of zone files and Certificate Transparency logs, but DNS queries and TLS SNI
still expose the name to A4. **The subdomain is a moat, not authentication**
(`internal/cloudserver/router.go`).

### 6.4 The integration carve-outs

Several implemented features deliberately move plaintext past the operator.
They are **not** one uniform "all opt-in" set, and flattening them is itself a
disclosure defect:

1. **Off until the user turns them on** — Telegram, trial AI, trial voice,
   hosted MCP (tier 2). The three trial scopes additionally require a durable,
   revocable consent record where only a literal `true` passes; a missing
   record refuses (`web/domain/settings.js:56`, `:321-341`;
   `web/cloud/js/aiclient.js:312-313`). Skipping key setup is not consent.
2. **No toggle; active whenever the feature is used** — the operator-default
   food-DB proxy (setting your own endpoint removes the operator from the
   path) and RxNav drug lookups (**always** proxied; there is no
   bring-your-own alternative at all).
3. **Always on, inherent to running the service** — the operational metadata
   in §6.1–§6.3.

The canonical, code-derived enumeration with per-row evidence is the
[generated privacy boundary table](../cloud-mode.md#privacy-boundary--the-vault-promise-and-its-carve-outs);
its source of truth is `web/cloud/js/privacy-manifest.js`, and
`web/cloud/js/tests/architecture.privacy-claims.test.js` fails CI on a new
egress path that no manifest entry claims. Third-party retention per
destination is in
[cloud-operations-security.md §5](../cloud-operations-security.md#5-subprocessors--who-sees-what).

### 6.5 One server-side plaintext parse

A Mi Band `.nxk` backup is written to a temp file and parsed **in plaintext**
on the server before being sealed to the account's inbox key
(`internal/cloudserver/vitals_import_api.go`). The parser needs the raw file;
there is no client-side alternative today. The temp file is removed when the
request ends, and the upload is refused outright when no unlocked device has
published an inbox key — so nothing plaintext is ever stored.

## 7. Residual risks

Ranked by what an attacker actually gets.

### 7.1 The operator serves the code that handles the DEK — **dominant**

The vault is end-to-end encrypted; the browser code that reconstructs the key
and decrypts the records is served by the operator. A malicious or coerced
operator, or a poisoned CI/deploy path, can ship JavaScript that reads
everything after unlock. Encryption at rest and in transit does not change
this, and **nothing in a browser can attest what it ran**.

What narrows it: `script-src 'self'` with zero third-party script, a scoped
per-account `connect-src`, SLSA build provenance signed to the GitHub Actions
OIDC identity, and published `SHA256SUMS` over every browser-delivered file —
which turn an undetectable substitution into a *detectable* one for anyone who
checks. Full statement, verification commands, and the honest list of what is
still missing (no reproducible build, no transparency log, no update pinning,
no independent crypto review): [release-integrity.md](release-integrity.md).

**The removed mobile shell is not a mitigation.** It is not built, not
shipped, and must never be cited as the answer to this risk.

### 7.2 On-origin XSS is equivalent to a malicious operator, while the page lives

A5 reads the in-memory DEK and drives the non-extractable LDK. Non-extractable
keys block raw-key export; they do not make the page safe to inject into. The
`connect-src` allowlist bounds exfiltration, with an honest gap: an XSS with
persistence can `PUT /api/egress-hosts` to add its own host and force a reload
to pick up the widened policy (`internal/cloudserver/egress.go`, capped at
`maxEgressHosts = 8`). That is strictly harder than instant arbitrary-origin
exfiltration — it needs a write plus a navigation — and it is not a closed
door.

### 7.3 Device removal is not compromise recovery

`DELETE /api/devices/{credential_id}` deletes the WebAuthn credential and its
DEK envelope in one transaction and invalidates that credential's sessions
(`internal/cloudserver/device.go:93`, `:109`). It does **not** rotate the DEK
or NK. A stolen, already-unlocked device keeps a readable copy of everything
it had synced. Supportable language today is *retire a device*; fully evicting
a compromised unlocked device needs the rotation ceremony designed in
[cloud-key-rotation.md](../cloud-key-rotation.md) — **a proposal, not
implemented**. Even then, the past cannot be un-leaked.

### 7.4 The local plaintext mirror never auto-locks

Offline rendering requires a decrypted copy on the device, so every synced
record sits in that browser profile's IndexedDB, alongside a warm-unlock cache
that reopens the vault with no passkey prompt (`web/cloud/js/sync.js`,
`web/cloud/js/unlock.js`). **There is no idle auto-lock.** It clears on sign
out, account deletion, or clearing site data. Protection is the device unlock
and full-disk encryption — the OS's boundary, not ours. The strict mode that
would drop the warm cache is designed but not built (`docs/cloud-crypto.md`
§"Local at-rest posture").

### 7.5 Availability is never zero-knowledge

A2 can withhold, delay, or destroy data it cannot read. Encryption gives no
integrity-of-service guarantee. Concretely: the recovery envelope lives in the
same `cloud.db` as everything else, so losing that volume does not merely lose
the data — it invalidates every recovery code that would have let anyone back
in ([cloud-deployment.md §6](../cloud-deployment.md#6-backups-and-restore)).
The user-side answer is the vault export, which is always available and always
plain
([vault-format.md](../vault-format.md)).

### 7.6 The Telegram bot token is not vault-grade

It is sealed at rest under a key **derived from `SESSION_SECRET`**
(`internal/cloudserver/tg_token.go`), so a server holding that secret recovers
it. Anyone holding the token can send messages as that bot. This is disclosed
as the one server-visible credential; a chat bot cannot be made end-to-end
encrypted, and inbound Telegram messages necessarily cross the relay in the
clear before being sealed.

### 7.7 Hosted MCP (tier 2) terminates the client connection server-side

The operator runs the shim, so query and response content are visible in
transit (never stored) for as long as the mode is enabled, and the pairing key
sits at rest in the server DB (`internal/cloudserver/mcp_remote.go`). It is
off by default, per-account, consent-gated, and torn down on Disconnect. Tier
1 — a local shim over a blind relay — provides the same capability with no
such exposure (`internal/cloudserver/mcp_relay.go`).

Known, deliberately-deferred gap in the relay's replay defense: write frames
are deduped by GCM nonce in a bounded per-pairing, **per-device** ring, so a
malicious relay can replay a captured write frame to a *second*
simultaneously-unlocked device whose ring has never seen that nonce. Single-
device use is fully protected. The durable fix is a counter bound into the
frame AAD.

### 7.8 Deleted rows are not erased bytes

`DELETE` frees SQLite pages without zeroing them, `secure_delete` is off, and
no routine `VACUUM` runs. The freed bytes are **ciphertext**, and the
account's recovery verifier is deleted in the same transaction, so nothing
that could unwrap them survives. Full semantics — including backup expiry and
third-party retention — in
[cloud-operations-security.md §2–§4](../cloud-operations-security.md#2-sqlite-storage-reality--deleting-a-row-is-not-erasing-bytes).

### 7.9 Capability material can enter someone else's logs

The application log is redacted by test-guarded invariants: push endpoints
become truncated SHA-256 fingerprints (`internal/cloudserver/log_redact.go:20-26`,
`TestNoRawPushEndpointInLogs`), and the RxNav proxy uses fixed-string logging
so drug names never appear. **The exposure is the reverse proxy**, which by
default logs request lines: `/mcp/<token>` carries a live capability in the
path and `/api/rxnav/*?…` carries a drug name in the query string. Traefik's
access log is off by default and the stack does not enable it; enabling it
without dropping `RequestPath` re-opens both
([cloud-operations-security.md §1.3](../cloud-operations-security.md#13-reverse-proxy-access-logs--required-decision)).

### 7.10 Two blind concurrent writes on skewed clocks are still unordered

Last-writer-wins uses a server-referenced, per-record-monotonic `clientTs`, so
edit-what-you-can-see always wins and a device more than two minutes out says
so. Two *blind* concurrent writes from skewed devices remain unordered; a
hybrid logical clock is deferred behind the envelope's `format_version`.

## 8. Known unknowns

Stated because a threat model that only lists what it checked is misleading.

- **No independent review** of the browser crypto or the WebAuthn ceremonies
  has been done. The constructions are conventional, which is an argument for
  plausibility, not a substitute for review.
- **Live deployment configuration is not verified from this repository.**
  Whether backups are enabled, what the reverse proxy logs, and what retention
  the object store enforces are operator facts. The policy they must satisfy
  is [cloud-operations-security.md](../cloud-operations-security.md); this
  document does not assert what any particular deployment does.
- **Real-device WebAuthn PRF behavior across the platform matrix** is
  feature-detected at runtime, not proven here
  (`docs/2026-07-13-cloud-prf-compatibility-research.md`).
- **Subprocessor retention** is each party's own policy and is not verified.
- **No formal cryptographic proof** of the composed protocol exists.

## 9. Guards that keep this document true

These are executable, not aspirational. A change that invalidates a claim
above should fail one of them.

| Property | Guard |
|---|---|
| No absolute privacy claim on any copy surface; the vault claim is never hedged away; carve-outs stay enumerated | `web/cloud/js/tests/architecture.privacy-claims.test.js` |
| Every outbound / server-side-plaintext path in `internal/cloudserver` is disclosed by a manifest entry with real evidence | same file, "every egress / plaintext path in the code is disclosed" |
| The published boundary table equals `renderBoundaryTable()` — the doc cannot drift from the manifest | same file, "the generated boundary table matches the manifest exactly" |
| No `blob:`/`data:`/`unsafe-*` in any script directive; no foreign host in `script-src` | `TestSecurityHeaders_NoBlobOrDataScript`, `TestRouter_HostVariants` |
| The app document's `connect-src` reflects only stored egress hosts — never a bare `https:` | `TestRouter_AppDocumentReflectsEgressHosts` |
| Session timestamps bounded in both directions | `TestVerifySessionToken_FutureSkew` |
| Raw push endpoints never reach a log line | `TestNoRawPushEndpointInLogs` |
| Account deletion covers every account-keyed table — discovered from the schema, not from a hand-kept list | `TestDeleteAccount_CoverageMatchesSchema` (`internal/cloudstore/delete_account_test.go:95`) |
| The sealed-inbox wire format cannot drift between Go and the browser | `internal/cloudserver/testdata/inbox_sealed_vector.json`, decrypted by both suites |
