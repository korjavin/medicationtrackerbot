# Unblock large-vault snapshot sync (compress + raise caps + stop the wedge loop)

bd: **med-9z3.1** (epic med-9z3)

## Overview

Importing a real 24 MB gzip vault into **cloud mode** makes the app unusable. Root
cause is a single wedged sync loop:

- The C2e full-vault import lands its whole record set in the local `records`
  store and propagates it to other devices **only** via one snapshot upload
  (`forceSnapshot` → `tryForceSnapshot` → `snapshotAt`, `web/cloud/js/sync.js`).
- `snapshotAt` sends the snapshot **uncompressed**: `JSON.stringify(records)` →
  encrypt → base64. A 24 MB vault → ~24 MB ciphertext → base64 ×4/3 → **~32 MB
  POST body**.
- The server caps the snapshot POST body at **8 MiB**
  (`internal/cloudserver/sync.go:27` `maxSnapshotBodyBytes = 8 << 20`, decoded
  via `io.LimitReader`). A 32 MB body is truncated → JSON decode fails → **HTTP
  400** every time (symptom 2).
- On failure `tryForceSnapshot` leaves `forceSnapshotPending` set
  (`sync.js:457`), and `pullOnOpen` re-runs it **before any pull/flush** every
  open and returns early if still pending (`sync.js:584-587`). So the client
  re-encrypts and re-POSTs ~32 MB on **every app launch**, fails, and never
  pulls the tail or flushes pending — this is the bulk of symptom 1 ("enormously
  slow"). It never converges.
- There is **no compression anywhere** on the cloud sync path (confirmed: zero
  `gzip`/`Content-Encoding` matches in `internal/cloudserver`, `web/cloud`,
  `cmd/cloud`). The very same JSON gzips ~10x in the legacy vault export
  (`internal/server/vault_export.go:68`).

**Fix (user-selected):** gzip the JSON **plaintext before encryption** so the
ciphertext (and therefore the POST body) shrinks ~10x, and raise the server caps
to real headroom so the cap is not the binding limit and oplog compaction keeps
working as the store grows. Because gzip must precede encryption to be effective,
this is a small, client-side snapshot payload-format change; the server treats
`ct` as opaque bytes and only needs the larger caps.

DONE = a 24 MB vault snapshot uploads successfully (~2–3 MB body), other devices
bootstrap from it, sync is not wedged, and a genuinely-too-big snapshot surfaces
an error instead of re-uploading forever and blocking pulls.

## Context (from discovery)

Files/components involved:
- `web/cloud/js/crypto.js` — `encryptSnapshot` (:265), `decryptSnapshot` (:272).
  Server never inspects `ct`, so format is entirely client-owned.
- `web/cloud/js/sync.js` — `snapshotAt` (:333, the uncompressed encode+POST),
  `bootstrap` (:235-256, the decrypt+`JSON.parse` on download), `tryForceSnapshot`
  (:415-464), `pullOnOpen` (:584-590, the wedge ordering).
- `internal/cloudserver/sync.go` — `maxSnapshotBodyBytes`/`maxSnapshotCTLen`
  (:27-28), `PostSnapshot` decode+validate (:206-222), `GetSnapshot` (:245).
- `cmd/cloud/main.go` — `ReadTimeout` (15s), account quota (snapshots bypass it).

Related patterns found:
- Legacy `internal/server/vault_export.go` gzips the same JSON ~10x — precedent
  for the ratio and approach.
- gzip streams have a fixed 2-byte magic header `0x1f 0x8b`; legacy raw-JSON
  snapshots start with `[` (`0x5b`) or `{` (`0x7b`). So the decrypt path can
  **sniff** whether to gunzip — no new wire field, no server/schema change, and
  old (uncompressed) snapshots stay readable.

Dependencies identified: `CompressionStream`/`DecompressionStream('gzip')` — a
Web Streams API available in modern browsers and the Capacitor WebView. No new
npm dependency.

## Development Approach

- **Testing approach**: NO unit tests. Cloud snapshot round-trip crosses a real
  boundary (client crypto/format ↔ server size caps) with data-loss risk, so
  Task 3 adds **one** integration test: gzip→encrypt→POST→GET→decrypt→gunzip of a
  large record set through the real server handler, asserting the body lands
  under the raised cap and round-trips byte-identical, plus a legacy
  (uncompressed) snapshot still decodes. That is the only test.
- Small focused changes; complete each task before the next.
- If the integration test is added, it must pass before the next task.
- Maintain backward compatibility: existing uncompressed snapshots on deployed
  accounts must still bootstrap (magic-byte sniff on decrypt).

## Testing Strategy

- **Unit tests**: none.
- **Integration tests**: one (Task 3) — the snapshot compress/round-trip boundary.
- **E2E tests**: none (no existing cloud e2e suite to reuse).

## Progress Tracking

- Mark completed items `[x]` immediately.
- ➕ newly discovered tasks, ⚠️ blockers.
- Keep this file in sync if scope shifts.

## Implementation Steps

### Task 1: Gzip snapshot plaintext before encryption (client)

- [x] Add small `gzip(bytes)` / `gunzip(bytes)` helpers in `web/cloud/js/crypto.js`
      (or a tiny shared util) using `CompressionStream`/`DecompressionStream('gzip')`,
      returning `Uint8Array`.
- [x] In `web/cloud/js/sync.js` `snapshotAt` (:335-337): after
      `JSON.stringify(records)` → `TextEncoder().encode(...)`, gzip the bytes and
      pass the **gzipped** bytes as `plaintext` to `encryptSnapshot`. (Encrypt the
      compressed bytes — do NOT change `encryptSnapshot`'s crypto/AAD.)
- [x] In `web/cloud/js/sync.js` `bootstrap` (:238-245): after `decryptSnapshot`,
      sniff the first two plaintext bytes — if `0x1f 0x8b`, `gunzip` before
      `TextDecoder().decode` + `JSON.parse`; otherwise decode as-is (legacy
      uncompressed snapshot). No `snapshot_seq`/nonce/AAD changes.
- [x] Confirm no other reader decrypts a snapshot (only `bootstrap` does) so the
      sniff lives in exactly one place.

### Task 2: Raise server snapshot caps + honest failure (server + client)

- [x] `internal/cloudserver/sync.go`: raise `maxSnapshotBodyBytes` and
      `maxSnapshotCTLen` from `8 << 20` to `64 << 20` (headroom well above a
      compressed large vault, so the cap stops being the binding limit and
      compaction keeps working as the store grows). Keep the existing
      `len(req.CT) > maxSnapshotCTLen` and nonce validation.
- [x] Sanity-check `cmd/cloud/main.go` `ReadTimeout` (15s) is comfortable for a
      ~2–3 MB compressed upload (it is; note it here, no change unless a slow-link
      concern is raised).
- [x] Stop the wedge: in `web/cloud/js/sync.js`, when `snapshotAt` fails inside
      `tryForceSnapshot` with a **non-transient** rejection (HTTP 4xx, i.e. the
      body was accepted by the network but refused — distinct from the offline
      `catch`/`!res.ok` 5xx path), record the failure durably (e.g. a
      `forceSnapshotError` meta field / integrity counter) and DO NOT keep
      re-encrypting the same oversized body every open. The pull/flush path must
      still run so the rest of the app syncs. `snapshotAt` currently returns a
      bare `false` for both oversized-400 and offline; thread enough signal
      (status code) so `tryForceSnapshot`/`pullOnOpen` can distinguish
      "retryable offline" from "this snapshot will never fit — surface it and let
      pulls proceed."
- [x] Surface `forceSnapshotError` in whatever status/offline indicator the shell
      already reads, so a stuck import is visible rather than a silent spinner.

### Task 3: Integration test — snapshot compress round-trip through the real handler

- [ ] Add one integration test (Go side, `internal/cloudserver`) that POSTs a
      compressed snapshot representative of a large vault and asserts: (a) the
      body is accepted (under the raised cap), (b) `GET /api/sync/snapshot`
      returns it byte-identical, and (c) an uncompressed (legacy) snapshot body
      still POSTs+GETs successfully. Client-side gzip/gunzip+sniff correctness is
      covered by the byte-identical round-trip of the ciphertext plus a plaintext
      magic-byte assertion. Must pass before Task 4.

### Task 4: Verify acceptance criteria

- [ ] Re-import a large synthetic vault in cloud mode; confirm the snapshot POST
      succeeds and the body is ~2–3 MB, not ~32 MB.
- [ ] Confirm `forceSnapshotPending` clears and a second device bootstraps the
      imported data.
- [ ] Confirm a legacy uncompressed snapshot still bootstraps (back-compat).
- [ ] Run `go test ./internal/cloudserver/...` and `pnpm test` — must pass.
- [ ] Run linters — all issues fixed.

### Task 5: [Final] Docs

- [ ] Update `docs/cloud-crypto.md` "snapshot" section (and
      `docs/cloud-mode.md` if it describes the snapshot payload) to note snapshots
      are gzip-then-encrypt with a magic-byte-sniffed back-compat read, and the
      64 MiB server caps.

## Technical Details

- Snapshot plaintext-to-encrypt goes from `utf8(JSON)` to `gzip(utf8(JSON))`.
  Encryption (AES-GCM, AAD `mt/v1/snap ‖ account_id ‖ snapshot_seq`), the
  `{snapshot_seq, nonce, ct}` wire shape, and server storage are all unchanged —
  `ct` is opaque to the server.
- Back-compat read: `plaintext[0]==0x1f && plaintext[1]==0x8b` → gunzip; else
  parse as raw UTF-8 JSON. No version field needed.
- Caps 8 MiB → 64 MiB on both body and CT. Snapshots bypass the account quota
  (`AppendOps` path only), so quota is unaffected.
- Wedge fix distinguishes 4xx (won't-fit → surface, let pulls run) from
  offline/5xx (retry next open), instead of the current undifferentiated
  `return false`.

## Post-Completion

**Manual verification:**
- Import the actual 24 MB vault on the deployed cloud instance; confirm
  responsiveness restored and history/vitals load (those are separate beads
  med-9z3.2 / .3, but the wedged sync must be cleared first for them to matter).
- Slow-link check: a ~2–3 MB upload under the 15s `ReadTimeout` on mobile data.

**External:** none.
