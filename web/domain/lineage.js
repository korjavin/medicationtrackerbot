// Dose lineage across a timezone change or a schedule edit (bd med-wi09.10,
// epic med-wi09 Phase 2 (b)). Pure: no records port except loadLineage.
//
// boundary({oldGen, newGen, switchAt, evidence}) pairs the two generations'
// occurrences over ±36 h around the switch (wide enough for UTC+14 ↔ UTC−12).
// A logical slot is (med, HH:MM, old-epoch local date); its old instant pairs
// with the new generation's occurrence at the same HH:MM on the same local
// date (in the new zone). Per slot, in order:
//   1. the old instant has evidence (TAKEN / SKIPPED / tombstone) → keep it,
//      no replacement (the partner is cancelled, aliased to the kept dose);
//   2. old instant before the switch → keep old (it was real);
//   3. new instant after the switch → old cancelled, replacement = new;
//   4. else (old after, new before) → keep old.
// An old slot with no same-time partner (a schedule edit 08:00→20:00 made
// before 08:00) that is after the switch is cancelled; its replacement is the
// first new occurrence after it on the same old-zone local date, else none.
// One before the switch on the switch's own date is replaced the same way when
// untaken (08:00 → 20:00 at 10:00: today's 08:00 gives way to today's 20:00);
// logged, it stays and today's first new occurrence is cancelled into it.
// Output per med: {medId, kept, cancelled, replacement} — `replacement` maps
// every cancelled occId to its canonical occId (null = no replacement). It is
// stored on the tztransition / medsched record at approve/edit time; the
// projection resolves evidence through it (applyLineage), never by nearness.
//
// ponytail: an APPROVED plan still in progress when the zone changes again is
// not part of oldGen (its steps are not paired); the newer plan's steps are.
import {
  parseSchedule, parseTimeOfDay, localDateParts, localDateTimeParts, localWallToUtcMs, sortByEffective,
} from './medschedule.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const LINEAGE_WINDOW_MS = 36 * HOUR_MS;
const PREVIEW_AHEAD_MS = 48 * HOUR_MS;

const sameMed = (a, b) => String(a) === String(b);
const pad2 = (n) => String(n).padStart(2, '0');
// Same id as medintake.js's slotId — the deterministic intake id.
const slotId = (medId, ms) => `intake-${medId}-${Math.floor(ms / 1000)}`;
const SLOT_RE = /^intake-(.+)-(\d+)(?:-tz_step)?$/;

// Stored intake rows (RAW, tombstones included) → slot id → evidence. Keyed by
// (med, scheduled second), not recordId: an imported tz_step row carries a
// `-tz_step` suffix. Manual logs are not slots.
export function evidenceMap(intakes = []) {
  const ev = new Map();
  for (const i of intakes) {
    if (!i || i.deleted || (i.status !== 'TAKEN' && i.status !== 'SKIPPED')) continue;
    if (String(i.recordId).startsWith('intake-manual-')) continue;
    const ms = Date.parse(i.scheduled_at);
    if (Number.isFinite(ms)) ev.set(slotId(i.medication_id, ms), i.status === 'TAKEN' ? 'taken' : 'skipped');
  }
  for (const i of intakes) {
    if (!i || !i.deleted || String(i.recordId).startsWith('intake-manual-')) continue;
    const m = SLOT_RE.exec(String(i.recordId));
    if (m && !ev.has(`intake-${m[1]}-${m[2]}`)) ev.set(`intake-${m[1]}-${m[2]}`, 'tombstone');
  }
  return ev;
}

// A generation's occurrences in [fromMs, toMs]: normal slots in gen.timeZone
// (wall clock via localWallToUtcMs — the planner's own DST policy, so the ids
// match the materializer's), and gen.steps (a tz plan) in place of a med's
// normal slots up to its last step, as planDosesWithTzPlan does.
function occurrences(gen, fromMs, toMs) {
  const tz = gen.timeZone;
  const steps = Array.isArray(gen.steps) ? gen.steps : [];
  const start = localDateParts(fromMs - DAY_MS, tz);
  const days = Math.ceil((toMs - fromMs) / DAY_MS) + 3;
  const out = [];
  for (const med of gen.medications || []) {
    if (!med || med.deleted || med.archived) continue;
    const cfg = parseSchedule(med.schedule);
    if (!cfg || cfg.type === 'as_needed') continue;
    const medId = med.recordId ?? med.id;
    const startMs = med.start_date ? Date.parse(med.start_date) : -Infinity;
    const endMs = med.end_date ? Date.parse(med.end_date) : Infinity;
    const inRange = (at) => at >= fromMs && at <= toMs && at >= startMs && at <= endMs;
    const own = steps.filter((s) => sameMed(s.medicationId, medId));
    const lastStep = own.reduce((m, s) => Math.max(m, s.scheduledAtMs), -Infinity);
    for (let d = 0; d < days; d++) {
      const day = new Date(Date.UTC(start.year, start.month - 1, start.day + d));
      if (cfg.type === 'weekly' && !cfg.days.includes(day.getUTCDay())) continue;
      for (const t of cfg.times) {
        const hm = parseTimeOfDay(t);
        if (!hm) continue;
        const at = localWallToUtcMs(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hm.hour, hm.minute), tz);
        if (!inRange(at) || at <= lastStep) continue;
        out.push({
          occId: slotId(medId, at), medId, at, tz, localDate: day.toISOString().slice(0, 10), localTime: t, source: 'schedule',
        });
      }
    }
    for (const s of own) {
      if (!inRange(s.scheduledAtMs)) continue;
      const p = localDateTimeParts(s.scheduledAtMs, tz);
      out.push({
        occId: slotId(medId, s.scheduledAtMs),
        medId,
        at: s.scheduledAtMs,
        tz,
        localDate: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`,
        localTime: `${pad2(p.hour)}:${pad2(p.minute)}`,
        source: 'tz_step',
        stepNumber: s.stepNumber,
        totalSteps: s.totalSteps,
        ...(s.note ? { note: s.note } : {}),
      });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

function localDateIn(ms, tz) {
  const p = localDateParts(ms, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

// Decides every slot; marks olds/news in place.
function resolve({
  oldGen, newGen, switchAt, evidence = [], fromMs = switchAt - LINEAGE_WINDOW_MS, toMs = switchAt + LINEAGE_WINDOW_MS,
}) {
  const ev = evidenceMap(evidence);
  const olds = occurrences(oldGen, fromMs, toMs);
  // Two days of slack each side: the same wall time on the same local date can
  // sit up to 26 h away in the other zone (UTC+14 ↔ UTC−12), and a fallback
  // replacement may lie past the window's edge.
  const news = occurrences(newGen, fromMs - 2 * DAY_MS, toMs + 2 * DAY_MS);
  const used = new Set();
  const key = (o) => `${o.medId}|${o.localTime}|${o.localDate}`;
  const byKey = new Map(news.map((n) => [key(n), n]));
  const cancelNew = (n, keptOld) => {
    n.state = 'cancelled';
    n.replacement = keptOld.occId;
    keptOld.partnerAt = n.at;
  };

  // A slot with no same-time partner earlier on the switch's own local date
  // (a time edit 08:00 → 20:00 made at 10:00): untaken, it is cancelled and
  // today's new time replaces it (second loop); logged, it is kept and today's
  // new time is cancelled into it — one dose per slot per day either way.
  const switchDate = localDateIn(switchAt, oldGen.timeZone);
  const sameDayNew = (o) => news.find((x) => !used.has(x.occId) && sameMed(x.medId, o.medId) && x.at >= switchAt
    && localDateIn(x.at, oldGen.timeZone) === o.localDate);
  const loggedToday = [];
  for (const o of olds) {
    o.evidence = ev.get(o.occId) || null;
    let n = byKey.get(key(o));
    if (n && used.has(n.occId)) n = null;
    if (n) used.add(n.occId);
    if (n && n.occId === o.occId) {
      o.state = 'kept';
      n.state = 'kept';
    } else if (!n && o.at < switchAt && o.localDate === switchDate) {
      if (o.evidence) {
        o.state = 'kept';
        loggedToday.push(o);
      }
    } else if (o.evidence || o.at < switchAt) {
      o.state = 'kept';
      if (n) cancelNew(n, o);
    } else if (n && n.at >= switchAt) {
      o.state = 'cancelled';
      o.replacement = n.occId;
      n.state = 'kept';
      n.replaces = o.occId;
    } else if (n) {
      o.state = 'kept';
      cancelNew(n, o);
    }
  }
  for (const o of loggedToday) {
    const n = sameDayNew(o);
    if (n) {
      used.add(n.occId);
      cancelNew(n, o);
    }
  }
  for (const o of olds) {
    if (o.state) continue;
    const n = news.find((x) => !used.has(x.occId) && sameMed(x.medId, o.medId) && x.at > o.at && x.at >= switchAt
      && localDateIn(x.at, oldGen.timeZone) === o.localDate);
    o.state = 'cancelled';
    o.replacement = n ? n.occId : null;
    if (n) {
      used.add(n.occId);
      n.state = 'kept';
      n.replaces = o.occId;
    }
  }
  // A new-only occurrence exists from the switch on; before it, it never did.
  for (const n of news) if (!n.state && n.at >= switchAt) n.state = 'kept';
  // One id is one instant (intake-<med>-<sec>), so two slots can't share one.
  // Times 08:00 + 11:00 moving UTC → UTC+3 put the new 11:00 on the kept old
  // 08:00's instant: the 11:00 slot keeps its old instant instead of folding
  // into the 08:00 dose. And an instant standing on either side is never
  // cancelled by the other.
  const keptOld = new Set(olds.filter((o) => o.state === 'kept').map((o) => o.occId));
  for (const o of olds) {
    if (o.state !== 'cancelled' || !keptOld.has(o.replacement)) continue;
    o.state = 'kept';
    delete o.replacement;
  }
  const standing = new Set([...olds, ...news].filter((o) => o.state === 'kept').map((o) => o.occId));
  for (const o of [...olds, ...news]) if (o.state === 'cancelled' && standing.has(o.occId)) o.state = 'kept';
  for (const n of news) {
    if (n.replaces && !olds.some((o) => o.occId === n.replaces && o.state === 'cancelled')) delete n.replaces;
  }
  // Worth listing: what stands from the switch on, or what cancels a twin
  // that would have stood from it.
  for (const o of olds) o.shown = o.at >= switchAt || (o.partnerAt ?? -Infinity) >= switchAt;
  return { olds, news };
}

export function boundary(args) {
  const { olds, news } = resolve(args);
  const meds = new Map();
  const entry = (medId) => {
    const k = String(medId);
    if (!meds.has(k)) meds.set(k, { medId, kept: [], cancelled: [], replacement: {} });
    return meds.get(k);
  };
  for (const o of olds) {
    if (o.state === 'kept' && o.shown) entry(o.medId).kept.push(o.occId);
  }
  for (const o of [...olds, ...news]) {
    if (o.state !== 'cancelled') continue;
    entry(o.medId).cancelled.push(o.occId);
    entry(o.medId).replacement[o.occId] = o.replacement;
  }
  return [...meds.values()].filter((e) => e.cancelled.length > 0);
}

// MT7 preview: Before (current zone/schedule) and After (if applied) for the
// next 48 h from the switch. Before marks `moves` (same wall time, new
// instant), `cancelled`, or `kept` (has evidence); After marks `moved` /
// `replaces` (naming the cancelled occId) or `kept`. An old dose already
// logged that cancels its new twin shows in both lists even though it is in
// the past — "Taken · kept", no replacement.
export function transitionPreview(args) {
  const toMs = args.switchAt + PREVIEW_AHEAD_MS;
  const { olds, news } = resolve({ ...args, toMs });
  const byId = new Map(olds.map((o) => [o.occId, o]));
  const newById = new Map(news.map((n) => [n.occId, n]));
  const row = (o, mark, extra) => {
    const out = {
      occId: o.occId,
      medId: o.medId,
      plannedAt: new Date(o.at).toISOString(),
      tz: o.tz,
      localDate: o.localDate,
      localTime: o.localTime,
      source: o.source,
      mark,
      ...extra,
    };
    if (o.evidence) out.evidence = o.evidence;
    if (o.stepNumber) Object.assign(out, { stepNumber: o.stepNumber, totalSteps: o.totalSteps });
    if (o.note) out.stepNote = o.note;
    return out;
  };
  const before = olds.filter((o) => o.shown).map((o) => {
    if (o.state === 'cancelled') {
      const r = o.replacement && newById.get(o.replacement);
      return row(o, r && r.localTime === o.localTime ? 'moves' : 'cancelled', { replacement: o.replacement });
    }
    return row(o, o.evidence ? 'kept' : null);
  });
  const keptOlds = olds.filter((o) => o.state === 'kept' && o.shown);
  const keptIds = new Set(keptOlds.map((o) => o.occId));
  const after = keptOlds.map((o) => row(o, o.evidence ? 'kept' : null))
    .concat(news.filter((n) => n.state === 'kept' && n.at >= args.switchAt && n.at <= toMs && !keptIds.has(n.occId)).map((n) => {
      if (!n.replaces) return row(n, null);
      const was = byId.get(n.replaces);
      return row(n, was && was.localTime === n.localTime ? 'moved' : 'replaces', { replaces: n.replaces });
    }))
    .sort((a, b) => Date.parse(a.plannedAt) - Date.parse(b.plannedAt));
  return { before, after };
}

// Every stored boundary, in effective order, folded into one alias table
// cancelledOccId → canonical occId | null. A later boundary that keeps or
// replaces INTO an id revives it (back-and-forth zone changes), so a newer
// decision always wins over an older one.
export function lineageTable(historyRows = []) {
  const rows = historyRows
    .filter((r) => r && !r.deleted && Array.isArray(r.boundary))
    .map((r) => ({ t: Date.parse(r.switch_at ?? r.from), r }))
    .sort((a, b) => (a.t - b.t) || (String(a.r.recordId) < String(b.r.recordId) ? -1 : 1));
  const table = new Map();
  for (const { r } of rows) {
    for (const e of r.boundary) {
      for (const id of e.kept || []) table.delete(id);
      for (const [c, k] of Object.entries(e.replacement || {})) {
        if (k) table.delete(k);
        table.set(c, k ?? null);
      }
    }
  }
  return table;
}

export async function loadLineage(records) {
  const [tz, ms] = await Promise.all([records.list('tztransition'), records.list('medsched')]);
  return lineageTable([...tz, ...ms]);
}

// Regenerated occurrences (bd med-wi09.12): the doses the schedule in force at
// each instant produced over [fromMs, toMs]. History (tztransition + medsched)
// cuts the range into segments at every change; a segment is planned with the
// zone, each med's schedule and the tz-plan steps in force at its start. An
// old-generation instant a boundary KEPT past its switch (rule 4: old after the
// switch, new before it) is regenerated as well — the segment split alone would
// drop it. Past instants only, plus those kept ones (they can sit up to the
// window ahead of a switch); the forecast owns the rest of the future. A med
// regenerates nothing before its created_at. Tombstones and evidence are the
// projection's business, not this function's.
// ponytail: cost grows with days since the ledger cut (one Intl pass per slot);
// memoize on the records change count if a long-lived vault makes it show.
//
// `tzPlan` (the current APPROVED plan, or null) adds its steps from its
// approval on: a plan approved before history existed has no tztransition
// carrying them.
export function regenerate({
  medications = [], scheds = [], transitions = [], timeZone, fromMs, toMs, nowMs, tzPlan = null,
}) {
  const plan = tzPlan && tzPlan.status === 'APPROVED' && Array.isArray(tzPlan.steps) ? tzPlan : null;
  const planFrom = plan ? (Date.parse(plan.approved_at || plan.created_at) || 0) : Infinity;
  const end = Math.min(toMs, nowMs + LINEAGE_WINDOW_MS);
  if (!(Number.isFinite(fromMs) && end >= fromMs)) return [];
  const tr = sortByEffective(transitions, 'switch_at');
  const sc = sortByEffective(scheds, 'from');
  const kept = new Set();
  for (const r of [...tr, ...sc]) {
    for (const e of Array.isArray(r.boundary) ? r.boundary : []) for (const id of e.kept || []) kept.add(id);
  }
  // Segments start one window early: a kept old-generation instant inside
  // [fromMs, end] can come from a switch up to the window before fromMs, and
  // only the pre-switch generation enumerates it.
  const start = fromMs - LINEAGE_WINDOW_MS;
  const changes = [...tr.map((r) => Date.parse(r.switch_at)), ...sc.map((r) => Date.parse(r.from))]
    .filter((t) => t > start && t <= end);
  const bounds = [start, ...[...new Set(changes)].sort((a, b) => a - b), end + 1];
  const lastAt = (rows, key, at) => rows.filter((r) => Date.parse(r[key]) <= at).pop();
  const createdMs = new Map(medications.map((m) => [String(m.recordId ?? m.id), m.created_at ? Date.parse(m.created_at) : -Infinity]));
  // Archiving (medications.js writes a medsched row with `archived` at each
  // flip) cancels every open dose of the med, as the old archive path
  // tombstoned every PENDING row, and nothing is due while archived. A
  // regenerated occurrence is open by definition (a stored row would occupy
  // its id), so: dropped when the med is archived at its instant or archived
  // again later. A med archived before these rows existed has none: all of
  // its occurrences go while it stays archived.
  const archiveRows = new Map(medications.map((m) => [String(m.recordId ?? m.id),
    sc.filter((h) => sameMed(h.medication_id, m.recordId ?? m.id) && typeof h.archived === 'boolean')]));
  const archivedFor = new Map(medications.map((m) => [String(m.recordId ?? m.id), !!m.archived]));
  const cancelledByArchive = (o) => {
    const rows = archiveRows.get(String(o.medId)) || [];
    if (rows.length === 0) return archivedFor.get(String(o.medId)) === true;
    const at = lastAt(rows, 'from', o.at);
    return (at && at.archived) || rows.some((h) => h.archived && Date.parse(h.from) > o.at);
  };
  const out = new Map();
  for (let s = 0; s < bounds.length - 1; s++) {
    const [a, b] = [bounds[s], bounds[s + 1]];
    const t = lastAt(tr, 'switch_at', a);
    const steps = new Map();
    for (const st of [...(t && Array.isArray(t.steps) ? t.steps : []), ...(a >= planFrom ? plan.steps : [])]) {
      steps.set(`${st.medicationId}-${st.scheduledAtMs}`, st);
    }
    const gen = {
      timeZone: t ? t.new_tz : (tr[0] ? tr[0].old_tz : timeZone),
      steps: [...steps.values()],
      medications: medications.map((m) => {
        const own = sc.filter((h) => sameMed(h.medication_id, m.recordId ?? m.id));
        const h = lastAt(own, 'from', a) || own[0];
        return h ? { ...m, schedule: h.schedule, tz_shift_policy: h.tz_shift_policy } : m;
      }),
    };
    for (const o of occurrences(gen, a, Math.min(b - 1 + LINEAGE_WINDOW_MS, end))) {
      const inSegment = o.at < b && o.at <= nowMs;
      if (o.at < fromMs || !(inSegment || kept.has(o.occId)) || out.has(o.occId)) continue;
      if (o.at < (createdMs.get(String(o.medId)) ?? -Infinity) || cancelledByArchive(o)) continue;
      out.set(o.occId, o);
    }
  }
  return [...out.values()].sort((x, y) => x.at - y.at);
}

// The zone of each past local day, for an account with no tztransition
// history (bd med-wi09.12, Archie's rule): never the device clock. A day with
// tz-stamped evidence (acted() stamps `tz`) is that zone — the newest row wins;
// a day without carries the zone of the nearest earlier evidence row; before
// any, `timeZone` (the pinned zone, else the device's). Returned as in-memory
// pseudo-transitions at local midnight wherever the zone changes — no
// boundary, no steps, never written. `legacyDays` ({date, from, to}): past
// days whose only evidence carries no tz (an old client's row) — the stored
// rows are that whole day, as before the cut: nothing is regenerated on it,
// and the old client's own PENDING rows stand.
const legacyDaysSeen = new Set();
export function evidenceTransitions(intakes, timeZone, fromMs, nowMs) {
  const days = new Map();
  const legacyMs = [];
  let before = null;
  for (const i of intakes) {
    if (!i || i.deleted || String(i.recordId).startsWith('intake-manual-')) continue;
    const ms = Date.parse(i.scheduled_at);
    if (!Number.isFinite(ms) || ms > nowMs) continue;
    if (!i.tz) {
      if (ms >= fromMs && (i.status === 'TAKEN' || i.status === 'SKIPPED')) legacyMs.push(ms);
      continue;
    }
    const ts = i.clientTs || 0;
    if (ms < fromMs) {
      if (!before || ms > before.ms) before = { ms, tz: i.tz };
      continue;
    }
    const date = localDateIn(ms, i.tz);
    const cur = days.get(date);
    if (!cur || ts > cur.ts) days.set(date, { tz: i.tz, ts, date });
  }
  const transitions = [];
  let zone = before ? before.tz : timeZone;
  for (const d of [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (d.tz === zone) continue;
    const [y, m, day] = d.date.split('-').map(Number);
    transitions.push({ switch_at: new Date(localWallToUtcMs(Date.UTC(y, m - 1, day), d.tz)).toISOString(), old_tz: zone, new_tz: d.tz });
    zone = d.tz;
  }
  const zoneAt = (ms) => {
    let z = before ? before.tz : timeZone;
    for (const t of transitions) if (Date.parse(t.switch_at) <= ms) z = t.new_tz;
    return z;
  };
  const legacy = new Map();
  for (const ms of legacyMs) {
    const z = zoneAt(ms);
    const date = localDateIn(ms, z);
    if (days.has(date) || legacy.has(date)) continue;
    const [y, m, day] = date.split('-').map(Number);
    legacy.set(date, {
      date, from: localWallToUtcMs(Date.UTC(y, m - 1, day), z), to: localWallToUtcMs(Date.UTC(y, m - 1, day + 1), z) - 1,
    });
    if (!legacyDaysSeen.has(date)) {
      legacyDaysSeen.add(date);
      console.info(`[ledger] legacy-evidence day ${date}: stored rows stand for the whole day (${legacyDaysSeen.size} so far)`);
    }
  }
  return { transitions, legacyDays: [...legacy.values()], initialZone: before ? before.tz : timeZone };
}

// regenerate() over [fromMs, toMs] the way every reader asks for it (bd
// med-wi09.12): from the ledger cut on (before it, stored rows are the
// truth), each past day in its evidence zone when there is no tztransition
// history. The settled past — up to the last whole hour — is memoized on its
// inputs, so a read after a write re-plans only what the write could change;
// the window is floored to a UTC day so one caller's sliding window keeps
// hitting. Segments start one LINEAGE_WINDOW_MS early, so the two halves'
// union is exactly one regenerate() over the whole range. Returns the
// occurrences and the legacy days (evidenceTransitions) the projection must
// read as stored-rows-only.
// ponytail: the memo keys on a JSON of the history rows (small) and holds the
// last 16 windows; key on the records change count if that ever shows.
const pastMemo = new Map();
export function regenerateWindow({
  medications = [], scheds = [], transitions = [], intakes = [], tzPlan = null, timeZone, cutMs = null, fromMs, toMs, nowMs,
}) {
  const from = Math.max(fromMs, cutMs ?? nowMs);
  if (!(from <= toMs)) return { occurrences: [], legacyDays: [] };
  let tr = transitions.filter((t) => t && !t.deleted);
  let legacyDays = [];
  if (tr.length === 0) {
    const ev = evidenceTransitions(intakes, timeZone, cutMs ?? nowMs, nowMs);
    tr = ev.transitions;
    legacyDays = ev.legacyDays;
    timeZone = ev.initialZone;
  }
  const args = { medications, scheds, transitions: tr, tzPlan, timeZone };
  const pastEnd = Math.floor(nowMs / HOUR_MS) * HOUR_MS - 1;
  const out = new Map();
  if (from <= pastEnd) {
    const memoFrom = Math.max(cutMs ?? -Infinity, Math.floor(from / DAY_MS) * DAY_MS);
    const key = JSON.stringify([args, memoFrom, pastEnd]);
    let past = pastMemo.get(key);
    if (!past) {
      past = regenerate({ ...args, fromMs: memoFrom, toMs: pastEnd, nowMs: pastEnd });
      if (pastMemo.size >= 16) pastMemo.delete(pastMemo.keys().next().value);
      pastMemo.set(key, past);
    }
    for (const o of past) if (o.at >= from && o.at <= toMs) out.set(o.occId, o);
  }
  for (const o of regenerate({ ...args, fromMs: Math.max(from, pastEnd + 1), toMs, nowMs })) out.set(o.occId, o);
  const occurrences = [...out.values()]
    .filter((o) => !(o.at <= nowMs && legacyDays.some((d) => o.at >= d.from && o.at <= d.to)))
    .sort((x, y) => x.at - y.at);
  return { occurrences, legacyDays };
}

function canonical(table, id) {
  let k = table.get(id);
  const seen = new Set([id]);
  while (k && table.has(k) && !seen.has(k)) {
    seen.add(k);
    k = table.get(k);
  }
  return k && seen.has(k) ? null : (k ?? null);
}

// Projection pass over projectOccurrences' rows. Per cancelled id C with
// canonical K: no evidence at C → C's row is hidden (when K is listed or
// there is no K); evidence at C and at K →
// both rows stay, flagged `loggedTwice` (the partner's occId), never settled;
// evidence at C only → C's row is the dose and K's row is hidden (one row, one
// consumption). `intakes` RAW, so a tombstone counts as evidence.
export function applyLineage(rows, table, intakes = []) {
  if (!table || table.size === 0) return rows;
  const ev = evidenceMap(intakes);
  const keyOf = (r) => (r.source === 'manual' ? null : slotId(r.medId, Date.parse(r.plannedAt)));
  const occOf = new Map();
  for (const r of rows) { const k = keyOf(r); if (k) occOf.set(k, r.occId); }
  // One group per logical dose: the canonical K plus every cancelled id that
  // resolves to it (a whole A → B → C chain). No K → each id stands alone.
  const groups = new Map();
  for (const c of table.keys()) {
    const k = canonical(table, c);
    const g = k ? `k:${k}` : `c:${c}`;
    if (!groups.has(g)) groups.set(g, { k, members: k ? [k] : [] });
    groups.get(g).members.push(c);
  }
  const hidden = new Set();
  const twice = new Map();
  for (const { k, members } of groups.values()) {
    const logged = members.filter((m) => ev.has(m));
    if (logged.length > 1) {
      // Logged more than once: every logged row stays, flagged, unsettled.
      for (const m of logged) {
        const other = logged.find((x) => x !== m);
        twice.set(m, occOf.get(other) ?? other);
      }
      for (const m of members) if (!ev.has(m)) hidden.add(m);
    } else if (logged.length === 1) {
      for (const m of members) if (m !== logged[0]) hidden.add(m);
    } else {
      // A canonical the projection doesn't list (a window that cuts K off, or
      // a switch before the ledger cut, where nothing is regenerated) would
      // leave the slot empty — so the cancelled rows stay as stand-ins.
      if (!k || occOf.has(k)) for (const m of members) if (m !== k) hidden.add(m);
    }
  }
  return rows.filter((r) => !hidden.has(keyOf(r))).map((r) => {
    const partner = twice.get(keyOf(r));
    return partner ? { ...r, loggedTwice: partner } : r;
  });
}
