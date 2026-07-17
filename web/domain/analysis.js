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
  const endMs = to ? startOfDayMs(to, timeZone) + DAY_MS - 1 : nowMs;
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
    } else {
      unavailable.push('blood_pressure (feature disabled)');
    }

    // Medications (gated).
    if (gated(features, 'medication')) {
      const active = (await medications.list({ archived: false }))
        .map((m) => ({ name: m.name, dosage: m.dosage, schedule: m.schedule }));
      // history caps at 100 rows and windows only by a `days` look-back, so
      // derive `days` to cover [fromMs, now] then clamp to [fromMs, toMs].
      // ponytail: 100-row cap can undercount adherence over a dense 90-day
      // window; raise the cap or add a windowed intake read if that surfaces.
      const lookbackDays = Math.max(1, Math.ceil((now() - fromMs) / DAY_MS) + 1);
      const log = (await intake.history({ days: lookbackDays })).filter((i) => {
        const ms = Date.parse(i.scheduled_at);
        return ms >= fromMs && ms <= toMs;
      });
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
    } else {
      unavailable.push('medications (feature disabled)');
    }

    // Sleep (no gate).
    const sleepLogs = await vitals.sleep({
      from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(),
    });
    response.sleep = {
      logs: sleepLogs,
      avg_duration_minutes: avgInt(sleepLogs.filter((l) => l.total_minutes != null).map((l) => l.total_minutes)),
      avg_deep_minutes: avgInt(sleepLogs.filter((l) => l.deep_minutes != null).map((l) => l.deep_minutes)),
    };

    // Heart rate — omitted (nil) when there's no data, matching the Go section.
    const hr = await vitals.listHeart({ from: fromMs, to: toMs });
    if (hr.length > 0) {
      const values = hr.map((s) => s.value);
      response.heart_rate = {
        avg: avgInt(values),
        min: Math.min(...values),
        max: Math.max(...values),
        readings_count: hr.length,
      };
    }

    // SpO2 — omitted when there's no data.
    const spo2 = await vitals.listSpO2({ from: fromMs, to: toMs });
    if (spo2.length > 0) {
      const values = spo2.map((s) => s.value);
      response.spo2 = {
        avg: avgInt(values),
        min: Math.min(...values),
        readings_count: spo2.length,
      };
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

  return { cardiovascular };
}
