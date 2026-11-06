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
  if (validEma(record.ema)) {
    resp.ema = Object.fromEntries(EMA_FIELDS.map((f) => [f, record.ema[f]]));
  }
  const s = deriveStock(record, sources || { intakes });
  if (s) {
    resp.inventory_count = s.count;
    resp.stock = s.audit
      ? { counted: s.audit.count, counted_at: s.audit.at, seed: s.audit.seed, refills: s.refills, taken: s.taken }
      : { counted: s.count, counted_at: null, seed: true, refills: [], taken: 0 };
  }
  return resp;
}

// The saved EU register reference (bd med-3u28.10): medication.ema =
// { for_name, substances, revision, data_date, sha256 }. for_name is the
// medication name it was saved for; substances the picked card's substance
// text as the register writes it; the triple is the register's source at
// save time. A dated reference, never revalidated and never proof of the
// product. Readers use it only when it validates (a malformed or foreign
// row is ignored, kept on the row, never thrown on) and only while
// for_name equals the row's name.
const EMA_FIELDS = ['for_name', 'substances', 'revision', 'data_date', 'sha256'];

export function validEma(ema) {
  return !!ema && typeof ema === 'object' && !Array.isArray(ema)
    && EMA_FIELDS.every((f) => typeof ema[f] === 'string' && ema[f].trim() !== '')
    && /^[a-f0-9]{64}$/.test(ema.sha256);
}

// One entry per substance text as the register writes it (the card the
// editor shows and "Use this" picks): its routes with every country
// (alphabetical); "|" separates distinct products (kit ER9). `substances`
// is the exact key a pick sends back.
export function groupEmaCandidates(candidates) {
  const bySubstance = new Map();
  for (const c of candidates || []) {
    if (!bySubstance.has(c.substances)) bySubstance.set(c.substances, { rows: 0, routes: new Map() });
    const entry = bySubstance.get(c.substances);
    entry.rows++;
    if (!entry.routes.has(c.route)) entry.routes.set(c.route, new Set());
    entry.routes.get(c.route).add(c.jurisdiction);
  }
  return [...bySubstance].map(([substances, entry]) => ({
    substances,
    products: substances.split('|').map((s) => s.trim()).filter(Boolean),
    rows: entry.rows,
    routes: [...entry.routes].map(([route, countries]) => ({ route, countries: [...countries].sort((a, b) => a.localeCompare(b)) }))
      .sort((a, b) => b.countries.length - a.countries.length || a.route.localeCompare(b.route)),
  })).sort((a, b) => b.rows - a.rows || a.products.join(' + ').localeCompare(b.products.join(' + ')));
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
//               real RxNav fetches (Task 6), tests inject a fake. searchRxNorm
//               resolves null when no lookup was performed (failed, or EU
//               register picked) and {rxcui:''} when it ran with no match.
//               Failures never block a med save.
//   ema     — { register({ start }) -> { status: 'off'|'loading'|'ready'|'unavailable',
//               catalogue?, progress? } } — the on-device EU register
//               (web/cloud/js/ema.js, bd med-3u28.2); 'off' unless the EU
//               register is picked. create/update only poll it (start:
//               false) to fill or apply a saved reference (emaFor).
export function createMedicationsDomain({
  records, now, timeZone, rxnorm, ema,
}) {
  const noopRxnorm = {
    async searchRxNorm() { return null; },
    async checkInteractions() { return []; },
  };
  const rx = rxnorm || noopRxnorm;
  const eu = ema || { async register() { return { status: 'off' }; } };
  const stock = createStockDomain({ records, now });

  // performed: false when no lookup ran (no port, EU register picked: the
  // port resolves null) or it failed (throws, or null on timeout/non-2xx/
  // malformed). A lookup that ran and matched nothing is performed.
  async function searchRxNorm(name) {
    try {
      const res = await rx.searchRxNorm(name);
      if (!res) return { rxcui: '', normalizedName: '', performed: false };
      return { rxcui: res.rxcui || '', normalizedName: res.normalizedName || '', performed: true };
    } catch {
      return { rxcui: '', normalizedName: '', performed: false };
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

  // emaCheck backs the editor's EU chip (bd med-3u28.2): an exact,
  // case-insensitive name match over every jurisdiction of the register.
  // While the register downloads it answers 'loading' with the progress so
  // far; the caller asks again with poll set, which only reads where the
  // load is, so a failed load stays 'unavailable' until a new check retries.
  async function emaCheck({ name = '', poll = false } = {}) {
    let reg;
    try { reg = await eu.register({ start: !poll }); } catch { reg = { status: 'unavailable' }; }
    if (!reg || reg.status !== 'ready') {
      const status = (reg && reg.status) || 'unavailable';
      const res = { status, candidates: [], ambiguous: false, source: null };
      if (status === 'loading') res.progress = typeof reg.progress === 'number' ? reg.progress : null;
      return res;
    }
    const match = reg.catalogue.exact(String(name || '').trim());
    return {
      status: 'ready', candidates: match.candidates, ambiguous: match.ambiguous, source: match.source,
      groups: groupEmaCandidates(match.candidates),
    };
  }

  // The saved EU register reference a Save writes (bd med-3u28.10). A saved
  // reference for this name is never revalidated: it keeps its own triple
  // whatever the register says now, ready or not, unless this Save carries
  // a selection (`selection`, the card key the editor's "Use this" sent).
  // The register is polled, never loaded (start: false: a Save never waits),
  // and consulted only to fill an absent reference (exactly one card) or to
  // apply a selection; a selection naming no card keeps what was there. US
  // register ('off'), not ready, several cards or none: what was there for
  // this name, else absent. A rename drops it (for_name is the old name).
  async function emaFor(existing, name, selection) {
    const prior = existing && existing.ema && existing.ema.for_name === name ? existing.ema : undefined;
    const pick = typeof selection === 'string' ? selection : '';
    if (!pick && validEma(prior)) return prior;
    let reg;
    try { reg = await eu.register({ start: false }); } catch { reg = null; }
    if (!name || !reg || reg.status !== 'ready') return prior;
    const groups = groupEmaCandidates(reg.catalogue.exact(name).candidates);
    const group = pick ? groups.find((g) => g.substances === pick) : (groups.length === 1 ? groups[0] : null);
    if (!group) return prior;
    const { revision, data_date: dataDate, sha256 } = reg.catalogue.source;
    return { for_name: name, substances: group.substances, revision, data_date: dataDate, sha256 };
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
    const ema = await emaFor(null, name, input && input.ema_substances);

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
    if (ema) record.ema = ema;
    await records.put(MEDICATION_RECORD_TYPE, record);
    // Starting stock is the med's first count.
    if (record.inventory_count !== null) await stock.audit(record.recordId, record.inventory_count);
    await records.put(MEDSCHED_RECORD_TYPE, medschedRecord(record.recordId, record, record.created_at, nowMs, 'base'));

    const warning = await computeWarning(rxcui);
    return { id: record.recordId, status: 'created', warning };
  }

  // update mirrors handleUpdateMedication's full-replace semantics exactly,
  // including its quirks: name/dosage/schedule/archived/start_date/end_date/
  // tz_shift_policy are all unconditionally overwritten (rxcui/normalized_name
  // too, except that an unchanged name keeps them when no lookup ran)
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

    const { rxcui, normalizedName, performed } = await searchRxNorm(name);
    const ema = await emaFor(existing, name, input && input.ema_substances);

    if (archived) {
      await cancelPendingIntakesForMedication(id);
    }

    // An unchanged name keeps its saved US match only when no lookup ran (EU
    // register picked, no port) or it failed. A lookup that ran and found no
    // unique exact match clears it, so a wrong legacy approximate match heals
    // on an ordinary Save (5382c9aca); a changed name always takes the result
    // (bd med-3u28.2 ruling R1).
    const keepMatch = !performed && name.toLowerCase() === String(existing.name || '').trim().toLowerCase();

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
      rxcui: keepMatch ? (existing.rxcui || '') : rxcui || '',
      normalized_name: keepMatch ? (existing.normalized_name || '') : normalizedName || '',
      tz_shift_policy: tzShiftPolicy,
    };
    if (ema) updated.ema = ema;
    else delete updated.ema;
    const wantCount =input && input.inventory_count !== undefined && input.inventory_count !== null
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
    create, update, remove, list, get, restock, stockAudit, listRestocks, listLowStock, rxCheck, emaCheck,
  };
}
