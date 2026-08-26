// Runtime-agnostic medication intake state machine. Pure logic over an
// injected records port — no window/document/fetch/IndexedDB — so the same
// file can later run inside the Go server via goja (C6). Mirrors
// internal/domain/medication.go + the intake-related handlers in
// internal/server/medication_handlers.go, server.go (confirm-schedule) and
// settings_handlers.go (next-intake forecast).
//
// Record type: intake — medication_id, scheduled_at, taken_at, status
// (PENDING|TAKEN|SKIPPED), snoozed_until, source ("schedule" or "tz_step" —
// a slot that came from an APPROVED tz transition plan's steps, unioned in
// via planDosesWithTzPlan, see tzplan.js).
//
// Deterministic ids are the multi-device dedup mechanism: a scheduled dose's
// recordId is `intake-<medId>-<slotUnix>`, so two devices materializing "the
// same" due intake write an identical record and LWW merges them into one —
// no dupes, no divergence. Manual (log-past) intakes have no natural slot, so
// they get a random id (same nowMs+random technique as medications.js's
// nextId / weight.js's genId).
import { minDoseIntervalMs, localDateTimeParts, scheduleYieldsDoses } from './medschedule.js';
import { planDosesWithTzPlan, forecastDosesWithTzPlan } from './tzplan.js';

const MEDICATION_RECORD_TYPE = 'medication';
const INTAKE_RECORD_TYPE = 'intake';
const TZPLAN_RECORD_TYPE = 'tzplan';
const TZPLAN_RECORD_ID = 'tzplan-current';

const NEXT_INTAKE_FORECAST_MS = 12 * 60 * 60 * 1000;
const CLUSTER_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_SNOOZE_MINUTES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
// The only marker a log-past intake carries — logPast writes source:'schedule'
// like a materialized dose, so the id prefix is what distinguishes them.
const MANUAL_ID_PREFIX = 'intake-manual-';
const UPCOMING_FORECAST_DAYS = 7;
// A dose taken more than this long after its slot is "delayed". Owner decision
// (bd med-29gh.2): 60 minutes, from their own "avg delay ~ 1h" framing — the
// default snooze is 10 minutes, so anything under an hour is routine. Named so
// it stays tunable.
const DELAYED_DOSE_THRESHOLD_MS = 60 * 60 * 1000;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function slotId(medId, scheduledAtMs) {
  return `intake-${medId}-${Math.floor(scheduledAtMs / 1000)}`;
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

// Ported from IntakeLog's JSON tags (repo.go:104-114) — taken_at/
// snoozed_until have omitempty.
function toResponse(intake) {
  const resp = {
    id: intake.recordId,
    medication_id: intake.medication_id,
    scheduled_at: intake.scheduled_at,
    status: intake.status,
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

// createIntakeDomain builds the intake state-machine API over the injected
// ports:
//   records — { list(type), put(type, record), del(type, id) }
//   now()   — current time in ms epoch
//   timeZone — IANA zone string, passed straight through to planDoses
export function createIntakeDomain({ records, now, timeZone }) {
  async function loadMeds() {
    const all = await records.list(MEDICATION_RECORD_TYPE);
    return all.filter((m) => !m.deleted);
  }

  async function loadIntakes() {
    const all = await records.list(INTAKE_RECORD_TYPE);
    return all.filter((i) => !i.deleted);
  }

  async function getIntake(id) {
    const all = await loadIntakes();
    return all.find((i) => i.recordId === id) || null;
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

  async function putIntake(intake) {
    await records.put(INTAKE_RECORD_TYPE, intake);
  }

  // Best-effort, matching the server's DecrementInventory calls: a null/
  // untracked inventory_count (or a missing medication) is a silent no-op.
  async function adjustInventory(medId, delta) {
    const meds = await records.list(MEDICATION_RECORD_TYPE);
    const med = meds.find((m) => m.recordId === medId && !m.deleted);
    if (!med || med.inventory_count === null || med.inventory_count === undefined) return;
    await records.put(MEDICATION_RECORD_TYPE, {
      ...med,
      clientTs: now(),
      inventory_count: med.inventory_count + delta,
    });
  }

  // Ported from internal/domain/medplan/medplan.go's fire-mode use in
  // internal/scheduler/medication.go: run PlanDoses with window=0 (due-or-past
  // targets in today's local date) and materialize a PENDING intake for any
  // slot not already covered. Dedup mirrors HasIntakeNearScheduledTime: the
  // deterministic id itself catches an exact-slot re-run, and the
  // ±minDoseInterval band additionally blocks a near-duplicate slot (e.g. a
  // schedule edit that shifted the clock time slightly) from double-firing.
  // Called by the shim on domain init and on its own timer — this module
  // itself has no timer, staying a pure function of its inputs at call time.
  async function materializeDueDoses() {
    const meds = await loadMeds();
    const intakes = await loadIntakes();
    const nowMs = now();
    const tzPlan = await loadActiveTzPlan();

    const targets = planDosesWithTzPlan({
      medications: meds.map(toMedScheduleShape), timeZone, now: nowMs, window: 0, tzPlan,
    });

    const created = [];
    for (const target of targets) {
      const id = slotId(target.medicationId, target.scheduledAtMs);
      if (intakes.some((i) => i.recordId === id)) continue;

      const med = meds.find((m) => m.recordId === target.medicationId);
      const bandMs = med ? minDoseIntervalMs(med.schedule, med.tz_shift_policy) : 0;
      if (bandMs > 0) {
        const near = intakes.some((i) => i.medication_id === target.medicationId
          && (i.status === 'PENDING' || i.status === 'TAKEN')
          && Math.abs(Date.parse(i.scheduled_at) - target.scheduledAtMs) <= bandMs);
        if (near) continue;
      }

      const record = {
        recordId: id,
        // DERIVED state, so it takes the LOWEST possible LWW precedence — not
        // now(). This row is re-derivable from the schedule on every device and
        // its id is deterministic, so a device whose mirror predates a confirm
        // (it was closed when the Telegram tap drained elsewhere) re-creates
        // the very same recordId as PENDING. Stamped with now() that stale
        // re-creation is the NEWEST write, and LWW erases the real TAKEN — a
        // confirmed dose silently reverting to Pending hours later, on every
        // device (bd med-d4w). A floor clientTs makes materialization lose
        // every merge against a real write, which is exactly its standing: it
        // only ever needs to win against nothing at all.
        clientTs: 0,
        deleted: false,
        medication_id: target.medicationId,
        scheduled_at: new Date(target.scheduledAtMs).toISOString(),
        taken_at: null,
        status: 'PENDING',
        snoozed_until: null,
        source: target.source === 'tz_step' ? 'tz_step' : 'schedule',
      };
      await putIntake(record);
      intakes.push(record);
      created.push(record);
    }
    return created.map(toResponse);
  }

  // Ported from ConfirmIntakeWithCleanup: PENDING -> TAKEN, decrement
  // inventory. The already-confirmed idempotency guard is the status check
  // itself — a non-PENDING intake throws instead of double-decrementing.
  async function confirm(intakeId, takenAtMs) {
    const intake = await getIntake(intakeId);
    if (!intake || intake.status !== 'PENDING') throw notPending();
    const takenIso = new Date(takenAtMs ?? now()).toISOString();
    const updated = {
      ...intake, clientTs: now(), status: 'TAKEN', taken_at: takenIso,
    };
    await putIntake(updated);
    await adjustInventory(intake.medication_id, -1);
    return toResponse(updated);
  }

  // Ported from SkipIntake: PENDING -> SKIPPED, no inventory change.
  async function skip(intakeId) {
    const intake = await getIntake(intakeId);
    if (!intake || intake.status !== 'PENDING') throw notPending();
    await putIntake({ ...intake, clientTs: now(), status: 'SKIPPED' });
    return { status: 'skipped' };
  }

  // Ported from handleSnoozeMedication + SnoozeIntake: only a PENDING intake
  // can be snoozed; default duration matches the server's 10-minute default.
  async function snooze(intakeId, durationMinutes) {
    const intake = await getIntake(intakeId);
    if (!intake) throw notFound('intake not found');
    if (intake.status !== 'PENDING') throw notPending();
    const minutes = durationMinutes > 0 ? durationMinutes : DEFAULT_SNOOZE_MINUTES;
    const nowMs = now();
    const snoozedUntil = new Date(nowMs + minutes * 60 * 1000).toISOString();
    await putIntake({ ...intake, clientTs: nowMs, snoozed_until: snoozedUntil });
    return { status: 'snoozed', snoozed_until: snoozedUntil };
  }

  // Ported from LogMedicationAt/CreateManualIntake: a manual past intake has
  // no scheduled slot, so scheduled_at == taken_at and it gets a random id.
  async function logPast(medicationId, takenAtMs) {
    const meds = await loadMeds();
    const med = meds.find((m) => m.recordId === medicationId);
    if (!med) throw notFound('medication not found');

    const nowMs = now();
    const takenIso = new Date(takenAtMs).toISOString();
    const record = {
      recordId: genManualId(nowMs),
      clientTs: nowMs,
      deleted: false,
      medication_id: medicationId,
      scheduled_at: takenIso,
      taken_at: takenIso,
      status: 'TAKEN',
      snoozed_until: null,
      source: 'schedule',
    };
    await putIntake(record);
    await adjustInventory(medicationId, -1);
    return toResponse(record);
  }

  // Ported from handleUpdateIntake (POST /api/intakes/update): per-row
  // {updated, failed, failures[]} so the frontend can roll back only the rows
  // that failed. Cloud mode has no tz-plan gating yet (Task 4), so the only
  // failure reason possible here is "not_found_or_forbidden".
  async function updateIntakes(updates) {
    let updated = 0;
    const failures = [];
    const nowMs = now();
    for (const up of updates) {
      const intake = await getIntake(up.id);
      if (!intake) {
        failures.push({ id: up.id, reason: 'not_found_or_forbidden' });
        continue;
      }
      const prevStatus = intake.status;
      const takenAt = up.status === 'TAKEN'
        ? (up.taken_at || new Date(nowMs).toISOString())
        : null;
      await putIntake({
        ...intake, clientTs: nowMs, status: up.status, taken_at: takenAt,
      });
      updated++;
      if (up.status === 'PENDING' && prevStatus === 'TAKEN') {
        await adjustInventory(intake.medication_id, 1);
      } else if (up.status === 'TAKEN' && prevStatus === 'PENDING') {
        await adjustInventory(intake.medication_id, -1);
      }
    }
    return { updated, failed: failures.length, failures };
  }

  // Ported from handleConfirmSchedule: intake_ids take priority (batch
  // confirm-by-id); otherwise scheduled_at + medication_ids confirms the
  // listed meds AND reverts any other TAKEN intake at the same exact slot
  // back to PENDING (the "user unchecked a box that was already confirmed"
  // path).
  async function confirmSchedule({ scheduledAt, medicationIds = [], intakeIds = [] } = {}) {
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();

    if (intakeIds.length > 0) {
      for (const id of intakeIds) {
        const intake = await getIntake(id);
        if (!intake || intake.status !== 'PENDING') continue;
        await putIntake({
          ...intake, clientTs: nowMs, status: 'TAKEN', taken_at: nowIso,
        });
        await adjustInventory(intake.medication_id, -1);
      }
      return { status: 'confirmed' };
    }

    const scheduledAtMs = Date.parse(scheduledAt);
    for (const medId of medicationIds) {
      const intakes = await loadIntakes();
      const intake = intakes.find((i) => i.medication_id === medId
        && Date.parse(i.scheduled_at) === scheduledAtMs);
      if (intake && intake.status === 'PENDING') {
        await putIntake({
          ...intake, clientTs: nowMs, status: 'TAKEN', taken_at: nowIso,
        });
        await adjustInventory(medId, -1);
      }
    }

    const medSet = new Set(medicationIds);
    const intakesAfter = await loadIntakes();
    for (const intake of intakesAfter) {
      if (intake.status === 'TAKEN'
        && Date.parse(intake.scheduled_at) === scheduledAtMs
        && !medSet.has(intake.medication_id)) {
        await putIntake({
          ...intake, clientTs: nowMs, status: 'PENDING', taken_at: null,
        });
        await adjustInventory(intake.medication_id, 1);
      }
    }

    return { status: 'confirmed' };
  }

  // Ported from handleCancelIntake: TAKEN -> PENDING, increment inventory.
  async function cancelIntakes(intakeIds) {
    const nowMs = now();
    let cancelledCount = 0;
    for (const id of intakeIds) {
      const intake = await getIntake(id);
      if (!intake || intake.status !== 'TAKEN') continue;
      await putIntake({
        ...intake, clientTs: nowMs, status: 'PENDING', taken_at: null,
      });
      await adjustInventory(intake.medication_id, 1);
      cancelledCount++;
    }
    return { status: 'cancelled', cancelled_count: cancelledCount, requested_count: intakeIds.length };
  }

  // Ported from handleDeleteFutureIntake: only a PENDING intake scheduled
  // strictly in the future can be hard-deleted; past history is preserved.
  async function deleteFutureIntakes(intakeIds) {
    const nowMs = now();
    let deletedCount = 0;
    for (const id of intakeIds) {
      const intake = await getIntake(id);
      if (!intake || intake.status !== 'PENDING' || Date.parse(intake.scheduled_at) <= nowMs) continue;
      await records.del(INTAKE_RECORD_TYPE, id);
      deletedCount++;
    }
    return { status: 'deleted', deleted_count: deletedCount, requested_count: intakeIds.length };
  }

  // Ported from handleTriggerNextIntake: pick the earliest not-yet-handled
  // dose cluster (±10min) in the next 12h and confirm-or-create each member.
  // planDosesWithTzPlan unions in an APPROVED plan's own steps and suppresses
  // affected meds' normal targets (Task 4).
  async function triggerNextIntake() {
    const meds = await loadMeds();
    const intakes = await loadIntakes();
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();
    const tzPlan = await loadActiveTzPlan();

    const targets = planDosesWithTzPlan({
      medications: meds.map(toMedScheduleShape), timeZone, now: nowMs, window: NEXT_INTAKE_FORECAST_MS, tzPlan,
    });

    let clusterEarliestMs = null;
    let cluster = [];
    for (const t of targets) {
      const existing = intakes.find((i) => i.medication_id === t.medicationId
        && Date.parse(i.scheduled_at) === t.scheduledAtMs);
      if (existing && (existing.status === 'TAKEN' || existing.status === 'SKIPPED')) continue;
      if (clusterEarliestMs === null || t.scheduledAtMs < clusterEarliestMs) {
        clusterEarliestMs = t.scheduledAtMs;
        cluster = [t];
      } else if (Math.abs(t.scheduledAtMs - clusterEarliestMs) <= CLUSTER_WINDOW_MS) {
        cluster.push(t);
      }
    }

    if (cluster.length === 0) throw notFound('No upcoming scheduled intakes found');

    const medNames = [];
    let confirmedCount = 0;

    for (const target of cluster) {
      const med = meds.find((m) => m.recordId === target.medicationId);
      if (med) medNames.push(med.name);

      const existing = intakes.find((i) => i.medication_id === target.medicationId
        && Date.parse(i.scheduled_at) === target.scheduledAtMs);

      if (existing && existing.status === 'PENDING') {
        await putIntake({
          ...existing, clientTs: nowMs, status: 'TAKEN', taken_at: nowIso,
        });
        await adjustInventory(target.medicationId, -1);
        confirmedCount++;
      } else if (!existing) {
        const record = {
          recordId: slotId(target.medicationId, target.scheduledAtMs),
          clientTs: nowMs,
          deleted: false,
          medication_id: target.medicationId,
          scheduled_at: new Date(target.scheduledAtMs).toISOString(),
          taken_at: nowIso,
          status: 'TAKEN',
          snoozed_until: null,
          source: target.source === 'tz_step' ? 'tz_step' : 'schedule',
        };
        await putIntake(record);
        intakes.push(record);
        await adjustInventory(target.medicationId, -1);
        confirmedCount++;
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

  // Ported from computeNextIntakeData: nearest not-yet-handled dose cluster
  // (±10min) in the next 12h. Returns null (204-equivalent) when none.
  async function nextIntake() {
    const meds = await loadMeds();
    const intakes = await loadIntakes();
    const nowMs = now();
    const tzPlan = await loadActiveTzPlan();

    const targets = planDosesWithTzPlan({
      medications: meds.map(toMedScheduleShape), timeZone, now: nowMs, window: NEXT_INTAKE_FORECAST_MS, tzPlan,
    });

    let nextTimeMs = null;
    let nextMeds = [];
    for (const t of targets) {
      const existing = intakes.find((i) => i.medication_id === t.medicationId
        && Date.parse(i.scheduled_at) === t.scheduledAtMs);
      if (existing && (existing.status === 'TAKEN' || existing.status === 'SKIPPED')) continue;

      const med = meds.find((m) => m.recordId === t.medicationId);
      if (!med) continue;

      if (nextTimeMs === null || t.scheduledAtMs < nextTimeMs) {
        nextTimeMs = t.scheduledAtMs;
        nextMeds = [med];
      } else if (Math.abs(t.scheduledAtMs - nextTimeMs) <= CLUSTER_WINDOW_MS) {
        nextMeds.push(med);
      }
    }

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
  async function upcomingDoses({ days = UPCOMING_FORECAST_DAYS } = {}) {
    const meds = await loadMeds();
    const intakes = await loadIntakes();
    const nowMs = now();
    const tzPlan = await loadActiveTzPlan();

    const targets = forecastDosesWithTzPlan({
      medications: meds.map(toMedScheduleShape), timeZone, now: nowMs, days, tzPlan,
    });

    const byId = new Map(meds.map((m) => [m.recordId, m]));
    const today = localDateTimeParts(nowMs, timeZone);
    const todayUtc = Date.UTC(today.year, today.month - 1, today.day);

    const out = [];
    for (const t of targets) {
      const med = byId.get(t.medicationId);
      if (!med) continue;
      // Same already-handled filter as nextIntake: a confirmed or skipped slot
      // is not "upcoming" any more.
      const existing = intakes.find((i) => i.medication_id === t.medicationId
        && Date.parse(i.scheduled_at) === t.scheduledAtMs);
      if (existing && (existing.status === 'TAKEN' || existing.status === 'SKIPPED')) continue;

      const p = localDateTimeParts(t.scheduledAtMs, timeZone);
      const row = {
        medication_id: t.medicationId,
        med_name: med.name,
        dosage: med.dosage || '',
        scheduled_at: new Date(t.scheduledAtMs).toISOString(),
        local_date: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`,
        local_time: `${pad2(p.hour)}:${pad2(p.minute)}`,
        day_offset: Math.round((Date.UTC(p.year, p.month - 1, p.day) - todayUtc) / DAY_MS),
        source: t.source === 'tz_step' ? 'tz_step' : 'schedule',
      };
      if (t.source === 'tz_step') {
        row.step_number = t.stepNumber;
        row.total_steps = t.totalSteps;
        if (t.note) row.note = t.note;
      }
      out.push(row);
    }
    return out;
  }

  // Ported from handleListHistory (GET /api/history?days&med_id):
  // newest-first, same row shape, capped at 100.
  async function history({ days = 3, medId = 0 } = {}) {
    const intakes = await loadIntakes();
    const nowMs = now();
    const since = days > 0 ? nowMs - days * 24 * 60 * 60 * 1000 : null;
    return intakes
      .filter((i) => (medId ? i.medication_id === medId : true))
      .filter((i) => (since === null ? true : Date.parse(i.scheduled_at) >= since))
      .sort((a, b) => Date.parse(b.scheduled_at) - Date.parse(a.scheduled_at))
      .slice(0, 100)
      .map(toResponse);
  }

  // Uncapped, windowed intake log for composite analysis — mirrors the Go
  // analyze_* handlers' fetchMedicationsSection (ListIntakesSince, uncapped,
  // then join med name/dosage). history()'s 100-row cap would undercount
  // adherence, or drop every row for a past-dated window, over a dense range;
  // this reads the full [fromMs,toMs] slice ascending with the Go row shape
  // ({medication_name, dosage, scheduled_at, status, taken_at?}), plus
  // `manual: true` on a log-past row — its scheduled_at is a fake copy of
  // taken_at (see logPast), so foldAdherence must keep it out of delay math.
  async function listWindow({ fromMs = 0, toMs = Infinity } = {}) {
    const [intakes, meds] = await Promise.all([loadIntakes(), loadMeds()]);
    const byId = new Map(meds.map((m) => [m.recordId, m]));
    return intakes
      .filter((i) => {
        const ms = Date.parse(i.scheduled_at);
        return ms >= fromMs && ms <= toMs;
      })
      .sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at))
      .map((i) => {
        const med = byId.get(i.medication_id);
        const row = {
          medication_name: med ? med.name : '',
          dosage: med ? med.dosage : '',
          scheduled_at: i.scheduled_at,
          status: i.status,
        };
        if (i.taken_at) row.taken_at = i.taken_at;
        if (typeof i.recordId === 'string' && i.recordId.startsWith(MANUAL_ID_PREFIX)) row.manual = true;
        return row;
      });
  }

  return {
    materializeDueDoses,
    confirm,
    skip,
    snooze,
    logPast,
    updateIntakes,
    confirmSchedule,
    cancelIntakes,
    deleteFutureIntakes,
    triggerNextIntake,
    nextIntake,
    upcomingDoses,
    history,
    listWindow,
  };
}
