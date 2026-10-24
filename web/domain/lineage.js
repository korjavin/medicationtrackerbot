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
// Output per med: {medId, kept, cancelled, replacement} — `replacement` maps
// every cancelled occId to its canonical occId (null = no replacement). It is
// stored on the tztransition / medsched record at approve/edit time; the
// projection resolves evidence through it (applyLineage), never by nearness.
//
// ponytail: an APPROVED plan still in progress when the zone changes again is
// not part of oldGen (its steps are not paired); the newer plan's steps are.
import {
  parseSchedule, localDateParts, localDateTimeParts, localWallToUtcMs,
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
        const hm = /^(\d\d):(\d\d)$/.exec(t);
        if (!hm) continue;
        const at = localWallToUtcMs(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), +hm[1], +hm[2]), tz);
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

  for (const o of olds) {
    o.evidence = ev.get(o.occId) || null;
    let n = byKey.get(key(o));
    if (n && used.has(n.occId)) n = null;
    if (n) used.add(n.occId);
    if (n && n.occId === o.occId) {
      o.state = 'kept';
      n.state = 'kept';
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
  for (const o of olds) {
    if (o.state) continue;
    const n = news.find((x) => !used.has(x.occId) && sameMed(x.medId, o.medId) && x.at > o.at
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
      // ponytail: until bd med-wi09.12 regenerates kept old instants, a
      // canonical the projection doesn't list (an old instant kept after the
      // switch) would leave the slot empty — so the cancelled rows stay as
      // stand-ins. The check is per call, so a window that cuts K off shows them.
      if (!k || occOf.has(k)) for (const m of members) if (m !== k) hidden.add(m);
    }
  }
  return rows.filter((r) => !hidden.has(keyOf(r))).map((r) => {
    const partner = twice.get(keyOf(r));
    return partner ? { ...r, loggedTwice: partner } : r;
  });
}
