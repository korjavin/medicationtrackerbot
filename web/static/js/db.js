// Local Database Layer using Dexie.js (IndexedDB wrapper)
// Provides offline storage for BP readings and weight logs

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

// Simple logger for db operations (will be enhanced by sync.js SyncDebug)
const dbLog = (msg, data) => {
    console.log(`[DB] ${msg}`, data || '');
    if (window.SyncDebug) window.SyncDebug.info(`DB: ${msg}`, data);
};

// BP Reading operations
const BPStore = {
    // Save a new BP reading locally
    async save(reading) {
        dbLog('Saving BP reading', { sys: reading.systolic });
        const entry = {
            ...reading,
            serverId: reading.serverId || null,
            syncStatus: reading.syncStatus || 'pending',
            createdAt: new Date().toISOString()
        };
        const localId = await db.bp_readings.add(entry);
        dbLog('BP reading saved', { localId });
        return { ...entry, localId };
    },

    // Update reading with server ID after successful sync
    async markSynced(localId, serverId) {
        await db.bp_readings.update(localId, {
            serverId,
            syncStatus: 'synced'
        });
    },

    // Mark reading as having sync error (transient — will be retried)
    async markError(localId, errorMessage) {
        await db.bp_readings.update(localId, {
            syncStatus: 'error',
            errorMessage
        });
    },

    // Mark reading as permanently rejected (4xx — will NOT be retried)
    async markRejected(localId, errorMessage) {
        await db.bp_readings.update(localId, {
            syncStatus: 'rejected',
            errorMessage
        });
    },

    // Get all readings that need to be synced (pending or transient error)
    async getPending() {
        const pending = await db.bp_readings
            .where('syncStatus')
            .equals('pending')
            .toArray();
        const errored = await db.bp_readings
            .where('syncStatus')
            .equals('error')
            .toArray();
        const all = pending.concat(errored);
        dbLog('BP getPending', { count: all.length });
        return all;
    },

    // Get all readings (both pending and synced) for display
    async getAll() {
        return await db.bp_readings
            .orderBy('measured_at')
            .reverse()
            .toArray();
    },

    // Get readings within a date range
    async getByDateRange(startDate, endDate) {
        return await db.bp_readings
            .where('measured_at')
            .between(startDate.toISOString(), endDate.toISOString())
            .toArray();
    },

    // Update local readings with server data (after fetching from API)
    async syncFromServer(serverReadings) {
        // Get all local readings that are synced (have serverId)
        const localSynced = await db.bp_readings
            .where('syncStatus')
            .equals('synced')
            .toArray();

        const localServerIds = new Set(localSynced.map(r => r.serverId));

        // Add new readings from server that we don't have locally
        for (const serverReading of serverReadings) {
            if (!localServerIds.has(serverReading.id)) {
                await db.bp_readings.add({
                    ...serverReading,
                    serverId: serverReading.id,
                    syncStatus: 'synced'
                });
            }
        }
    },

    // Delete a reading (local only, or mark for deletion if synced)
    async delete(localId) {
        const reading = await db.bp_readings.get(localId);
        if (!reading) return;

        if (reading.syncStatus === 'pending') {
            // Never synced, just delete locally
            await db.bp_readings.delete(localId);
        } else {
            // Was synced, mark for deletion (will be handled by sync)
            await db.bp_readings.update(localId, {
                syncStatus: 'deleted'
            });
        }
    },

    // Delete synced reading after successful server deletion
    async confirmDelete(localId) {
        await db.bp_readings.delete(localId);
    },

    // Clear all local data
    async clear() {
        await db.bp_readings.clear();
    },

    // Get count of items needing sync (pending or previously failed)
    async getPendingCount() {
        const pending = await db.bp_readings
            .where('syncStatus')
            .equals('pending')
            .count();
        const errored = await db.bp_readings
            .where('syncStatus')
            .equals('error')
            .count();
        return pending + errored;
    },

    // Get permanently rejected items for display
    async getRejected() {
        const items = await db.bp_readings
            .where('syncStatus')
            .equals('rejected')
            .toArray();
        dbLog('BP getRejected', { count: items.length });
        return items;
    },

    // Get count of permanently rejected items
    async getRejectedCount() {
        return await db.bp_readings
            .where('syncStatus')
            .equals('rejected')
            .count();
    }
};

// Weight Log operations
const WeightStore = {
    // Save a new weight log locally
    async save(log) {
        dbLog('Saving weight log', { weight: log.weight });
        const entry = {
            ...log,
            serverId: log.serverId || null,
            syncStatus: log.syncStatus || 'pending',
            createdAt: new Date().toISOString()
        };
        const localId = await db.weight_logs.add(entry);
        dbLog('Weight log saved', { localId });
        return { ...entry, localId };
    },

    // Update log with server ID after successful sync
    async markSynced(localId, serverId) {
        await db.weight_logs.update(localId, {
            serverId,
            syncStatus: 'synced'
        });
    },

    // Mark log as having sync error (transient — will be retried)
    async markError(localId, errorMessage) {
        await db.weight_logs.update(localId, {
            syncStatus: 'error',
            errorMessage
        });
    },

    // Mark log as permanently rejected (4xx — will NOT be retried)
    async markRejected(localId, errorMessage) {
        await db.weight_logs.update(localId, {
            syncStatus: 'rejected',
            errorMessage
        });
    },

    // Get all logs that need to be synced (pending or transient error)
    async getPending() {
        const pending = await db.weight_logs
            .where('syncStatus')
            .equals('pending')
            .toArray();
        const errored = await db.weight_logs
            .where('syncStatus')
            .equals('error')
            .toArray();
        const all = pending.concat(errored);
        dbLog('Weight getPending', { count: all.length });
        return all;
    },

    // Get all logs (both pending and synced) for display
    async getAll() {
        return await db.weight_logs
            .orderBy('measured_at')
            .reverse()
            .toArray();
    },

    // Get logs within a date range
    async getByDateRange(startDate, endDate) {
        return await db.weight_logs
            .where('measured_at')
            .between(startDate.toISOString(), endDate.toISOString())
            .toArray();
    },

    // Update local logs with server data (after fetching from API)
    async syncFromServer(serverLogs) {
        // Get all local logs that are synced (have serverId)
        const localSynced = await db.weight_logs
            .where('syncStatus')
            .equals('synced')
            .toArray();

        const localServerIds = new Set(localSynced.map(l => l.serverId));

        // Add new logs from server that we don't have locally
        for (const serverLog of serverLogs) {
            if (!localServerIds.has(serverLog.id)) {
                await db.weight_logs.add({
                    ...serverLog,
                    serverId: serverLog.id,
                    syncStatus: 'synced'
                });
            }
        }
    },

    // Delete a log (local only, or mark for deletion if synced)
    async delete(localId) {
        const log = await db.weight_logs.get(localId);
        if (!log) return;

        if (log.syncStatus === 'pending') {
            // Never synced, just delete locally
            await db.weight_logs.delete(localId);
        } else {
            // Was synced, mark for deletion
            await db.weight_logs.update(localId, {
                syncStatus: 'deleted'
            });
        }
    },

    // Delete synced log after successful server deletion
    async confirmDelete(localId) {
        await db.weight_logs.delete(localId);
    },

    // Clear all local data
    async clear() {
        await db.weight_logs.clear();
    },

    // Get count of items needing sync (pending or previously failed)
    async getPendingCount() {
        const pending = await db.weight_logs
            .where('syncStatus')
            .equals('pending')
            .count();
        const errored = await db.weight_logs
            .where('syncStatus')
            .equals('error')
            .count();
        return pending + errored;
    },

    // Get permanently rejected items for display
    async getRejected() {
        const items = await db.weight_logs
            .where('syncStatus')
            .equals('rejected')
            .toArray();
        dbLog('Weight getRejected', { count: items.length });
        return items;
    },

    // Get count of permanently rejected items
    async getRejectedCount() {
        return await db.weight_logs
            .where('syncStatus')
            .equals('rejected')
            .count();
    },

    // Get the last logged weight (for ruler default)
    async getLastWeight() {
        const logs = await db.weight_logs
            .orderBy('measured_at')
            .reverse()
            .limit(1)
            .toArray();
        return logs.length > 0 ? logs[0].weight : null;
    }
};

// Medication Cache operations (for offline support)
const MedicationStore = {
    // Cache TTL: 7 days (medications don't change often)
    CACHE_TTL: 7 * 24 * 60 * 60 * 1000,

    // Save medications list to cache
    async saveCache(medications) {
        dbLog('Saving medications cache', { count: medications.length });

        // Clear existing cache
        await db.medication_cache.clear();

        // Save new cache with timestamp
        await db.medication_cache.add({
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

// Offline Intake Queue (for medication confirmations while offline)
const IntakeQueueStore = {
    async save(entry) {
        dbLog('Saving offline intake', { medication_ids: entry.medication_ids });
        const record = {
            ...entry,
            syncStatus: 'pending',
            createdAt: new Date().toISOString()
        };
        const localId = await db.intake_queue.add(record);
        dbLog('Intake queued', { localId });
        return { ...record, localId };
    },

    async getPending() {
        const pending = await db.intake_queue
            .where('syncStatus')
            .equals('pending')
            .toArray();
        const errored = await db.intake_queue
            .where('syncStatus')
            .equals('error')
            .toArray();
        const all = pending.concat(errored);
        dbLog('Intake getPending', { count: all.length });
        return all;
    },

    async markSynced(localId) {
        await db.intake_queue.delete(localId);
    },

    async markError(localId, errorMessage) {
        await db.intake_queue.update(localId, {
            syncStatus: 'error',
            errorMessage
        });
    },

    async markRejected(localId, errorMessage) {
        await db.intake_queue.update(localId, {
            syncStatus: 'rejected',
            errorMessage
        });
    },

    async getPendingCount() {
        const pending = await db.intake_queue
            .where('syncStatus')
            .equals('pending')
            .count();
        const errored = await db.intake_queue
            .where('syncStatus')
            .equals('error')
            .count();
        return pending + errored;
    },

    async getRejectedCount() {
        return await db.intake_queue
            .where('syncStatus')
            .equals('rejected')
            .count();
    },

    async clear() {
        await db.intake_queue.clear();
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
    }
};

// Export for use in other modules
window.MedTrackerDB = {
    db,
    BPStore,
    WeightStore,
    MedicationStore,
    IntakeHistoryStore,
    WorkoutStore,
    IntakeQueueStore,
    FoodProductsStore,
    ApiCache
};
