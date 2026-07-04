# Cloud C0c — encrypted blob sync + blind push relay

Third of three sequential C0 plans. **Depends on C0a + C0b being completed** (accounts, passkey unlock with in-memory DEK, multi-device enrollment all work). Normative specs: [docs/cloud-mode.md](../cloud-mode.md) "Sync protocol" + "Push relay & reminder lifecycle", [docs/cloud-crypto.md](../cloud-crypto.md) "Exact formats" (record/snapshot/push-payload AADs, NK).

## Overview

Completes C0: the cloud becomes a working encrypted-sync backend and blind alarm clock, validated end-to-end with a toy record type (encrypted notes) — no domain logic yet (that's C1). Deliverables: append-only encrypted oplog with per-account cursors and snapshot compaction; two enrolled devices converge on the same toy records; web-push subscriptions + a client-scheduled `(fire_at, ciphertext)` queue the server fires blindly (two-layer encryption: app-layer AES-GCM under NK inside standard RFC 8291); a stale-sync warning so reminder queues never run dry silently.

## Context (from discovery)

- `internal/webpush` wraps `github.com/SherClockHolmes/webpush-go` behind a 2-method `SubscriptionStore` interface (`List`, `Disable`) and is not coupled to the app store — reuse the library binding + VAPID handling; do NOT reuse the medication-specific `Send*` methods (the relay is content-free).
- VAPID generation exists: `cmd/genvapid`. The cloud service reads `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` env (same names as the bot; documented in docs/environment.md).
- SSE/streaming behind Traefik has a documented pattern (docs/sse-traefik.md) — **not needed here**: C0 sync is pull-on-open + push-nudge; no long-lived streams (`ponytail:` add SSE only if C1 needs live cross-device updates).
- NK (notification key) semantics: docs/cloud-crypto.md "The push key (NK)" — random 256-bit, lives as an encrypted vault record + plaintext copy in IndexedDB for the SW; generic-notification mode when absent.
- `account_seq` binding into record AAD (anti-reorder/replay) is already implemented in `web/cloud/js/crypto.js` format helpers if C0a Task 8 followed the spec — verify, extend if the record/snapshot constructors were deferred.

## Development Approach

- **Testing approach**: NO unit tests. They blow up the codebase for no value here.
  - add an integration test ONLY when it covers a real boundary (API contract, data migration, cross-component flow) and gives a guarantee manual checking can't
  - if no integration test adds a real guarantee, the task has NO test items — that is correct and expected
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: if a task adds an integration test, it must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Maintain backward compatibility (C0a/C0b flows unchanged)

## Testing Strategy

- **Unit tests**: none. Do not add unit tests.
- **Integration tests**: three real boundaries — (1) oplog append/cursor/snapshot-compaction HTTP contract over real SQLite, (2) the scheduled-push firing loop against a fake webpush sender (due selection, replace-all semantics, 410 pruning), (3) client record encrypt→sync→decrypt roundtrip incl. seq-tamper detection (Vitest, exercises the AAD binding a manual test can't prove).
- **E2E tests**: none.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope

## What Goes Where

- **Implementation Steps**: migrations, sync + push endpoints, ticker loop, SW, client toy-record UI, integration tests
- **Post-Completion**: real-device push delivery (iOS installed-PWA quirks), cross-phone sync demo

## Implementation Steps

### Task 1: oplog + snapshot storage and API

- [x] migration `003_sync.sql`: `oplog(account_id TEXT NOT NULL, seq INTEGER NOT NULL, device_credential_id BLOB, record_type_tag TEXT NOT NULL, nonce BLOB NOT NULL, ct BLOB NOT NULL, created_at_unix INTEGER NOT NULL, PRIMARY KEY(account_id, seq))`, `snapshots(account_id TEXT PK, snapshot_seq INTEGER NOT NULL, nonce BLOB NOT NULL, ct BLOB NOT NULL, created_at_unix INTEGER NOT NULL)`, `sync_state(account_id TEXT PK, last_seq INTEGER NOT NULL DEFAULT 0, last_sync_unix INTEGER)`
- [x] `POST /api/sync/ops` (session auth): batch of `{record_type_tag, nonce, ct}`; server assigns contiguous `seq` values in one tx (read+bump `sync_state.last_seq`), returns `{assigned: [seq...]}`; per-op and per-batch size caps + per-account total-storage quota (env `CLOUD_ACCOUNT_QUOTA_BYTES`, default 50MB) → 413 on breach
- [x] `GET /api/sync/ops?since=<seq>` (session auth): ordered page (limit + `next` cursor); every sync API call updates `sync_state.last_sync_unix`
- [x] integration test: append from two sessions → strictly increasing seqs, cursor pagination exact, quota 413 — guards the sync contract

### Task 2: snapshot upload + compaction

- [x] `POST /api/sync/snapshot` (session auth): `{snapshot_seq, nonce, ct}` — upsert snapshot, delete oplog rows `seq <= snapshot_seq` in the same tx; reject `snapshot_seq > last_seq`
- [x] `GET /api/sync/snapshot` (session auth): latest snapshot (204 when none) — new-device bootstrap = snapshot + ops-since
- [x] integration test: snapshot at seq N compacts ops ≤ N, ops > N survive, fresh client restores snapshot+tail — guards the compaction contract

### Task 3: client sync engine + toy records

- [x] `web/cloud/js/sync.js`: record encrypt/decrypt per spec (`aad = "mt/v1/rec"‖account_id‖record_type‖record_id‖account_seq` — encrypt-then-assign is impossible, so AAD binds at *decrypt*: client verifies the server-claimed seq decrypts cleanly; tampered/reordered seq → AEAD failure surfaces a sync-integrity error), local mirror, push-batch on write, pull-on-open, LWW by `(record_id, client_ts)` for the toy type — ➕ scope note: implemented the local mirror as a plain IndexedDB store (`web/cloud/js/localdb.js`, extending the existing `unlock.js` LDK-cache pattern) instead of Dexie — `web/cloud/` has no bundler/vendoring step and already has this exact raw-IndexedDB pattern in-repo; Dexie is a `web/static/`-only dependency and this toy record set (a handful of notes) doesn't need its query layer. ➕ also: `record_id` isn't a separate wire column on `oplog` (Task 1's schema only has `record_type_tag`), so it's packed as `"<type>:<recordId>"` into `record_type_tag` — that field was never confidential (server-visible metadata already), so this satisfies the AAD binding without a migration change
- [x] snapshot logic: on unlock, if oplog tail > threshold (e.g. 500 ops) build + upload snapshot from local state
- [x] toy record UI in the unlocked shell: encrypted notes (create/edit/list) — exists to prove sync, labelled as demo (`web/cloud/js/notes.js`)
- [x] sync-status indicator in the unlocked shell: last-synced time, pending (unpushed) op count, offline state — driven by the sync engine's own state, no new API. This widget is the seed of the permanent cloud-mode status UI that C1 inherits
- [x] Vitest integration test (Node WebCrypto): encrypt→"server assigns seq"→decrypt roundtrip; decrypt with altered seq/type throws — guards the AAD anti-reorder property (`web/cloud/js/tests/sync.test.js`)

### Task 4: push subscriptions + VAPID

- [x] migration `004_push.sql`: `push_subscriptions(account_id TEXT NOT NULL, endpoint TEXT PK, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at_unix INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0)`, `scheduled_pushes(id INTEGER PK AUTOINCREMENT, account_id TEXT NOT NULL, fire_at_unix INTEGER NOT NULL, ct BLOB NOT NULL, sent_at_unix INTEGER)` + index on `(sent_at_unix, fire_at_unix)`
- [x] `POST /api/push/subscriptions` + `DELETE` (session auth); `GET /api/push/vapid-public-key` (unauthenticated on subdomain host)
- [x] cloudstore implements `webpush.SubscriptionStore`-shaped `List/Disable` for the relay sender (account-keyed instead of the bot's int64 user — adapt, don't force-fit)

### Task 5: schedule API + blind firing loop

- [x] `PUT /api/push/schedule` (session auth): replace-all — delete this account's unsent future entries, insert batch of `{fire_at_unix, ct}` (caps: entries ≤ 2000, ct ≤ 4KB — 4078-byte webpush payload limit minus RFC 8291 overhead)
- [x] sender goroutine in cmd/cloud: 30s ticker, `SELECT ... WHERE sent_at_unix IS NULL AND fire_at_unix <= now` → for each account fan out to enabled subscriptions via `webpush-go` (the stored `ct` is the app-layer ciphertext; webpush-go applies RFC 8291) → mark sent; 404/410 responses disable the subscription; per-send timeout + error logging via slog
- [x] graceful shutdown: ticker stops with the server context (mirror scheduler patterns)
- [x] integration test: fake sender captures due-and-only-due payloads; replace-all drops old future entries but never sent ones; 410 disables — guards the relay contract

### Task 6: service worker + NK

- [ ] `web/cloud/sw.js`: precache shell, `push` handler — read NK from IndexedDB, decrypt app layer (`aad="mt/v1/push"`) → rich notification; NK absent/decrypt fails → generic "Medication reminder"; `notificationclick` focuses/opens the shell
- [ ] NK provisioning on first unlock: generate NK, write as encrypted vault record (toy record machinery from Task 3) + plaintext copy in IndexedDB; settings toggle "rich notifications" ↔ generic mode (deletes IDB copy)
- [ ] client demo scheduler: "remind me in N minutes" button → encrypts payload under NK → `PUT /api/push/schedule` (stands in for the C1 reminder engine)
- [ ] SW registration + push permission prompt in the unlocked shell (user-gesture gated); on iOS gate the prompt behind installed state (`display-mode: standalone`) and show add-to-homescreen instructions first — **install-then-push ordering** per docs/cloud-mode.md Onboarding, with the step shown/skipped by derived state (subscription exists? standalone?), never a stored step counter

### Task 7: stale-sync warning

- [ ] hourly sweep in the sender goroutine: accounts whose latest unsent `fire_at_unix` is within `CLOUD_DRY_QUEUE_WARN_HOURS` (default 120h) **and** `last_sync_unix` older than 24h → send a server-composed generic push ("Open the app to keep reminders running"); record last-warned time in `sync_state` to fire at most once/day
- [ ] the warning text is a server constant — content-free by construction; no account data is read (only timestamps, which the server inherently has)

### Task 8: Verify acceptance criteria

- [ ] two-profile walkthrough: note created on A appears on B after open; snapshot compaction observed after threshold; push scheduled on A fires as a decrypted rich notification in B's SW (desktop browser push)
- [ ] verify zero-knowledge invariants: DB inspection shows only ciphertext in oplog/snapshots/scheduled_pushes; relay logs contain no payload plaintext
- [ ] `go test ./...`, `pnpm test`, both build modes, linter — all pass/fixed

### Task 9: [Final] Update documentation

- [ ] docs/cloud-mode.md: mark C0 complete (all three plans), update status header; note C1 (JS domain layer) as next
- [ ] docs/cloud-deployment.md: VAPID setup, quotas, `CLOUD_DRY_QUEUE_WARN_HOURS`; docs/environment.md: new env vars
- [ ] CLAUDE.md: reflect final cmd/cloud surface in the index/Code Layout if anything moved

## Technical Details

- **Two-layer push encryption**: server stores/relays client-encrypted `ct` (NK, AES-GCM) and webpush-go wraps it in RFC 8291 per subscription — the relay composes nothing and can read nothing; push services see only RFC 8291 ciphertext.
- **Replace-all schedule** mirrors the Capacitor `Reminders` loop semantics (docs/local-mode.md) — simpler than diffing, and idempotent from the client's viewpoint.
- **Seq assignment vs AAD**: the client cannot pre-bind an unknown seq into AAD at encrypt time; the binding is verified at decrypt (server-claimed seq must produce a clean AEAD open). Reordering/replay by the server therefore breaks decryption deterministically — same guarantee, verified at the reading edge.
- **`ponytail:` single sender goroutine, 30s tick** — per-account fan-out is tiny at C0 scale; shard the ticker only if account count makes a tick overrun its interval.

## Post-Completion

**Manual verification**:
- Real-device push: install PWA on iPhone (≥16.4) and Android, schedule a reminder, background/kill the app, confirm delivery + rich text with NK, generic without; note observed iOS delivery quirks in docs/cloud-mode.md
- Two-phone sync demo: note on phone A visible on phone B; stale-sync warning observed by letting the queue horizon lapse with a shortened `CLOUD_DRY_QUEUE_WARN_HOURS`

**External follow-ups**:
- C1 planning: JS domain layer (meds + intakes + reminder computation) behind the `/api` shim — the big fork documented in docs/cloud-mode.md "The client: porting the domain layer"
