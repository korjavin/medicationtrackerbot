// Runtime-agnostic diary/notes domain module. Pure logic over an injected
// records port — no window/document/fetch/IndexedDB — so the same file can
// later run inside the Go server via goja (C6) with a Go-backed records port.
// Mirrors internal/store/diary/repo.go + internal/server/notes_handlers.go.

const RECORD_TYPE = 'note';
const MAX_CONTENT_RUNES = 10000;
const VALID_TAGS = new Set(['SLEEP', 'STRESS', 'HR', 'SPO2', 'STEPS', 'NOTE']);

// Ported from internal/domain/notes.go NormalizeNoteTag: invalid tags are
// silently dropped (nil), never rejected.
function normalizeTag(raw) {
  if (!raw) return null;
  const t = String(raw).trim().toUpperCase();
  return VALID_TAGS.has(t) ? t : null;
}

// The frontend's "load more" cursor gates on `id > 0` and passes it back as a
// numeric before_id (features/health.js), so string ids like `note_...` would
// coerce to NaN and silently break pagination past the first page. So the id
// must be numeric, positive, and monotonic-descending (newest first).
//
// A dense `max+1` counter satisfies that but collides across devices: two
// offline devices with the same live-note count both mint the same id, and the
// LWW-on-clientTs sync merge then silently discards one note. Instead stamp the
// id from the millisecond clock (already time-ordered) with 3 low-order random
// digits for cross-device entropy, and fall back to `localMax+1` so a stalled
// clock or a same-ms random collision can never reuse a local id.
// ponytail: nowMs*1000 stays under Number.MAX_SAFE_INTEGER until ~year 2255.
function nextId(existing, nowMs) {
  const localMax = existing.reduce((m, r) => Math.max(m, Number(r.recordId) || 0), 0);
  const stamped = nowMs * 1000 + Math.floor(Math.random() * 1000);
  return String(Math.max(stamped, localMax + 1));
}

function toResponse(record) {
  const resp = {
    id: record.recordId,
    content: record.content,
    created_at: record.created_at,
  };
  if (record.tag) resp.tag = record.tag;
  return resp;
}

// createNotesDomain builds the diary domain API over the injected ports:
//   records — { list(type), put(type, record), del(type, id) }
//   now()   — current time in ms epoch
export function createNotesDomain({ records, now }) {
  async function create(input) {
    const content = (input && input.content ? String(input.content) : '').trim();
    if (!content) {
      const err = new Error('content is required');
      err.code = 'empty_content';
      throw err;
    }
    if ([...content].length > MAX_CONTENT_RUNES) {
      const err = new Error('content too long');
      err.code = 'content_too_long';
      throw err;
    }
    const nowMs = now();
    const record = {
      recordId: nextId(await records.list(RECORD_TYPE), nowMs),
      clientTs: nowMs,
      deleted: false,
      content,
      tag: normalizeTag(input && input.tag),
      created_at: new Date(nowMs).toISOString(),
    };
    await records.put(RECORD_TYPE, record);
    return toResponse(record);
  }

  // list mirrors handleListNotes's newest-first + before_id keyset cursor
  // contract (internal/server/notes_handlers.go:16-54).
  async function list({ limit = 50, beforeId } = {}) {
    const all = await records.list(RECORD_TYPE);
    // Server orders strictly by id DESC (unique, monotonic) and applies the
    // cursor as `id < beforeID` — robust whether or not the cursor row still
    // exists. Mirror both: sort by numeric id, keyset-filter by id.
    let filtered = all.slice().sort((a, b) => Number(b.recordId) - Number(a.recordId));
    if (beforeId) {
      const bid = Number(beforeId);
      filtered = filtered.filter((r) => Number(r.recordId) < bid);
    }
    const bounded = limit > 0 ? filtered.slice(0, limit) : filtered;
    return bounded.map(toResponse);
  }

  async function remove(id) {
    const all = await records.list(RECORD_TYPE);
    if (!all.some((r) => r.recordId === id)) {
      const err = new Error('note not found');
      err.code = 'not_found';
      throw err;
    }
    await records.del(RECORD_TYPE, id);
  }

  return { create, list, remove };
}
