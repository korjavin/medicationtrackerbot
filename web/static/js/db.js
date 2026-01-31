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

    // Mark reading as having sync error
    async markError(localId, errorMessage) {
        await db.bp_readings.update(localId, {
            syncStatus: 'error',
            errorMessage
        });
    },

    // Get all pending readings that need to be synced
    async getPending() {
        const pending = await db.bp_readings
            .where('syncStatus')
            .equals('pending')
            .toArray();
        dbLog('BP getPending', { count: pending.length });
        return pending;
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

    // Get count of pending items
    async getPendingCount() {
        return await db.bp_readings
            .where('syncStatus')
            .equals('pending')
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

    // Mark log as having sync error
    async markError(localId, errorMessage) {
        await db.weight_logs.update(localId, {
            syncStatus: 'error',
            errorMessage
        });
    },

    // Get all pending logs that need to be synced
    async getPending() {
        const pending = await db.weight_logs
            .where('syncStatus')
            .equals('pending')
            .toArray();
        dbLog('Weight getPending', { count: pending.length });
        return pending;
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

    // Get count of pending items
    async getPendingCount() {
        return await db.weight_logs
            .where('syncStatus')
            .equals('pending')
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

// Export for use in other modules
window.MedTrackerDB = {
    db,
    BPStore,
    WeightStore
};
