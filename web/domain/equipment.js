// Runtime-agnostic equipment-inventory domain module (med-niix.1). Pure logic
// over an injected records port — no window/document/fetch/IndexedDB — so the
// same file can later run inside the Go server via goja (C6), like workout.js.
//
// Equipment = a set of achievable loads (kg, what you log for one rep — per
// hand for dumbbells). Two kinds:
//   fixed:  { kind:'fixed', name, loads_kg:[...] } — fixed dumbbells/
//           kettlebells, machine stacks, dial-adjustable dumbbells.
//   plated: { kind:'plated', name, bar_kg, sides:1|2, pair:bool,
//             plates:[{kg, count}] } — a barbell (sides:2), a plate-loaded
//           kettlebell (sides:1), plate-loaded dumbbells (sides:2, pair:true).
// Each barbell owns its plate list; three bars with different sleeve diameters
// are three records.
// ponytail: plates live on the bar; a shared plate pool with diameter matching
// only if two bars ever share plates.
//
// Numeric ids reuse workout.js's mintNumericId/findByNumericId pattern
// (imported, not duplicated); recordIds are random via genRecordId — nothing
// is lazily materialized, so no LWW-floor concern (unlike med-9a87's
// deterministic slots).
import { mintNumericId, findByNumericId, genRecordId } from './workout.js';

export const EQUIPMENT_RECORD_TYPE = 'equipment';

// Validation + compute ceilings (kept small so the knapsack stays bounded).
// ponytail: fixed caps, not derived from any inventory — raise only if the UI
// needs bigger sets.
const MAX_PLATE_TYPES = 20;
const MAX_FIXED_LOADS = 200;
const QUANTA_PER_KG = 4; // 0.25-kg quanta for the plated knapsack.
// ponytail: absolute DP span ceiling (500 kg -> 2000 slots). Real bars never
// reach it; without a ceiling a hostile plate count widens the DP array.
const MAX_TOTAL_KG = 500;

function invalidRequest(message, code) {
  const err = new Error(message);
  err.code = code || 'invalid_request';
  return err;
}

function uniqueSorted(nums) {
  return [...new Set(nums)].sort((a, b) => a - b);
}

// achievableLoads returns every load (kg) the implement can be built at,
// ascending. Fixed: the stored list, normalized. Plated: bar + every symmetric
// plate combination — each side carries the same plates, so a plate type
// contributes in multiples of `sides` plates per step, usable
// floor(count / (sides * (pair ? 2 : 1))) times per implement. On a sides:2
// bar a lone single plate contributes nothing (floor(1/2) = 0); on sides:1
// (plate-loaded kettlebell) it counts.
// ponytail: symmetric loading only — add an allow_uneven flag only if the
// owner asks. The UI should surface the computed loads/step so a lone plate
// that drops out is visible.
// Off-grid weights are snapped, not rejected: bar and plate kg round to the
// 0.25-kg grid (a 20.4 kg bar still reports loads[0] === 20.4, plate rungs
// land on-grid), and a plate type rounding to zero quanta drops out — same
// visibility rule as the lone plate, never a silent error.
export function achievableLoads(equipment) {
  if (!equipment || equipment.kind !== 'plated') {
    const raw = (equipment && equipment.loads_kg) || [];
    return uniqueSorted(
      raw.map(Number).filter((n) => Number.isFinite(n) && n > 0),
    );
  }
  const bar = Number(equipment.bar_kg);
  if (!Number.isFinite(bar) || bar <= 0) return [];
  const sides = equipment.sides === 1 ? 1 : 2;
  const divisor = sides * (equipment.pair ? 2 : 1);
  const barQ = Math.round(bar * QUANTA_PER_KG);
  const maxSideQ = Math.max(
    0,
    Math.floor((MAX_TOTAL_KG * QUANTA_PER_KG - barQ) / sides),
  );
  const reachable = new Uint8Array(maxSideQ + 1);
  reachable[0] = 1;
  for (const p of mergePlateRows(equipment.plates)) {
    const perSide = Math.floor(p.count / divisor);
    const q = Math.round(p.kg * QUANTA_PER_KG);
    if (!(perSide > 0) || !(q > 0)) continue;
    // Bounded multiplicity via binary splitting: O(log perSide) 0/1 passes.
    let remaining = perSide;
    let k = 1;
    while (remaining > 0) {
      const use = Math.min(k, remaining);
      const w = use * q;
      for (let s = maxSideQ; s >= w; s -= 1) {
        if (reachable[s - w]) reachable[s] = 1;
      }
      remaining -= use;
      k *= 2;
    }
  }
  const loads = [];
  for (let s = 0; s <= maxSideQ; s += 1) {
    // The bar rides exact (never quantized); only plate sums sit on the grid.
    if (reachable[s]) loads.push(Math.round((bar + (sides * s) / QUANTA_PER_KG) * 100) / 100);
  }
  return loads;
}

// loadingFor decomposes a target load into the bar plus the plates on each
// side — { bar_kg, per_side: [kg, ...] } (heaviest first) — or null when the
// kg cannot be built on this equipment. Fixed gear (and anything not plated)
// returns null: nothing to draw. Greedy heaviest-first over the same
// per-side grid achievableLoads uses (plate-row merge first, then
// floor(count / (sides * (pair ? 2 : 1))) usable copies per side); greedy can
// miss exotic inventories, so a miss falls back to a bounded-knapsack witness
// before reporting null. The bar rides exact (achievableLoads convention) and
// the rebuilt total must land on the requested kg, so off-grid snapping never
// reports a near-miss as a build.
export function loadingFor(equipment, kg) {
  if (!equipment || equipment.kind !== 'plated') return null;
  const bar = Number(equipment.bar_kg);
  const target = Number(kg);
  if (!Number.isFinite(bar) || bar <= 0) return null;
  if (!Number.isFinite(target) || target <= 0) return null;
  const sides = equipment.sides === 1 ? 1 : 2;
  const divisor = sides * (equipment.pair ? 2 : 1);
  const inv = [];
  for (const p of mergePlateRows(equipment.plates)) {
    const copies = Math.floor(p.count / divisor);
    const q = Math.round(p.kg * QUANTA_PER_KG);
    if (!(copies > 0) || !(q > 0)) continue;
    inv.push({ kg: p.kg, q, copies });
  }
  inv.sort((a, b) => b.q - a.q);
  const barQ = Math.round(bar * QUANTA_PER_KG);
  const targetQ = Math.round(target * QUANTA_PER_KG);
  const diff = targetQ - barQ;
  if (diff < 0 || diff % sides !== 0) return null;
  const sideQ = diff / sides;
  let remaining = sideQ;
  const greedy = [];
  for (const p of inv) {
    if (remaining <= 0) break;
    const use = Math.min(p.copies, Math.floor(remaining / p.q));
    for (let i = 0; i < use; i += 1) greedy.push(p);
    remaining -= use * p.q;
  }
  const picked = remaining === 0 ? greedy : knapsackWitness(inv, sideQ);
  if (!picked) return null;
  const total = Math.round((bar + (sides * sideQ) / QUANTA_PER_KG) * 100) / 100;
  if (Math.abs(total - target) > 1e-9) return null;
  return { bar_kg: bar, per_side: picked.map((p) => p.kg).sort((a, b) => b - a) };
}

// knapsackWitness is the exact-cover fallback for loadingFor: bounded 0/1
// knapsack over per-side quanta, one pass per usable copy (capped at what the
// target side could ever take, so a hostile plate count cannot widen the
// loop). Returns the plate entries building sideQ, or null.
function knapsackWitness(inv, sideQ) {
  const dp = new Array(sideQ + 1).fill(null);
  dp[0] = [];
  for (const p of inv) {
    const copies = Math.min(p.copies, Math.floor(sideQ / p.q));
    for (let c = 0; c < copies; c += 1) {
      for (let s = sideQ; s >= p.q; s -= 1) {
        if (dp[s] === null && dp[s - p.q] !== null) dp[s] = [...dp[s - p.q], p];
      }
    }
  }
  return dp[sideQ];
}

// minStep is the smallest gap between consecutive achievable loads (null when
// fewer than two loads exist). Rounded to 2dp so fixed lists with decimal
// loads never report float dust.
export function minStep(loads) {
  const sorted = uniqueSorted(
    (loads || []).map(Number).filter((n) => Number.isFinite(n) && n > 0),
  );
  if (sorted.length < 2) return null;
  let best = Infinity;
  for (let i = 1; i < sorted.length; i += 1) {
    best = Math.min(best, sorted[i] - sorted[i - 1]);
  }
  return Math.round(best * 100) / 100;
}

// snapLoad picks the achievable rung for a desired bump: candidates are the
// loads strictly above `current`; the winner is nearest to current+desired
// (tie -> lower); null when already at max.
export function snapLoad(loads, current, desired) {
  const cur = Number(current);
  const want = cur + Number(desired);
  if (!Number.isFinite(cur) || !Number.isFinite(want)) return null;
  let best = null;
  for (const raw of loads || []) {
    const c = Number(raw);
    if (!Number.isFinite(c) || !(c > cur)) continue;
    if (best === null) {
      best = c;
      continue;
    }
    const dC = Math.abs(c - want);
    const dB = Math.abs(best - want);
    if (dC < dB || (dC === dB && c < best)) best = c;
  }
  return best;
}

// mergePlateRows folds duplicate plate rows by weight (first-seen order),
// skipping malformed rows. Shared by validation (canonical stored shape) and
// achievableLoads (vault bodies bypass validation on import): the symmetric
// floor divides each row independently, so [{5,1},{5,1}] on a sides:2 bar
// would otherwise discard both halves of a valid pair.
function mergePlateRows(rows) {
  const merged = new Map();
  for (const p of rows || []) {
    const kg = Number(p && p.kg);
    const count = Number(p && p.count);
    if (!Number.isFinite(kg) || kg <= 0 || !Number.isInteger(count) || count < 1) continue;
    merged.set(kg, (merged.get(kg) || 0) + count);
  }
  return [...merged.entries()].map(([kg, count]) => ({ kg, count }));
}

function validatePlates(plates) {
  if (plates === undefined || plates === null) return [];
  if (!Array.isArray(plates)) throw invalidRequest('plates must be an array');
  if (plates.length > MAX_PLATE_TYPES) {
    throw invalidRequest(`plates may not exceed ${MAX_PLATE_TYPES} types`);
  }
  const rows = plates.map((p) => {
    const kg = Number(p && p.kg);
    if (!Number.isFinite(kg) || kg <= 0) {
      throw invalidRequest('plate kg must be a positive finite number');
    }
    const count = Number(p && p.count);
    if (!Number.isInteger(count) || count < 1) {
      throw invalidRequest('plate count must be an integer >= 1');
    }
    return { kg, count };
  });
  return mergePlateRows(rows);
}

function validateLoads(loads) {
  if (!Array.isArray(loads) || loads.length === 0) {
    throw invalidRequest('loads_kg must be a non-empty array');
  }
  if (loads.length > MAX_FIXED_LOADS) {
    throw invalidRequest(`loads_kg may not exceed ${MAX_FIXED_LOADS} entries`);
  }
  const nums = loads.map(Number);
  for (const n of nums) {
    if (!Number.isFinite(n) || n <= 0) {
      throw invalidRequest('loads_kg entries must be positive finite numbers');
    }
  }
  return uniqueSorted(nums);
}

// validateEquipmentInput normalizes a create/update payload or throws
// invalid_request. Shared by both writers so the stored shape is identical.
function validateEquipmentInput(input) {
  const name = ((input && input.name) || '').trim();
  if (!name) throw invalidRequest('Name is required');
  const kind = input && input.kind;
  if (kind !== 'fixed' && kind !== 'plated') {
    throw invalidRequest("kind must be one of 'fixed', 'plated'");
  }
  const out = { name, kind };
  if (kind === 'fixed') {
    out.loads_kg = validateLoads(input.loads_kg);
  } else {
    const barKg = Number(input.bar_kg);
    if (!Number.isFinite(barKg) || barKg <= 0) {
      throw invalidRequest('bar_kg must be a positive finite number');
    }
    const sides = Number(input.sides);
    if (sides !== 1 && sides !== 2) {
      throw invalidRequest('sides must be 1 or 2');
    }
    out.bar_kg = barKg;
    out.sides = sides;
    out.pair = !!(input.pair);
    out.plates = validatePlates(input.plates);
  }
  return out;
}

function toEquipmentResponse(record) {
  const loads = achievableLoads(record);
  const resp = {
    id: record.id,
    user_id: record.user_id,
    name: record.name,
    kind: record.kind,
    created_at: record.created_at,
    updated_at: record.updated_at,
    loads_kg: loads,
    min_step_kg: minStep(loads),
    max_kg: loads.length > 0 ? loads[loads.length - 1] : null,
  };
  if (record.kind === 'plated') {
    resp.bar_kg = record.bar_kg;
    resp.sides = record.sides;
    resp.pair = !!record.pair;
    resp.plates = (record.plates || []).map((p) => ({ kg: p.kg, count: p.count }));
  }
  return resp;
}

export function createEquipmentDomain({ records, now }) {
  async function createEquipment(input) {
    const clean = validateEquipmentInput(input);
    const nowMs = now();
    const record = {
      recordId: genRecordId('equipment', nowMs),
      clientTs: nowMs,
      deleted: false,
      id: mintNumericId(await records.list(EQUIPMENT_RECORD_TYPE), nowMs),
      // Single-account cloud mode: same shape-fidelity convention as
      // workout.js's CLOUD_USER_ID; no frontend code reads it.
      user_id: 1,
      ...clean,
      created_at: new Date(nowMs).toISOString(),
      updated_at: new Date(nowMs).toISOString(),
    };
    await records.put(EQUIPMENT_RECORD_TYPE, record);
    return toEquipmentResponse(record);
  }

  async function listEquipment() {
    const all = (await records.list(EQUIPMENT_RECORD_TYPE)).filter((r) => !r.deleted);
    all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return all.map(toEquipmentResponse);
  }

  async function getEquipment(id) {
    const record = await findByNumericId(records, EQUIPMENT_RECORD_TYPE, id);
    return record ? toEquipmentResponse(record) : null;
  }

  async function updateEquipment(id, input) {
    const record = await findByNumericId(records, EQUIPMENT_RECORD_TYPE, id);
    // Mirrors updateGroup: an unknown id matches zero rows — no error, no-op.
    if (!record) return;
    const clean = validateEquipmentInput(input);
    const nowMs = now();
    const updated = {
      ...record,
      ...clean,
      clientTs: nowMs,
      updated_at: new Date(nowMs).toISOString(),
    };
    // A kind change must not leave the other kind's fields behind: delete
    // the disowned side's keys (never persist undefined).
    const disowned = clean.kind === 'fixed'
      ? ['bar_kg', 'sides', 'pair', 'plates']
      : ['loads_kg'];
    for (const k of disowned) delete updated[k];
    await records.put(EQUIPMENT_RECORD_TYPE, updated);
  }

  async function deleteEquipment(id) {
    const record = await findByNumericId(records, EQUIPMENT_RECORD_TYPE, id);
    if (record) await records.del(EQUIPMENT_RECORD_TYPE, record.recordId);
  }

  return {
    createEquipment,
    listEquipment,
    getEquipment,
    updateEquipment,
    deleteEquipment,
  };
}
