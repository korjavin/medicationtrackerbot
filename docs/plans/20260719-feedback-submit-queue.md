# Cloud feedback channel — age-encrypt + durable reliable submit (bd med-dni.3)

## Overview

Third slice of the cloud feedback channel (epic med-dni). Implements the
`enqueueFeedback(bundle)` seam that med-dni.2's capture UI already calls (currently a
stub in `web/cloud/js/feedback-submit.js`). This task makes feedback actually reach the
developer, **reliably and encrypted**:

1. **age-encrypt** the feedback bundle (text + attachments) client-side to the
   developer's X25519 **recipient** public key (`getFeedbackRecipient()`, the `age1...`
   string from med-dni.1's meta tag). The server only ever stores ciphertext.
2. **Durable submit queue** — persist the ciphertext to a small IndexedDB outbox and
   POST it to `POST /api/feedback` (shipped in med-dni.1). A bad or offline connection
   **defers, never loses**: a drain loop retries with exponential backoff and drains on
   reconnect. Idempotent via a per-item `client_id` (server dedupes on it).

**Cloud-first**, JS-only, in `web/cloud/js/`. Replaces the `feedback-submit.js` stub;
the exported `enqueueFeedback(bundle)` signature is unchanged, so med-dni.2's UI and its
test (which mocks the module) keep working.

## Context (from discovery)

- **age recipient mode is already vendored** — typage (`age-encryption`) at
  `web/static/vendor/age.min.js` exports `Encrypter`; `addRecipient('age1...')` decodes
  the bech32 recipient internally, `.encrypt(Uint8Array)` returns the standard
  `age-encryption.org/v1` binary. No new crypto, no hand-rolled stanzas. Base64 with
  `toBase64` (`web/cloud/js/crypto.js:26`).
  - The absolute `/static/vendor/age.min.js` import doesn't resolve under Vitest →
    **copy the `setLoader()` seam** from `web/static/js/core/backup-crypto.js:30`; its
    test injects a Node loader (`backup-crypto.test.js:53`,
    `setLoader(() => import(pathToFileURL(VENDOR).href))`). `feedback-submit.js` needs the
    same overridable loader for its dynamic import.
- **Durable outbox pattern** — cloud sync uses **raw IndexedDB** (`web/cloud/js/localdb.js`
  `openDb()`, DB `medtracker-cloud`). Mirror the shape, don't reuse the oplog `pending`
  store (seq/snapshot-coupled). Enqueue = `store.put` (`sync.js:244`), read =
  `getAll` (`sync.js:248`), drain+error-policy = `flushPending`/`flushPendingUnlocked`
  (`sync.js:849,855`, retryable = network `status:0` / 5xx, permanent = 4xx after a cap,
  `sync.js:32-34,599`), reconnect autodrain = `startReconnectAutoDrain` (`sync.js:1064` —
  `online` + `visibilitychange`-gated-on-`navigator.onLine`, 250ms debounce, teardown).
  Sync is event-driven with **no backoff timer** — add a `setTimeout` exponential-backoff
  reschedule ourselves.
- **POST** — `apiCallDirect(endpoint, method, body, opts)` (`web/static/js/core/api.js:89`,
  exposed `:205`): object body → JSON + `Content-Type`, same-origin session cookie,
  returns parsed JSON / `true` on 204, throws `Error` with `.status` on non-ok. Use
  `await apiCallDirect('/api/feedback','POST',{client_id,kind,app_version,ciphertext})`.
- **ids + version** — `crypto.randomUUID()` for a fresh anonymous `client_id`;
  `app_version` from `document.querySelector('meta[name="medtracker-build-id"]')?.content`
  (`update-check.js:29`, `'dev'` when unstamped).
- **Test posture** — `feedback-submit.js`'s own tests: `import 'fake-indexeddb/auto'`
  (`sync.test.js:1`), `vi.stubGlobal('fetch', ...)` (`sync.test.js:245`), the age
  `setLoader` Node seam (`backup-crypto.test.js:53`). med-dni.2's `feedback-ui.test.js`
  mocks `feedback-submit.js`, so put the submit-pipeline tests in their own `describe`
  (own focused file `web/cloud/js/tests/feedback-submit.test.js`). Run vitest with
  **Node 20** (`/tmp/node-v20.18.1-linux-x64/bin` on PATH;
  `node node_modules/vitest/vitest.mjs run <file>`).

## Development Approach

- **Testing approach**: Regular. Each task ends with passing tests (Node 20 for vitest).
- Encrypt **at enqueue time** so plaintext never persists to IndexedDB — the outbox
  stores only ciphertext. Privacy by construction.
- Keep the outbox its own tiny store; copy sync's error classification + reconnect
  listener shape; add the one thing sync lacks (a backoff timer).

## Progress Tracking
- Mark `[x]` immediately. `➕` new, `⚠️` blocker.

## Implementation Steps

### Task 1: serialize bundle + age-encrypt to the recipient
- [x] In `web/cloud/js/feedback-submit.js` add an overridable age loader
      (`setLoader(fn)` / default `() => import('/static/vendor/age.min.js')`), copying
      `backup-crypto.js:30`.
- [x] Add `serializeFeedback(bundle, meta)` → a v1 plaintext JSON document (the contract
      with med-dni.4's decrypt CLI): `{ v:1, created_at, text, attachments:[{ type, mime,
      data_b64 }] }` (attachment `bytes` → base64). UTF-8 encode to `Uint8Array`.
- [x] Add `encryptToRecipient(bytes, recipient)`: load typage, `new Encrypter()`,
      `addRecipient(recipient)`, `await e.encrypt(bytes)` → base64 the result. Throw a
      clear error if `recipient` is empty (feature misconfigured — UI shouldn't call it).
- [x] Tests (`web/cloud/js/tests/feedback-submit.test.js`, Node 20, `setLoader` Node
      seam): a bundle round-trips through `serializeFeedback` (text + both attachment
      types preserved as base64); `encryptToRecipient` produces a non-empty base64 blob
      that begins with the age v1 header when decoded (or decrypts back with a test
      identity via typage `Decrypter` — assert plaintext JSON matches); empty recipient
      throws.
- [x] Run the test (Node 20) — must pass before Task 2.

### Task 2: durable IndexedDB outbox + enqueueFeedback
- [x] Add a small feedback outbox store. Prefer a **4th object store** in
      `localdb.js` `openDb()` upgrade (`localdb.js:14-24`) named `feedback_outbox`
      (keyPath `client_id`), so it shares the `medtracker-cloud` DB; if bumping that
      DB's version is risky, use a separate `indexedDB.open('medtracker-feedback', 1)`.
      Helpers: `putFeedbackItem`, `getAllFeedbackItems`, `deleteFeedbackItem`
      (mirror `sync.js:244/248` + `DeleteInboxEvent`-style scoped delete).
- [x] Implement `export async function enqueueFeedback(bundle)`:
      1. `recipient = getFeedbackRecipient()`; if empty, throw (UI gates on this).
      2. `meta = { client_id: crypto.randomUUID(), kind: 'feedback', app_version: <build-id meta>, created_at: new Date().toISOString() }`.
      3. `ciphertext = await encryptToRecipient(serializeFeedback(bundle, meta), recipient)`.
      4. Persist `{ client_id, kind, app_version, ciphertext, attempts:0, created_at }`
         to `feedback_outbox` (ciphertext only — no plaintext at rest).
      5. Kick the drain (Task 3) — fire-and-forget; resolve as soon as it's durably
         queued (the UI's "sent" is optimistic, delivery is the queue's job).
- [x] Tests: `enqueueFeedback` persists exactly one ciphertext item (no plaintext fields
      in the stored row); a second call with a distinct bundle stores a second item;
      the stored `client_id` is a uuid; missing recipient throws before persisting.
- [x] Run the test (Node 20) — must pass before Task 3.

### Task 3: drain loop — POST, error policy, exponential backoff, reconnect
- [x] `drainFeedbackOutbox()` (single-slot promise-chain lock like `flushChain`,
      `sync.js:849`): for each outbox item,
      `await apiCallDirect('/api/feedback','POST',{client_id,kind,app_version,ciphertext})`.
      - success (2xx / `true`) → `deleteFeedbackItem(client_id)`.
      - permanent failure — `err.status` 400/413/401-after-auth? Classify per sync
        (`sync.js:32-34,599`): **4xx (bad payload, 400/413) = give up** and drop the item
        (optionally after logging); **401** = auth not ready → retry later (don't drop);
        **network (`status` undefined/0), 5xx, 503 (feature temporarily disabled) =
        retry** — increment `attempts`, keep the item.
      - After a retryable failure, schedule a re-drain with **exponential backoff**
        (`setTimeout`, base ~2s, factor 2, cap ~5min, jitter), guarded against
        overlapping timers. Cap `attempts` at a sane max (e.g. 20) then park the item
        (leave it for the next `online`/session, don't infinite-loop).
- [x] Wire triggers: kick `drainFeedbackOutbox()` from `enqueueFeedback` and install a
      `startFeedbackAutoDrain()` copying `startReconnectAutoDrain` (`sync.js:1064`):
      `online` + `visibilitychange`(gated on `navigator.onLine`), 250ms debounce,
      in-flight guard, returns a teardown.
- [x] Tests (fake-indexeddb + `vi.stubGlobal('fetch')`): happy path → 204 removes the
      item + POST body carries the base64 ciphertext + client_id; a network throw keeps
      the item and increments `attempts`; a 503 keeps + retries; a 400 drops the item; a
      duplicate `client_id` re-POST is safe (server dedupes — assert we still delete on
      the 204 it returns); backoff reschedules (use fake timers, assert a second fetch
      after advancing the timer). Assert no unhandled rejections.
- [x] Run the test (Node 20) — must pass before Task 4.

### Task 4: wire startup + verify
- [ ] Call `startFeedbackAutoDrain()` once from cloud boot (near where med-dni.2's
      launcher mounts in `web/cloud/js/cloud-boot.js`, gated on the same
      `getFeedbackRecipient()` non-empty check) so a queued item left from a previous
      session drains on next open. Idempotent (dedupe by a module-level guard).
- [ ] Run the full frontend suite (`node node_modules/vitest/vitest.mjs run`, **Node 20**)
      incl. `architecture.globals.test.js` (no new `window.*` global — ES module exports),
      `architecture.cloud-tokens.test.js` — all green.
- [ ] `go build ./...` + `go build -tags mobile ./...` (no Go changes; confirm build).

### Task 5: Verify acceptance criteria
- [ ] Feedback is age-encrypted to the recipient pubkey client-side; the outbox and the
      server store only ciphertext (no plaintext at rest, verified by the enqueue test).
- [ ] Submit is durable: offline/5xx defers and retries with exponential backoff; drains
      on `online`/visibility and on next app open; idempotent on `client_id`.
- [ ] Permanent (4xx) failures are dropped, not retried forever; retryable failures are
      capped, not infinite.
- [ ] med-dni.2's UI + its test still pass against the real `enqueueFeedback`.

## Technical Details

- **Plaintext document v1 (contract with med-dni.4)**:
  `{ "v":1, "created_at":"<iso8601>", "text":"...", "attachments":[ { "type":"image"|"audio", "mime":"image/jpeg"|"audio/webm", "data_b64":"..." } ] }`
  UTF-8 → age v1 encrypt → base64 → POST `ciphertext`. med-dni.4 base64-decodes,
  age-decrypts with the private key, `JSON.parse`, writes each attachment to disk.
- **Cleartext metadata** (server columns from med-dni.1): `client_id` (uuid, idempotency),
  `kind` (`'feedback'`), `app_version` (build id, lets the dev triage without decrypting).
  Everything the user authored stays inside the ciphertext.
- **Encrypt-at-enqueue**: plaintext is never written to IndexedDB — only the age blob.
- **Backoff is the one addition over sync**: sync drains on events only; feedback adds a
  self-rescheduling `setTimeout` so a persistently-offline device still retries without a
  user action, capped so it parks rather than spins.
  <!-- ponytail: single global backoff timer + one shared drain lock; fine for a low-rate anonymous outbox -->

## Post-Completion

**Manual verification** (cloud deploy, `FEEDBACK_AGE_RECIPIENT` set to a real age
recipient): send feedback with airplane mode on → confirm it queues and doesn't error;
turn networking back on → confirm the row lands in the server `feedback_queue` and the
outbox empties. Decrypt with the private key (med-dni.4) to confirm the plaintext
document round-trips.

**Follow-on**: med-dni.4 (dev decrypt CLI consuming this plaintext format +
`ListFeedback`/`DeleteFeedback`); med-dni.5 (Telegram channel into the same queue).
