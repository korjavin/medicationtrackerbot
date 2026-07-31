// Bounded list reads (med-vgw). Runtime-agnostic and pure — no window,
// document, fetch or IndexedDB — so it can ride into goja with the rest of
// web/domain (architecture.domain-purity.test.js).
//
// Why this exists: an unbounded array is an unbounded relay frame, and a frame
// over maxRelayFrameBytes is not a truncated answer. coder/websocket CLOSES the
// connection on an oversized frame, so one big list killed the device leg, the
// shim timed out, the tab redialed, and the same oversized answer killed it
// again — a loop the user only ever saw as "No unlocked Med Tracker device is
// online" while the app sat open and unlocked
// (internal/cloudserver/mcp_relay.go). Raising the cap to 5 MiB buys headroom;
// bounding the reads is what stops a large query producing an error instead of
// an answer.
//
// Two idioms fed it. Every list function reads `limit > 0 ? rows.slice(0,
// limit) : rows`, so `limit=0` off a query string meant "the entire history";
// and nothing clamped the other end, so `limit=999999` was honored verbatim.
//
// WHERE THE CLAMP LIVES — and why it is not inside those list functions.
// `limit: 0` is load-bearing *between* domain modules: analysis.js's
// cardiovascular/fitness composites and apishim's bootstrap deliberately ask
// for every row in an already-bounded window, and a clamp there would silently
// truncate an adherence rate or a 60-day chart. Truncating an aggregate is a
// worse bug than the one being fixed. The untrusted value is the query string,
// so the clamp belongs at the request boundary — apishim.js's createApiRouter,
// the single entry point the cloud UI and mcp-responder.js both dispatch
// through.

// MAX_LIMIT is the ceiling for one page of any list read. 1000 rather than a
// rounder 500 because the existing first-party callers set the floor: the
// weight screen and the Today loader both request `/api/weight?days=0&limit=1000`
// on purpose (web/static/js/features/weight.js, today-loader.js), and a 500-row
// ceiling would silently shorten those charts — trading a frame bug for a
// quiet-wrong-data bug. 1000 is the largest limit any caller in the tree asks
// for, so nothing legitimate is truncated while `limit=999999` stops being
// honored.
//
// The widest row shape here (a workout session view: group/variant names plus
// per-set logs) runs a few hundred bytes of JSON, so 1000 rows is a few hundred
// KB — inside the 5 MiB frame cap with room for several such lists in one
// composite response. Raise it only alongside maxRelayFrameBytes.
export const MAX_LIMIT = 1000;

// MAX_DAYS bounds the one read whose response grows with the window rather than
// with a row count (food.log.list — meal groups per day, each carrying its
// logs). A year clears every UI range picker and every plausible "how did last
// year go" question while keeping the worst case finite.
//
// Deliberately NOT applied to the other `days`-taking ops, because their
// responses do not grow with it: food.stats.read sums to four numbers,
// medications.inventory.low returns one row per medication, medications.history
// is hard-capped at 100 rows in the domain, and the health.analyze_* composites
// are already clamped to a 90-day window by analysis.js's resolveWindow
// (matching the bot's Config.MaxQueryDays). Clamping those would change answers
// without shrinking a single frame.
export const MAX_DAYS = 366;

function toInt(raw) {
  if (raw === null || raw === undefined || raw === '') return NaN;
  const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

// clampLimit: absent, unparseable or <= 0 yields the op's default — never
// "everything" — and anything above `max` is clamped down to it.
export function clampLimit(raw, def, max = MAX_LIMIT) {
  const n = toInt(raw);
  if (Number.isNaN(n) || n <= 0) return Math.min(def, max);
  return Math.min(n, max);
}

// clampDays is clampLimit against the window ceiling rather than the row one.
export function clampDays(raw, def, max = MAX_DAYS) {
  return clampLimit(raw, def, max);
}

// clampOffset: absent, unparseable or negative yields 0. No upper bound — an
// offset past the end returns an empty page, which is the correct "no more
// rows" answer rather than an error.
export function clampOffset(raw) {
  const n = toInt(raw);
  return Number.isNaN(n) || n < 0 ? 0 : n;
}

// pageOf slices one page out of an already-ordered list. Response SHAPE is
// unchanged on purpose: the same router serves the cloud UI and the MCP
// response_example conformance sweep, so wrapping arrays in {items, has_more}
// would break both. Pagination rides on limit/offset alone, and a short page is
// the "no more rows" signal.
export function pageOf(rows, limit, offset) {
  return rows.slice(offset, offset + limit);
}
