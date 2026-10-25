// Apple Health record identity (bd med-w6gx.6), split out of healthimport.js so
// bp.js / weight.js can use it without an import cycle (healthimport → bp/weight).

export const HEALTH_SOURCE = 'apple_health';

// HKObject.uuid.uuidString — also keeps the recordId free of anything odd.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function healthRecordId(kind, uuid) {
  return `${kind}-hk-${String(uuid).toLowerCase()}`;
}

// The recordId an imported body maps back to (vault restore re-mints leaf ids),
// or null for anything that did not come from Apple Health.
// A Health sleep record is keyed by its sleep day (YYYY-MM-DD, healthimport.js
// importSleep), every other kind by the sample UUID.
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function healthImportRecordId(kind, body) {
  if (!body || body.source !== HEALTH_SOURCE) return null;
  const ok = kind === 'sleep' ? DAY_RE.test(body.source_id) : UUID_RE.test(body.source_id);
  return ok ? healthRecordId(kind, body.source_id) : null;
}

// deleteHealthAlias: a Health row restored by an older client sits under a
// fresh id; its delete tombstone carries no source_id, so a full rescan would
// re-create the canonical row. Tombstone the canonical slot too.
export async function deleteHealthAlias(records, kind, row) {
  const canonical = healthImportRecordId(kind, row);
  if (canonical && canonical !== row.recordId) await records.del(kind, canonical);
}

// displaceHealthSleep (bd med-w6gx.31): a non-Health night (Mi Band, manual)
// beats an Apple Health sleep day it overlaps, whatever the arrival order.
// healthimport.js importSleep skips a day overlapping a night already there;
// this is the other order. `rows` are live sleep rows; every Health day (alias
// included) overlapping [startMs, endMs) is tombstoned — records.del, a real
// write that outranks the day's clientTs-0 floor on every device — so the
// importer's exists check keeps it out on rescan. Returns the rows left.
// Every future non-Health sleep writer calls this after its write.
export async function displaceHealthSleep(records, rows, startMs, endMs) {
  const left = [];
  for (const r of rows) {
    const hit = !r.deleted && healthImportRecordId('sleep', r)
      && Date.parse(r.start_time) < endMs && startMs < Date.parse(r.end_time);
    if (!hit) { left.push(r); continue; }
    await records.del('sleep', r.recordId);
    await deleteHealthAlias(records, 'sleep', r);
  }
  return left;
}

// The body `id` of an imported Health workout (miband record, bd med-w6gx.7):
// the edit/delete routes key on it, so it must be the same on every device and
// after a restore. It must never equal another miband row's id (delete and
// edit find the row by it), so it lives in its own band: 1e14 + the UUID's
// last 48 bits (random in HealthKit's v4 UUIDs), i.e. [1e14, 1e14 + 2^48) ≈
// [1.0e14, 3.8e14]. Every other miband id is either a Mi Band start time in
// epoch ms (vitals.js / vault.js: < 1e14 until the year 5138), a bot-era small
// integer, or workout.js mintNumericId(startMs * 1000) (≥ 3.8e14 for any
// start after 1982). The band stays far below Number.MAX_SAFE_INTEGER, and it
// sits below mint, so mint's localMax + 1 fallback never climbs into it.
export const HEALTH_ID_BASE = 1e14;

export function healthNumericId(uuid) {
  return HEALTH_ID_BASE + parseInt(String(uuid).slice(-12), 16);
}
