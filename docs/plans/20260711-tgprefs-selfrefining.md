# Self-refining communication preferences for the free-text Telegram agent (med-vcv.3)

## Overview
Give the cloud-mode free-text Telegram agent (`createTGAgent`) a persistent, self-refining
sense of how THIS user talks, so repeated phrasings get interpreted the same way without
re-explaining. One bounded, user-scoped freeform note ("glossary") is:
- **read** into the agent's system prompt at the start of every free-text turn, and
- **optionally appended to** by the agent after a turn, when it learns a durable phrasing
  or term mapping (e.g. `"my usual" = 2 eggs + toast`).

The note lives ONLY in the E2EE vault as a single record (type `tgprefs`, recordId
`tgprefs`), exactly like the existing `tgagentrun` marker and the `reminderdeliverypref`
singleton. The relay never sees it — the agent runs client-side on the unlocked tab (same
zero-knowledge posture as med-vcv.2). This does NOT widen the server's seal-and-forget
surface; the learning is entirely client-side.

**Non-goals (do not build):** no ML, no embeddings, no per-message profile store, no
cross-user learning, no LLM-compaction. It is a bounded text note the agent reads and
appends to; when the cap is hit, drop oldest lines. If that ceiling is ever a problem,
revisit — do not pre-build for it.

## Context (from discovery)
Verified on local master @5e2eca7c (after ff to origin/master, which merged med-vcv.2 PR #578).

- **`web/cloud/js/tg-agent.js`** — `createTGAgent({ chat, dispatcher, maxRounds })` returns
  `{ run(userText) }`. A 2-tool (`mcp_help`/`mcp_call`) OpenAI tool-calling loop. Pure /
  runtime-agnostic, ports injected, NO browser globals. `SYSTEM_PROMPT` is a `const` at the
  top; `TOOLS` is a `const` array at the top; `execTool(call)` dispatches tool calls; `run`
  builds `messages` starting with `{ role:'system', content: SYSTEM_PROMPT }`.
- **`web/cloud/js/inbox-apply.js`** — `applyTGText(event, eventId, { agent, records, verbosity, now, editReply })`.
  Already writes an at-most-once marker of type `tgagentrun`
  (`const TG_AGENT_MARKER_TYPE = 'tgagentrun'`, recordId `` `tgtext-${eventId}` ``) BEFORE
  running the agent, and returns early on a re-drain if the marker exists. `createInboxApplier`
  builds the real agent in an `agentOverride || (() => { ... createTGAgent(...) })()` factory.
  The `TG_TEXT` dispatch branch reads `verbosity` via `createRemindersDomain(...).getDeliveryPref()`.
- **`web/domain/reminders.js`** — the singleton-vault-record pattern to mirror:
  `findSingleton(all, recordId)` = `all.find(r => r.recordId === recordId && !r.deleted)`;
  read via `records.list(TYPE)` + `findSingleton`; write via
  `records.put(TYPE, { recordId, clientTs: now(), deleted:false, ...fields })`.
- **`web/cloud/js/tests/inbox-apply.test.js`** — existing integration suite to EXTEND.

## Development Approach
- **Testing approach**: NO unit tests. Extend the existing `web/cloud/js/tests/inbox-apply.test.js`
  integration suite (project rule: integration-first, no `*-branches`/`*-edges`/new standalone files).
- Complete each task fully before moving to the next; small, focused changes.
- **CRITICAL: the integration tests added in Task 4 must pass (`pnpm test`) before Task 5.**
- **CRITICAL: update this plan file when scope changes during implementation.**
- Keep `web/cloud/js/tg-agent.js` free of browser globals (it has none today).

## Testing Strategy
- **Unit tests**: none.
- **Integration tests**: extend `web/cloud/js/tests/inbox-apply.test.js` with three cases
  (inject / append+cap / re-drain idempotency) — these guard the real agent-to-vault boundary
  that manual checking can't cheaply cover.
- **E2E tests**: none (no relevant existing e2e suite for this cloud path).

## Progress Tracking
- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with plus prefix; blockers with warning prefix.
- Keep this plan in sync with actual work done.

## What Goes Where
- **Implementation Steps** (`[ ]`): the vault helpers, the READ injection, the WRITE tool,
  and the integration tests — all achievable and verifiable in this repo.
- **Post-Completion** (no checkboxes): the optional Settings-UI textarea (deferred — see below)
  and manual end-to-end verification over a real Telegram bot.

## Implementation Steps

### Task 1: Add tgprefs vault helpers + a prefs port in the applier
- [x] In `web/cloud/js/inbox-apply.js`, add `const TG_PREFS_TYPE = 'tgprefs'`, a recordId
      constant (`'tgprefs'`), and a hard cap `const TG_PREFS_MAX_CHARS = 4096` (a few KB).
- [x] Add `readTGPrefs(records)` returning the current note string (or `''`): `records.list(TG_PREFS_TYPE)`
      then the same `findSingleton` shape used in `web/domain/reminders.js`; read the `.note` field.
- [x] Add `appendTGPref(records, line, now)`: normalize `line` to a single trimmed line (strip
      newlines, ignore empty), append it as a new line to the existing note, then enforce the cap by
      dropping WHOLE oldest lines from the front until `note.length <= TG_PREFS_MAX_CHARS`. Cap on
      string length (char count) to stay browser-global-free — no TextEncoder/Buffer. Persist via
      `records.put(TG_PREFS_TYPE, { recordId:'tgprefs', clientTs: now(), deleted:false, note })`.
- [x] In `createInboxApplier`, build a `prefs` port `{ get: () => readTGPrefs(records),
      append: (line) => appendTGPref(records, line, now) }` with a `prefs`/`prefsOverride`
      injection point (same pattern as `agentOverride`, `foodAIOverride`) so tests can stub it.
- [x] Pass the `prefs` port into the `createTGAgent({ chat, dispatcher, prefs })` factory call.

### Task 2: READ — inject the tgprefs note into the agent system prompt
- [ ] In `web/cloud/js/tg-agent.js`, accept `prefs` in `createTGAgent({ chat, dispatcher, prefs, maxRounds })`.
      Make it optional (default to a no-op port `{ get: async () => '', append: async () => {} }`)
      so existing callers/tests without `prefs` keep working.
- [ ] In `run(userText)`, `await prefs.get()` and, when the note is non-empty, build the system
      message as `SYSTEM_PROMPT + "\n\nWhat you already know about how THIS user talks (apply it
      when interpreting them):\n" + note`. When the note is empty, the system message is exactly
      `SYSTEM_PROMPT` (unchanged — no dangling header).

### Task 3: WRITE — remember_preference tool with size-capped append
- [ ] In `web/cloud/js/tg-agent.js`, add a third entry to `TOOLS`: `remember_preference` with a
      single required string param `note` — description: record ONE short durable phrasing/term
      mapping about how this user talks (NOT per-message content, NOT health-data values).
- [ ] Extend `SYSTEM_PROMPT` with one short instruction: when the user reveals a durable
      shorthand or term mapping worth remembering for next time, call `remember_preference` with a
      single concise line; otherwise don't. Keep it sparse — one line, only durable phrasing.
- [ ] In `execTool`, handle `name === 'remember_preference'`: `await prefs.append(args.note)` and
      return a small `{ ok: true }` (or `{ error }` on a bad/empty note) so the loop continues.
      The append rides the SAME pending vault batch as the turn's other writes (same `records`
      port); no extra flush is needed.

### Task 4: Integration tests (extend inbox-apply.test.js)
- [ ] (a) INJECT: seed a `tgprefs` record with a note, drive a `tg_text` event through the applier
      (or `applyTGText`) with a stub `chat` that captures its `messages`, and assert the system
      message contains the seeded note. Also assert the empty-note case leaves the system message
      equal to the base prompt.
- [ ] (b) APPEND + CAP: stub `chat` to emit a `remember_preference` tool call, drive a turn, and
      assert the line landed in the `tgprefs` vault record. Then pre-seed a near-cap note and assert
      a further append drops the OLDEST line(s) and stays within the cap (oldest-out).
- [ ] (c) IDEMPOTENCY: run the same `tg_text` event twice through the applier; assert the agent
      (and thus `remember_preference`) runs only ONCE — the existing `tgagentrun` marker gates the
      whole run, so no duplicate append. Do NOT add a second gate; this test just proves the free one.
- [ ] `pnpm test` — the new cases and the whole cloud JS suite must pass before Task 5.

### Task 5: Verify acceptance criteria
- [ ] Verify the note is injected into the agent prompt on every turn when present (Task 2).
- [ ] Verify the agent can append a durable one-line preference, size-capped oldest-out (Tasks 1+3).
- [ ] Verify re-drain idempotency holds with no second gate added (Task 4c).
- [ ] Confirm `web/cloud/js/tg-agent.js` still has no browser globals.
- [ ] Run the full `pnpm test` suite — must pass. Run `go build ./...` (no Go changed, sanity only).
- [ ] Run whatever JS lint/architecture checks the repo runs under `pnpm test` — clean.

## Technical Details
- **Record shape** (`tgprefs`): `{ recordId: 'tgprefs', note: string, clientTs, deleted:false }`.
  Singleton — always the same recordId; `records.put` overwrites (last-writer-wins via clientTs).
- **Cap**: `TG_PREFS_MAX_CHARS = 4096`. Oldest-out on whole lines keeps it well under any vault
  record limit and bounds the prompt-injection cost. No compaction/LLM summarization (non-goal).
- **prefs port contract**: `{ get(): Promise<string>, append(line: string): Promise<void> }`.
  Injected into `createTGAgent`; defaulted to a no-op so pre-existing tests need no change.
- **Idempotency**: unchanged — `applyTGText` writes the `tgagentrun` marker before `agent.run`
  and early-returns on re-drain, so the entire run (including any `remember_preference` append)
  happens at most once per event. No new marker.

## Post-Completion
*Items requiring manual intervention or external systems — informational only, no checkboxes.*

**Deferred follow-up (recommend a new bead):**
- **Settings-UI editor for the note.** The bead mentions "user-editable in Settings". Wiring a
  new `tgprefs` field into cloud Settings -> Integrations is NOT cheap: it touches
  `web/cloud/js/settings/integrations.js`, `FIELD_IDS`, `readDOMIntoPayload`, and
  `web/domain/settings.js patchIntegrations`, and hits the known `'' = CLEAR` landmine
  (a field absent from the DOM silently wipes the stored value). That is a materially larger,
  separately-testable surface than the bead's own acceptance tests (which cover only the agent
  inject/append/idempotency core). Deferring it keeps this PR tight per the "two touch points only"
  scope. File a follow-up bead if the in-app editor is wanted; the agent-appendable note works
  without it.

**Manual verification:**
- Over a real linked Telegram bot in cloud mode: send a message establishing a shorthand
  ("by 'my usual' I mean 2 eggs and toast"), confirm on a later turn the agent applies it, and
  confirm the note persists in the vault across app reloads.
