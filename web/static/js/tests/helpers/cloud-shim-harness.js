// Shim-mode harness (Plan 2026-07-05 cloud-c1, Task 7): loads the same
// window/document as loadFrontendEnv, then installs the cloud apiCall shim
// (web/cloud/js/apishim.js) onto window.offlineAwareApiCall with an
// in-memory records port instead of the crypto/IndexedDB-backed one from
// web/cloud/js/sync.js. The real BP/weight feature code drives window.apiCall
// exactly as in production (core/api.js:203 delegates to
// window.offlineAwareApiCall) — this is the Go↔JS domain-contract boundary.
import { installApiShim } from '../../../../cloud/js/apishim.js';
import { loadFrontendEnv } from './frontend-harness.js';

// In-memory stand-in for web/cloud/js/sync.js's recordsPort(ctx): same
// list/put/del contract (list returns only live/non-tombstoned records),
// no crypto or IndexedDB involved.
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
    const { seedRecords, ...frontendOpts } = opts;
    const env = loadFrontendEnv(frontendOpts);
    installApiShim({}, { records: createInMemoryRecordsPort(seedRecords), win: env.window });
    return env;
}
