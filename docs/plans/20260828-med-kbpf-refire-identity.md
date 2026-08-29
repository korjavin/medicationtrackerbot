# med-kbpf — Carry med identity on the reminder row; server cancels on Confirm; delete the slotmeds map

## Overview

Two production bugs on 2026-08-28 (bd med-onzf, med-om6l) were both failures of
the SAME mechanism: the Telegram Confirm button carries only `s:<slotUnix>`, so
the browser has to reconstruct *which meds the message named* from a vault
side-table (`slotmeds-<slotUnix>` records, LWW-merged, tombstoned, 48h-retained,
two-phase-written around every schedule PUT) and a time-band heuristic. Every
reconstruction failure (lost record, legacy record, IndexedDB throw, expired
retention) degrades to "never cancel" — and the relay's server-owned re-fire
chain then nags hourly for 6h for doses already taken.

Full context dump: `bug.txt` in the repo root (read it first; do not commit it).

Fix, in three parts:

1. **Identity rides on the reminder row, not in a vault side-table.** The client
   already knows `medicationIds` per med entry when it builds the horizon
   (`web/domain/reminders.js` ~:330, `entries[].medicationIds`). Send them in the
   PUT, store them on `scheduled_pushes`, copy them through the re-fire chain,
   and put them into the sealed `intake_slot_action` event. The drain then reads
   identity from the event. Delete the whole `slotmeds` apparatus.
2. **The server cancels the chain on a Confirm tap.** The tap is the user's
   explicit statement. The drain re-arms the chain (one call, `now+1h`) only in
   the rare case a named dose is still PENDING after applying (drifted out of
   band). This inverts the failure direction: a missed drain is now silent for
   one rare case instead of loud for every case.
3. **The drain confirms by deterministic intake id first**, band-nearest second.
   `intake-<medId>-<slotUnix>` is exactly the id `materializeDueDoses` writes for
   the same target instant the reminder was built from, so the common case is an
   exact lookup, and the `minDoseIntervalMs` band is only a drift fallback.

Why NOT put ids in `callback_data`: med `recordId`s minted by
`web/domain/medications.js nextId()` are `nowMs*1000+rand` (16 digits); five of
them overflow Telegram's 64-byte limit. The row is the only place that fits.

**Zero-knowledge note (must be stated in code comments and docs):** the relay
learns opaque numeric med ids per slot. At `detailed` verbosity it already holds
the medication NAMES in cleartext `tg_text` (push.js ~:347), so this is strictly
less than what it knows today on that path. At `generic` verbosity it learns
the ids + count per slot. Accept this and document it in
`web/cloud/js/privacy-manifest.js` (the `push/schedule` egress entry — extend
its `userCopy`/evidence; run `pnpm privacy:docs` and commit the regenerated
table in `docs/cloud-mode.md`). `architecture.privacy-claims.test.js` must stay
green.

## Context

### Files (line numbers approximate, master 7e041984 + branch med-om6l-cancel-refire-retry)

- `web/domain/reminders.js` — :56 `SLOTMEDS_RETAIN_MS`; :313-330 slot grouping,
  `callback: 's:<slot>'`, `medicationIds`; :547 `slotMedicationsFromEntries`;
  :676-780 slotmeds read/write/prune/retire (`dropFutureSlotMedications`,
  `recordSlotMedications`, `getSlotMedications`, `retireLegacySlotMedications`,
  `LEGACY_SLOTMEDS_RECORD_ID`, `SLOTMEDS_RECORD_TYPE`, `SLOTMEDS_RECORD_ID_PREFIX`).
- `web/cloud/js/push.js` — :326 `pushScheduleInner(ctx, reminders, pref, onPushed, beforePush)`;
  :347 `entry.tg_text`/`tg_callback` build; `beforePush`/`onPushed` hooks exist
  ONLY for the slotmeds two-phase write.
- `web/cloud/js/reminders.js` — :122 `recomputeAndPush` (wires beforePush/onPushed
  to the slotmeds writes); :161-203 `cancelMedRefire` (POST
  `/api/telegram/cancel-refire {callback}`; checks `res.ok`, retries once — keep).
- `web/cloud/js/inbox-apply.js` — :175 `SLOT_DRIFT_BAND_MS`; :210
  `nearestPendingByMed`; :221 `getSlotMedicationsSafe`; :256
  `applyIntakeSlotAction(event, {intake, records, now, verbosity, editReply, getSlotMeds, cancelRefire})`;
  :291-313 identity vs fallback selection; :346-372 `stillDue` + cancel; :994
  production call site in `createInboxApplier`.
- `web/cloud/js/apishim.js` — :541-552 in-app confirm-schedule → `cancelMedRefire`
  when nothing PENDING at the slot (keep as-is).
- `web/domain/medintake.js` — :45 `slotId(medId, scheduledAtMs)` =
  `intake-<medId>-<floor(ms/1000)>`; :284 materialize uses it.
- `internal/tgclient/tgclient.go` — :509 `CallbackSlotPrefix`; :553
  `ValidCallbackStem`; :659 `ParseCallbackData`. **Unchanged** — the button
  stays `s:<slot>:<action>`.
- `internal/cloudserver/push.go` — :217 `scheduleEntry` JSON (`tg_callback`);
  :250-290 PUT validation → `cloudstore.ScheduledPushInput`.
- `internal/cloudstore/push.go` — :134 `ScheduledPush`; :150 `ScheduledPushInput`;
  :162 `ReplaceSchedule` (INSERT :183); :191 `DueScheduledPushes` SELECT/scan;
  :238 `InsertRelayRefire`; :260 `RescheduleRelayRefire` (:277 INSERT); :301
  `CancelRelayRefire`. Sent rows are never deleted (only unsent ones), so a
  sent row can be looked up by `(account_id, tg_callback)` at tap time.
- `internal/cloudstore/migrations/` — last is `021_feedback_reader_tokens.sql`;
  add `022_push_med_ids.sql` (precedent: `020_push_supersedes.sql`, additive
  column with DEFAULT so existing INSERTs keep working).
- `internal/cloudserver/relay.go` — :294 `sendTelegram`; :321 `scheduleMedRefire`
  (calls `RescheduleRelayRefire(ctx, acct, now+1h, p.TGText, p.TGCallback, id)`).
- `internal/cloudserver/telegram.go` — :1674 `intakeSlotEvent`; :1782-1850
  med callback handler (`default:` branch = confirm, deliberately no cancel, with
  the med-fml rationale comment — that rationale is now void and the comment
  must be rewritten); :1410 `CancelRefire` handler for `POST /api/telegram/cancel-refire`.
- Tests: `web/cloud/js/tests/push.slot-meds.test.js` (slotmeds — will mostly be
  deleted/rewritten), `web/cloud/js/tests/inbox-apply.test.js`,
  `internal/cloudserver/telegram_test.go`, `relay_test.go` (`fakeTGSender`,
  fake store), `internal/cloudstore/repo_test.go`, `internal/cloudserver/push_test.go`.
- Docs: `docs/cloud-mode.md` :838 record-type list (mentions `slotmeds` — remove),
  reminder lifecycle sections mentioning the re-fire/cancel rule;
  `docs/architecture.md` reminders section. `bug.txt` §2 describes the as-built
  flow — update the docs so they describe the new flow.

### Invariants to keep

- `go test ./...` and `pnpm test` green tree-wide, including every
  `tests/architecture.*.test.js` guard (globals, no-module-state, privacy-claims,
  domain-purity, offline-coverage). Run them all, not just the feature suite.
- Never modify an existing migration.
- `web/domain/*.js` stay pure (injected ports only).
- The relay never reads `ct`. Med ids are a new cleartext column, like
  `tg_text`; say so in the migration comment.
- Existing tombstone `slotmeds` records in real vaults must be ignored
  harmlessly (unknown record type in `records.list` is fine; make sure
  `web/domain/vault.js` export/import does not choke on or require them — check
  the golden fixture).
- `CallbackSlotPrefix` cancel semantics: `CancelRefire` handler stays
  `s:`-prefixed only.

## Development Approach

- Regular: code, then tests, per task. Smallest coherent diff. Reuse the
  `supersedes_message_id` precedent for the column.
- Deletion is the point: after task 3, `grep -ri slotmeds web internal docs`
  should only hit the migration-era comment explaining why old records are
  ignored (if any) and nothing executable.
- Commit per task with `(med-kbpf)` in the subject.
- Do not commit `bug.txt`.

## Tasks

### Task 1 — Server: store `tg_med_ids` on the row, carry it through the chain, put it in the sealed event

- [ ] Migration `internal/cloudstore/migrations/022_push_med_ids.sql`:
      `ALTER TABLE scheduled_pushes ADD COLUMN tg_med_ids TEXT NOT NULL DEFAULT '';`
      Comment: comma-separated numeric medication record ids the client named in
      this reminder; cleartext like `tg_text`; only meaningful on `s:` rows.
- [ ] `internal/cloudstore/push.go`: add `TGMedIDs string` to `ScheduledPush` and
      `ScheduledPushInput`; write it in `ReplaceSchedule`, `InsertRelayRefire`,
      `RescheduleRelayRefire` (new param); read it in `DueScheduledPushes`.
      Add `MedIDsForCallback(ctx, accountID, tgCallback) (string, error)`:
      `SELECT tg_med_ids FROM scheduled_pushes WHERE account_id=? AND tg_callback=? AND tg_med_ids<>'' ORDER BY id DESC LIMIT 1`
      (empty string, nil when none).
- [ ] `internal/cloudserver/push.go`: accept `tg_med_ids` on `scheduleEntry`
      (JSON `tg_med_ids`, string). Validate: empty, or `^\d+(,\d+)*$`, max 512
      bytes, only allowed when `tg_callback` has the `s:` prefix. Reject otherwise
      (400, same style as the existing checks).
- [ ] `internal/cloudserver/relay.go`: `scheduleMedRefire` passes `p.TGMedIDs`
      through `RescheduleRelayRefire`. Update the `relayStore` interface + fakes.
- [ ] `internal/cloudserver/telegram.go`: snooze branch passes med ids through
      `RescheduleRelayRefire` (look them up via `MedIDsForCallback(stem)`).
      `intakeSlotEvent` gains `MedicationIDs []int64 \`json:"medication_ids"\``
      (parse the stored string; omit/empty when unknown). Update the
      `telegramStore` interface + fakes.
- [ ] Tests: repo_test (round-trip incl. reschedule copy + `MedIDsForCallback`),
      push_test (validation matrix), relay_test (refire carries ids),
      telegram_test (sealed event contains ids; snooze reschedule carries ids).

### Task 2 — Server: Confirm tap cancels the chain; add re-arm endpoint

- [ ] `telegram.go` med callback `default:` (confirm) branch: after a successful
      `sealAndQueue`, call `t.store.CancelRelayRefire(ctx, ref, stem)` (log and
      swallow errors, same as the snooze branch). Rewrite the med-fml rationale
      comment: the event now carries identity; the drain re-arms if a named dose
      is still due. Keep the message edit + ack as they are.
- [ ] New handler `RearmRefire` on `POST /api/telegram/rearm-refire`
      `{callback:"s:<slot>"}`, session-authenticated, mirrors `CancelRefire`'s
      validation, then `RescheduleRelayRefire(ctx, acct, now+1h, text, stem, 0, medIDs)`
      where `text`/`medIDs` come from the latest row for that stem (add
      `LatestForCallback` or extend `MedIDsForCallback` to return text too —
      pick one, keep it small); 204. Skip re-arm (204, no-op) when the slot is
      older than `maxMedRefireWindow` — reuse the constant from relay.go. Wire
      it next to `cancel-refire` in the router. Register in the MCP coverage
      exempt list or registry if the legacy coverage test complains (cloud
      routes: check `router_test.go` conventions for `cancel-refire` and mirror).
- [ ] Tests: telegram_test — confirm tap deletes pending refire; rearm handler
      inserts one with the row's text/ids; rearm past the window is a no-op;
      rearm rejects non-`s:` callbacks.

### Task 3 — Client: send ids, read them from the event, confirm by id, delete slotmeds

- [ ] `web/cloud/js/push.js`: when `needsText && r.callback && Array.isArray(r.medicationIds) && r.medicationIds.length`,
      set `entry.tg_med_ids = r.medicationIds.join(',')`. Remove the
      `beforePush`/`onPushed` params from `pushScheduleInner`/`pushSchedule` if
      nothing else uses them (check `addDemoReminder` and tests).
- [ ] `web/cloud/js/reminders.js recomputeAndPush`: drop the slotmeds
      drop/record wiring.
- [ ] `web/cloud/js/inbox-apply.js applyIntakeSlotAction`:
      - identity = `event.medication_ids` (array of numbers/strings; normalise to
        the same type as `medication.recordId` — check how ids compare today:
        `nearestPendingByMed` uses `i.medication_id !== medId`, so match that).
      - Remove `getSlotMeds`, `getSlotMedicationsSafe`, the mapless/fallback
        branch and `SLOT_DRIFT_BAND_MS` if no longer referenced.
      - Selection per named med: (a) exact id `intake-<medId>-<slotUnix>` if it
        exists, not deleted, PENDING; else (b) `nearestPendingByMed` within the
        med's band (existing drift fallback, keep its comment). Keep the
        `doneThisTap` redelivery guard.
      - If the event has NO medication_ids (a legacy row pushed before deploy):
        apply nothing, `console.warn` once, still edit the reply to the receipt.
        No band-wide guessing. (The server cancelled the chain on tap, so the
        cost of a pre-deploy tap is "confirm in the app", not 6 nags.)
      - After applying, `stillDue` = any NAMED med still has a PENDING intake by
        exact id or within band. On `confirm`: if `stillDue` → call the injected
        `rearmRefire(slotMs)`; else nothing (server already cancelled). Remove the
        `cancelRefire` injection from this function if it becomes unused — but
        keep `cancelMedRefire` in `web/cloud/js/reminders.js`, `apishim.js` still
        uses it for in-app confirms.
- [ ] `web/cloud/js/reminders.js`: add `rearmMedRefire(slotMs)` next to
      `cancelMedRefire` — same shape (POST, check `res.ok`, retry once, warn).
      Factor the two into one helper `postRefire(path, slotMs)` if that is
      shorter than duplicating.
- [ ] `createInboxApplier` (inbox-apply.js ~:994): inject `rearmRefire`.
- [ ] `web/domain/reminders.js`: delete `SLOTMEDS_*`, `LEGACY_SLOTMEDS_RECORD_ID`,
      `slotMedicationsFromEntries` (unless used elsewhere), `dropFutureSlotMedications`,
      `recordSlotMedications`, `getSlotMedications`, `pruneSlotRecords`,
      `retireLegacySlotMedications`, `slotRecordId`, `listSlotRecords`. Keep
      `medicationIds` on the horizon entries. Check `web/domain/vault.js` and the
      golden fixture for `slotmeds` — remove from the export set if listed (old
      vaults with stray tombstones must still import cleanly).
- [ ] Tests: rewrite `push.slot-meds.test.js` → `push.med-ids.test.js` (PUT body
      carries `tg_med_ids` per med entry; BP/weight entries do not; generic
      verbosity still sends ids). `inbox-apply.test.js`: event with ids confirms
      the exact-id intake; drifted dose falls back to band; unknown id is skipped;
      no ids → nothing applied + warn + receipt; stillDue → rearm called, else
      not called; snooze never rearms/cancels. Delete the slotmeds tests.
- [ ] Privacy manifest + `pnpm privacy:docs`; docs (`docs/cloud-mode.md` :838
      record list, drain protocol / reminder lifecycle sections; `docs/architecture.md`
      reminders). Describe the new rule in one paragraph: "the row carries
      identity; Confirm tap cancels server-side; drain re-arms if still due".
- [ ] Close-out: `bd close med-pl0f med-d6eb --reason "slotmeds deleted (med-kbpf)"`
      is for the reviewer, not the executor — just note it in the PR body.

### Task 4 — Verify

- [ ] `go build ./... && go test ./...` (cmd/bot included).
- [ ] `pnpm test` full run — all `architecture.*` suites.
- [ ] `grep -rin slotmeds web internal docs` → only historical comments, if any.
- [ ] Open PR against `master` with a body that states the privacy trade-off
      explicitly, references med-kbpf, and says it supersedes PR #812's
      branch (`med-om6l-cancel-refire-retry`, commit d3eb293c — keep that
      commit; branch off it).
