// workout-suggest.js — "Up next" ranking for the live session (med-okwf.4,
// kit WA3/WA5/WA6). Pure: plain records in, a ranked list out; no ports, no
// clock, no browser globals. workout.js loads the records and calls it; the
// add sheet and the Next › step render the result.

const key = (name) => String(name || '').trim().toLowerCase();

// rankNextExercises picks up to `limit` exercises to offer after `after` in
// session `sessionId`, from the user's own data only, in this order:
//   a) what the user usually logged right after `after` (most often first,
//      ties by recency),
//   b) library exercises for a body part this session hasn't hit (one per
//      body part, ones logged recently first),
//   c) the most recently logged exercises.
// Anything already in the session (any status) is never offered, so a tap
// can never hit the (session, exercise, source) dedup.
//   sessions — [{ id, scheduled_date, scheduled_time }]
//   logs     — [{ id, session_id, exercise_name, status }] (all sessions)
//   library  — the library rows as listLibrary returns them
// Returns library rows where the name has one, else { name }.
export function rankNextExercises({ sessions = [], logs = [], library = [], sessionId = 0, after = '', limit = 3 } = {}) {
  const libByKey = new Map();
  for (const item of library) if (item && key(item.name)) libByKey.set(key(item.name), item);

  const taken = new Set(logs.filter((l) => l.session_id === sessionId).map((l) => key(l.exercise_name)));
  const takenParts = new Set();
  for (const k of taken) {
    const bp = libByKey.get(k) && String(libByKey.get(k).body_part || '').trim().toLowerCase();
    if (bp) takenParts.add(bp);
  }

  // Past sessions newest first, each as its completed exercise names in the
  // order they were logged (log ids are minted in creation order).
  const past = sessions
    .filter((s) => s.id !== sessionId)
    .sort((a, b) => {
      const da = `${a.scheduled_date || ''} ${a.scheduled_time || ''}`;
      const db = `${b.scheduled_date || ''} ${b.scheduled_time || ''}`;
      if (da !== db) return da < db ? 1 : -1;
      return b.id - a.id;
    });
  const bySession = new Map(past.map((s) => [s.id, []]));
  for (const l of [...logs].sort((a, b) => a.id - b.id)) {
    if (l.status !== 'completed' || !key(l.exercise_name)) continue;
    const seq = bySession.get(l.session_id);
    if (seq) seq.push(l.exercise_name.trim());
  }

  // c) recency: first sighting walking sessions newest → oldest.
  const recent = [];
  const recency = new Map();
  for (const s of past) {
    for (const name of bySession.get(s.id)) {
      if (!recency.has(key(name))) {
        recency.set(key(name), recent.length);
        recent.push(name);
      }
    }
  }

  // a) followers of `after`.
  const followers = new Map();
  if (key(after)) {
    for (const s of past) {
      const seq = bySession.get(s.id);
      seq.forEach((name, i) => {
        if (key(name) !== key(after) || i + 1 >= seq.length) return;
        const next = seq[i + 1];
        followers.set(key(next), { name: next, count: ((followers.get(key(next)) || {}).count || 0) + 1 });
      });
    }
  }
  const usual = [...followers.values()]
    .sort((a, b) => (b.count - a.count) || (recency.get(key(a.name)) - recency.get(key(b.name))))
    .map((f) => f.name);

  // b) one library row per body part this session hasn't hit.
  const rank = (item) => (recency.has(key(item.name)) ? recency.get(key(item.name)) : Number.MAX_SAFE_INTEGER);
  const parts = new Set();
  const fresh = [];
  for (const item of [...libByKey.values()].sort((a, b) => rank(a) - rank(b))) {
    const bp = String(item.body_part || '').trim().toLowerCase();
    if (!bp || takenParts.has(bp) || parts.has(bp) || taken.has(key(item.name))) continue;
    parts.add(bp);
    fresh.push(item.name);
  }

  const out = [];
  const seen = new Set(taken);
  for (const name of [...usual, ...fresh, ...recent]) {
    if (out.length >= limit) break;
    if (seen.has(key(name))) continue;
    seen.add(key(name));
    out.push(libByKey.get(key(name)) || { name });
  }
  return out;
}
