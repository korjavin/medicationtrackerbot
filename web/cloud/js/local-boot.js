// Local-only mode boot (bd med-o7zq.2, epic med-o7zq): the iOS "Only on this
// device" origin, where the whole app runs against the on-device IndexedDB
// store with no account and no server. The counterpart of cloud-boot.js and
// deliberately NOT a branch of it — that file's every step assumes an account
// (warm unlock, pullOnOpen, push relay, inbox, MCP). A classic script for the
// same reason as cloud-boot.js: app.js's checkAuth() must find
// window.MedTrackerCloudReady already set when it runs.
//
// What this entry does NOT do, on purpose: register a Service Worker (the
// shell serves the assets from the bundle), start any sync, pending queue or
// relay, or tell a server its egress hosts. Reminder relay effects are no-ops
// here; local notification scheduling, Health import and the full egress
// policy are med-o7zq.3/.9, built on the effects/registerEgress seams below.

// installApiShim's ctx keys the per-account caches (reminder debounce); there is
// one local "account" per origin and no key material.
const LOCAL_CTX = { accountId: 'local' };

// The reminder relay is the cloud server's blind push relay; there is none here.
const LOCAL_EFFECTS = {
    scheduleReminderRecompute() {},
    cancelMedRefire() {},
    cancelReminderRefire() {},
    async sendTestPush() {
        throw new Error('Test notifications are not available on this device yet.');
    },
};

window.MedTrackerCloudReady = (async function boot() {
    try {
        const [{ installApiShim }, { localRecordsPort }] = await Promise.all([
            import('/js/apishim.js'),
            import('/js/sync.js'),
        ]);
        const shimCall = installApiShim(LOCAL_CTX, {
            recordsPort: localRecordsPort,
            effects: LOCAL_EFFECTS,
            registerEgress: async () => null,
        });
        // Same bypass routing as cloud-boot.js (see its med-1iv note): the
        // feature modules that call window.apiCallDirect directly must reach the
        // shim too, or their /api/* reads go to the network.
        const realApiCallDirect = window.apiCallDirect;
        window.apiCallDirect = (endpoint, method, body, opts) => (
            endpoint.startsWith('/api/')
                ? shimCall(endpoint, method, body, opts)
                : realApiCallDirect(endpoint, method, body, opts)
        );
    } catch (e) {
        // Nothing to redirect to — there is no unlock screen in local mode.
        console.error('[local-boot] boot failed', e);
    }
})();
