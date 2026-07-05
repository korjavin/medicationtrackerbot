# Cloud Mode: Devices Entry Point — Settings Row + /devices Page

## Overview

The full add-a-second-device machinery shipped in C0b and works: Path B QR/typed-code
hand-off (`web/cloud/js/transfer.js`), device list with revoke + envelope-MAC audit
(`web/cloud/js/devices.js`), claim flow on the new device (`/claim` route), and all
server endpoints (`POST /api/transfer`, `POST /api/transfer/{slot}/claim`,
`GET/DELETE /api/devices`). But it is unreachable in normal use: the only UI entry
point is the unlock shell's `renderUnlocked` menu (`web/cloud/js/unlock.js:121`),
which renders **only** on the LDK warm-cache-write-failure fallback path. Every
normal boot (warm unlock via `cloud-boot.js`, or cold unlock success) redirects
straight to `/` — the real `web/static` app — which has no link to device management.
A user who claimed their instance on one device has no discoverable way to enroll a
second one.

Fix: give the shell a dedicated `/devices` page (warm-unlocks silently, renders the
existing device list), and add a cloud-only "Devices" row to the real app's Settings
screen that links to it. No new crypto, no new endpoints, no changes to
`devices.js` / `transfer.js` / `claim.js`.

**Relation to C2**: this is a standalone sibling of the C2a/C2b plans, not a step
inside them. C2a touches Settings *data* (vault records via the shim); this touches
the Settings *screen* and the cloud shell. No shared code, no dependency either
direction — safe to run before, after, or in parallel. Only known friction: a
trivial merge risk in `web/static/js/features/settings.js` if C2a lands concurrently.

## Context (from discovery)

- `internal/cloudserver/router.go:147` — shell-path case: `/unlock`, `/claim`,
  `/recover` all rewrite to `signup.html`. `/devices` joins this list.
- `web/cloud/js/app.js:23-36` — shell entry dispatch on `location.pathname`.
  Adds a `/devices` branch.
- `web/cloud/js/unlock.js` — already exports `readLdkRecord()` and
  `unwrapWithLdk(record)` (used by `cloud-boot.js:16-27` for warm unlock). Reuse
  as-is for the `/devices` page's silent unlock.
- `web/cloud/js/devices.js:8` — `renderDeviceList(app, ctx, onExit)` with
  `ctx = {dek, accountId}`; mounts into any container. "Add a device" button
  already dynamic-imports `transfer.js`. Unchanged.
- `web/cloud/js/cloud-boot.js:12` — sets `window.__MEDTRACKER_CLOUD__ = true`
  before any web/static script runs. This is the existing, already-allowlisted
  cloud-mode signal the Settings row gates on. No new `window.*` global.
- `web/static/js/features/settings.js` — Settings screen; gains the cloud-only row.
- `web/cloud/js/apishim.js` — NOT touched: the row is a plain navigation link to
  `/devices`, not an API call.
- Existing test suites: `web/static/js/tests/settings.*.test.js` (Vitest via
  `tests/helpers/frontend-harness.js`), `internal/cloudserver/*_test.go`.

## Development Approach

- **Testing approach**: NO unit tests. They blow up the codebase for no value here.
  - add an integration test ONLY when it covers a real boundary (API contract, data
    migration, cross-component flow) and gives a guarantee manual checking can't
  - if no integration test adds a real guarantee, the task has NO test items — that
    is correct and expected
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: if a task adds an integration test, it must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Maintain backward compatibility: server and mobile builds must never render the
  Devices row (`window.__MEDTRACKER_CLOUD__` is undefined there)

## Testing Strategy

- **Unit tests**: none.
- **Integration tests**: two boundaries are worth guarding — (1) the router serving
  the shell at `/devices` (Go, extends the existing host-routing test), (2) the
  Settings row's cloud-flag gate (Vitest, extends the existing settings suite —
  guards the "never show on server/mobile builds" contract).
- **E2E tests**: none — no existing e2e suite covers the cloud shell.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope
- Keep plan in sync with actual work done

## Implementation Steps

### Task 1: Serve the shell at /devices

- [x] `internal/cloudserver/router.go:147` — add `r.URL.Path == "/devices"` to the
      shell-path case (rewrites to `signup.html`, same as `/unlock`/`/claim`/`/recover`)
- [x] update the routing comment block above the case to mention `/devices`
- [x] integration test: extend the existing router/host-routing Go test — GET
      `https://<sub>.<base>/devices` returns the shell page (guards the real
      route contract; without it the frontend link 404s to the app SPA fallback)

### Task 2: /devices dispatch in the cloud shell

- [x] `web/cloud/js/app.js` — add a `location.pathname === '/devices'` branch
      before the unlock fallback: import `readLdkRecord`/`unwrapWithLdk` from
      `unlock.js` and `renderDeviceList` from `devices.js`; warm-unlock, build
      `ctx = {accountId, dek}`, call
      `renderDeviceList(document.getElementById('app'), ctx, () => { location.href = '/'; })`
- [x] no-warm-cache path: `readLdkRecord()` returns null (fresh profile / cleared
      storage) → `location.href = '/unlock'` (cold unlock lands the user in the
      app; they tap the Settings row again — now warm). Same failure handling for
      `unwrapWithLdk` throw, mirroring `cloud-boot.js:35-38`.
      <!-- ponytail: no ?next= return-URL plumbing; add if the two-tap cold path annoys anyone -->

### Task 3: Cloud-only Devices row in Settings

- [x] `web/static/js/features/settings.js` — render a "Devices" row/card
      ("Manage devices · add a new device") only when
      `window.__MEDTRACKER_CLOUD__` is truthy; activation navigates to `/devices`
      (plain `location.href` — full page swap into the shell is intended)
- [x] follow the screen's existing row markup + design tokens (no hardcoded
      colors, no inline `.style.` — rule 3); reuse an existing settings-row class
- [x] integration test: extend the existing settings Vitest suite
      (`settings.*.test.js` pattern via `tests/helpers/frontend-harness.js`) —
      row present when `window.__MEDTRACKER_CLOUD__ = true`, absent when unset
      (guards the server/mobile-build contract)

### Task 4: Verify acceptance criteria

- [x] verify all requirements from Overview are implemented (row visible in cloud
      mode only; `/devices` serves shell; warm unlock → device list; no-cache →
      `/unlock` redirect)
- [x] `go test ./...` (both default and `-tags mobile`) — must pass
- [x] `pnpm test` — must pass
- [x] run linter — all issues must be fixed

### Task 5: [Final] Update documentation

- [x] `docs/cloud-mode.md` — note the `/devices` entry point and Settings row in
      the C0b device-lifecycle section
- [x] `docs/cloud-crypto.md` — update the "device-list UI" references (currently
      describe it as reachable from the unlock shell only)

## Technical Details

- **DEK availability**: `devices.js` needs the plaintext DEK (envelope-MAC audit
  via `K_mac`) and `transfer.js` needs it to wrap under the transfer key TK. The
  `/devices` page gets it from the LDK warm cache exactly like `cloud-boot.js`
  does — no extra passkey ceremony on the happy path.
- **Why a separate page instead of a modal in the app**: `devices.js`/`transfer.js`
  render with the shell's wizard CSS and own the container's `innerHTML`; mounting
  them inside the web/static app would drag shell styles into the Wandergeek token
  system and violate the design-token rules. A full-page swap reuses everything
  untouched.
- **No apishim change**: `/api/devices` and `/api/transfer` are cloudserver API
  routes hit directly by shell JS with the device session cookie; the shim only
  intercepts web/static's `apiCall` paths.
- **No MCP coverage impact**: no new backend routes; `/devices` is a static-shell
  path on `cmd/cloud`, which is outside the `internal/server` coverage guard.

## Post-Completion

**Manual verification**:
- Real two-device pass on the deployed cloud instance: phone (claimed instance) →
  Settings → Devices → Add a device → scan QR with a second device → passkey
  enrollment completes → both devices listed as verified; revoke the second one.
- Typed-fallback path once on a camera-less desktop (`slot_id.code` at `/claim`).

**Known deferrals** (documented gaps, out of scope here):
- Inline "add a second device now" step in the signup wizard (docs/cloud-mode.md
  onboarding step 3) — separate UX change.
- DEK rotation on suspected-compromise revocation — pre-existing C0b gap
  (docs/cloud-crypto.md).
- Path A (cross-device hybrid-transport enrollment) — deferred by design.
