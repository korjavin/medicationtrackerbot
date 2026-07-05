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
import { minDoseIntervalMs } from './medschedule.js';
import { planDosesWithTzPlan } from './tzplan.js';

const MEDICATION_RECORD_TYPE = 'medication';
const INTAKE_RECORD_TYPE = 'intake';
const TZPLAN_RECORD_TYPE = 'tzplan';
const TZPLAN_RECORD_ID = 'tzplan-current';

const NEXT_INTAKE_FORECAST_MS = 12 * 60 * 60 * 1000;
const CLUSTER_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_SNOOZE_MINUTES = 10;

function slotId(medId, scheduledAtMs) {
  return `intake-${medId}-${Math.floor(scheduledAtMs / 1000)}`;
}

// ponytail: nowMs*1e6 stays under Number.MAX_SAFE_INTEGER until ~year 2255,
// same margin medications.js's nextId relies on.
function genManualId(nowMs) {
  return `intake-manual-${nowMs}-${Math.floor(Math.random() * 1e6)}`;
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
        clientTs: nowMs,
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
    history,
  };
}
