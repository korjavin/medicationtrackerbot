// core/cache-keys.js
// Centralized registry of every key that lives in the `api_cache` Dexie store.
// The registry is the single source of truth for:
//   - what cache keys exist
//   - which invalidation tag each key belongs to
//   - what freshness windows (freshAfterMs / staleAfterMs) it should use
// Loaded before data-store.js; `CacheKeys.registerAll(window.DataStore)` is
// called once at boot so tag-based invalidation works regardless of which
// feature has already executed its first loader.

(function () {
    const HOUR_MS = 60 * 60 * 1000;
    const DAY_MS = 24 * HOUR_MS;

    // Static (literal-keyed) cache entries. One entry per concrete key.
    const STATIC_KEYS = {
        medications: {
            key: 'medications',
            tag: 'medications',
            staleAfterMs: DAY_MS,
            description: 'Medications list (food-targets-aware).'
        },
        next_intake: {
            key: 'next_intake',
            tag: 'medications',
            freshAfterMs: 5 * 60 * 1000,
            staleAfterMs: 12 * HOUR_MS,
            description: 'Today screen next-medication tile.'
        },
        bp: {
            key: 'bp',
            tag: 'bp',
            staleAfterMs: 3 * DAY_MS,
            description: 'Bundled BP readings + goal + stats.'
        },
        weight: {
            key: 'weight',
            tag: 'weight',
            staleAfterMs: 3 * DAY_MS,
            description: 'Bundled weight logs + goal.'
        },
        workout_next: {
            key: 'workout_next',
            tag: 'workout',
            description: 'Next planned workout payload.'
        },
        workout_history: {
            key: 'workout_history',
            tag: 'workout',
            description: 'Workout history list.'
        },
        workout_groups: {
            key: 'workout_groups',
            tag: 'workout',
            description: 'Workout groups + variants.'
        },
        workout_stats: {
            key: 'workout_stats',
            tag: 'workout',
            description: 'Workout stats sub-tab payload.'
        },
        exercise_library: {
            key: 'exercise_library',
            tag: 'workout',
            description: 'Exercise library list.'
        },
        food_products_cache: {
            key: 'food_products_cache',
            tag: 'food',
            staleAfterMs: 7 * DAY_MS,
            description: 'Food products lookup cache.'
        },
        diary_notes: {
            key: 'diary_notes',
            tag: 'health-notes',
            description: 'Vitals diary notes.'
        },
        settings_bundle: {
            key: 'settings_bundle',
            tag: null,
            description: 'Settings bundle. Never invalidated, only replaced.'
        }
    };

    // Dynamic key families. Each family expands to many concrete keys at
    // runtime; invalidating the family's tag must evict every concrete key
    // whose id starts with the family's prefix.
    const FAMILIES = [
        {
            name: 'history',
            prefix: 'history_',
            tag: 'history',
            factory: (days, medId) => `history_${days}_${medId == null ? '' : medId}`,
            description: 'Per-medication history (history_<days>_<medId>).'
        },
        {
            name: 'dayFood',
            prefix: 'food_',
            tag: 'food',
            factory: (date) => `food_${date}_day`,
            description: 'Per-day food log (food_<YYYY-MM-DD>_day).'
        },
        {
            name: 'healthOverview',
            prefix: 'health_overview_',
            tag: 'health',
            factory: (tz) => `health_overview_${tz}`,
            description: 'Per-timezone health overview (health_overview_<tz>).'
        }
    ];

    function lookup(name) {
        if (typeof name !== 'string' || !name) {
            throw new Error(`[CacheKeys] lookup requires a non-empty string, got ${String(name)}`);
        }
        if (!Object.prototype.hasOwnProperty.call(STATIC_KEYS, name)) {
            throw new Error(`[CacheKeys] unknown cache key: "${name}". Add it to web/static/js/core/cache-keys.js.`);
        }
        return STATIC_KEYS[name];
    }

    function tagFor(keyOrName) {
        if (Object.prototype.hasOwnProperty.call(STATIC_KEYS, keyOrName)) {
            return STATIC_KEYS[keyOrName].tag;
        }
        for (const fam of FAMILIES) {
            if (typeof keyOrName === 'string' && keyOrName.startsWith(fam.prefix)) {
                return fam.tag;
            }
        }
        return null;
    }

    function workoutKeys() {
        return Object.values(STATIC_KEYS)
            .filter((entry) => entry.tag === 'workout' && entry.key !== 'exercise_library')
            .map((entry) => entry.key);
    }

    function registerAll(dataStore) {
        if (!dataStore || typeof dataStore.registerTags !== 'function') return;
        Object.values(STATIC_KEYS).forEach(({ key, tag }) => {
            if (tag) dataStore.registerTags(key, [tag]);
        });
        if (typeof dataStore.registerTagFamily === 'function') {
            FAMILIES.forEach(({ prefix, tag }) => dataStore.registerTagFamily(prefix, tag));
        }
    }

    const CacheKeys = {
        static: STATIC_KEYS,
        families: FAMILIES,
        lookup,
        tagFor,
        history: FAMILIES[0].factory,
        dayFoodKey: FAMILIES[1].factory,
        healthOverviewKey: FAMILIES[2].factory,
        workoutKeys,
        registerAll
    };

    if (typeof window !== 'undefined') {
        window.CacheKeys = CacheKeys;
    }
})();
