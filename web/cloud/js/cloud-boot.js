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

        const shimCall = installApiShim(ctx);
        // Decision 3 (C2d plan): groups.js/next-card.js/stats.js/today-loader.js
        // call window.apiCallDirect directly, bypassing the offlineAwareApiCall
        // seam apiCall() checks first. Route /api/* straight into the same shim
        // dispatch so those bypasses are served too; anything else (there is no
        // other caller today, but the real implementation is one already-broken
        // fetch away) keeps hitting the real network fetch unchanged.
        // Order-independent install: core/api.js (index.html, well after this
        // shim's <head> injection) also does `window.apiCallDirect = …`. The
        // boot() awaits above can resume mid-parse — the event loop spins while
        // the parser is blocked fetching an earlier script — so we can't assume
        // api.js has run yet. A plain capture-and-reassign would either read an
        // undefined real fn or get clobbered when api.js runs last. Instead hold
        // the real fn in a closure and expose the wrapper via an accessor whose
        // setter absorbs api.js's later assignment as the fallback rather than
        // replacing the wrapper.
        let realApiCallDirect = window.apiCallDirect;
        const wrapper = (endpoint, method, body, opts) => (
            endpoint.startsWith('/api/')
                ? shimCall(endpoint, method, body, opts)
                : realApiCallDirect(endpoint, method, body, opts)
        );
        Object.defineProperty(window, 'apiCallDirect', {
            configurable: true,
            get() { return wrapper; },
            set(fn) { realApiCallDirect = fn; },
        });
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
            await window.DataStore.invalidateTags(['bp', 'weight', 'medications', 'history', 'workout']);
        }
        // Warm workout_next the same way applyBootstrapPayload warms bp/weight,
        // so Today's workout card paints instantly instead of waiting on
        // next-card.js's own fetch. No res.workout bootstrap key exists on
        // either server (native or shim) to piggyback on, so this calls the
        // same route the frontend's fetcher would and caches it directly.
        if (window.cacheApiSnapshot) {
            const workoutNext = await window.apiCallDirect('/api/workout/sessions/next').catch(() => null);
            await window.cacheApiSnapshot('workout_next', workoutNext === null ? { session: null } : workoutNext, ['workout']);
        }
        // Recompute + re-upload the med reminder horizon on every unlock so a
        // device that was closed for a while "self-heals" the schedule (see
        // docs/plans/2026-07-05-cloud-c2b-medications-tz-reminders.md Task 5's
        // Reminder fidelity limits note) — best-effort, never blocks boot.
        import('/js/reminders.js')
            .then(({ scheduleReminderRecompute }) => scheduleReminderRecompute(ctx))
            .catch((e) => console.error('[cloud-boot] reminder recompute failed', e));
        // Task 4: if this account has a Claude pairing, this tab starts
        // answering MCP calls too — any unlocked device may be the one
        // online when the shim connects. relayURL is intentionally omitted:
        // the vault record's relayUrl is the shim's dial target (it appends
        // /api/mcp/relay/shim), while this tab is already same-origin and
        // dials /api/mcp/relay/device by default. Best-effort, never blocks boot.
        import('/js/mcp-pairing.js')
            .then(async ({ getPairing }) => {
                const pairing = await getPairing(ctx);
                if (!pairing) return;
                const [{ createResponder }, { recordsPort }, { fromBase64 }] = await Promise.all([
                    import('/js/mcp-responder.js'),
                    import('/js/sync.js'),
                    import('/js/crypto.js'),
                ]);
                const startResponder = () => createResponder({
                    pairingId: pairing.pairingId,
                    key: fromBase64(pairing.key),
                    records: recordsPort(ctx),
                    now: () => Date.now(),
                    timeZone: (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC',
                }).connect();
                // Elect one responder per account: the relay keeps a single
                // device leg per pairing and evicts the old one on each new
                // connection, so if every open tab connected they'd ping-pong
                // — each eviction triggers the evicted tab's reconnect, which
                // re-evicts the other, forever. Hold an exclusive Web Lock for
                // this tab's lifetime; other tabs queue and only take over when
                // the holder's tab closes (auto-releasing the lock).
                if (navigator.locks && navigator.locks.request) {
                    navigator.locks.request('mcp-responder', () => {
                        startResponder();
                        return new Promise(() => {});
                    });
                } else {
                    startResponder();
                }
            })
            .catch((e) => console.error('[cloud-boot] mcp responder failed', e));
    } catch (e) {
        console.error('[cloud-boot] warm unlock failed', e);
        location.href = '/unlock';
    }
})();
