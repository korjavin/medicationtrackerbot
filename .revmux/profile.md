[#](#) Project conventions — medicationtrackerbot

Self-hosted health-tracking PWA built around a **zero-knowledge vault**. `cmd/cloud` is the product:
the browser holds the vault keys, the plaintext and all domain logic; the server only stores encrypted
sync state and operates relays.

`CLAUDE.md` at the repo root is normative and links the detailed docs. Read it before reviewing. What
follows is the calibration that is not obvious from the diff.

## Invariants — a violation is a real finding

1. **Domain logic lives in one place per runtime.** Browser: `web/domain/*.js`, pure ES modules with
   injected ports and zero browser globals. `web/cloud/js/apishim.js` and `mcp-responder.js` only route
   into it — logic in a router is a finding. Go: `internal/domain/*` service pattern.
2. **Migrations in `internal/store/migrations/` are immutable.** Editing an existing one is critical;
   changes go in a new migration.
3. **Reads that write need an LWW floor** (CLAUDE.md rule 12). A read path that lazily materializes a
   record into a *deterministic* recordId must stamp `clientTs: 0` and write via `records.putIfAbsent`,
   never `now()` + `put`. Otherwise a device with a stale mirror re-derives that recordId and LWW erases
   the real row. Ask of any new write: *could a device that hasn't synced recently produce this same
   recordId?* If yes it is derived state, takes the floor, and never overwrites the slot. `putIfAbsent`
   treats a tombstone as occupied. Read/timer-side *transitions* on a singleton keep plain `put` but
   still take the floor, promoting to `existing.clientTs + 1`. This has caused three shipped data-loss
   bugs (med-d4w, med-9a87, med-qhpu, med-y4ue) — flag it hard.
4. **No hardcoded colors and no inline `.style.` assignments in frontend code.** Visual values come from
   `--wg-*` design tokens plus CSS classes.
5. **Frontend write handlers use `DataStore.applyOptimistic`** (commit/rollback). `invalidateTags +
   loadX()` is only for read-only refreshes and the rollback path.
6. **Device capabilities route through `web/static/js/native/`** (`window.MediaCapture`,
   `window.Barcode`). Raw `getUserMedia`/`BarcodeDetector` and any `window.Capacitor` reference are
   banned.
7. **New `window.*` globals** need an allowlist entry in `tests/architecture.globals.test.js` with a
   justification.
8. **The app document must not surface Telegram** — no `telegram.org` script tag in
   `web/static/index.html`, no Telegram login screen in cloud.
9. **`internal/cloudstore` must never import `internal/store`** (goose migration-registry landmine); it
   may import `internal/store/db` only.
10. **CSP:** the account app document must never serve a wildcard `https:`/`wss:` `connect-src` —
    per-account allowlist only.
11. **New egress paths** must be declared in `web/cloud/js/privacy-manifest.js` (with `file:line`
    evidence and `userCopy`) and `pnpm privacy:docs` re-run. The manifest is the single source of truth
    for what leaves the vault; the docs table is generated and must never be hand-edited.
12. **Dose-like timestamp columns** participating in SQL equality are `INTEGER` unix-seconds-UTC, never
    `DATETIME` text; normalize via `storedb.TimeToUnix`/`UnixToTime`.
13. **Navigation:** the bottom nav is canonical, one slot per section. No "More" aggregator, no
    `section-header-mount` banners. The Vitals slot keeps internal id `health` for deeplink stability.
14. Go logging is `log/slog` with contextual args, never `log.Printf`.

## Testing posture — read this before raising a test finding

**Integration-first. The maintainer does not want unit tests per function.**

- Frontend behavior belongs in the owning feature suite via `tests/helpers/frontend-harness.js`,
  exercised through the real entry point. Pure-unit tests only for layers that genuinely have no
  integration entry point.
- **Do not ask for** coverage-driven `*-branches` / `*-edges` files, standalone `pin-defect-N` /
  `task-N` files, one test file per function, or a test whose only justification is an uncovered branch.
  These are explicitly against project rules — proposing one is itself a finding against your review.
- A missing test is reportable only when you can name the concrete defect it would catch and it belongs
  in an existing suite. "No test for this function" is noise here.
- Prefer one test that drives the real path over several that assert on mocks. A finding that a test
  asserts on internal call sequences rather than observable results is welcome.
- Architecture guards (`tests/architecture.*.test.js`) are the enforcement layer for the invariants
  above. New rule → extend the guard, not a bespoke test.

## Style — the maintainer is deliberately minimal

Prefer the smallest thing that works. Over-engineering is a finding in its own right: an interface with
one implementation, a factory for one product, config for a value that never changes, scaffolding "for
later", a new dependency for what a few lines of stdlib do. Deletion beats addition; boring beats
clever. Do not propose an abstraction the diff does not already need.

Deliberate simplifications are marked with a `ponytail:` comment naming the ceiling and the upgrade
path. Do not report those as unfinished work.

## Out of scope — do not report

- **Bot mode is legacy.** `internal/bot`, `internal/server`, `internal/scheduler` and `cmd/bot` are
  deprecated and not deployed. They must keep compiling and passing tests, nothing more. Never raise
  parity gaps, backports, or UX regressions in bot mode caused by cloud-only features.
- **The Capacitor Android shell is frozen** (branch `mobile`). No feature work; seams just keep
  compiling.
- **`cmd/cloud` is the only shipped binary.** Everything else under `cmd/` is dev/operator tooling —
  do not review it as production surface or ask for production hardening there.
- Issue tracking is **bd (beads)**. Do not suggest TODO comments or markdown task lists.
