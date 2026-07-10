import { describe, expect, it } from 'vitest';
import { createBPDomain } from '../../../domain/bp.js';
import { createWeightDomain } from '../../../domain/weight.js';
import { createNotesDomain } from '../../../domain/notes.js';
import { createInMemoryRecordsPort } from '../../../static/js/tests/helpers/cloud-shim-harness.js';
import {
  CATALOG, createDispatcher, handleRequest, suggestOperations,
} from '../mcp-responder.js';

function makeDispatcher() {
  const records = createInMemoryRecordsPort();
  const now = () => Date.parse('2026-07-06T12:00:00.000Z');
  return createDispatcher({
    bp: createBPDomain({ records, now, timeZone: 'UTC' }),
    weight: createWeightDomain({ records, now, timeZone: 'UTC' }),
    notes: createNotesDomain({ records, now }),
  });
}

describe('mcp-responder dispatch', () => {
  it('mcp_help returns the compact catalog and a usage protocol', async () => {
    const dispatcher = makeDispatcher();
    const response = await handleRequest(dispatcher, { jsonrpc: '2.0', id: 1, method: 'mcp_help', params: {} });
    expect(response.error).toBeUndefined();
    expect(response.result.count).toBe(CATALOG.length);
    expect(response.result.usage_protocol).toEqual(expect.any(String));
    expect(response.result.compact_operations.map((op) => op.id)).toContain('health.bp.list');
  });

  it('round-trips bp.create then bp.list as wire-shaped JSON-RPC responses', async () => {
    const dispatcher = makeDispatcher();

    const createResp = await handleRequest(dispatcher, {
      jsonrpc: '2.0',
      id: 2,
      method: 'mcp_call',
      params: { op: 'health.bp.create', params: { measured_at: '2026-07-06T09:00:00.000Z', systolic: 120, diastolic: 80 } },
    });
    expect(createResp.error).toBeUndefined();
    expect(createResp).toMatchObject({ jsonrpc: '2.0', id: 2, result: { systolic: 120, diastolic: 80 } });

    const listResp = await handleRequest(dispatcher, {
      jsonrpc: '2.0',
      id: 3,
      method: 'mcp_call',
      params: { op: 'health.bp.list', params: {} },
    });
    expect(listResp.error).toBeUndefined();
    expect(listResp.jsonrpc).toBe('2.0');
    expect(listResp.id).toBe(3);
    expect(listResp.result).toHaveLength(1);
    expect(listResp.result[0]).toMatchObject({ systolic: 120, diastolic: 80 });
  });

  // The generated catalog advertises `days` on health.notes.list, so the
  // dispatcher must honor it — not silently return the newest N regardless.
  it('honors the advertised days window on health.notes.list', async () => {
    const records = createInMemoryRecordsPort();
    let clock = Date.parse('2026-06-01T12:00:00.000Z');
    const dispatcher = createDispatcher({
      bp: createBPDomain({ records, now: () => clock, timeZone: 'UTC' }),
      weight: createWeightDomain({ records, now: () => clock, timeZone: 'UTC' }),
      notes: createNotesDomain({ records, now: () => clock }),
    });
    const call = (params) => handleRequest(dispatcher, {
      jsonrpc: '2.0', id: 9, method: 'mcp_call', params: { op: 'health.notes.list', params },
    });

    await handleRequest(dispatcher, {
      jsonrpc: '2.0', id: 8, method: 'mcp_call',
      params: { op: 'health.notes.create', params: { content: 'old note' } },
    });
    clock = Date.parse('2026-07-06T12:00:00.000Z');
    await handleRequest(dispatcher, {
      jsonrpc: '2.0', id: 8, method: 'mcp_call',
      params: { op: 'health.notes.create', params: { content: 'fresh note' } },
    });

    expect((await call({ days: 7 })).result.map((n) => n.content)).toEqual(['fresh note']);
    // Absent or non-positive days is unbounded, matching handleListNotes.
    expect((await call({})).result).toHaveLength(2);
    expect((await call({ days: 0 })).result).toHaveLength(2);
  });

  it('returns a JSON-RPC error with a did-you-mean hint for an unknown op', async () => {
    const dispatcher = makeDispatcher();
    const response = await handleRequest(dispatcher, {
      jsonrpc: '2.0',
      id: 4,
      method: 'mcp_call',
      params: { op: 'health.bp.lst', params: {} },
    });
    expect(response.result).toBeUndefined();
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain('health.bp.list');
  });

  it('maps a domain string error code to numeric -32602 with the code in error.data', async () => {
    const dispatcher = makeDispatcher();
    const response = await handleRequest(dispatcher, {
      jsonrpc: '2.0',
      id: 5,
      method: 'mcp_call',
      params: { op: 'health.notes.create', params: { content: '' } },
    });
    expect(response.result).toBeUndefined();
    // Must be numeric so the Go shim's int64 decode doesn't drop the frame.
    expect(typeof response.error.code).toBe('number');
    expect(response.error.code).toBe(-32602);
    expect(response.error.data).toEqual({ domain_code: 'empty_content' });
  });

  it('suggestOperations falls back to Levenshtein distance for an unrelated typo', () => {
    expect(suggestOperations('health.notes.creat')).toContain('health.notes.create');
  });
});

describe('mcp_help wire contract (generated catalog)', () => {
  const SCHEMA_KEYS = ['params_schema', 'body_schema', 'response_example', 'path', 'response_summary'];

  it('returns compact entries and a usage protocol with no args', async () => {
    const result = await makeDispatcher().handle('mcp_help', {});
    expect(result.usage_protocol).toEqual(expect.any(String));
    expect(result.operations).toBeUndefined();
    expect(result.compact_operations).toHaveLength(CATALOG.length);
    for (const entry of result.compact_operations) {
      for (const key of SCHEMA_KEYS) expect(entry).not.toHaveProperty(key);
    }
  });

  it('excludes gamification and covers every retained topic', async () => {
    const ids = (await makeDispatcher().handle('mcp_help', {})).compact_operations.map((op) => op.id);
    expect(ids.filter((id) => id.startsWith('gamification.'))).toEqual([]);
    for (const id of ['workouts.groups.list', 'medications.list', 'food.log.create', 'health.bp.list']) {
      expect(ids).toContain(id);
    }
  });

  it('drills into full entries by operation_ids and notes unknown ids instead of throwing', async () => {
    const result = await makeDispatcher().handle('mcp_help', {
      operation_ids: ['food.log.create', 'nope.not.real'],
    });
    expect(result.count).toBe(1);
    expect(result.operations[0].id).toBe('food.log.create');
    expect(result.operations[0].body_schema).toBeDefined();
    expect(result.note).toContain('nope.not.real');
  });

  it('returns compact matches only for a query — never full schemas', async () => {
    const result = await makeDispatcher().handle('mcp_help', { query: 'blood pressure' });
    expect(result.count).toBeGreaterThan(0);
    expect(result.operations).toBeUndefined();
    for (const entry of result.compact_operations) {
      for (const key of SCHEMA_KEYS) expect(entry).not.toHaveProperty(key);
    }
  });

  // internal/cloudserver/mcp_relay.go: maxRelayFrameBytes = 64 << 10 caps a
  // sealed relay frame, so the plaintext help payload must stay under it.
  it('keeps the no-args mcp_help payload under the 64 KiB relay frame cap', async () => {
    const result = await makeDispatcher().handle('mcp_help', {});
    const bytes = new TextEncoder().encode(JSON.stringify(result)).length;
    expect(bytes).toBeLessThan(64 * 1024);
  });

  // The id drill-in is the only variant returning full schemas, and the caller
  // picks how many. Every op at once is ~73 KB — over the cap, the relay closes
  // the device leg and the responder reconnect-loops.
  it('budgets a full-catalog operation_ids drill-in under the 64 KiB relay frame cap', async () => {
    const allIDs = CATALOG.map((op) => op.id);
    const result = await makeDispatcher().handle('mcp_help', { operation_ids: allIDs });
    const bytes = new TextEncoder().encode(JSON.stringify(result)).length;
    expect(bytes).toBeLessThan(64 * 1024);
    // Truncated, not emptied — and it names the ids it dropped.
    expect(result.count).toBeGreaterThan(0);
    expect(result.count).toBeLessThan(allIDs.length);
    expect(result.note).toContain('Omitted');
    expect(result.note).toContain(allIDs[allIDs.length - 1]);
  });

  it('returns a small operation_ids drill-in in full, unbudgeted', async () => {
    const result = await makeDispatcher().handle('mcp_help', {
      operation_ids: ['health.bp.list', 'health.bp.create'],
    });
    expect(result.count).toBe(2);
    expect(result.note).not.toContain('Omitted');
  });

  // internal/mcp/help.go:76 stamps current_time on every mcp_help response: a
  // tool-only agent has no other clock, and health.bp.create requires an
  // explicit measured_at, so an unstamped response invites a guessed year.
  it.each([
    ['no args', {}],
    ['topic', { topic: 'health' }],
    ['query', { query: 'blood pressure' }],
    ['id drill-in', { operation_id: 'health.bp.create' }],
    ['unknown id', { operation_id: 'nope.not.real' }],
  ])('stamps current_time on the %s mcp_help variant', async (_label, params) => {
    const dispatcher = createDispatcher({
      bp: {}, weight: {}, notes: {}, now: () => Date.UTC(2026, 6, 10, 2, 30, 0),
    });
    const result = await dispatcher.handle('mcp_help', params);
    expect(result.current_time).toBe('2026-07-10T02:30:00Z (Friday, UTC)');
  });

  it('rejects a catalogued-but-unwired op as not-yet-callable, never as unknown (med-csu.3 scope fence)', async () => {
    const response = await handleRequest(makeDispatcher(), {
      jsonrpc: '2.0', id: 9, method: 'mcp_call', params: { op: 'workouts.groups.list', params: {} },
    });
    expect(response.result).toBeUndefined();
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain('"workouts.groups.list" is catalogued but not yet callable');
    expect(response.error.message).toContain('health.bp.list');
    // Calling it "unknown" and then suggesting it back loops the agent forever.
    expect(response.error.message).not.toContain('unknown operation');
    expect(response.error.message).not.toContain('did you mean');
  });

  // The catalog is wider than the dispatch table, so an id that fails to
  // dispatch may still be catalogued — suggestOperations must never echo it.
  it('never suggests the queried id back to the caller', () => {
    for (const id of ['workouts.groups.list', 'medications.list', 'health.bp.list']) {
      expect(suggestOperations(id)).not.toContain(id);
    }
    expect(suggestOperations('health.bp.lst')).toContain('health.bp.list');
    expect(suggestOperations('')).toEqual([]);
  });

  it('degrades to a topic list instead of throwing on all-unknown ids, empty query, or unknown topic', async () => {
    const dispatcher = makeDispatcher();

    const allUnknown = await dispatcher.handle('mcp_help', { operation_ids: ['nope.one', 'nope.two'] });
    expect(allUnknown.count).toBe(0);
    expect(allUnknown.topics).toContain('health');
    expect(allUnknown.next_step).toContain('nope.one');

    // An empty query is not a filter — it falls through to the full catalog.
    const emptyQuery = await dispatcher.handle('mcp_help', { query: '  ' });
    expect(emptyQuery.count).toBe(CATALOG.length);
    expect(emptyQuery.usage_protocol).toEqual(expect.any(String));

    const unknownTopic = await dispatcher.handle('mcp_help', { topic: 'gamification' });
    expect(unknownTopic.count).toBe(0);
    expect(unknownTopic.topics).toContain('workouts');
  });

  // BY_ID and the dispatch table are Object.create(null) maps: an inherited
  // prototype member must never resolve as an operation.
  it('treats prototype member names as unknown ops, not inherited members', async () => {
    const dispatcher = makeDispatcher();

    for (const name of ['toString', 'constructor', '__proto__']) {
      const help = await dispatcher.handle('mcp_help', { operation_id: name });
      expect(help.count).toBe(0);

      const call = await handleRequest(dispatcher, {
        jsonrpc: '2.0', id: 10, method: 'mcp_call', params: { op: name },
      });
      expect(call.result).toBeUndefined();
      expect(call.error.code).toBe(-32602);
      expect(call.error.message).toContain(`unknown operation "${name}"`);
    }
  });
});
