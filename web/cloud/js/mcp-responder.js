// Browser-side responder for the MCP blind relay (Tier 1 PoC,
// docs/cloud-mode.md "MCP"; wire contract in internal/mcpshim/frame.go).
// Connects to /api/mcp/relay/device, decrypts each inbound frame, dispatches
// mcp_help/mcp_call through the same apishim router the cloud UI calls (so MCP
// and the UI share one map from HTTP route to web/domain/ module), encrypts the
// response, and reconnects with backoff while the tab lives. Wired from the
// unlocked boot path (cloud-boot.js), never from web/static — zero bot-mode
// surface.
//
// The router is injected, never imported: apishim.js imports createDispatcher
// for its in-tab voice dispatcher, so importing it back here would close a
// module cycle, and the injection is what lets the dispatcher be exercised
// without a window.

import { openMCPFrame, sealMCPFrame, utf8 } from './crypto.js';
import { openDb } from './localdb.js';
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
// The resolved path is the endpoint the dispatcher hands to the apishim router.
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

// --- Warn-only input validation (port of registry.ValidateInput) ---------
// internal/mcp/registry/validate.go:64. It never blocks: a missing or mistyped
// field produces a warning, unknown/extra fields are ignored, and an unparseable
// value stays lenient. Wording matches the Go warnings so an agent sees the same
// guidance on both surfaces.

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function jsonTypeOf(v) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean': return 'boolean';
    case 'number': return Number.isInteger(v) ? 'integer' : 'number';
    case 'string': return 'string';
    case 'object': return Array.isArray(v) ? 'array' : 'object';
    default: return '';
  }
}

// A whole number ("integer") satisfies an expected "number", per validate.go:188.
function typeMatches(actual, expected) {
  return expected.some((e) => e === actual || (e === 'number' && actual === 'integer'));
}

function checkObject(prefix, schema, obj) {
  const warnings = [];
  for (const req of schema.required || []) {
    if (!has(obj, req)) warnings.push(`${prefix}.${req}: required field missing`);
  }
  for (const name of Object.keys(obj).sort()) {
    const prop = (schema.properties || {})[name];
    if (!prop) continue; // ignore unknown/extra fields
    const expected = [].concat(prop.type || []);
    if (expected.length === 0) continue;
    const actual = jsonTypeOf(obj[name]);
    if (!actual) continue;
    if (!typeMatches(actual, expected)) {
      warnings.push(`${prefix}.${name}: expected ${expected.join(' or ')}, got ${actual}`);
    }
  }
  return warnings;
}

// Takes the merged `params` + `body` object cloud mode dispatches (see
// mergeInput), checking it against whichever schemas the op declares so each
// warning stays labelled with the field's real source. The catalog's
// precomputed `required` is the union of the two schemas' own `required` lists
// (catalogjs.go:88), so checking the schemas covers it. A non-object input
// can't be field-checked; an empty object stands in (validate.go:84).
export function validateInput(op, input) {
  if (!op) return [];
  const obj = isPlainObject(input) ? input : {};
  const warnings = [];
  if (op.params_schema) warnings.push(...checkObject('params', op.params_schema, obj));
  if (op.body_schema) warnings.push(...checkObject('body', op.body_schema, obj));
  return warnings;
}

// The two input channels merge before normalization and validation: agents in
// the wild put a write payload in `params` as often as in `body`, and the
// catalog's precomputed `required` spans both schemas. splitInput puts each
// field back on the channel the router expects.
const mergeInput = (params, body) => ({
  ...(isPlainObject(params) ? params : {}),
  ...(isPlainObject(body) ? body : {}),
});

// splitInput routes each merged field to the querystring or the request body
// using the catalog's own schemas as the authority, so an agent that misplaces
// a field still dispatches correctly. GET/DELETE carry no body, so everything
// goes to the querystring; otherwise a field the body schema declares goes to
// the body, one the params schema declares goes to the querystring, and an
// undeclared field defaults to the body (a write's payload is the likelier
// home for an extra field than its querystring).
function splitInput(op, input) {
  const takesBody = op.method !== 'GET' && op.method !== 'DELETE';
  if (!takesBody) return { query: input, body: null };
  const paramProps = (op.params_schema && op.params_schema.properties) || {};
  const bodyProps = (op.body_schema && op.body_schema.properties) || {};
  const query = {};
  const body = {};
  for (const name of Object.keys(input)) {
    if (!has(bodyProps, name) && has(paramProps, name)) query[name] = input[name];
    else body[name] = input[name];
  }
  return { query, body };
}

// serializeQuery encodes `params` for the router's parseQuery, which reads them
// back with URLSearchParams. Scalars encode as themselves; an array repeats its
// key (`tags=a&tags=b`, readable via params.getAll); an object encodes as JSON,
// which is the only lossless option a flat querystring affords. null/undefined
// are omitted rather than encoded as the strings "null"/"undefined".
const queryScalar = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));

function serializeQuery(obj) {
  const qs = new URLSearchParams();
  for (const name of Object.keys(obj)) {
    const value = obj[name];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((item) => qs.append(name, queryScalar(item)));
    else qs.append(name, queryScalar(value));
  }
  return qs.toString();
}

// --- Relative-date repair (port of registry.NormalizeCallInput step 2/3) ---
// internal/mcp/registry/normalize_input.go:18. A tool-only agent has no clock
// and writes the literal string "today"/"now" into a timestamp field. Bot mode
// resolves it before the call leaves the MCP layer; without the same repair the
// cloud domain modules store the token verbatim, and since `Date.parse("now")`
// is NaN the record is then invisible to every list and sorts unpredictably —
// a silent write corruption, not a 400. Warn-only and never blocking, like Go.
//
// Cloud merges params+body into one object, so the two schemas' properties are
// checked as a union. The misplaced-body-field repair (step 1) is unnecessary
// here for the same reason.
// Prototype-free: a date field whose value is the literal "constructor" /
// "valueOf" would otherwise resolve to an inherited function, slip past the
// `undefined` guard, and blow up `new Date(NaN).toISOString()` — turning a
// warn-only repair into a -32603. Go's map lookup just misses.
const RELATIVE_DATE_DAYS = Object.assign(Object.create(null), {
  now: 0, today: 0, yesterday: -1, tomorrow: 1,
});
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_TIME_KEYWORDS = ['rfc3339', 'iso8601', 'iso 8601', 'timestamp'];

const propDescription = (prop) => String((prop && prop.description) || '').toLowerCase();

// isDateField / isDateOnly mirror normalize_input.go:208 and :224.
function isDateField(name, prop) {
  const ln = name.toLowerCase();
  if (ln.endsWith('_at') || ln === 'date' || ln === 'from' || ln === 'to') return true;
  const d = propDescription(prop);
  return d.includes('yyyy-mm-dd') || DATE_TIME_KEYWORDS.some((kw) => d.includes(kw));
}

function isDateOnly(prop) {
  const d = propDescription(prop);
  return d.includes('yyyy-mm-dd') && !DATE_TIME_KEYWORDS.some((kw) => d.includes(kw));
}

// normalizeRelativeDates returns a repaired copy of the merged input plus one
// note per resolved field. Non-token values (a real timestamp, a number, an
// unrecognized word) are left untouched — exactly as Go leaves them for the
// warn-only schema check downstream.
export function normalizeRelativeDates(op, input, nowMs) {
  if (!op || !isPlainObject(input)) return { input, notes: [] };
  const props = {
    ...((op.params_schema && op.params_schema.properties) || {}),
    ...((op.body_schema && op.body_schema.properties) || {}),
  };
  const out = { ...input };
  const notes = [];
  for (const name of Object.keys(out).sort()) {
    const prop = props[name];
    if (!prop || !isDateField(name, prop)) continue;
    const raw = out[name];
    if (typeof raw !== 'string') continue;
    const offset = RELATIVE_DATE_DAYS[raw.trim().toLowerCase()];
    if (offset === undefined) continue;
    const iso = new Date(nowMs + offset * DAY_MS).toISOString();
    out[name] = isDateOnly(prop) ? iso.slice(0, 10) : iso;
    notes.push(`resolved relative date ${name}="${raw}" to "${out[name]}" using the device clock`);
  }
  return { input: out, notes };
}

// createDispatcher builds the mcp_help/mcp_call handlers over an injected
// router — apishim.js's createApiRouter, the same `(endpoint, method, body)`
// function the cloud UI calls. Every catalog entry carries the `method` +
// `path` the router is already keyed by, so dispatch is a lookup plus an
// endpoint build; there is no second dispatch table to drift from the first,
// and no domain logic in this module.
export function createDispatcher({ router, now = Date.now }) {
  if (typeof router !== 'function') {
    throw new Error('mcp-responder: createDispatcher requires a router (apishim.js createApiRouter)');
  }

  // The router throws an Error carrying `.status` (apishim's apiError), and sets
  // `.noRoute` on the one throw that means "no branch matched this method+path"
  // — an internal inconsistency between the generated catalog and apishim.js,
  // not bad params, so it reads as -32603 and names the route the next author
  // has to add. The coverage sweep in tests/mcp-responder.test.js exists to make
  // it unreachable. Keying off `.status === 404` instead would swallow the
  // router's domain 404s (a missing session, a group with no rotation state) and
  // tell the agent to go add a route that is already there. Those surface as
  // -32602 with the router's own message; everything else is left alone for
  // handleRequest's mapping.
  async function dispatch(op, endpoint, body) {
    try {
      return await router(endpoint, op.method, body);
    } catch (e) {
      if (e && e.noRoute) {
        throw new MCPError(-32603, `operation "${op.id}" is catalogued but the cloud router has no route for `
          + `${op.method} ${endpoint} — add it to web/cloud/js/apishim.js.`);
      }
      if (e && typeof e.status === 'number' && e.status >= 400 && e.status < 500) {
        throw new MCPError(-32602, e.message);
      }
      throw e;
    }
  }

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
      // BY_ID is prototype-free, so a caller-supplied id like "toString" /
      // "constructor" misses here instead of resolving an inherited member.
      const op = BY_ID[opID];
      if (!op) {
        const suggestions = suggestOperations(opID);
        const hint = suggestions.length ? ` — did you mean: ${suggestions.join(', ')}?` : '';
        throw new MCPError(-32602, `unknown operation "${opID}"${hint}`);
      }

      // Absent mode means read-only, matching call.go:70-73.
      const mode = p.mode == null || p.mode === '' ? MODE_READ_ONLY : String(p.mode);
      if (mode !== MODE_READ_ONLY && mode !== MODE_WRITE) {
        throw new MCPError(-32602, `mode must be "${MODE_READ_ONLY}" or "${MODE_WRITE}", got "${mode}"`);
      }
      // call.go:78 — a write must carry a stated intent. Both errors name the
      // fields to set so the agent self-corrects on its next call instead of
      // re-issuing the identical one.
      if (mode === MODE_WRITE && String(p.intent || '').trim() === '') {
        throw new MCPError(-32602, `intent is required and must be non-empty when mode is "${MODE_WRITE}"`);
      }
      if (op.risk === MODE_WRITE && mode !== MODE_WRITE) {
        throw new MCPError(-32602, `operation "${opID}" is a write — re-issue it with mode: "${MODE_WRITE}" `
          + 'and a non-empty intent describing why.');
      }

      // Fills the op's `{slot}`s from path_params, allowlisted by the catalog
      // and percent-encoded; an unfilled slot is an error, never an "undefined"
      // path segment.
      const path = substitutePath(op, p.path_params);

      // Repair-then-validate, in that order, so a field the normalizer just
      // rewrote isn't reported as malformed (call.go:96-121). Both stages are
      // warn-only: a mismatch never blocks the call.
      const { input, notes } = normalizeRelativeDates(op, mergeInput(p.params, p.body), now());
      const warnings = [...notes, ...validateInput(op, input)];

      const { query, body } = splitInput(op, input);
      const qs = serializeQuery(query);
      const result = await dispatch(op, `${path}${qs ? `?${qs}` : ''}`, body);
      // Bot mode's CallResponse (call.go:33-39) unconditionally. The shape must
      // not depend on the input: an agent that learned `health.bp.list` returns
      // its rows at `.result` must still find them there on the call that
      // happened to trip a warning. `warnings` is omitted when empty, matching
      // Go's `json:"omitempty"`.
      const resp = { status: 'ok', result, api_calls: 1 };
      if (warnings.length) resp.warnings = warnings;
      return resp;
    }
    throw new MCPError(-32601, `unknown method "${method}"`);
  }

  return { handle };
}

// handleRequest builds the JSON-RPC 2.0 response object for one decoded
// request message. Pure and framework-free so it can be exercised without
// any WebSocket/crypto plumbing.
export async function handleRequest(dispatcher, request) {
  // A frame decoding to JSON `null` would throw on `.id` outside the try, and
  // onFrame swallows that — the agent then waits out an offline-device timeout
  // instead of seeing an error.
  const req = request || {};
  const response = { jsonrpc: '2.0', id: req.id };
  try {
    response.result = await dispatcher.handle(req.method, req.params);
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

// --- Anti-replay: seen-nonce ring for write frames -----------------------
// A frame is nonce(12) ‖ AES-GCM(key, payload, aad) and the sender draws the
// nonce randomly per frame (internal/mcpshim/frame.go:70). A repeated nonce
// under one key is therefore always either a relay replaying a captured frame
// or a catastrophic sender bug — reject either way, with zero wire change.
//
// The ring lives in localdb's `device` store: local-only and never synced.
// The `records` port is the encrypted oplog and would replicate every nonce to
// every device. Persistence is the point — an in-memory Set is defeated by a
// relay that waits for a tab reload.
const NONCE_RING_LIMIT = 4096;

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// createNonceRing returns a bounded FIFO of seen write-frame nonces for one
// pairing. seen() is serialized through a promise chain so two frames in
// flight cannot both miss the same nonce and both dispatch.
export function createNonceRing(pairingId, { openStore = openDb } = {}) {
  const key = `mcpSeenNonces:${pairingId}`;
  let chain = Promise.resolve();

  async function check(nonceHex) {
    const db = await openStore();
    try {
      const tx = db.transaction('device', 'readwrite');
      const store = tx.objectStore('device');
      const ring = (await idbRequest(store.get(key))) || [];
      if (ring.includes(nonceHex)) return true;
      ring.push(nonceHex);
      // FIFO: a flood of distinct nonces evicts the oldest entries. See the
      // plan's security note — an AAD-bound counter is the durable fix.
      if (ring.length > NONCE_RING_LIMIT) ring.splice(0, ring.length - NONCE_RING_LIMIT);
      await idbRequest(store.put(ring, key));
      return false;
    } finally {
      db.close();
    }
  }

  return {
    seen(nonceHex) {
      const next = chain.then(() => check(nonceHex));
      chain = next.then(() => {}, () => {});
      return next;
    },
  };
}

// Drops one pairing's ring. Every connectClaude mints a fresh pairing_id, so
// without this each connect/disconnect cycle strands a ring key forever: the
// per-ring FIFO cap bounds one ring's size, not how many rings exist.
export async function clearNonceRing(pairingId, { openStore = openDb } = {}) {
  if (!pairingId) return;
  const db = await openStore();
  try {
    const tx = db.transaction('device', 'readwrite');
    await idbRequest(tx.objectStore('device').delete(`mcpSeenNonces:${pairingId}`));
  } finally {
    db.close();
  }
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// Write-ness is decided from the catalog's `risk` (plus an explicit write
// mode), after decrypt and parse but before dispatch. A replayed read is
// idempotent; deduping reads would bloat the ring and break a legitimate agent
// polling the same op.
function isWriteRequest(request) {
  if (!request || request.method !== 'mcp_call') return false;
  const p = request.params || {};
  if (p.mode === MODE_WRITE) return true;
  const op = BY_ID[p.operation_id || p.op];
  return !!op && op.risk === MODE_WRITE;
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
// module). `router` is an apishim createApiRouter over this account's records
// port — the same route table the cloud UI dispatches through.
//
// onStalePairing fires when the relay reports the pairing is gone; the owner
// (reconcile) drops the vault record. The responder is already stopped by
// then, so the callback must not stop it again.
export function createResponder({
  pairingId, key, router, now, relayURL, onStalePairing = () => {},
  nonceRing = createNonceRing(pairingId),
}) {
  const dispatcher = createDispatcher({ router, now });

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
    let request;
    try {
      request = JSON.parse(decoder.decode(payload));
    } catch {
      return;
    }
    // Anti-replay: a write frame whose GCM nonce we have already answered is a
    // replay (the sender draws a fresh nonce per frame), so it is refused
    // before dispatch. Answering with a JSON-RPC error rather than staying
    // silent keeps id-correlation intact — a silently dropped frame surfaces
    // to the caller as a bogus offline-device timeout.
    //
    // ponytail: read frames are NOT deduped (a replayed read is idempotent) and
    // there is no counter bound into the frame AAD, so the ring is bounded and
    // FIFO — a relay that floods distinct nonces can eventually replay a very
    // old write frame. An AAD counter is the durable fix (see the plan).
    if (isWriteRequest(request) && await nonceRing.seen(hex(bytes.slice(0, 12)))) {
      const dup = { jsonrpc: '2.0', id: request.id, error: { code: -32600, message: 'duplicate frame: this write was already applied' } };
      const dupFrame = await sealMCPFrame(key, pairingId, utf8(JSON.stringify(dup)));
      if (sock.readyState === WebSocket.OPEN) sock.send(dupFrame);
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
  const { fromBase64 } = await import('./crypto.js');
  // Dynamic: apishim.js imports createDispatcher from this module for its
  // in-tab voice dispatcher, so a static import back would close the cycle.
  const { createApiRouter } = await import('./apishim.js');
  const ctx = controllerCtx;
  const responder = createResponder({
    pairingId: pairing.pairingId,
    key: fromBase64(pairing.key),
    router: createApiRouter(controllerCtx, {}),
    now: () => Date.now(),
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
