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
    let _tokenIndex = null; // Map<token, Map<body_part, entryCount>> — inverted index for fuzzy fallback

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
                    const index = new Map();
                    for (const e of (cat.exercises || [])) {
                        const key = _norm(e.name);
                        if (!key || !e.body_part) continue;
                        map.set(key, e.body_part);
                        // One vote per distinct token per entry so multi-token
                        // overlap weights naturally.
                        for (const tok of _tokens(e.name)) {
                            let byPart = index.get(tok);
                            if (!byPart) { byPart = new Map(); index.set(tok, byPart); }
                            byPart.set(e.body_part, (byPart.get(e.body_part) || 0) + 1);
                        }
                    }
                    _exactMap = map;
                    _tokenIndex = index;
                    return map;
                })
                .catch((err) => {
                    console.error('Error loading exercise catalog:', err);
                    _mapPromise = null; // allow a later retry
                    _exactMap = null;
                    _tokenIndex = null;
                    return new Map();
                });
        }
        return _mapPromise;
    }

    // Exact match wins; else tally body_part votes across the query's tokens and
    // return the plurality. Strict tie or zero votes → null. Assumes load() has
    // resolved (getBodyPart awaits it; stats.js awaits load() before calling).
    function resolveBodyPart(name) {
        if (_exactMap) {
            const hit = _exactMap.get(_norm(name));
            if (hit) return hit;
        }
        if (!_tokenIndex) return null;
        const tally = new Map();
        for (const tok of _tokens(name)) {
            const byPart = _tokenIndex.get(tok);
            if (!byPart) continue;
            for (const [part, count] of byPart) {
                tally.set(part, (tally.get(part) || 0) + count);
            }
        }
        let best = null, bestVotes = 0, tie = false;
        for (const [part, votes] of tally) {
            if (votes > bestVotes) { best = part; bestVotes = votes; tie = false; }
            else if (votes === bestVotes) { tie = true; }
        }
        return tie ? null : best;
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

    window.WorkoutExerciseCatalog = { load, getBodyPart, resolveBodyPart, friendlyBodyPart };
})();
