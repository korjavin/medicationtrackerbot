# Explicit durable consent gate for operator trial AI and trial voice (bd med-yor.2)

## Overview

When operator trial providers are configured (`<meta name="medtracker-trial-ai">` /
`<meta name="medtracker-trial-voice">`), the absence of a BYO key currently
auto-selects the trial path: `const useTrial = !text.apiKey` at
`web/cloud/js/aiclient.js:291-292` (same at 323-324 and 366-367), and the voice
mirror at `web/static/js/features/elevenlabs-call.js:84-88`
(`trialVoiceAvailable()` + `/api/trial/elevenlabs/signed-url`). No consent
record exists anywhere; the only consent-shaped artifact is a wizard button
label ("Skip — use the trial key",
`web/static/js/features/firstrun/screens/integrations.js:195`). Skipping
API-key setup alone is NOT consent.

This plan adds an explicit, durable, revocable consent gate:

- Before the FIRST trial AI or trial voice request, disclose: the data
  categories sent (meal descriptions, photos, Telegram-assistant tool results
  including health data it reads; voice audio + transcripts), that the content
  transits the OPERATOR's provider account (operator's OpenAI / operator's
  ElevenLabs agent), and the alternative (add your own key in
  Settings → Integrations).
- Require a positive choice (Allow / Not now). Refusal prevents transmission.
- Persist the choice as an encrypted-vault singleton record (`trialconsent`) —
  a synced record type, NOT localStorage.
- Allow revocation (and granting) in Settings → Integrations.
- Scope separation: consent has three independent scopes — `ai` (meal
  text/photo parsing), `voice` (trial ElevenLabs calls), and `tg` (the Telegram
  free-text agent, whose tool-calling loop at `web/cloud/js/tg-agent.js:130-138`
  feeds mcp_call results — arbitrary vault reads: BP history, notes — back into
  model messages that transit the trial proxy via `aiClient.chat`, wired at
  `web/cloud/js/inbox-apply.js:481-482`). Consenting to meal parsing must NOT
  silently consent to vault reads via Telegram chat.
- BYO keys bypass the gate entirely (BYO precedence is pinned by existing
  tests and must not change).

Acceptance (from the bead): every trial AI/voice request is gated by
encrypted-vault consent; refusal and revocation prevent transmission; BYO
remains preferred; disclosure names operator and provider visibility AND the
Telegram agent's tool-result content; automated tests cover first use,
refusal, revocation, BYO precedence.

## Context (from discovery — verified file:line evidence)

- **Trial AI seam**: `web/cloud/js/aiclient.js` — `createAIClient({ settingsDomain })`;
  `useTrial = !apiKey` decisions at :291 (parseMealFromDescription), :323
  (parseMealFromImage), :366 (chat). Trial POSTs go to
  `/api/trial/openai/chat/completions` via `postTrialChatCompletion` (:243) /
  `postTrialChatRaw` (:256). `settingsDomain` is already injected — the consent
  read rides the same port.
- **Trial voice seam**: `web/static/js/features/elevenlabs-call.js:77-113`
  `fetchSignedURL()` — cloud branch (`window.__MEDTRACKER_CLOUD__`) checks
  `CloudElevenLabs.hasKey()`; no key + `trialVoiceAvailable()` →
  `fetchTrialSignedURL()` (:49). Gate goes immediately before that call.
- **tg-agent**: `web/cloud/js/tg-agent.js` `createTGAgent({ chat, dispatcher, prefs })`
  — `chat` port IS `aiClient.chat` (`inbox-apply.js:481-482`). Gating
  `aiClient.chat` on a separate `tg` scope covers this channel at the shared
  seam. Runs at drain time with no user present — it must REFUSE (throw), never
  prompt.
- **Vault singleton pattern to copy**: `web/domain/settings.js:227-305` — the
  `integrations` record (`INTEGRATIONS_RECORD_ID`, `findSingleton`,
  `records.put` with `{ recordId, clientTs: now(), deleted: false, ... }`, LWW
  on clientTs) and `getVoiceProvisioning`/`setVoiceProvisioning` (:285-305) —
  the closest structural template. Records self-describe via `recordType`; a
  new type syncs through the oplog automatically the moment `records.put('trialconsent', …)`
  is called — there is NO kind/table registry to update. Do NOT add it to
  `web/domain/vault.js` `VAULT_MANAGED_TYPES` — like `nk` and
  `voiceprovisioning` it is preserved across import; consent does not travel in
  backups (a fresh account asks fresh consent).
- **apishim routing**: `web/cloud/js/apishim.js` `createApiRouter` — the
  integrations precedent at :359-362 routes `/api/settings/integrations`
  GET/PATCH to domain methods. New route `/api/settings/trial-consent` goes
  next to it. NOT added to the MCP catalog: consent is a human ceremony, an
  agent must not be able to grant it (catalog→router coverage is one-way; an
  uncatalogued router path is fine).
- **Settings UI precedent**: `web/static/js/features/settings/integrations.js`
  — `applyTrialHints` (:107-120) already shows/hides trial hints from the meta
  flags + own-key state; `saveIntegrations` (:209-250) is the
  `DataStore.applyOptimistic` write pattern to copy
  (`applyOptimistic(key, mutator, tags)` → `{ commit, rollback }`,
  defined at `web/static/js/data-store.js:206`).
- **Privacy page**: `web/cloud/js/privacy.js` — entries with `docSignal: null`
  are exempt from the doc-table drift check
  (`web/cloud/js/tests/privacy.drift.test.js:43-63`). The existing trial-AI
  entry (:91-95) is `docSignal: null`. The drift test also asserts the literal
  phrases `/trial ai/`, `/operator's openai/`, and
  `telegram delivers your messages to the bot in the clear` survive — keep them.
- **Globals allowlist**: any new `window.*` global requires an entry in
  `tests/architecture.globals.test.js` with justification.
- **First-run wizard**: `web/static/js/features/firstrun/screens/integrations.js:195`
  "Skip — use the trial key" — skipping stays skipping; the request-time gate
  enforces that skip ≠ consent. Only the copy needs a small honesty tweak.
- **Test infrastructure**: Vitest + jsdom, run with `pnpm test` (Node 20 —
  `/tmp/node-v20.18.1-linux-x64/bin` may need to be on PATH). Existing aiclient
  trial tests live under `web/cloud/js/tests/` (find with
  `grep -rl "trial" web/cloud/js/tests/`); they currently assume trial works
  without consent and MUST be updated to grant consent in fixtures, not
  weakened.

## Development Approach

- **Testing approach**: Regular (code first, then tests within the same task)
- Complete each task fully before moving to the next
- Make small, focused changes; follow existing patterns exactly (singleton
  record, apishim if-ladder, applyOptimistic, textContent-only DOM building)
- **CRITICAL: every task MUST include new/updated tests** for code changes in
  that task — success and error scenarios, listed as separate checklist items
- **CRITICAL: all tests must pass before starting next task** — run the
  affected vitest files per task, full `pnpm test` in the verify task
- **CRITICAL: update this plan file when scope changes during implementation**
- Maintain backward compatibility: BYO-key behavior and bot-mode behavior are
  untouched; only the trial paths gain a gate

## Testing Strategy

- **Unit/integration tests (Vitest)**: required for every task. Domain-level
  tests for the consent record; client-seam tests for aiclient (first use,
  refusal, revocation, BYO precedence, tg-scope separation); voice-gate tests
  for elevenlabs-call; UI tests for the Settings controls and consent dialog
  following the owning feature suites (per CLAUDE.md rule 8 — extend existing
  feature suites, no `*-branches`/`pin-defect-N` files).
- **No Go changes** — this is a frontend/cloud-shell feature; the consent
  record is client-encrypted vault content the server never reads.
- **E2E**: none in this project's frontend stack (no Playwright/Cypress).

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope
- Keep plan in sync with actual work done

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): code changes, tests, docs in
  this repo
- **Post-Completion** (no checkboxes): manual verification against a deployed
  trial-configured cloud instance

## Implementation Steps

### Task 1: `trialconsent` vault singleton in the settings domain + apishim route

- [x] In `web/domain/settings.js`, add a `trialconsent` singleton record type
      following the `voiceprovisioning` pattern (settings.js:285-305): record
      type + record id `trialconsent`, methods `getTrialConsent()` returning
      `{ ai: true|false|null, voice: true|false|null, tg: true|false|null, updated_at }`
      (null = never asked) and `setTrialConsent(patch)` accepting a partial
      `{ ai?, voice?, tg? }` of booleans, merging over the existing record,
      stamping `updated_at` from `now()`, writing via
      `records.put('trialconsent', { recordId, clientTs: now(), deleted: false, ... })`.
      Ignore/reject non-boolean patch values. Keep the module pure (no browser
      globals — `architecture.domain-purity.test.js` guards this).
- [x] In `web/cloud/js/apishim.js` `shimCall`, route
      `GET /api/settings/trial-consent` → `settings.getTrialConsent()` and
      `PATCH /api/settings/trial-consent` → `settings.setTrialConsent(body)`,
      placed next to the `/api/settings/integrations` block (:359-362). Do NOT
      add a catalog op (consent is a human ceremony; agents must not grant it).
- [x] Write tests for `getTrialConsent`/`setTrialConsent` in the existing
      settings-domain test suite (➕ the prescribed grep found no dedicated
      domain suite; the owning suite driving the real domain module is
      `web/static/js/tests/cloud.shim-contract.settings.test.js` — tests added
      there): default all-null when no record; set-then-get round trip; partial
      patch preserves other scopes; non-boolean values rejected/ignored; record
      is written with `recordType` `trialconsent` (i.e. syncs via the generic
      records port — asserted via `records.list('trialconsent')`).
- [x] Write tests for the two new shim routes (GET default, PATCH then GET) in
      the existing apishim test suite (same shim-contract file — it drives the
      routes through the real `window.apiCall` → apishim path).
- [x] Run the touched vitest files — must pass before Task 2. (15/15 in the
      settings shim-contract suite; domain-purity, apishim.write-origin, and
      mcp-responder guards all green.)

### Task 2: Consent gate in aiclient.js (shared trial seam, `ai` vs `tg` scopes)

- [x] In `web/cloud/js/aiclient.js`, add a
      `trialConsentRequiredError(scope)` factory (code:
      `trial_consent_required`, `err.scope = scope`, message pointing at
      Settings → Integrations) and a private
      `ensureTrialConsent(scope)` helper that reads
      `settingsDomain.getTrialConsent()` and throws unless the scope is
      exactly `true` (null/false/missing all refuse — skipping setup is not
      consent).
- [x] Gate all three trial decisions: in `parseMealFromDescription` (:291) and
      `parseMealFromImage` (:323) call `await ensureTrialConsent('ai')` when
      `useTrial` is true (after the existing `trialAIAvailable()` check); in
      `chat` (:366) call `await ensureTrialConsent('tg')` when `useTrial` is
      true. First `grep -rn "aiClient.chat\|\.chat(" web/cloud/js web/static/js`
      to confirm `chat`'s only production caller is the tg-agent wiring
      (`inbox-apply.js:481-482`); if another caller exists, note it here with ➕
      and pick its scope explicitly. BYO path (apiKey present) must remain
      completely untouched — no consent read at all.
      ➕ The grep found a second production `chat` caller: the gamification
      narrator (`web/cloud/js/gamification-narrator.js:141`, wired in
      `apishim.js:143`). It sends vault-derived, already-computed health
      summaries — the same data category the `tg` disclosure names — so
      `chat()` gates uniformly on the `tg` scope for both callers. The
      narrator's invariant-3 catch turns a refusal into its deterministic
      fallback (`{ text: null }`), so no error ever surfaces from that path;
      without `tg` consent trial narration simply doesn't happen.
- [x] Update existing aiclient trial tests to grant consent in fixtures (a
      settingsDomain stub whose `getTrialConsent` returns the needed scope) —
      do not weaken assertions. (The existing trial tests in
      `cloud.shim-contract.food-ai.test.js` drive the REAL settings domain, so
      they grant via the real shim route — `grantTrialConsent(window)` PATCHes
      `/api/settings/trial-consent`; the stub approach is used in the new
      direct-seam tests. The "vault key beats trial" test deliberately grants
      nothing, proving BYO works with the gate never involved.)
- [x] Write new tests in the aiclient suite: (a) first use — no consent record
      → `trial_consent_required` and NO fetch to `/api/trial/...`; (b) refusal
      — scope `false` → same refusal, no fetch; (c) revocation — consent
      granted then set false → refused; (d) BYO precedence — apiKey present →
      request goes to the provider URL and `getTrialConsent` is never called;
      (e) scope separation — `{ ai: true, tg: null }` lets meal parsing
      through but `chat()` still throws `trial_consent_required` with
      scope `tg` (and vice versa). (Two new describe blocks in
      `cloud.shim-contract.food-ai.test.js`: route-driven gate tests incl. the
      photo path, plus direct `createAIClient` tests for (d)/(e).)
- [x] Write a tg-agent-level test (existing tg-agent suite): a `chat` port that
      throws `trial_consent_required` results in no trial transmission and a
      surfaced error (no crash/hang of the drain loop).
- [x] Run the touched vitest files — must pass before Task 3. (31/31 in the
      food-ai + tg-agent suites; inbox-apply, gamification-narrator,
      elevenlabs + settings shim-contract, and firstrun suites all green —
      95 more tests.)

### Task 3: Consent gate for trial voice in elevenlabs-call.js

- [x] In `web/static/js/features/elevenlabs-call.js` `fetchSignedURL()` cloud
      branch (:84-88): before calling `fetchTrialSignedURL()`, read consent via
      the shim route (`window.apiCall('/api/settings/trial-consent', 'GET')` —
      in cloud mode apiCall routes through apishim; guard for its absence). If
      `voice !== true`, do NOT fetch the trial signed URL; instead invoke the
      consent prompt seam (Task 4's `window.TrialConsent.request('voice')` if
      present) and proceed only on an affirmative result; otherwise throw an
      error telling the user trial voice needs consent (Settings →
      Integrations). BYO path (hasKey true) untouched.
      (`ensureTrialVoiceConsent()` — throws the shared contract:
      `err.code = 'trial_consent_required'`, `err.scope = 'voice'`; apiCall
      absent or failing counts as no consent.)
- [x] Write tests in the existing elevenlabs-call feature suite: (a) no
      consent → no fetch to `/api/trial/elevenlabs/signed-url`, error state
      shown; (b) consent granted (stubbed GET returns `{ voice: true }`) →
      trial signed URL fetched as before; (c) BYO key present → consent never
      read; (d) declined prompt → no fetch. (Also covered: revoked
      `voice: false`, `ai`-only scope separation, prompt-allows-then-fetch,
      apiCall-absent refusal, and a startCall-driven error-state test.
      `cloudEnv` grants `{ voice: true }` by default so the pre-gate trial
      tests keep their assertions unweakened.)
- [x] Run the touched vitest files — must pass before Task 4. (44/44 in
      features.elevenlabs-call; shim-contract.elevenlabs, call-indicator,
      auth-headers, offline-coverage, globals, egress-consistency all green —
      46 more tests.)

### Task 4: Consent disclosure dialog + Settings → Integrations grant/revoke controls

- [ ] Create `web/static/js/features/trial-consent.js`: a small
      `window.TrialConsent` module exposing `request(scope)` → shows a modal
      disclosure dialog (textContent/createElement only, no innerHTML; design
      tokens/CSS classes only, no inline styles or hardcoded colors) and
      resolves `true` (user clicked Allow → PATCH
      `/api/settings/trial-consent` `{ [scope]: true }`) or `false` (Not now →
      PATCH `{ [scope]: false }`). Disclosure copy per scope must name: the
      data categories (`ai`: meal descriptions and photos; `voice`: your voice
      audio and the agent conversation; `tg`: your Telegram messages AND the
      health data the assistant reads from your vault to answer — BP history,
      notes, etc.), that content transits the OPERATOR's provider account
      (operator's OpenAI / operator's ElevenLabs), and the alternative: add
      your own key in Settings → Integrations. Load it from the shared script
      loading path the other feature modules use (find where
      `features/elevenlabs-call.js` is loaded and mirror it for both server
      and cloud shells).
- [ ] Add `TrialConsent` to the allowlist in
      `tests/architecture.globals.test.js` with a one-line justification.
- [ ] Wire the food AI paths: where the UI calls meal parsing (find with
      `grep -rn "parseMealFromDescription\|parseMealFromImage" web/static/js web/cloud/js` —
      the food feature + apishim food-ai route), catch
      `err.code === 'trial_consent_required'`, call
      `window.TrialConsent.request(err.scope)`, and retry once on `true`;
      surface the refusal message on `false`. Keep the catch at the smallest
      shared call site (prefer one seam over per-button copies).
- [ ] In `web/static/js/features/settings/integrations.js`, extend the trial
      hints area (`applyTrialHints`, :107-120): when a trial flag is active in
      cloud mode, render a consent row per applicable scope (`ai` + `tg` under
      the AI trial flag, `voice` under the voice flag) showing current state
      (Allowed / Not allowed / Not asked) with an Allow/Revoke button. Writes
      go through the `DataStore.applyOptimistic` pattern exactly as
      `saveIntegrations` (:209-250) does: optimistic repaint → PATCH
      `/api/settings/trial-consent` → `commit(fresh)` / `rollback()`.
- [ ] Update the first-run wizard copy at
      `web/static/js/features/firstrun/screens/integrations.js:195`: "Skip —
      use the trial key" → copy that says trial use will ask for consent on
      first use (e.g. "Skip — decide later (trial asks consent on first
      use)"); adjust any test that pins the old label.
- [ ] Write tests: dialog renders disclosure naming operator + provider +
      data categories + the Telegram tool-result content (assert key phrases);
      Allow PATCHes `{scope: true}` and resolves true; Not now PATCHes false
      and resolves false; Settings consent row renders state and Revoke
      PATCHes `{scope: false}` via applyOptimistic (commit on success,
      rollback on failure); food path retries after Allow.
- [ ] Run the touched vitest files — must pass before Task 5.

### Task 5: Privacy page entry

- [ ] In `web/cloud/js/privacy.js`, update the existing trial-AI item
      (:91-95, `docSignal: null`) to state that trial use requires your
      explicit consent (asked on first use, revocable in Settings →
      Integrations) and extend/add `docSignal: null` items so trial VOICE and
      the Telegram assistant's tool-result channel (health data it reads to
      answer you transits the operator's OpenAI account on the trial key) are
      named. Keep the drift-test literal phrases intact: `/trial ai/`,
      `/operator's openai/`, `telegram delivers your messages to the bot in
      the clear`.
- [ ] Run `web/cloud/js/tests/privacy.drift.test.js` — the doc-table
      one-to-one checks and phrase assertions must pass unchanged.

### Task 6: Verify acceptance criteria

- [ ] Re-read the bead acceptance criteria and confirm each maps to a
      passing test: gated first use, refusal prevents transmission,
      revocation prevents transmission, BYO precedence untouched, disclosure
      names operator/provider visibility AND Telegram tool-result content,
      consent lives in an encrypted-vault synced record (not localStorage —
      `grep -n localStorage` the new files to prove it).
- [ ] Confirm scope separation is tested: `ai` consent alone does not permit
      `chat()` trial calls (tg scope), and vice versa.
- [ ] Run the full frontend suite: `pnpm test` (use Node 20:
      `PATH=/tmp/node-v20.18.1-linux-x64/bin:$PATH pnpm test`) — all green.
- [ ] Run `go build ./...` and `go test ./internal/cloudserver/...` to prove
      no server-side regression (expected: no Go changes).
- [ ] Verify no new `window.*` global is missing an allowlist entry and no
      inline `.style.` assignments or hardcoded colors were introduced
      (architecture tests cover this — they run in `pnpm test`).

### Task 7: Update documentation

- [ ] Add a short "Trial consent" paragraph to `docs/cloud-mode.md` (near the
      trial AI/voice sections — find with `grep -n "trial" docs/cloud-mode.md`):
      consent is an encrypted-vault `trialconsent` singleton with independent
      `ai`/`voice`/`tg` scopes, asked before first trial use, revocable in
      Settings → Integrations, never granted by skipping key setup, not
      exported in backups. Do NOT touch the "## Metadata leakage summary"
      table (drift guard).
- [ ] Run `pnpm test` once more if any test-adjacent file changed; otherwise
      confirm the tree is clean and all plan checkboxes are marked.

## Technical Details

- **Record shape** (`trialconsent` singleton, encrypted vault, synced via
  oplog like every record):
  ```js
  {
    recordId: 'trialconsent',
    recordType: 'trialconsent',
    clientTs: <ms>,
    deleted: false,
    ai: true | false | null,     // meal text + photo parsing via trial OpenAI
    voice: true | false | null,  // trial ElevenLabs voice calls
    tg: true | false | null,     // Telegram free-text agent (incl. tool results)
    updated_at: <ms>
  }
  ```
  `null` (or missing record) = never asked → gate refuses. Only literal `true`
  passes the gate.
- **Error contract**: `err.code === 'trial_consent_required'`, `err.scope` set.
  Interactive UI paths catch it and run the dialog; the tg drain path lets it
  surface as a handled error (never prompts — no user present).
- **Server never sees consent**: the record is ordinary encrypted vault
  content; the gate is client-side by design (the server cannot read the
  vault, and the trial proxy stays dumb).
- **BYO precedence**: when an own key exists the gate code path is never
  reached (`useTrial` is false) — pinned by test (d) in Task 2.

## Post-Completion

**Manual verification** (deployed trial-configured cloud instance):
- Fresh account, no key: first meal parse shows the disclosure; Decline →
  nothing sent; Allow → parse works; revoke in Settings → next parse asks
  refusal-style again.
- Telegram free-text message on a fresh account with only `ai` consent → the
  agent refuses (no trial transmission) until `tg` consent is granted in
  Settings.
- Voice call without consent → dialog; with BYO ElevenLabs key → no dialog.
- Consent state syncs to a second enrolled device (grant on one, visible on
  the other).
