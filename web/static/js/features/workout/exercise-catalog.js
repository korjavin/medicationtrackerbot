// ====================================
// WORKOUT EXERCISE CATALOG — shared translation layer (med-mj4)
// ====================================
//
// Single-flight fetch of the vendored static exercise catalog (med-s5m.1),
// building a Map<lowercased-trimmed name, body_part>, plus a medical→friendly
// body-part translation dict. Consumed by BOTH the Stats "Body-part Split"
// (stats.js) and the active-session exercise-card chip (sessions.js), so the
// two surfaces share one vocabulary. Matching is client-side; in cloud mode the
// decrypted names never leave the browser. A failed fetch is silent (empty Map)
// and retried on the next call.
(function () {
    let _mapPromise = null; // single-flight cache for the catalog name->body_part map
    let _exactMap = null;   // Map<normalized name, body_part>
    let _entries = null;    // [[Set<token>, body_part]] for subset-match fuzzy fallback

    function _norm(name) {
        return String(name || '').toLowerCase().trim();
    }

    // Split into whole-word tokens, dropping short noise ("up"/"ab"/"of") that
    // would otherwise dominate the plurality vote. Distinct tokens only.
    function _tokens(name) {
        return [...new Set(
            _norm(name).split(/[^a-z0-9]+/).filter((t) => t.length >= 3)
        )];
    }

    function load() {
        if (!_mapPromise) {
            _mapPromise = fetch('/static/data/exercises-catalog.json')
                .then((r) => (r.ok ? r.json() : Promise.reject(new Error('catalog ' + r.status))))
                .then((cat) => {
                    const map = new Map();
                    const entries = [];
                    for (const e of (cat.exercises || [])) {
                        const key = _norm(e.name);
                        if (!key || !e.body_part) continue;
                        map.set(key, e.body_part);
                        entries.push([new Set(_tokens(e.name)), e.body_part]);
                    }
                    _exactMap = map;
                    _entries = entries;
                    return map;
                })
                .catch((err) => {
                    console.error('Error loading exercise catalog:', err);
                    _mapPromise = null; // allow a later retry
                    _exactMap = null;
                    _entries = null;
                    return new Map();
                });
        }
        return _mapPromise;
    }

    // Exact match wins; else a bare logged name ("bench press") is a token-subset
    // of its verbose catalog form ("barbell bench press"), so tally body_part
    // across every entry the query is a subset of and return the plurality. Strict
    // tie or no match → null. Subset (not raw token frequency) is what avoids a
    // popular head-noun like "press"/"curl" outvoting the identifying token, e.g.
    // "leg press" → upper legs, not chest. Assumes load() has resolved (getBodyPart
    // awaits it; stats.js awaits load() before calling).
    function resolveBodyPart(name) {
        if (_exactMap) {
            const hit = _exactMap.get(_norm(name));
            if (hit) return hit;
        }
        if (!_entries) return null;
        const q = _tokens(name);
        if (!q.length) return null;
        const tally = new Map();
        for (const [toks, part] of _entries) {
            if (q.every((t) => toks.has(t))) {
                tally.set(part, (tally.get(part) || 0) + 1);
            }
        }
        let best = null, bestVotes = 0, tie = false;
        for (const [part, votes] of tally) {
            if (votes > bestVotes) { best = part; bestVotes = votes; tie = false; }
            else if (votes === bestVotes) { tie = true; }
        }
        return tie ? null : best;
    }

    // -- Movement pattern (med-904.3) -------------------------------------
    //
    // JEFIT's Movement Balance Engine axis: push / pull / hinge / squat, the
    // thing Strong and Hevy both leave out. The vendored catalog carries body
    // parts and target muscles, not movement patterns, so the pattern is
    // DERIVED — the exercise NAME is what actually encodes it ("row" vs
    // "press"), while a body part alone cannot tell a pull-up from a bench
    // press.
    //
    // Two gates, in order:
    //   1. the body part must be one that HAS a movement pattern. A crunch, a
    //      calf raise and a treadmill walk are none of the four, and gating on
    //      the body part kills all of them in one line instead of a growing
    //      blacklist of name fragments.
    //   2. an ordered rule table over the name. LEG patterns come first
    //      because "leg curl" / "leg press" / "leg extension" carry upper-body
    //      verbs that would otherwise file them under pull/push.
    // Anything unmatched falls back to the body part where it is unambiguous
    // (chest and shoulders push, backs pull) and is left out otherwise —
    // silence beats a wrong ratio.
    //
    // `axis` is vertical/horizontal where the movement has one and null where
    // it doesn't (a biceps curl has no meaningful axis). Nothing renders it
    // yet; it is the field a hex radar would read.
    const PATTERN_BODY_PARTS = new Set(['chest', 'back', 'shoulders', 'upper arms', 'upper legs']);
    const MOVEMENT_RULES = [
        [/squat|lunge|leg press|hack|step[- ]?up|sissy|leg extension/, 'squat', null],
        [/deadlift|hip thrust|glute bridge|good morning|romanian|\brdl\b|swing|back extension|hyperextension|leg curl|nordic|hip extension|pull[- ]?through/, 'hinge', null],
        [/pull[- ]?up|chin[- ]?up|pull[- ]?down|lat pull|muscle[- ]?up/, 'pull', 'vertical'],
        // `\b` on the short fragments is load-bearing: a bare /row/ files
        // "narrow-grip bench press" as a pull, and a bare /chin/ does the same
        // to every "machine …" exercise.
        [/\brow|face pull|pullover|rear delt|reverse fly|reverse pec/, 'pull', 'horizontal'],
        [/curl|shrug|\bchin/, 'pull', null],
        [/overhead press|shoulder press|military|arnold|push press|handstand/, 'push', 'vertical'],
        [/bench|chest press|push[- ]?up|\bdip|\bfly|flye|pec deck/, 'push', 'horizontal'],
        [/press|push|extension|skull|kickback|raise/, 'push', null],
    ];
    const BODY_PART_PATTERN = { chest: 'push', shoulders: 'push', back: 'pull' };

    // → { pattern, axis } or null. Same "assumes load() has resolved" contract
    // as resolveBodyPart, which it delegates the first gate to.
    function resolveMovementPattern(name) {
        const bodyPart = resolveBodyPart(name);
        if (!bodyPart || !PATTERN_BODY_PARTS.has(bodyPart)) return null;
        const n = _norm(name);
        for (const [re, pattern, axis] of MOVEMENT_RULES) {
            if (re.test(n)) return { pattern, axis };
        }
        const fallback = BODY_PART_PATTERN[bodyPart];
        return fallback ? { pattern: fallback, axis: null } : null;
    }

    async function getBodyPart(exerciseName) {
        await load();
        return resolveBodyPart(exerciseName);
    }

    // Medical DB body_part value → lifter-friendly display name. Any unmatched
    // key (including 'uncategorized') returns null so callers can fall back.
    const FRIENDLY = {
        'upper legs': 'Legs', 'lower legs': 'Calves', 'waist': 'Core',
        'upper arms': 'Arms', 'lower arms': 'Forearms', 'chest': 'Chest',
        'back': 'Back', 'shoulders': 'Shoulders', 'neck': 'Neck', 'cardio': 'Cardio'
    };
    function friendlyBodyPart(bodyPart) {
        return FRIENDLY[_norm(bodyPart)] || null;
    }

    // The same dict as a picker-ready list, so the library modal's muscle-group
    // <select> stays a projection of this one vocabulary instead of a second
    // hand-maintained copy in index.html.
    function bodyPartOptions() {
        return Object.entries(FRIENDLY).map(([value, label]) => ({ value, label }));
    }

    window.WorkoutExerciseCatalog = {
        load, getBodyPart, resolveBodyPart, resolveMovementPattern, friendlyBodyPart, bodyPartOptions,
    };
})();
