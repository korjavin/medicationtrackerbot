// Cloud-mode boot shim, served by cmd/cloud ahead of every web/static script
// (internal/cloudserver/router.go injects the <script> tag right after
// <head>). Mirrors core/native-bootstrap.js: a classic, non-module script so
// it executes synchronously before messenger-adapter.js / app-shell.js /
// data-store.js ever read window.__MEDTRACKER_CLOUD__.
//
// The warm-unlock + shim install below is unavoidably async (IndexedDB +
// WebCrypto), so it cannot finish before parsing reaches later scripts.
// app.js's checkAuth() awaits window.MedTrackerCloudReady before touching the
// network — the same shape as it already awaits window.MessengerAdapterReady
// for the Telegram SDK upgrade.
window.__MEDTRACKER_CLOUD__ = true;

window.MedTrackerCloudReady = (async function boot() {
    try {
        const [{ readLdkRecord, unwrapWithLdk }, { installApiShim }, { pullOnOpen }] = await Promise.all([
            import('/js/unlock.js'),
            import('/js/apishim.js'),
            import('/js/sync.js'),
        ]);

        const cached = await readLdkRecord();
        if (!cached) {
            location.href = '/unlock';
            return;
        }
        const dek = await unwrapWithLdk(cached);
        const ctx = { accountId: cached.accountId, dek };

        installApiShim(ctx);
        await pullOnOpen(ctx);
        if (window.DataStore && typeof window.DataStore.invalidateTags === 'function') {
            window.DataStore.invalidateTags(['bp', 'weight']);
        }
    } catch (e) {
        console.error('[cloud-boot] warm unlock failed', e);
        location.href = '/unlock';
    }
})();
