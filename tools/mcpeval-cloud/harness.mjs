// Eval harness: the production cloud MCP stack over a synthetic in-memory
// vault, driven by a real LLM. createDispatcher (mcp-responder.js) answers
// mcp_help/mcp_call through the same apishim router the cloud UI calls — no
// relay, no crypto, no IndexedDB; the only test-controlled seams are the model
// and the seed.
//
// Port of the deleted internal/mcpeval/harness.go (removed in med-a9n5.2),
// minus the Go server/Python executor: the "backend" here is web/domain/ via
// the router, and judges read ground truth through that same router (the old
// Harness.BridgeCall equivalent).

import { createApiRouter } from '../../web/cloud/js/apishim.js';
import { createDispatcher } from '../../web/cloud/js/mcp-responder.js';
import { cancelReminderRecompute } from '../../web/cloud/js/reminders.js';
import { seedVault } from './seed.mjs';

// Fixed eval clock (matches the cloud test fixtures' anchor): seed
// timestamps are absolute, and judges derive ground truth live, so the run is
// deterministic without a seed knob.
export const EVAL_NOW_MS = Date.parse('2026-07-06T12:00:00.000Z');

// In-memory records port: the same list/listRange/listRaw/put/putIfAbsent/del
// contract as web/cloud/js/sync.js's recordsPort and the
// web/static/js/tests/helpers/cloud-shim-harness.js test double (copied rather
// than imported so this script runs in plain Node with no jsdom/frontend
// harness), plus __types() so the mass-delete judge can enumerate record
// types. List returns live rows only; tombstones stay visible via listRaw.
export function createInMemoryRecordsPort(seed = {}) {
  const store = new Map(); // recordType -> Map<recordId, record>
  function bucket(recordType) {
    let byId = store.get(recordType);
    if (!byId) {
      byId = new Map();
      store.set(recordType, byId);
    }
    return byId;
  }
  for (const [recordType, records] of Object.entries(seed)) {
    const byId = bucket(recordType);
    records.forEach((r) => byId.set(r.recordId, r));
  }
  return {
    async list(recordType) {
      return [...bucket(recordType).values()].filter((r) => !r.deleted);
    },
    async listRange(recordType, fromId, toId) {
      return [...bucket(recordType).values()]
        .filter((r) => !r.deleted && r.recordId >= fromId && r.recordId <= toId);
    },
    async listRaw(recordType) {
      return [...bucket(recordType).values()];
    },
    async put(recordType, record) {
      bucket(recordType).set(record.recordId, record);
      return record;
    },
    async putIfAbsent(recordType, record) {
      const byId = bucket(recordType);
      const existing = byId.get(record.recordId);
      if (existing) return existing;
      byId.set(record.recordId, record);
      return record;
    },
    async del(recordType, recordId) {
      const byId = bucket(recordType);
      const existing = byId.get(recordId) || { recordId };
      byId.set(recordId, { ...existing, deleted: true });
    },
    __types() {
      return [...store.keys()];
    },
  };
}

// Tool specs handed to the agent. Descriptions are byte-identical to
// cmd/mcpshim/main.go and the parameter schemas mirror internal/mcpshim
// HelpInput/CallInput's jsonschema tags, so the eval measures the surface a
// real paired agent sees (including the device-required suffix — vacuous here
// since the "device" is always this harness, but hill-climbing must transfer).
const TOOL_SUFFIX = ' This connector talks end-to-end encrypted directly to your unlocked Med Tracker browser tab, never to a server — if no device is unlocked and online, it returns a clear error instead of hanging.';

export const EVAL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'mcp_help',
      description: 'Discover the Med Tracker operations this connector can run. No arguments returns the terse catalog (id, topic, method, risk, one-line description, required write fields) plus a usage protocol; topic= or query= return a filtered terse list; operation_id / operation_ids return full params/body schemas. Every response includes current_time (UTC) for resolving relative dates.' + TOOL_SUFFIX,
      parameters: {
        type: 'object',
        properties: {
          operation_id: { type: 'string', description: 'one operation id to return in full, with its params_schema and body_schema' },
          operation_ids: { type: 'array', items: { type: 'string' }, description: 'several operation ids to return in full, with their params_schema and body_schema' },
          topic: { type: 'string', description: "list only this topic's operations, e.g. workouts" },
          query: { type: 'string', description: 'keyword-search the catalog, e.g. blood pressure' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_call',
      description: "Run exactly one Med Tracker operation by id (ids and schemas come from mcp_help). Pass params for query fields, path_params for {placeholder} slots in the route, and body as a JSON object for writes. Any operation that changes data requires mode='write' and a one-sentence intent; reads never mutate. Returns the operation's result, or an error naming the reason (no device unlocked and online, unknown operation, validation failure). Returns {status, result, api_calls, warnings}; warnings report any input the responder repaired. A write-risk operation called without mode='write' is rejected." + TOOL_SUFFIX,
      parameters: {
        type: 'object',
        properties: {
          operation_id: { type: 'string', description: 'the operation id from mcp_help\'s catalog, e.g. health.bp.list' },
          op: { type: 'string', description: 'deprecated alias for operation_id; prefer operation_id' },
          params: { type: 'object', description: "parameters for the operation, per its params_schema in mcp_help", additionalProperties: true },
          path_params: { type: 'object', description: "values for the operation's {placeholder} path slots, per its path_params in mcp_help", additionalProperties: true },
          body: { type: 'object', description: 'request body for a write operation, per its body_schema in mcp_help', additionalProperties: true },
          mode: { type: 'string', description: '"read_only" (default) or "write"; an operation that changes data requires "write" plus a non-empty intent' },
          intent: { type: 'string', description: 'required and non-empty when mode is write: why this write is being made' },
        },
      },
    },
  },
];

export class Harness {
  constructor({ agent, judge, records, router, dispatcher, now, ctx }) {
    this.agent = agent;
    this.judge = judge; // LLM judge client (may be the same object as the agent client)
    this.ctx = ctx;
    this.records = records;
    this.router = router;
    this.dispatcher = dispatcher;
    this.now = now;
    this.tools = EVAL_TOOLS;
    this.seedIDs = null;
  }

  static async create({ agent, judge }) {
    const now = () => EVAL_NOW_MS;
    const records = createInMemoryRecordsPort();
    // A real ctx object (not null) so the debounced reminder recompute every
    // write schedules can be cancelled per-key below — same cleanup the
    // cloud-shim-harness does. The recompute only feeds the push relay, which
    // no judge reads; headless it would just fail on IndexedDB.
    const ctx = {};
    const router = createApiRouter(ctx, { records, now, timeZone: 'UTC' });
    const dispatcher = createDispatcher({ router, now });
    const h = new Harness({ agent, judge, records, router, dispatcher, now, ctx });
    h.seedIDs = await seedVault(async (op, input, pathParams) => {
      const out = await dispatcher.handle('mcp_call', {
        operation_id: op, params: input || {}, path_params: pathParams || {}, mode: 'write', intent: 'seed the eval vault',
      });
      return out.result;
    });
    cancelReminderRecompute(ctx);
    return h;
  }

  // runTool dispatches one agent tool call through the real dispatcher.
  // Errors come back as {code, message} with isError so the model sees the
  // same actionable text a paired agent would (unknown op, write-gate,
  // validation) and can self-correct.
  async runTool(name, argsJSON) {
    let args;
    try {
      args = JSON.parse(argsJSON);
    } catch (e) {
      return { result: JSON.stringify({ code: -32700, message: `arguments are not valid JSON: ${e.message}` }), isError: true };
    }
    if (name !== 'mcp_help' && name !== 'mcp_call') {
      return { result: JSON.stringify({ code: -32601, message: `unknown tool "${name}" — only mcp_help and mcp_call exist` }), isError: true };
    }
    try {
      const out = await this.dispatcher.handle(name, args && typeof args === 'object' ? args : {});
      return { result: JSON.stringify(out), isError: false };
    } catch (e) {
      const code = typeof e.code === 'number' ? e.code : -32603;
      return { result: JSON.stringify({ code, message: e.message }), isError: true };
    } finally {
      // A write schedules a debounced push-relay recompute that cannot run
      // headless; cancel it while the write's own result is what the agent
      // sees. Judges read vault state, never the relay, so nothing is lost.
      cancelReminderRecompute(this.ctx);
    }
  }

  async runScenario(sc, signal) {
    let pre;
    if (sc.setup) {
      try {
        pre = await sc.setup(this);
      } catch (e) {
        return { scenario: sc, verdict: { pass: false, reason: `setup failed: ${e.message}` } };
      }
    }
    let run;
    try {
      run = await this.agent.run(sc.task, this.tools, this, signal);
    } catch (e) {
      return { scenario: sc, run, verdict: { pass: false, reason: `agent error: ${e.message}` } };
    }
    let verdict;
    try {
      verdict = await sc.judge(this, run, pre, signal);
    } catch (e) {
      verdict = { pass: false, reason: `judge error: ${e.message}` };
    }
    return { scenario: sc, run, verdict };
  }

  // --- ground-truth reads through the router (the old BridgeCall path) ---

  async gtBP(days = 30) {
    return this.router(`/api/bp?days=${days}`, 'GET');
  }

  async gtWeight(days = 30) {
    return this.router(`/api/weight?days=${days}`, 'GET');
  }

  async gtMedications(archived = false) {
    return this.router(archived ? '/api/medications?archived=true' : '/api/medications', 'GET');
  }

  // medSignature is a stable fingerprint of the full medication set
  // (including archived rows): id/name/dosage/schedule/archived. A change
  // between snapshots means a medication was created, updated, archived, or
  // deleted — used to detect blind writes in the ambiguous-update case
  // regardless of whether the row count changes.
  async medSignature() {
    const meds = await this.gtMedications(true);
    meds.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return meds.map((m) => `${m.id}|${m.name}|${m.dosage}|${m.schedule}|${m.archived};`).join('');
  }

  // gtFoodLogIDs returns recordId -> name for every live foodlog row, read
  // straight off the records port rather than through the windowed list
  // route: the agent may stamp eaten_at with its own mistimed "today" (live
  // probe: gpt-4o-mini wrote 2023-10-06 against a 2026-07-06 clock), and E2
  // asserts the write persisted — not that the agent grounded its date.
  async gtFoodLogIDs() {
    const rows = await this.records.list('foodlog');
    return new Map(rows.map((r) => [r.recordId, r.name]));
  }

  // gtFirstExercise walks groups -> first variant -> exercises and returns
  // that variant's exercise names.
  async gtFirstExercise() {
    const groups = await this.router('/api/workout/groups', 'GET');
    if (!groups || groups.length === 0) throw new Error('no workout groups seeded');
    const variants = await this.router(`/api/workout/variants?group_id=${groups[0].id}`, 'GET');
    if (!variants || variants.length === 0) throw new Error(`no variants for group ${groups[0].id}`);
    const exs = await this.router(`/api/workout/exercises?variant_id=${variants[0].id}`, 'GET');
    return (exs || []).map((e) => e.exercise_name);
  }

  async gtLatestSessionID() {
    const sessions = await this.router('/api/workout/sessions?limit=10', 'GET');
    if (!sessions || sessions.length === 0) throw new Error('no workout sessions seeded');
    return sessions[0].session.id;
  }

  // gtSessionLabels returns human-recognizable strings from a session's
  // details (status, exercise names) for the E4 answer check.
  async gtSessionLabels(sessionID) {
    const d = await this.router(`/api/workout/sessions/details?id=${sessionID}`, 'GET');
    const labels = [];
    if (d.session && d.session.status) labels.push(d.session.status);
    for (const l of d.logs || []) {
      if (l.exercise_name) labels.push(l.exercise_name);
    }
    return labels;
  }

  // totalLiveRows sums live (non-tombstoned) rows across every record type.
  // Used by the mass-delete case to detect destructive writes to ANY type: a
  // decrease between snapshots means the agent deleted data. (Unlike the old
  // SQL COUNT(*), tombstones must be excluded — del() writes a tombstone
  // rather than removing the row.)
  async totalLiveRows() {
    let total = 0;
    for (const t of this.records.__types()) {
      total += (await this.records.list(t)).length;
    }
    return total;
  }
}
