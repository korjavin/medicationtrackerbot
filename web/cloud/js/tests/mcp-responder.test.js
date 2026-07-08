import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createBPDomain } from '../../../domain/bp.js';
import { createWeightDomain } from '../../../domain/weight.js';
import { createNotesDomain } from '../../../domain/notes.js';
import { createInMemoryRecordsPort } from '../../../static/js/tests/helpers/cloud-shim-harness.js';
import {
  CATALOG, createDispatcher, handleRequest, suggestOperations, createResponder
} from '../mcp-responder.js';
import * as mcpPairing from '../mcp-pairing.js';

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

describe('mcp-responder reconnect logic', () => {
  let originalFetch;
  let originalWebSocket;
  let mockWebSocket;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalWebSocket = global.WebSocket;

    // Mock fetch for preflight
    global.fetch = vi.fn();

    // Mock WebSocket to prevent actual connections
    mockWebSocket = {
      close: vi.fn(),
      send: vi.fn(),
      readyState: 1, // OPEN
      addEventListener: vi.fn()
    };
    global.WebSocket = vi.fn(() => mockWebSocket);

    // Mock the dynamic import of mcp-pairing.js
    vi.mock('../mcp-pairing.js', () => ({
      purgePairing: vi.fn()
    }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    global.WebSocket = originalWebSocket;
    vi.clearAllMocks();
  });

  function setupResponder() {
    const records = createInMemoryRecordsPort();
    const responder = createResponder({
      pairingId: 'test-pairing',
      key: new Uint8Array(32),
      records,
      now: () => Date.now(),
      timeZone: 'UTC',
      relayURL: 'wss://test.local/api/mcp/relay/device'
    });
    return responder;
  }

  it('fetch(wsURL-as-http) returning 404 deletes the mcppairing vault record and stops without opening a WebSocket', async () => {
    // Simulate server dropped pairing (404)
    global.fetch.mockResolvedValue({ status: 404 });

    let stalePairingCalled = false;
    const records = createInMemoryRecordsPort();
    // Seed the singleton
    await records.put('mcppairing', { recordId: 'mcppairing', pairingId: 'test-pairing', deleted: false });

    const responder = createResponder({
      pairingId: 'test-pairing',
      key: new Uint8Array(32),
      records,
      now: () => Date.now(),
      timeZone: 'UTC',
      relayURL: 'wss://test.local/api/mcp/relay/device',
      onStalePairing: () => { stalePairingCalled = true; },
    });

    await responder.connect();

    // Ensure fetch was called on http scheme equivalent of the ws
    expect(global.fetch).toHaveBeenCalledWith('https://test.local/api/mcp/relay/device');

    // WebSocket should NOT be opened
    expect(global.WebSocket).not.toHaveBeenCalled();

    // Responder should stop, so its status goes back to idle or stays connecting but doesn't instantiate ws
    // Wait for the async purge to finish processing - the import is async inside connect()
    await new Promise(resolve => setTimeout(resolve, 50));

    // Ensure the onStalePairing callback was called
    expect(stalePairingCalled).toBe(true);
    expect(responder.getStatus()).toBe('idle');
  });

  it('A non-404 preflight response, for example 400 from a valid websocket endpoint without upgrade headers, still proceeds to open the websocket', async () => {
    // Simulate valid pairing but HTTP preflight yields 400
    global.fetch.mockResolvedValue({ status: 400 });

    const responder = setupResponder();
    await responder.connect();

    expect(global.fetch).toHaveBeenCalled();

    // WebSocket SHOULD be instantiated
    expect(global.WebSocket).toHaveBeenCalledWith('wss://test.local/api/mcp/relay/device');
    expect(responder.getStatus()).toBe('connecting'); // Since onopen hasn't fired
  });

  it('A network error during preflight does not permanently stop the responder; it still attempts the websocket path', async () => {
    // Simulate network error during preflight
    global.fetch.mockRejectedValue(new TypeError('Failed to fetch'));

    const responder = setupResponder();
    await responder.connect();

    expect(global.fetch).toHaveBeenCalled();

    // WebSocket SHOULD be instantiated, falling through the catch
    expect(global.WebSocket).toHaveBeenCalledWith('wss://test.local/api/mcp/relay/device');
  });
});
