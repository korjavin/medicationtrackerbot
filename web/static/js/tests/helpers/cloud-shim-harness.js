// Shim-mode harness (Plan 2026-07-05 cloud-c1, Task 7): loads the same
// window/document as loadFrontendEnv, then installs the cloud apiCall shim
// (web/cloud/js/apishim.js) onto window.offlineAwareApiCall with an
// in-memory records port instead of the crypto/IndexedDB-backed one from
// web/cloud/js/sync.js. The real BP/weight feature code drives window.apiCall
// exactly as in production (core/api.js:203 delegates to
// window.offlineAwareApiCall) — this is the Go↔JS domain-contract boundary.
import { installApiShim } from '../../../../cloud/js/apishim.js';
import { loadFrontendEnv } from './frontend-harness.js';
import { cancelReminderRecompute } from '../../../../cloud/js/reminders.js';

// In-memory stand-in for web/cloud/js/sync.js's recordsPort(ctx): same
// list/listRange/put/del contract (list returns only live/non-tombstoned
// records), no crypto or IndexedDB involved.
export function createInMemoryRecordsPort(seed = {}) {
    const store = new Map(); // recordType -> Map<recordId, record>

    function bucket(recordType) {
        let byId = store.get(recordType);
        if (!byId) {
            byId = new Map();
            store.set(recordType, byId);
        }
        return byId;
    }

    for (const [recordType, records] of Object.entries(seed)) {
        const byId = bucket(recordType);
        records.forEach((r) => byId.set(r.recordId, r));
    }

    return {
        async list(recordType) {
            return [...bucket(recordType).values()].filter((r) => !r.deleted);
        },
        // Mirrors listRecordsInRange: an INCLUSIVE range over the primary key
        // (recordId), which is what IDBKeyRange.bound gives on the real store.
        async listRange(recordType, fromId, toId) {
            return [...bucket(recordType).values()]
                .filter((r) => !r.deleted && r.recordId >= fromId && r.recordId <= toId);
        },
        async put(recordType, record) {
            bucket(recordType).set(record.recordId, record);
            return record;
        },
        async del(recordType, recordId) {
            const byId = bucket(recordType);
            const existing = byId.get(recordId) || { recordId };
            byId.set(recordId, { ...existing, deleted: true });
        }
    };
}

export function loadCloudShimFrontendEnv(opts = {}) {
    const { seedRecords, wrapApiCallDirect, ...frontendOpts } = opts;
    const env = loadFrontendEnv(frontendOpts);
    // Exposed on env so a suite can assert HOW the domain layer read (e.g. that
    // vitals bounds its window via listRange rather than listing every batch).
    const records = createInMemoryRecordsPort(seedRecords);
    env.records = records;
    // Every mutating med/intake/tzplan route schedules a 2s debounced reminder
    // recompute keyed by this ctx. Nothing cancelled it on teardown, so a suite
    // whose tests run on real timers left live timers behind; once the process
    // was slow enough for 2s to elapse, they fired inside a *later* test and
    // called its pushSchedule mock — an extra, empty-entry call the later test
    // read as its own. Hold the ctx so cleanup can cancel. See bd med-tc1.3.
    const ctx = {};
    const shimCall = installApiShim(ctx, { records, win: env.window });
    const innerCleanup = env.cleanup;
    env.cleanup = () => {
        cancelReminderRecompute(ctx);
        if (innerCleanup) innerCleanup();
    };
    if (wrapApiCallDirect) {
        // Workout's groups.js/next-card.js/stats.js call window.apiCallDirect
        // directly, bypassing offlineAwareApiCall (Decision 3, C2d plan) —
        // mirror cloud-boot.js's wrapper here so those bypasses are shim-served
        // too. Opt-in only: other suites' background pollers (e.g. the
        // change-poll loop hitting /api/changes) also call apiCallDirect and
        // aren't expecting the shim's unmapped-route warn.
        const realApiCallDirect = env.window.apiCallDirect;
        env.window.apiCallDirect = (endpoint, method, body, callOpts) => (
            endpoint.startsWith('/api/')
                ? shimCall(endpoint, method, body, callOpts)
                : realApiCallDirect(endpoint, method, body, callOpts)
        );
    }
    return env;
}

// Minimal in-memory stand-in for window.MedTrackerDB.ApiCache (get/set/clear),
// enough for DataStore.loadSWR/applyOptimistic — the read/write surface every
// shim-contract suite needs to drive real feature code (health.js, settings.js)
// without a real Dexie/IndexedDB backing.
export function installApiCache(window, seed = {}) {
    const map = new Map(Object.entries(seed));
    window.MedTrackerDB = {
        ...(window.MedTrackerDB || {}),
        ApiCache: {
            async get(key) { return map.has(key) ? map.get(key) : null; },
            async set(key, value) { map.set(key, value); },
            async clear(key) { map.delete(key); },
            async keys(prefix) {
                const all = [...map.keys()];
                return typeof prefix === 'string' && prefix
                    ? all.filter((k) => k.startsWith(prefix))
                    : all;
            }
        }
    };
    return map;
}
