# Cloud Admin Inspect — Operator Debug View Over Accounts, Devices, Envelopes, Sync, Push

## Overview

A read-only `cloud admin inspect <subdomain>` CLI subcommand (plus small
enrichments to the existing `cloud admin list`) that shows the operator
everything the server knows about an account: devices (credentials), DEK
envelopes, sync-log state, and the push queue.

Two purposes:

1. **Debugging**: answer "did the phone's write reach the server?", "does
   device 2 have an envelope?", "did snapshot compaction run?", "is the push
   queue draining?" without sqlite3 spelunking.
2. **Zero-knowledge ground truth**: the output is *by construction* the
   complete metadata-leakage surface — sizes, timestamps, counts, record-type
   tags, never plaintext. A sample of it gets pasted into
   `docs/cloud-mode.md`'s metadata-leakage section as living documentation of
   what a hostile operator could see.

Deliberately a CLI (reached via `docker exec`, same trust boundary as
`admin invite`), NOT a web page — an admin web UI would add auth + attack
surface to a zero-knowledge service for no debugging gain. Strictly
read-only: no mutation beyond what existing admin subcommands already do.

**Scheduling note**: independent of C1/C2 (read-only, no shared files with
the C1 branch beyond `cmd/cloud/admin.go` — see conflict note in Post-
Completion). Intended to run after C1 merges.

## Context (from discovery)

- Admin CLI dispatch: `cmd/cloud/main.go:143` → `runAdmin` in
  `cmd/cloud/admin.go` (subcommands: `invite`, `list`, `reset-claim`,
  `revoke`, `delete`). Each invocation opens its own DB handle. `admin list`
  = `adminList` (`admin.go:46`) over `cloudstore.ListAccounts`.
- Existing read queries that already cover part of the view:
  `CredentialsByAccount` (id, transports, sign_count, backup flags,
  created, last_asserted — `internal/cloudstore/repo.go`), `ListEnvelopes`
  (account_id, credential_ref, v, nonce, ct, mac).
- Sync tables (`internal/cloudstore/migrations/003_sync.sql`, queries in
  `sync.go`): `sync_ops` (account_id, seq, device_credential_id,
  record_type_tag, nonce, ct, created_at_unix), `sync_snapshots`
  (snapshot_seq, nonce, ct, created_at_unix). `record_type_tag` is the
  plaintext `"<type>:<id>"` tag — type histograms are derivable server-side.
- Push tables (`004_push.sql`, queries in `push.go`): `push_subscriptions`
  (endpoint, disabled, created), `scheduled_pushes` (fire_at_unix, ct,
  sent_at_unix).
- Envelope/credential refs are base64 rawURL of the credential id
  (`internal/cloudserver/webauthn.go` register finish) — the inspect view
  should print the same short prefix for both so the operator can eyeball
  the credential↔envelope pairing.

## Development Approach

- **Testing approach**: NO unit tests. They blow up the codebase for no value here.
  - add an integration test ONLY when it covers a real boundary (API contract, data migration, cross-component flow) and gives a guarantee manual checking can't
  - here: one repo-level test for the new SQL aggregate queries (real SQL over the real schema is a boundary; string formatting of the CLI is not)
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: if a task adds an integration test, it must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Read-only: no new writes, no new HTTP routes (MCP coverage guard untouched)

## Testing Strategy

- **Unit tests**: none. Do not add unit tests.
- **Integration tests**: one test in `internal/cloudstore` exercising the new
  inspect queries against a seeded repo (accounts + credentials + ops +
  snapshot + push rows), asserting counts/seqs/tags come back right. CLI
  formatting is verified manually.
- **E2E tests**: none.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix

## Implementation Steps

### Task 1: cloudstore inspect queries

- [x] add `internal/cloudstore/inspect.go` with read-only aggregates, one
      `InspectAccount(ctx, accountID)` returning a struct composed of:
      sync stats (op count, min/max seq, last append time, last appending
      device credential id), record-type histogram (split
      `record_type_tag` on the first `:`, count per type), snapshot state
      (seq, ct byte size, written at — nil when none), envelope list
      (credential_ref, v, ct byte size), push state (active + disabled
      subscription counts, pending scheduled count, next fire time, last
      sent time)
- [x] reuse `CredentialsByAccount` for the device list — no new query
- [x] add `AccountSummaries(ctx)` for the enriched `list`: per account —
      subdomain, created, claimed (credential count > 0), device count,
      op count, last sync activity (single GROUP BY query joined over
      accounts; keep it one query, not N+1)
- [x] integration test in `internal/cloudstore/inspect_test.go`: seed two
      accounts (one with ops from two credentials + snapshot + scheduled
      pushes, one empty/unclaimed), assert `InspectAccount` and
      `AccountSummaries` values

### Task 2: `cloud admin inspect` subcommand + enriched `list`

- [ ] wire `inspect <subdomain>` into `runAdmin` (`cmd/cloud/admin.go`),
      resolving the account via `AccountBySubdomain`; unknown subdomain →
      clear error, exit 1
- [ ] output: plain aligned text (stdlib `text/tabwriter`), sections
      `account / devices / envelopes / sync / push`; credential ids and
      envelope refs printed as the same 8-char prefix so pairings are
      eyeball-able; times in UTC RFC3339; byte sizes human-readable
- [ ] devices section marks synced passkeys (`backup_eligible`) and shows
      `last unlock` from `last_asserted_at`; never-asserted prints `never`
- [ ] switch `adminList` to `AccountSummaries` output (adds claimed/devices/
      ops/last-activity columns); keep existing columns so muscle memory
      survives
- [ ] no secrets in output: never print claim tokens, nonces, MACs, or
      ciphertext bytes — sizes and counts only (nonce/ct presence is implied
      by the envelope row existing)

### Task 3: Verify acceptance criteria

- [ ] `inspect` on a live-ish seeded DB shows all sections correctly,
      including the empty-account case (no credentials, no ops, no snapshot)
- [ ] `go build ./... && go build -tags mobile ./...` green;
      `go test -count=1 ./internal/cloudstore/ ./cmd/cloud/...` green;
      full `go test ./...` green
- [ ] run linter — all issues fixed

### Task 4: [Final] Update documentation

- [ ] `docs/cloud-deployment.md`: add `admin inspect` (+ enriched `list`) to
      the admin command reference with a trimmed sample output
- [ ] `docs/cloud-mode.md`: paste a representative `inspect` output into the
      metadata-leakage section as the ground-truth illustration of what the
      operator sees ("this is the entire view — sizes, timestamps, tags")
- [ ] `CLAUDE.md`: no change expected (CLI lives under existing `cmd/cloud`
      entry) — confirm and skip if so

## Technical Details

- Record-type histogram comes from `record_type_tag` prefixes — this is
  existing plaintext metadata, the view adds zero new leakage; that fact is
  the point of documenting it.
- `InspectAccount` composes existing + new queries in plain Go; no
  transaction needed (read-only, mild cross-query skew is fine for a debug
  view).
- Empty states must render explicitly (`snapshot: none`, `ops: 0`,
  `push: no subscriptions`) — an empty section that silently vanishes hides
  exactly the bugs this tool exists to show.

## Post-Completion

*No checkboxes — informational.*

**Merge-conflict watch**: `cmd/cloud/admin.go` may also be touched by other
cloud work; this plan is deliberately additive (new case in the dispatch
switch + new file) so conflicts stay trivial. Run after C1 merges.

**Manual verification on the Hetzner rig**: `docker exec medtracker-cloud
./cloud admin inspect <subdomain>` against the real account after some
BP/weight writes land (post-C1) — confirm op counts climb, tags show
`bp`/`weight`, snapshot appears after ~500 ops, and the push queue drains
around reminder times.
