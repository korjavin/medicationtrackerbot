# Onboarding (v3) — open and use it

Status: **implemented** (epic `med-ta2n`; the Android shell's QA scenarios are the one open item, see
[android.md](android.md)). Design source: [screens-onboarding-v3.html](design/claude-design/ui_kits/app-v2/screens-onboarding-v3.html)
and the brief [onboarding-v3](design/briefs/onboarding-v3.md). It replaced the cloud-only wizard of epic `med-4pz`
(welcome → features → integrations → done), the native first-run choice screen (kit N1), the native local intro (N2)
and the Emergency Kit inside signup (the old O1 placement). The git history of this file holds the `med-4pz` design.

## Principle

The app works on first launch. No choice, no QR, no account. Cloud sync is a **feature you turn on**, not a mode you
pick; the words *encryption, key, vault, passkey* stay out of onboarding ("Sign in with Face ID / your fingerprint").
Risk talk (lose the phone, the Emergency Kit) comes later as a nudge, once there is something worth protecting.

## The flow at a glance

| id | screen | where | owner bead |
|---|---|---|---|
| W1 | module picker (first run) | `WGFirstRun` overlay, web | `med-ta2n.1` (`.21`, `.28`) |
| W2 | AI trial offer | `WGFirstRun` overlay, web | `med-ta2n.2` |
| W3 | Today "Start here" hints | Today, web | `med-ta2n.3` |
| W4 | protect-your-data card + sheet | Today, local mode | `med-ta2n.4` |
| W5 | Settings → Sync & backup card and page; sign-in copy of the claim ceremony | Settings / `signup.js` | `med-ta2n.5`, `.8` |
| F1 | "Have an invite?" sheet (paste or scan) | `features/invite.js` | `med-ta2n.6` |
| P3 | "Turn on sync?" sheet (+ "Your invite is here", "Switch account?") | `features/invite.js` | `med-ta2n.7` |
| L1–L3, expired | invite landing page | `web/cloud/invite.html` | `med-ta2n.10` |
| — | Emergency Kit nudge after sync is on | Today, cloud | `med-ta2n.15` |

Every first-run screen is **web**. The shells draw nothing native for onboarding: with no stored account they enter
local mode and the bundled app shows W1 ([ios.md](ios.md#the-shell-bd-med-w6gx3), [android.md](android.md)).

## The trigger and the flag (unchanged from `med-4pz.5`)

`WGFirstRun` (`web/static/js/features/firstrun/`: `index.js` orchestrator, `state.js` step tracker, `screens/features.js`
= W1, `screens/trial.js` = W2) mounts when `/api/bootstrap` reports a top-level `needs_first_run: true`
(`features/auth-bootstrap.js`). `bootstrapPayload()` in `apishim.js` computes it from the vault on every call and never
caches; local mode takes the same path through the bundled app's shim.

- **Account mode waits for the first pull** (`med-ejgf`). Until this device has pulled the account's whole tail once
  (`sync.js` `hasCaughtUp`, i.e. `lastSyncedAt` set), the shim answers `needs_first_run: false`: an empty mirror of an
  existing account must not run W1, whose flag writes and `{floor:'auto'}` reminder default would overwrite the
  account's. `cloud-boot.js` re-asks after the boot pull and after every drain (online / visible / sync wake) and
  hands the answer to `AuthBootstrap.mountFirstRun`. A failed pull just leaves the app shell up without W1. Local mode
  has nothing to pull and is never gated.

- The flag lives on its own **`firstrun` vault singleton** (`web/domain/settings.js`, `setFirstRunComplete`), not the
  general `settings` record: records are last-writer-wins per whole record, and a lagging device writing `timezone`
  must not resurrect the overlay. Only `setFirstRunComplete` writes it, and only ever `true`. Vault restore with user
  content stamps it at the `clientTs: 0` floor (`vaultToRecords`), so a restored install does not onboard again.
- **Absent ⇒ needs onboarding.** Cloud vaults that predate the flag see the overlay once.
- The record also carries `picked`, the W1 module picks in picker order (`diary` included), which W3 reads.
- The in-flight step stays in `sessionStorage` (`wg-firstrun-step`; valid steps `features | trial`; a stored `welcome`
  or `done` falls back to W1, a stored `integrations` resumes on W2). A power-cycle or another device restarts at W1
  because the vault flag is still unset. Intentional.
- `POST /api/firstrun/complete` (a real `shimCall` branch) writes the flag and the `picked` list.

## W1 — module picker

One screen, seven kit check choices (Medications, Blood pressure, Weight, Workouts, Sleep, Food, Diary), nothing
preselected. *Continue with N* writes the picks; *Skip* = everything on. Rows map to the six feature flags (Sleep is the
Vitals section, internal id `health`); **Diary has no flag** (the notes section has none): picking it drives the W3
hints and keeps `health` on even without Sleep (`med-ta2n.21`). Continue/Skip write an **explicit boolean for all six
flags**, sequentially (`DEFAULT_FEATURES` is all-on, so an unwritten flag would come back on). Picking Medications
while notifications are off for the device shows the O3 "Reminders won't fire" note and asks in context.

The footer has the "not a medical device" footnote, the Privacy policy link and, in local mode, *Want it on every
device? Get an invite* (IM1, `med-er5x`; the request sheet when the shell has `base.post`, else the base landing, else
nothing; `med-ta2n.28`). The request sheet opens with the four facts of what an account adds (every device · a copy off
this phone · only you can open it · any browser) and a line that Telegram, AI-assistant connectors and sharing need an
account too (IM2; from the W4 sheet the copy leads, IM2 · W4). In a v3 shell in
local mode with no invite already waiting, the footer also shows **F1** "Have an invite?".

After W1, `finishPicker` stores the picks and either completes (POST above, overlay dismissed) or moves to W2.

## W2 — AI trial offer

Shown **only when Food was picked and a trial is on offer** (`SettingsIntegrations.trialOffer()`: no own OpenAI key,
none started, and an install that can start one — local: the shell's App Attest status; cloud: the operator's
`medtracker-trial-ai` meta). One real example, *Try it free* (the consent sheet in place, then the Settings flow) and a
full-width *Not now*. "Not now" completes first run and writes nothing; the Today "Try AI for free" card (own per-device
dismiss, `med-6xb9`) is the one later appearance. Local mode: `anon` consent, `trial.apply()` (a reload when the CSP must
admit our server; the overlay resumes on this step), `trial.enroll()`. Cloud: the `ai` TrialConsent is the whole opt-in.

This is the **one** trial question of onboarding. The claim wizard's trial step (`med-w6sx`, `TRIAL_CHOICE_KEY` carry-over)
and the first-run BYO-key form are gone; the key form lives in Settings → AI & integrations.

## W3, W4 — after first run

- **W3 "Start here"** (`GET /api/today/start-here`, read-only): one hint per picked module with no live record, in W1
  order; each runs the module's existing add flow and disappears with that module's first record. A vault in use that
  predates v3 (no stored picks, has content) gets none. See [features.md](features.md).
- **W4 "Protect your data"** (local mode only): the `protection` vault singleton `{lastBackupAt, nudgeDismissedAt[]}`
  (carried in `data.protection`). Written only by deliberate actions (a confirmed backup Share, the card's × / Later) with
  `now()` + `put` — never lazily created, so the derived-writer floor rule does not apply. Shown at 20 records or 7 days
  since first run; × snoozes 14 days; the second dismissal stops it. Replaces the weekly backup toast. The Settings chip
  reads the same status. Its sync choice reads "An encrypted copy only you can open. Needs an invite." (IM4); picked with
  no invite waiting it opens the request sheet in the W4 order where the shell has `base.post`, else the W5 page.

## The local-first path (P1: installed from a store)

1. Store install → shell enters local mode, no native screen → **W1** → (**W2**) → Today with **W3** hints.
2. Notifications are asked in context (O3), not here.
3. Later **W4** nudges to back up or turn on sync.
4. Settings slot ① **Sync & backup** (**W5**): Backup first, then Sync — the same four facts (IM3), *Sync needs an
   invite for now* with Paste / Scan (F1) and *No invite? Request one* (or *How to get an invite* where the shell has
   only a base), or *An invite is waiting → Turn on sync* when the shell slot holds one.
   The old Settings *Move to a cloud account* row is gone; the move runs from P3. Cloud mode keeps the S6 cloud card.

*Sync needs an invite* is deliberate: registration is invite-only ([cloud-mode.md](cloud-mode.md#onboarding--invite--wizard--installed-pwa)).
Requests go to our server (`med-ta2n.14`: in-app email form → admin approval in the manager bot → emailed invite).

## Invite paths

The invite is a single-use link (14 days, `CLOUD_CLAIM_TTL`) that claims one prepared account. Link forms, the landing
page and the status API are in [cloud-mode.md → Onboarding](cloud-mode.md#onboarding--invite--wizard--installed-pwa);
the token stays in the URL fragment end to end and never reaches the server.

**P2 — link or QR, app not installed.** The landing page (`https://<base>/i/<sub>#<token>`) shows one platform button
("Get the app for iPhone" / "…Android"), "Continue in the browser" (the PWA stays supported) and, on a desktop, a QR.
- *Android*: the Play link carries the invite as the Install Referrer; on first launch the shell reads it **once** and files
  it in its pending slot before entering local mode, so the web shows **"Your invite is here"** (P3 · Android: *Sign in
  with fingerprint* / *Use without sync*) ahead of W1. This transit through Google Play is a privacy-manifest carve-out
  (owner-accepted; the "Invite link → Get the app on Android" row of the generated table).
- *iPhone*: no reliable automatic hand-off. The app starts local as in P1; the landing page's L3 "Installed? Tap to
  continue" opens it (universal link, or `medtracker://i/<sub>#<token>` since Safari will not open a universal link to the
  host it is already on). "Get the app" also copies the landing URL, which F1's Paste picks up.

**P3 — invite arrives while the app is installed.** The shell captures it from any source (iOS universal link / scheme;
Android app link / scheme / referrer) into **one pending-invite slot** (`{url, receivedAt}`; newest wins; ignored after 14
days) and tells the page (home with `?invite=1`). The web reads it with bridge op `invite.pending` (one read per page,
before W1) and routes by state:

| state | sheet |
|---|---|
| local mode with records | **Turn on sync?** ("Your N records move to your account") |
| local mode, no records | **Your invite is here** |
| account mode | **Switch account?** (*Switch* = `account.leave {url}`, *Keep this account* = `invite.clear`) |

*Turn on sync* / *Sign in* is `CloudVault.moveToCloud({url})`: `move.stash` always, then `local.leave {url}` opens the
claim page directly. The leave is gated on `navigator.onLine !== false`; offline shows an in-page error and sends nothing.
**F1** (paste via `window.Clipboard`, scan via `window.Barcode`; Android registers `clipboard.read` because a WebView has no
clipboard-read prompt) feeds the same sheet from the web side, with a text-field fallback. Older shells without
`invite.pending` in `shell.ops` never get the slot read or a `{url}` sent. Bridge contract and parity:
[mobile-parity.md](mobile-parity.md).

## The claim ceremony (W5 sign-in) and the Emergency Kit

The ceremony (`web/cloud/js/signup.js`, bd `med-ta2n.8`) is `sign in → (unsupported-authenticator) → [kit offer, only with
&kit=1] → (telegram) → (install) → enterApp`. The first screen is **W5 · sign in** ("Sign in with Face ID" / "your
fingerprint" / "this device" from the UA and shell, one privacy sentence, never the words passkey / vault / encrypt).

The Emergency Kit is an **offer**, not a gate, and only when the claim fragment carries `&kit=1` (appended by the web when
sync was turned on from Settings; shells pass the fragment through untouched; `app.js` reads it next to `claim`). The offer
mints the code, shows two facts, *Save kit* / *Print* and *Done*; Done POSTs `/api/loss-ack` and files `download | print`
after a save, else `none`. Without the flag — the P3 path, a plain invite link, and an invite pasted into an older native
first-run screen — there is no kit page and no recovery code is minted at signup; the wizard files `emergencykit`
`how: 'none'` and the Settings Kit chip reminds (regenerate = `/devices?flow=emergency-kit`). The pre-v3 gate page
(`renderEmergencyKit` without `offer`: "I saved it" unlocks Continue) stays for `/recover`'s forced rotation and the
`/devices` regenerate flow. After sync is on, the Today **Emergency Kit nudge** (`med-ta2n.15`) repeats as the data grows,
with *Don't remind me again*.

`enterApp(ctx)` establishes the LDK warm cache **at the tail** (not right after `register/finish`, so abandoning at the kit
offer cannot reload into an unlocked app with an unsaved code) and navigates to `/`; a storage-blocked browser is routed to
`/unlock` instead. A P3 claim ends on Today with the pickup toast ("Sync is on · N records are on your account"). The
claim wizard has one job: get a passkey (and, from Settings, offer the code); the web app's overlay and the shell's
`wizard-step` markup remain two documents with two primitives.

## Owner decisions recorded (epic `med-ta2n`)

| question | answer |
|---|---|
| store users cannot turn on sync without an invite | request-an-invite on our server (`med-ta2n.14`), not self-serve sign-up |
| Android Play Install Referrer (single-use token transits Google Play) | accepted; privacy-manifest carve-out |
| compat shim for old shells | none (no distribution yet); pre-v3 shells reject the landing form on their paste screen, and the landing's "Continue in the browser" still claims |
| delete native first-run screens | confirmed; exits land in local mode with F1 open; QR scan via `window.Barcode` |
| kit reminder | data-driven repeating nudge with "Don't remind me again" (`med-ta2n.15`) |
| `ClaimURL` form | flipped to the landing form `https://<base>/i/<sub>#<token>` (`med-ta2n.16`); the old claim form stays valid |

## Settings re-run entry point

Settings still has a *Re-run onboarding* button (`#settings-rerun-onboarding`, `bindRerunOnboarding` in `settings.js`) that
reopens the overlay at W1 in place; otherwise the overlay is once-only per vault.
