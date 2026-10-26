// Stock ledger (bd med-wi09.13, epic med-wi09 Phase 3). Pure: an injected
// records port and clock, no browser globals.
//
// Stock is no longer one number overwritten in place (a second read-modify-
// write on the medication record that lost or doubled movements when two
// devices confirmed or refilled at once). It is derived:
//
//   current = the last audit's count + refills after it − TAKEN intakes whose
//             taken_at is after it (manual logs included)
//
// Record type `stock`, id `stock-<medId>-<ms>-<rand>`, body
//   { medication_id, kind: 'refill', n, at, note? }  — pills added
//   { medication_id, kind: 'audit', count, at }      — pills counted
// Every movement is its own row, so concurrent refills both count and a dose
// moves stock by being TAKEN evidence, not by a write here. A dose whose
// taken_at moves from after an audit to before it stops counting (the count
// already saw it), and the other way round.
//
// Old clients' `restock` rows (medication_id, quantity, restocked_at) count as
// refills too, so a refill from a tab that predates the ledger is not lost.
//
// SEED. A med tracked before the ledger has no audit. The first stock-moving
// write on this client seeds one from the old inventory_count, before that
// write lands: an audit (`seed: true`) whose window has no start — its count
// is the old number back-projected over the evidence this device holds
// (inventory_count + TAKEN − refills, all time), so the derived number equals
// the old one at the seed, and every dose before it still moves stock when it
// is undone or edited, as it did before the ledger. A device that had not seen
// some doses or refills (offline at the upgrade) held a number missing exactly
// those, and gets them back from the evidence once it syncs. `at` is only the
// seeding instant (shown as the starting point in the history).
// A derived write (CLAUDE.md rule 12): putIfAbsent at clientTs 0 into an id
// that names its whole body (`stock-<medId>-<ms>-seed<count>`), so two devices
// that seed differently write two rows rather than two bodies at one id. A
// real audit always beats a seed; among seeds the earliest wins.
//
// medication.inventory_count is now a write-only MIRROR for older clients,
// rewritten after every local stock-moving write. New code reads only whether
// it is null (untracked — the tracking flag old clients set too), and its
// value only to seed, or to show before a med is seeded.

export const STOCK_RECORD_TYPE = 'stock';
const RESTOCK_RECORD_TYPE = 'restock';
const MEDICATION_RECORD_TYPE = 'medication';
const INTAKE_RECORD_TYPE = 'intake';

const isTracked = (med) => !!med && med.inventory_count !== null && med.inventory_count !== undefined;
const sameId = (a, b) => String(a) === String(b);

export function stockRecordId(medId, atMs, suffix) {
  const tail = suffix || Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `stock-${medId}-${atMs}-${tail}`;
}

// The audit the count starts from: the latest real audit, else the earliest
// seed. Ties on the instant break by recordId so every device picks the same.
function startingAudit(rows) {
  let best = null;
  for (const r of rows) {
    if (r.kind !== 'audit') continue;
    const atMs = Date.parse(r.at);
    if (!Number.isFinite(atMs)) continue;
    const c = { row: r, atMs, seed: !!r.seed };
    if (!best) { best = c; continue; }
    if (best.seed !== c.seed) { if (best.seed) best = c; continue; }
    const later = c.atMs > best.atMs || (c.atMs === best.atMs && String(c.row.recordId) > String(best.row.recordId));
    if (c.seed ? !later : later) best = c;
  }
  return best;
}

// This med's movements: refills (ledger + legacy restocks, newest first) and
// TAKEN instants.
function movements(medId, { stock = [], restocks = [], intakes = [] }) {
  const mine = (r) => r && !r.deleted && sameId(r.medication_id, medId);
  const rows = stock.filter(mine);
  const refills = [];
  for (const r of rows) if (r.kind === 'refill') refills.push({ n: Number(r.n) || 0, at: r.at, ms: Date.parse(r.at) });
  for (const r of restocks) {
    if (mine(r)) refills.push({ n: Number(r.quantity) || 0, at: r.restocked_at, ms: Date.parse(r.restocked_at) });
  }
  refills.sort((a, b) => b.ms - a.ms);
  const taken = [];
  for (const i of intakes) if (mine(i) && i.status === 'TAKEN') taken.push(Date.parse(i.taken_at));
  return { rows, refills, taken };
}

const sumN = (list) => list.reduce((s, f) => s + f.n, 0);

// deriveStock(med, { stock, restocks, intakes }) → null for an untracked med,
// else { count, audit: {count, at, seed} | null, refills: [{n, at}], taken }:
// the starting point, what moved after it, and the result. For a seed the
// starting point is its value at the seeding instant.
export function deriveStock(med, sources = {}) {
  if (!isTracked(med)) return null;
  const { rows, refills, taken } = movements(med.recordId ?? med.id, sources);
  const start = startingAudit(rows);
  if (!start) return { count: med.inventory_count, audit: null, refills: [], taken: 0 };
  const base = Number(start.row.count) || 0;
  const after = refills.filter((f) => f.ms > start.atMs);
  const takenAfter = taken.filter((t) => t > start.atMs).length;
  // A seed counts every movement; its starting point is the stock at `at`.
  const count = start.seed
    ? base + sumN(refills) - taken.length
    : base + sumN(after) - takenAfter;
  return {
    count,
    audit: { count: count - sumN(after) + takenAfter, at: start.row.at, seed: start.seed },
    refills: after.map(({ n, at }) => ({ n, at })),
    taken: takenAfter,
  };
}

// The medication records with inventory_count replaced by the derived count —
// what every low-stock reader (medschedule.js) takes as its input.
export function withDerivedStock(meds, sources) {
  return meds.map((m) => {
    const s = deriveStock(m, sources);
    return s ? { ...m, inventory_count: s.count } : m;
  });
}

function bad(message, code) {
  return Object.assign(new Error(message), { code });
}

// createStockDomain over the injected ports:
//   records — { list(type), put(type, record), putIfAbsent(type, record) }
//   now()   — current time in ms epoch
export function createStockDomain({ records, now }) {
  async function sources() {
    const [stock, restocks, intakes] = await Promise.all([
      records.list(STOCK_RECORD_TYPE), records.list(RESTOCK_RECORD_TYPE), records.list(INTAKE_RECORD_TYPE),
    ]);
    return { stock, restocks, intakes };
  }

  async function findMed(medId) {
    const meds = await records.list(MEDICATION_RECORD_TYPE);
    return meds.find((m) => !m.deleted && sameId(m.recordId, medId)) || null;
  }

  // Seed a tracked med that has no audit yet (see SEED above). Runs before the
  // stock-moving write lands, while inventory_count and the evidence agree.
  // A med with any audit (the common case after its first write) is decided
  // from the small stock list alone; only the one-time seed reads intakes.
  async function ensureSeed(medId) {
    const med = await findMed(medId);
    if (!isTracked(med)) return;
    const stock = await records.list(STOCK_RECORD_TYPE);
    if (stock.some((r) => !r.deleted && r.kind === 'audit' && sameId(r.medication_id, med.recordId))) return;
    const src = await sources();
    const { rows, refills, taken } = movements(med.recordId, src);
    if (rows.some((r) => r.kind === 'audit')) return;
    const atMs = now();
    const count = Number(med.inventory_count) + taken.length - sumN(refills);
    await records.putIfAbsent(STOCK_RECORD_TYPE, {
      recordId: stockRecordId(med.recordId, atMs, `seed${count}`),
      clientTs: 0,
      deleted: false,
      medication_id: med.recordId,
      kind: 'audit',
      count,
      at: new Date(atMs).toISOString(),
      seed: true,
    });
  }

  // Rewrite the mirror from the derived count; returns that count (null when
  // untracked). `track` starts tracking an untracked med (its audit was just
  // written).
  async function mirror(medId, { track = false } = {}) {
    const med = await findMed(medId);
    if (!med || (!isTracked(med) && !track)) return null;
    return mirrorOne(med, await sources(), track);
  }

  async function mirrorOne(med, src, track) {
    const s = deriveStock(isTracked(med) ? med : { ...med, inventory_count: 0 }, src);
    if (med.inventory_count !== s.count) {
      await records.put(MEDICATION_RECORD_TYPE, { ...med, clientTs: now(), inventory_count: s.count });
    }
    return s.count;
  }

  // One mirror pass for every med a batch of dose writes touched: a single
  // read of the evidence however many doses (a cluster confirm, a bulk act).
  async function mirrorMany(medIds) {
    const ids = new Set([...medIds].map(String));
    if (ids.size === 0) return;
    const meds = (await records.list(MEDICATION_RECORD_TYPE))
      .filter((m) => !m.deleted && ids.has(String(m.recordId)) && isTracked(m));
    if (meds.length === 0) return;
    const src = await sources();
    for (const med of meds) await mirrorOne(med, src, false);
  }

  async function write(medId, kind, fields) {
    const med = await findMed(medId);
    if (!med) throw bad('medication not found', 'not_found');
    // A count needs no seed: a real audit outranks one.
    if (kind === 'refill') await ensureSeed(medId);
    // Strictly after this med's last row, so a count and a refill written in
    // the same millisecond keep their order.
    const last = (await records.list(STOCK_RECORD_TYPE))
      .filter((r) => !r.deleted && sameId(r.medication_id, med.recordId))
      .reduce((m, r) => Math.max(m, Date.parse(r.at) || 0), 0);
    let atMs = Math.max(now(), last + 1);
    const put = (body) => records.put(STOCK_RECORD_TYPE, {
      recordId: stockRecordId(med.recordId, atMs),
      clientTs: now(),
      deleted: false,
      medication_id: med.recordId,
      ...body,
      at: new Date(atMs).toISOString(),
    });
    // A refill on an untracked med starts tracking from 0 (the old
    // COALESCE-to-0 restock).
    if (kind === 'refill' && !isTracked(med)) {
      await put({ kind: 'audit', count: 0 });
      atMs += 1;
    }
    await put({ kind, ...fields });
    return mirror(medId, { track: true });
  }

  // POST /api/medications/{id}/restock — pills added.
  async function refill(medId, n, note) {
    if (!Number.isInteger(n) || n <= 0) throw bad('Quantity must be positive', 'invalid_quantity');
    const count = await write(medId, 'refill', note ? { n, note: String(note) } : { n });
    return { status: 'restocked', quantity_added: n, inventory_count: count };
  }

  // POST /api/medications/{id}/stock-audit — pills counted: the new starting
  // point; nothing before it is rewritten.
  async function audit(medId, count) {
    if (!Number.isInteger(count) || count < 0) throw bad('count must be a whole number, 0 or more', 'invalid_count');
    const derived = await write(medId, 'audit', { count });
    return { status: 'counted', inventory_count: derived };
  }

  return {
    sources, ensureSeed, mirror, mirrorMany, refill, audit,
  };
}
