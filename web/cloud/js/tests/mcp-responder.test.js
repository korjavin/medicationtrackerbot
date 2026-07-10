import 'fake-indexeddb/auto';
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { openMCPFrame, sealMCPFrame, utf8 } from '../crypto.js';
import { createApiRouter } from '../apishim.js';
import { createInMemoryRecordsPort } from '../../../static/js/tests/helpers/cloud-shim-harness.js';
import { allowConsoleNoise } from '../../../static/js/tests/helpers/setup.js';
import {
  CATALOG, clearNonceRing, createDispatcher, createNonceRing, createResponder,
  handleRequest, STATUS_NO_PAIRING, substitutePath, suggestOperations,
} from '../mcp-responder.js';
import { openDb } from '../localdb.js';

// The coverage sweep drives medications.create, whose domain module calls the
// rxnorm port — the real one fetches RxNav over the network. Stub it file-wide;
// no test here asserts on interaction warnings. It resolves a real rxcui so the
// created row carries the rxcui/normalized_name that medications.list documents.
vi.mock('../rxnorm.js', () => ({
  createRxnormPort: () => ({
    searchRxNorm: async () => ({ rxcui: '2601723', normalizedName: 'tirzepatide' }),
    checkInteractions: async () => [],
  }),
}));

// The dispatcher under test routes through the real apishim router over an
// in-memory records port — the same code path the cloud UI takes. Injecting a
// stub router here would prove nothing about whether a catalogued op reaches a
// domain module.
function makeRouter(now = () => Date.parse('2026-07-06T12:00:00.000Z'), records = createInMemoryRecordsPort()) {
  return createApiRouter(null, { records, now, timeZone: 'UTC' });
}

function makeDispatcher() {
  const now = () => Date.parse('2026-07-06T12:00:00.000Z');
  return createDispatcher({ router: makeRouter(now), now });
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
    let clock = Date.parse('2026-06-01T12:00:00.000Z');
    const dispatcher = createDispatcher({ router: makeRouter(() => clock), now: () => clock });
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
      router: () => {}, now: () => Date.UTC(2026, 6, 10, 2, 30, 0),
    });
    const result = await dispatcher.handle('mcp_help', params);
    expect(result.current_time).toBe('2026-07-10T02:30:00Z (Friday, UTC)');
  });

  // A catalogued op the router cannot serve is an internal inconsistency, not
  // bad params: the message must name the route so the next author can add it,
  // and the code must stay numeric or the Go shim drops the frame. Calling it
  // "unknown" and suggesting it back would loop the agent forever. Every real
  // catalog op is routed now (the coverage sweep below is what keeps it that
  // way), so the 404 comes from a stub standing in for a future gap.
  it('maps a catalogued op with no router route to a numeric internal error naming the route', async () => {
    const notFound = () => {
      const err = new Error('Not found: GET /api/workout/exercises/unique');
      err.status = 404;
      throw err;
    };
    const dispatcher = createDispatcher({ router: notFound, now: () => 0 });
    const response = await handleRequest(dispatcher, {
      jsonrpc: '2.0', id: 9, method: 'mcp_call', params: { op: 'workouts.exercises.unique', params: {} },
    });
    expect(response.result).toBeUndefined();
    expect(response.error.code).toBe(-32603);
    expect(response.error.message).toContain('GET /api/workout/exercises/unique');
    expect(response.error.message).not.toContain('unknown operation');
    expect(response.error.message).not.toContain('did you mean');
  });

  // Dispatch is a lookup + an endpoint build, never a second dispatch table:
  // the router receives the substituted path, the querystring-serialized
  // params, and the body — and nothing else translates them.
  it('dispatches through the injected router with a built endpoint', async () => {
    const calls = [];
    const router = (endpoint, method, body) => { calls.push([endpoint, method, body]); return []; };
    const dispatcher = createDispatcher({ router, now: () => 0 });

    await dispatcher.handle('mcp_call', {
      op: 'medications.restocks.list',
      params: { limit: 5 },
      path_params: { id: '1/../2' },
    });
    expect(calls[0]).toEqual(['/api/medications/1%2F..%2F2/restocks?limit=5', 'GET', null]);

    await dispatcher.handle('mcp_call', {
      op: 'health.bp.create',
      mode: 'write',
      intent: 'log the reading',
      body: { systolic: 120, diastolic: 80, measured_at: '2026-07-06T09:00:00.000Z' },
    });
    expect(calls[1]).toEqual(['/api/bp', 'POST', { systolic: 120, diastolic: 80, measured_at: '2026-07-06T09:00:00.000Z' }]);
  });

  // Array and object params need a defined encoding or the router's
  // URLSearchParams read silently sees "[object Object]".
  it('serializes array params as repeated keys and object params as JSON', async () => {
    const calls = [];
    const dispatcher = createDispatcher({ router: (endpoint) => { calls.push(endpoint); return []; }, now: () => 0 });
    await dispatcher.handle('mcp_call', {
      op: 'health.bp.list',
      params: { tags: ['a', 'b'], filter: { min: 1 }, days: 7 },
    });
    expect(calls[0]).toBe('/api/bp?tags=a&tags=b&filter=%7B%22min%22%3A1%7D&days=7');
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
  const now = () => Date.parse('2026-07-06T12:00:00.000Z');
  return createResponder({
    pairingId: 'pair-1',
    key: new Uint8Array(32),
    router: makeRouter(now),
    now,
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
    const now = () => Date.parse('2026-07-06T12:00:00.000Z');
    const responder = createResponder({
      pairingId,
      key,
      router: makeRouter(now, records),
      now,
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

// --- Coverage sweep (med-csu.3) ------------------------------------------
// The acceptance proof: every catalogued op must reach a web/domain module
// through the shared apishim router. apishim.js's unmapped-route 404 is what
// makes that machine-checkable — the dispatcher maps it to a -32603 naming the
// missing METHOD /path, and this sweep fails listing every op that trips it.
//
// Only that one failure mode counts. A domain error (no such medication, a
// bogus schedule string) means the op *was* routed, which is all coverage
// asserts.

describe('cloud MCP coverage sweep', () => {
  // Values are synthesized from each op's catalog `required` names, typed via
  // whichever schema declares them. They only have to be well-formed enough to
  // reach the router; the domain module is free to reject them.
  function sampleValue(type) {
    switch (type) {
      case 'integer': case 'number': return 1;
      case 'boolean': return true;
      case 'array': return [];
      case 'object': return {};
      default: return '1';
    }
  }

  function propType(op, name) {
    const props = {
      ...((op.params_schema && op.params_schema.properties) || {}),
      ...((op.body_schema && op.body_schema.properties) || {}),
    };
    return [].concat((props[name] && props[name].type) || 'string')[0];
  }

  function synthesize(op) {
    const pathParams = {};
    for (const name of op.path_params || []) pathParams[name] = '1';
    const input = {};
    for (const name of op.required || []) {
      if (!(name in pathParams)) input[name] = sampleValue(propType(op, name));
    }
    const params = { operation_id: op.id, params: input, path_params: pathParams };
    if (op.risk === 'write') {
      params.mode = 'write';
      params.intent = 'coverage sweep';
    }
    return params;
  }

  it('routes every catalogued operation to a domain module', async () => {
    allowConsoleNoise(); // the router warns once per unmapped route before throwing
    const now = () => Date.parse('2026-07-06T12:00:00.000Z');
    const router = createApiRouter(null, {
      records: createInMemoryRecordsPort(), now, timeZone: 'UTC',
    });
    const dispatcher = createDispatcher({ router, now });

    const unrouted = [];
    for (const op of CATALOG) {
      // Serial, not Promise.all: the writes share one records port and the
      // failure list should read in catalog order.
      const response = await handleRequest(dispatcher, {
        jsonrpc: '2.0', id: 1, method: 'mcp_call', params: synthesize(op),
      });
      if (response.error && / has no route for /.test(response.error.message)) {
        unrouted.push(`${op.id} → ${op.method} ${op.path}`);
      }
    }

    expect(unrouted, `catalogued ops the cloud router cannot serve:\n  ${unrouted.join('\n  ')}`).toEqual([]);
  });

  // An op whose params carry an array or an object must survive the trip
  // through the querystring — the sweep above would pass on a router that
  // stringified them to "[object Object]" and ignored them.
  it('round-trips an array-valued write param through the router', async () => {
    const now = () => Date.parse('2026-07-06T12:00:00.000Z');
    const router = createApiRouter(null, {
      records: createInMemoryRecordsPort(), now, timeZone: 'UTC',
    });
    const dispatcher = createDispatcher({ router, now });
    const response = await handleRequest(dispatcher, {
      jsonrpc: '2.0',
      id: 1,
      method: 'mcp_call',
      params: {
        operation_id: 'medications.cancel_intake',
        mode: 'write',
        intent: 'coverage sweep',
        params: { intake_ids: [] },
      },
    });
    expect(response.error).toBeUndefined();
  });
});

// --- ResponseExample shape conformance (med-csu.3, Task 5) ----------------
// The registry's ResponseExample is the shape both surfaces advertise to an
// agent. The coverage sweep above only proves an op *reaches* a domain module;
// this proves what comes back looks like what mcp_help promised. Records are
// seeded through the router's own write ops — an all-empty sweep would assert
// nothing about element shape.

describe('cloud MCP response_example conformance', () => {
  const NOW = Date.parse('2026-07-06T12:00:00.000Z');

  // Ops whose reads must come back non-empty: if a fixture stops landing, the
  // key checks below silently degrade to "is an array" and prove nothing.
  const MUST_BE_NON_EMPTY = [
    'health.bp.list', 'health.weight.list', 'health.notes.list', 'food.log.list',
    'food.products.list', 'food.products.search', 'health.weight.goal.history.list',
    'health.sleep.list', 'medications.list', 'medications.history',
    'medications.restocks.list', 'workouts.groups.list', 'workouts.variants.list',
    'workouts.exercises.list', 'workouts.exercise_library.list', 'workouts.miband.list',
    'workouts.sessions.list',
  ];

  async function seedFixtures(dispatcher) {
    const w = async (op, input, pathParams = {}) => {
      const res = await handleRequest(dispatcher, {
        jsonrpc: '2.0',
        id: 1,
        method: 'mcp_call',
        params: {
          operation_id: op,
          params: input,
          path_params: pathParams,
          mode: 'write',
          intent: 'seed the conformance fixture',
        },
      });
      expect(res.error, `${op}: ${res.error && res.error.message}`).toBeUndefined();
      return res.result.result;
    };

    // Every optional field the examples advertise is filled in: the Go handlers
    // mark them `omitempty`, so a sparse fixture would let a domain module that
    // never emits them at all pass the key check.
    await w('health.bp.create', {
      measured_at: '2026-07-06T08:00:00.000Z',
      systolic: 122,
      diastolic: 79,
      pulse: 61,
      site: 'left arm',
      position: 'sitting',
      notes: 'after coffee',
      tag: 'MORNING',
    });
    await w('health.weight.create', {
      measured_at: '2026-07-06T07:00:00.000Z', weight: 78.4, body_fat: 18.2, muscle_mass: 34.1, notes: 'post-run',
    });
    await w('health.notes.create', { content: 'slept well', tag: 'SLEEP' });
    await w('food.targets.set', {
      calories: 2200, carbs: 250, protein: 140, fat: 70,
    });
    await w('food.log.create', {
      name: 'oatmeal', eaten_at: '2026-07-06T08:30:00.000Z', weight: 100, calories: 370, carbs: 60, protein: 13, fat: 7,
    });

    // 20:00 today, inside nextIntake's 12h forecast window from the fixed clock.
    const med = await w('medications.create', {
      name: 'Mounjaro', dosage: '5 mg', schedule: JSON.stringify({ type: 'daily', times: ['20:00'] }), inventory_count: 4,
    });
    const medID = med.id;
    await w('medications.restock', { quantity: 30, note: 'Pharmacy refill' }, { id: String(medID) });
    await w('medications.log_past', { medication_id: medID, taken_at: '2026-07-05T20:00:00.000Z' });

    const group = await w('workouts.groups.create', { name: 'Home Workout', description: 'Bodyweight rotation' });
    // sessions.next scans active groups for a weekday + time match, so the
    // group needs a schedule before it can name a next session.
    await w('workouts.groups.update', {
      id: group.id,
      name: 'Home Workout',
      description: 'Bodyweight rotation',
      is_rotating: true,
      days_of_week: '[0,1,2,3,4,5,6]',
      scheduled_time: '18:00',
      notification_advance_minutes: 15,
      active: true,
    });
    const variant = await w('workouts.variants.create', {
      group_id: group.id, name: 'Push Day', description: 'chest and triceps', rotation_order: 1,
    });
    await w('workouts.exercises.create', {
      variant_id: variant.id,
      exercise_name: 'Bench Press',
      target_sets: 4,
      target_reps_min: 6,
      target_reps_max: 8,
      target_weight_kg: 65,
      order_index: 0,
    });
    await w('workouts.exercise_library.create', {
      name: 'Pull-ups', default_sets: 3, default_reps_min: 8, default_reps_max: 12, default_weight_kg: 5, notes: 'weighted',
    });
    await w('workouts.rotation.initialize', { group_id: group.id, starting_variant_id: variant.id });
    const session = await w('workouts.sessions.schedule', {
      scheduled_date: '2026-07-07',
      scheduled_time: '18:00',
      exercises: [{ exercise_name: 'Bench Press', target_sets: 4, target_reps_min: 6 }],
    });

    return { medID, groupID: group.id, variantID: variant.id, sessionID: session.session.id };
  }

  // Per-op inputs for the reads that need one; everything else runs bare.
  function inputsFor(op, ids) {
    switch (op.id) {
      case 'workouts.variants.list': return { params: { group_id: ids.groupID } };
      case 'workouts.exercises.list': return { params: { variant_id: ids.variantID } };
      case 'workouts.sessions.details': return { params: { id: ids.sessionID } };
      case 'workouts.rotation.state': return { params: { group_id: ids.groupID } };
      case 'medications.restocks.list': return { path_params: { id: String(ids.medID) } };
      case 'food.products.search': return { params: { q: 'oat' } };
      case 'medications.intake.update': return { params: { updates: [] } };
      default: return {};
    }
  }

  function parseExample(op) {
    return typeof op.response_example === 'string' ? JSON.parse(op.response_example) : op.response_example;
  }

  const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  // Returns a mismatch string, or '' when the shapes agree.
  function compareShape(example, actual) {
    if (Array.isArray(example)) {
      if (!Array.isArray(actual)) return `expected an array, got ${actual === null ? 'null' : typeof actual}`;
      if (!example.length || !actual.length || !isPlainObject(example[0])) return '';
      return missingKeys(example[0], actual[0], 'element');
    }
    if (!isPlainObject(actual)) return `expected an object, got ${actual === null ? 'null' : typeof actual}`;
    return missingKeys(example, actual, 'top level');
  }

  function missingKeys(example, actual, where) {
    if (!isPlainObject(example) || !isPlainObject(actual)) return '';
    const missing = Object.keys(example).filter((k) => !(k in actual));
    return missing.length ? `${where} missing ${missing.join(', ')}` : '';
  }

  // Sleep and Mi Band have no catalogued write op (the bands upload them), and
  // the BP goal has no cloud route at all — only the read is catalogued. Those
  // three are seeded straight onto the records port the router reads.
  function seedRecordsPort() {
    return createInMemoryRecordsPort({
      bpgoal: [{ recordId: 'bpgoal', target_systolic: 120, target_diastolic: 80 }],
      sleep: [{
        recordId: 305,
        start_time: '2026-07-05T23:10:00.000Z',
        end_time: '2026-07-06T06:40:00.000Z',
        day: '2026-07-06',
        light_minutes: 240,
        deep_minutes: 110,
        rem_minutes: 80,
        awake_minutes: 20,
        total_minutes: 450,
        turn_over_count: 12,
        heart_rate_avg: 56,
        spo2_avg: 97,
        notes: 'restless',
      }],
      miband: [{
        recordId: 'miband-88',
        id: 88,
        activity_type: 1,
        activity_name: 'Outdoor Running',
        source_start_ms: NOW - 3600_000,
        source_end_ms: NOW - 1200_000,
        tz_offset: 0,
        duration_sec: 2400,
        distance_m: 5200,
        steps: 5400,
        calories: 320,
        heart_rate_avg: 148,
        spo2_avg: 97,
        source: 'miband',
      }],
    });
  }

  it('returns the shape mcp_help advertises for every op carrying a response_example', async () => {
    allowConsoleNoise();
    const now = () => NOW;
    const records = seedRecordsPort();
    const router = createApiRouter(null, { records, now, timeZone: 'UTC' });
    const dispatcher = createDispatcher({ router, now });

    // The weight goal has no catalogued write; post it through the same router.
    await router('/api/weight/goal', 'POST', { target_weight: 75, set_at: '2026-07-01T08:00:00.000Z' });

    const ids = await seedFixtures(dispatcher);

    const mismatches = [];
    const empty = [];
    for (const op of CATALOG.filter((o) => o.response_example !== undefined)) {
      const { params = {}, path_params: pathParams = {} } = inputsFor(op, ids);
      const request = { operation_id: op.id, params, path_params: pathParams };
      if (op.risk === 'write') { request.mode = 'write'; request.intent = 'conformance check'; }
      const response = await handleRequest(dispatcher, {
        jsonrpc: '2.0', id: 1, method: 'mcp_call', params: request,
      });
      if (response.error) { mismatches.push(`${op.id}: errored — ${response.error.message}`); continue; }
      const actual = response.result.result;
      if (Array.isArray(actual) && !actual.length) empty.push(op.id);
      const mismatch = compareShape(parseExample(op), actual);
      if (mismatch) mismatches.push(`${op.id}: ${mismatch}`);
    }

    expect(mismatches, `ops whose result disagrees with the registry response_example:\n  ${mismatches.join('\n  ')}`).toEqual([]);
    // A read that came back empty checked nothing about its element shape.
    expect(
      MUST_BE_NON_EMPTY.filter((id) => empty.includes(id)),
      'seeded reads that still returned an empty array — the fixture stopped landing',
    ).toEqual([]);
  });
});
