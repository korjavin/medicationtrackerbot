// Runtime-agnostic weight domain module. Pure logic over an injected
// records port — no window/document/fetch/IndexedDB — so the same file can
// later run inside the Go server via goja (C6) with a Go-backed records port.
// Mirrors internal/store/weight/repo.go + internal/server/weight_handlers.go.

const RECORD_TYPE = 'weight';
const GOAL_RECORD_TYPE = 'weightgoal';

// Ported from internal/store/weight/repo.go:77 (CalculateWeightTrend).
// alpha = 0.1 gives roughly a 20-day smoothing.
export function calculateWeightTrend(currentWeight, previousTrend) {
  if (previousTrend === null || previousTrend === undefined) return currentWeight;
  const alpha = 0.1;
  return alpha * currentWeight + (1 - alpha) * previousTrend;
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
  if (record.weight_trend !== null && record.weight_trend !== undefined) resp.weight_trend = record.weight_trend;
  if (record.body_fat !== null && record.body_fat !== undefined) resp.body_fat = record.body_fat;
  if (record.muscle_mass !== null && record.muscle_mass !== undefined) resp.muscle_mass = record.muscle_mass;
  if (record.notes) resp.notes = record.notes;
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
  async function create(input, { replacesId } = {}) {
    const nowMs = now();
    const all = await records.list(RECORD_TYPE);
    const previous = all
      .filter((r) => r.recordId !== replacesId)
      .sort((a, b) => Date.parse(b.measured_at) - Date.parse(a.measured_at))[0];
    const previousTrend = previous && previous.weight_trend !== null && previous.weight_trend !== undefined
      ? previous.weight_trend
      : null;

    const record = {
      recordId: genId(nowMs),
      clientTs: nowMs,
      deleted: false,
      measured_at: toISOString(input.measured_at),
      weight: input.weight,
      weight_trend: calculateWeightTrend(input.weight, previousTrend),
      body_fat: input.body_fat ?? null,
      muscle_mass: input.muscle_mass ?? null,
      notes: input.notes || '',
    };
    await records.put(RECORD_TYPE, record);
    return toResponse(record);
  }

  async function list({ days = 30, limit = 100 } = {}) {
    const since = days > 0 ? now() - days * 24 * 60 * 60 * 1000 : 0;
    const all = await records.list(RECORD_TYPE);
    const filtered = all
      .filter((r) => !since || Date.parse(r.measured_at) >= since)
      .sort((a, b) => Date.parse(b.measured_at) - Date.parse(a.measured_at));
    const limited = limit > 0 ? filtered.slice(0, limit) : filtered;
    return limited.map(toResponse);
  }

  async function remove(id) {
    const all = await records.list(RECORD_TYPE);
    if (!all.some((r) => r.recordId === id)) {
      const err = new Error('weight log not found');
      err.code = 'not_found';
      throw err;
    }
    await records.del(RECORD_TYPE, id);
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

  async function setGoal(goal) {
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

  return { create, list, remove, getGoal, setGoal };
}
