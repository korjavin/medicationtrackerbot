// Runtime-agnostic weight domain module. Pure logic over an injected
// records port — no window/document/fetch/IndexedDB — so the same file can
// later run inside the Go server via goja (C6) with a Go-backed records port.
// Mirrors internal/store/weight/repo.go + internal/server/weight_handlers.go.

import { deleteHealthAlias, healthImportRecordId } from './healthsource.js';

const RECORD_TYPE = 'weight';
const GOAL_RECORD_TYPE = 'weightgoal';
const GOAL_MIN_KG = 20;
const GOAL_MAX_KG = 500;

// Single-account cloud mode has exactly one user; user_id is echoed back only
// where the server's JSON shape carries it (goal history). See workout.js.
const CLOUD_USER_ID = 1;

// Ported from internal/store/weight/repo.go:77 (CalculateWeightTrend).
// alpha = 0.1 gives roughly a 20-day smoothing.
export function calculateWeightTrend(currentWeight, previousTrend) {
  if (previousTrend === null || previousTrend === undefined) return currentWeight;
  const alpha = 0.1;
  return alpha * currentWeight + (1 - alpha) * previousTrend;
}

// compareChain is THE order of a recomputed chain (readers and restore):
// instant, then weight, then Health row before manual, then recordId.
// ponytail: restore re-mints manual ids, so only the first three survive it —
// two manual (or two Health) rows tied on all three are interchangeable for
// the EMA; recordId just keeps one device deterministic.
export function compareChain(a, b) {
  const d = (Date.parse(a.measured_at) - Date.parse(b.measured_at)) || (a.weight - b.weight)
    || (isHealthWeight(b) - isHealthWeight(a));
  if (d) return d;
  const ia = String(a.recordId || '');
  const ib = String(b.recordId || '');
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

// weightTrendChain is THE weight_trend EMA walk over a chain sorted oldest
// first, seeded from null. vault.js restore uses it too.
export function weightTrendChain(rowsAsc) {
  let prev = null;
  return rowsAsc.map((r) => (prev = calculateWeightTrend(r.weight, prev)));
}

const hasTrend = (r) => r.weight_trend !== null && r.weight_trend !== undefined;
export const isHealthWeight = (r) => healthImportRecordId(RECORD_TYPE, r) !== null;

// withTrends returns the rows carrying the trend to read. A history without
// Apple Health rows is returned as stored (unchanged behaviour, null trends
// included). Health rows are stored without a trend so their body is
// device-independent; a history holding one (canonical or a restored alias) is
// recomputed whole by weightTrendChain in instant order. That is all a reader
// sees while a Health row exists, and restore keeps Health rows trend-less, so
// restore's own (lexical, master) order and stored trends never show here.
function withTrends(rows) {
  if (!rows.some(isHealthWeight)) return rows;
  const asc = [...rows].sort(compareChain);
  const trends = weightTrendChain(asc);
  return asc.map((r, i) => ({ ...r, weight_trend: trends[i] }));
}

function toISOString(v) {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  return v;
}

function genId(nowMs) {
  return `weight_${nowMs}_${Math.random().toString(36).slice(2, 10)}`;
}

function toResponse(record) {
  const resp = {
    id: record.recordId,
    measured_at: record.measured_at,
    weight: record.weight,
  };
  if (hasTrend(record)) resp.weight_trend = record.weight_trend;
  if (record.body_fat !== null && record.body_fat !== undefined) resp.body_fat = record.body_fat;
  if (record.muscle_mass !== null && record.muscle_mass !== undefined) resp.muscle_mass = record.muscle_mass;
  if (record.notes) resp.notes = record.notes;
  if (record.source) resp.source = record.source;
  return resp;
}

// dateOnlyToISOString mirrors Go parsing "2006-01-02" into a time.Time (UTC
// midnight) then JSON-encoding it as RFC3339.
function dateOnlyToISOString(dateStr) {
  if (!dateStr) return undefined;
  return new Date(`${dateStr}T00:00:00.000Z`).toISOString();
}

function goalResponse(latestGoal, highestRecord) {
  const resp = {};
  if (latestGoal) {
    resp.goal = latestGoal.target_weight;
    const goalDate = dateOnlyToISOString(latestGoal.target_date);
    if (goalDate) resp.goal_date = goalDate;
    if (latestGoal.set_at) resp.goal_set_at = latestGoal.set_at;
    if (latestGoal.start_weight !== null && latestGoal.start_weight !== undefined) {
      resp.goal_start_weight = latestGoal.start_weight;
    }
  }
  if (highestRecord) {
    resp.highest_weight = highestRecord.weight;
    resp.highest_date = highestRecord.measured_at;
  }
  return resp;
}

// createWeightDomain builds the weight domain API over the injected ports:
//   records — { list(type), put(type, record), del(type, id) }
//   now()   — current time in ms epoch
//   timeZone — IANA zone string (unused here; kept for port-shape parity with bp.js)
export function createWeightDomain({ records, now, timeZone }) {
  // recordId: see createBPDomain — deterministic ids let the Telegram inbox
  // drain re-apply an event without double-logging (drain protocol, rule 2).
  // derived: see createBPDomain (LWW floor for re-derivable imports).
  async function create(input, { replacesId, recordId, derived = false } = {}) {
    const nowMs = now();
    // A derived row must be the same body on every device that derives it
    // (equal clientTs 0 never reconciles under LWW), so it stores no trend;
    // readers fill it in from the chain (withTrends).
    const all = derived ? [] : withTrends((await records.list(RECORD_TYPE))
      .filter((r) => r.recordId !== replacesId));
    const previous = all
      .sort((a, b) => Date.parse(b.measured_at) - Date.parse(a.measured_at))[0];
    const previousTrend = previous && hasTrend(previous) ? previous.weight_trend : null;

    const record = {
      recordId: recordId || genId(nowMs),
      clientTs: derived ? 0 : nowMs,
      deleted: false,
      measured_at: toISOString(input.measured_at),
      weight: input.weight,
      weight_trend: derived ? null : calculateWeightTrend(input.weight, previousTrend),
      body_fat: input.body_fat ?? null,
      muscle_mass: input.muscle_mass ?? null,
      notes: input.notes || '',
      ...(input.source ? { source: input.source, source_id: input.source_id || '' } : {}),
    };
    if (derived) return toResponse(await records.putIfAbsent(RECORD_TYPE, record));
    await records.put(RECORD_TYPE, record);
    return toResponse(record);
  }

  async function list({ days = 30, limit = 100 } = {}) {
    const since = days > 0 ? now() - days * 24 * 60 * 60 * 1000 : 0;
    const all = withTrends(await records.list(RECORD_TYPE));
    const filtered = all
      .filter((r) => !since || Date.parse(r.measured_at) >= since)
      .sort((a, b) => Date.parse(b.measured_at) - Date.parse(a.measured_at));
    const limited = limit > 0 ? filtered.slice(0, limit) : filtered;
    return limited.map(toResponse);
  }

  async function remove(id) {
    const all = await records.list(RECORD_TYPE);
    const row = all.find((r) => r.recordId === id);
    if (!row) {
      const err = new Error('weight log not found');
      err.code = 'not_found';
      throw err;
    }
    await records.del(RECORD_TYPE, id);
    await deleteHealthAlias(records, RECORD_TYPE, row);
  }

  async function latestGoal() {
    const goals = await records.list(GOAL_RECORD_TYPE);
    return goals.sort((a, b) => Date.parse(b.set_at) - Date.parse(a.set_at))[0];
  }

  async function highestWeightLog() {
    const all = await records.list(RECORD_TYPE);
    return all.sort((a, b) => b.weight - a.weight)[0];
  }

  async function getGoal() {
    const [goal, highest] = await Promise.all([latestGoal(), highestWeightLog()]);
    return goalResponse(goal, highest);
  }

  // listGoals ports handleListWeightGoals + weight.ListGoals: the append-only
  // goal history, newest first, capped at 1..200 (default 100). No UI reads
  // it; the MCP catalog does.
  async function listGoals(limit) {
    const n = limit > 0 ? Math.min(limit, 200) : 100;
    return (await records.list(GOAL_RECORD_TYPE))
      .filter((g) => !g.deleted)
      .sort((a, b) => Date.parse(b.set_at) - Date.parse(a.set_at))
      .slice(0, n)
      .map((g) => {
        const resp = {
          id: g.recordId,
          user_id: CLOUD_USER_ID,
          set_at: g.set_at,
          target_weight: g.target_weight,
          target_date: g.target_date,
        };
        if (g.start_weight !== null && g.start_weight !== undefined) resp.start_weight = g.start_weight;
        return resp;
      });
  }

  async function setGoal(goal) {
    // No height record exists, so no BMI floor — plain sanity bounds (kg).
    const target = goal && goal.target_weight;
    if (typeof target !== 'number' || !Number.isFinite(target)
      || target < GOAL_MIN_KG || target > GOAL_MAX_KG) {
      const err = new Error(`target_weight must be a number between ${GOAL_MIN_KG} and ${GOAL_MAX_KG} kg`);
      err.code = 'invalid_request';
      throw err;
    }
    const nowMs = now();
    const all = await records.list(RECORD_TYPE);
    const latestLog = all.sort((a, b) => Date.parse(b.measured_at) - Date.parse(a.measured_at))[0];
    const startWeight = latestLog ? latestLog.weight : null;

    await records.put(GOAL_RECORD_TYPE, {
      recordId: genId(nowMs),
      clientTs: nowMs,
      deleted: false,
      set_at: new Date(nowMs).toISOString(),
      target_weight: goal.target_weight,
      target_date: goal.target_date,
      start_weight: startWeight,
    });
    return getGoal();
  }

  return {
    create, list, remove, getGoal, setGoal, listGoals,
  };
}
