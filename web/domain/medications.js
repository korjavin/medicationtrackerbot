// Runtime-agnostic medication CRUD + inventory domain module. Pure logic
// over an injected records port and an injected rxnorm port — no
// window/document/fetch/IndexedDB — so the same file can later run inside
// the Go server via goja (C6). Mirrors internal/store/medication/repo.go
// (Create/List/Get/Update/Delete/CreateRestock/ListRestocks/ListLowOnStock)
// and internal/server/medication_handlers.go + server.go's restock/low-stock
// handlers.
//
// Record types:
//   medication — server field names: name, dosage, schedule, supplement,
//     archived, start_date, end_date, rxcui, normalized_name,
//     inventory_count, tz_shift_policy, created_at. recordId is a
//     client-minted number (see nextId), mirroring the server's int64 id —
//     internal/domain/medplan/medplan.go's PlanDoses output sort compares
//     medicationId with numeric subtraction, and intake records (Task 3)
//     reference medication_id by this same number.
//   restock — medication_id, quantity, note, restocked_at.
//
// Intake records (owned by web/domain's Task 3 intake state machine) are
// only *read* here, to compute last_taken_at and to cancel pending intakes
// on archive — this module never writes intake status.
import { getDaysOfStockRemaining, listLowOnStock } from './medschedule.js';

const MEDICATION_RECORD_TYPE = 'medication';
const INTAKE_RECORD_TYPE = 'intake';
const RESTOCK_RECORD_TYPE = 'restock';

const VALID_TZ_POLICIES = new Set(['flexible', 'medium', 'strict']);
const DEFAULT_LOW_STOCK_THRESHOLD_DAYS = 7;

// Same technique as notes.js's nextId: stamp from the millisecond clock (time
// -ordered) plus low-order random digits for cross-device entropy, falling
// back to localMax+1 so a stalled clock or same-ms collision never reuses a
// local id. Returned as a Number (not String) so medschedule.js's
// `medicationId - medicationId` tie-break sort and the `intake-<medId>-...`
// id template both work without coercion surprises.
// ponytail: nowMs*1000 stays under Number.MAX_SAFE_INTEGER until ~year 2255.
function nextId(existing, nowMs) {
  const localMax = existing.reduce((m, r) => Math.max(m, Number(r.recordId) || 0), 0);
  const stamped = nowMs * 1000 + Math.floor(Math.random() * 1000);
  return Math.max(stamped, localMax + 1);
}

function toISOStringOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  return v;
}

// Ported from handleCreate/handleUpdateMedication's inline tz_shift_policy
// validation. Empty defaults to "flexible" (matches repo.go's Create/Update).
function normalizeTzPolicy(raw) {
  const p = raw || '';
  if (p !== '' && !VALID_TZ_POLICIES.has(p)) {
    const err = new Error('Invalid tz_shift_policy: must be one of flexible, medium, strict');
    err.code = 'invalid_tz_shift_policy';
    throw err;
  }
  return p || 'flexible';
}

// Ported from handleCreate/handleUpdateMedication's duplicate check: same
// name (case-insensitive) + same dosage, checked against ALL medications
// including archived ones.
function assertNoDuplicate(all, name, dosage, excludeId) {
  const dup = all.some((m) => !m.deleted && m.recordId !== excludeId
    && String(m.name).toLowerCase() === String(name).toLowerCase()
    && m.dosage === dosage);
  if (dup) {
    const err = new Error('Medication with this name and dosage already exists');
    err.code = 'duplicate';
    throw err;
  }
}

function lastTakenAtFor(medId, intakes) {
  let max = null;
  for (const i of intakes) {
    if (i.deleted || i.medication_id !== medId || i.status !== 'TAKEN' || !i.taken_at) continue;
    if (max === null || Date.parse(i.taken_at) > Date.parse(max)) max = i.taken_at;
  }
  return max;
}

// Ported from the Medication struct's JSON tags (repo.go:54-69) — last_taken_at
// has no omitempty (always present, null if never taken); rxcui/
// normalized_name/inventory_count do.
function toResponse(record, intakes = []) {
  const resp = {
    id: record.recordId,
    name: record.name,
    dosage: record.dosage,
    schedule: record.schedule,
    archived: !!record.archived,
    supplement: !!record.supplement,
    start_date: record.start_date ?? null,
    end_date: record.end_date ?? null,
    last_taken_at: lastTakenAtFor(record.recordId, intakes),
    created_at: record.created_at,
    tz_shift_policy: record.tz_shift_policy || 'flexible',
  };
  if (record.rxcui) resp.rxcui = record.rxcui;
  if (record.normalized_name) resp.normalized_name = record.normalized_name;
  if (record.inventory_count !== null && record.inventory_count !== undefined) {
    resp.inventory_count = record.inventory_count;
  }
  return resp;
}

function toRestockResponse(record) {
  const resp = {
    id: record.recordId,
    medication_id: record.medication_id,
    quantity: record.quantity,
    restocked_at: record.restocked_at,
  };
  if (record.note) resp.note = record.note;
  return resp;
}

function notFound(message) {
  const err = new Error(message);
  err.code = 'not_found';
  return err;
}

// createMedicationsDomain builds the medications domain API over the
// injected ports:
//   records — { list(type), put(type, record), del(type, id) }
//   now()   — current time in ms epoch
//   timeZone — IANA zone string (reserved for callers; unused directly here)
//   rxnorm  — { searchRxNorm(name) -> {rxcui, normalizedName},
//               checkInteractions(rxcuis) -> string[] } — browser impl does
//               real RxNav fetches (Task 6), tests inject a fake. Failures
//               degrade to empty results, never block a med save.
export function createMedicationsDomain({
  records, now, timeZone, rxnorm,
}) {
  const noopRxnorm = {
    async searchRxNorm() { return { rxcui: '', normalizedName: '' }; },
    async checkInteractions() { return []; },
  };
  const rx = rxnorm || noopRxnorm;

  async function searchRxNorm(name) {
    try {
      const res = await rx.searchRxNorm(name);
      return { rxcui: (res && res.rxcui) || '', normalizedName: (res && res.normalizedName) || '' };
    } catch {
      return { rxcui: '', normalizedName: '' };
    }
  }

  // Ported from handleCreate/handleUpdateMedication's interaction check:
  // only fires once >1 active medication carries an rxcui, first warning +
  // "(+N more)" suffix, exact same string format.
  async function computeWarning(rxcui) {
    if (!rxcui) return '';
    const active = await list({ archived: false });
    const rxcuis = active.filter((m) => m.rxcui).map((m) => m.rxcui);
    if (rxcuis.length <= 1) return '';
    let warnings = [];
    try {
      warnings = await rx.checkInteractions(rxcuis);
    } catch {
      warnings = [];
    }
    if (!warnings || warnings.length === 0) return '';
    let warning = warnings[0];
    if (warnings.length > 1) warning += ` (+ ${warnings.length - 1} more)`;
    return warning;
  }

  // Ported from handleUpdateMedication's archive branch: delete pending
  // intakes for the medication (client has no reminder-message cleanup to
  // mirror — that's Telegram-specific).
  async function cancelPendingIntakesForMedication(medId) {
    const intakes = await records.list(INTAKE_RECORD_TYPE);
    for (const intake of intakes) {
      if (!intake.deleted && intake.medication_id === medId && intake.status === 'PENDING') {
        await records.del(INTAKE_RECORD_TYPE, intake.recordId);
      }
    }
  }

  async function create(input) {
    const name = (input && input.name ? String(input.name) : '').trim();
    const dosage = input && input.dosage ? String(input.dosage) : '';
    const schedule = input && input.schedule ? String(input.schedule) : '';
    const tzShiftPolicy = normalizeTzPolicy(input && input.tz_shift_policy);

    const all = await records.list(MEDICATION_RECORD_TYPE);
    assertNoDuplicate(all, name, dosage, null);

    const { rxcui, normalizedName } = await searchRxNorm(name);

    const nowMs = now();
    const record = {
      recordId: nextId(all, nowMs),
      clientTs: nowMs,
      deleted: false,
      name,
      dosage,
      schedule,
      archived: false,
      supplement: !!(input && input.supplement),
      start_date: toISOStringOrNull(input && input.start_date),
      end_date: toISOStringOrNull(input && input.end_date),
      rxcui: rxcui || '',
      normalized_name: normalizedName || '',
      inventory_count: null,
      tz_shift_policy: tzShiftPolicy,
      created_at: new Date(nowMs).toISOString(),
    };
    await records.put(MEDICATION_RECORD_TYPE, record);

    const warning = await computeWarning(rxcui);
    return { id: record.recordId, status: 'created', warning };
  }

  // update mirrors handleUpdateMedication's full-replace semantics exactly,
  // including its quirks: name/dosage/schedule/archived/start_date/end_date/
  // rxcui/normalized_name/inventory_count/tz_shift_policy are all
  // unconditionally overwritten from the input (an omitted start_date/
  // end_date/inventory_count clears it; an omitted tz_shift_policy resets to
  // "flexible") — only `supplement` is preserved when the input omits it,
  // matching the server's *bool-nil guard.
  async function update(id, input) {
    const all = await records.list(MEDICATION_RECORD_TYPE);
    const existing = all.find((m) => m.recordId === id && !m.deleted);
    if (!existing) throw notFound('medication not found');

    const name = (input && input.name ? String(input.name) : '').trim();
    const dosage = input && input.dosage ? String(input.dosage) : '';
    const schedule = input && input.schedule ? String(input.schedule) : '';
    const archived = !!(input && input.archived);
    const tzShiftPolicy = normalizeTzPolicy(input && input.tz_shift_policy);

    assertNoDuplicate(all, name, dosage, id);

    const { rxcui, normalizedName } = await searchRxNorm(name);

    if (archived) {
      await cancelPendingIntakesForMedication(id);
    }

    const nowMs = now();
    const updated = {
      ...existing,
      clientTs: nowMs,
      name,
      dosage,
      schedule,
      archived,
      start_date: toISOStringOrNull(input && input.start_date),
      end_date: toISOStringOrNull(input && input.end_date),
      rxcui: rxcui || '',
      normalized_name: normalizedName || '',
      inventory_count: input && input.inventory_count !== undefined ? input.inventory_count : null,
      tz_shift_policy: tzShiftPolicy,
    };
    if (input && input.supplement !== undefined && input.supplement !== null) {
      updated.supplement = !!input.supplement;
    }
    await records.put(MEDICATION_RECORD_TYPE, updated);

    const warning = archived ? '' : await computeWarning(rxcui);
    return { status: 'updated', warning };
  }

  // remove mirrors handleDeleteMedication: only archived medications can be
  // hard-deleted, and only if no intake (of any status) references them.
  async function remove(id) {
    const all = await records.list(MEDICATION_RECORD_TYPE);
    const med = all.find((m) => m.recordId === id && !m.deleted);
    if (!med) throw notFound('medication not found');
    if (!med.archived) {
      const err = new Error('Cannot delete active medication. Archive it first.');
      err.code = 'not_archived';
      throw err;
    }

    const intakes = await records.list(INTAKE_RECORD_TYPE);
    const hasHistory = intakes.some((i) => !i.deleted && i.medication_id === id);
    if (hasHistory) {
      const err = new Error('Cannot delete medication with intake history');
      err.code = 'has_intake_history';
      throw err;
    }

    await records.del(MEDICATION_RECORD_TYPE, id);
  }

  // list mirrors handleList's `?archived=true` query flag and
  // repo.go's List's `ORDER BY m.name ASC` (binary/ordinal, not locale-aware).
  async function list({ archived = false } = {}) {
    const all = await records.list(MEDICATION_RECORD_TYPE);
    const intakes = await records.list(INTAKE_RECORD_TYPE);
    return all
      .filter((m) => !m.deleted && (archived || !m.archived))
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((m) => toResponse(m, intakes));
  }

  async function get(id) {
    const all = await records.list(MEDICATION_RECORD_TYPE);
    const med = all.find((m) => m.recordId === id && !m.deleted);
    if (!med) return null;
    const intakes = await records.list(INTAKE_RECORD_TYPE);
    return toResponse(med, intakes);
  }

  // restock mirrors handleRestock + repo.go's CreateRestock: adds to
  // inventory_count (COALESCE-to-0, so it starts tracking even if untracked
  // before) and logs a restock row.
  async function restock(medId, quantity, note) {
    if (!(quantity > 0)) {
      const err = new Error('Quantity must be positive');
      err.code = 'invalid_quantity';
      throw err;
    }
    const all = await records.list(MEDICATION_RECORD_TYPE);
    const med = all.find((m) => m.recordId === medId && !m.deleted);
    if (!med) throw notFound('medication not found');

    const nowMs = now();
    const newCount = (med.inventory_count || 0) + quantity;
    await records.put(MEDICATION_RECORD_TYPE, { ...med, clientTs: nowMs, inventory_count: newCount });

    const restockAll = await records.list(RESTOCK_RECORD_TYPE);
    await records.put(RESTOCK_RECORD_TYPE, {
      recordId: nextId(restockAll, nowMs),
      clientTs: nowMs,
      deleted: false,
      medication_id: medId,
      quantity,
      note: note || '',
      restocked_at: new Date(nowMs).toISOString(),
    });

    return { status: 'restocked', quantity_added: quantity, inventory_count: newCount };
  }

  // listRestocks mirrors handleListRestocks: newest-first for one medication.
  async function listRestocks(medId) {
    const all = await records.list(RESTOCK_RECORD_TYPE);
    return all
      .filter((r) => !r.deleted && r.medication_id === medId)
      .sort((a, b) => Date.parse(b.restocked_at) - Date.parse(a.restocked_at))
      .map(toRestockResponse);
  }

  // listLowStock mirrors handleGetLowStock: ListLowOnStock + days_remaining
  // enrichment, both ported to medschedule.js.
  async function listLowStock(daysThreshold = DEFAULT_LOW_STOCK_THRESHOLD_DAYS) {
    const all = await records.list(MEDICATION_RECORD_TYPE);
    const intakes = await records.list(INTAKE_RECORD_TYPE);
    const meds = all.filter((m) => !m.deleted);
    const nowMs = now();
    const low = listLowOnStock(meds, nowMs, daysThreshold);
    return low.map((m) => {
      const resp = toResponse(m, intakes);
      const daysRemaining = getDaysOfStockRemaining(m);
      if (daysRemaining !== null && daysRemaining !== undefined) resp.days_remaining = daysRemaining;
      return resp;
    });
  }

  return {
    create, update, remove, list, get, restock, listRestocks, listLowStock,
  };
}
