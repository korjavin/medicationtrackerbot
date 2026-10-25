// Runtime-agnostic medication intake state machine. Pure logic over an
// injected records port — no window/document/fetch/IndexedDB — so the same
// file can later run inside the Go server via goja (C6). Mirrors
// internal/domain/medication.go + the intake-related handlers in
// internal/server/medication_handlers.go, server.go (confirm-schedule) and
// settings_handlers.go (next-intake forecast).
//
// Record type: intake — medication_id, scheduled_at, taken_at, status
// (PENDING|TAKEN|SKIPPED|UNTAKEN), snoozed_until, source ("schedule" or "tz_step" —
// a slot that came from an APPROVED tz transition plan's steps, unioned in
// via planDosesWithTzPlan, see tzplan.js). Merge fields (bd med-wi09.11, see
// mergeIntake): rev, acted_at, via (app|mcp|telegram|native — the channel the
// action came through), tz, snoozed_at; optional note, conflict. UNTAKEN is an
// explicit undo: it reads as due, and the wire shape reports it as PENDING.
//
// Evidence stored, occurrences derived (bd med-wi09.12): nothing writes a
// PENDING prediction any more. A scheduled dose's recordId is
// `intake-<medId>-<slotUnix>`, and an action on a dose that has no stored row
// yet writes its evidence at exactly that id, so two devices acting on "the
// same" dose converge on one record (mergeIntake). Manual (log-past) intakes
// have no natural slot, so they get a random id (same nowMs+random technique as
// medications.js's nextId / weight.js's genId).
import { localDateTimeParts, localWallToUtcMs, scheduleYieldsDoses } from './medschedule.js';
import { planDosesWithTzPlan, forecastDosesWithTzPlan } from './tzplan.js';
import { applyLineage, evidenceTransitions, loadLineage, regenerateWindow } from './lineage.js';

const MEDICATION_RECORD_TYPE = 'medication';
const INTAKE_RECORD_TYPE = 'intake';
const TZPLAN_RECORD_TYPE = 'tzplan';
const TZPLAN_RECORD_ID = 'tzplan-current';

const NEXT_INTAKE_FORECAST_MS = 12 * 60 * 60 * 1000;
const CLUSTER_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_SNOOZE_MINUTES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
// How far either side of an instant the projection must read to see a lineage
// partner (up to 26h apart, UTC+14 ↔ UTC−12): a narrower window leaves a
// cancelled dose standing in for its out-of-window replacement.
const LINEAGE_PAD_MS = 2 * DAY_MS;

// The projection's doses planned at exactly `ms` (to the second), read
// lineage-safe. Takes the domain so callers' stubs of occurrences() apply.
export async function dosesAtInstant(intake, ms) {
  const rows = await intake.occurrences({ fromMs: ms - LINEAGE_PAD_MS, toMs: ms + LINEAGE_PAD_MS + 999 });
  return rows.filter((r) => { const p = Date.parse(r.plannedAt); return p >= ms && p <= ms + 999; });
}
// The only marker a log-past intake carries — logPast writes source:'schedule'
// like a scheduled dose, so the id prefix is what distinguishes them.
const MANUAL_ID_PREFIX = 'intake-manual-';
const UPCOMING_FORECAST_DAYS = 7;
// The ledger cut (bd med-wi09.12): a singleton whose first op sets the
// account's cut server-side (med-wi09.8, which then fences pre-v2 writers with
// 426). Written put-if-absent at the clientTs floor (CLAUDE.md rule 12); `at`
// is this device's boot instant until sync adopts the server's ledger_cut_at
// from the pull (sync.js adoptLedgerCut), and it is the cut on a device that
// never syncs (local mode).
export const LEDGERCUT_RECORD_TYPE = 'ledgercut';
export const LEDGERCUT_RECORD_ID = 'ledgercut';
// A dose taken more than this long after its slot is "delayed". Owner decision
// (bd med-29gh.2): 60 minutes, from their own "avg delay ~ 1h" framing — the
// default snooze is 10 minutes, so anything under an hour is routine. Named so
// it stays tunable.
const DELAYED_DOSE_THRESHOLD_MS = 60 * 60 * 1000;

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Med ids compare as strings: a med recordId and an intake medication_id can be
// number vs string in imported vaults (med-wi09.15/.16).
const sameMed = (a, b) => String(a) === String(b);
const MED_ID_ORDER = new Intl.Collator(undefined, { numeric: true });

function slotId(medId, scheduledAtMs) {
  return `intake-${medId}-${Math.floor(scheduledAtMs / 1000)}`;
}

// ---------------------------------------------------------------------------
// Intake merge reducer (bd med-wi09.11, epic med-wi09 Phase 2 (d)). sync.js
// runs it on every local write (stampAndPut), every incoming op
// (applyIncoming) and every pending-vs-snapshot overlay, in place of LWW on
// clientTs, so a stale Telegram tap drained late can never undo a correction.
//   1. a tombstone is terminal both ways;
//   2. higher rev wins — explicit actions write seen+1, a reminder callback
//      only moves rev 0 → 1;
//   3. equal rev: via app = mcp > telegram = native > legacy;
//   4. then the later acted_at, then clientTs, then the body — a total order,
//      so every device picks the same winner whatever the apply order. Two
//      explicit (app/mcp) rows tied on rev with different statuses flag the
//      winner with the loser's summary in `conflict`;
//   5. snoozed_until rides its own snoozed_at branch: the newer snooze is kept
//      on whichever row wins, and a snooze never changes status.
// A row with no `rev` is legacy (written before this rule, or an old client's
// queued payload): PENDING is rev 0, anything else rev 1, ranked lowest — so
// re-posting it after reload never beats a v2 correction. The reducer never
// writes rev/via into a legacy row. Returns `local` itself when nothing
// changes, so callers can skip the write.
const VIA_RANK = { app: 3, mcp: 3, telegram: 2, native: 2 };
const OPEN_STATUSES = new Set(['PENDING', 'UNTAKEN']);
const NON_STATUS_FIELDS = new Set(['snoozed_until', 'snoozed_at', 'conflict', 'clientTs', 'recordType']);

// An undo keeps the taken_at it reverts in the row's note.
function untakenNote(intake, fields) {
  if (fields.status !== 'UNTAKEN' || !intake || !intake.taken_at) return fields;
  return { ...fields, note: `Undone; was taken at ${intake.taken_at}` };
}

export function intakeRev(row) {
  if (typeof row.rev === 'number') return row.rev;
  return row.status === 'PENDING' ? 0 : 1;
}

function viaRank(row) {
  return (typeof row.rev === 'number' && VIA_RANK[row.via]) || 1;
}

function statusBody(row) {
  return JSON.stringify(Object.keys(row).sort().filter((k) => !NON_STATUS_FIELDS.has(k)).map((k) => [k, row[k]]));
}

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function mergeIntake(local, incoming) {
  if (!local) return incoming;
  if (local.deleted) return local;
  if (incoming.deleted) return incoming;
  const ib = statusBody(incoming);
  const lb = statusBody(local);
  const cmp = (intakeRev(incoming) - intakeRev(local))
    || (viaRank(incoming) - viaRank(local))
    || cmpStr(incoming.acted_at || '', local.acted_at || '')
    || ((incoming.clientTs || 0) - (local.clientTs || 0))
    || cmpStr(ib, lb);
  const [win, lose] = cmp > 0 ? [incoming, local] : [local, incoming];
  let out = win;
  if (intakeRev(win) === intakeRev(lose)) {
    // The conflict flag is the greatest piece of evidence across both rows (a
    // fixed key), so three tied edits agree whatever order they arrive in. A
    // lower-rev row's flag was resolved by the action that outranked it.
    // Only a disagreement on status is a conflict: two devices both taking the
    // same dose differ in acted_at/taken_at, not in what happened.
    const tie = win.status !== lose.status && viaRank(win) === 3 && viaRank(lose) === 3;
    const candidates = [win.conflict, lose.conflict, tie && {
      status: lose.status, taken_at: lose.taken_at ?? null, acted_at: lose.acted_at ?? null, via: lose.via,
    }].filter(Boolean);
    const key = (c) => `${c.acted_at || ''}|${JSON.stringify(c)}`;
    const best = candidates.reduce((a, c) => (!a || key(c) > key(a) ? c : a), null);
    if (best && (!win.conflict || key(best) !== key(win.conflict))) out = { ...win, conflict: best };
  }
  const ws = win.snoozed_at || '';
  const ls = lose.snoozed_at || '';
  // Equal snoozed_at: the later snoozed_until decides, so the branch converges.
  const laterSnooze = ls > ws || (ls && ls === ws && (lose.snoozed_until || '') > (out.snoozed_until || ''));
  if (laterSnooze && (lose.snoozed_until !== out.snoozed_until || lose.snoozed_at !== out.snoozed_at)) {
    out = { ...out, snoozed_until: lose.snoozed_until ?? null, snoozed_at: lose.snoozed_at };
  }
  return out;
}

// ponytail: nowMs*1e6 stays under Number.MAX_SAFE_INTEGER until ~year 2255,
// same margin medications.js's nextId relies on.
function genManualId(nowMs) {
  return `${MANUAL_ID_PREFIX}${nowMs}-${Math.floor(Math.random() * 1e6)}`;
}

function notPending(message = 'intake is not pending') {
  const err = new Error(message);
  err.code = 'not_pending';
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.code = 'not_found';
  return err;
}

// planDoses/toMedScheduleShape need `id`; medication records only carry
// `recordId` (medications.js mints it, never renames it to `id`).
function toMedScheduleShape(med) {
  return { ...med, id: med.recordId };
}

// UNTAKEN is storage-only: every wire reader (frontend, MCP, refire checks)
// keeps seeing the PENDING it saw before undo had its own status.
const wireStatus = (s) => (s === 'UNTAKEN' ? 'PENDING' : s);

// Ported from IntakeLog's JSON tags (repo.go:104-114) — taken_at/
// snoozed_until have omitempty.
function toResponse(intake) {
  const resp = {
    id: intake.recordId,
    medication_id: intake.medication_id,
    scheduled_at: intake.scheduled_at,
    status: wireStatus(intake.status),
    source: intake.source || 'schedule',
  };
  if (intake.taken_at) resp.taken_at = intake.taken_at;
  if (intake.snoozed_until) resp.snoozed_until = intake.snoozed_until;
  return resp;
}

// ---------------------------------------------------------------------------
// Adherence fold (bd med-29gh.1) — the ONE place adherence is computed, called
// by both analysis.js (health.analyze adherence_rate) and brief.js (the
// doctor-visit brief's per-med + overall percentages). It used to be a
// character-for-character duplicate in those two files, and both carried the
// same bug: an as-needed med has no schedule, so planDoses never materializes
// a dose for it (medschedule.js planDoses skips `!cfg || cfg.type ===
// 'as_needed'`) and its only rows are manual logPast entries — every one of
// them TAKEN. That made a PRN med read as 100% adherent and dragged the
// overall number toward 100. A doctor must never be handed an invented
// perfect-compliance figure.
//
// Definition: a med planDoses would skip is UNSCHEDULED — it gets no adherence
// percentage of its own AND its rows are excluded from the overall
// numerator/denominator. It is still reported (a doctor wants to know the
// patient takes ibuprofen as needed), as a count of times taken.
// Delegates to the planner (medschedule.js scheduleYieldsDoses) rather than
// re-reading the schedule here: the definition of "unscheduled" has to be
// exactly "planDoses would skip it", and a second reading of the schedule
// string is how that drifts.
function round1(n) {
  return Math.round(n * 10) / 10;
}

export function isScheduledMed(med) {
  return !!med && scheduleYieldsDoses(med.schedule);
}

// listWindow denormalizes to medication_name + dosage rather than an id, and
// the medications domain forbids a duplicate name+dosage pair
// (assertNoDuplicate), so that pair is a safe join key between a row and its
// med.
export function adherenceKey(name, dosage) {
  return JSON.stringify([name || '', dosage || '']);
}

// foldAdherence({ log, meds, nowMs }) -> { overall, perMed, detail }
//   log     — intake.listWindow rows ({medication_name, dosage, scheduled_at, status, taken_at?, manual?})
//   meds    — medications.list rows ({name, dosage, schedule})
//   overall — {total, taken} over SCHEDULED meds' due rows only
//   perMed  — Map(adherenceKey -> {scheduled, total, taken, timesTaken})
//   detail  — {missed, delayed, avg_delay_minutes} over the same SCHEDULED rows
// A future PENDING dose isn't due yet and counts for nothing; every other row
// counts, TAKEN is the numerator. `timesTaken` counts TAKEN rows whether or not
// the med is scheduled — it is what an as-needed med reports instead of a
// percentage.
//
// Pass ARCHIVED meds in too (callers list with archived:true and render only
// the active ones): listWindow still emits an archived med's rows, and a row
// whose med is missing from `meds` has an unknowable schedule, so it falls back
// to counting — which would let an archived PRN med go on faking adherence.
// When two meds collide on name+dosage (the active pair is unique, an archived
// one can still shadow it) the fold takes the pessimistic reading and calls the
// key unscheduled: no number beats a number that might be invented.
//
// `detail` (bd med-29gh.2) is the same fold's second reading, for the brief's
// "missed 4, delayed 7, average delay 1h 10m" line:
//   missed  — overall.total - overall.taken, i.e. SKIPPED + overdue PENDING.
//             Derived, not re-counted, so a third definition cannot drift in.
//   delayed — TAKEN rows whose taken_at is more than DELAYED_DOSE_THRESHOLD_MS
//             past their slot. A dose taken EARLY is not late: the `>` compare
//             on a signed difference drops negatives, never abs().
//   MANUAL ROWS ARE EXCLUDED FROM DELAY MATH (but still count toward
//   adherence — the patient did take it). logPast fakes scheduled_at ==
//   taken_at because a manual entry has no slot, and updateIntakes will then
//   re-stamp taken_at = now() on such a row while scheduled_at stays days back,
//   inventing a multi-day "delay". listWindow flags those rows `manual` off
//   their `intake-manual-` id prefix; `source` cannot — logPast writes
//   source:'schedule' like everything else.
export function foldAdherence({ log = [], meds = [], nowMs = 0 } = {}) {
  const perMed = new Map();
  for (const m of meds) {
    const key = adherenceKey(m.name, m.dosage);
    const prior = perMed.get(key);
    perMed.set(key, {
      scheduled: isScheduledMed(m) && (!prior || prior.scheduled),
      total: 0,
      taken: 0,
      timesTaken: 0,
    });
  }
  const overall = { total: 0, taken: 0 };
  let delayed = 0;
  let delaySumMs = 0;
  for (const row of log) {
    const key = adherenceKey(row.medication_name, row.dosage);
    let entry = perMed.get(key);
    if (!entry) {
      entry = { scheduled: true, total: 0, taken: 0, timesTaken: 0 };
      perMed.set(key, entry);
    }
    const isTaken = row.status === 'TAKEN';
    if (isTaken) entry.timesTaken += 1;
    if (row.status === 'PENDING' && Date.parse(row.scheduled_at) > nowMs) continue;
    if (!entry.scheduled) continue;
    entry.total += 1;
    overall.total += 1;
    if (isTaken) {
      entry.taken += 1;
      overall.taken += 1;
      if (!row.manual && row.taken_at) {
        const lateBy = Date.parse(row.taken_at) - Date.parse(row.scheduled_at);
        if (lateBy > DELAYED_DOSE_THRESHOLD_MS) {
          delayed += 1;
          delaySumMs += lateBy;
        }
      }
    }
  }
  const detail = {
    missed: overall.total - overall.taken,
    delayed,
    avg_delay_minutes: delayed > 0 ? round1(delaySumMs / delayed / 60000) : null,
  };
  return { overall, perMed, detail };
}

// Percentage from one fold counter. `empty` is the caller's choice for a
// window with nothing due: brief.js wants null ("nothing was scheduled" is not
// "took nothing"), analysis.js has always reported 0 and its shipped MCP
// consumers depend on that — the two are deliberately not unified.
export function adherencePct(counts, empty = null) {
  const { total = 0, taken = 0 } = counts || {};
  return total > 0 ? (taken / total) * 100 : empty;
}

// ---------------------------------------------------------------------------
// The occurrence projection (bd med-wi09.1) — the ONE answer to "which doses
// exist in [fromMs, toMs] and what state is each in". Every reader that used
// to re-predict around the stored PENDING rows with its own rule (Home's
// next-intake, the Schedule tab's upcoming + missed buckets, the Meds badge,
// Today's Next up, the reminder horizon) reads this instead, so they cannot
// disagree about the same vault state.
//
// Union of:
//   (a) every non-deleted stored intake row in range, as-is: TAKEN/SKIPPED as
//       recorded; PENDING → snoozed while snoozed_until is ahead, upcoming while
//       its slot is ahead, else due; an `intake-manual-*` row is source manual.
//   (b) `regenerated` (lineage.js regenerateWindow, bd med-wi09.12): from
//       local midnight of the cut day on, the doses history says were
//       scheduled — due once past.
//   (c) the current forecast (forecastDosesWithTzPlan), future instants only.
// (b) and (c) only fill slots with no stored row at their exact deterministic
// id; a tombstoned id is hidden — that dose was dropped on purpose.
// Before `cutMs` stored rows are the whole truth (old PENDING rows included:
// that is how day one shows the doses an old client left stuck). From the cut
// on a stored PENDING row is a prediction, not evidence: it shows only where
// (b)/(c) has its slot (carrying its snooze), so an old client's row at an
// orphaned instant reads as "no evidence"; an old client's TAKEN row still
// counts at its own instant. cutMs null = no cut yet, stored rows only.
// No `missed` state and no threshold (epic med-wi09): a due dose stays due
// until the user acts; "overdue" is a label the UI may put on it.
//
// Inputs are raw records: `medications` live (deleted filtered by the caller),
// `intakes` RAW with tombstones (recordsPort.listRaw). `forecast: false` skips
// (c) — the history view. Rows sorted by (plannedAt, medId); stored rows keep
// their stored ISO strings verbatim.
const MAX_FORECAST_DAYS = 30;

export function projectOccurrences({
  medications = [], intakes = [], tzPlan = null, timeZone, nowMs, fromMs = -Infinity, toMs = Infinity, forecast = true,
  lineage = null, regenerated = [], cutMs = null,
} = {}) {
  // Keyed by String(id): a vault can hold a med's recordId and an intake's
  // medication_id as number vs string (inbox-apply.js compares the same way);
  // a strict miss here blanks the row's name/dosage (bd med-wi09.15).
  const medById = new Map(medications.map((m) => [String(m.recordId ?? m.id), m]));
  const stepByKey = new Map();
  if (tzPlan && tzPlan.status === 'APPROVED' && Array.isArray(tzPlan.steps)) {
    for (const s of tzPlan.steps) stepByKey.set(`${s.medicationId}-${s.scheduledAtMs}`, s);
  }
  const occupied = new Set(intakes.map((i) => String(i.recordId)));
  // A live row for the same med at the same second also covers the slot: a
  // vault import keys a tz_step dose `intake-<m>-<s>-tz_step`, not the bare
  // slot id, and its forecast twin must not be offered again.
  for (const i of intakes) {
    if (!i.deleted) occupied.add(slotId(i.medication_id, Date.parse(i.scheduled_at)));
  }

  function row({ occId, medId, plannedMs, plannedAt, source, state }) {
    const med = medById.get(String(medId));
    const p = localDateTimeParts(plannedMs, timeZone);
    const out = {
      occId,
      medId,
      name: med ? med.name : '',
      dosage: med ? (med.dosage || '') : '',
      plannedAt,
      tz: timeZone,
      localDate: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`,
      localTime: `${pad2(p.hour)}:${pad2(p.minute)}`,
      source,
      state,
    };
    if (source === 'tz_step') {
      const step = stepByKey.get(`${medId}-${plannedMs}`);
      if (step) {
        out.stepNumber = step.stepNumber;
        out.totalSteps = step.totalSteps;
        if (step.note) out.stepNote = step.note;
      }
    }
    return out;
  }

  const targets = forecast && toMs > nowMs
    ? forecastDosesWithTzPlan({
      medications: medications.map((m) => ({ ...m, id: m.recordId ?? m.id })),
      timeZone,
      now: nowMs,
      days: Math.min(MAX_FORECAST_DAYS, Math.ceil((Math.min(toMs, nowMs + MAX_FORECAST_DAYS * DAY_MS) - nowMs) / DAY_MS)),
      tzPlan,
    }).filter((t) => t.scheduledAtMs >= fromMs && t.scheduledAtMs <= toMs)
    : [];
  const generated = new Set([
    ...regenerated.map((o) => o.occId), ...targets.map((t) => slotId(t.medicationId, t.scheduledAtMs)),
  ]);

  const out = [];
  for (const i of intakes) {
    if (i.deleted) continue;
    const ms = Date.parse(i.scheduled_at);
    if (!(ms >= fromMs && ms <= toMs)) continue;
    if (cutMs !== null && i.status === 'PENDING' && ms >= cutMs && !generated.has(slotId(i.medication_id, ms))) continue;
    let state;
    if (i.status === 'TAKEN') state = 'taken';
    else if (i.status === 'SKIPPED') state = 'skipped';
    else if (i.snoozed_until && Date.parse(i.snoozed_until) > nowMs) state = 'snoozed';
    else state = ms > nowMs ? 'upcoming' : 'due';
    let source = i.source === 'tz_step' ? 'tz_step' : 'schedule';
    if (typeof i.recordId === 'string' && i.recordId.startsWith(MANUAL_ID_PREFIX)) source = 'manual';
    const r = row({
      occId: i.recordId, medId: i.medication_id, plannedMs: ms, plannedAt: i.scheduled_at, source, state,
    });
    if (i.taken_at) r.takenAt = i.taken_at;
    if (i.snoozed_until) r.snoozedUntil = i.snoozed_until;
    // The evidence channel, distinct from `source` (schedule|tz_step|manual).
    r.via = typeof i.rev === 'number' && VIA_RANK[i.via] ? i.via : 'legacy';
    if (i.conflict) r.conflict = i.conflict;
    out.push(r);
  }

  for (const o of regenerated) {
    if (o.at < fromMs || o.at > toMs || occupied.has(o.occId) || !medById.has(String(o.medId))) continue;
    occupied.add(o.occId);
    out.push(row({
      occId: o.occId,
      medId: o.medId,
      plannedMs: o.at,
      plannedAt: new Date(o.at).toISOString(),
      source: o.source === 'tz_step' ? 'tz_step' : 'schedule',
      state: o.at > nowMs ? 'upcoming' : 'due',
    }));
  }

  for (const t of targets) {
    const id = slotId(t.medicationId, t.scheduledAtMs);
    if (occupied.has(id) || !medById.has(String(t.medicationId))) continue;
    out.push(row({
      occId: id,
      medId: t.medicationId,
      plannedMs: t.scheduledAtMs,
      plannedAt: new Date(t.scheduledAtMs).toISOString(),
      source: t.source === 'tz_step' ? 'tz_step' : 'schedule',
      state: 'upcoming',
    }));
  }

  // `lineage` (lineage.js's alias table): cancelled slots resolve to their
  // declared replacement, evidence on both sides is flagged (bd med-wi09.10).
  const sorted = out.map((r) => [Date.parse(r.plannedAt), r])
    .sort((a, b) => (a[0] - b[0]) || MED_ID_ORDER.compare(String(a[1].medId), String(b[1].medId)))
    .map((x) => x[1]);
  return applyLineage(sorted, lineage, intakes);
}

// The stored intake wire shape (toResponse) read back off a stored projection
// row — the inverse of projectOccurrences' state mapping, so /api/history is a
// view over the projection rather than a second reading of the records.
function historyResponse(r) {
  const resp = {
    id: r.occId,
    medication_id: r.medId,
    scheduled_at: r.plannedAt,
    status: r.state === 'taken' ? 'TAKEN' : r.state === 'skipped' ? 'SKIPPED' : 'PENDING',
    source: r.source === 'tz_step' ? 'tz_step' : 'schedule',
  };
  if (r.takenAt) resp.taken_at = r.takenAt;
  if (r.snoozedUntil) resp.snoozed_until = r.snoozedUntil;
  return resp;
}

// ---------------------------------------------------------------------------
// Projection cache (bd med-wi09.12, perf). project() is the read every dose
// view goes through, and a year of history is ~15k rows to rebuild. Settled
// UTC days (ended before now) are kept as finished rows, per records port and
// zone. Nothing is reused unchecked — every read first re-checks:
//   - the port's write journal (`records.changesSince`, sync.js) names every
//     intake written since the last read; each one's old and new days are
//     dropped. A port without a journal, or a journal that lost track (a store
//     replace, an overflow), rebuilds the index and drops every day. So does a
//     list whose row count or clientTs sum the index doesn't match (a
//     write no journal named, e.g. an old bundle's tab).
//   - every other input — the meds minus their stock, history, the tz plan,
//     the cut, the evidence zones — is one key; any change drops every day.
//   - a day holding a snooze still ahead is recomputed once it lapses.
// Today and later are always computed fresh.
const projectionCaches = new WeakMap();
const provisionalCuts = new WeakMap();
const PLAIN_SLOT_RE = /^intake-(.+)-(\d+)$/;

function projectionCache(records, timeZone) {
  let byZone = projectionCaches.get(records);
  if (!byZone) projectionCaches.set(records, byZone = new Map());
  let c = byZone.get(timeZone);
  if (!c) {
    c = { token: null, index: new Map(), days: new Map(), cells: new Map(), version: 0, minDay: Infinity, gkey: null, evidence: null };
    byZone.set(timeZone, c);
  }
  return c;
}

// A stored row sits in the UTC day of its instant and, when its id names a
// different slot, in that slot's day too (it occupies that slot).
function indexAdd(c, row) {
  const ms = Date.parse(row.scheduled_at);
  const days = Number.isFinite(ms) ? [Math.floor(ms / DAY_MS)] : [];
  const id = String(row.recordId);
  const m = id.startsWith(MANUAL_ID_PREFIX) ? null : PLAIN_SLOT_RE.exec(id);
  if (m) {
    const d = Math.floor((Number(m[2]) * 1000) / DAY_MS);
    if (!days.includes(d)) days.push(d);
  }
  const e = { row, ms, days, localDate: undefined };
  c.index.set(id, e);
  for (const d of days) {
    let set = c.days.get(d);
    if (!set) c.days.set(d, set = new Set());
    set.add(e);
    if (d < c.minDay) c.minDay = d;
    c.cells.delete(d);
  }
}

function indexRemove(c, id) {
  const e = c.index.get(id);
  if (!e) return;
  c.index.delete(id);
  for (const d of e.days) {
    const set = c.days.get(d);
    if (set) set.delete(e);
    c.cells.delete(d);
  }
}

// Row count and the sum of clientTs: what a write the journal never named still
// changes. A row's clientTs only goes up, so every write — a new row, or an
// edit of one, even below the newest stamp — moves the sum. Summed modulo a
// prime so 13k epoch-ms stamps stay exact integers (a plain float sum would
// round a +1 away past 2^53); a write misses only if it moves a stamp by an
// exact multiple of the prime (~24.8 days to the ms).
const FP_MOD = 2147483647;
function stampSum(sum, row) {
  const t = Number(row.clientTs);
  return Number.isFinite(t) ? (sum + (((Math.trunc(t) % FP_MOD) + FP_MOD) % FP_MOD)) % FP_MOD : sum;
}

function rowsFingerprint(rows) {
  let sum = 0;
  for (const r of rows) sum = stampSum(sum, r);
  return `${rows.length}|${sum}`;
}

function indexFingerprint(c) {
  let sum = 0;
  for (const e of c.index.values()) sum = stampSum(sum, e.row);
  return `${c.index.size}|${sum}`;
}

function syncIndex(c, changes, intakes) {
  let rebuild = !changes || changes.ids === null || c.token === null;
  if (!rebuild && changes.ids.length) {
    const ids = new Set(changes.ids.map(String));
    for (const id of ids) indexRemove(c, id);
    for (const row of intakes) if (ids.has(String(row.recordId))) indexAdd(c, row);
    c.version++;
  }
  // A write no journal named — an old bundle's tab left open after a deploy, a
  // cross-tab message lost to a frozen page, a browser without
  // BroadcastChannel — leaves the index off the list it was built from.
  if (!rebuild && indexFingerprint(c) !== rowsFingerprint(intakes)) rebuild = true;
  if (rebuild) {
    c.index = new Map();
    c.days = new Map();
    c.cells = new Map();
    c.minDay = Infinity;
    for (const row of intakes) indexAdd(c, row);
    c.version++;
  }
  c.token = changes ? changes.token : null;
}

function rowsOfDays(c, from, to) {
  const out = new Set();
  if (Number.isFinite(to)) {
    for (let d = from; d <= to; d++) for (const e of c.days.get(d) || []) out.add(e.row);
  } else {
    for (const [d, set] of c.days) if (d >= from) for (const e of set) out.add(e.row);
  }
  return [...out];
}

// Everything a settled day's rows read besides its own intakes. Stock and
// bookkeeping fields are left out: a take moves inventory_count and must not
// drop a year of days.
// A batch acts once per id (Archie 4934): resolver() is a snapshot, so a
// repeated id would see its open row twice and move inventory twice.
function uniqueIds(ids) {
  return [...new Map(ids.map((id) => [String(id), id])).values()];
}

function medsKey(meds) {
  return meds.map((m) => [m.recordId ?? m.id, m.name, m.dosage, m.schedule, m.tz_shift_policy, m.created_at,
    m.start_date, m.end_date, !!m.archived, !!m.deleted]);
}

// createIntakeDomain builds the intake state-machine API over the injected
// ports:
//   records — { list(type), put(type, record), putIfAbsent(type, record),
//              del(type, id), listRaw?(type) }. putIfAbsent writes the ledger
//              cut (ensureLedgerCut).
//   now()   — current time in ms epoch
//   timeZone — IANA zone string, passed straight through to planDoses
//   via     — the channel this instance's writes come through (app|mcp|
//             telegram|native), stamped on every action for mergeIntake.
//   onBoundary(atMs)? — told, after each projection, the earliest instant it
//             listed as still ahead: the next moment a row turns due on the
//             clock alone. The shell arms its refresh timer there (Archie 4934
//             point 3); the domain keeps no timer.
export function createIntakeDomain({ records, now, timeZone, via = 'app', onBoundary }) {
  // An explicit action on `intake` (null = a slot with no stored row yet):
  // rev seen+1, a fresh acted_at, and any old conflict flag resolved.
  function acted(intake, fields, nowMs) {
    const base = { ...intake };
    delete base.conflict;
    return {
      ...base,
      ...fields,
      clientTs: nowMs,
      rev: (intake ? intakeRev(intake) : 0) + 1,
      acted_at: new Date(nowMs).toISOString(),
      via,
      tz: timeZone,
    };
  }

  async function loadMeds() {
    const all = await records.list(MEDICATION_RECORD_TYPE);
    return all.filter((m) => !m.deleted);
  }

  async function loadIntakes() {
    const all = await records.list(INTAKE_RECORD_TYPE);
    return all.filter((i) => !i.deleted);
  }

  // The dose `id` names: its stored row, else — when the projection lists that
  // exact occId with no row behind it (a regenerated or forecast dose) — a
  // virtual open row at that id, so every action writes its evidence there
  // (confirm-or-create, bd med-wi09.12). Never a neighbouring dose.
  async function getIntake(id) {
    return (await resolver([id])).get(id);
  }

  // getIntake for a batch: one intake load and at most one projection (over
  // the span of the unstored ids) per call, however many ids (F6).
  async function resolver(ids) {
    const stored = await loadIntakes();
    const byId = new Map(stored.map((i) => [String(i.recordId), i]));
    const unstored = ids.map((id) => /^intake-(.+)-(\d+)$/.exec(String(id)))
      .filter((m) => m && !byId.has(m[0])).map((m) => Number(m[2]) * 1000);
    let projected = new Map();
    if (unstored.length) {
      const { rows } = await project({ fromMs: Math.min(...unstored) - LINEAGE_PAD_MS, toMs: Math.max(...unstored) + LINEAGE_PAD_MS });
      projected = new Map(rows.map((r) => [r.occId, r]));
    }
    return {
      stored,
      get: (id) => byId.get(String(id)) || (projected.has(String(id)) ? virtualIntake(projected.get(String(id))) : null),
    };
  }

  function virtualIntake(r) {
    return {
      recordId: r.occId,
      deleted: false,
      medication_id: r.medId,
      scheduled_at: r.plannedAt,
      taken_at: null,
      status: 'PENDING',
      snoozed_until: null,
      source: r.source === 'tz_step' ? 'tz_step' : 'schedule',
    };
  }

  // The projection's rows in [fromMs, toMs] that are not still ahead — the
  // stored row where there is one, else a virtual open row — in the
  // stored-row shape the Telegram drain matches a tap against. Only what the
  // app shows: no future dose, no row the projection hides (an orphan PENDING
  // from an old client, a lineage-cancelled slot).
  async function withDueRows({ fromMs, toMs } = {}) {
    const [stored, { rows }] = await Promise.all([loadIntakes(), project({ fromMs, toMs, forecast: false })]);
    const byId = new Map(stored.map((i) => [String(i.recordId), i]));
    return rows.filter((r) => r.state !== 'upcoming').map((r) => byId.get(String(r.occId)) || virtualIntake(r));
  }

  // "Took my meds" (the Telegram chat confirm): the projection's open rows
  // due today in this instance's zone, up to atMs — never a future dose, never
  // an earlier day's missed one (bd med-wi09.12).
  async function dueToday(atMs) {
    const p = localDateTimeParts(atMs, timeZone);
    const dayStart = localWallToUtcMs(Date.UTC(p.year, p.month - 1, p.day), timeZone);
    return (await withDueRows({ fromMs: dayStart, toMs: atMs })).filter((i) => i.status === 'PENDING');
  }

  async function loadCutMs() {
    const all = await records.list(LEDGERCUT_RECORD_TYPE);
    const rec = all.find((r) => !r.deleted && r.recordId === LEDGERCUT_RECORD_ID);
    const ms = rec ? Date.parse(rec.at) : NaN;
    return Number.isFinite(ms) ? ms : null;
  }

  // First boot of a ledger-v2 client (bd med-wi09.12): the singleton whose
  // first op sets the account's cut. A derived write — floored and
  // put-if-absent (rule 12) — so it never moves a cut another device set.
  async function ensureLedgerCut() {
    return records.putIfAbsent(LEDGERCUT_RECORD_TYPE, {
      recordId: LEDGERCUT_RECORD_ID, clientTs: 0, deleted: false, at: new Date(now()).toISOString(),
    });
  }

  // The active APPROVED tz transition plan, or null — read directly (this
  // module's established pattern for shared record types, same as
  // medications.js reading intake records). A PENDING_APPROVAL/REJECTED/
  // COMPLETED plan has no effect on forecasting: planDosesWithTzPlan is a
  // passthrough for anything that isn't APPROVED.
  async function loadActiveTzPlan() {
    const all = await records.list(TZPLAN_RECORD_TYPE);
    const plan = all.find((r) => !r.deleted && r.recordId === TZPLAN_RECORD_ID);
    return plan && plan.status === 'APPROVED' ? plan : null;
  }

  // `delta` moves inventory only when the write actually landed: the reducer
  // can refuse it (a tombstoned slot is terminal).
  async function putIntake(intake, delta = 0) {
    const stored = await records.put(INTAKE_RECORD_TYPE, intake);
    const landed = !stored || (!stored.deleted && stored.status === intake.status);
    if (delta && landed) await adjustInventory(intake.medication_id, delta);
    return landed;
  }

  // projectOccurrences over the current vault. RAW intakes (tombstones hide
  // their forecast slot); a port without listRaw (pure-domain test doubles)
  // degrades to live rows only.
  async function project({ fromMs = -Infinity, toMs = Infinity, forecast = true } = {}) {
    const c = projectionCache(records, timeZone);
    // Asked before the read: a write landing in between is named again next time.
    const changes = typeof records.changesSince === 'function' ? records.changesSince(INTAKE_RECORD_TYPE, c.token) : null;
    const [meds, intakes, tzPlan, lineage, scheds, transitions, storedCut] = await Promise.all([
      loadMeds(),
      records.listRaw ? records.listRaw(INTAKE_RECORD_TYPE) : records.list(INTAKE_RECORD_TYPE),
      loadActiveTzPlan(),
      loadLineage(records),
      records.list('medsched'),
      records.list('tztransition'),
      loadCutMs(),
    ]);
    const nowMs = now();
    // No ledgercut row yet = this client is about to write one (install-time
    // ensureLedgerCut), so the cut is this port's first read — fixed there, so
    // it never slides forward with the clock before the write lands (N2).
    if (storedCut === null && !provisionalCuts.has(records)) provisionalCuts.set(records, nowMs);
    const cut = storedCut ?? provisionalCuts.get(records);
    syncIndex(c, changes, intakes);
    const evidence = transitions.some((t) => t && !t.deleted) ? null : evidenceFor(c, cut, nowMs);
    const gkey = JSON.stringify([cut, medsKey(meds), scheds, transitions, tzPlan,
      evidence && [evidence.transitions, evidence.initialZone]]);
    if (gkey !== c.gkey) {
      c.cells.clear();
      c.gkey = gkey;
    }
    const base = { medications: meds, scheds, transitions, tzPlan, timeZone, cutMs: cut, nowMs, evidence };
    const liveDay = Math.floor(nowMs / DAY_MS);
    // Before the earliest stored row and the cut day there is nothing to list.
    const dFrom = Math.max(Number.isFinite(fromMs) ? Math.floor(fromMs / DAY_MS) : -Infinity,
      Math.min(c.minDay, Math.floor(cut / DAY_MS) - 1));
    const dTo = Math.min(Number.isFinite(toMs) ? Math.floor(toMs / DAY_MS) : Infinity, liveDay - 1);
    let span = null;
    const fill = () => { if (span) settleDays(c, span[0], span[1], base); span = null; };
    for (let d = dFrom; d <= dTo; d++) {
      const cell = c.cells.get(d);
      if (cell && nowMs < cell.recheckAt) fill();
      else if (span) span[1] = d;
      else span = [d, d];
    }
    fill();
    const rows = [];
    for (let d = dFrom; d <= dTo; d++) {
      const cell = c.cells.get(d);
      const edge = d === dFrom || d === dTo;
      for (let k = 0; k < cell.rows.length; k++) {
        if (!edge || (cell.ms[k] >= fromMs && cell.ms[k] <= toMs)) rows.push(cell.rows[k]);
      }
    }
    if (toMs >= liveDay * DAY_MS) {
      const lf = Math.max(fromMs, liveDay * DAY_MS);
      const live = rowsOfDays(c, liveDay, Number.isFinite(toMs) ? Math.floor(toMs / DAY_MS) : Infinity);
      const { occurrences: regenerated } = regenerateWindow({ ...base, intakes: live, fromMs: lf, toMs });
      rows.push(...projectOccurrences({
        medications: meds, intakes: live, tzPlan, timeZone, nowMs, fromMs: lf, toMs, forecast, regenerated, cutMs: cut,
      }));
    }
    const out = applyLineage(rows, lineage, intakes);
    if (onBoundary) {
      let next = Infinity;
      for (const r of out) {
        // A snooze running out turns its row due on the clock alone too.
        const ms = Date.parse(r.state === 'upcoming' ? r.plannedAt : r.state === 'snoozed' ? r.snoozedUntil : '');
        if (ms > nowMs && ms < next) next = ms;
      }
      if (next < Infinity) onBoundary(next);
    }
    return { meds, rows: out };
  }

  // The settled days [a, b] (UTC day numbers): one regeneration over the span,
  // then each day's rows on their own — a day's stored rows are exactly the
  // ones that can occupy its slots (indexAdd).
  function settleDays(c, a, b, base) {
    const fromMs = a * DAY_MS;
    const toMs = (b + 1) * DAY_MS - 1;
    const { occurrences } = regenerateWindow({ ...base, intakes: rowsOfDays(c, a, b), fromMs, toMs });
    const occByDay = new Map();
    for (const o of occurrences) {
      const d = Math.floor(o.at / DAY_MS);
      if (!occByDay.has(d)) occByDay.set(d, []);
      occByDay.get(d).push(o);
    }
    for (let d = a; d <= b; d++) {
      const dayRows = rowsOfDays(c, d, d);
      // Frozen: these rows are handed to every later read, so no consumer may
      // change them in place (R3-3). `conflict` is the stored row's own object,
      // so it gets a frozen copy rather than freezing the record.
      const rows = projectOccurrences({
        medications: base.medications, intakes: dayRows, tzPlan: base.tzPlan, timeZone, nowMs: base.nowMs,
        fromMs: d * DAY_MS, toMs: (d + 1) * DAY_MS - 1, forecast: false, regenerated: occByDay.get(d) || [], cutMs: base.cutMs,
      }).map((r) => Object.freeze(r.conflict ? { ...r, conflict: Object.freeze({ ...r.conflict }) } : r));
      let recheckAt = Infinity;
      for (const i of dayRows) {
        const s = i.snoozed_until ? Date.parse(i.snoozed_until) : NaN;
        if (s > base.nowMs && s < recheckAt) recheckAt = s;
      }
      c.cells.set(d, { rows, ms: rows.map((r) => Date.parse(r.plannedAt)), recheckAt });
    }
  }

  // evidenceTransitions over the index, kept until the index changes, the cut
  // moves, or a tz-stamped instant still ahead comes due.
  function evidenceFor(c, cut, nowMs) {
    const e = c.evidence;
    if (e && e.version === c.version && e.cut === cut && nowMs >= e.nowMs && nowMs < e.value.nextAt) return e.value;
    const value = evidenceTransitions([...c.index.values()], timeZone, cut, nowMs, {
      rowOf: (x) => x.row,
      msOf: (x) => x.ms,
      localDateOf: (x) => {
        if (x.localDate === undefined) {
          const p = localDateTimeParts(x.ms, x.row.tz);
          x.localDate = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
        }
        return x.localDate;
      },
    });
    c.evidence = { version: c.version, cut, nowMs, value };
    return value;
  }

  // GET /api/doses — the projection itself.
  async function occurrences({ fromMs, toMs } = {}) {
    return (await project({ fromMs, toMs })).rows;
  }

  // Best-effort, matching the server's DecrementInventory calls: a null/
  // untracked inventory_count (or a missing medication) is a silent no-op.
  async function adjustInventory(medId, delta) {
    const meds = await records.list(MEDICATION_RECORD_TYPE);
    // String(): an intake's medication_id may be number vs string against the
    // med's recordId (med-wi09.15) — a strict miss silently skips the stock move.
    const med = meds.find((m) => String(m.recordId) === String(medId) && !m.deleted);
    if (!med || med.inventory_count === null || med.inventory_count === undefined) return;
    await records.put(MEDICATION_RECORD_TYPE, {
      ...med,
      clientTs: now(),
      inventory_count: med.inventory_count + delta,
    });
  }

  // The REMINDER CALLBACK (a Telegram tap drained by inbox-apply.js): PENDING ->
  // TAKEN, decrement inventory. A callback may only move rev 0 -> 1 (bd
  // med-wi09.11): a dose any explicit action already touched is not its to
  // change, so it throws not_pending like an already-confirmed one — which is
  // also the redelivery idempotency guard (no double decrement).
  async function confirm(intakeId, takenAtMs) {
    const intake = await getIntake(intakeId);
    if (!intake || intake.status !== 'PENDING' || intakeRev(intake) !== 0) throw notPending();
    const nowMs = now();
    const updated = acted(intake, { status: 'TAKEN', taken_at: new Date(takenAtMs ?? nowMs).toISOString() }, nowMs);
    await putIntake(updated, -1);
    return toResponse(updated);
  }

  // Ported from SkipIntake: PENDING -> SKIPPED, no inventory change.
  async function skip(intakeId) {
    const intake = await getIntake(intakeId);
    if (!intake || !OPEN_STATUSES.has(intake.status)) throw notPending();
    await putIntake(acted(intake, { status: 'SKIPPED' }, now()));
    return { status: 'skipped' };
  }

  // Ported from handleSnoozeMedication + SnoozeIntake: only an open intake
  // can be snoozed; default duration matches the server's 10-minute default.
  // A snooze is its own merge branch (snoozed_at), never an action: no rev
  // bump, no status change.
  async function snooze(intakeId, durationMinutes) {
    const intake = await getIntake(intakeId);
    if (!intake) throw notFound('intake not found');
    if (!OPEN_STATUSES.has(intake.status)) throw notPending();
    const minutes = durationMinutes > 0 ? durationMinutes : DEFAULT_SNOOZE_MINUTES;
    const nowMs = now();
    const snoozedUntil = new Date(nowMs + minutes * 60 * 1000).toISOString();
    // A dose with no row yet gets its first one here: stamped rev 0 (a snooze
    // is not an action — a reminder callback may still confirm it), the
    // channel and the zone, like acted() but without the rev bump.
    const stamp = typeof intake.rev === 'number' ? {} : { rev: intakeRev(intake), via, tz: timeZone };
    await putIntake({
      ...intake, ...stamp, clientTs: nowMs, snoozed_until: snoozedUntil, snoozed_at: new Date(nowMs).toISOString(),
    });
    return { status: 'snoozed', snoozed_until: snoozedUntil };
  }

  // Ported from LogMedicationAt/CreateManualIntake: a manual past intake has
  // no scheduled slot, so scheduled_at == taken_at and it gets a random id.
  async function logPast(medicationId, takenAtMs) {
    const meds = await loadMeds();
    const med = meds.find((m) => sameMed(m.recordId, medicationId));
    if (!med) throw notFound('medication not found');

    const nowMs = now();
    const takenIso = new Date(takenAtMs).toISOString();
    const record = acted(null, {
      recordId: genManualId(nowMs),
      deleted: false,
      medication_id: medicationId,
      scheduled_at: takenIso,
      taken_at: takenIso,
      status: 'TAKEN',
      snoozed_until: null,
      source: 'schedule',
    }, nowMs);
    await putIntake(record, -1);
    return toResponse(record);
  }

  // Ported from handleUpdateIntake (POST /api/intakes/update): per-row
  // {updated, failed, failures[]} so the frontend can roll back only the rows
  // that failed. Cloud mode has no tz-plan gating yet (Task 4), so the only
  // failure reason possible here is "not_found_or_forbidden".
  async function updateIntakes(allUpdates) {
    // One write per id, the first copy wins (see uniqueIds).
    const seen = new Set();
    const updates = allUpdates.filter((up) => !seen.has(String(up.id)) && seen.add(String(up.id)));
    let updated = 0;
    const failures = [];
    const nowMs = now();
    const resolve = await resolver(updates.map((up) => up.id));
    for (const up of updates) {
      const intake = resolve.get(up.id);
      if (!intake) {
        failures.push({ id: up.id, reason: 'not_found_or_forbidden' });
        continue;
      }
      const prevStatus = intake.status;
      const takenAt = up.status === 'TAKEN'
        ? (up.taken_at || new Date(nowMs).toISOString())
        : null;
      // A revert to PENDING is an undo: stored as UNTAKEN (bd med-wi09.11).
      const status = up.status === 'PENDING' && !OPEN_STATUSES.has(prevStatus) ? 'UNTAKEN' : up.status;
      let delta = 0;
      if (up.status === 'PENDING' && prevStatus === 'TAKEN') delta = 1;
      else if (up.status === 'TAKEN' && OPEN_STATUSES.has(prevStatus)) delta = -1;
      await putIntake(acted(intake, untakenNote(intake, { status, taken_at: takenAt }), nowMs), delta);
      updated++;
    }
    return { updated, failed: failures.length, failures };
  }

  // Ported from handleConfirmSchedule: intake_ids take priority (batch
  // confirm-by-id); otherwise scheduled_at + medication_ids confirms the
  // listed meds. Always additive (bd med-wi09.2): a med absent from the list
  // is never touched — absence from a view is not an undo; undo is an
  // explicit act() on its id. A dose with no stored row (regenerated or
  // forecast) is confirm-or-create at its exact id (getIntake).
  // takenAt (optional, the take sheet's "Time taken") back-dates taken_at;
  // clientTs stays now so the write still wins LWW.
  async function confirmSchedule({ scheduledAt, medicationIds = [], intakeIds = [], takenAt } = {}) {
    const nowMs = now();
    const takenMs = takenAt ? Date.parse(takenAt) : NaN;
    const takenIso = new Date(Number.isFinite(takenMs) ? takenMs : nowMs).toISOString();

    if (intakeIds.length > 0) {
      const ids = uniqueIds(intakeIds);
      const resolve = await resolver(ids);
      for (const id of ids) {
        const intake = resolve.get(id);
        if (!intake || !OPEN_STATUSES.has(intake.status)) continue;
        await putIntake(acted(intake, { status: 'TAKEN', taken_at: takenIso }, nowMs), -1);
      }
      return { status: 'confirmed' };
    }

    const scheduledAtMs = Date.parse(scheduledAt);
    for (const medId of medicationIds) {
      const intakes = await loadIntakes();
      const intake = intakes.find((i) => String(i.medication_id) === String(medId)
        && Date.parse(i.scheduled_at) === scheduledAtMs)
        || (Number.isFinite(scheduledAtMs) ? await getIntake(slotId(medId, scheduledAtMs)) : null);
      if (intake && OPEN_STATUSES.has(intake.status)) {
        await putIntake(acted(intake, { status: 'TAKEN', taken_at: takenIso }, nowMs), -1);
      }
    }

    return { status: 'confirmed' };
  }

  // POST /api/doses/act (bd med-wi09.2) — one explicit action on explicit
  // occIds; nothing outside the list is touched. Per id:
  //   take      PENDING or absent → TAKEN (absent = created at the planned
  //             instant when the forecast has that slot), −1 inventory
  //   skip      PENDING or absent → SKIPPED
  //   undo      TAKEN/SKIPPED → UNTAKEN (reads as PENDING), +1 inventory when
  //             it was TAKEN
  //   edit_time TAKEN → taken_at only
  // A row already in the target state is `unchanged` (a repeated bulk take is
  // idempotent: no second decrement, taken_at kept). Anything else is a
  // per-id failure {id, reason}, so the UI rolls back only those.
  // An absent occId resolves EXACTLY: the stored row with that id, else a
  // stored row for the same med at the same instant (legacy ids), else the
  // projection's dose at that id (regenerated or forecast) — never a
  // neighbouring dose. A tombstoned id is gone.
  async function act({ occIds = [], action, takenAt } = {}) {
    if (!['take', 'skip', 'undo', 'edit_time'].includes(action)) {
      const err = new Error('action must be take, skip, undo or edit_time');
      err.code = 'bad_request';
      throw err;
    }
    const nowMs = now();
    const takenMs = takenAt ? Date.parse(takenAt) : NaN;
    if (action === 'edit_time' && !Number.isFinite(takenMs)) {
      const err = new Error('taken_at is required for edit_time');
      err.code = 'bad_request';
      throw err;
    }
    const takenIso = new Date(Number.isFinite(takenMs) ? takenMs : nowMs).toISOString();
    const raw = records.listRaw ? await records.listRaw(INTAKE_RECORD_TYPE) : [];
    const tombstoned = new Set(raw.filter((i) => i.deleted).map((i) => String(i.recordId)));
    const result = { updated: 0, unchanged: 0, failed: 0, failures: [], doses: [] };
    const fail = (id, reason) => { result.failed++; result.failures.push({ id, reason }); };

    const ids = [...new Set(occIds)];
    const [resolve, meds] = await Promise.all([resolver(ids), loadMeds()]);
    const intakes = resolve.stored;
    for (const occId of ids) {
      // Ids compare as String() throughout: a med's recordId and an intake's
      // medication_id (or a JSON occId) can be number vs string (med-wi09.15).
      let intake = intakes.find((i) => String(i.recordId) === String(occId)) || null;
      let virtual = false;
      if (!intake) {
        const m = /^intake-(.+)-(\d+)$/.exec(String(occId));
        const med = m && meds.find((x) => String(x.recordId) === m[1]);
        if (m && med && !tombstoned.has(String(occId))) {
          const sec = Number(m[2]);
          intake = intakes.find((i) => String(i.medication_id) === String(med.recordId)
            && Math.floor(Date.parse(i.scheduled_at) / 1000) === sec) || null;
          if (!intake) {
            intake = resolve.get(occId);
            virtual = !!intake;
          }
        }
      }
      if (!intake) { fail(occId, 'not_found'); continue; }

      // UNTAKEN (an earlier undo) acts exactly like PENDING here.
      const status = wireStatus(intake.status);
      let next = null;
      let delta = 0;
      if (action === 'take') {
        if (status === 'TAKEN') { result.unchanged++; continue; }
        if (status !== 'PENDING') { fail(occId, 'not_pending'); continue; }
        next = { status: 'TAKEN', taken_at: takenIso };
        delta = -1;
      } else if (action === 'skip') {
        if (status === 'SKIPPED') { result.unchanged++; continue; }
        if (status !== 'PENDING') { fail(occId, 'not_pending'); continue; }
        next = { status: 'SKIPPED', taken_at: null };
      } else if (action === 'undo') {
        if (virtual) { fail(occId, 'not_found'); continue; }
        if (status === 'PENDING') { result.unchanged++; continue; }
        next = { status: 'UNTAKEN', taken_at: null };
        if (status === 'TAKEN') delta = 1;
      } else {
        if (status !== 'TAKEN') { fail(occId, 'not_taken'); continue; }
        if (intake.taken_at === takenIso) { result.unchanged++; continue; }
        next = { taken_at: takenIso };
      }

      const record = acted(intake, untakenNote(intake, next), nowMs);
      if (!(await putIntake(record, delta))) { fail(occId, 'not_found'); continue; }
      result.updated++;
      result.doses.push(toResponse(record));
    }
    return result;
  }

  // Ported from handleCancelIntake: TAKEN -> UNTAKEN (reads as PENDING),
  // increment inventory.
  async function cancelIntakes(intakeIds) {
    const nowMs = now();
    let cancelledCount = 0;
    const ids = uniqueIds(intakeIds);
    const resolve = await resolver(ids);
    for (const id of ids) {
      const intake = resolve.get(id);
      if (!intake || intake.status !== 'TAKEN') continue;
      await putIntake(acted(intake, untakenNote(intake, { status: 'UNTAKEN', taken_at: null }), nowMs), 1);
      cancelledCount++;
    }
    return { status: 'cancelled', cancelled_count: cancelledCount, requested_count: intakeIds.length };
  }

  // Ported from handleDeleteFutureIntake: only a PENDING intake scheduled
  // strictly in the future can be hard-deleted; past history is preserved.
  async function deleteFutureIntakes(intakeIds) {
    const nowMs = now();
    let deletedCount = 0;
    const ids = uniqueIds(intakeIds);
    const resolve = await resolver(ids);
    for (const id of ids) {
      const intake = resolve.get(id);
      if (!intake || !OPEN_STATUSES.has(intake.status) || Date.parse(intake.scheduled_at) <= nowMs) continue;
      await records.del(INTAKE_RECORD_TYPE, id);
      deletedCount++;
    }
    return { status: 'deleted', deleted_count: deletedCount, requested_count: intakeIds.length };
  }

  // Ported from handleTriggerNextIntake: confirm-or-create each member of the
  // cluster nextIntake shows — the same projection rows (bd med-wi09.18), so
  // the writer never records a dose the card does not show. Each member is
  // written at its own planned instant, keeping its tz_step source.
  async function triggerNextIntake() {
    const intakes = await loadIntakes();
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();

    const { meds, timeMs: clusterEarliestMs, rows } = await nextCluster(nowMs);
    const cluster = rows.map((r) => ({
      occId: String(r.occId), medicationId: r.medId, scheduledAtMs: Date.parse(r.plannedAt), source: r.source,
    }));

    if (cluster.length === 0) throw notFound('No upcoming scheduled intakes found');

    const medNames = [];
    let confirmedCount = 0;

    for (const target of cluster) {
      const med = meds.find((m) => sameMed(m.recordId, target.medicationId));
      if (med) medNames.push(med.name);

      // Confirm-or-create at the row's exact id (bd med-wi09.12): its stored
      // row, else a legacy-id row for the same med at the same instant.
      const existing = intakes.find((i) => String(i.recordId) === target.occId)
        || intakes.find((i) => sameMed(i.medication_id, target.medicationId)
          && Date.parse(i.scheduled_at) === target.scheduledAtMs);

      if (existing && OPEN_STATUSES.has(existing.status)) {
        await putIntake(acted(existing, { status: 'TAKEN', taken_at: nowIso }, nowMs), -1);
        confirmedCount++;
      } else if (!existing) {
        const record = acted(null, {
          recordId: target.occId,
          deleted: false,
          medication_id: target.medicationId,
          scheduled_at: new Date(target.scheduledAtMs).toISOString(),
          taken_at: nowIso,
          status: 'TAKEN',
          snoozed_until: null,
          source: target.source === 'tz_step' ? 'tz_step' : 'schedule',
        }, nowMs);
        intakes.push(record);
        if (await putIntake(record, -1)) confirmedCount++;
      }
      // Already TAKEN/SKIPPED members were filtered out of `cluster` above.
    }

    return {
      status: 'confirmed',
      scheduled_at: new Date(clusterEarliestMs).toISOString(),
      taken_at: nowIso,
      medication_count: confirmedCount,
      medication_names: medNames,
    };
  }

  // The nearest not-yet-handled dose cluster (±10min) in the next 12h, read
  // off the projection's upcoming rows: one row per med (its earliest), its
  // med, and the cluster's earliest instant. nextIntake shows it and
  // triggerNextIntake writes it — one reading, so they cannot disagree.
  async function nextCluster(nowMs) {
    const { meds, rows } = await project({ fromMs: nowMs, toMs: nowMs + NEXT_INTAKE_FORECAST_MS });

    let timeMs = null;
    let picked = [];
    for (const r of rows) {
      if (r.state !== 'upcoming') continue;
      const med = meds.find((m) => String(m.recordId) === String(r.medId));
      // An archived med's stored PENDING row (e.g. an undo after archiving)
      // is history, not a dose to offer — the forecast already skips it.
      if (!med || med.archived) continue;
      const ms = Date.parse(r.plannedAt);
      if (timeMs === null || ms < timeMs) {
        timeMs = ms;
        picked = [{ med, row: r }];
      } else if (Math.abs(ms - timeMs) <= CLUSTER_WINDOW_MS && !picked.some((p) => p.med === med)) {
        picked.push({ med, row: r });
      }
    }
    return { meds: picked.map((p) => p.med), rows: picked.map((p) => p.row), timeMs };
  }

  // Ported from computeNextIntakeData: nearest not-yet-handled dose cluster
  // (±10min) in the next 12h. Returns null (204-equivalent) when none. A view
  // over the projection's upcoming rows (bd med-wi09.1).
  async function nextIntake() {
    const { meds: nextMeds, timeMs: nextTimeMs } = await nextCluster(now());

    if (nextMeds.length === 0) return null;

    return {
      scheduled_at: new Date(nextTimeMs).toISOString(),
      medication_ids: nextMeds.map((m) => m.recordId),
      medication_names: nextMeds.map((m) => m.name),
    };
  }

  // upcomingDoses is nextIntake's forecast generalized from "the next cluster
  // in 12h" to "every not-yet-handled dose in the next N days" — the SAME
  // plan-aware engine, so the Meds → Schedule tab and Home's next-intake card
  // cannot disagree (bd med-gut.1). Rows carry their wall-clock date/time in
  // the tracked zone (`local_date`/`local_time`/`day_offset`) because grouping
  // and formatting are zone math, and the browser only knows the DEVICE zone —
  // the naive device-local bucketing this replaces is exactly the bug.
  // tz-plan step rows also carry step_number/total_steps/note so the UI can
  // label them and show buildNote's explanation (bd med-gut.2).
  // A view over the projection's upcoming rows (bd med-wi09.1), wire shape
  // unchanged.
  async function upcomingDoses({ days = UPCOMING_FORECAST_DAYS } = {}) {
    const nowMs = now();
    const { meds, rows } = await project({ fromMs: nowMs, toMs: nowMs + days * DAY_MS });

    const byId = new Map(meds.map((m) => [String(m.recordId), m]));
    const today = localDateTimeParts(nowMs, timeZone);
    const todayUtc = Date.UTC(today.year, today.month - 1, today.day);

    const out = [];
    for (const r of rows) {
      const med = byId.get(String(r.medId));
      if (r.state !== 'upcoming' || !med || med.archived) continue;
      const [y, mo, d] = r.localDate.split('-').map(Number);
      const row = {
        medication_id: r.medId,
        med_name: r.name,
        dosage: r.dosage,
        scheduled_at: new Date(Date.parse(r.plannedAt)).toISOString(),
        local_date: r.localDate,
        local_time: r.localTime,
        day_offset: Math.round((Date.UTC(y, mo - 1, d) - todayUtc) / DAY_MS),
        source: r.source === 'tz_step' ? 'tz_step' : 'schedule',
      };
      if (r.source === 'tz_step') {
        row.step_number = r.stepNumber;
        row.total_steps = r.totalSteps;
        if (r.stepNote) row.note = r.stepNote;
      }
      out.push(row);
    }
    return out;
  }

  // Ported from handleListHistory (GET /api/history?days&med_id):
  // newest-first, same row shape, capped at 100. The projection's stored half.
  async function history({ days = 3, medId = 0 } = {}) {
    const nowMs = now();
    const fromMs = days > 0 ? nowMs - days * DAY_MS : -Infinity;
    const { rows } = await project({ fromMs, forecast: false });
    return rows
      .filter((r) => (medId ? sameMed(r.medId, medId) : true))
      .reverse()
      .slice(0, 100)
      .map(historyResponse);
  }

  // Uncapped, windowed intake log for composite analysis — mirrors the Go
  // analyze_* handlers' fetchMedicationsSection (ListIntakesSince, uncapped,
  // then join med name/dosage). history()'s 100-row cap would undercount
  // adherence, or drop every row for a past-dated window, over a dense range;
  // this reads the full [fromMs,toMs] slice ascending with the Go row shape
  // ({medication_name, dosage, scheduled_at, status, taken_at?}), plus
  // `manual: true` on a log-past row — its scheduled_at is a fake copy of
  // taken_at (see logPast), so foldAdherence must keep it out of delay math.
  // A view over the projection's history half (bd med-wi09.12), so a dose
  // regenerated from the cut with nothing logged counts as missed exactly as a
  // stored PENDING row did.
  async function listWindow({ fromMs = 0, toMs = Infinity } = {}) {
    const { rows } = await project({ fromMs, toMs, forecast: false });
    return rows.map((r) => {
      const row = {
        medication_name: r.name,
        dosage: r.dosage,
        scheduled_at: r.plannedAt,
        status: historyResponse(r).status,
      };
      if (r.takenAt) row.taken_at = r.takenAt;
      if (r.source === 'manual') row.manual = true;
      return row;
    });
  }

  // The doses in [fromMs, toMs] as a stored-row-shaped log (historyResponse):
  // stored evidence, regenerated doses and the forecast — gamification's
  // adherence input. Always a window: the projection never reads the whole log.
  async function doseLog({ fromMs, toMs }) {
    return (await project({ fromMs, toMs })).rows.map(historyResponse);
  }

  return {
    ensureLedgerCut,
    withDueRows,
    dueToday,
    doseLog,
    confirm,
    skip,
    snooze,
    logPast,
    updateIntakes,
    confirmSchedule,
    act,
    cancelIntakes,
    deleteFutureIntakes,
    triggerNextIntake,
    nextIntake,
    occurrences,
    upcomingDoses,
    history,
    listWindow,
  };
}
