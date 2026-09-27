// Local Database Layer using Dexie.js (IndexedDB wrapper)
// Provides offline read caches (medications, history, workout, food, generic
// api_cache). The bot-mode offline WRITE queues (bp_readings, weight_logs,
// intake_queue, pending_sw_actions) were dropped by schema version 7
// (med-a9n5.9) — cloud writes go through the encrypted-oplog sync engine.

const db = new Dexie('MedTrackerDB');

// Schema definition
db.version(1).stores({
    // Blood Pressure readings
    // localId: auto-increment primary key
    // serverId: server-assigned ID (null for pending items)
    // measured_at: timestamp for indexing
    // syncStatus: 'pending' | 'synced' | 'error'
    bp_readings: '++localId, serverId, measured_at, syncStatus',

    // Weight logs
    // Same structure as bp_readings
    weight_logs: '++localId, serverId, measured_at, syncStatus'
});

// Version 2: Add medications cache for offline support
db.version(2).stores({
    // Keep existing tables
    bp_readings: '++localId, serverId, measured_at, syncStatus',
    weight_logs: '++localId, serverId, measured_at, syncStatus',

    // Medications cache
    // Stores the full medications list with timestamp for TTL
    medication_cache: 'id, timestamp'
});

// Version 3: Add caches for history/workout tabs + offline intake queue
db.version(3).stores({
    bp_readings: '++localId, serverId, measured_at, syncStatus',
    weight_logs: '++localId, serverId, measured_at, syncStatus',
    medication_cache: 'id, timestamp',

    // API response caches (TTL-based, keyed by cache key)
    intake_history_cache: 'id, timestamp',
    workout_cache: 'id, timestamp',

    // Offline write queues
    intake_queue: '++localId, medication_id, syncStatus'
});

// Version 4: Add Food Products Cache
db.version(4).stores({
    bp_readings: '++localId, serverId, measured_at, syncStatus',
    weight_logs: '++localId, serverId, measured_at, syncStatus',
    medication_cache: 'id, timestamp',
    intake_history_cache: 'id, timestamp',
    workout_cache: 'id, timestamp',
    intake_queue: '++localId, medication_id, syncStatus',

    // Food products cache
    food_products_cache: 'id, timestamp'
});

// Version 5: Add generic API cache for stale-while-revalidate pattern
// Data is always returned regardless of age; background refresh always happens
db.version(5).stores({
    bp_readings: '++localId, serverId, measured_at, syncStatus',
    weight_logs: '++localId, serverId, measured_at, syncStatus',
    medication_cache: 'id, timestamp',
    intake_history_cache: 'id, timestamp',
    workout_cache: 'id, timestamp',
    intake_queue: '++localId, medication_id, syncStatus',
    food_products_cache: 'id, timestamp',

    // Generic API response cache (no TTL enforcement on reads)
    api_cache: 'id, timestamp'
});

// Version 6: Add failed-action queue for Service Worker notification handlers.
// When a SW handler's POST fails (offline, 5xx, network blip) it writes the
// {endpoint, method, body} envelope here and the main thread drains the
// queue on the next online sync. See SyncManager.drainSwActionQueue in
// sync.js.
db.version(6).stores({
    bp_readings: '++localId, serverId, measured_at, syncStatus',
    weight_logs: '++localId, serverId, measured_at, syncStatus',
    medication_cache: 'id, timestamp',
    intake_history_cache: 'id, timestamp',
    workout_cache: 'id, timestamp',
    intake_queue: '++localId, medication_id, syncStatus',
    food_products_cache: 'id, timestamp',
    api_cache: 'id, timestamp',

    pending_sw_actions: '++localId, endpoint, syncStatus, createdAt'
});

// Version 7: Drop the bot-mode offline write queues. Cloud never wrote to
// them (offlineAwareApiCall was overwritten by the apishim at boot and the
// cloud SW never enqueued SW actions), so existing profiles upgrade with zero
// data loss — the tables are empty by construction. Dexie deletes a table
// when its schema entry is null. Versions 1-6 above are preserved verbatim
// so an upgrade from any older profile replays the full history.
db.version(7).stores({
    bp_readings: null,
    weight_logs: null,
    medication_cache: 'id, timestamp',
    intake_history_cache: 'id, timestamp',
    workout_cache: 'id, timestamp',
    intake_queue: null,
    food_products_cache: 'id, timestamp',
    api_cache: 'id, timestamp',
    pending_sw_actions: null
});

// Simple logger for db operations (will be enhanced by sync.js SyncDebug)
const dbLog = (msg, data) => {
    console.log(`[DB] ${msg}`, data || '');
    if (window.SyncDebug) window.SyncDebug.info(`DB: ${msg}`, data);
};

// Medication Cache operations (for offline support)
const MedicationStore = {
    // Cache TTL: 7 days (medications don't change often)
    CACHE_TTL: 7 * 24 * 60 * 60 * 1000,

    // Save medications list to cache.
    // Uses put() (upsert) rather than clear()+add() so concurrent writers
    // can't race into a `ConstraintError: Key already exists` between the
    // clear and the add — that error aborted the post-mutation refresh chain
    // for unrelated UI paths (notes list, BP list, Today macro card).
    async saveCache(medications) {
        dbLog('Saving medications cache', { count: medications.length });

        await db.medication_cache.put({
            id: 'medications_list',
            timestamp: Date.now(),
            data: medications
        });
    },

    // Get medications from cache
    async getCache() {
        const cache = await db.medication_cache.get('medications_list');

        if (!cache) {
            dbLog('No medications cache found');
            return null;
        }

        // Check if cache is still valid
        const age = Date.now() - cache.timestamp;
        if (age > this.CACHE_TTL) {
            dbLog('Medications cache expired', { age: Math.round(age / 1000 / 60 / 60) + 'h' });
            await db.medication_cache.clear();
            return null;
        }

        dbLog('Medications cache hit', { count: cache.data.length, age: Math.round(age / 1000 / 60) + 'min' });
        return cache.data;
    },

    // Cold-start hydration loader. Returns the full `{ data, timestamp }`
    // record (TTL-checked) so DataStore.hydrateFromDexie can preserve the
    // real fetched-at timestamp for the stale badge. Returns null if missing
    // or expired — same TTL semantics as getCache().
    async loadCache() {
        const cache = await db.medication_cache.get('medications_list');
        if (!cache) return null;
        const age = Date.now() - cache.timestamp;
        if (age > this.CACHE_TTL) {
            await db.medication_cache.clear();
            return null;
        }
        return { data: cache.data, timestamp: cache.timestamp };
    },

    // Check if cache exists and is valid
    async isCacheValid() {
        const cache = await db.medication_cache.get('medications_list');
        if (!cache) return false;

        const age = Date.now() - cache.timestamp;
        return age <= this.CACHE_TTL;
    },

    // Clear cache
    async clearCache() {
        await db.medication_cache.clear();
        dbLog('Medications cache cleared');
    }
};

// Intake History Cache (for medication history tab)
const IntakeHistoryStore = {
    CACHE_TTL: 30 * 60 * 1000, // 30 minutes

    async saveCache(key, data) {
        dbLog('Saving intake history cache', { key, count: data.length });
        await db.intake_history_cache.put({
            id: key,
            timestamp: Date.now(),
            data: data
        });
    },

    async getCache(key) {
        const cache = await db.intake_history_cache.get(key);
        if (!cache) return null;

        const age = Date.now() - cache.timestamp;
        if (age > this.CACHE_TTL) {
            dbLog('Intake history cache expired', { key });
            await db.intake_history_cache.delete(key);
            return null;
        }

        dbLog('Intake history cache hit', { key, count: cache.data.length });
        return cache.data;
    },

    async clearCache() {
        await db.intake_history_cache.clear();
        dbLog('Intake history cache cleared');
    }
};

// Workout Cache (for workout tabs)
const WorkoutStore = {
    CACHE_TTL: 30 * 60 * 1000, // 30 minutes

    async saveCache(key, data) {
        dbLog('Saving workout cache', { key });
        await db.workout_cache.put({
            id: key,
            timestamp: Date.now(),
            data: data
        });
    },

    async getCache(key) {
        const cache = await db.workout_cache.get(key);
        if (!cache) return null;

        const age = Date.now() - cache.timestamp;
        if (age > this.CACHE_TTL) {
            dbLog('Workout cache expired', { key });
            await db.workout_cache.delete(key);
            return null;
        }

        dbLog('Workout cache hit', { key });
        return cache.data;
    },

    async clearCache() {
        await db.workout_cache.clear();
        dbLog('Workout cache cleared');
    }
};

// Food Products Cache
const FoodProductsStore = {
    CACHE_TTL: 7 * 24 * 60 * 60 * 1000, // 7 days

    async saveCache(products) {
        dbLog('Saving food products cache', { count: products.length });
        await db.food_products_cache.put({
            id: 'recent_products',
            timestamp: Date.now(),
            data: products
        });
    },

    async getCache() {
        const cache = await db.food_products_cache.get('recent_products');
        if (!cache) return null;

        const age = Date.now() - cache.timestamp;
        if (age > this.CACHE_TTL) {
            dbLog('Food products cache expired');
            await db.food_products_cache.delete('recent_products');
            return null;
        }

        dbLog('Food products cache hit', { count: cache.data.length });
        return cache.data;
    },

    async clearCache() {
        await db.food_products_cache.clear();
        dbLog('Food products cache cleared');
    }
};

// Generic API cache for stale-while-revalidate pattern.
// No TTL enforcement: always return whatever is stored, always refresh in background.
const ApiCache = {
    async get(key) {
        try {
            const entry = await db.api_cache.get(key);
            return entry ? entry.data : null;
        } catch (e) {
            return null;
        }
    },

    async getWithMeta(key) {
        try {
            const entry = await db.api_cache.get(key);
            return entry ? { data: entry.data, timestamp: entry.timestamp } : null;
        } catch (e) {
            return null;
        }
    },

    async set(key, data) {
        try {
            await db.api_cache.put({ id: key, timestamp: Date.now(), data });
        } catch (e) {
            console.warn('[ApiCache] Failed to save', key, e);
        }
    },

    // Same as `set`, but stamps the row with the supplied timestamp instead of
    // Date.now(). Used by DataStore.hydrateFromDexie so a cold-start primer
    // from a long-lived Dexie table preserves the original fetch age — without
    // it the stale badge would surface "Updated just now" for data that's
    // actually hours old.
    async setWithMeta(key, data, timestamp) {
        try {
            const ts = Number.isFinite(timestamp) ? timestamp : Date.now();
            await db.api_cache.put({ id: key, timestamp: ts, data });
        } catch (e) {
            console.warn('[ApiCache] Failed to save', key, e);
        }
    },

    async clear(key) {
        try {
            if (key) {
                await db.api_cache.delete(key);
            } else {
                await db.api_cache.clear();
            }
        } catch (e) {
            console.warn('[ApiCache] Failed to clear', e);
        }
    },

    // Enumerate api_cache primary keys, optionally filtered to those starting
    // with `prefix`. Used by DataStore.invalidateByTag when a tag has a
    // registered family prefix so the eviction can sweep every concrete
    // dynamic key (e.g. every `history_*` row when the `history` tag fires).
    async keys(prefix) {
        try {
            if (typeof prefix === 'string' && prefix.length > 0) {
                return await db.api_cache.where('id').startsWith(prefix).primaryKeys();
            }
            return await db.api_cache.toCollection().primaryKeys();
        } catch (_e) {
            return [];
        }
    },

    // Returns the api_cache row with the newest `timestamp` whose `id` starts
    // with `prefix`, as { key, data, timestamp }, or null. Used by the
    // cold-start health-overview hydration fallback: if the user's current
    // timezone has no cached row (e.g. they changed TZ while offline), seed
    // the current-TZ key from whichever `health_overview_<tz>` row was
    // written most recently instead of leaving the section blank.
    async findMostRecentByPrefix(prefix, opts) {
        if (!prefix || typeof prefix !== 'string') return null;
        const exclude = (opts && typeof opts.exclude === 'function') ? opts.exclude : null;
        try {
            const entries = await db.api_cache.where('id').startsWith(prefix).toArray();
            if (!entries || entries.length === 0) return null;
            let best = null;
            for (const entry of entries) {
                if (!entry || typeof entry.timestamp !== 'number') continue;
                if (exclude && exclude(entry.id)) continue;
                if (!best || entry.timestamp > best.timestamp) best = entry;
            }
            return best ? { key: best.id, data: best.data, timestamp: best.timestamp } : null;
        } catch (_e) {
            return null;
        }
    }
};

// Export for use in other modules
window.MedTrackerDB = {
    db,
    MedicationStore,
    IntakeHistoryStore,
    WorkoutStore,
    FoodProductsStore,
    ApiCache
};
