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
// A sleep record is keyed by its sleep day (YYYY-MM-DD): a Health day
// (healthimport.js importSleep) and a converted Mi Band day (unifySleep below,
// source 'miband') alike, so it keys on the day-shaped source_id, not the
// source. Every other kind is a Health sample keyed by its UUID.
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function healthImportRecordId(kind, body) {
  if (!body) return null;
  if (kind === 'sleep') return DAY_RE.test(body.source_id) ? healthRecordId(kind, body.source_id) : null;
  if (body.source !== HEALTH_SOURCE) return null;
  return UUID_RE.test(body.source_id) ? healthRecordId(kind, body.source_id) : null;
}

// A sleep day runs from 18:00 to 18:00 local, by when a night ENDS: a night
// ending 07:00 belongs to that date (its wake day), a nap at 15:00 to the
// same one, a night still going at 18:00 to the next. The one boundary
// function: healthimport.js files Health days by it, visibleSleep groups by it.
const SLEEP_DAY_SHIFT_MS = 6 * 3_600_000;

// sleepDayOf(endMs, offsetMs east of UTC) → 'YYYY-MM-DD'.
export function sleepDayOf(endMs, offsetMs) {
  return new Date(endMs + offsetMs + SLEEP_DAY_SHIFT_MS).toISOString().slice(0, 10);
}

// A sleep row's timezone_offset → ms east of UTC. Stored as minutes WEST,
// except bot-era rows (bot mode until 2026-07-03, nxk.go) that kept Zepp's
// SECONDS EAST and can reach the cloud through a vault restore. A real minute
// offset never exceeds 840 (UTC+14), so anything larger is seconds east.
function recordOffsetMs(tz) {
  const v = Number(tz) || 0;
  return Math.abs(v) > 840 ? v * 1000 : -v * 60_000;
}

// asleepMinutes: minutes actually asleep, so two sources compare like with
// like. A Health day's total_minutes is asleep-only already (healthimport.js
// excludes In Bed and awake), so it is taken as is. A Mi Band total is the
// Zepp column copied verbatim and may include awake time: light + deep + rem
// when any phase is present, else total − awake, else total.
function asleepMinutes(r) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (healthImportRecordId('sleep', r)) return n(r.total_minutes) || 0;
  const [light, deep, rem] = [n(r.light_minutes), n(r.deep_minutes), n(r.rem_minutes)];
  if (light !== null || deep !== null || rem !== null) return (light || 0) + (deep || 0) + (rem || 0);
  const total = n(r.total_minutes) || 0;
  const awake = n(r.awake_minutes);
  return awake !== null ? total - awake : total;
}

// visibleSleep (bd med-w6gx.31): the live sleep rows every reader shows. An
// Apple Health day and a non-Health night (Mi Band) can describe the same
// night; nothing is deleted on import, the read picks. Per sleep day
// (sleepDayOf of each row's own end and timezone_offset, minutes west), a day
// holding both shows one source: the more asleep minutes (the non-Health side
// summed over its sessions), a tie to the non-Health device. The loser is
// hidden, never deleted, so a fuller later .nxk flips the day by itself.
export function visibleSleep(rows) {
  const days = new Map(); // day -> { health: [], other: [] }
  for (const r of rows) {
    const end = Date.parse(r.end_time);
    if (r.deleted || !Number.isFinite(end)) continue;
    const day = sleepDayOf(end, recordOffsetMs(r.timezone_offset));
    if (!days.has(day)) days.set(day, { health: [], other: [] });
    days.get(day)[healthImportRecordId('sleep', r) ? 'health' : 'other'].push(r);
  }
  const hidden = new Set();
  const sum = (list) => list.reduce((a, r) => a + asleepMinutes(r), 0);
  for (const { health, other } of days.values()) {
    if (!health.length || !other.length) continue;
    for (const r of sum(health) > sum(other) ? other : health) hidden.add(r);
  }
  return rows.filter((r) => !r.deleted && !hidden.has(r));
}

const DAY_ROW_ID = /^sleep-hk-\d{4}-\d{2}-\d{2}$/;

// unifySleep (bd med-0xad.4) → { puts, dels }: the one-off conversion of
// legacy sleep rows (every live row not at a sleep-hk-<day> id: Mi Band
// sessions, bot-era rows, restores by older clients) into one day row per
// sleep day, the shape healthimport.js writes. Per day, the converted body
// goes to sleep-hk-<day> unless a live row already there has more asleep
// minutes (a tie: see below); either way every legacy row of the day is
// deleted. A row without a parseable end_time is no night and stays. No
// legacy rows → nothing to do, so a second run writes nothing.
export function unifySleep(rows) {
  const live = rows.filter((r) => !r.deleted);
  const byId = new Map(live.map((r) => [r.recordId, r]));
  const days = new Map();
  for (const r of live) {
    const end = Date.parse(r.end_time);
    if (DAY_ROW_ID.test(r.recordId) || !Number.isFinite(end)) continue;
    const day = sleepDayOf(end, recordOffsetMs(r.timezone_offset));
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(r);
  }
  const puts = [];
  const dels = [];
  for (const day of [...days.keys()].sort()) {
    const sessions = days.get(day);
    // A Health day restored under a fresh id is one source, the band
    // sessions another: fold each on its own and keep one, by visibleSleep's
    // rule (more asleep minutes, a tie to the band), never their sum.
    const health = sessions.filter((r) => healthImportRecordId('sleep', r));
    const other = sessions.filter((r) => !healthImportRecordId('sleep', r));
    const bodies = [health, other].filter((g) => g.length).map((g) => sleepDayBody(day, g));
    const body = bodies.length === 2 && asleepMinutes(bodies[0]) <= asleepMinutes(bodies[1]) ? bodies[1] : bodies[0];
    const have = byId.get(body.recordId);
    // A tie against a Health day goes to the converted sessions, as
    // visibleSleep shows it today; against an earlier conversion (equal
    // minutes, same rows) the existing row stays.
    const mine = asleepMinutes(body);
    const theirs = have ? asleepMinutes(have) : -1;
    if (mine > theirs || (mine === theirs && have.source === HEALTH_SOURCE)) puts.push(body);
    for (const r of sessions) dels.push(r.recordId);
  }
  return { puts, dels };
}

// One day's body from its legacy sessions; built from the rows alone, so every
// device converting the same rows writes the same bytes.
function sleepDayBody(day, sessions) {
  const startOf = (r) => { const s = Date.parse(r.start_time); return Number.isFinite(s) ? s : Date.parse(r.end_time); };
  const list = [...sessions].sort((a, b) => startOf(a) - startOf(b) || Date.parse(a.end_time) - Date.parse(b.end_time)
    || String(a.recordId).localeCompare(String(b.recordId)));
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const sum = (k) => {
    const vals = list.map((r) => num(r[k])).filter((v) => v !== null);
    return vals.length ? vals.reduce((a, v) => a + v, 0) : null;
  };
  // Averages weighted by session length.
  const weighted = (k) => {
    let w = 0;
    let acc = 0;
    for (const r of list) {
      const v = num(r[k]);
      if (v === null) continue;
      const d = Math.max(Date.parse(r.end_time) - startOf(r), 0) || 1;
      w += d;
      acc += v * d;
    }
    return w ? Math.round(acc / w) : null;
  };
  const first = list[0];
  const last = list.reduce((a, r) => (Date.parse(r.end_time) > Date.parse(a.end_time) ? r : a));
  const notes = list.map((r) => r.notes).filter((n) => typeof n === 'string' && n.trim()).join('\n');
  return {
    recordId: healthRecordId('sleep', day),
    start_time: Number.isFinite(Date.parse(first.start_time)) ? first.start_time : first.end_time,
    end_time: last.end_time,
    // Minutes west of UTC, as healthimport.js stores it.
    timezone_offset: -Math.round(recordOffsetMs(last.timezone_offset) / 60_000) || 0,
    day,
    light_minutes: sum('light_minutes'),
    deep_minutes: sum('deep_minutes'),
    rem_minutes: sum('rem_minutes'),
    awake_minutes: sum('awake_minutes'),
    total_minutes: list.reduce((a, r) => a + asleepMinutes(r), 0),
    turn_over_count: sum('turn_over_count'),
    heart_rate_avg: weighted('heart_rate_avg'),
    spo2_avg: weighted('spo2_avg'),
    user_modified: list.some((r) => !!r.user_modified),
    notes,
    // A Health day an older client restored under a fresh id stays Health.
    source: list.every((r) => r.source === HEALTH_SOURCE) ? HEALTH_SOURCE : 'miband',
    source_id: day,
  };
}

// deleteHealthAlias: a Health row restored by an older client sits under a
// fresh id; its delete tombstone carries no source_id, so a full rescan would
// re-create the canonical row. Tombstone the canonical slot too.
export async function deleteHealthAlias(records, kind, row) {
  const canonical = healthImportRecordId(kind, row);
  if (canonical && canonical !== row.recordId) await records.del(kind, canonical);
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
