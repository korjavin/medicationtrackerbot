// Runtime-agnostic equipment-inventory domain module (med-niix.1). Pure logic
// over an injected records port — no window/document/fetch/IndexedDB — so the
// same file can later run inside the Go server via goja (C6), like workout.js.
//
// Equipment = a set of achievable loads (kg, what you log for one rep — per
// hand for dumbbells). Two kinds:
//   fixed:  { kind:'fixed', name, loads_kg:[...] } — fixed dumbbells/
//           kettlebells, machine stacks, dial-adjustable dumbbells.
//   plated: { kind:'plated', name, bar_kg, sides:1|2, pair:bool,
//             plates:[{kg, count}], max_plates_per_side? } — a barbell
//           (sides:2), a plate-loaded kettlebell (sides:1), plate-loaded
//           dumbbells (sides:2, pair:true).
// max_plates_per_side is the optional sleeve capacity: how many plates fit on
// ONE sleeve (the single sleeve of a sides:1 kettlebell, each sleeve of each
// dumbbell in a pair). Absent = unlimited. achievableLoads and loadingFor both
// honour it, so every consumer (progression snap, session chip, print sheet,
// auto-match) sees only loads the sleeve can actually hold.
// Each barbell owns its plate list; three bars with different sleeve diameters
// are three records.
// Both kinds carry an optional implement label (med-v75c.1): barbell |
// dumbbell | kettlebell | other. It is display-only — the solver and
// achievableLoads keep reading sides/pair; plated writes default it from
// sides/pair when absent, and legacy plated records without it derive the
// same default on READ (never persisted outside a user write).
// ponytail: plates live on the bar; a shared plate pool with diameter matching
// only if two bars ever share plates.
//
// Numeric ids reuse workout.js's mintNumericId/findByNumericId pattern
// (imported, not duplicated); recordIds are random via genRecordId — nothing
// is lazily materialized, so no LWW-floor concern (unlike med-9a87's
// deterministic slots).
import { mintNumericId, findByNumericId, genRecordId } from './workout.js';

export const EQUIPMENT_RECORD_TYPE = 'equipment';
// Workout locations (gyms, med-8j5w.1): flat named records; equipment carries
// an optional location_id (absent/null = portable, available everywhere). A
// location_id that resolves to no live location reads as portable — deleting
// a gym never cascades a write onto its gear.
export const LOCATION_RECORD_TYPE = 'location';
// The active gym is its OWN synced singleton, not a key on the `settings`
// record: settings is whole-record LWW, so a stale device editing the timezone
// would revert the gym (same reason as `firstrun`, settings.js). Only the
// explicit user setter writes it; absent or pointing at a deleted location
// reads as null, with no cleanup write.
export const ACTIVE_LOCATION_RECORD_TYPE = 'activelocation';
export const ACTIVE_LOCATION_RECORD_ID = 'activelocation';
export const MAX_LOCATION_NAME = 100;

// Validation + compute ceilings (kept small so the knapsack stays bounded).
// ponytail: fixed caps, not derived from any inventory — raise only if the UI
// needs bigger sets.
const MAX_PLATE_TYPES = 20;
const MAX_FIXED_LOADS = 200;
const QUANTA_PER_KG = 4; // 0.25-kg quanta for the plated knapsack.
// ponytail: absolute DP span ceiling (500 kg -> 2000 slots). Real bars never
// reach it; without a ceiling a hostile plate count widens the DP array.
const MAX_TOTAL_KG = 500;
// ponytail: sleeve-capacity ceiling — far above any real sleeve, it only keeps
// the stored value sane.
const MAX_PLATES_PER_SIDE = 100;
// Sentinel "unreachable" plate count for the min-plates DP (Uint16Array).
const UNREACHABLE = 0xffff;

function invalidRequest(message, code) {
  const err = new Error(message);
  err.code = code || 'invalid_request';
  return err;
}

function uniqueSorted(nums) {
  return [...new Set(nums)].sort((a, b) => a - b);
}

// sleeveCapacity is the read-side plates-per-sleeve limit: a positive integer
// when the record carries one, else Infinity (absent, or a vault body that
// bypassed validation with garbage — unlimited, the pre-limit behavior).
function sleeveCapacity(equipment) {
  const n = Number(equipment && equipment.max_plates_per_side);
  return Number.isInteger(n) && n >= 1 ? n : Infinity;
}

// achievableLoads returns every load (kg) the implement can be built at,
// ascending. Fixed: the stored list, normalized. Plated: bar + every symmetric
// plate combination — each side carries the same plates, so a plate type
// contributes in multiples of `sides` plates per step, usable
// floor(count / (sides * (pair ? 2 : 1))) times per implement. On a sides:2
// bar a lone single plate contributes nothing (floor(1/2) = 0); on sides:1
// (plate-loaded kettlebell) it counts. With max_plates_per_side set, a load
// counts only when some combination builds it with at most that many plates
// per sleeve: the knapsack tracks the FEWEST plates per side reaching each
// sum, so the limit is a filter over the same pass.
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
  const capacity = sleeveCapacity(equipment);
  const barQ = Math.round(bar * QUANTA_PER_KG);
  const maxSideQ = Math.max(
    0,
    Math.floor((MAX_TOTAL_KG * QUANTA_PER_KG - barQ) / sides),
  );
  // fewest[s] = fewest plates per side summing to s quanta (UNREACHABLE when
  // none). Plate counts stay below maxSideQ (every plate is >= 1 quantum), so
  // they never reach the sentinel.
  const fewest = new Uint16Array(maxSideQ + 1).fill(UNREACHABLE);
  fewest[0] = 0;
  for (const p of mergePlateRows(equipment.plates)) {
    const perSide = Math.floor(p.count / divisor);
    const q = Math.round(p.kg * QUANTA_PER_KG);
    if (!(perSide > 0) || !(q > 0)) continue;
    // Bounded multiplicity via binary splitting: O(log perSide) 0/1 passes,
    // each bundle of `use` plates costing `use` toward the plate count.
    let remaining = perSide;
    let k = 1;
    while (remaining > 0) {
      const use = Math.min(k, remaining);
      const w = use * q;
      for (let s = maxSideQ; s >= w; s -= 1) {
        const from = fewest[s - w];
        if (from !== UNREACHABLE && from + use < fewest[s]) fewest[s] = from + use;
      }
      remaining -= use;
      k *= 2;
    }
  }
  const loads = [];
  for (let s = 0; s <= maxSideQ; s += 1) {
    // The bar rides exact (never quantized); only plate sums sit on the grid.
    if (fewest[s] !== UNREACHABLE && fewest[s] <= capacity) loads.push(Math.round((bar + (sides * s) / QUANTA_PER_KG) * 100) / 100);
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
// before reporting null. With max_plates_per_side set, a greedy build that
// overflows the sleeve also falls back to the witness, which is the
// fewest-plates build — still over capacity means null (the load does not fit
// on the sleeve, matching achievableLoads). The bar rides exact
// (achievableLoads convention) and the rebuilt total must land on the
// requested kg, so off-grid snapping never reports a near-miss as a build.
export function loadingFor(equipment, kg) {
  if (!equipment || equipment.kind !== 'plated') return null;
  const bar = Number(equipment.bar_kg);
  const target = Number(kg);
  if (!Number.isFinite(bar) || bar <= 0) return null;
  if (!Number.isFinite(target) || target <= 0) return null;
  // Same order as the knapsack span ceiling in achievableLoads: without it a
  // mistyped multi-tonne target sizes the witness array from the target
  // instead of the inventory. +1 covers off-grid bar rounding at the edge.
  if (target > MAX_TOTAL_KG + 1) return null;
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
  const capacity = sleeveCapacity(equipment);
  const picked = remaining === 0 && greedy.length <= capacity ? greedy : knapsackWitness(inv, sideQ);
  if (!picked || picked.length > capacity) return null;
  const total = Math.round((bar + (sides * sideQ) / QUANTA_PER_KG) * 100) / 100;
  if (Math.abs(total - target) > 1e-9) return null;
  return { bar_kg: bar, per_side: picked.map((p) => p.kg).sort((a, b) => b - a) };
}

// knapsackWitness is the exact-cover fallback for loadingFor: bounded 0/1
// knapsack over per-side quanta, one pass per usable copy (capped at what the
// target side could ever take, so a hostile plate count cannot widen the
// loop). Keeps the fewest-plates build per sum (first found on a tie), so the
// sleeve-capacity check sees the best case. Returns the plate entries
// building sideQ, or null.
function knapsackWitness(inv, sideQ) {
  const dp = new Array(sideQ + 1).fill(null);
  dp[0] = [];
  for (const p of inv) {
    const copies = Math.min(p.copies, Math.floor(sideQ / p.q));
    for (let c = 0; c < copies; c += 1) {
      for (let s = sideQ; s >= p.q; s -= 1) {
        const from = dp[s - p.q];
        if (from !== null && (dp[s] === null || from.length + 1 < dp[s].length)) dp[s] = [...from, p];
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

const IMPLEMENT_VALUES = ['barbell', 'dumbbell', 'kettlebell', 'other'];

// defaultPlatedImplement is the label a plated write/read falls back to when
// the payload (or a legacy record) carries no implement: a single-sleeve
// implement is a kettlebell, a pair is dumbbells, otherwise a barbell.
function defaultPlatedImplement(sides, pair) {
  if (sides === 1) return 'kettlebell';
  if (pair) return 'dumbbell';
  return 'barbell';
}

// Absent (undefined/null) stays absent — the caller decides whether to fill
// the plated default; anything else must be one of the four values.
function validateImplement(value) {
  if (value === undefined || value === null) return undefined;
  if (!IMPLEMENT_VALUES.includes(value)) {
    throw invalidRequest("implement must be one of 'barbell', 'dumbbell', 'kettlebell', 'other'");
  }
  return value;
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

// validateMaxPlates: undefined = absent (an update preserves the stored
// value), null = no limit (cleared), else an integer sleeve capacity.
function validateMaxPlates(value) {
  if (value === undefined || value === null) return value;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PLATES_PER_SIDE) {
    throw invalidRequest(`max_plates_per_side must be an integer from 1 to ${MAX_PLATES_PER_SIDE}, or null`);
  }
  return n;
}

// validateLocationId: undefined = absent (an update preserves the stored
// value), null = portable, else a positive integer id. Existence is checked by
// the writer (it needs the records port).
function validateLocationId(value) {
  if (value === undefined || value === null) return value;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw invalidRequest('location_id must be a positive integer or null');
  return n;
}

// validateEquipmentInput normalizes a create/update payload or throws
// invalid_request. Shared by both writers so the stored shape is identical,
// and exported pure (no records port) so the gym share importer
// (workout-share.js) can validate every item BEFORE its first write.
export function validateEquipmentInput(input) {
  const name = ((input && input.name) || '').trim();
  if (!name) throw invalidRequest('Name is required');
  const kind = input && input.kind;
  if (kind !== 'fixed' && kind !== 'plated') {
    throw invalidRequest("kind must be one of 'fixed', 'plated'");
  }
  const out = { name, kind };
  if (kind === 'fixed') {
    out.loads_kg = validateLoads(input.loads_kg);
    const implement = validateImplement(input.implement);
    if (implement !== undefined) out.implement = implement;
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
    const maxPlates = validateMaxPlates(input.max_plates_per_side);
    if (maxPlates !== undefined) out.max_plates_per_side = maxPlates;
    out.implement = validateImplement(input.implement) || defaultPlatedImplement(sides, out.pair);
  }
  const locationId = validateLocationId(input.location_id);
  if (locationId !== undefined) out.location_id = locationId;
  return out;
}

// implementOf is the read-side implement of an equipment record: a genuine
// enum value when set (a vault body bypasses validation on import, so
// anything else does not count), else the plated default, else null (a
// fixed item the user never labelled — unknown).
export function implementOf(record) {
  if (!record) return null;
  if (IMPLEMENT_VALUES.includes(record.implement)) return record.implement;
  if (record.kind === 'plated') return defaultPlatedImplement(record.sides, record.pair);
  return null;
}

export function toEquipmentResponse(record) {
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
  const implement = implementOf(record);
  if (implement) resp.implement = implement;
  // Emitted verbatim, dangling included: normalizing a dangling FK to null
  // here would let the next edit persist the loss.
  if (record.location_id !== null && record.location_id !== undefined) resp.location_id = record.location_id;
  if (record.kind === 'plated') {
    resp.bar_kg = record.bar_kg;
    resp.sides = record.sides;
    resp.pair = !!record.pair;
    resp.plates = (record.plates || []).map((p) => ({ kg: p.kg, count: p.count }));
    const capacity = sleeveCapacity(record);
    if (capacity !== Infinity) resp.max_plates_per_side = capacity;
  }
  return resp;
}

function toLocationResponse(record) {
  return {
    id: record.id,
    name: record.name,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function validateLocationInput(input) {
  const name = (typeof (input && input.name) === 'string' ? input.name : '').trim();
  if (!name) throw invalidRequest('Name is required');
  if (name.length > MAX_LOCATION_NAME) {
    throw invalidRequest(`Name may not exceed ${MAX_LOCATION_NAME} characters`);
  }
  return { name };
}

function sameId(a, b) {
  return a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
}

export async function liveLocations(records) {
  return (await records.list(LOCATION_RECORD_TYPE)).filter((r) => !r.deleted);
}

// activeLocation resolves the active-gym singleton to its live location
// record, or null (no record, null id, or a deleted location). Read-only.
export async function activeLocation(records, locations) {
  const rec = (await records.list(ACTIVE_LOCATION_RECORD_TYPE))
    .find((r) => r.recordId === ACTIVE_LOCATION_RECORD_ID && !r.deleted);
  if (!rec) return null;
  const live = locations || await liveLocations(records);
  return live.find((l) => sameId(l.id, rec.location_id)) || null;
}

// inventoryAt is THE location filter (med-8j5w.1): with a live locationId,
// the items at that location plus portable ones (location_id null/absent or
// dangling); a null or non-live locationId means no location — the whole
// inventory, exactly the pre-locations behavior.
export function inventoryAt(inventory, locationId, liveLocationIds) {
  const inv = Array.isArray(inventory) ? inventory : [];
  const live = new Set([...(liveLocationIds || [])].map(String));
  if (locationId === null || locationId === undefined || !live.has(String(locationId))) return inv;
  return inv.filter((item) => item && (
    item.location_id === null || item.location_id === undefined
    || !live.has(String(item.location_id))
    || String(item.location_id) === String(locationId)));
}

export function createEquipmentDomain({ records, now }) {
  async function assertLiveLocation(locationId) {
    if (locationId === null || locationId === undefined) return;
    if (!(await findByNumericId(records, LOCATION_RECORD_TYPE, locationId))) {
      throw invalidRequest('location_id does not name a location');
    }
  }

  async function createEquipment(input) {
    const clean = validateEquipmentInput(input);
    await assertLiveLocation(clean.location_id);
    if (clean.location_id === null) delete clean.location_id;
    if (clean.max_plates_per_side === null) delete clean.max_plates_per_side;
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
    // Only a CHANGED location must exist: re-saving an item whose gym was
    // deleted keeps the dangling id verbatim (it reads as portable).
    if (!sameId(clean.location_id, record.location_id)) await assertLiveLocation(clean.location_id);
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
      ? ['bar_kg', 'sides', 'pair', 'plates', 'max_plates_per_side']
      : ['loads_kg'];
    for (const k of disowned) delete updated[k];
    // location_id: absent preserves the stored gym (spread above), explicit
    // null clears it (portable) — never persisted as null.
    if (updated.location_id === null) delete updated.location_id;
    // max_plates_per_side follows the same rule: absent preserves the stored
    // sleeve capacity (an older caller must not silently lift it), explicit
    // null removes the limit.
    if (updated.max_plates_per_side === null) delete updated.max_plates_per_side;
    // implement is deliberately NOT stripped: omitting it preserves the stored
    // label (a stale second device or an older MCP caller must not wipe a
    // user-set type), and it survives kind changes — it lives on both kinds.
    await records.put(EQUIPMENT_RECORD_TYPE, updated);
  }

  async function deleteEquipment(id) {
    const record = await findByNumericId(records, EQUIPMENT_RECORD_TYPE, id);
    if (record) await records.del(EQUIPMENT_RECORD_TYPE, record.recordId);
  }

  async function createLocation(input) {
    const clean = validateLocationInput(input);
    const nowMs = now();
    const record = {
      recordId: genRecordId('location', nowMs),
      clientTs: nowMs,
      deleted: false,
      id: mintNumericId(await records.list(LOCATION_RECORD_TYPE), nowMs),
      user_id: 1,
      ...clean,
      created_at: new Date(nowMs).toISOString(),
      updated_at: new Date(nowMs).toISOString(),
    };
    await records.put(LOCATION_RECORD_TYPE, record);
    return toLocationResponse(record);
  }

  async function listLocations() {
    const all = await liveLocations(records);
    all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id));
    return all.map(toLocationResponse);
  }

  async function getLocation(id) {
    const record = await findByNumericId(records, LOCATION_RECORD_TYPE, id);
    return record ? toLocationResponse(record) : null;
  }

  async function updateLocation(id, input) {
    const record = await findByNumericId(records, LOCATION_RECORD_TYPE, id);
    if (!record) return;
    const clean = validateLocationInput(input);
    const nowMs = now();
    await records.put(LOCATION_RECORD_TYPE, {
      ...record, ...clean, clientTs: nowMs, updated_at: new Date(nowMs).toISOString(),
    });
  }

  // Deleting a gym writes nothing else: its gear reads as portable (dangling
  // location_id) and an active pointer at it reads as null.
  async function deleteLocation(id) {
    const record = await findByNumericId(records, LOCATION_RECORD_TYPE, id);
    if (record) await records.del(LOCATION_RECORD_TYPE, record.recordId);
  }

  async function getActiveLocation() {
    const loc = await activeLocation(records);
    return { location_id: loc ? loc.id : null, location: loc ? toLocationResponse(loc) : null };
  }

  // setActiveLocation is the only writer of the singleton: an explicit user
  // switch, stamped with now(). null clears it; any other id must be live.
  async function setActiveLocation(locationId) {
    const id = validateLocationId(locationId === undefined ? null : locationId);
    await assertLiveLocation(id);
    await records.put(ACTIVE_LOCATION_RECORD_TYPE, {
      recordId: ACTIVE_LOCATION_RECORD_ID,
      clientTs: now(),
      deleted: false,
      location_id: id,
    });
    return getActiveLocation();
  }

  return {
    createEquipment,
    listEquipment,
    getEquipment,
    updateEquipment,
    deleteEquipment,
    createLocation,
    listLocations,
    getLocation,
    updateLocation,
    deleteLocation,
    getActiveLocation,
    setActiveLocation,
  };
}

// equipmentIdForExercise is THE equipment-resolution rule (med-3gln): the
// plan row's own equipment_id overrides the library row's binding, and an
// unset row falls back to the library. Either side may be null (a row without
// a library link, a library-sourced log with no plan row); null means
// unbound. Consumers go through equipmentForExercise (below), which adds the
// inventory lookup and the auto-match fallback on top of this precedence.
export function equipmentIdForExercise(exercise, library) {
  if (exercise && exercise.equipment_id !== null && exercise.equipment_id !== undefined) {
    return exercise.equipment_id;
  }
  if (library && library.equipment_id !== null && library.equipment_id !== undefined) {
    return library.equipment_id;
  }
  return null;
}

// pickNearestLoad chooses the rung to show from a nearestLoads bracket: the
// closer rung, ties going to below (owner decision). Shared by the session
// chip and the print sheet so the tie-break can never drift between them.
export function pickNearestLoad(below, above, kg) {
  if (below === null || below === undefined) {
    return (above === null || above === undefined) ? null : above;
  }
  if (above === null || above === undefined) return below;
  return (Number(kg) - below) <= (above - Number(kg)) ? below : above;
}

// nearestLoads brackets a target kg within an ascending achievable-loads list
// (med-v75c.2): { below, above }, each a rung or null past the ends. An exact
// hit returns the rung twice. Pure lookup - the 0.25-kg grid snapping already
// happened when the loads were computed, so off-grid targets just bracket.
export function nearestLoads(loads, kg) {
  const target = Number(kg);
  const rungs = uniqueSorted(
    (loads || []).map(Number).filter((n) => Number.isFinite(n) && n > 0),
  );
  if (!Number.isFinite(target) || rungs.length === 0) return { below: null, above: null };
  let below = null;
  let above = null;
  for (const rung of rungs) {
    if (rung <= target) below = rung;
    if (rung >= target && above === null) above = rung;
  }
  return { below, above };
}

// Name-keyword → implement rules (med-x295), checked in this order so a name
// mentioning two implements resolves to the first. EN stems plus the RU ones
// the owner names exercises with; a stem must start a word, the RU kettlebell
// endings are enumerated so "гир…" does not catch unrelated words.
// ponytail: name keyword rule instead of a catalog port — 487/515 catalog
// implement rows already carry the word; add a catalog-backed port only if a
// real miss shows up.
const IMPLEMENT_NAME_RULES = [
  ['barbell', /(?<!\p{L})(?:barbell|ez[\s-]?bar(?!\p{L})|trap[\s-]?bar(?!\p{L})|landmine|штанг)/iu],
  ['dumbbell', /(?<!\p{L})(?:dumbbell|гантел)/iu],
  ['kettlebell', /(?<!\p{L})(?:kettlebell|гир(?:я|и|е|ю|ей|ями|ях|ям)(?!\p{L}))/iu],
];

// implementForExerciseName derives 'barbell' | 'dumbbell' | 'kettlebell' |
// null from an exercise name — exercises carry no implement field.
export function implementForExerciseName(name) {
  const text = typeof name === 'string' ? name : '';
  for (const [implement, re] of IMPLEMENT_NAME_RULES) {
    if (re.test(text)) return implement;
  }
  return null;
}

// autoEquipmentForExercise (med-x295) picks the inventory item (response
// shape: implement, loads_kg, min_step_kg) matching the implement derived from
// the exercise name. Only items whose implementOf equals it, with a non-empty
// loads_kg, are candidates. Deterministic order: with kg > 0 the smaller
// distance from kg to the item's nearest rung (pickNearestLoad, tie → below —
// an exact rung is distance 0, so it beats every miss); then the smaller
// min_step_kg (finer rungs; a single-rung item counts as coarsest); then the
// lower id. No implement from the name, or no candidate → null.
export function autoEquipmentForExercise(name, inventory, kg) {
  const want = implementForExerciseName(name);
  if (!want) return null;
  const target = Number(kg);
  const hasKg = Number.isFinite(target) && target > 0;
  const scored = (Array.isArray(inventory) ? inventory : [])
    .filter((item) => item && implementOf(item) === want
      && Array.isArray(item.loads_kg) && item.loads_kg.length > 0)
    .map((item) => {
      let dist = 0;
      if (hasKg) {
        const { below, above } = nearestLoads(item.loads_kg, target);
        const rung = pickNearestLoad(below, above, target);
        dist = rung === null ? Infinity : Math.abs(rung - target);
      }
      const step = Number(item.min_step_kg);
      return { item, dist, step: Number.isFinite(step) && step > 0 ? step : Infinity };
    });
  scored.sort((a, b) => (a.dist - b.dist) || (a.step - b.step) || (Number(a.item.id) - Number(b.item.id)));
  return scored.length > 0 ? scored[0].item : null;
}

// equipmentForExercise is THE equipment rule every consumer calls (med-x295):
// an explicit binding (equipmentIdForExercise: row override, else library)
// resolves against the inventory — a dangling explicit id stays unbound and
// never falls through to auto (a deleted binding must not silently switch
// gear); with no explicit id, the inventory is auto-matched by implement +
// weight. Returns { item, auto } or null. Computed on every read, never stored.
// `location` ({ locationId, liveLocationIds }, med-8j5w.1) scopes it to a gym
// via inventoryAt: an explicit binding to gear at ANOTHER live location is
// ignored and falls through to auto-match, and auto-match only considers gear
// available at that location. Absent/null location = the whole inventory.
export function equipmentForExercise(exercise, library, inventory, kg, location) {
  const id = equipmentIdForExercise(exercise, library);
  const inv = Array.isArray(inventory) ? inventory : [];
  const scoped = location ? inventoryAt(inv, location.locationId, location.liveLocationIds) : inv;
  if (id !== null) {
    const item = inv.find((e) => e && e.id !== null && e.id !== undefined && String(e.id) === String(id));
    if (!item) return null;
    if (scoped === inv || scoped.includes(item)) return { item, auto: false };
  }
  // The library name is canonical (plan reads resolve exercise_name from it,
  // the row's own copy is a cache), so every consumer matches the same name.
  const name = (library && library.name) || (exercise && exercise.exercise_name) || '';
  const item = autoEquipmentForExercise(name, scoped, kg);
  return item ? { item, auto: true } : null;
}
