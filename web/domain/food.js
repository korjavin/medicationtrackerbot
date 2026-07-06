// Runtime-agnostic food domain module. Pure logic over an injected records
// port — no window/document/fetch/IndexedDB — so the same file can later run
// inside the Go server via goja (C6) with a Go-backed records port.
// Mirrors internal/store/food/repo.go + internal/server/food_handlers.go +
// internal/domain/food.go.

import { offsetMsAt, dayStartMs } from './bp.js';

const LOG_RECORD_TYPE = 'foodlog';
const PRODUCT_RECORD_TYPE = 'foodproduct';
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Ported verbatim from internal/domain/food.go:11 (CalculateMacros) —
// int-truncated totals, calories always recomputed, never trusted from input.
export function calculateMacros(carbs100, protein100, fat100, weight) {
  const carbs = Math.trunc((carbs100 * weight) / 100);
  const protein = Math.trunc((protein100 * weight) / 100);
  const fat = Math.trunc((fat100 * weight) / 100);
  const calories = 4 * carbs + 4 * protein + 9 * fat;
  return { carbs, protein, fat, calories };
}

// Mirrors the HTTP handlers' pre-store guards (food_handlers.go:53-60,
// :515-522, :829-837) — in cloud mode the domain layer is the only validation
// seam, so a negative macro/weight would otherwise sync straight into the vault
// and corrupt daily/weekly stats.
function invalidRequest(message) {
  const err = new Error(message);
  err.code = 'invalid_request';
  return err;
}

function assertNonNegativeMacros(input, { checkWeight = false } = {}) {
  if (checkWeight && (input.weight || 0) < 0) throw invalidRequest('Weight cannot be negative');
  if ((input.carbs || 0) < 0 || (input.protein || 0) < 0 || (input.fat || 0) < 0 || (input.calories || 0) < 0) {
    throw invalidRequest('Nutritional values cannot be negative');
  }
}

function toISOString(v) {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  return v;
}

function genId(prefix, nowMs) {
  return `${prefix}_${nowMs}_${Math.random().toString(36).slice(2, 10)}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// wallParts mirrors bp.js's offsetMsAt trick: shift the instant by the zone's
// current offset, then read wall-clock components via the UTC getters.
function wallParts(ms, timeZone) {
  const wall = new Date(ms + offsetMsAt(ms, timeZone));
  return {
    day: wall.getUTCDate(),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
    weekday: wall.getUTCDay(),
    month: wall.getUTCMonth(),
  };
}

function formatTimeLabel(ms, timeZone) {
  const p = wallParts(ms, timeZone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

function formatDateLabel(ms, timeZone) {
  const p = wallParts(ms, timeZone);
  return `${WEEKDAYS[p.weekday]}, ${MONTHS[p.month]} ${pad2(p.day)}`;
}

function mealNameForHour(hour) {
  if (hour >= 5 && hour < 11) return 'Breakfast';
  if (hour >= 11 && hour < 16) return 'Lunch';
  if (hour >= 16 && hour < 22) return 'Dinner';
  return 'Snack';
}

function totalsFor(group) {
  let calories = 0;
  let carbs = 0;
  let protein = 0;
  let fat = 0;
  for (const l of group.logs) {
    calories += l.calories;
    carbs += l.carbs;
    protein += l.protein;
    fat += l.fat;
  }
  return { ...group, calories, carbs, protein, fat };
}

// Ported from internal/server/food_handlers.go:625 (groupFoodLogs). `logs`
// must already be sorted ascending by eaten_at (server response shape).
export function groupFoodLogs(logs, isMultiDay, timeZone) {
  if (!logs.length) return [];
  const groups = [];
  let current = null;

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    const ms = Date.parse(log.eaten_at);
    const timeStr = isMultiDay ? formatDateLabel(ms, timeZone) : formatTimeLabel(ms, timeZone);
    const groupName = isMultiDay ? timeStr : mealNameForHour(wallParts(ms, timeZone).hour);

    if (i === 0) {
      current = { name: groupName, time: timeStr, logs: [log] };
      continue;
    }

    const prevMs = Date.parse(logs[i - 1].eaten_at);
    const shouldGroup = isMultiDay
      ? dayStartMs(ms, timeZone) === dayStartMs(prevMs, timeZone)
      : Math.abs(ms - prevMs) < 30 * 60 * 1000;

    if (shouldGroup) {
      current.logs.push(log);
    } else {
      groups.push(totalsFor(current));
      current = { name: groupName, time: timeStr, logs: [log] };
    }
  }
  if (current && current.logs.length) groups.push(totalsFor(current));
  return groups;
}

function toLogResponse(record, isMeal) {
  const resp = {
    id: record.recordId,
    eaten_at: record.eaten_at,
    weight: record.weight,
    carbs: record.carbs,
    protein: record.protein,
    fat: record.fat,
    calories: record.calories,
    is_meal: !!isMeal,
  };
  if (record.name) resp.name = record.name;
  if (record.product_id) resp.product_id = record.product_id;
  return resp;
}

function toProductResponse(record) {
  return {
    id: record.recordId,
    name: record.name,
    barcode: record.barcode || undefined,
    carbs_100g: record.carbs_100g,
    protein_100g: record.protein_100g,
    fat_100g: record.fat_100g,
    energy_kcal_100g: record.energy_kcal_100g,
    usage_count: record.usage_count,
    is_meal: !!record.is_meal,
    total_weight_g: record.total_weight_g,
    created_at: record.created_at,
    last_used_at: record.last_used_at,
  };
}

function foodProductUniqueKey(p) {
  const barcode = (p.barcode || '').trim().toLowerCase();
  if (barcode) return `barcode:${barcode}`;
  return `name:${(p.name || '').trim().toLowerCase()}`;
}

// mergeProducts ports mergeFoodProducts (food_handlers.go:1087): base first,
// dedup by barcode-else-name, capped at 50.
export function mergeProducts(base, extra) {
  if (!extra.length) return base;
  const merged = [];
  const seen = new Set();
  const add = (p) => {
    const key = foodProductUniqueKey(p);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(p);
  };
  base.forEach(add);
  extra.forEach(add);
  return merged.slice(0, 50);
}

// createFoodDomain builds the food domain API over the injected ports:
//   records  — { list(type), put(type, record), del(type, id) }
//   now()    — current time in ms epoch
//   timeZone — IANA zone string for meal-grouping / day-window boundaries
//   foodDb   — remote search port, { search(query) => Promise<product[]> };
//              optional — omitted/falsy means remote search is unavailable.
export function createFoodDomain({ records, now, timeZone, foodDb }) {
  // upsertProductByName ports UpsertProduct's ON CONFLICT(name) semantics
  // (repo.go:141): COALESCE-preserve non-zero macros, bump usage_count,
  // refresh last_used_at; is_meal/total_weight_g only overwritten when the
  // incoming row says is_meal.
  async function upsertProductByName(input) {
    const nowMs = now();
    const all = await records.list(PRODUCT_RECORD_TYPE);
    const existing = all.find((p) => !p.deleted && p.name === input.name);
    const record = existing
      ? {
        ...existing,
        clientTs: nowMs,
        barcode: input.barcode || existing.barcode || null,
        carbs_100g: input.carbs_100g ? input.carbs_100g : existing.carbs_100g,
        protein_100g: input.protein_100g ? input.protein_100g : existing.protein_100g,
        fat_100g: input.fat_100g ? input.fat_100g : existing.fat_100g,
        energy_kcal_100g: input.energy_kcal_100g ? input.energy_kcal_100g : existing.energy_kcal_100g,
        usage_count: existing.usage_count + 1,
        is_meal: input.is_meal ? true : !!existing.is_meal,
        total_weight_g: input.is_meal ? input.total_weight_g : existing.total_weight_g,
        last_used_at: new Date(nowMs).toISOString(),
      }
      : {
        recordId: genId('foodproduct', nowMs),
        clientTs: nowMs,
        deleted: false,
        name: input.name,
        barcode: input.barcode || null,
        carbs_100g: input.carbs_100g || 0,
        protein_100g: input.protein_100g || 0,
        fat_100g: input.fat_100g || 0,
        energy_kcal_100g: input.energy_kcal_100g || 0,
        usage_count: 1,
        is_meal: !!input.is_meal,
        total_weight_g: input.total_weight_g || 0,
        created_at: new Date(nowMs).toISOString(),
        last_used_at: new Date(nowMs).toISOString(),
      };
    await records.put(PRODUCT_RECORD_TYPE, record);
    return record;
  }

  function per100gFrom(input) {
    const weight = input.weight || 0;
    const carbs = input.carbs || 0;
    const protein = input.protein || 0;
    const fat = input.fat || 0;
    const calories = input.calories || 0;
    if (input.per_100g) return { carbs_100g: carbs, protein_100g: protein, fat_100g: fat, energy_kcal_100g: calories };
    if (weight > 0) {
      const mult = 100 / weight;
      return { carbs_100g: carbs * mult, protein_100g: protein * mult, fat_100g: fat * mult, energy_kcal_100g: calories * mult };
    }
    return { carbs_100g: 0, protein_100g: 0, fat_100g: 0, energy_kcal_100g: 0 };
  }

  function isMealFor(record, productsById) {
    if (!record.product_id) return false;
    const product = productsById.get(record.product_id);
    return !!(product && product.is_meal);
  }

  async function productsIndex() {
    const all = await records.list(PRODUCT_RECORD_TYPE);
    return new Map(all.filter((p) => !p.deleted).map((p) => [p.recordId, p]));
  }

  // create mirrors handleCreateFoodLog (food_handlers.go:21): a product_id
  // resolves the log's name/product and only bumps usage afterwards; a bare
  // name upserts the product with the computed per-100g macros up front.
  // skipProductUpsert matches the AI handlers (handleCreateFoodLogFrom*), which
  // CreateLog a bare-named entry with no product_id and no UpsertProduct.
  async function create(input, { skipProductUpsert = false } = {}) {
    assertNonNegativeMacros(input, { checkWeight: true });
    const nowMs = now();
    let resolvedName = input.name || '';
    let resolvedProductId = null;
    let bumpAfterCreate = null;

    if (input.product_id) {
      const products = await productsIndex();
      const product = products.get(input.product_id);
      if (!product) {
        const err = new Error('invalid product_id: product does not exist or belongs to another user');
        err.code = 'invalid_product';
        throw err;
      }
      resolvedProductId = product.recordId;
      if (!resolvedName) resolvedName = product.name;
      bumpAfterCreate = product.name;
    } else if (resolvedName && !skipProductUpsert) {
      const product = await upsertProductByName({ name: resolvedName, barcode: input.barcode || null, ...per100gFrom(input) });
      resolvedProductId = product.recordId;
    }

    const record = {
      recordId: genId('foodlog', nowMs),
      clientTs: nowMs,
      deleted: false,
      eaten_at: toISOString(input.eaten_at),
      weight: input.weight || 0,
      carbs: input.carbs || 0,
      protein: input.protein || 0,
      fat: input.fat || 0,
      calories: input.calories || 0,
      name: resolvedName,
      product_id: resolvedProductId,
    };
    await records.put(LOG_RECORD_TYPE, record);

    if (bumpAfterCreate) await upsertProductByName({ name: bumpAfterCreate });

    const products = await productsIndex();
    return toLogResponse(record, isMealFor(record, products));
  }

  // update mirrors handleUpdateFoodLog (food_handlers.go:477): always
  // recomputes per-100g macros from the edited totals and upserts the named
  // product (no usage-only bump path — unlike create).
  async function update(id, input) {
    assertNonNegativeMacros(input, { checkWeight: true });
    const all = await records.list(LOG_RECORD_TYPE);
    const existing = all.find((r) => !r.deleted && r.recordId === id);
    if (!existing) {
      const err = new Error('food log not found');
      err.code = 'not_found';
      throw err;
    }

    if (input.product_id) {
      const products = await productsIndex();
      if (!products.has(input.product_id)) {
        const err = new Error('invalid product_id: product does not exist or belongs to another user');
        err.code = 'invalid_product';
        throw err;
      }
    }

    const record = {
      ...existing,
      clientTs: now(),
      eaten_at: toISOString(input.eaten_at),
      weight: input.weight || 0,
      carbs: input.carbs || 0,
      protein: input.protein || 0,
      fat: input.fat || 0,
      calories: input.calories || 0,
      name: input.name || '',
      product_id: input.product_id || null,
    };
    await records.put(LOG_RECORD_TYPE, record);

    if (record.name) {
      await upsertProductByName({ name: record.name, barcode: input.barcode || null, ...per100gFrom(input) });
    }

    const products = await productsIndex();
    return toLogResponse(record, isMealFor(record, products));
  }

  async function remove(id) {
    const all = await records.list(LOG_RECORD_TYPE);
    if (!all.some((r) => !r.deleted && r.recordId === id)) {
      const err = new Error('food log not found');
      err.code = 'not_found';
      throw err;
    }
    await records.del(LOG_RECORD_TYPE, id);
  }

  // dayWindow resolves [start, endExclusive) for `days` calendar days ending
  // on `date`'s local day, mirroring ListLogs/GetStats's DST-safe midnight
  // math (repo.go:509/595). `date` may be a ms epoch, Date, or "YYYY-MM-DD"
  // string (parsed as local midnight in `timeZone`); omitted means "now".
  function dayWindow(date, days) {
    let endMs;
    if (date === undefined || date === null) {
      endMs = now();
    } else if (date instanceof Date) {
      endMs = date.getTime();
    } else if (typeof date === 'number') {
      endMs = date;
    } else {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
      if (m) {
        const utcMidnight = Date.UTC(+m[1], +m[2] - 1, +m[3]);
        endMs = utcMidnight - offsetMsAt(utcMidnight, timeZone);
      } else {
        endMs = Date.parse(date);
      }
    }
    const dayStart = dayStartMs(endMs, timeZone);
    // Snap each edge back through dayStartMs so DST transitions inside the range
    // don't shift a boundary by the offset delta — mirrors Go's AddDate calendar
    // math (repo.go:509/595) rather than raw fixed-86.4Ms hops. The +DAY_MS/2
    // buffer absorbs the DST drift (≤2h) so the floor always lands on the
    // intended local midnight.
    const endExclusive = dayStartMs(dayStart + DAY_MS + DAY_MS / 2, timeZone);
    const start = dayStartMs(dayStart - (days - 1) * DAY_MS + DAY_MS / 2, timeZone);
    return { start, endExclusive };
  }

  // listGrouped mirrors handleGetFoodLogs (food_handlers.go:431).
  async function listGrouped({ date, days = 1 } = {}) {
    const { start, endExclusive } = dayWindow(date, days);
    const all = await records.list(LOG_RECORD_TYPE);
    const products = await productsIndex();
    const logs = all
      .filter((r) => !r.deleted)
      .filter((r) => {
        const ms = Date.parse(r.eaten_at);
        return ms >= start && ms < endExclusive;
      })
      .sort((a, b) => Date.parse(a.eaten_at) - Date.parse(b.eaten_at));

    const responses = [];
    for (const record of logs) {
      responses.push(toLogResponse(record, isMealFor(record, products)));
    }
    return groupFoodLogs(responses, days > 1, timeZone);
  }

  // stats mirrors handleGetFoodStats / GetStats (repo.go:592): plain window
  // SUM, no per-day averaging.
  async function stats({ date, days = 7 } = {}) {
    const { start, endExclusive } = dayWindow(date, days);
    const all = await records.list(LOG_RECORD_TYPE);
    const result = { calories: 0, carbs: 0, protein: 0, fat: 0 };
    for (const r of all) {
      if (r.deleted) continue;
      const ms = Date.parse(r.eaten_at);
      if (ms < start || ms >= endExclusive) continue;
      result.calories += r.calories;
      result.carbs += r.carbs;
      result.protein += r.protein;
      result.fat += r.fat;
    }
    return result;
  }

  // listProducts mirrors ListProducts (repo.go:242): is_meal filter, `q`
  // substring match, limit/offset, three sort modes.
  async function listProducts({ isMeal, q, offset = 0, limit = 100, sort } = {}) {
    const all = await records.list(PRODUCT_RECORD_TYPE);
    let filtered = all.filter((p) => !p.deleted);
    if (isMeal !== undefined && isMeal !== null) filtered = filtered.filter((p) => !!p.is_meal === isMeal);
    if (q) {
      const needle = q.toLowerCase();
      filtered = filtered.filter((p) => p.name.toLowerCase().includes(needle));
    }

    const total = filtered.length;
    const sorted = filtered.slice().sort((a, b) => {
      if (sort === 'last_used') return Date.parse(b.last_used_at) - Date.parse(a.last_used_at);
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (b.usage_count !== a.usage_count) return b.usage_count - a.usage_count;
      return Date.parse(b.last_used_at) - Date.parse(a.last_used_at);
    });

    const page = limit > 0 ? sorted.slice(offset, offset + limit) : sorted.slice(offset);
    return { products: page.map(toProductResponse), total };
  }

  async function updateProduct(id, input) {
    if (!input.name) throw invalidRequest('Name is required');
    if ((input.carbs_100g || 0) < 0 || (input.protein_100g || 0) < 0 ||
        (input.fat_100g || 0) < 0 || (input.energy_kcal_100g || 0) < 0) {
      throw invalidRequest('Nutritional values cannot be negative');
    }
    const all = await records.list(PRODUCT_RECORD_TYPE);
    const existing = all.find((p) => !p.deleted && p.recordId === id);
    if (!existing) {
      const err = new Error('product not found');
      err.code = 'not_found';
      throw err;
    }
    const record = {
      ...existing,
      clientTs: now(),
      name: input.name,
      barcode: input.barcode || null,
      carbs_100g: input.carbs_100g || 0,
      protein_100g: input.protein_100g || 0,
      fat_100g: input.fat_100g || 0,
      energy_kcal_100g: input.energy_kcal_100g || 0,
      is_meal: !!input.is_meal,
      total_weight_g: input.total_weight_g || 0,
    };
    await records.put(PRODUCT_RECORD_TYPE, record);
    return toProductResponse(record);
  }

  async function removeProduct(id) {
    const all = await records.list(PRODUCT_RECORD_TYPE);
    if (!all.some((p) => !p.deleted && p.recordId === id)) {
      const err = new Error('product not found');
      err.code = 'not_found';
      throw err;
    }
    await records.del(PRODUCT_RECORD_TYPE, id);
  }

  // createMealFromLogs mirrors CreateMealFromLogs (repo.go:349): sums the
  // given logs' totals into a new is_meal product with per-100g macros.
  async function createMealFromLogs(name, logIds) {
    if (!logIds.length) {
      const err = new Error('no log IDs provided');
      err.code = 'invalid_request';
      throw err;
    }
    const uniqueIds = [...new Set(logIds)];
    const all = await records.list(LOG_RECORD_TYPE);
    const byId = new Map(all.filter((r) => !r.deleted).map((r) => [r.recordId, r]));

    let totalWeight = 0;
    let totalCarbs = 0;
    let totalProtein = 0;
    let totalFat = 0;
    let totalCalories = 0;
    let count = 0;
    for (const id of uniqueIds) {
      const log = byId.get(id);
      if (!log) continue;
      totalWeight += log.weight;
      totalCarbs += log.carbs;
      totalProtein += log.protein;
      totalFat += log.fat;
      totalCalories += log.calories;
      count++;
    }

    if (count === 0) {
      const err = new Error('no valid food logs found for the given IDs');
      err.code = 'invalid_request';
      throw err;
    }
    if (count !== uniqueIds.length) {
      const err = new Error('could not find all requested food logs; some may be deleted');
      err.code = 'invalid_request';
      throw err;
    }
    if (totalWeight <= 0) {
      const err = new Error('total weight must be greater than 0');
      err.code = 'invalid_request';
      throw err;
    }

    const mult = 100 / totalWeight;
    const product = await upsertProductByName({
      name,
      carbs_100g: totalCarbs * mult,
      protein_100g: totalProtein * mult,
      fat_100g: totalFat * mult,
      energy_kcal_100g: totalCalories * mult,
      is_meal: true,
      total_weight_g: totalWeight,
    });
    return toProductResponse(product);
  }

  // search mirrors handleSearchFoodProducts (food_handlers.go:946): local
  // products always searched; `remote` additionally merges the injected
  // foodDb port (Task 5 supplies the real browser implementation).
  async function search(q, { remote = false } = {}) {
    const query = (q || '').trim();
    if (query.length < 2) return [];

    const all = await records.list(PRODUCT_RECORD_TYPE);
    const needle = query.toLowerCase();
    const local = all
      .filter((p) => !p.deleted)
      .filter((p) => p.name.toLowerCase().includes(needle) || (p.barcode || '').toLowerCase().includes(needle))
      .sort((a, b) => {
        if (!!b.is_meal !== !!a.is_meal) return (b.is_meal ? 1 : 0) - (a.is_meal ? 1 : 0);
        if (b.usage_count !== a.usage_count) return b.usage_count - a.usage_count;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 50)
      .map(toProductResponse);

    if (!remote || !foodDb) return local;

    let apiProducts = [];
    try {
      apiProducts = await foodDb.search(query);
    } catch {
      return local;
    }
    if (!apiProducts.length) return local;
    return mergeProducts(local, apiProducts);
  }

  return {
    create,
    update,
    remove,
    listGrouped,
    stats,
    listProducts,
    updateProduct,
    removeProduct,
    createMealFromLogs,
    search,
  };
}
