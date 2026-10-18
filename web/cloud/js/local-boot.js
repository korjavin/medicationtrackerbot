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
// relay, or tell a server anything. What it injects in place of the cloud's
// server-backed effects — reminders on the device only, no RxNav, BYOK hosts
// to the shell, Apple Health into the local store — is local-policy.js (bd
// med-o7zq.3, med-o7zq.9).

// installApiShim's ctx keys the per-account caches (reminder debounce); there is
// one local "account" per origin and no key material.
const LOCAL_CTX = { accountId: 'local' };

// The capability marker the page reads through CSS (styles.css: .wg-cloud-only
// hides, .wg-local-only shows under :root.wg-local-vault). Set now, before the
// body parses, so a server-only control never paints for a frame.
window.document.documentElement.classList.add('wg-local-vault');

window.MedTrackerCloudReady = (async function boot() {
    // Every classic body script has run by DOMContentLoaded: core/api.js (whose
    // apiCallDirect is wrapped below) and native/index.js (the shell bridge).
    const domReady = window.document.readyState === 'loading'
        ? new Promise((resolve) => {
            window.document.addEventListener('DOMContentLoaded', resolve, { once: true });
        })
        : Promise.resolve();
    try {
        const [{ installApiShim }, { localRecordsPort }, policy] = await Promise.all([
            import('/js/apishim.js'),
            import('/js/sync.js'),
            import('/js/local-policy.js'),
        ]);
        // The shell sends the CSP before the page can read its own settings, so
        // it keeps a mirror of the BYOK hosts and a change applies on the next
        // document load: this document's CSP is stale, so reload — at boot and
        // after a Settings save alike (the app shell has no reload control of
        // its own). The next load's list matches, so it reloads once. null
        // skips apishim's "reload to apply" toast.
        const registerEgress = async ({ settings }) => {
            await domReady;
            const res = await policy.registerLocalEgress({ settings, win: window });
            if (!res) return null;
            if (res.changed) {
                window.location.reload();
                return null;
            }
            return res.hosts;
        };
        const shimCall = installApiShim(LOCAL_CTX, {
            recordsPort: localRecordsPort,
            effects: policy.LOCAL_EFFECTS,
            rxnorm: null,
            registerEgress,
            win: window,
        });
        window.CloudVault = policy.LOCAL_VAULT;
        // Same bypass routing as cloud-boot.js (see its med-1iv note): the
        // feature modules that call window.apiCallDirect directly must reach the
        // shim too, or their /api/* reads go to the network. cloud-boot.js is
        // safely late because of the async warm unlock; with no unlock here the
        // imports can resolve before the parser reaches core/api.js, whose own
        // `window.apiCallDirect = ...` would then overwrite this wrapper.
        await domReady;
        const records = localRecordsPort();
        policy.keepLocalRemindersFresh({ ctx: LOCAL_CTX, records, win: window });
        policy.startLocalHealthImport({ ctx: LOCAL_CTX, records, win: window });
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
