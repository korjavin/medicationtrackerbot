import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { createBPDomain } from '../../../domain/bp.js';
import { createWeightDomain } from '../../../domain/weight.js';
import { createNotesDomain } from '../../../domain/notes.js';
import { createInMemoryRecordsPort } from '../../../static/js/tests/helpers/cloud-shim-harness.js';
import {
  CATALOG, createDispatcher, createResponder, handleRequest,
  STATUS_NO_PAIRING, suggestOperations,
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
  it('mcp_help returns the catalog and a usage protocol', async () => {
    const dispatcher = makeDispatcher();
    const response = await handleRequest(dispatcher, { jsonrpc: '2.0', id: 1, method: 'mcp_help', params: {} });
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { catalog: CATALOG, usage_protocol: expect.any(String) },
    });
  });

  it('round-trips bp.create then bp.list as wire-shaped JSON-RPC responses', async () => {
    const dispatcher = makeDispatcher();

    const createResp = await handleRequest(dispatcher, {
      jsonrpc: '2.0',
      id: 2,
      method: 'mcp_call',
      params: { op: 'bp.create', params: { measured_at: '2026-07-06T09:00:00.000Z', systolic: 120, diastolic: 80 } },
    });
    expect(createResp.error).toBeUndefined();
    expect(createResp).toMatchObject({ jsonrpc: '2.0', id: 2, result: { systolic: 120, diastolic: 80 } });

    const listResp = await handleRequest(dispatcher, {
      jsonrpc: '2.0',
      id: 3,
      method: 'mcp_call',
      params: { op: 'bp.list', params: {} },
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
      params: { op: 'bp.lst', params: {} },
    });
    expect(response.result).toBeUndefined();
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain('bp.list');
  });

  it('maps a domain string error code to numeric -32602 with the code in error.data', async () => {
    const dispatcher = makeDispatcher();
    const response = await handleRequest(dispatcher, {
      jsonrpc: '2.0',
      id: 5,
      method: 'mcp_call',
      params: { op: 'notes.create', params: { content: '' } },
    });
    expect(response.result).toBeUndefined();
    // Must be numeric so the Go shim's int64 decode doesn't drop the frame.
    expect(typeof response.error.code).toBe('number');
    expect(response.error.code).toBe(-32602);
    expect(response.error.data).toEqual({ domain_code: 'empty_content' });
  });

  it('suggestOperations falls back to Levenshtein distance for an unrelated typo', () => {
    expect(suggestOperations('notes.creat')).toContain('notes.create');
  });
});

// --- Reconnect loop (med-253) --------------------------------------------
// The relay's pairing table is in-memory and TTL'd; the vault record is not.
// When they disagree the device leg is closed with STATUS_NO_PAIRING, and the
// responder must give up instead of reconnecting forever.

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    FakeSocket.instances.push(this);
  }

  close() { this.readyState = 3; }

  // Drive the close handler the way a browser would.
  fireClose(code) { this.readyState = 3; this.onclose({ code }); }
}
FakeSocket.instances = [];

function makeResponder(overrides = {}) {
  FakeSocket.instances = [];
  const records = createInMemoryRecordsPort();
  const now = () => Date.parse('2026-07-06T12:00:00.000Z');
  return createResponder({
    pairingId: 'pair-1',
    key: new Uint8Array(32),
    records,
    now,
    timeZone: 'UTC',
    relayURL: 'ws://relay.test/api/mcp/relay/device',
    ...overrides,
  });
}

describe('mcp-responder reconnect loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reconnects after a transient close', () => {
    const responder = makeResponder();
    responder.connect();
    expect(FakeSocket.instances).toHaveLength(1);

    FakeSocket.instances[0].fireClose(1006); // abnormal closure, e.g. network drop
    expect(responder.getStatus()).toBe('idle');

    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    responder.stop();
  });

  it('stops permanently on STATUS_NO_PAIRING and reports the stale pairing', () => {
    const onStalePairing = vi.fn();
    const responder = makeResponder({ onStalePairing });
    responder.connect();

    FakeSocket.instances[0].fireClose(STATUS_NO_PAIRING);

    expect(onStalePairing).toHaveBeenCalledTimes(1);
    expect(responder.getStatus()).toBe('idle');

    // The whole point: no reconnect is ever scheduled, however long we wait.
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('does not reconnect after a 4404 close even if a retry was already queued', () => {
    const onStalePairing = vi.fn();
    const responder = makeResponder({ onStalePairing });
    responder.connect();

    FakeSocket.instances[0].fireClose(1006);   // queues a reconnect at +1000ms
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);

    FakeSocket.instances[1].fireClose(STATUS_NO_PAIRING); // must cancel the backoff chain
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(onStalePairing).toHaveBeenCalledTimes(1);
  });
});
