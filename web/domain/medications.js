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
//   restock — medication_id, quantity, note, restocked_at. Written by older
//     clients only; still counted as refills (stock.js).
//   stock — the stock ledger (stock.js, bd med-wi09.13). A med's stock is
//     derived from it; inventory_count on the record is a mirror for older
//     clients (null = untracked) and pack_size an optional pack size.
//
// Intake records (owned by web/domain's Task 3 intake state machine) are
// only *read* here, to compute last_taken_at and to cancel pending intakes
// on archive — this module never writes intake status.
import { getDaysOfStockRemaining, listLowOnStock, historyRecordId } from './medschedule.js';
import { boundary } from './lineage.js';
import {
  createStockDomain, deriveStock, withDerivedStock, STOCK_RECORD_TYPE,
} from './stock.js';

const MEDICATION_RECORD_TYPE = 'medication';
const INTAKE_RECORD_TYPE = 'intake';
// History (bd med-wi09.9): one immutable medsched-<medId>-<fromSec>-<rand> per
// schedule/policy change — medication_id, schedule, tz_shift_policy, from
// (ISO). The generation a med was created with lives at the `base` suffix
// (from = created_at): written on create, and backfilled at the clientTs floor
// on the first edit of a med that predates history (CLAUDE.md rule 12), so
// the edit's old generation is never lost. An edit row also carries
// `boundary` (lineage.js, bd med-wi09.10): the old→new slot lineage decided
// at the edit; the base row has none.
export const MEDSCHED_RECORD_TYPE = 'medsched';

function medschedRecord(medId, { schedule, tz_shift_policy: policy }, fromIso, clientTs, suffix, lineage) {
  const fromMs = Date.parse(fromIso);
  return {
    ...(lineage ? { boundary: lineage } : {}),
    recordId: historyRecordId(`${MEDSCHED_RECORD_TYPE}-${medId}`, Number.isFinite(fromMs) ? fromMs : 0, suffix),
    clientTs,
    deleted: false,
    medication_id: medId,
    schedule: schedule || '',
    tz_shift_policy: policy || 'flexible',
    from: Number.isFinite(fromMs) ? fromIso : new Date(0).toISOString(),
  };
}

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
    if (i.deleted || String(i.medication_id) !== String(medId) || i.status !== 'TAKEN' || !i.taken_at) continue;
    if (max === null || Date.parse(i.taken_at) > Date.parse(max)) max = i.taken_at;
  }
  return max;
}

// Ported from the Medication struct's JSON tags (repo.go:54-69) — last_taken_at
// has no omitempty (always present, null if never taken); rxcui/
// normalized_name/inventory_count do. inventory_count is the DERIVED stock
// (stock.js), never the record's mirror; `stock` carries the ledger behind it
// for the Update stock sheet (ST3): the starting count and when, refills since
// (newest first), doses taken since.
function toResponse(record, intakes = [], sources = null) {
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
  if (record.pack_size) resp.pack_size = record.pack_size;
  const s = deriveStock(record, sources || { intakes });
  if (s) {
    resp.inventory_count = s.count;
    resp.stock = s.audit
      ? { counted: s.audit.count, counted_at: s.audit.at, seed: s.audit.seed, refills: s.refills, taken: s.taken }
      : { counted: s.count, counted_at: null, seed: true, refills: [], taken: 0 };
  }
  return resp;
}

// An optional positive whole pack size, else null.
function normalizePackSize(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
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
  const stock = createStockDomain({ records, now });

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
    return warningFor(active.filter((m) => m.rxcui).map((m) => m.rxcui));
  }

  // rxCheck backs the editor's Rx chip + inline interaction warning: the same
  // match and warning create/update compute after the write, answered before
  // Save against the other active meds. Legacy supplied rxcui parameters
  // are not identity proof: always recheck the current name through the port.
  async function rxCheck({ name = '', excludeId = 0 } = {}) {
    const term = String(name || '').trim();
    const match = term ? await searchRxNorm(term) : { rxcui: '', normalizedName: '' };
    if (!match.rxcui) return { rxcui: '', normalized_name: '', warning: '' };
    const others = (await list({ archived: false })).filter((m) => m.id !== excludeId && m.rxcui);
    const warning = await warningFor([...others.map((m) => m.rxcui), match.rxcui]);
    return { rxcui: match.rxcui, normalized_name: match.normalizedName, warning };
  }

  async function warningFor(rxcuis) {
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
      if (!intake.deleted && String(intake.medication_id) === String(medId)
        && (intake.status === 'PENDING' || intake.status === 'UNTAKEN')) {
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
    const startCount = input && input.inventory_count !== undefined && input.inventory_count !== null
      ? Number(input.inventory_count) : null;
    if (startCount !== null && !(Number.isInteger(startCount) && startCount >= 0)) {
      throw Object.assign(new Error('inventory_count must be a whole number, 0 or more'), { code: 'invalid_count' });
    }

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
      inventory_count: startCount,
      pack_size: normalizePackSize(input && input.pack_size),
      tz_shift_policy: tzShiftPolicy,
      created_at: new Date(nowMs).toISOString(),
    };
    await records.put(MEDICATION_RECORD_TYPE, record);
    // Starting stock is the med's first count.
    if (record.inventory_count !== null) await stock.audit(record.recordId, record.inventory_count);
    await records.put(MEDSCHED_RECORD_TYPE, medschedRecord(record.recordId, record, record.created_at, nowMs, 'base'));

    const warning = await computeWarning(rxcui);
    return { id: record.recordId, status: 'created', warning };
  }

  // update mirrors handleUpdateMedication's full-replace semantics exactly,
  // including its quirks: name/dosage/schedule/archived/start_date/end_date/
  // rxcui/normalized_name/tz_shift_policy are all unconditionally overwritten
  // from the input (an omitted start_date/end_date clears it; an omitted
  // tz_shift_policy resets to "flexible") — only `supplement` and `pack_size`
  // are preserved when the input omits them.
  // inventory_count is tracking, not a count (bd med-wi09.13): null/omitted
  // stops tracking; a number on an untracked med starts it at that count (an
  // audit); on a tracked med the number is ignored — the stock moves only
  // through the ledger (restock / stock-audit), so an editor that read the
  // count before a dose landed cannot set it back.
  async function update(id, input) {
    const all = await records.list(MEDICATION_RECORD_TYPE);
    const existing = all.find((m) => String(m.recordId) === String(id) && !m.deleted);
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
      tz_shift_policy: tzShiftPolicy,
    };
    const wantCount = input && input.inventory_count !== undefined && input.inventory_count !== null
      ? Number(input.inventory_count) : null;
    const wasTracked = existing.inventory_count !== null && existing.inventory_count !== undefined;
    const startTracking = wantCount !== null && !wasTracked;
    if (wantCount === null) updated.inventory_count = null;
    else if (startTracking) {
      if (!Number.isInteger(wantCount) || wantCount < 0) {
        throw Object.assign(new Error('inventory_count must be a whole number, 0 or more'), { code: 'invalid_count' });
      }
      updated.inventory_count = wantCount;
    }
    if (input && input.supplement !== undefined && input.supplement !== null) {
      updated.supplement = !!input.supplement;
    }
    if (input && input.pack_size !== undefined) updated.pack_size = normalizePackSize(input.pack_size);
    await records.put(MEDICATION_RECORD_TYPE, updated);
    if (startTracking) await stock.audit(existing.recordId, wantCount);
    if ((existing.schedule || '') !== schedule || (existing.tz_shift_policy || 'flexible') !== tzShiftPolicy) {
      // Floored backfill of the pre-history generation (no-op when the base
      // row already exists), then the edit itself at a real stamp.
      await records.putIfAbsent(MEDSCHED_RECORD_TYPE, medschedRecord(existing.recordId, existing, existing.created_at, 0, 'base'));
      const evidence = records.listRaw ? await records.listRaw(INTAKE_RECORD_TYPE) : await records.list(INTAKE_RECORD_TYPE);
      const lineage = boundary({
        oldGen: { timeZone, medications: [existing] }, newGen: { timeZone, medications: [updated] }, switchAt: nowMs, evidence,
      });
      await records.put(MEDSCHED_RECORD_TYPE, medschedRecord(existing.recordId, updated, new Date(nowMs).toISOString(), nowMs, undefined, lineage));
    }
    if (archived !== !!existing.archived) {
      // The archive flip is history too (bd med-wi09.12): doses are derived,
      // so this row — not a tombstone per stored dose — is what cancels the
      // open ones and keeps the archived days empty (lineage.js regenerate).
      // Un-archiving a med archived before these rows existed first records
      // that archive, at the med's last write.
      const own = (await records.list(MEDSCHED_RECORD_TYPE)).filter((h) => String(h.medication_id) === String(existing.recordId));
      if (!archived && !own.some((h) => h.archived === true)) {
        const atMs = Number.isFinite(existing.clientTs) && existing.clientTs > 0 ? Math.min(existing.clientTs, nowMs - 1) : 0;
        await records.put(MEDSCHED_RECORD_TYPE, { ...medschedRecord(existing.recordId, existing, new Date(atMs).toISOString(), nowMs, undefined), archived: true });
      }
      await records.put(MEDSCHED_RECORD_TYPE, { ...medschedRecord(existing.recordId, updated, new Date(nowMs).toISOString(), nowMs, undefined), archived });
    }

    const warning = archived ? '' : await computeWarning(rxcui);
    return { status: 'updated', warning };
  }

  // remove mirrors handleDeleteMedication: only archived medications can be
  // hard-deleted, and only if no intake (of any status) references them.
  async function remove(id) {
    const all = await records.list(MEDICATION_RECORD_TYPE);
    const med = all.find((m) => String(m.recordId) === String(id) && !m.deleted);
    if (!med) throw notFound('medication not found');
    if (!med.archived) {
      const err = new Error('Cannot delete active medication. Archive it first.');
      err.code = 'not_archived';
      throw err;
    }

    const intakes = await records.list(INTAKE_RECORD_TYPE);
    const hasHistory = intakes.some((i) => !i.deleted && String(i.medication_id) === String(id));
    if (hasHistory) {
      const err = new Error('Cannot delete medication with intake history');
      err.code = 'has_intake_history';
      throw err;
    }

    await records.del(MEDICATION_RECORD_TYPE, id);
    // Its schedule history goes with it: nothing dangles in an export.
    for (const type of [MEDSCHED_RECORD_TYPE, STOCK_RECORD_TYPE]) {
      for (const h of await records.list(type)) {
        if (!h.deleted && String(h.medication_id) === String(id)) await records.del(type, h.recordId);
      }
    }
  }

  // list mirrors handleList's `?archived=true` query flag and
  // repo.go's List's `ORDER BY m.name ASC` (binary/ordinal, not locale-aware).
  async function list({ archived = false } = {}) {
    const all = await records.list(MEDICATION_RECORD_TYPE);
    const src = await stock.sources();
    return all
      .filter((m) => !m.deleted && (archived || !m.archived))
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((m) => toResponse(m, src.intakes, src));
  }

  async function get(id) {
    const all = await records.list(MEDICATION_RECORD_TYPE);
    const med = all.find((m) => String(m.recordId) === String(id) && !m.deleted);
    if (!med) return null;
    const src = await stock.sources();
    return toResponse(med, src.intakes, src);
  }

  // POST /restock — a refill row in the stock ledger (stock.js). An untracked
  // med starts tracking at that amount, like the old COALESCE-to-0 restock.
  async function restock(medId, quantity, note) {
    return stock.refill(medId, quantity, note);
  }

  // POST /stock-audit — a count: the new starting point for the stock.
  async function stockAudit(medId, count) {
    return stock.audit(medId, count);
  }

  // listRestocks mirrors handleListRestocks: newest-first for one medication —
  // the ledger's refills plus older clients' restock rows, in the restock shape.
  async function listRestocks(medId) {
    const { stock: rows, restocks } = await stock.sources();
    const refills = rows
      .filter((r) => !r.deleted && r.kind === 'refill' && String(r.medication_id) === String(medId))
      .map((r) => ({
        recordId: r.recordId, medication_id: r.medication_id, quantity: r.n, note: r.note, restocked_at: r.at,
      }));
    return restocks
      .filter((r) => !r.deleted && String(r.medication_id) === String(medId))
      .concat(refills)
      .sort((a, b) => Date.parse(b.restocked_at) - Date.parse(a.restocked_at))
      .map(toRestockResponse);
  }

  // listLowStock mirrors handleGetLowStock: ListLowOnStock + days_remaining
  // enrichment, both ported to medschedule.js.
  async function listLowStock(daysThreshold = DEFAULT_LOW_STOCK_THRESHOLD_DAYS) {
    const all = await records.list(MEDICATION_RECORD_TYPE);
    const src = await stock.sources();
    const meds = withDerivedStock(all.filter((m) => !m.deleted), src);
    const nowMs = now();
    const low = listLowOnStock(meds, nowMs, daysThreshold);
    const byId = new Map(all.map((m) => [String(m.recordId), m]));
    return low.map((m) => {
      const resp = toResponse(byId.get(String(m.recordId)), src.intakes, src);
      const daysRemaining = getDaysOfStockRemaining(m);
      if (daysRemaining !== null && daysRemaining !== undefined) resp.days_remaining = daysRemaining;
      return resp;
    });
  }

  return {
    create, update, remove, list, get, restock, stockAudit, listRestocks, listLowStock, rxCheck,
  };
}
