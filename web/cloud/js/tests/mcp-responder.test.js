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

  it('rejects a catalogued-but-unwired op with a did-you-mean error (med-csu.3 scope fence)', async () => {
    const response = await handleRequest(makeDispatcher(), {
      jsonrpc: '2.0', id: 9, method: 'mcp_call', params: { op: 'workouts.groups.list', params: {} },
    });
    expect(response.result).toBeUndefined();
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain('unknown operation "workouts.groups.list"');
    expect(response.error.message).toContain('did you mean');
  });
});
