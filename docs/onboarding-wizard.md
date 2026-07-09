# Cloud onboarding wizard — design

Status: **design proposal** (bd `med-4pz.1`), except for the vault flag (`med-4pz.5`) and the claim→app seam
(`med-8eh`) — both **implemented**, so `WGFirstRun` now mounts in cloud mode and the claim wizard delivers the
user into the app. The screens still land via the sibling beads `med-4pz.2`, `med-4pz.3`, `med-4pz.4`.

## The headline: don't build a wizard, revive one

The app **already has** an in-app, multi-step, first-run onboarding overlay. It ships in the real app today:

- `web/static/js/features/firstrun/index.js` — orchestrator: mounts a full-screen overlay, dispatches to a
  **screen registry**, exposes `window.WGFirstRun = { mount, dismiss, isActive, state, screens }`
- `web/static/js/features/firstrun/state.js` — step tracker (`sessionStorage`, key `wg-firstrun-step`)
- `web/static/js/features/firstrun/screens/{welcome,permissions,integrations,done}.js` — the four screens
- `web/static/css/firstrun.css` — `.wg-firstrun-overlay` / `__panel` / `__title` / `__body`, loaded at
  `web/static/index.html:37`
- `web/static/js/features/auth-bootstrap.js:312-324` — reads top-level `needs_first_run` from
  `/api/bootstrap` and calls `WGFirstRun.mount({ needs_first_run })` on every fresh bootstrap

It was **dead in cloud mode for exactly one reason** — `bootstrapPayload()` hardcoded
`needs_first_run: false`, and `POST /api/firstrun/complete` was a fake `STUBS` entry that acked without
storing anything. `med-4pz.5` fixed both (see "The flag lives in the vault" below): the payload now computes
the flag from the vault on every call, and the completion route is a real `shimCall` branch that writes it.

In bot mode the same flag is a real SQLite column (`first_run_complete`,
`internal/store/settings/repo.go:227-242`, migration `071_add_first_run_state.sql`), surfaced on
`/api/bootstrap` and cleared by `POST /api/firstrun/complete` (`internal/server/server.go:956`).

So this design is **not** "build an onboarding wizard". It is:

1. ~~give cloud mode a vault-backed `first_run_complete` so `needs_first_run` can be true~~ — done (`med-4pz.5`),
2. ~~route `POST /api/firstrun/complete` through the shim~~ — done (`med-4pz.5`),
3. ~~delete the claim wizard's dead-end final screen and hand off into the app~~ — done (`med-8eh`),
4. add three screens to the existing registry.

Step 3 fell out of the same ordering: `med-8eh` was a *consequence* of the vault flag, not a separate tweak —
which is what that bead's own notes ask for.

## The trigger

**Trigger: first `/api/bootstrap` after the claim wizard finishes**, i.e. the first time the real app boots
with an unlocked vault whose `first_run_complete` is unset.

No new dispatch code. The account subdomain already serves the full `web/static` app, and `cloud-boot.js`
installs the `/api` shim ahead of every `web/static` script (`cloud-boot.js:130-159`), so the real app's
`apiCall('/api/bootstrap')` already lands in `apishim.js:221`. Making `bootstrapPayload` compute
`needs_first_run` from the vault is the entire hook. `auth-bootstrap.js` mounts the overlay for us.

Explicitly **not** the hook: `web/cloud/js/app.js`'s router. That handles `/claim`, `/recover`, `/devices`
and the claim-token branch — it is the *shell* entry, not the main-app boot path.

## The flag lives in the vault, not localStorage — **implemented** (`med-4pz.5`)

Per the bead: the flag must sync across devices. Cloud-mode settings are vault singleton records via the
runtime-agnostic domain module `web/domain/settings.js` (`createSettingsDomain({ records, now, timeZone })`,
line 72), encrypted at rest by the sync engine.

`first_run_complete` lives on its **own vault singleton** (`FIRSTRUN_RECORD_TYPE = 'firstrun'`), not on the
general `settings` record. Records are last-writer-wins per *whole record*: a device that has not yet pulled
the completion op, later writing the shared singleton for `timezone` or `dismissed_tz_suggestion`, would
upload a newer record with the flag missing and re-open the overlay everywhere. Nothing but
`setFirstRunComplete` writes the `firstrun` record, and it only ever writes `true`. No migration, no new HTTP
route.

| concern | decision |
|---|---|
| authoritative "onboarding done?" | the `firstrun` vault singleton — syncs to every device |
| in-flight step ("resume at step 3") | stays `sessionStorage` (`state.js`), unchanged |

**Absent ⇒ needs onboarding.** `needs_first_run = !first_run_complete`, so only an explicit `true`
suppresses the overlay. A vault record cannot be backfilled the way migration `071` backfilled bot mode's
column, and an absent record cannot mean two things at once. The accepted consequence: **cloud vaults that
predate this change see the overlay once**, dismiss it, and never see it again.

Shape: the flag is read once per `bootstrapPayload()` and surfaced as a
**top-level** `/api/bootstrap` field — matching bot mode (`internal/server/settings_handlers.go:460`). It is
deliberately *not* in the `GET /api/settings` body, whose shape is unchanged. `bootstrapPayload()` re-reads
the vault on every call and never caches: `WGFirstRun`'s `_mounted` latch is module state lost on reload, so
across reloads the payload reporting `false` is the only thing keeping the overlay closed. Contract covered by
`web/static/js/tests/cloud.shim-contract.settings.test.js`.

**Why the split.** The vault flag answers *"has this human ever been onboarded?"* — that must survive a new
device. The step tracker answers *"where were they 30 seconds ago?"* — that must not. Syncing a half-finished
step across devices would resume a wizard on a phone the user never started it on. The existing
`state.js` comment already reasons this way for Capacitor; the same logic holds for cloud.

**Resume after abandon** therefore falls out for free, and matches today's documented semantics: a mid-session
kill resumes at the last visible step; a power-cycle (or a different device) wipes `sessionStorage` and
restarts at `welcome`, because the vault flag is still unset. Intentional, not a bug.

## Step sequence

Existing registry order is `welcome → permissions → integrations → done` (`state.js:22`, `VALID_STEPS`).
The bead asks for `intro → sections tour → feature picker → BYO keys → safety nudges`. Reconciled:

| # | step | status | notes |
|---|------|--------|-------|
| 1 | `welcome` | **exists** | reuse. Owns "Skip all" (calls `complete()`). |
| 2 | `sections` | **new** (`med-4pz.3`) | sections intro / tour |
| 3 | `features` | **new** (`med-4pz.2`) | feature picker |
| 4 | `integrations` | **exists** | BYO keys. `med-4pz.3` re-checks copy for cloud. |
| 5 | `safety` | **new** (`med-4pz.4`) | Emergency Kit + second device |
| 6 | `done` | **exists** | reuse; `POST /api/firstrun/complete` |

`permissions` is bot/Capacitor-oriented (push permission). Cloud push exists, so **keep it**, but it should
self-gate to a no-op when permission is already granted — same pattern `renderTelegramStep` uses in the claim
wizard (`signup.js:239`), which falls straight through when Telegram is disabled. Not verified: whether
`firstrun/permissions.js` behaves correctly under cloud push. **`med-4pz.4` must check this before assuming.**

Adding steps means extending the frozen `VALID_STEPS` array in `state.js:22` — it is the single source of
truth for step validity and unknown names are silently rejected by `setStep`.

### Per-step skip vs skip-all

- **Skip-all** already exists on `welcome` via the `complete()` helper (`index.js:130`), which POSTs
  `/api/firstrun/complete` and dismisses. It sets the vault flag → never re-prompts on any device.
- **Per-step skip** is a "Skip" control on each new screen calling `advance(nextStep)` (`index.js:123`).
  It moves on **without** setting the vault flag; the user still reaches `done`, which is what completes.

Consequence worth stating plainly: skipping every step individually and skipping all have the same end state
(`first_run_complete = true`), but per-step skip still walks the user past the safety nudges. That is the
point — `med-4pz.4`'s Emergency Kit nudge is the one screen we want people to *see* even if they skip it.

## The claim → onboarding seam — **implemented** (`med-8eh`)

The claim wizard used to end at `renderDone`, a terminal screen ("the full app arrives with the next update")
with no button and no redirect. It is gone. The sequence is now
`welcome → (unsupported-authenticator) → loss-ack → Emergency Kit → (telegram) → enterApp`.

`enterApp(ctx)` (`web/cloud/js/signup.js`) establishes the LDK warm cache with the ceremony's `{dek, accountId}`
and then navigates `location.href = '/'`, exactly as `renderDeviceList`'s `onExit` already does
(`app.js:38-40`). The app boots, `/api/bootstrap` reports `needs_first_run: true`, and `WGFirstRun` mounts on
top of the real app.

The cache is established **at the tail, not right after `register/finish`** (which is what `claim.js:167-173`
does, because enrollment is its last step). Caching early would let a user who abandons at the Emergency Kit
reload straight into the app having never saved a recovery code.

`establishLdkCache` failure is swallowed and we navigate anyway: a storage-blocked browser lands on `/`,
`cloud-boot`'s `warmUnlock` fails, and it is routed to `/unlock` to sign in with the passkey it just created.
Degraded, not dead-ended.

`recover.js` is unaffected — its `ctx.onKitSaved` override still short-circuits at `#kit-continue`, and its
warm cache was already established by `enrollWithToken`.

Onboarding therefore starts **after** the Emergency Kit, **inside** the real app — as the bead requires — and
the claim wizard keeps exactly one job: get a passkey and a recovery code. No duplicated step machinery: the
claim wizard uses `wizard-step` (defined in `web/cloud/css/cloud.css:15`, **shell-only**, not loaded by
`web/static`), and onboarding uses `.wg-firstrun-overlay` (`web/static/css/firstrun.css`). Two different
documents, two different primitives, no sharing needed. That is the correct boundary, not an accident.

## Screen-by-screen inputs

### `features` — feature picker (`med-4pz.2`)

- write path: `POST /api/settings/features/:feature {enabled}` → shim `apishim.js:303-316` → `settings.setFeature`
- toggles + defaults (`web/domain/settings.js:47-56`): `bp`, `weight`, `medication`, `workout`, `health`,
  `gamification` default **enabled**; `food` and `weekly_digest` default **disabled**
- ⚠️ `gamification` is in `DEFAULT_FEATURES` but has **no toggle** in the Settings Features UI
  (`web/static/index.html:525-553`). The picker must decide: expose it, or match Settings and omit it.
  Recommend **omit** — `docs/gamification.md` is still an unimplemented design proposal, so a picker row for
  it promises a feature that does not exist.
- the picker sells `food` and `weekly_digest` (the two off-by-default features). Everything else is already on;
  showing six pre-checked boxes is noise.

### `integrations` — BYO keys (`med-4pz.3`)

- screen **exists** (`screens/integrations.js`), reusing `window.SettingsIntegrations.patch`
- cloud stores these in the `integrations` vault singleton (`web/domain/settings.js:18-19`), masked to `'***'`
  on read, mask-preserved on write (`:27-45,199-238`); unmasked values are read module-to-module by
  `aiclient.js` / `fooddb.js`, never over an `/api` route
- so the existing screen should already work in cloud mode unmodified. `med-4pz.3` **verifies** rather than rewrites.

### `safety` — Emergency Kit + second device (`med-4pz.4`)

- the Kit was already shown during claim (`signup.js:175-233`); this step is a **nudge**, not a re-render.
  Do not re-display the recovery code — it was shown once, deliberately.
- "Add a second device" entry point from inside the app is Settings → Devices card
  (`web/static/index.html:428-451`, `#settings-devices-link` → `/devices`), which is a cloud-shell route
  (`app.js:30-41`) leading to `devices.js:78` → `transfer.js`. The nudge should link there rather than
  reimplement transfer.

## Settings re-run entry point

Add a `wg-settings-row` ("Re-run onboarding") to the cloud-only Devices card
(`web/static/index.html:428-451`), tagged `wg-settings-cloud-* wg-settings-hidden`, revealed by the existing
cloud block in `web/static/js/features/settings.js:210-217`:

```js
if (window.__MEDTRACKER_CLOUD__) {
    document.querySelector('.wg-settings-cloud-devices')?.classList.remove('wg-settings-hidden');
}
```

Handler: clear the vault flag, `WGFirstRun.state.clear()`, then
`window.WGFirstRun.mount({ needs_first_run: true })` (`firstrun/index.js:184`) to reopen the overlay in place.
No navigation, no reload.

## Work breakdown

| bead | work |
|---|---|
| `med-4pz.5` ✅ | vault flag: `first_run_complete` in `web/domain/settings.js`; `needs_first_run` computed in `bootstrapPayload`; `POST /api/firstrun/complete` routed as a real `shimCall` branch. `VALID_STEPS` deliberately **not** extended — that belongs with the screens that need it |
| `med-8eh` ✅ | `renderDone` → `enterApp(ctx)`: warm the LDK cache, then navigate `location.href = '/'` |
| `med-4pz.2` | `screens/features.js` |
| `med-4pz.3` | `screens/sections.js`; verify `screens/integrations.js` under cloud |
| `med-4pz.4` | `screens/safety.js`; verify `firstrun/permissions.js` under cloud push |
| **new** (file it) | Settings "Re-run onboarding" row |

The vault-flag bead **blocked all the others** — without it the overlay could not mount in cloud mode and no
screen could be exercised end to end. It has landed, so the rest are unblocked.

## Deliberately not doing

- **No new wizard framework.** The registry + overlay + step tracker exist and are purpose-built for this.
- **No migration or new HTTP route** for the flag — the `firstrun` singleton syncs through the ordinary oplog.
- **No syncing of the in-flight step.** See the table above.
- **No per-step plan files yet.** The parent epic `med-l3q` scopes the wizard steps themselves out of this
  sprint; plan files written now would rot before `med-4pz.2/.3/.4` are scheduled. Write each plan when its
  bead is picked up, against the code as it stands then.

## Open questions for the owner

1. **`gamification` in the feature picker** — omit (recommended, it is an unimplemented proposal) or expose?
2. **`permissions` step in cloud** — keep it (self-gating on already-granted) or drop it from the cloud
   sequence entirely? Needs `firstrun/permissions.js` read first; flagged as unverified above.
3. **Sections tour depth** — a single "here's what's in the app" screen, or one screen per section? This design
   assumes **one screen**; the bottom nav already names all eight sections.
