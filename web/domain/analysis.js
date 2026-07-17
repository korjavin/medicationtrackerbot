// Runtime-agnostic composite-analysis domain module. Pure logic over the
// already-built feature domains (no window/document/fetch/IndexedDB), so the
// same file can later run inside the Go server via goja (C6). Reproduces bot
// mode's two top-level composite MCP tools — analyze_cardiovascular /
// analyze_fitness — client-side over vault data (docs/plans/20260717-cloud-analysis-pathb.md).
// Oracle: internal/mcp/cardiovascular.go + internal/mcp/fitness.go (value-exact
// against cardiovascular_test.go / fitness_test.go).
//
// Feature gates are passed in via each call's `features` map (the router reads
// settings.getFeatures()); a disabled/failed section is added to an `unavailable`
// warning list and omitted, never aborting the whole analysis — mirroring the Go
// handlers' per-section `unavailable = append(...)` pattern.

import { dayStartMs } from './bp.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Default + max lookback window, matching Config.MaxQueryDays (90) — the bot's
// parseDateRange both defaults an omitted start to end-90d and clamps an
// over-long range to it.
const MAX_DAYS = 90;
const NOTES_LIMIT = 50;
const NOTES_TRUNCATED_WARNING = 'Diary notes truncated to 50 most recent entries; older notes in this period were omitted.';

// Trunc toward zero: Go's integer division of non-negative sums.
function avgInt(values) {
  if (values.length === 0) return 0;
  return Math.trunc(values.reduce((a, b) => a + b, 0) / values.length);
}

function fmtDay(ms, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

// Start of the local day named by a YYYY-MM-DD string. Anchoring on noon UTC
// keeps the calendar day from rolling over under any real tz offset (±14h);
// dayStartMs then snaps to the local midnight.
function startOfDayMs(dateStr, timeZone) {
  return dayStartMs(Date.parse(`${dateStr}T12:00:00Z`), timeZone);
}

// resolveWindow reproduces resolveCompositeRange + parseDateRange: end defaults
// to now (else end-of-day of `to`), start defaults to end-90d (or the `days`
// shorthand), then start is clamped to no earlier than end-90d.
function resolveWindow({ from, to, days }, nowMs, timeZone) {
  let endMs;
  if (to) {
    endMs = startOfDayMs(to, timeZone) + DAY_MS - 1;
  } else if (!from && days > 0) {
    // Go's resolveCompositeRange normalizes an empty end to today's *date* in
    // the days-shorthand path, which parseDateRange then extends to end-of-day
    // (23:59:59) — not the wall-clock `now` instant the plain-default path uses.
    endMs = startOfDayMs(fmtDay(nowMs, timeZone), timeZone) + DAY_MS - 1;
  } else {
    endMs = nowMs;
  }
  let startMs;
  if (from) {
    startMs = startOfDayMs(from, timeZone);
  } else if (days > 0) {
    startMs = startOfDayMs(fmtDay(endMs, timeZone), timeZone) - (days - 1) * DAY_MS;
  } else {
    startMs = endMs - MAX_DAYS * DAY_MS;
  }
  const maxStart = endMs - MAX_DAYS * DAY_MS;
  if (startMs < maxStart) startMs = maxStart;
  return {
    fromMs: startMs,
    toMs: endMs,
    period: `${fmtDay(startMs, timeZone)} to ${fmtDay(endMs, timeZone)}`,
  };
}

// runSection isolates one section's read + aggregation: on any thrown error it
// records `<label> (query failed)` in `unavailable` and moves on, so one failed
// read degrades that section instead of aborting the whole analysis — mirroring
// the Go handlers, which wrap every fetch in `if err != nil { unavailable = append(...) }`.
async function runSection(unavailable, label, fn) {
  try {
    await fn();
  } catch {
    unavailable.push(`${label} (query failed)`);
  }
}

function gated(features, key) {
  // Missing features map → treat as enabled (the router always passes one; this
  // keeps unit tests terse). An explicit falsy flag disables the section.
  return !features || features[key] !== false;
}

// createAnalysis builds the composite-analysis API over the injected feature
// domains (all already constructed in apishim.js createApiRouter) plus now/timeZone.
export function createAnalysis({
  bp, vitals, medications, intake, food, weight, workout, notes, now, timeZone,
}) {
  // Diary notes in [fromMs,toMs], newest-first, capped at NOTES_LIMIT with a
  // truncation flag — fetchContextNotes' limit+1 truncation probe.
  async function diaryNotes(fromMs, toMs) {
    const raw = await notes.list({ limit: 0 });
    const inWindow = raw.filter((n) => {
      const ms = Date.parse(n.created_at);
      return ms >= fromMs && ms <= toMs;
    });
    const truncated = inWindow.length > NOTES_LIMIT;
    const out = inWindow.slice(0, NOTES_LIMIT).map((n) => ({ content: n.content, created_at: n.created_at }));
    return { notes: out, truncated };
  }

  async function cardiovascular({
    from, to, days, excludeNotes, features,
  } = {}) {
    const { fromMs, toMs, period } = resolveWindow({ from, to, days }, now(), timeZone);
    const unavailable = [];
    const warnings = [];
    const response = { period };

    // Blood pressure (gated).
    if (gated(features, 'bp')) {
      await runSection(unavailable, 'blood_pressure', async () => {
        const readings = (await bp.list({ days: 0, limit: 0 }))
          .filter((r) => {
            const ms = Date.parse(r.measured_at);
            return ms >= fromMs && ms <= toMs;
          });
        const daysSet = new Set(readings.map((r) => fmtDay(Date.parse(r.measured_at), timeZone)));
        response.blood_pressure = {
          readings,
          avg_systolic: avgInt(readings.map((r) => r.systolic)),
          avg_diastolic: avgInt(readings.map((r) => r.diastolic)),
          days_measured: daysSet.size,
        };
      });
    } else {
      unavailable.push('blood_pressure (feature disabled)');
    }

    // Medications (gated).
    if (gated(features, 'medication')) {
      await runSection(unavailable, 'medications', async () => {
        const active = (await medications.list({ archived: false }))
          .map((m) => ({ name: m.name, dosage: m.dosage, schedule: m.schedule }));
        // Uncapped, windowed intake log — mirrors fetchMedicationsSection's
        // ListIntakesSince (see intake.listWindow); history()'s 100-row cap would
        // undercount adherence or drop a past-dated window entirely.
        const log = await intake.listWindow({ fromMs, toMs });
        const nowMs = now();
        let total = 0;
        let taken = 0;
        for (const i of log) {
          // Future PENDING isn't yet due; every resolved status + overdue PENDING
          // counts against adherence.
          if (i.status === 'PENDING' && Date.parse(i.scheduled_at) > nowMs) continue;
          total += 1;
          if (i.status === 'TAKEN') taken += 1;
        }
        response.medications = {
          active,
          intake_log: log,
          adherence_rate: total > 0 ? (taken / total) * 100 : 0,
        };
      });
    } else {
      unavailable.push('medications (feature disabled)');
    }

    // Sleep (no gate).
    await runSection(unavailable, 'sleep', async () => {
      const sleepLogs = await vitals.sleep({
        from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(),
      });
      response.sleep = {
        logs: sleepLogs,
        avg_duration_minutes: avgInt(sleepLogs.filter((l) => l.total_minutes != null).map((l) => l.total_minutes)),
        avg_deep_minutes: avgInt(sleepLogs.filter((l) => l.deep_minutes != null).map((l) => l.deep_minutes)),
      };
    });

    // Heart rate — omitted (nil) when there's no data, matching the Go section.
    await runSection(unavailable, 'heart_rate', async () => {
      const hr = await vitals.listHeart({ from: fromMs, to: toMs });
      if (hr.length > 0) {
        const values = hr.map((s) => s.value);
        response.heart_rate = {
          avg: avgInt(values),
          // reduce, not Math.min(...values) — dense vitals can overflow the
          // argument-spread limit.
          min: values.reduce((m, v) => (v < m ? v : m), values[0]),
          max: values.reduce((m, v) => (v > m ? v : m), values[0]),
          readings_count: hr.length,
        };
      }
    });

    // SpO2 — omitted when there's no data.
    await runSection(unavailable, 'spo2', async () => {
      const spo2 = await vitals.listSpO2({ from: fromMs, to: toMs });
      if (spo2.length > 0) {
        const values = spo2.map((s) => s.value);
        response.spo2 = {
          avg: avgInt(values),
          min: values.reduce((m, v) => (v < m ? v : m), values[0]),
          readings_count: spo2.length,
        };
      }
    });

    if (!excludeNotes) {
      const { notes: notesOut, truncated } = await diaryNotes(fromMs, toMs);
      if (notesOut.length > 0) response.diary_notes = notesOut;
      if (truncated) warnings.push(NOTES_TRUNCATED_WARNING);
    }

    if (unavailable.length > 0) {
      warnings.push(`Unavailable sections: ${unavailable.join(', ')}.`);
    }
    if (warnings.length > 0) response.warning = warnings.join(' ');
    return response;
  }

  // -- fitness --

  // Manual session view (workout.listSessions) → the Go WorkoutSessionResult
  // shape (type "manual", date-only scheduled_date, omit-empty optional fields).
  function manualSessionResult(view) {
    const s = view.session;
    const result = {
      type: 'manual',
      group_name: view.group_name,
      scheduled_date: String(s.scheduled_date).slice(0, 10),
      status: s.status,
    };
    if (view.variant_name) result.variant_name = view.variant_name;
    if (s.started_at) result.started_at = s.started_at;
    if (s.completed_at) result.completed_at = s.completed_at;
    if (s.notes) result.notes = s.notes;
    return result;
  }

  // Mi-band workout (workout.listMiBand) → WorkoutSessionResult (type "miband",
  // always counted as a completed session). Optional metric fields drop when
  // zero, matching the Go `if wo.Steps > 0 { ... }` guards.
  function mibandSessionResult(wo) {
    const result = {
      type: 'miband',
      group_name: wo.activity_name,
      scheduled_date: String(wo.start_time).slice(0, 10),
      status: 'completed',
      started_at: wo.start_time,
      completed_at: wo.end_time,
      duration_sec: wo.duration_sec,
      distance_m: wo.distance_m,
    };
    if (wo.steps > 0) result.steps = wo.steps;
    if (wo.calories > 0) result.calories = wo.calories;
    if (wo.heart_rate_avg > 0) result.heart_rate_avg = wo.heart_rate_avg;
    return result;
  }

  async function fitness({
    from, to, days, excludeNotes, features,
  } = {}) {
    const { fromMs, toMs, period } = resolveWindow({ from, to, days }, now(), timeZone);
    const inRange = (ms) => ms >= fromMs && ms <= toMs;
    const unavailable = [];
    const warnings = [];
    const response = { period };

    // Workouts (gated): manual sessions in range + mi-band workouts in range,
    // every mi-band counted as a completed session (fetchWorkoutsSection).
    if (gated(features, 'workout')) {
      await runSection(unavailable, 'workouts', async () => {
        const manual = (await workout.listSessions(1000))
          .filter((v) => inRange(Date.parse(v.session.scheduled_date)));
        const miband = (await workout.listMiBand(1000))
          .filter((w) => inRange(Date.parse(w.start_time)));
        const sessions = [
          ...manual.map(manualSessionResult),
          ...miband.map(mibandSessionResult),
        ];
        // Descending by started_at (falling back to scheduled_date), matching
        // the Go sort.Slice on the same string keys.
        sessions.sort((a, b) => {
          const ka = a.started_at || a.scheduled_date;
          const kb = b.started_at || b.scheduled_date;
          return ka < kb ? 1 : ka > kb ? -1 : 0;
        });
        const total = manual.length + miband.length;
        const completed = manual.filter((v) => v.session.status === 'completed').length + miband.length;
        response.workouts = {
          sessions,
          total_sessions: total,
          completion_rate: total > 0 ? (completed / total) * 100 : 0,
        };
      });
    } else {
      unavailable.push('workouts (feature disabled)');
    }

    // Steps (no gate): per-day step/calorie/distance rows in range.
    await runSection(unavailable, 'steps', async () => {
      const dayStats = await vitals.listDayStats({
        from: fmtDay(fromMs, timeZone), to: fmtDay(toMs, timeZone),
      });
      const daily = dayStats.map((d) => ({
        date: d.day, steps: d.steps, calories: d.calories, distance: d.distance,
      }));
      response.steps = {
        daily,
        avg_daily_steps: daily.length > 0
          ? Math.trunc(daily.reduce((sum, d) => sum + d.steps, 0) / daily.length) : 0,
      };
    });

    // Nutrition (gated): per-day macro sums, food names dropped, avg over
    // days-with-data. Group individual logs by their local day (matching
    // fetchNutritionSection); the instant filter owns the exact window.
    if (gated(features, 'food')) {
      await runSection(unavailable, 'nutrition', async () => {
        const startDay = startOfDayMs(fmtDay(fromMs, timeZone), timeZone);
        const endDay = startOfDayMs(fmtDay(toMs, timeZone), timeZone);
        const totalDays = Math.round((endDay - startDay) / DAY_MS) + 1;
        // +2 days of slack so a DST-skewed count never trims an edge day; the
        // per-log instant filter below re-imposes the exact [fromMs,toMs] window.
        const groups = await food.listGrouped({ date: fmtDay(toMs, timeZone), days: totalDays + 2 });
        const dayMap = new Map();
        for (const g of groups) {
          for (const log of g.logs) {
            const ms = Date.parse(log.eaten_at);
            if (!inRange(ms)) continue;
            const day = fmtDay(ms, timeZone);
            let dt = dayMap.get(day);
            if (!dt) {
              dt = {
                date: day, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0,
              };
              dayMap.set(day, dt);
            }
            dt.calories += log.calories;
            dt.protein_g += log.protein;
            dt.carbs_g += log.carbs;
            dt.fat_g += log.fat;
          }
        }
        const dailyTotals = [...dayMap.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        const daysWithData = dailyTotals.length;
        response.nutrition = {
          daily_totals: dailyTotals,
          avg_daily_calories: daysWithData > 0
            ? Math.trunc(dailyTotals.reduce((s, d) => s + d.calories, 0) / daysWithData) : 0,
          avg_daily_protein: daysWithData > 0
            ? Math.trunc(dailyTotals.reduce((s, d) => s + d.protein_g, 0) / daysWithData) : 0,
        };
      });
    } else {
      unavailable.push('nutrition (feature disabled)');
    }

    // Weight (gated): kg-only logs in range (newest-first), current + change +
    // trend direction (±0.1 kg), insufficient_data with a single reading.
    if (gated(features, 'weight')) {
      await runSection(unavailable, 'weight', async () => {
        const logs = (await weight.list({ days: 0, limit: 0 }))
          .filter((l) => inRange(Date.parse(l.measured_at)))
          .map((l) => {
            const entry = { measured_at: fmtDay(Date.parse(l.measured_at), timeZone), weight_kg: l.weight };
            if (l.weight_trend != null) entry.trend_kg = l.weight_trend;
            if (l.body_fat != null) entry.body_fat_percent = l.body_fat;
            if (l.notes) entry.notes = l.notes;
            return entry;
          });
        const section = { logs };
        if (logs.length > 0) {
          const current = logs[0].weight_kg;
          section.current_kg = current;
          if (logs.length >= 2) {
            const change = current - logs[logs.length - 1].weight_kg;
            section.change_kg = change;
            section.trend_direction = change > 0.1 ? 'gaining' : change < -0.1 ? 'losing' : 'stable';
          } else {
            section.trend_direction = 'insufficient_data';
          }
        }
        response.weight = section;
      });
    } else {
      unavailable.push('weight (feature disabled)');
    }

    if (!excludeNotes) {
      const { notes: notesOut, truncated } = await diaryNotes(fromMs, toMs);
      if (notesOut.length > 0) response.diary_notes = notesOut;
      if (truncated) warnings.push(NOTES_TRUNCATED_WARNING);
    }

    if (unavailable.length > 0) {
      warnings.push(`Unavailable sections: ${unavailable.join(', ')}.`);
    }
    if (warnings.length > 0) response.warning = warnings.join(' ');
    return response;
  }

  return { cardiovascular, fitness };
}
