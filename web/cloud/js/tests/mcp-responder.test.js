import 'fake-indexeddb/auto';
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { openMCPFrame, sealMCPFrame, utf8 } from '../crypto.js';
import { createBPDomain } from '../../../domain/bp.js';
import { createWeightDomain } from '../../../domain/weight.js';
import { createNotesDomain } from '../../../domain/notes.js';
import { createInMemoryRecordsPort } from '../../../static/js/tests/helpers/cloud-shim-harness.js';
import {
  CATALOG, clearNonceRing, createDispatcher, createNonceRing, createResponder,
  handleRequest, STATUS_NO_PAIRING, substitutePath, suggestOperations,
} from '../mcp-responder.js';
import { openDb } from '../localdb.js';

function makeDispatcher() {
  const records = createInMemoryRecordsPort();
  const now = () => Date.parse('2026-07-06T12:00:00.000Z');
  return createDispatcher({
    bp: createBPDomain({ records, now, timeZone: 'UTC' }),
    weight: createWeightDomain({ records, now, timeZone: 'UTC' }),
    notes: createNotesDomain({ records, now }),
    now,
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
      params: {
        op: 'health.bp.create',
        mode: 'write',
        intent: 'log the reading the user just dictated',
        params: { measured_at: '2026-07-06T09:00:00.000Z', systolic: 120, diastolic: 80 },
      },
    });
    expect(createResp.error).toBeUndefined();
    // Bot mode's CallResponse envelope: {status, result, api_calls} always.
    expect(createResp).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      result: { status: 'ok', api_calls: 1, result: { systolic: 120, diastolic: 80 } },
    });
    expect(createResp.result.warnings).toBeUndefined();

    const listResp = await handleRequest(dispatcher, {
      jsonrpc: '2.0',
      id: 3,
      method: 'mcp_call',
      params: { op: 'health.bp.list', params: {} },
    });
    expect(listResp.error).toBeUndefined();
    expect(listResp.jsonrpc).toBe('2.0');
    expect(listResp.id).toBe(3);
    expect(listResp.result.result).toHaveLength(1);
    expect(listResp.result.result[0]).toMatchObject({ systolic: 120, diastolic: 80 });
  });

  // The write-gate and the anti-replay ring both read `risk` off the catalog,
  // so a wired op the catalog doesn't carry would execute writes ungated and
  // undeduped. createDispatcher throws on that; this pins the six wired ids as
  // catalogued so an exclusion can't quietly reopen the hole.
  it('catalogues every dispatchable operation, with write risk on the writes', () => {
    const byID = new Map(CATALOG.map((op) => [op.id, op]));
    for (const id of ['health.bp.list', 'health.weight.list', 'health.notes.list']) {
      expect(byID.has(id), id).toBe(true);
    }
    for (const id of ['health.bp.create', 'health.weight.create', 'health.notes.create']) {
      expect(byID.get(id)?.risk, id).toBe('write');
    }
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

    const write = (content) => handleRequest(dispatcher, {
      jsonrpc: '2.0', id: 8, method: 'mcp_call',
      params: {
        op: 'health.notes.create', mode: 'write', intent: 'seed a note', params: { content },
      },
    });
    await write('old note');
    clock = Date.parse('2026-07-06T12:00:00.000Z');
    await write('fresh note');

    expect((await call({ days: 7 })).result.result.map((n) => n.content)).toEqual(['fresh note']);
    // Absent or non-positive days is unbounded, matching handleListNotes.
    expect((await call({})).result.result).toHaveLength(2);
    expect((await call({ days: 0 })).result.result).toHaveLength(2);
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
      params: {
        op: 'health.notes.create', mode: 'write', intent: 'log a note', params: { content: '' },
      },
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

  it('rejects a path_param the catalog does not declare for the op', async () => {
    const dispatcher = makeDispatcher();
    const response = await handleRequest(dispatcher, {
      jsonrpc: '2.0', id: 6, method: 'mcp_call',
      params: { op: 'health.bp.list', params: {}, path_params: { id: '1' } },
    });
    expect(response.result).toBeUndefined();
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain('unknown path_param "id"');
  });

  // A caller-supplied value must not escape its `{id}` segment, and an unfilled
  // slot must fail loudly rather than resolve to a literal "undefined".
  it('substitutePath encodes values into their slot and rejects a missing one', () => {
    const op = { id: 'food.log.delete', path: '/api/food/log/{id}', path_params: ['id'] };
    expect(substitutePath(op, { id: '1/../2' })).toBe('/api/food/log/1%2F..%2F2');
    expect(() => substitutePath(op, {})).toThrow('missing path_param "id"');
  });

  // A `risk: 'write'` op is refused unless the caller states mode + intent
  // (call.go:74-80). Nothing is persisted by the refused call.
  it('gates a write op on mode: write plus a non-empty intent', async () => {
    const dispatcher = makeDispatcher();
    const create = (extra) => handleRequest(dispatcher, {
      jsonrpc: '2.0',
      id: 7,
      method: 'mcp_call',
      params: { op: 'health.notes.create', params: { content: 'hi' }, ...extra },
    });

    const noMode = await create({});
    expect(noMode.error.code).toBe(-32602);
    expect(noMode.error.message).toContain('mode: "write"');
    expect(noMode.error.message).toContain('intent');

    const blankIntent = await create({ mode: 'write', intent: '   ' });
    expect(blankIntent.error.code).toBe(-32602);
    expect(blankIntent.error.message).toContain('intent is required');

    const badMode = await create({ mode: 'readonly' });
    expect(badMode.error.code).toBe(-32602);

    const listed = await handleRequest(dispatcher, {
      jsonrpc: '2.0', id: 7, method: 'mcp_call', params: { op: 'health.notes.list', params: {} },
    });
    expect(listed.result.result).toHaveLength(0);

    const ok = await create({ mode: 'write', intent: 'user dictated a note' });
    expect(ok.error).toBeUndefined();
    expect(ok.result.result).toMatchObject({ content: 'hi' });
  });

  // The wired write ops advertise only `body_schema`, so an agent following the
  // catalog sends its payload in `body`. That payload must reach the domain call
  // rather than being dropped for an empty `params`.
  it('dispatches a write payload sent in body, not just params', async () => {
    const dispatcher = makeDispatcher();
    const created = await handleRequest(dispatcher, {
      jsonrpc: '2.0',
      id: 20,
      method: 'mcp_call',
      params: {
        operation_id: 'health.bp.create',
        mode: 'write',
        intent: 'log the morning reading',
        body: { measured_at: '2026-07-10T08:00:00Z', systolic: 120, diastolic: 80 },
      },
    });
    expect(created.error).toBeUndefined();
    expect(created.result.warnings).toBeUndefined();
    expect(created.result.result).toMatchObject({ systolic: 120, diastolic: 80 });
  });

  // registry.NormalizeCallInput (normalize_input.go:105) resolves the relative
  // date tokens a clockless agent writes into a timestamp field. Without the
  // repair the token persists verbatim and `Date.parse` makes the row invisible
  // to every subsequent list — a silent write corruption, not an error.
  it('resolves a relative date token in a write and warns about the repair', async () => {
    const dispatcher = makeDispatcher();

    const created = await handleRequest(dispatcher, {
      jsonrpc: '2.0',
      id: 30,
      method: 'mcp_call',
      params: {
        operation_id: 'health.bp.create',
        mode: 'write',
        intent: 'log the reading the user just dictated',
        body: { measured_at: 'now', systolic: 118, diastolic: 76 },
      },
    });
    expect(created.error).toBeUndefined();
    expect(created.result.warnings).toEqual([
      'resolved relative date measured_at="now" to "2026-07-06T12:00:00.000Z" using the device clock',
    ]);
    expect(created.result.result.measured_at).toBe('2026-07-06T12:00:00.000Z');

    const listed = await handleRequest(dispatcher, {
      jsonrpc: '2.0',
      id: 31,
      method: 'mcp_call',
      params: { operation_id: 'health.bp.list', params: {} },
    });
    expect(listed.result.result.map((r) => r.systolic)).toEqual([118]);
  });

  it('leaves a real timestamp and an unrecognized word untouched', async () => {
    const dispatcher = makeDispatcher();
    const created = await handleRequest(dispatcher, {
      jsonrpc: '2.0',
      id: 32,
      method: 'mcp_call',
      params: {
        operation_id: 'health.bp.create',
        mode: 'write',
        intent: 'log a backdated reading',
        body: { measured_at: '2026-07-05T09:00:00.000Z', systolic: 120, diastolic: 80 },
      },
    });
    expect(created.result.warnings).toBeUndefined();
    expect(created.result.result.measured_at).toBe('2026-07-05T09:00:00.000Z');
  });

  // "constructor"/"valueOf" are inherited Object.prototype members, not date
  // tokens. A prototype-carrying lookup map resolves them to a function, and
  // `new Date(NaN).toISOString()` then throws — turning the warn-only repair
  // into a -32603. Go's map lookup simply misses; so must this one.
  it('leaves a prototype-member name in a date field untouched', async () => {
    const dispatcher = makeDispatcher();
    const created = await handleRequest(dispatcher, {
      jsonrpc: '2.0',
      id: 33,
      method: 'mcp_call',
      params: {
        operation_id: 'health.bp.create',
        mode: 'write',
        intent: 'log a reading',
        body: { measured_at: 'constructor', systolic: 120, diastolic: 80 },
      },
    });
    expect(created.error).toBeUndefined();
    expect(created.result.result.measured_at).toBe('constructor');
  });

  // registry.ValidateInput never blocks (call.go:118): a mistyped or missing
  // field warns, the call still runs, and the data comes back under `result`.
  it('warns on a schema mismatch without blocking the call', async () => {
    const dispatcher = makeDispatcher();

    const created = await handleRequest(dispatcher, {
      jsonrpc: '2.0',
      id: 11,
      method: 'mcp_call',
      params: {
        op: 'health.weight.create',
        mode: 'write',
        intent: 'log the weigh-in',
        // weight is required and declared "number"; a string trips both checks
        // the Go validator makes, and measured_at is absent entirely.
        params: { weight: '81.2' },
      },
    });
    expect(created.error).toBeUndefined();
    expect(created.result.warnings).toEqual([
      'body.measured_at: required field missing',
      'body.weight: expected number, got string',
    ]);
    expect(created.result.result).toMatchObject({ weight: '81.2' });

    // A clean call carries the same envelope, minus `warnings` — the shape must
    // not depend on whether the input happened to trip a warning.
    const clean = await handleRequest(dispatcher, {
      jsonrpc: '2.0', id: 12, method: 'mcp_call', params: { op: 'health.weight.list', params: { days: 7 } },
    });
    expect(clean.result).toMatchObject({ status: 'ok', api_calls: 1 });
    expect(Array.isArray(clean.result.result)).toBe(true);
    expect(clean.result.warnings).toBeUndefined();
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

  // Parity with registry.Search's tokenized fallback: a natural multi-word
  // query that matches no whole-phrase must still land on the workout ops
  // rather than dead-ending at count: 0.
  it('falls back to token matching for multi-word queries with no phrase match', async () => {
    const result = await makeDispatcher().handle('mcp_help', { query: 'first workout group exercises' });
    expect(result.count).toBeGreaterThan(0);
    expect(result.compact_operations.some((op) => op.topic === 'workouts')).toBe(true);
    // One common token can't drag in the whole catalog.
    expect(result.count).toBeLessThan(CATALOG.length);
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
// --- Reconnect loop (med-253) --------------------------------------------
// The relay's pairing table is in-memory and TTL'd; the vault record is not.
// When they disagree the device leg is closed with STATUS_NO_PAIRING, and the
// responder must give up instead of reconnecting forever.

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.instances.push(this);
  }

  send(data) { this.sent.push(data); }

  close() { this.readyState = 3; }

  // Drive the close handler the way a browser would.
  fireClose(code) { this.readyState = 3; this.onclose({ code }); }
}
FakeSocket.instances = [];
FakeSocket.OPEN = 1;

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

// --- Anti-replay (med-csu.2) ---------------------------------------------
// The dedupe lives at the frame layer, so this must drive a real sealed frame
// through createResponder twice. Two dispatcher calls would prove nothing.

describe('mcp-responder write-frame replay guard', () => {
  const decoder = new TextDecoder();
  const pairingId = 'pair-replay';
  const key = new Uint8Array(32).fill(7);

  beforeEach(() => { vi.stubGlobal('WebSocket', FakeSocket); });
  afterEach(() => { vi.unstubAllGlobals(); });

  function boot(records) {
    FakeSocket.instances = [];
    const responder = createResponder({
      pairingId,
      key,
      records,
      now: () => Date.parse('2026-07-06T12:00:00.000Z'),
      timeZone: 'UTC',
      relayURL: 'ws://relay.test/api/mcp/relay/device',
    });
    responder.connect();
    const sock = FakeSocket.instances[0];
    sock.readyState = 1;
    return { responder, sock };
  }

  async function deliver(sock, frame) {
    const before = sock.sent.length;
    sock.onmessage({ data: frame.buffer });
    await vi.waitFor(() => expect(sock.sent.length).toBe(before + 1));
    const payload = await openMCPFrame(key, pairingId, sock.sent[sock.sent.length - 1]);
    return JSON.parse(decoder.decode(payload));
  }

  it('applies a replayed write frame exactly once, even across a tab reload', async () => {
    const records = createInMemoryRecordsPort();
    const frame = await sealMCPFrame(key, pairingId, utf8(JSON.stringify({
      jsonrpc: '2.0',
      id: 42,
      method: 'mcp_call',
      params: {
        op: 'health.notes.create', mode: 'write', intent: 'user dictated a note', params: { content: 'once' },
      },
    })));

    const first = boot(records);
    expect((await deliver(first.sock, frame)).result.result).toMatchObject({ content: 'once' });

    // Same sealed bytes again on the live connection: refused, not re-applied.
    const replay = await deliver(first.sock, frame);
    expect(replay.result).toBeUndefined();
    expect(replay.error.code).toBe(-32600);
    expect(replay.error.message).toContain('duplicate frame');
    first.responder.stop();

    // The ring is persisted, so a reload cannot clear the guard.
    const reloaded = boot(records);
    expect((await deliver(reloaded.sock, frame)).error.code).toBe(-32600);
    const listed = await reloaded.responder.dispatcher.handle('mcp_call', { op: 'health.notes.list', params: {} });
    expect(listed.result).toHaveLength(1);
    reloaded.responder.stop();
  });

  // Every connectClaude mints a fresh pairing_id, so an un-cleared ring leaks
  // one IndexedDB key per connect/disconnect cycle, forever.
  it('clearNonceRing drops the pairing ring so its key does not outlive the pairing', async () => {
    const ring = createNonceRing('pair-gc');
    expect(await ring.seen('aa11')).toBe(false);
    expect(await ring.seen('aa11')).toBe(true);

    await clearNonceRing('pair-gc');

    const db = await openDb();
    try {
      const stored = await new Promise((resolve, reject) => {
        const req = db.transaction('device', 'readonly').objectStore('device').get('mcpSeenNonces:pair-gc');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      expect(stored).toBeUndefined();
    } finally {
      db.close();
    }
    // A cleared ring means the old pairing's nonces are gone, not remembered.
    expect(await createNonceRing('pair-gc').seen('aa11')).toBe(false);
  });

  it('clearNonceRing on a pairing that never wrote is a no-op', async () => {
    await expect(clearNonceRing('pair-never-used')).resolves.toBeUndefined();
    await expect(clearNonceRing(undefined)).resolves.toBeUndefined();
  });

  // A replayed read is idempotent — deduping it would break an agent polling
  // the same op, and bloat the ring for no security gain.
  it('lets a replayed read frame through', async () => {
    const records = createInMemoryRecordsPort();
    const frame = await sealMCPFrame(key, pairingId, utf8(JSON.stringify({
      jsonrpc: '2.0', id: 43, method: 'mcp_call', params: { op: 'health.bp.list', params: {} },
    })));
    const { responder, sock } = boot(records);
    expect((await deliver(sock, frame)).error).toBeUndefined();
    expect((await deliver(sock, frame)).error).toBeUndefined();
    responder.stop();
  });
});
