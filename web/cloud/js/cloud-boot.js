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
    };

    // --- Post-unlock boot. The vault is unlocked; from here on any failure
    // degrades the app in place and is logged — it must NOT redirect to /unlock
    // (see decision above). A failed sync/shim-install is not a reason to evict
    // the user to the unlock screen.
    try {
        const [{ installApiShim }, { pullOnOpen }] = await Promise.all([
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
        // answering MCP calls too — any unlocked device may be the one online
        // when the shim connects. refreshResponder reads the pairing from the
        // vault, elects a single answering tab (Web Lock, so open tabs don't
        // ping-pong the relay's single device leg), and no-ops when there's no
        // pairing. Best-effort, never blocks boot.
        import('/js/mcp-responder.js')
            .then(({ refreshResponder }) => refreshResponder(ctx))
            .catch((e) => console.error('[cloud-boot] mcp responder failed', e));
    } catch (e) {
        // Boot the app degraded rather than redirecting — the vault is already
        // unlocked, so /unlock would just bounce straight back to / (med-eas.16).
        console.error('[cloud-boot] post-unlock boot failed', e);
    }
})();
