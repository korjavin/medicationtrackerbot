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

// Register the service worker on FIRST PAINT (med-gvk.1), before the
// unlock/sync gates in boot() below and OUTSIDE the detached background sync
// IIFE where push.js's ensurePushSubscription otherwise registers it. The SW
// warms the offline app shell into cache and serves it on later cold starts
// with ZERO network on the critical path — the whole point of "open in one
// blink" offline. Registering it here means the cache establishes on the very
// first visit's paint, not only after a fully successful boot + background
// sync. Fire-and-forget and non-blocking: MedTrackerCloudReady (which app.js
// awaits before mounting) does NOT await this, so a slow/failed registration
// never gates the mount. Idempotent — register() on an already-controlled page
// returns the existing registration, so push.js's belt-and-suspenders call is
// a harmless no-op. Cloud-only (this file is served solely by cmd/cloud, never
// in the Capacitor shell), so no isNativePlatform guard is needed.
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    // First-install vs update is decided entirely by whether a SW already
    // controls this page: absent = first-ever install (activate's
    // clients.claim() controls with NO banner and NO reload), present = update
    // (the new SW WAITS — sw.js no longer skipWaiting()s — and we prompt).
    const hadController = !!navigator.serviceWorker.controller;
    // Guarded so a SKIP_WAITING that fires controllerchange reloads exactly once.
    let reloading = false;

    const showBanner = (registration) =>
        import('/js/update-check.js')
            .then((m) => m.showUpdateBanner({ registration }))
            .catch((e) => console.error('[cloud-boot] update banner failed', e));

    navigator.serviceWorker
        .register('/sw.js')
        .then((registration) => {
            // A SW is already waiting for this already-controlled page (e.g. it
            // installed on a previous visit) — prompt now.
            if (registration.waiting && navigator.serviceWorker.controller) showBanner(registration);
            registration.onupdatefound = () => {
                const nw = registration.installing;
                if (!nw) return;
                nw.onstatechange = () => {
                    if (nw.state === 'installed' && navigator.serviceWorker.controller) showBanner(registration);
                };
            };
        })
        .catch((e) => console.error('[cloud-boot] service worker registration failed', e));

    // Reload only when an update replaced an EXISTING controller. On a first
    // install hadController is false, so activate's clients.claim() fires
    // controllerchange without a reload (bead: first install controls silently).
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloading) return;
        reloading = true;
        window.sendSwAuthToken?.();
        location.reload();
    });
}

// Routes the service worker considers safe to replay from a notification tap.
// Kept as an allowlist so a compromised/stale SW message can't drive arbitrary
// shim writes (the SW is same-origin, but the page is the only holder of the DEK
// and should decide what a notification button is allowed to do).
const REMINDER_ACTION_ROUTES = {
    bp_snooze: '/api/bp/reminder/snooze',
    bp_dontbug: '/api/bp/reminder/dontbug',
    weight_snooze: '/api/weight/reminder/snooze',
    weight_dontbug: '/api/weight/reminder/dontbug',
};

function installReminderActionHandler(shimCall) {
    const allowed = new Set(Object.values(REMINDER_ACTION_ROUTES));
    const apply = (route) => {
        if (!allowed.has(route)) return;
        shimCall(route, 'POST').catch((e) => console.error('[cloud-boot] reminder action failed', e));
    };

    // Cold start: the SW opened us with ?reminder_action=<action>. Strip it so a
    // refresh (or a shared link) can't replay the mute.
    try {
        const url = new URL(window.location.href);
        const action = url.searchParams.get('reminder_action');
        if (action) {
            url.searchParams.delete('reminder_action');
            window.history.replaceState({}, '', url.pathname + url.search + url.hash);
            apply(REMINDER_ACTION_ROUTES[action]);
        }
    } catch (e) {
        console.error('[cloud-boot] reminder action url parse failed', e);
    }

    // Warm tab: the SW postMessages the route it resolved.
    if (navigator.serviceWorker) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            if (event.data && event.data.type === 'reminder-action') apply(event.data.route);
        });
    }
}

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
    // --- Warm-unlock decision. This is the ONLY block allowed to redirect to
    // /unlock, and only on "there is no usable local key" — no cached LDK record
    // (warmUnlock → null) or the read itself failing. Everything that decides
    // "must unlock" lives here and NOWHERE else; the post-unlock boot below must
    // never send the browser back to /unlock, or a boot failure unrelated to the
    // key ping-pongs against unlock.js's "record unwraps → go to /" gate forever
    // (med-eas.16). Kept narrow on purpose: import unlock.js alone (NOT the ~15
    // apishim modules) so an apishim/sync load error can't masquerade as a
    // locked device.
    let ctx;
    try {
        const { warmUnlock } = await import('/js/unlock.js');
        ctx = await warmUnlock();
    } catch (e) {
        // Genuinely can't read the vault key (unlock.js/localdb.js broke). This
        // will NOT loop: /unlock loads the same unlock.js + localdb.js, so if
        // they're truly broken it renders the locked/error screen instead of
        // bouncing back to /.
        console.error('[cloud-boot] warm unlock read failed', e);
        location.href = '/unlock';
        return;
    }
    if (!ctx) {
        location.href = '/unlock';
        return;
    }

    // Publish ctx for main-app code (e.g. Settings' cloud push controls) that
    // needs the unlocked vault but isn't part of this boot closure. Plain field
    // set — must not throw or block the try/catch below that guards the rest
    // of post-unlock boot.
    window.MedTrackerCloud = { ctx };

    // C2e full-vault export/import (Settings → Import/Export, Task 6). Both
    // sides are entirely client-side against the unlocked vault — zero-knowledge
    // forbids the server ever seeing plaintext. exportAll reads every live
    // record (including the unmasked integrations keys, module-to-module, never
    // across the /api shim) and regroups via web/domain/vault.js; importAll
    // wipes+relays the whole record store (preserving device/crypto state the
    // vault never carries — nk, voice provisioning) and forces one snapshot upload
    // so other devices re-bootstrap. Lazy dynamic imports keep this off the
    // boot critical path.
    window.CloudVault = {
        async exportAll({ includeSecrets = true } = {}) {
            const [{ readAllLiveRecords }, { recordsToVault }] = await Promise.all([
                import('/js/sync.js'),
                import('/domain/vault.js'),
            ]);
            const records = await readAllLiveRecords(ctx);
            return JSON.stringify(recordsToVault(records, { now: Date.now(), includeSecrets }), null, 2);
        },
        async importAll(json) {
            const [{ replaceAllRecords, forceSnapshot, markForceSnapshotPending, readAllLiveRecords, isBootstrapped, dropPendingForTypes }, { vaultToRecords, managedTypesForImport }] = await Promise.all([
                import('/js/sync.js'),
                import('/domain/vault.js'),
            ]);
            const vault = typeof json === 'string' ? JSON.parse(json) : json;
            const records = vaultToRecords(vault, { now: Date.now() });
            // Managed set is narrowed per-file: a secrets-free vault must not
            // wipe the destination's integrations keys / api tokens.
            const VAULT_MANAGED_TYPES = managedTypesForImport(vault);
            // Preserve records the vault never manages (nk push key, voice
            // provisioning, un-carried secrets) across the wholesale replace.
            // readAllLiveRecords bootstraps first, so isBootstrapped below
            // reflects whether that bootstrap actually reached the server.
            const survive = (await readAllLiveRecords(ctx))
                .filter((r) => !VAULT_MANAGED_TYPES.has(r.recordType));
            // Refuse to wipe until the account cursor exists. Without it,
            // forceSnapshot can't propagate the import (null cursor → nothing to
            // snapshot at) and the next open re-bootstraps the stale server
            // snapshot over the imported records. Throwing here surfaces the
            // error in importexport.js and skips the reload — no destructive
            // replace happens, so local data is untouched.
            if (!(await isBootstrapped())) {
                throw new Error('Sync not ready — connect to the internet and reopen the app before importing.');
            }
            // Replace-only: discard any not-yet-flushed managed writes first, or
            // replaceAllRecords' pending overlay resurrects them over the backup
            // (and they later flush over it). Non-managed pending (nk, reminder
            // prefs) stays queued — those records are in `survive`.
            // Mark before the wipe: a crash between replaceAllRecords and the
            // marker would let the next open re-bootstrap the stale server
            // snapshot over the import (and the old data is already gone).
            await markForceSnapshotPending();
            await dropPendingForTypes(VAULT_MANAGED_TYPES);
            await replaceAllRecords([...records, ...survive]);
            // Past this line the import HAS happened locally. Propagation to the
            // server is retryable (forceSnapshotPending stays set, next pullOnOpen
            // retries), so a throw here must not reach importexport.js — it would
            // report "Import failed" and skip the reload while the old data is
            // already gone, leaving the user staring at pre-import UI over
            // post-import data.
            try {
                await forceSnapshot(ctx);
            } catch (err) {
                console.warn('[cloud] import applied locally; sync to other devices deferred', err);
            }
        },
        async resetLocalSync() {
            // Clear the server inbox backlog FIRST — while sync is still wedged.
            // A permanently un-appliable sealed event is what wedged sync
            // (med-eas.51), and un-wedging alone would just let the drain
            // re-fetch and re-wedge. Order is load-bearing: while syncWedged is
            // set the inbox poller's drain is PAUSED (drainInbox's wedge guard),
            // so clearing the server backlog now — before resetLocalSync clears
            // syncWedged below — closes the window where a live poll tick could
            // otherwise re-fetch the poison event between un-wedge and clear and
            // recreate doomed pending ops locally (re-wedging the account). Best-
            // effort: a failed network clear must not block local recovery, so it
            // proceeds to the reset regardless (same recovery the un-wedge gives).
            try {
                const { clearInbox } = await import('/js/inbox.js');
                await clearInbox({});
            } catch (err) {
                console.warn('[cloud] server inbox backlog not cleared; proceeding with local reset', err);
            }
            const { resetLocalSync } = await import('/js/sync.js');
            await resetLocalSync(ctx);
        },
    };

    // --- Post-unlock boot. The vault is unlocked; from here on any failure
    // degrades the app in place and is logged — it must NOT redirect to /unlock
    // (see decision above). A failed sync/shim-install is not a reason to evict
    // the user to the unlock screen.
    try {
        const [{ installApiShim }, { pullOnOpen, startReconnectAutoDrain, getSyncStatus, reauthenticate }] = await Promise.all([
            import('/js/apishim.js'),
            import('/js/sync.js'),
        ]);

        const shimCall = installApiShim(ctx);
        // Decision 3 (C2d plan): groups.js/next-card.js/stats.js/today-loader.js
        // call window.apiCallDirect directly, bypassing the offlineAwareApiCall
        // seam apiCall() checks first. Route /api/* straight into the same shim
        // dispatch so those bypasses are served too; anything else keeps hitting
        // the real network fetch unchanged.
        //
        // core/api.js declares apiCallDirect as a top-level `function`, which
        // makes window.apiCallDirect a NON-CONFIGURABLE global property. The
        // previous accessor form (Object.defineProperty) therefore threw
        // "Cannot redefine property: apiCallDirect", which aborted the whole
        // post-unlock boot right here — silently skipping pullOnOpen, tag
        // invalidation, reminder recompute and the MCP responder, and leaving
        // these apiCallDirect reads hitting the network → 404 (med-1iv). The
        // property is WRITABLE though, so a plain assignment works. Ordering is
        // safe: this block resumes only after the async warmUnlock + apishim
        // import, i.e. after the synchronous body parse that runs core/api.js and
        // its own `window.apiCallDirect = apiCallDirect`, so we capture the real
        // fn and land last.
        const realApiCallDirect = window.apiCallDirect;
        window.apiCallDirect = (endpoint, method, body, opts) => (
            endpoint.startsWith('/api/')
                ? shimCall(endpoint, method, body, opts)
                : realApiCallDirect(endpoint, method, body, opts)
        );
        // med-gvk.2: local state is READY here — the vault is unlocked and the
        // API shim now serves every /api/* read from the local mirror, so app.js
        // (which awaits MedTrackerCloudReady) can mount the UI immediately.
        // Everything below is NETWORK sync (pullOnOpen, tag invalidation, warm
        // reads, reminder/push/mcp/inbox/feedback) and must NOT gate the mount:
        // on a DEGRADED network (captive portal / hung TCP) an awaited bare-fetch
        // pullOnOpen used to hang here forever, so MedTrackerCloudReady never
        // resolved and the app painted cache but NEVER mounted. Detaching this
        // block (plus the SYNC_FETCH_TIMEOUT_MS on sync.js's fetches) lets boot
        // resolve now and sync catch up in the background. Failures here degrade
        // in place and are logged — they must NOT redirect to /unlock (the vault
        // is already unlocked). The IIFE closes just before the outer catch.
        void (async () => {
        await pullOnOpen(ctx);
        // med-deq.2: the sync-status re-auth affordance lives in the unlock
        // shell, but a device with a warm LDK cache never sees that shell
        // (/unlock redirects straight back to /), so the real app must surface
        // an expired session itself. Called once after the boot drain and
        // again whenever a reconnect auto-drain settles into auth-expired —
        // a session expiring under a long-lived tab must not queue silently.
        // Best-effort, never blocks boot; the banner id dedupes repeat calls.
        const surfaceAuthExpired = () => (async () => {
            if (!(await getSyncStatus(ctx)).authExpired) return;
            if (!document.body) await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
            if (document.getElementById('auth-expired-banner')) return;
            const banner = document.createElement('div');
            banner.id = 'auth-expired-banner';
            banner.className = 'offline-banner'; // reuse the sync-degraded strip style
            banner.setAttribute('aria-live', 'polite');
            banner.append('Session expired — sync is paused. ');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = 'Re-authenticate';
            btn.addEventListener('click', () => {
                btn.disabled = true;
                reauthenticate(ctx)
                    .then(async (status) => {
                        if (status.authExpired) { btn.disabled = false; return; }
                        banner.remove();
                        // The drain may have pulled peer changes — repaint the
                        // shim-served tags, same set as the boot drain above.
                        if (window.DataStore && typeof window.DataStore.invalidateTags === 'function') {
                            await window.DataStore.invalidateTags(['bp', 'weight', 'medications', 'history', 'workout']);
                        }
                    })
                    .catch(() => { btn.disabled = false; });
            });
            banner.appendChild(btn);
            document.body.prepend(banner);
        })().catch((e) => console.error('[cloud-boot] auth-expired surface failed', e));
        // Reconnect auto-drain: online / visibility-regain events re-run the
        // boot drain so queued offline edits sync without a write or reload;
        // a drain that settles auth-expired re-surfaces the banner above.
        startReconnectAutoDrain(ctx, { onAuthExpired: surfaceAuthExpired });
        surfaceAuthExpired();
        if (window.DataStore && typeof window.DataStore.invalidateTags === 'function') {
            // Cloud mode has no change-poll loop — pullOnOpen is the only sync
            // trigger — so every shim-served tag must be evicted here or a
            // remote change from another device renders stale until some other
            // refresh path repaints. 'medications'/'history' cover the meds
            // list, Today next-dose tile (next_intake) and per-med history.
            // Runs in the background block (med-gvk.2): the UI already mounted
            // from local, so evicting here simply repaints those tags once the
            // background pull lands — no longer gating MedTrackerCloudReady.
            await window.DataStore.invalidateTags(['bp', 'weight', 'medications', 'history', 'workout']);
        }
        // med-prk.2: one-time backfill linking pre-migration plan exercises to
        // their exercise_library row, so a later library rename shows through in
        // plans (history logs snapshot the name at log time and stay unchanged;
        // the JS mirror of migration 076). Idempotent by
        // construction — a rerun finds zero ref-less exercises and no-ops, so no
        // separate "has run" flag is needed. Reuses the normal exercise-update
        // path (shimCall), which dedups by name into the library and sets
        // exercise_library_id exactly like createExercise; per-record writes
        // (not a full-vault snapshot) keep this additive backfill from dropping
        // tombstones or racing bootstrap. Best-effort; never blocks boot.
        try {
            const { readAllLiveRecords } = await import('/js/sync.js');
            const refless = (await readAllLiveRecords(ctx)).filter((r) => (
                r.recordType === 'workoutexercise'
                && (r.exercise_name || '').trim()
                && r.exercise_library_id == null
            ));
            for (const ex of refless) {
                await shimCall(`/api/workout/exercises/update?id=${ex.id}`, 'PUT', {
                    exercise_name: ex.exercise_name,
                    target_sets: ex.target_sets,
                    target_reps_min: ex.target_reps_min,
                    target_reps_max: ex.target_reps_max,
                    target_weight_kg: ex.target_weight_kg,
                    order_index: ex.order_index,
                });
            }
            if (refless.length) console.info(`[cloud-boot] linked ${refless.length} plan exercise(s) to the library`);
        } catch (e) {
            console.error('[cloud-boot] exercise-library backfill failed', e);
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
        // Safari evicts the push subscription of a PWA left unopened for a few
        // days, and nothing used to notice — reminders stopped forever, with no
        // signal, on a medication tracker (med-d5t.3). If permission is still
        // granted, re-subscribe and re-upload now. This is the load-bearing
        // half of the fix; the SW's pushsubscriptionchange handler is the belt.
        // Best-effort, never blocks boot; Settings reads the result.
        import('/js/push.js')
            .then(({ ensurePushSubscription }) => ensurePushSubscription())
            .then((result) => { window.MedTrackerCloud.push = result; })
            .catch((e) => console.error('[cloud-boot] push subscription check failed', e));

        // Task 4: if this account has a Claude pairing, this tab starts
        // answering MCP calls too — any unlocked device may be the one online
        // when the shim connects. refreshResponder reads the pairing from the
        // vault, elects a single answering tab (Web Lock, so open tabs don't
        // ping-pong the relay's single device leg), and no-ops when there's no
        // pairing. Best-effort, never blocks boot.
        import('/js/mcp-responder.js')
            .then(({ refreshResponder }) => refreshResponder(ctx))
            .catch((e) => console.error('[cloud-boot] mcp responder failed', e));

        // Publish this account's inbox public key so the relay can seal inbound
        // Telegram events to it (bd med-76c.2). Generates the keypair on the
        // first unlock that finds none. Best-effort: a failure here means
        // inbound events are refused server-side, not that the app degrades.
        //
        // Then drain whatever the relay sealed while we were away: a Confirm
        // tapped in Telegram at 09:00 is applied here, backdated to 09:00, on
        // the first unlock after it. Key publish must land first — draining
        // needs the private key it reads from the vault. Reminders are recomputed
        // afterwards because a confirmed dose removes its own re-reminders.
        import('/js/inbox.js')
            .then(async ({ ensureInboxKey, drainInbox, startInboxPolling }) => {
                await ensureInboxKey(ctx);
                const { createInboxApplier } = await import('/js/inbox-apply.js');
                const apply = createInboxApplier(ctx);
                const afterApply = async () => {
                    const { scheduleReminderRecompute } = await import('/js/reminders.js');
                    scheduleReminderRecompute(ctx);
                };

                const result = await drainInbox(ctx, { apply });
                if (result.applied > 0) await afterApply();

                // Keep draining while the tab is open, so a /bp texted to the
                // bot lands (and its "Queued" reply becomes "Recorded") within
                // seconds instead of waiting for the next page load.
                startInboxPolling(ctx, { apply, onApplied: afterApply });
            })
            .catch((e) => console.error('[cloud-boot] inbox key publish/drain failed', e));

        // Snooze / don't-bug taps from a push notification (med-9b8.3). The
        // service worker has no DEK, so it hands the action here instead of
        // POSTing it itself: warm tab → postMessage, cold start → ?reminder_action.
        // Runs only after unlock, which is exactly when shimCall can serve it.
        installReminderActionHandler(shimCall);

        // Cloud feedback channel (bd med-dni.2): mount the "Send feedback"
        // launcher only when the operator configured a recipient (the injected
        // <meta> read by getFeedbackRecipient). Unset → import nothing, feature
        // fully absent (matches the med-dni.1 server disabled state). Best-effort,
        // never blocks boot; the encrypt + POST behind enqueueFeedback is med-dni.3.
        import('/js/feedback-config.js')
            .then(async ({ getFeedbackRecipient }) => {
                if (!getFeedbackRecipient()) return;
                const { mountFeedbackLauncher } = await import('/js/feedback-ui.js');
                await mountFeedbackLauncher(ctx);
                // med-dni.3: install the reconnect/visibility autodrain and kick
                // one drain so an item queued in a previous session (offline at
                // capture time) is delivered on next open. Idempotent — the module
                // guards against a duplicate listener pair.
                const { startFeedbackAutoDrain, drainFeedbackOutbox } = await import('/js/feedback-submit.js');
                startFeedbackAutoDrain();
                drainFeedbackOutbox().catch(() => {});
            })
            .catch((e) => console.error('[cloud-boot] feedback launcher mount failed', e));
        })().catch((e) => console.error('[cloud-boot] background sync failed', e));
    } catch (e) {
        // Boot the app degraded rather than redirecting — the vault is already
        // unlocked, so /unlock would just bounce straight back to / (med-eas.16).
        // Only the SYNCHRONOUS shim install can reach here now (e.g. the
        // apiCallDirect redefine hazard above); background-sync failures land in
        // the IIFE's own .catch and likewise never redirect.
        console.error('[cloud-boot] post-unlock boot failed', e);
    }
})();
