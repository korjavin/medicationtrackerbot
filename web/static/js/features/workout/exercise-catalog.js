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

    function _norm(name) {
        return String(name || '').toLowerCase().trim();
    }

    function load() {
        if (!_mapPromise) {
            _mapPromise = fetch('/static/data/exercises-catalog.json')
                .then((r) => (r.ok ? r.json() : Promise.reject(new Error('catalog ' + r.status))))
                .then((cat) => {
                    const map = new Map();
                    for (const e of (cat.exercises || [])) {
                        const key = _norm(e.name);
                        if (key && e.body_part) map.set(key, e.body_part);
                    }
                    return map;
                })
                .catch((err) => {
                    console.error('Error loading exercise catalog:', err);
                    _mapPromise = null; // allow a later retry
                    return new Map();
                });
        }
        return _mapPromise;
    }

    async function getBodyPart(exerciseName) {
        return (await load()).get(_norm(exerciseName)) || null;
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

    window.WorkoutExerciseCatalog = { load, getBodyPart, friendlyBodyPart };
})();
