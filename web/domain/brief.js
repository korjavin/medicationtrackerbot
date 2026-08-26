// Runtime-agnostic doctor-visit brief module (epic med-5k6t). Pure logic over
// the already-built feature domains — no window/document/fetch/IndexedDB — so
// the same file can run inside the Go server via goja (C6), like analysis.js.
//
// This is the DATA half only: one read op assembling the printable brief's
// JSON for a range + a section selection. The document/print half lives in the
// UI (med-5k6t.2). Every number here is folded from an existing domain read —
// nothing re-derives what bp/weight/vitals/notes/food/workout/intake already
// compute — so the brief can never disagree with the screen it summarizes.
//
// Only the SELECTED sections are computed: an unselected section costs no read
// at all (a 180-day food or workout fold is not cheap), and its key is simply
// absent from the response. A selected section with no data yields nulls/empty
// rather than throwing — the doc builder decides what to omit.
//
// `range` labels the window as "the last N days"; it is not a byte-exact
// interval contract across sections. Each domain applies its own filter and
// they do not all agree at the edges — food.stats/listGrouped snap to whole
// local calendar days while bp/weight/notes use a rolling now−N×24h — so the
// food section can differ from the others by up to a partial day at each
// boundary. Reusing those folds is the point (a doctor brief must not disagree
// with the Food screen); re-deriving them here to align the edges would trade
// a sub-day boundary for a second source of truth.

import { parseSchedule } from './medschedule.js';
import { foldAdherence, adherenceKey, adherencePct } from './medintake.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// The three ranges the brief UI offers. Anything else (including garbage)
// falls back to the default rather than erroring — this is a read op behind a
// print button, not a validating write.
const ALLOWED_DAYS = [30, 90, 180];
const DEFAULT_DAYS = 90;

// Canonical key order of the response. Food and workouts are opt-in: a doctor
// visit about blood pressure should not ship a nutrition log unless asked.
export const SECTION_ORDER = ['meds', 'bp', 'weight', 'vitals', 'notes', 'food', 'workouts'];
export const DEFAULT_SECTIONS = ['meds', 'bp', 'weight', 'vitals', 'notes'];
const KNOWN_SECTIONS = new Set(SECTION_ORDER);

// Same cap analysis.js applies to diary notes — a brief is meant to be handed
// over on paper, and 400 notes is not.
const NOTES_LIMIT = 50;

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function normalizeDays(raw) {
  // Whole-value parse, not parseInt: parseInt would honor "30junk" and "30.5"
  // as the 30-day range instead of falling back to the default.
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  return ALLOWED_DAYS.includes(n) ? n : DEFAULT_DAYS;
}

// An absent/empty `sections` means "the default set". A present one is taken
// literally: unknown names are ignored, and a selection that names only
// unknown ones selects nothing (the response is then just `range`).
export function normalizeSections(raw) {
  if (raw === undefined || raw === null || raw === '') return [...DEFAULT_SECTIONS];
  const wanted = new Set(
    String(raw).split(',').map((s) => s.trim()).filter((s) => KNOWN_SECTIONS.has(s)),
  );
  return SECTION_ORDER.filter((s) => wanted.has(s));
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round1(v) {
  return v === null ? null : Math.round(v * 10) / 10;
}

function roundInt(v) {
  return v === null ? null : Math.round(v);
}

// avg/min/max over one metric, or null when the metric was never recorded.
// reduce, not Math.min(...values) — a 180-day window can overflow the
// argument-spread limit (same reason analysis.js avoids it).
function stat(values) {
  if (values.length === 0) return null;
  return {
    avg: Math.round(mean(values)),
    min: values.reduce((m, v) => (v < m ? v : m), values[0]),
    max: values.reduce((m, v) => (v > m ? v : m), values[0]),
  };
}

// One human line per medication schedule, from the same parseSchedule the
// dose planner uses. Unparseable schedules pass through verbatim.
export function scheduleSummary(schedule) {
  const cfg = parseSchedule(schedule);
  if (!cfg) return schedule || '';
  if (cfg.type === 'as_needed') return 'as needed';
  const times = cfg.times.join(', ');
  if (cfg.type === 'weekly') {
    const days = cfg.days.map((d) => WEEKDAY_NAMES[d]).filter(Boolean).join(', ') || 'weekly';
    return times ? `${days} at ${times}` : days;
  }
  return times ? `daily at ${times}` : (cfg.type || schedule || '');
}

// createBriefDomain builds the brief API over the feature domains already
// constructed in apishim.js createApiRouter, plus:
//   settings — for the food targets shown next to the food averages
//   now()    — current time in ms epoch
export function createBriefDomain({
  bp, weight, vitals, notes, medications, intake, food, workout, settings, now,
}) {
  async function medsSection(fromMs, toMs, nowMs) {
    // archived:true lists ALL meds (medications.js list: `archived || !m.archived`).
    // The brief still SHOWS only the active ones, but the fold needs the archived
    // ones' schedules — listWindow keeps emitting their rows, and an unclassified
    // row counts toward adherence.
    const [all, log] = await Promise.all([
      medications.list({ archived: true }),
      intake.listWindow({ fromMs, toMs }),
    ]);
    const list = all.filter((m) => !m.archived);
    // The shared fold (medintake.js foldAdherence), the same one analysis.js
    // runs over the same rows. It classifies each med as scheduled or not: an
    // as-needed (or unparseably-scheduled) med never gets a materialized dose,
    // so its rows are all manual TAKEN logs and a percentage over them is a
    // fabricated 100%. Those meds report `times_taken` instead — and their rows
    // stay out of the overall number too.
    const { overall, perMed, detail } = foldAdherence({ log, meds: all, nowMs });
    const empty = { scheduled: true, total: 0, taken: 0, timesTaken: 0 };
    return {
      medications: list.map((m) => {
        const counts = perMed.get(adherenceKey(m.name, m.dosage)) || empty;
        return {
          name: m.name,
          dosage: m.dosage,
          schedule_summary: scheduleSummary(m.schedule),
          started_at: m.start_date || m.created_at || null,
          // null on an empty window too: "nothing was scheduled" is not "took
          // nothing" (analysis.js deliberately reports 0 there instead).
          adherence_pct: counts.scheduled ? round1(adherencePct(counts, null)) : null,
          // `as_needed` also covers a schedule that yields no doses at all
          // (unparseable, or parseable but slotless) — from the doctor's side
          // they all mean "no schedule to be adherent to".
          as_needed: !counts.scheduled,
          times_taken: counts.timesTaken,
        };
      }),
      overall_adherence_pct: round1(adherencePct(overall, null)),
      // The same fold's second reading (bd med-29gh.2): what the percentage
      // does not say — how many doses were missed, how many were merely late,
      // and by how much on average. Overall-only on purpose; per-med detail is
      // a separate ask. Manual log-past rows are excluded from the delay
      // numbers upstream (they have no real slot to be late against) but still
      // count toward the percentage.
      adherence_detail: detail,
    };
  }

  async function bpSection(days) {
    const [readings, goal] = await Promise.all([
      bp.list({ days, limit: 0 }),
      bp.getGoal(),
    ]);
    const pulses = readings.map((r) => r.pulse).filter(isNum);
    return {
      count: readings.length,
      systolic: stat(readings.map((r) => r.systolic).filter(isNum)),
      diastolic: stat(readings.map((r) => r.diastolic).filter(isNum)),
      pulse: stat(pulses),
      goal,
      // Oldest first: the chart in the printed doc reads left-to-right.
      readings: readings.slice().reverse().map((r) => ({
        measured_at: r.measured_at,
        systolic: r.systolic,
        diastolic: r.diastolic,
        pulse: isNum(r.pulse) ? r.pulse : null,
      })),
    };
  }

  // `unit` is always 'kg' — the vault stores kilograms and unit conversion is
  // render-time everywhere else in the app (core/utils.js formatWeight, which
  // reads the user's kg/lb preference). The brief carries the storage unit so
  // the doc builder converts once, at the point it draws the numbers, instead
  // of a second KG_PER_LB constant living down here.
  async function weightSection(days) {
    const rows = await weight.list({ days, limit: 0 });
    const points = rows.slice().reverse()
      .map((r) => ({ measured_at: r.measured_at, weight: r.weight }));
    if (points.length === 0) {
      return {
        start: null, end: null, delta: null, unit: 'kg', points: [],
      };
    }
    const start = points[0].weight;
    const end = points[points.length - 1].weight;
    return {
      start, end, delta: round1(end - start), unit: 'kg', points,
    };
  }

  async function vitalsSection(fromMs, toMs) {
    const logs = await vitals.sleep({
      from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), limit: 0,
    });
    return {
      avg_sleep_minutes: roundInt(mean(logs.map((l) => l.total_minutes).filter(isNum))),
      // Sleeping heart rate is the resting-HR proxy the gamification engine
      // already uses (gamification.js "a resting-HR proxy"); the vault has no
      // dedicated resting-HR series.
      resting_hr: roundInt(mean(logs.map((l) => l.heart_rate_avg).filter(isNum))),
    };
  }

  async function notesSection(days) {
    const rows = await notes.list({ days, limit: NOTES_LIMIT });
    return rows.map((n) => ({ date: String(n.created_at || '').slice(0, 10), text: n.content }));
  }

  async function foodSection(days) {
    const [totals, groups, targets] = await Promise.all([
      food.stats({ days }),
      // days > 1 makes listGrouped group by calendar day, so one group = one
      // day with at least one log — which IS days_logged, no second fold.
      food.listGrouped({ days }),
      settings.getFoodTargets(),
    ]);
    const daysLogged = groups.length;
    // Averaged over days LOGGED, not calendar days: a gap in the log is a
    // missing measurement, not a zero-calorie day.
    const per = (total) => (daysLogged > 0 ? total / daysLogged : null);
    return {
      days_logged: daysLogged,
      avg_kcal: roundInt(per(totals.calories)),
      avg_protein: round1(per(totals.protein)),
      avg_carbs: round1(per(totals.carbs)),
      avg_fat: round1(per(totals.fat)),
      targets,
    };
  }

  async function workoutsSection(days) {
    const stats = await workout.getStats({ range: `${days}d` });
    const sessionCount = stats.completed_sessions;
    return {
      session_count: sessionCount,
      per_week: round1(sessionCount / (days / 7)),
    };
  }

  // build assembles the brief. Sequential per section on purpose: the sections
  // are independent, but a brief is generated once behind a print button, and
  // serializing keeps the "only selected sections are read" property obvious.
  async function build({ days, sections } = {}) {
    const windowDays = normalizeDays(days);
    const selected = new Set(normalizeSections(sections));
    const nowMs = now();
    const fromMs = nowMs - windowDays * DAY_MS;
    const generatedAt = new Date(nowMs).toISOString();

    const out = {
      range: {
        days: windowDays,
        from: new Date(fromMs).toISOString(),
        to: generatedAt,
        generated_at: generatedAt,
      },
    };

    if (selected.has('meds')) {
      const {
        medications: meds, overall_adherence_pct: overall, adherence_detail: detail,
      } = await medsSection(fromMs, nowMs, nowMs);
      out.medications = meds;
      out.overall_adherence_pct = overall;
      out.adherence_detail = detail;
    }
    if (selected.has('bp')) out.bp = await bpSection(windowDays);
    if (selected.has('weight')) out.weight = await weightSection(windowDays);
    if (selected.has('vitals')) out.vitals = await vitalsSection(fromMs, nowMs);
    if (selected.has('notes')) out.notes = await notesSection(windowDays);
    if (selected.has('food')) out.food = await foodSection(windowDays);
    if (selected.has('workouts')) out.workouts = await workoutsSection(windowDays);

    return out;
  }

  return { build };
}
