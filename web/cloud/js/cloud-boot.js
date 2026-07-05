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
    // Invite/claim links (https://<acct>.cloud…/#claim=<token>) resolve to '/',
    // which serves web/static + this shim — not the passkey shell. Hand off to
    // the shell (signup wizard via app.js) with the fragment intact BEFORE the
    // warm-unlock cache read, so a fresh device (no cache) — or a device holding
    // a stale LDK for a different account — still reaches the claim wizard.
    const claimToken = new URLSearchParams(location.hash.slice(1)).get('claim');
    if (claimToken) {
        location.href = '/unlock' + location.hash;
        return;
    }
    try {
        const [{ warmUnlock }, { installApiShim }, { pullOnOpen }] = await Promise.all([
            import('/js/unlock.js'),
            import('/js/apishim.js'),
            import('/js/sync.js'),
        ]);

        const ctx = await warmUnlock();
        if (!ctx) {
            location.href = '/unlock';
            return;
        }

        installApiShim(ctx);
        await pullOnOpen(ctx);
        if (window.DataStore && typeof window.DataStore.invalidateTags === 'function') {
            // Cloud mode has no change-poll loop — pullOnOpen is the only sync
            // trigger — so every shim-served tag must be evicted here or a
            // remote change from another device renders stale until some other
            // refresh path repaints. 'medications'/'history' cover the meds
            // list, Today next-dose tile (next_intake) and per-med history.
            // Awaited so MedTrackerCloudReady (which checkAuth blocks on before
            // applyBootstrapPayload) doesn't resolve until the Dexie evictions
            // finish — otherwise the app could read stale cache mid-clear.
            await window.DataStore.invalidateTags(['bp', 'weight', 'medications', 'history']);
        }
        // Recompute + re-upload the med reminder horizon on every unlock so a
        // device that was closed for a while "self-heals" the schedule (see
        // docs/plans/2026-07-05-cloud-c2b-medications-tz-reminders.md Task 5's
        // Reminder fidelity limits note) — best-effort, never blocks boot.
        import('/js/reminders.js')
            .then(({ scheduleReminderRecompute }) => scheduleReminderRecompute(ctx))
            .catch((e) => console.error('[cloud-boot] reminder recompute failed', e));
    } catch (e) {
        console.error('[cloud-boot] warm unlock failed', e);
        location.href = '/unlock';
    }
})();
