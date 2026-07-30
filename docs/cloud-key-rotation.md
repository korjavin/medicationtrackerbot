# Cloud-mode key rotation — evicting a compromised device

**Status: design proposal, not yet implemented.** Companion to
[docs/cloud-crypto.md](cloud-crypto.md) (key hierarchy, envelope formats,
ceremonies) and [docs/cloud-mode.md](cloud-mode.md) (sync engine, snapshot/oplog
model, push relay). Source: finding **P2 — "Device removal is not compromise
recovery"** in
[docs/2026-07-12-gpt-5.6-sol-cloud-privacy-audit.md](2026-07-12-gpt-5.6-sol-cloud-privacy-audit.md#L193-L203),
and the open question at [cloud-crypto.md](cloud-crypto.md) "DEK rotation on
suspected-compromise revocation".

This document is design-first on purpose. A partial rotation can leave an account
that nothing can open. Nothing here is implemented; the acceptance criteria at
the end are what an implementation must satisfy.

---

## 0. What rotation cannot do (read this first)

Rotation stops **future** access. It does not un-leak the past.

A stolen unlocked device holds a full plaintext mirror of the vault in its own
IndexedDB, plus the DEK, plus the plaintext push key. Rotation cannot reach into
that device and erase any of it. Specifically, rotation **cannot**:

- erase or overwrite records the device already synced and decrypted;
- erase the old DEK from that device's LDK cache
  (`web/cloud/js/unlock.js:234-253`), the old NK plaintext from its `device`
  object store (`web/cloud/js/sync.js:309-322`), the old inbox private key, or the
  old MCP pairing key — all of which are local records on hardware we do not
  control;
- undo any copy the attacker already made to somewhere else;
- prevent a passkey held in a synced credential fabric (iCloud Keychain, Google
  Password Manager) from continuing to exist. Deleting our `credentials` row stops
  it authenticating **to us**, which is the only part of that fabric we control.

What rotation **does** do, from the instant its transaction commits: the evicted
device can no longer (a) authenticate a session, (b) read any record written
after the rotation, (c) read the current snapshot, (d) decrypt any future push
payload, (e) receive future Telegram inbox events, or (f) drive MCP.

Every piece of user-facing copy in §7 states this distinction explicitly. Any
implementation that softens it is wrong.

---

## 1. Current state (grounded)

### 1.1 What device removal does today

`DELETE /api/devices/{credential_id}`
(`internal/cloudserver/device.go:38`, handler `device.go:93-121`) calls
`Repo.DeleteCredentialWithEnvelope` (`internal/cloudstore/repo.go:686-726`),
which in one transaction runs:

- `DELETE FROM credentials WHERE id = ? AND account_id = ?` (`repo.go:689`)
- `DELETE FROM envelopes WHERE account_id = ? AND credential_ref = ?` (`repo.go:723`)

…guarded by the last-credential check at `repo.go:700-722` (`ErrLastCredential`,
`repo.go:62`, surfaced as 409 at `device.go:113-114`), which refuses to delete the
final credential unless **both** the recovery envelope and the `recovery_auth`
verifier row exist.

It touches nothing else — not `push_subscriptions`, `scheduled_pushes`,
`transfer_slots`, `oplog`, `snapshots`, `inbox_events`, or `mcp_remote`. Data
keys are unchanged. This is exactly the "retire a device" semantic the audit says
is supportable today, and the client copy already says so
(`web/cloud/js/devices.js:164-176`).

### 1.2 Session revocation is derivative of the credentials table

Sessions are stateless HMAC tokens — payload
`accountID|hex(credentialID)|unix`, `NewSessionToken`
(`internal/cloudserver/session.go:34-40`), verified by `VerifySessionToken`
(`session.go:45-80`) with a 30-day TTL (`sessionTTL`, `session.go:21`). There is
no sessions table, no epoch, and no revoke-all.

The single revocation lever is `RequireSession` calling
`store.CredentialExists` on every account-scoped request
(`session.go:142-146` → `internal/cloudstore/repo.go:663-673`). **Deleting a
credential row is session revocation** for that credential, on its next request.
This is the load-bearing mechanism the whole eviction design rests on.

### 1.3 Snapshot / oplog model

- Append: `POST /api/sync/ops` (`internal/cloudserver/sync.go:66`, handler
  `sync.go:90-137`) → `Repo.AppendOps` (`internal/cloudstore/sync.go:61-107`),
  which assigns contiguous per-account seqs under a single SQLite writer
  transaction.
- Read: `GET /api/sync/ops` (`sync.go:162-208`) returns ops plus
  `snapshot_seq` — the compaction floor (`Repo.CompactionFloor`,
  `internal/cloudstore/sync.go:153-158`). A client below the floor must
  re-bootstrap.
- Snapshot upload: `POST /api/sync/snapshot` (`sync.go:219-247`) →
  `Repo.PutSnapshot` (`internal/cloudstore/sync.go:166-208`), which upserts the
  snapshot **and** `DELETE FROM oplog WHERE account_id = ? AND seq <= ?`
  (`sync.go:198`) in one transaction.
- Client side: `bootstrap()` (`web/cloud/js/sync.js:488-546`) downloads the
  snapshot, decrypts under `K_data`, and `replaceAllRecords`; `snapshotAt()`
  (`sync.js:637-676`) re-encrypts the entire local record store (gzip → AES-GCM)
  and POSTs it at a given seq.

Two guards in `PutSnapshot` matter for rotation:

- `ErrSnapshotSeqAhead` when `snapshotSeq > lastSeq` (`internal/cloudstore/sync.go:173-175`).
- The **monotonic floor guard** at `sync.go:183-189`: a snapshot at or below the
  existing floor is *silently ignored* (`return nil`). A rotation snapshot at an
  unchanged seq would therefore be swallowed, leaving the old-DEK snapshot in
  place while the client believed it had rotated. §4 invariant **I7** exists
  because of this line.

### 1.4 Key material and where each copy lives

| Key | Server copy | Client copy | Rides the snapshot? |
|---|---|---|---|
| DEK | only inside `envelopes` (`001_init.sql:24-32`) | memory + LDK-wrapped in IDB (`unlock.js:234-253`) | no — it *is* the key |
| K_data / K_mac | never | derived in memory (`crypto.js:150`, `crypto.js:245`) | no |
| NK (push) | never | vault record `nk`/`nk` (`sync.js:15-16`) **and** plaintext in the `device` store, read directly by the SW (`web/cloud/sw.js:307-335`) | **yes** — it is an ordinary record |
| inbox private key | never (public key in `accounts.inbox_public_key`, `012_inbox.sql:11`) | vault record `inboxkey`/`inboxkey` (`web/cloud/js/inbox.js:23-24`) | **yes** |
| MCP Tier-1 pairing key | never (relay holds only `pairing_id` in memory, `internal/cloudserver/mcp_relay.go:21-23`) | vault record `mcppairing`/`mcppairing` (`web/cloud/js/mcp-pairing.js:12-13`) | **yes** |
| MCP Tier-2 pairing key | **yes** — `mcp_remote.pairing_key_ct`, sealed under the server's `sessionSecret` (`internal/cloudserver/mcp_remote.go:280-301`, `:374`) | — | no |
| account VAPID keypair | yes (`007_account_vapid.sql`) — server-side push signing, not user key material | — | no |

The three vault-record keys (NK, inbox, MCP pairing) are the reason rotation is
cheaper than it looks: they are ordinary records, so re-generating them
client-side and taking a fresh snapshot propagates them for free. No separate
distribution step.

The Tier-2 MCP pairing key is the one genuine exception to the zero-knowledge
model — the operator can decrypt it with `sessionSecret`. Rotation must delete
that row, not re-wrap it.

### 1.5 Push and inbox coupling

- `push_subscriptions` has **no device/credential column** (`004_push.sql:3-10`:
  `account_id, endpoint PK, p256dh, auth, created_at_unix, disabled`). The server
  cannot tell the thief's subscription from a surviving device's. Consequence in
  §5.2.
- `scheduled_pushes.ct` is AES-GCM under NK (`crypto.js:320-327`, uploaded by
  `web/cloud/js/push.js:363-400` to `PUT /api/push/schedule`,
  `internal/cloudserver/push.go:86` → `Repo.ReplaceSchedule`,
  `internal/cloudstore/push.go:162-190`). Queued rows are ciphertext under
  **whatever NK was live when they were queued**.
- `inbox_events` rows are sealed to `accounts.inbox_public_key` at seal time
  (`internal/cloudserver/inbox.go:207-220`). The key is replaceable, last-write-wins
  (`inbox.go:68-70`, `internal/cloudstore/inbox.go:26-30`). A full wipe already
  exists: `DELETE /api/inbox` → `Repo.ClearInboxEvents`
  (`internal/cloudstore/inbox.go:93-100`).

### 1.6 The existing re-auth pattern to reuse

`DELETE /api/account` is gated on a session **plus a fresh passkey assertion**:
`POST /api/account/reauth` → `WebAuthnAPI.BeginReauth`
(`internal/cloudserver/webauthn.go:621`), answered into
`VerifyReauth` (`webauthn.go:658`), wired at
`internal/cloudserver/account.go:44-51`. `AccountAPI` also takes a `teardown`
hook composed in `cmd/cloud` for the external/in-memory cleanup a DB delete
cannot do (`account.go:31-35`). Rotation reuses both seams verbatim; no new
mechanism.

---

## 2. Why the obvious shortcuts do not work

**"Wrap DEK′ under the old DEK so every device picks it up."** The compromised
device holds the old DEK. It would pick up DEK′ too. This defeats the entire
exercise. Rejected outright — no variant of it is acceptable.

**"Let the rotating device re-wrap the other devices' envelopes."** It cannot.
`KEK_j = HKDF(PRF_j, salt=account_id, info="mt/v1/kek" ‖ credential_id_j)`
(`crypto.js:143-146`). `PRF_j` is released only by authenticator *j* after user
verification. The rotating device has no way to compute `KEK_j`, and that is the
property that makes envelopes safe in the first place.

**Therefore rotation v1 cannot preserve other devices' access.** Every surviving
device must be re-enrolled through an existing path — Path B QR hand-off
(`internal/cloudserver/transfer.go:49-58`) or Path C recovery code. This is a real
UX cost and §7's copy says so up front. §8 sketches the v2 mechanism that would
remove it.

**"Just re-encrypt the old oplog under DEK′."** Unnecessary. The rotation
snapshot supersedes every op below it, and `PutSnapshot` already deletes them
(`internal/cloudstore/sync.go:198`). Old ops are *discarded*, not re-encrypted —
the rotating device holds the full plaintext vault, so the snapshot is complete
by construction.

---

## 3. The protocol

### 3.1 New state

Three columns, all with defaults so existing rows are valid without a backfill:

```sql
ALTER TABLE accounts   ADD COLUMN key_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE envelopes  ADD COLUMN epoch     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE snapshots  ADD COLUMN epoch     INTEGER NOT NULL DEFAULT 0;
```

`envelopes`' primary key stays `(account_id, credential_ref)`
(`001_init.sql:24-32`) — **epoch is not part of it**. Only one epoch is ever live
(§3.3 is a single transaction), so no two-generation coexistence is needed and no
table rebuild is required. The `epoch` column is there so a client can detect that
an envelope it fetched belongs to a generation it does not expect, and so the
invariant checks in §4 are expressible as SQL.

Epoch is surfaced to clients on every sync response: add `"key_epoch"` to
`getOpsResponse` (`internal/cloudserver/sync.go:149-156`) and
`getSnapshotResponse` (`sync.go:249-253`), and to `GET /api/envelopes/{ref}`
(`internal/cloudserver/envelope.go:63-68`).

### 3.2 Client preconditions

The initiating device must, in order:

1. Be unlocked and hold the DEK.
2. `flushPending` to empty — all local writes are on the server
   (`web/cloud/js/sync.js:940-1000`).
3. `pullTail` to head, so `localLastSeq == sync_state.last_seq`.
4. Generate `DEK′`, `NK′`, a new inbox keypair, and a new recovery code.
5. **Render and gate the new Emergency Kit before sending anything.** Reuse
   `renderEmergencyKit` from `signup.js` with its "I saved it" gate, exactly as
   `rotateEmergencyKit` does today (`web/cloud/js/devices.js:128-144`). If the user
   abandons here, nothing has been sent and the old kit is still the live one —
   the same honest failure copy `devices.js:117-124` already uses.
6. Pass a **fresh passkey re-auth** (`POST /api/rotate/reauth` →
   `BeginReauth`/`VerifyReauth`, cookie path `/api/rotate`). An unlocked tab left
   open on a shared laptop must not be enough to rotate an account, for the same
   reason it is not enough to delete one (`internal/cloudserver/account.go:59-70`).
   The assertion also yields `PRF_init` → `KEK_init` for step 7.
7. Replace the `nk`, `inboxkey`, and `mcppairing` records in the **local** record
   store with the new values, then build the rotation snapshot from that store via
   the existing `snapshotAt` path (`sync.js:637-676`) using
   `K_data′ = HKDF(DEK′, "mt/v1/data")`. NK′, the new inbox private key, and the
   dropped/replaced pairing record therefore ride the snapshot; no extra
   distribution step.
8. Wrap `DEK′` under `KEK_init` → `envelope_init`, and under `KEK_rec′` →
   `envelope_rec′` with `verifier′` (`crypto.js:161-167`, `:235-241`).
9. **Self-check before sending:** unwrap `DEK′` back out of `envelope_init` and
   confirm it decrypts the snapshot ciphertext just built. A rotation that ships an
   envelope it has not proved it can open is the single worst bug available here.

### 3.3 `POST /api/rotate` — one server transaction

Request:

```jsonc
{
  "expected_last_seq": 4821,           // optimistic concurrency, see below
  "epoch": 1,                          // must equal accounts.key_epoch + 1
  "keep_credential_ids": ["<b64url>"], // the initiating credential; others are evicted
  "envelope":  { "v":1, "nonce":"…", "ct":"…", "mac":"…" },
  "recovery":  { "envelope": { … }, "verifier": "…" },
  "snapshot":  { "snapshot_seq": 4821, "nonce":"…", "ct":"…" },
  "inbox_public_key": "…"
}
```

Gated by `RequireSession` **and** `VerifyReauth`. In a single
`db.WithTx`, in this order:

1. **Idempotency.** If `req.epoch == accounts.key_epoch` and
   `snapshots.epoch == accounts.key_epoch`, return `200 {"key_epoch": N}` and do
   nothing. A retried request after a lost response is a no-op, not a second
   rotation.
2. Reject `req.epoch != accounts.key_epoch + 1` with `409`.
3. Reject `req.expected_last_seq != sync_state.last_seq` with `409 stale` — a
   concurrent device appended ops after the initiator pulled to head. The client
   re-pulls and retries (§6.1). Without this, those ops would be silently
   destroyed by step 7.
4. Reject an empty `keep_credential_ids`, or any id not currently in
   `credentials`, with `400`. Rotation must never produce a passkey-less account.
5. `DELETE FROM credentials WHERE account_id = ? AND id NOT IN (keep…)` — this is
   the eviction, and by §1.2 it is also session revocation for every evicted
   device.
6. `DELETE FROM envelopes WHERE account_id = ?` (all epochs, all refs), then
   insert `envelope_init` at `epoch = N+1` for the kept credential and
   `envelope_rec′` at `credential_ref = 'recovery'`, and write
   `sha256(verifier′)` into `recovery_auth` — the same atomic envelope+verifier
   pairing `PutRecoveryMaterial` already enforces
   (`internal/cloudserver/envelope.go:201-242`).
7. Upsert `snapshots` at `(snapshot_seq = req.snapshot.snapshot_seq,
   epoch = N+1)` **bypassing the monotonic-floor guard**
   (`internal/cloudstore/sync.go:183-189`) — an epoch increase legitimately
   replaces a snapshot at the same or a lower seq. Then
   `DELETE FROM oplog WHERE account_id = ?` — *all* rows, not just
   `seq <= snapshot_seq`. Step 3 has already established there are none above it.
8. `UPDATE accounts SET key_epoch = N+1, inbox_public_key = ?`.
9. `DELETE FROM push_subscriptions WHERE account_id = ?` (§5.2),
   `DELETE FROM scheduled_pushes WHERE account_id = ?` (all of it — client-origin
   and `origin='relay_refire'` alike; every row is ciphertext under the retired
   NK), `DELETE FROM inbox_events WHERE account_id = ?` (§5.3),
   `DELETE FROM transfer_slots WHERE account_id = ?` (an outstanding slot carries
   the *old* DEK under a TK the thief may have seen), and
   `DELETE FROM mcp_remote WHERE account_id = ?` (§5.4).
10. Commit. Return `200 {"key_epoch": N+1}`.

A `teardown(ctx, accountID)` hook composed in `cmd/cloud` — the same seam
`AccountAPI` uses (`internal/cloudserver/account.go:31-35`) — runs **before** the
transaction to close in-memory MCP relay legs
(`pairings.revoke`, `internal/cloudserver/mcp_relay.go:174-196`). Best-effort and
logged, never fatal, exactly as in `account.go:82-90`.

### 3.4 Client, after `200`

1. Write the new LDK cache over the old one (`unlock.js:242-247`) so warm unlock
   yields `DEK′`.
2. Delete the plaintext `nk` entry from the `device` store and re-write it from the
   new vault record, so the SW's direct read (`web/cloud/sw.js:307-335`) picks up
   `NK′`.
3. Re-subscribe to push (`POST /api/push/subscriptions`) and re-upload the whole
   reminder schedule under `NK′` via `PUT /api/push/schedule`
   (`web/cloud/js/push.js:396-400`). Until this completes the account simply has no
   queued pushes — a gap in reminders, not a failure.
4. Set local `keyEpoch = N+1` in `sync_meta`.
5. Show the "re-add your other devices" screen (§7.3).

Steps 1–3 are all locally re-derivable from the committed server state. If the tab
dies between the `200` and any of them, the next open recovers via §6.2.

---

## 4. Invariants

Each is stated as a predicate a test can evaluate directly against the DB (Go) or
the client store (Vitest).

**I1 — Openability.** At every instant, for every account there exists at least
one envelope row whose `epoch == snapshots.epoch` (or `snapshots` is absent) and
whose `credential_ref` is either an existing `credentials.id` or `'recovery'`
paired with a `recovery_auth` row.
*Test:* a `TestRotate_OpenableAfterEveryStep` that runs the rotation with the
transaction aborted after each statement and asserts the predicate on the
resulting DB.

**I2 — Epoch monotonicity.** `accounts.key_epoch` never decreases;
`snapshots.epoch` never decreases; `POST /api/rotate` rejects any
`epoch != key_epoch + 1` except the exact-match idempotent no-op.

**I3 — Snapshot/envelope coherence.** After any successful request,
`snapshots.epoch == accounts.key_epoch` and every `envelopes.epoch ==
accounts.key_epoch`. There is never more than one live epoch.

**I4 — Oplog homogeneity.** Every `oplog` row for an account is encrypted under
`accounts.key_epoch`. Enforced by (a) the rotation transaction emptying the
oplog, and (b) `POST /api/sync/ops` requiring a `key_epoch` field and rejecting a
stale one with `409` (§6.1).

**I5 — No plaintext loss on a stale-epoch rejection.** A `409` from
`POST /api/sync/ops` must not clear the pending queue. This is already the shape
of the existing code: `flushPending` encrypts from the local plaintext record store
at flush time (`web/cloud/js/sync.js:966-980`) and only clears `pending` after the
server accepts. A device offline for weeks therefore loses nothing — its writes
are re-encrypted under `DEK′` on the next flush after it re-unlocks.
*Test:* Vitest — queue writes offline, rotate, reconnect, assert every queued
record lands.

**I6 — Idempotent retry.** Replaying an identical `POST /api/rotate` after a lost
response returns `200` and changes nothing (step 1 of §3.3).

**I7 — The rotation snapshot always lands.** The rotate path must not go through
the monotonic-floor early-return at `internal/cloudstore/sync.go:183-189`.
*Test:* rotate an account whose current snapshot is at the same seq; assert the
stored `ct` changed and `epoch` advanced.

**I8 — The initiator can open what it wrote.** `POST /api/rotate` is only sent
after the client has round-tripped `DEK′` out of `envelope_init` and decrypted its
own snapshot ciphertext with it (§3.2 step 9).
*Test:* Vitest on the ceremony function, with a deliberately corrupted envelope
asserting the request is never sent.

**I9 — Eviction implies session death.** After rotation, a session token minted
for an evicted credential is rejected on its next request. This follows from
`RequireSession` → `CredentialExists` (`internal/cloudserver/session.go:142-146`)
and needs no new mechanism.
*Test:* Go — mint a session for credential B, rotate keeping only A, assert every
account-scoped route returns 401 for B.

**I10 — Rotation never strands.** `keep_credential_ids` must be non-empty and
every id must exist, **and** the recovery envelope + verifier must be written in
the same transaction. The account is therefore openable by at least two
independent paths at commit.

---

## 5. Consequences per subsystem

### 5.1 How a surviving device learns it must re-derive

This is the failure mode most likely to be got wrong, because the current code
already has a swallow-and-continue path that would hide it.

`bootstrap()` catches a snapshot decrypt failure, increments `integrityErrors`,
and **advances the cursor anyway** (`web/cloud/js/sync.js:536-543`). That behaviour
is correct for its original case (a genuinely corrupt snapshot must not wedge the
client in a tight re-fetch loop), but if it also handled a key change, a surviving
device would silently render an empty vault with a counter nobody reads.

So: **check the epoch before attempting decrypt.** In `bootstrap()` and
`pullTail()`, compare the response's `key_epoch` against the locally stored
`keyEpoch`. If the server's is higher:

1. Do not decrypt, do not advance the cursor, do not touch the local record store —
   the local plaintext mirror is the only copy of any unflushed writes.
2. Clear the LDK cache (`clearLdkRecord`, `unlock.js:301-313`) and the plaintext `nk`
   entry.
3. Force a **cold unlock**: a passkey assertion → `GET /api/envelopes/{ref}` →
   `KEK_i` → `DEK′`. This is unavoidable. `KEK_i` is only derivable from a live
   authenticator ceremony, so *rotation costs one biometric tap on every surviving
   device*. There is no silent path, and claiming one would mean the compromised
   device could take it too.
4. Then re-bootstrap from the new snapshot and re-flush the preserved pending queue
   (I5).

If the device's credential was **not** kept, the assertion has nothing to assert
against and every request 401s. That device shows the terminal state in §7.4: re-add
it from a device you still hold, or use the new Emergency Kit.

### 5.2 Push and NK

- NK is a vault record (`sync.js:15-16`) and rides the snapshot. No separate
  distribution.
- Every device also caches NK plaintext in its `device` store for the SW
  (`web/cloud/sw.js:307-335`). On an epoch change that cache is stale; deleting it
  makes `decryptPushPayload` fail, and the SW already falls back to a generic
  notification on AEAD failure. **Degraded, not broken** — the correct default.
- `scheduled_pushes` rows are ciphertext under the retired NK, so they are deleted
  wholesale (§3.3 step 9), including `origin='relay_refire'` rows that
  `Repo.ReplaceSchedule` normally preserves (`internal/cloudstore/push.go:167-168`).
  The client re-uploads its schedule after unlocking; relay refires are re-created
  by the relay on its next event.
- `push_subscriptions` has no device column (`004_push.sql:3-10`), so the server
  cannot selectively drop the thief's endpoint — **all** subscriptions are deleted
  and every device re-subscribes. The thief's browser cannot re-subscribe because
  `POST /api/push/subscriptions` needs a session and its credential is gone (I9).
- The per-account VAPID keypair (`007_account_vapid.sql`) is **not** rotated. It is
  server-side signing material, not user key material, and rotating it would orphan
  subscriptions — the invariant `TestSetAccountVAPIDKeys_NeverRotates`
  (`internal/cloudstore/repo_test.go:216`) already pins. Since rotation deletes
  every subscription anyway, there is nothing to gain.

### 5.3 Inbox

New keypair; the private key is a vault record (`web/cloud/js/inbox.js:23-24`) and
rides the snapshot; the public key is written inside the rotation transaction
rather than through the last-write-wins `PUT /api/inbox/key`
(`internal/cloudserver/inbox.go:68-70`) so it cannot land separately from the
vault record that can open it.

Existing `inbox_events` are sealed to the retired public key and the matching
private key is not carried into the new vault, so they are permanently unreadable
— they are deleted (the mechanism already exists as
`Repo.ClearInboxEvents`, `internal/cloudstore/inbox.go:93-100`). **Honest cost:**
any Telegram callback that arrived and had not yet been drained at rotation time is
lost. Carrying the old inbox private key forward as an extra vault record would
avoid that, at the price of a second live key with no other purpose; not worth it
for a mailbox that drains on every app open.

### 5.4 MCP

- **Tier 1** (local shim): the pairing key is a vault record
  (`web/cloud/js/mcp-pairing.js:12-13`) and the relay never sees it
  (`internal/cloudserver/mcp_relay.go:95`). But the thief's copy still works against
  a live pairing, so the pairing must be revoked — `pairings.revoke(accountID)`
  (`mcp_relay.go:174-196`) in the pre-transaction teardown hook, and the
  `mcppairing` record dropped from the rotation snapshot. The user re-pairs.
- **Tier 2** (hosted remote): `mcp_remote.pairing_key_ct` is sealed under the
  server's `sessionSecret` (`internal/cloudserver/mcp_remote.go:280-301`, `:374`) —
  the operator can decrypt it, and so could anyone who took a copy through the
  compromised device's session. Delete the row; the user reconnects. Do not attempt
  to re-seal it: it is not the user's key.

### 5.5 Telegram

Telegram linkage lives in `internal/cloudstore/tg.go` and is keyed to the account,
not to a device. Rotation does not break it, but the compromised device may have
seen the linkage. Out of scope here — flag it in the post-rotation checklist copy
(§7.3) as something the user should review, and let the existing relink flow
(`tg.go:111`, which already rotates every field) handle it if they choose to.

---

## 6. Multi-device coordination and interruption

### 6.1 A second device writes during rotation

Prevented, then repaired:

- **Before commit:** `expected_last_seq` (§3.3 step 3) makes the whole rotation a
  compare-and-swap on `sync_state.last_seq`. A concurrent append moves `last_seq`,
  the rotation 409s, and the initiator re-pulls and retries. It never destroys an op
  it did not see.
- **After commit:** the other device's next `POST /api/sync/ops` carries the stale
  `key_epoch` and is rejected `409` with the current epoch in the body. Its pending
  queue is untouched (I5); it re-derives per §5.1 and re-flushes. **No write is
  lost**, because writes live as local plaintext until the moment of flush
  (`web/cloud/js/sync.js:966-980`).

### 6.2 Two devices both attempt rotation

The second one's `epoch` is no longer `key_epoch + 1`, so it 409s at §3.3 step 2.
Its client re-derives to the winner's epoch (§5.1) and, if the user still wants a
rotation, starts a fresh one at `N+2`. Nothing partial can result: the whole
rotation is one transaction.

### 6.3 A device offline for weeks

It returns, sees `key_epoch` ahead of its own, and takes §5.1's path: cold unlock,
re-bootstrap, re-flush its queue. If it was evicted, §7.4. Its stale sync state does
not affect anyone else — the dry-queue stale-sync warning
(`internal/cloudstore/sync.go:215-241`) is unaffected by rotation.

### 6.4 Every crash point

| Crash point | Server state | Openable? |
|---|---|---|
| During §3.2 (kit gate, re-auth, snapshot build) | untouched | yes — old epoch fully intact, old kit still live |
| Request in flight, never reaches the server | untouched | yes |
| Inside the transaction | rolled back by SQLite | yes — I1 |
| Committed, response lost | epoch N+1 complete | yes; retry is the I6 no-op |
| Committed, client dies before §3.4 step 1 (LDK) | epoch N+1 complete | yes — warm unlock fails, epoch check (§5.1) forces cold unlock, which succeeds against the new envelope |
| Committed, client dies before §3.4 step 3 (push) | epoch N+1 complete | yes — no queued reminders until the next open re-uploads the schedule |

The reason every row says "yes" is that the only step which changes what can open
the vault is a single atomic transaction, and it writes two independent openers
(the kept credential's envelope and the recovery envelope) before it commits.

---

## 7. UI semantics

### 7.1 Two distinct actions, never one

The device row (`web/cloud/js/devices.js:146-180`) currently offers a single
**Revoke** whose `confirm()` text tries to cover both cases
(`devices.js:169-173`). Split it:

- **"Retire this device"** — routine, unchanged behaviour
  (`DELETE /api/devices/{credential_id}`). Copy: *"Removes this passkey's access to
  your vault. Use this for a device you still have — an old phone, a browser you no
  longer use. Your data keys don't change."*
- **"This device was lost or stolen"** — the rotation flow. Distinct button,
  distinct screen, never a checkbox on the retire dialog.

### 7.2 The compromise confirmation screen

Must say, in this order and without softening:

> **What this does.** We create a new set of keys for your vault, re-upload your
> data under them, and sign out every device except this one. From that moment the
> lost device cannot read anything new, cannot sign in, and cannot receive your
> reminders.
>
> **What this cannot do.** It cannot erase what that device already had. Everything
> that was on it when you lost it — your records, its copy of your keys — is still
> on it. If someone has that device unlocked, treat everything you had logged up to
> now as something they can read. Rotating keys protects what happens next; it
> cannot undo what already happened.
>
> **What it costs you.** Every other device you own is signed out and must be added
> again from this one. You get a new Emergency Kit — your old one stops working.
> Your reminders are rebuilt, so you may not get one for a few minutes. If you use
> Claude or Telegram with this vault, you will need to reconnect them.

Then the existing patterns, reused rather than re-invented: an explicit
acknowledgement checkbox (`devices.js:100-103`), a passkey confirmation button
(`devices.js:104`), and the Emergency Kit save gate (`renderEmergencyKit` from
`signup.js`, as `devices.js:128-144` already does) — which, per §3.2 step 5, runs
**before** anything is sent.

### 7.3 After success

A checklist, not a toast: re-add each device you still have (deep-link to the
existing Add-a-device flow), reconnect Claude, reconnect Telegram, and a plain
restatement that data already on the lost device is still on it.

### 7.4 On an evicted device

If a device that was not kept ever opens the app again, it must not show a generic
error or an empty vault. It shows: *"This device was signed out because your
account's keys were rotated. To use it again, add it from a device you still have,
or unlock it with your current Emergency Kit."*

### 7.5 Documentation copy

`docs/cloud-crypto.md` "Removing a device / revocation" and its Security-analysis
row for "Stolen **unlocked** device" both currently describe rotation as a
documented gap. They must be updated together with the implementation — and the
audit's actual complaint (P2: the security overview and the removal UI should state
the limitation "with equal prominence" as the crypto doc) is only satisfied when
§7.2's *"What this cannot do"* paragraph exists in the product, not just here.

---

## 8. Compatibility, migration, and the deferred v2

**Existing accounts.** All three new columns default to `0`, so every account
starts at epoch 0 with an epoch-0 snapshot and epoch-0 envelopes. Every comparison
in §4 holds without a backfill. No account is required to rotate.

**Old clients against a rotated account.** A client bundle that predates rotation
does not send `key_epoch` on `POST /api/sync/ops`. Treat a missing field as epoch 0:
accepted while `accounts.key_epoch == 0`, rejected `409` once the account has
rotated. A rotated account therefore forces a client refresh, which the existing
update-check path (`web/cloud/js/update-check.js`) already handles. This is the
right trade: silently accepting an epoch-less op would violate I4 and corrupt the
account for everyone else.

**Route registration.** `POST /api/rotate` and `POST /api/rotate/reauth` live in
`internal/cloudserver` and are not MCP-catalogued operations, so neither the bot-mode
route-coverage guard (`internal/server/mcp_coverage_exempt.go`, which scans
`internal/server` only) nor the cloud responder coverage sweep
(`web/cloud/js/tests/mcp-responder.test.js`, driven by the catalog) requires an
entry. Rotation must never be MCP-reachable — an agent must not be able to rotate a
user's keys.

**v2 — rotation without re-enrolling every device (deferred, not part of this
design).** The cost §2 identifies is that `KEK_j` is unreachable to the rotating
device. It could be made reachable *without* handing anything to a compromised
device, by giving each credential a **rekey keypair**: at enrollment, device *j*
derives an X25519 private key from a second PRF evaluation — the
`salt_kek_next = SHA-256("medtracker/v1/prf-kek-next")` slot already reserved at
[cloud-crypto.md](cloud-crypto.md) — and publishes only the public half. A rotating
device could then seal `DEK′` to each surviving credential's rekey public key, and
device *j* would open it with one ordinary passkey ceremony, with no QR and no
out-of-band step. Both primitives already exist in the codebase: X25519 sealing is
implemented for the inbox (`internal/cloudserver/sealedbox.go`,
`web/cloud/js/crypto.js:421-442`), and the second PRF salt is already specified.

It is deferred because it only helps accounts whose credentials were enrolled
*after* it ships — the compromise you are recovering from today is on a device
enrolled yesterday — so v1's re-enrollment path has to exist regardless. Build v1;
revisit v2 once v1 is in use and the re-enrollment friction is measured rather than
assumed.

---

## 9. Acceptance criteria

Implementation is complete when all of the following hold.

**Schema and server**

1. Migration adds `accounts.key_epoch`, `envelopes.epoch`, `snapshots.epoch`, all
   `NOT NULL DEFAULT 0`; `envelopes`' primary key is unchanged; existing accounts
   need no backfill.
2. `key_epoch` appears in the `GET /api/sync/ops`, `GET /api/sync/snapshot`, and
   `GET /api/envelopes/{credential_ref}` responses.
3. `POST /api/sync/ops` requires `key_epoch` and returns `409` with the current
   epoch when it is stale; a missing field is treated as epoch 0.
4. `POST /api/rotate` exists, is gated on `RequireSession` **and** `VerifyReauth`
   with cookie path `/api/rotate`, and performs §3.3 steps 1–10 in exactly one
   `db.WithTx`.
5. `POST /api/rotate/reauth` exists, per-IP throttled through the same limiter as
   `POST /api/account/reauth` (`internal/cloudserver/account.go:48`).
6. The rotate path writes the snapshot **without** the monotonic-floor early-return
   at `internal/cloudstore/sync.go:183-189` (I7).
7. A `teardown` hook composed in `cmd/cloud` revokes in-memory MCP relay pairings
   before the transaction; its failure is logged, never fatal.

**Go tests**

8. `TestRotate_OpenableAfterEveryStep` — I1 holds with the transaction aborted after
   each statement.
9. `TestRotate_Idempotent` — a replayed identical request returns 200 and mutates
   nothing (I6).
10. `TestRotate_RejectsStaleLastSeq` — a concurrent append between the client's pull
    and the rotate call produces `409` and destroys no op (§6.1).
11. `TestRotate_RejectsEmptyOrUnknownKeepList` — 400, account untouched (I10).
12. `TestRotate_EvictedSessionRejected` — a session for an evicted credential 401s on
    every account-scoped route (I9).
13. `TestRotate_ClearsDerivedState` — after rotation, `push_subscriptions`,
    `scheduled_pushes` (both origins), `inbox_events`, `transfer_slots`, and
    `mcp_remote` hold zero rows for the account, and `oplog` is empty.
14. `TestRotate_VAPIDUnchanged` — the account's VAPID keypair survives rotation
    (§5.2).
15. `TestRotate_SnapshotReplacedAtSameSeq` — I7, asserting both the stored `ct` and
    the `epoch` changed.

**Client (Vitest, per CLAUDE.md rule 8 — extend the owning suite, no new
coverage-shaped files)**

16. Epoch mismatch on `bootstrap()`/`pullTail()` does **not** decrypt, does **not**
    advance the cursor, and does **not** call `replaceAllRecords`; it clears the LDK
    cache and enters cold unlock (§5.1). Explicitly assert it does not take the
    existing `integrityErrors` swallow path (`web/cloud/js/sync.js:536-543`).
17. Writes queued while offline survive a rotation and land after re-unlock (I5).
18. The ceremony does not send `POST /api/rotate` if the round-trip self-check fails
    (I8).
19. The Emergency Kit save gate completes before any request is sent; abandoning it
    leaves the old kit live (§3.2 step 5).
20. After success, the client rewrites the LDK cache, refreshes the SW's plaintext
    NK, re-subscribes to push, and re-uploads the schedule under `NK′`.

**UI and docs**

21. The device row offers two distinct actions with the §7.1 copy; retire keeps its
    current behaviour unchanged.
22. The compromise screen carries §7.2's three paragraphs — including *"What this
    cannot do"* — verbatim in substance, behind an acknowledgement checkbox and a
    passkey confirmation.
23. An evicted device shows §7.4's terminal state, not a generic error or an empty
    vault.
24. `docs/cloud-crypto.md` ("Removing a device / revocation", the stolen-unlocked-device
    row of the Security-analysis table, and the DEK-rotation open question) is updated
    to point here and to drop the "documented gap" framing; the P2 entry in the audit
    doc is marked addressed.
25. No copy anywhere — product or documentation — claims or implies that rotation
    removes data already present on the compromised device.
