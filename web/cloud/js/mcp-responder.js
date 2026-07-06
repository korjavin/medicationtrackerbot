// Browser-side responder for the MCP blind relay (Tier 1 PoC,
// docs/cloud-mode.md "MCP"; wire contract in internal/mcpshim/frame.go).
// Connects to /api/mcp/relay/device, decrypts each inbound frame, dispatches
// mcp_help/mcp_call to the same in-browser domain modules apishim.js wires
// (bp/weight/notes), encrypts the response, and reconnects with backoff
// while the tab lives. Wired from the unlocked boot path (cloud-boot.js),
// never from web/static — zero bot-mode surface.

import { createBPDomain } from '../../domain/bp.js';
import { createWeightDomain } from '../../domain/weight.js';
import { createNotesDomain } from '../../domain/notes.js';
import { openMCPFrame, sealMCPFrame, utf8 } from './crypto.js';

const decoder = new TextDecoder();

// ponytail: PoC hardcodes this tiny catalog; full C4 generates it from
// internal/mcp/registry filtered to the ported-domain set (see the plan's
// "Locked decisions").
export const CATALOG = [
  {
    id: 'bp.list',
    risk: 'read',
    description: "List the user's blood pressure readings, newest first.",
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'lookback window in days (default 30, 0 = all)' },
        limit: { type: 'integer', description: 'max rows to return (default 100, 0 = unlimited)' },
      },
    },
  },
  {
    id: 'bp.create',
    risk: 'write',
    description: 'Log a new blood pressure reading.',
    input_schema: {
      type: 'object',
      required: ['measured_at', 'systolic', 'diastolic'],
      properties: {
        measured_at: { type: 'string', description: 'ISO 8601 timestamp' },
        systolic: { type: 'integer' },
        diastolic: { type: 'integer' },
        pulse: { type: 'integer' },
        notes: { type: 'string' },
      },
    },
  },
  {
    id: 'weight.list',
    risk: 'read',
    description: "List the user's weight log entries, newest first.",
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'lookback window in days (default 30, 0 = all)' },
        limit: { type: 'integer', description: 'max rows to return (default 100, 0 = unlimited)' },
      },
    },
  },
  {
    id: 'weight.create',
    risk: 'write',
    description: 'Log a new weight entry.',
    input_schema: {
      type: 'object',
      required: ['measured_at', 'weight'],
      properties: {
        measured_at: { type: 'string', description: 'ISO 8601 timestamp' },
        weight: { type: 'number' },
        notes: { type: 'string' },
      },
    },
  },
  {
    id: 'notes.list',
    risk: 'read',
    description: "List the user's diary notes, newest first.",
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'max rows to return (default 50)' },
        before_id: { type: 'string', description: 'pagination cursor: only notes older than this id' },
      },
    },
  },
  {
    id: 'notes.create',
    risk: 'write',
    description: 'Add a diary note.',
    input_schema: {
      type: 'object',
      required: ['content'],
      properties: {
        content: { type: 'string' },
        tag: { type: 'string', description: 'one of SLEEP, STRESS, HR, SPO2, STEPS, NOTE' },
      },
    },
  },
];

export const USAGE_PROTOCOL = 'Discover with mcp_help (no args) — the catalog is small enough to read in full. '
  + 'Run exactly one operation at a time with mcp_call({op, params}). This connector talks directly to your '
  + 'unlocked Med Tracker browser tab over an end-to-end encrypted channel; the relay server never sees your '
  + 'data, only frame sizes and timing. If no device is unlocked and online, mcp_call returns an actionable '
  + 'error instead of hanging.';

// Ported from internal/mcp/proxy's Levenshtein helper, scaled to this
// catalog's handful of entries.
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// suggestOperations mirrors internal/mcp/proxy's did-you-mean semantics
// (substring match first, Levenshtein fallback) over the tiny PoC catalog.
export function suggestOperations(opID) {
  const query = String(opID || '').toLowerCase();
  const substring = CATALOG.filter((op) => query && (op.id.includes(query) || query.includes(op.id))).map((op) => op.id);
  if (substring.length > 0) return substring.slice(0, 3);
  return CATALOG
    .map((op) => ({ id: op.id, dist: levenshtein(query, op.id.toLowerCase()) }))
    .filter((s) => s.dist <= 3)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 3)
    .map((s) => s.id);
}

class MCPError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// createDispatcher builds the mcp_help/mcp_call handlers over the injected
// domain instances (same construction path apishim.js uses for bp/weight/
// notes).
export function createDispatcher({ bp, weight, notes }) {
  const ops = {
    'bp.list': (p) => bp.list(p || {}),
    'bp.create': (p) => bp.create(p || {}),
    'weight.list': (p) => weight.list(p || {}),
    'weight.create': (p) => weight.create(p || {}),
    'notes.list': (p) => notes.list({ limit: p && p.limit, beforeId: p && p.before_id }),
    'notes.create': (p) => notes.create(p || {}),
  };

  async function handle(method, params) {
    if (method === 'mcp_help') {
      return { catalog: CATALOG, usage_protocol: USAGE_PROTOCOL };
    }
    if (method === 'mcp_call') {
      const opID = params && params.op;
      const fn = ops[opID];
      if (!fn) {
        const suggestions = suggestOperations(opID);
        const hint = suggestions.length ? ` — did you mean: ${suggestions.join(', ')}?` : '';
        throw new MCPError(-32602, `unknown operation "${opID}"${hint}`);
      }
      return fn(params && params.params);
    }
    throw new MCPError(-32601, `unknown method "${method}"`);
  }

  return { handle };
}

// handleRequest builds the JSON-RPC 2.0 response object for one decoded
// request message. Pure and framework-free so it can be exercised without
// any WebSocket/crypto plumbing.
export async function handleRequest(dispatcher, request) {
  const response = { jsonrpc: '2.0', id: request.id };
  try {
    response.result = await dispatcher.handle(request.method, request.params);
  } catch (e) {
    response.error = { code: e.code || -32603, message: e.message };
  }
  return response;
}

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// createResponder wires a live relay connection: decrypts each inbound
// frame, dispatches it via handleRequest, encrypts the response, and
// reconnects with backoff while the tab lives (docs/cloud-mode.md "Tab
// lifecycle honesty" — a backgrounded/closed tab is the accepted tier-1
// offline state, surfaced through the shim's timeout error, not this
// module). records/now/timeZone are the same ports apishim.js's domain
// instances take.
export function createResponder({
  pairingId, key, records, now, timeZone, relayURL,
}) {
  const dispatcher = createDispatcher({
    bp: createBPDomain({ records, now, timeZone }),
    weight: createWeightDomain({ records, now, timeZone }),
    notes: createNotesDomain({ records, now }),
  });

  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  let status = 'idle';
  let stopped = false;

  function wsURL() {
    if (relayURL) return relayURL;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/api/mcp/relay/device`;
  }

  async function onFrame(data) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(await data.arrayBuffer());
    let payload;
    try {
      payload = await openMCPFrame(key, pairingId, bytes);
    } catch {
      return; // ponytail: drop undecryptable frames (tamper/wrong-key); full C4 may alert.
    }
    let request;
    try {
      request = JSON.parse(decoder.decode(payload));
    } catch {
      return;
    }
    const response = await handleRequest(dispatcher, request);
    const responseFrame = await sealMCPFrame(key, pairingId, utf8(JSON.stringify(response)));
    ws.send(responseFrame);
  }

  function scheduleReconnect() {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  function connect() {
    stopped = false;
    status = 'connecting';
    ws = new WebSocket(wsURL());
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { status = 'linked'; reconnectDelay = RECONNECT_MIN_MS; };
    ws.onmessage = (ev) => { onFrame(ev.data).catch(() => {}); };
    ws.onclose = () => { status = 'idle'; scheduleReconnect(); };
    ws.onerror = () => {};
  }

  function stop() {
    stopped = true;
    clearTimeout(reconnectTimer);
    status = 'idle';
    if (ws) ws.close();
  }

  return {
    connect,
    stop,
    getStatus: () => status,
    dispatcher,
  };
}
