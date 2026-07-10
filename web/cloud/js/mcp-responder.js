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
import { CATALOG } from './mcp-catalog.generated.js';

// Re-exported: the catalog is generated from internal/mcp/registry by
// cmd/genmcpcatalog, but this module stays its import site for the rest of
// cloud mode. Regenerate with `go run ./cmd/genmcpcatalog`.
export { CATALOG };

const decoder = new TextDecoder();

export const USAGE_PROTOCOL = 'Decision rule: (1) Discover — call mcp_help with no args (or topic=/query=) for the '
  + 'terse catalog, then drill in with operation_id=/operation_ids=[...] for full schemas. The catalog is too large '
  + 'to return in full; only an id drill-in returns schemas. (2) Run exactly ONE operation per call with '
  + 'mcp_call({op, params}). There is no mcp_execute in cloud mode: this connector is zero-knowledge, the server '
  + 'cannot see your plaintext, so there is no server-side script runtime — chain mcp_call instead. This connector '
  + 'talks directly to your unlocked Med Tracker browser tab over an end-to-end encrypted channel; the relay server '
  + 'never sees your data, only frame sizes and timing. If no device is unlocked and online, mcp_call returns an '
  + "actionable error instead of hanging. For relative dates ('today', 'now', 'yesterday', 'last N days') use this "
  + "response's current_time as the real clock — never guess the date or year.";

// currentTimeHint mirrors internal/mcp/help.go's helper of the same name: a
// tool-only agent has no other clock, and the wired writes take an explicit
// timestamp (health.bp.create/health.weight.create require measured_at), so an
// unstamped response invites a guessed year. Same layout as Go's, weekday
// included.
function currentTimeHint(nowMs) {
  const d = new Date(nowMs);
  const weekday = d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  return `${d.toISOString().replace(/\.\d{3}Z$/, 'Z')} (${weekday}, UTC)`;
}

// Prototype-free so a caller-supplied id like "toString"/"constructor" misses
// (→ the unknown-op path) instead of resolving an inherited prototype member.
const BY_ID = CATALOG.reduce((m, op) => { m[op.id] = op; return m; }, Object.create(null));
const TOPICS = [...new Set(CATALOG.map((op) => op.topic))].sort();

// Ported from internal/mcp/proxy's Levenshtein helper. O(n·m) per entry, run
// once per catalog entry on an unknown op — a rare, already-failing path.
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
// (substring match first, Levenshtein ≤3 fallback, top 3). The query itself is
// never a candidate: unlike bot mode, cloud mode's catalog is wider than its
// dispatch table, so an id that fails to dispatch may still be catalogued, and
// "did you mean: <the id you just called>?" would loop the calling agent.
export function suggestOperations(opID) {
  const query = String(opID || '').toLowerCase();
  if (!query) return [];
  const candidates = CATALOG.filter((op) => op.id.toLowerCase() !== query);
  const substring = candidates.filter((op) => op.id.includes(query) || query.includes(op.id)).map((op) => op.id);
  if (substring.length > 0) return substring.slice(0, 3);
  return candidates
    .map((op) => ({ id: op.id, dist: levenshtein(query, op.id.toLowerCase()) }))
    .filter((s) => s.dist <= 3)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 3)
    .map((s) => s.id);
}

// compactEntry is the terse projection returned by every mcp_help variant
// except an explicit id drill-in. `required` is baked into the generated
// catalog by cmd/genmcpcatalog, so a write is formable straight from here.
function compactEntry(op) {
  const e = {
    id: op.id, topic: op.topic, method: op.method, risk: op.risk, description: op.description,
  };
  if (op.required && op.required.length) e.required = op.required;
  return e;
}

const lower = (v) => String(v == null ? '' : v).trim().toLowerCase();

// Ported from registry.searchStopwords / searchTokens / Registry.Search's
// fallback. Cloud mcp_help must answer natural multi-word queries ("first
// workout group exercises") the same way bot mode does — a zero-result
// dead-end is what makes weaker agents give up instead of drilling in.
const SEARCH_STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'what', 'that', 'with', 'your', 'you',
  'how', 'can', 'from', 'this', 'all', 'any', 'give', 'show', 'tell', 'does',
]);

function searchTokens(q) {
  return [...new Set(q.match(/[a-z0-9]+/g) || [])]
    .filter((tok) => tok.length >= 3 && !SEARCH_STOPWORDS.has(tok));
}

// searchCatalog mirrors registry.Search: whole-phrase substring across
// id/description/topic/response_summary first; only when that matches nothing,
// an OR-match over tokens ranked by distinct hits. A 2+ token query must hit at
// least 2 tokens on the same op so one common word can't drag in the catalog.
function searchCatalog(query) {
  const phrase = CATALOG.filter((op) => [op.id, op.description, op.topic, op.response_summary]
    .some((field) => lower(field).includes(query)));
  if (phrase.length > 0) return phrase.sort((a, b) => (a.id < b.id ? -1 : 1));

  const tokens = searchTokens(query);
  if (tokens.length === 0) return [];
  const minScore = tokens.length >= 2 ? 2 : 1;
  return CATALOG
    .map((op) => {
      const hay = lower(`${op.id} ${op.topic} ${op.description} ${op.response_summary || ''}`);
      return { op, score: tokens.filter((tok) => hay.includes(tok)).length };
    })
    .filter((s) => s.score >= minScore)
    .sort((a, b) => (b.score - a.score) || (a.op.id < b.op.id ? -1 : 1))
    .map((s) => s.op);
}

// An id drill-in is the only mcp_help variant that returns full schemas, and
// its size is caller-controlled: internal/cloudserver/mcp_relay.go caps a
// sealed relay frame at 64 KiB (maxRelayFrameBytes), and the whole catalog as
// full entries is ~73 KB. Over the cap the relay closes the device leg, so the
// agent sees an offline-device timeout and the responder reconnect-loops.
// Budget the entries by serialized size (not a count — entry sizes vary ~4x)
// and leave headroom for the envelope, note/next_step, and frame overhead.
const HELP_ENTRY_BUDGET_BYTES = 48 * 1024;

// takeWithinBudget returns the longest prefix of ids whose entries fit the
// budget, plus the ids that were dropped. At least one entry is always
// returned, so a single oversized op still answers rather than returning empty.
function takeWithinBudget(ids) {
  const kept = [];
  let bytes = 0;
  for (const id of ids) {
    const size = utf8(JSON.stringify(BY_ID[id])).length;
    if (kept.length > 0 && bytes + size > HELP_ENTRY_BUDGET_BYTES) break;
    bytes += size;
    kept.push(id);
  }
  return { kept, dropped: ids.slice(kept.length) };
}

// buildHelp mirrors internal/mcp/help.go's precedence: ids > query > topic >
// full catalog. Only an id drill-in returns full entries — internal/cloudserver/
// mcp_relay.go caps a relay frame at 64 KiB and the full catalog is ~100 KB.
// Query matches stay compact deliberately: help.go:161-167 records that full
// nested schemas on a query response make weaker models emit an empty turn.
function buildHelp(params) {
  const p = params || {};
  const requested = [p.operation_id, ...(Array.isArray(p.operation_ids) ? p.operation_ids : [])]
    .map(lower)
    .filter(Boolean);

  if (requested.length > 0) {
    const found = requested.filter((id) => BY_ID[id]);
    const missing = requested.filter((id) => !BY_ID[id]);
    if (found.length === 0) {
      return {
        count: 0,
        topics: TOPICS,
        next_step: `Operation "${missing.join(', ')}" not found. Pick a topic (e.g. 'workouts') or call mcp_help with no args for the full catalog.`,
      };
    }
    const { kept, dropped } = takeWithinBudget(found);
    let note = `Showing full details for ${kept.length} operation(s).`;
    if (missing.length > 0) note += ` Not found: ${missing.join(', ')}.`;
    if (dropped.length > 0) {
      note += ` Omitted ${dropped.length} operation(s) to stay under the relay's frame limit`
        + ` — request them in a follow-up mcp_help call: ${dropped.join(', ')}.`;
    }
    return {
      operations: kept.map((id) => BY_ID[id]),
      count: kept.length,
      note,
      next_step: 'Review the operation details, then run one with mcp_call({op, params}).',
    };
  }

  const query = lower(p.query);
  if (query) {
    const matches = searchCatalog(query);
    if (matches.length === 0) {
      return {
        count: 0,
        topics: TOPICS,
        note: `No operations matched query "${query}".`,
        next_step: 'Try a broader keyword, browse a topic from the list below, or omit all filters for the full catalog.',
      };
    }
    return {
      compact_operations: matches.map(compactEntry),
      count: matches.length,
      note: `Showing ${matches.length} match(es) for query "${query}". These are OPERATIONS you can run, not the data itself — re-running the same search makes no progress.`,
      next_step: `ACT NOW — don't search again: call mcp_call({op: "${matches[0].id}", params: {…}}), or pick whichever id above matches the request. Need a field's exact type? Call mcp_help({operation_id: "${matches[0].id}"}) for the full schema.`,
    };
  }

  const topic = lower(p.topic);
  if (topic && topic !== 'all') {
    const ops = CATALOG.filter((op) => op.topic === topic);
    if (ops.length === 0) {
      return { count: 0, topics: TOPICS, next_step: `Topic "${topic}" not found. Try one of the topics listed below.` };
    }
    return {
      compact_operations: ops.map(compactEntry),
      count: ops.length,
      note: `Showing ${ops.length} operation(s) for topic "${topic}" (id · method · risk · description, plus required input fields). Drill in with operation_id for full schemas.`,
      next_step: `Explore the operations for topic "${topic}", then act with mcp_call.`,
    };
  }

  return {
    compact_operations: CATALOG.map(compactEntry),
    count: CATALOG.length,
    topics: TOPICS,
    usage_protocol: USAGE_PROTOCOL,
    note: 'The full operation catalog is shown below in terse form (id, topic, method, risk, description, required). Drill in with topic="workouts" or operation_id="workouts.groups.list" for params/body schemas, or pass query="blood pressure" to keyword-search.',
    next_step: "Pick a topic, look up an operation by ID, or pass query='blood pressure' to keyword-search.",
  };
}

class MCPError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Mirrors proxy.ModeReadOnly / proxy.ModeWrite (internal/mcp/proxy/proxy.go:26).
export const MODE_READ_ONLY = 'read_only';
export const MODE_WRITE = 'write';

const PATH_PLACEHOLDER = /\{([^{}]+)\}/g;
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// substitutePath ports registry.SubstitutePath (internal/mcp/registry/
// registry.go:571): fill the op's `{name}` slots from the caller's path_params,
// allowlisted by the catalog's path_params, values percent-encoded so a value
// like "1/../2" cannot escape its segment. A slot with no value is an error, so
// no path can be dispatched with an "undefined" segment.
//
// The resolved path has no consumer yet — cloud mode dispatches by function,
// not by URL — so today this runs as validation only. med-csu.3 wires the
// catalogued /{id}/ ops and will route on the returned path.
export function substitutePath(op, pathParams) {
  const allowed = op.path_params || [];
  const values = pathParams || {};
  for (const name of Object.keys(values)) {
    if (!allowed.includes(name)) {
      throw new MCPError(-32602, `unknown path_param "${name}" for operation "${op.id}"`
        + ` — allowed: ${allowed.length ? allowed.join(', ') : 'none'}`);
    }
  }
  return String(op.path || '').replace(PATH_PLACEHOLDER, (_, name) => {
    if (!has(values, name) || values[name] === '' || values[name] == null) {
      throw new MCPError(-32602, `missing path_param "${name}" for operation "${op.id}"`);
    }
    return encodeURIComponent(String(values[name]));
  });
}

// createDispatcher builds the mcp_help/mcp_call handlers over the injected
// domain instances (same construction path apishim.js uses for bp/weight/
// notes).
export function createDispatcher({
  bp, weight, notes, now = Date.now,
}) {
  // Keyed by the registry's operation ids (health.bp.list, not bp.list) so the
  // ids mcp_call accepts are exactly the ids the generated catalog advertises.
  // Only these six are wired; med-csu.3 wires the rest of the catalog.
  //
  // Prototype-free so a caller-supplied op like "toString"/"constructor"
  // resolves to undefined (→ the unknown-op did-you-mean path) instead of an
  // inherited Object.prototype member that would dispatch a bogus result.
  const ops = Object.assign(Object.create(null), {
    'health.bp.list': (p) => bp.list(p || {}),
    'health.bp.create': (p) => bp.create(p || {}),
    'health.weight.list': (p) => weight.list(p || {}),
    'health.weight.create': (p) => weight.create(p || {}),
    'health.notes.list': (p) => notes.list({ days: p && p.days, limit: p && p.limit, beforeId: p && p.before_id }),
    'health.notes.create': (p) => notes.create(p || {}),
  });

  async function handle(method, params) {
    if (method === 'mcp_help') {
      // Stamped here, where every mcp_help variant converges (help.go:76 does
      // the same), so no branch can ship an unclocked response.
      return { ...buildHelp(params), current_time: currentTimeHint(now()) };
    }
    if (method === 'mcp_call') {
      // Full bot-mode envelope (internal/mcp/call.go:20-27): operation_id is
      // primary, `op` stays a back-compat alias because existing pairings and
      // older mcpshim binaries still send it.
      const p = params || {};
      const opID = p.operation_id || p.op;
      const fn = ops[opID];
      if (!fn) {
        // The generated catalog mirrors the whole Go registry, but cloud mode
        // dispatches only `ops` (med-csu.3 wires the rest). A catalogued id is
        // not "unknown" — telling an agent it is, then suggesting that same id
        // back, makes it re-issue the identical call forever.
        if (BY_ID[opID]) {
          throw new MCPError(-32602, `operation "${opID}" is catalogued but not yet callable in cloud mode. `
            + `Callable now: ${Object.keys(ops).join(', ')}.`);
        }
        const suggestions = suggestOperations(opID);
        const hint = suggestions.length ? ` — did you mean: ${suggestions.join(', ')}?` : '';
        throw new MCPError(-32602, `unknown operation "${opID}"${hint}`);
      }

      // Absent mode means read-only, matching call.go:70-73. Write-intent
      // gating on top of this lands in Task 3.
      const mode = p.mode == null || p.mode === '' ? MODE_READ_ONLY : String(p.mode);
      if (mode !== MODE_READ_ONLY && mode !== MODE_WRITE) {
        throw new MCPError(-32602, `mode must be "${MODE_READ_ONLY}" or "${MODE_WRITE}", got "${mode}"`);
      }

      // Validates the path_params against the catalog allowlist and rejects an
      // unfilled slot. `body` stays a pass-through for the write ops that take
      // one; none of the six wired ops do, so nothing consumes it yet.
      substitutePath(BY_ID[opID] || { id: opID }, p.path_params);

      return fn(p.params);
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
    // JSON-RPC error.code MUST be numeric — the Go shim decodes it into an
    // int64 (jsonrpc.WireError.Code) and drops the whole frame on a string,
    // which surfaces as a bogus offline-device timeout instead of the real
    // error. Domain modules (web/domain/notes.js) throw string codes like
    // "empty_content" for user-correctable validation failures, so map any
    // non-numeric code to -32602 (invalid params) and keep the original in
    // error.data.
    if (typeof e.code === 'number') {
      response.error = { code: e.code, message: e.message };
    } else if (e.code) {
      response.error = { code: -32602, message: e.message, data: { domain_code: e.code } };
    } else {
      response.error = { code: -32603, message: e.message };
    }
  }
  return response;
}

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// Mirrors StatusNoPairing in internal/cloudserver/mcp_relay.go: the relay has
// no pairing for this account, so reconnecting is futile.
export const STATUS_NO_PAIRING = 4404;

// createResponder wires a live relay connection: decrypts each inbound
// frame, dispatches it via handleRequest, encrypts the response, and
// reconnects with backoff while the tab lives (docs/cloud-mode.md "Tab
// lifecycle honesty" — a backgrounded/closed tab is the accepted tier-1
// offline state, surfaced through the shim's timeout error, not this
// module). records/now/timeZone are the same ports apishim.js's domain
// instances take.
//
// onStalePairing fires when the relay reports the pairing is gone; the owner
// (reconcile) drops the vault record. The responder is already stopped by
// then, so the callback must not stop it again.
export function createResponder({
  pairingId, key, records, now, timeZone, relayURL, onStalePairing = () => {},
}) {
  const dispatcher = createDispatcher({
    bp: createBPDomain({ records, now, timeZone }),
    weight: createWeightDomain({ records, now, timeZone }),
    notes: createNotesDomain({ records, now }),
    now,
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
    // Capture the socket this frame arrived on: the dispatch below awaits, and
    // a reconnect (see scheduleReconnect) can rebind `ws` to a new CONNECTING
    // socket meanwhile — send()ing on that throws and loses the response.
    const sock = ws;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(await data.arrayBuffer());
    let payload;
    try {
      payload = await openMCPFrame(key, pairingId, bytes);
    } catch {
      return; // ponytail: drop undecryptable frames (tamper/wrong-key); full C4 may alert.
    }
    // ponytail: no anti-replay/dedup — the blind relay could replay a captured
    // write frame and this re-executes it. Binding a per-connection counter into
    // the frame AAD + a seen-id window here is full-C4 scope (see the plan).
    let request;
    try {
      request = JSON.parse(decoder.decode(payload));
    } catch {
      return;
    }
    const response = await handleRequest(dispatcher, request);
    const responseFrame = await sealMCPFrame(key, pairingId, utf8(JSON.stringify(response)));
    if (sock.readyState === WebSocket.OPEN) sock.send(responseFrame);
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
    ws.onclose = (ev) => {
      status = 'idle';
      // The relay forgot this pairing (see StatusNoPairing in mcp_relay.go).
      // Reconnecting can never succeed: stop, and let the owner drop the
      // stale vault record. Every other close is transient — back off.
      if (ev && ev.code === STATUS_NO_PAIRING) {
        stopped = true;
        clearTimeout(reconnectTimer);
        onStalePairing();
        return;
      }
      scheduleReconnect();
    };
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

// --- Singleton responder controller -------------------------------------
// The responder's lifecycle must track the vault pairing at RUNTIME, not just
// at boot: "Connect Claude" mints a pairing (start), "Disconnect" removes it
// (stop), re-pairing replaces the key (restart) — all without a page reload.
// boot, connect, and disconnect therefore call refreshResponder(ctx) /
// stopResponder(). One Web Lock ('mcp-responder') elects a single answering
// tab across the account; the elected tab swaps its inner responder in place
// as the pairing changes.
//
// ponytail: cross-tab re-pair isn't broadcast — if tab A holds the election
// and the user re-pairs in tab B, tab A keeps the old key until it reloads.
// A BroadcastChannel/storage-event nudge is full-C4 scope.
let controllerCtx = null;
let electing = false;
let releaseLock = null;
let active = null; // { pairingId, responder }

async function reconcile() {
  if (!controllerCtx) {
    if (active) { active.responder.stop(); active = null; }
    return;
  }
  const { getPairing, purgePairing } = await import('./mcp-pairing.js');
  const pairing = await getPairing(controllerCtx);
  const nextId = pairing ? pairing.pairingId : null;
  if ((active && active.pairingId) === nextId) return; // unchanged
  if (active) { active.responder.stop(); active = null; }
  if (!pairing) return;
  const { recordsPort } = await import('./sync.js');
  const { fromBase64 } = await import('./crypto.js');
  const ctx = controllerCtx;
  const responder = createResponder({
    pairingId: pairing.pairingId,
    key: fromBase64(pairing.key),
    records: recordsPort(controllerCtx),
    now: () => Date.now(),
    timeZone: (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC',
    onStalePairing: () => {
      purgePairing(ctx).catch((e) => console.error('[mcp] stale pairing purge failed', e));
    },
  });
  active = { pairingId: pairing.pairingId, responder };
  responder.connect();
}

// refreshResponder reconciles the running responder to the vault's current
// pairing. Safe to call repeatedly; the first call that needs to answer wins
// the cross-tab election and holds it for the tab's lifetime, swapping its
// inner responder as the pairing changes.
export function refreshResponder(ctx) {
  controllerCtx = ctx;
  if (releaseLock || !(navigator.locks && navigator.locks.request)) {
    // This tab already holds the election (or Web Locks is unsupported):
    // reconcile in place.
    reconcile().catch((e) => console.error('[mcp] responder reconcile failed', e));
    return;
  }
  if (electing) return; // election in flight; its reconcile will read ctx.
  electing = true;
  navigator.locks.request('mcp-responder', () => new Promise((release) => {
    releaseLock = release;
    reconcile().catch((e) => console.error('[mcp] responder reconcile failed', e));
  })).catch((e) => { electing = false; console.error('[mcp] responder lock failed', e); });
}

// stopResponder stops any running responder and releases the election so a
// later reconnect re-elects cleanly. Called from Disconnect.
export function stopResponder() {
  controllerCtx = null;
  if (active) { active.responder.stop(); active = null; }
  if (releaseLock) { releaseLock(); releaseLock = null; }
  electing = false;
}
