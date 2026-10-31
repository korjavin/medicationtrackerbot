// Cloud-mode boot shim, served by cmd/cloud ahead of every web/static script
// (internal/cloudserver/router.go injects the <script> tag right after
// <head>). Mirrors core/native-bootstrap.js: a classic, non-module script so
// it executes synchronously before messenger-adapter.js / data-store.js
// ever read window.__MEDTRACKER_CLOUD__.
//
// The warm-unlock + shim install below is unavoidably async (IndexedDB +
// WebCrypto), so it cannot finish before parsing reaches later scripts.
// app.js's checkAuth() awaits window.MedTrackerCloudReady before touching the
// network.
window.__MEDTRACKER_CLOUD__ = true;

// Immutable raw capability from the loaded response, captured before unlock,
// dynamic imports or any later settings/DOM changes can substitute a policy.
// module-state: immutable per-document public permission snapshot.
const cloudDocumentPolicy = Object.freeze({
    origins: window.document?.querySelector('meta[name="medtracker-connect-origins"]')?.content ?? null,
    origin: window.location?.origin || location.origin || '',
});

// The supporting worker selected a fresh response for this one-shot navigation.
// Future ordinary starts retain their immediate offline shell.
if (window.location?.search && typeof window.history?.replaceState === 'function') {
    const loadedURL = new URL(window.location.href);
    if (loadedURL.searchParams.get('__wg_provider_reload') === '1') {
        loadedURL.searchParams.delete('__wg_provider_reload');
        window.history.replaceState(window.history.state, '', loadedURL.href);
    }
}

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
// a harmless no-op. Cloud-only: this file is served solely by cmd/cloud, so no
// platform guard is needed.
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    const providerActivations = new Map();
    const retireProviderActivation = (worker) => {
        providerActivations.get(worker)?.cleanup();
        providerActivations.delete(worker);
    };
    window.document?.addEventListener('wg:provider-reload-activation', (event) => {
        const operation = event.detail?.operation;
        const worker = operation?.worker;
        if (!worker || typeof operation.claim !== 'function') return;
        const prior = providerActivations.get(worker);
        if (prior && prior.operation !== operation) return;
        if (prior) { event.detail.accepted = true; return; }
        const changed = () => {
            if (worker.state !== 'redundant') return;
            retireProviderActivation(worker);
            operation.redundant(worker);
        };
        providerActivations.set(worker, { operation, cleanup: () => worker.removeEventListener?.('statechange', changed) });
        worker.addEventListener?.('statechange', changed);
        event.detail.accepted = true;
    });
    window.document?.addEventListener('wg:provider-reload-abort', (event) => {
        const operation = event.detail?.operation;
        if (providerActivations.get(operation?.worker)?.operation === operation) retireProviderActivation(operation.worker);
    });
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
        const controller = navigator.serviceWorker.controller;
        const owned = providerActivations.get(controller);
        if (owned?.operation.committed) {
            retireProviderActivation(controller);
            if (!reloading) {
                reloading = true;
                // Already verified before activation. Replace this document in
                // this callback; no probe, flush or dirty wait under the new SW.
                owned.operation.claim();
            }
            return;
        }
        if (!hadController || reloading) return;
        reloading = true;
        for (const [worker, activation] of providerActivations) {
            activation.operation.supersede();
            retireProviderActivation(worker);
        }
        if (window.document && window.CustomEvent) window.document.dispatchEvent(new window.CustomEvent('wg:provider-reload-unrelated'));
        // Another tab's Reload can land here mid-Undo-window: send the delete first.
        const owed = window.flushPendingDelete?.();
        if (owed) owed.catch(() => {}).finally(() => location.reload());
        else location.reload();
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

// Seamless local → cloud move, account side (bd med-nt9p.32.18, contract in
// docs/android.md "move stash"). Before switching to this account the app
// shell stashed the device-only vault (move.stash); this picks it up so the
// user never opens Backup & import → Restore.
// - Called ONLY from the post-unlock boot below: the passkey unlock of this
//   account is the proof the user owns it, so a stash on the phone can never
//   replace a locked (or someone else's) account's data.
// - Inert on the web and on any shell whose shell.ops does not list move.take
//   (older iOS/Android builds reject the probe → no pickup). Every bridge call
//   is time-boxed so a shell that never answers cannot hold the boot.
// - move.clear runs after restoreVault replaced the vault (its beforeReload
//   hook), or at once for a stash with no user content when this account is
//   known to have records (bd med-ta2n.7); a cancel, a failed import or an
//   unknown account state (offline, failed pull) keeps the stash and the next
//   open tries again.
const MOVE_NOTICE_KEY = 'wg-move-picked-up';
const MOVE_PICKED_AT_KEY = 'wg-move-picked-at';
const MOVE_JUST_PICKED_MS = 5 * 60 * 1000;
const MOVE_PROBE_MS = 5000;
const JOIN_ERASE_MS = 60000; // a wipe of a large local vault
function withinMs(promise, ms) {
    return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
}
async function pickUpMovedVault(win) {
    // Wait for the page's scripts first: native/index.js (the bridge),
    // settings.js (nativeHas) and importexport.js load after this file.
    const doc = win.document;
    if (doc && doc.readyState === 'loading') await new Promise((r) => doc.addEventListener('DOMContentLoaded', r, { once: true }));
    const native = win.LocalNotifications && win.LocalNotifications.__native;
    if (!native || (native.platform !== 'ios' && native.platform !== 'android')) return;
    // The reload after a pickup lands here once more: say where the records
    // went (P3 · done, bd med-ta2n.7). The key holds the moved record count.
    let moved = null;
    let pickedAt = NaN;
    try {
        moved = win.sessionStorage.getItem(MOVE_NOTICE_KEY);
        pickedAt = Number(win.sessionStorage.getItem(MOVE_PICKED_AT_KEY));
        win.sessionStorage.removeItem(MOVE_NOTICE_KEY);
        win.sessionStorage.removeItem(MOVE_PICKED_AT_KEY);
    } catch { /* storage blocked */ }
    if (moved !== null) {
        const n = Number(moved);
        win.safeToast(moved !== '' && Number.isInteger(n) && n > 0
            ? `Sync is on · ${n} ${n === 1 ? 'record is' : 'records are'} on your account`
            : 'Sync is on', 'success');
    }
    // nativeHas: features/settings.js, the one shell.ops probe per page.
    if (typeof win.nativeHas !== 'function') return;
    if ((await withinMs(win.nativeHas('move.take').catch(() => false), MOVE_PROBE_MS)) !== true) return;
    // The reload right after a pickup (bd med-ta2n.23, twin of local-policy.js
    // pickupLeaveStash justPicked): a stash still here is the one just
    // imported, its move.clear lost to the time box on a slow bridge. Taking it
    // again would ask Merge / Replace over its own records. Only a fresh
    // stamp counts: beforeReload writes both keys after a successful import,
    // and a flag a reload never consumed (bounced to /unlock) must not drop a
    // later move's stash. No stamp or a stale one → take it, as before.
    const age = Date.now() - pickedAt;
    if (moved !== null && age >= 0 && age < MOVE_JUST_PICKED_MS) {
        await withinMs(native.call('move.clear').catch(() => null), MOVE_PROBE_MS);
        return;
    }
    const stash = await withinMs(native.call('move.take').catch(() => null), MOVE_PROBE_MS);
    const vault = stash && stash.vault;
    const restore = win.SettingsImportExport && win.SettingsImportExport.restoreVault;
    if (typeof vault !== 'string' || !vault || typeof restore !== 'function') return;
    // A stash with no user content (an invite taken on a device with nothing
    // logged: moveToCloud {url} always stashes, bd med-ta2n.7) is never offered
    // as a Merge/Replace to an account with records: dropped there. An empty
    // account still takes it silently (settings, keys); unknown → kept for the
    // next open. Unreadable → restoreVault reports it.
    let count = null;
    try {
        const { vaultToRecords, userContentCount } = await import('/domain/vault.js');
        count = userContentCount(vaultToRecords(JSON.parse(vault), { now: Date.now() }));
    } catch { /* restoreVault below says why */ }
    if (count === 0) {
        // Only a definite answer acts: offline, a failed pull or a throw keeps
        // the stash for the next open (its settings and keys are not dropped).
        const has = await withinMs(Promise.resolve(win.CloudVault?.hasUserContent?.()).catch(() => null), MOVE_PROBE_MS);
        if (has === true) await withinMs(native.call('move.clear').catch(() => null), MOVE_PROBE_MS);
        if (has !== false) return;
    }
    // restoreVault reloads the page itself once the vault is replaced, and runs
    // beforeReload only then. A failed clear only means the next open offers
    // the same move again (behind the typed confirm: the account has content).
    // true = imported and the page is reloading (the boot's W1 ask stands down).
    const result = await restore(vault, {
        source: 'move',
        beforeReload: async () => {
            try {
                win.sessionStorage.setItem(MOVE_NOTICE_KEY, String(count ?? ''));
                win.sessionStorage.setItem(MOVE_PICKED_AT_KEY, String(Date.now()));
            } catch { /* storage blocked */ }
            await withinMs(native.call('move.clear'), MOVE_PROBE_MS);
        },
    });
    return !!(result && result.imported);
}

// AD9 "Join and erase", account side (bd med-r1j2.4). The local page asked
// local.leave {url, erase: true} and erased nothing. Only here — the joined
// account booted unlocked right after this tab enrolled its passkey (claim.js
// sets the one-shot sessionStorage 'wg-join-enrolled', takeJoinEnrolled reads
// and drops it at the top of every boot; bd med-r1j2.7) — is the
// shell told to finish: local.erase wipes the local vault (the Settings →
// Erase data on this device effects) if, and only if, it still holds that
// join's erase for this host; otherwise a no-op. A cancel, an expired code, a
// 409/410 (whose Close lands here too, unlocked by an older session), another
// account or a crash never get the marker. Inert on the web and on shells
// whose shell.ops lacks local.erase.
function takeJoinEnrolled(win) {
    try {
        const enrolled = win.sessionStorage.getItem('wg-join-enrolled') === '1';
        win.sessionStorage.removeItem('wg-join-enrolled');
        return enrolled;
    } catch {
        return false; // no storage: never erase
    }
}

async function finishJoinErase(win) {
    const doc = win.document;
    if (doc && doc.readyState === 'loading') await new Promise((r) => doc.addEventListener('DOMContentLoaded', r, { once: true }));
    const native = win.LocalNotifications && win.LocalNotifications.__native;
    if (!native || (native.platform !== 'ios' && native.platform !== 'android') || typeof win.nativeHas !== 'function') return;
    if ((await withinMs(win.nativeHas('local.erase').catch(() => false), MOVE_PROBE_MS)) !== true) return;
    // {enrolled: true}: a shell acts on nothing less, so an older cached
    // cloud-boot.js sending a bare local.erase on every boot erases nothing.
    // A failed wipe keeps the shell's intent: offer it again while it is due.
    const device = win.LocalNotifications.copy?.device || 'device';
    for (;;) {
        // No answer within JOIN_ERASE_MS (a hung wipe) counts as not finished;
        // a Try again while it still runs gets "busy" from the shell.
        const ok = await withinMs(native.call('local.erase', { enrolled: true }).then(() => true, () => false), JOIN_ERASE_MS);
        if (ok === true || typeof win.safeConfirm !== 'function') return;
        const again = await win.safeConfirm(`The records that were on this ${device} before could not be erased.`, null,
            { title: "Erase didn't finish", confirmLabel: 'Try again', cancelLabel: 'Not now' });
        if (!again) return;
    }
}

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

    // Warm tab: the SW postMessages the route it resolved — or, for a body tap
    // (med-9d1a), the reminder's deeplink, which the page routes exactly as a
    // cold start's URL. Same-origin root + query only (sw.js reminderOpenUrl).
    if (navigator.serviceWorker) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            if (event.data && event.data.type === 'reminder-action') apply(event.data.route);
            if (event.data && event.data.type === 'reminder-open') openReminderUrl(event.data.url);
        });
    }
}

function openReminderUrl(url) {
    if (typeof url !== 'string' || !url.startsWith('/?')) return;
    window.history.replaceState({}, '', url);
    if (typeof window.handleDeepLinks === 'function') window.handleDeepLinks();
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
    // Shared-plan/gym deeplink (med-uo64.3, med-8j5w.3): a #share-plan= or
    // #share-gym= fragment rides along to /unlock and back to /. Only these
    // fragments forward — anything else (notably #claim=, which has its own
    // branch above) must not, or the claim redirect ping-pongs.
    const sharePlanHash = /^#share-(?:plan|gym)=/.test(location.hash) ? location.hash : '';
    // claim.js's one-shot enrollment marker (bd med-r1j2.7), consumed by THIS
    // boot whatever happens next: a boot that fails before finishJoinErase must
    // not leave it for a later, unrelated one.
    const joinEnrolled = takeJoinEnrolled(window);
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
        location.href = '/unlock' + sharePlanHash;
        return;
    }
    if (!ctx) {
        location.href = '/unlock' + sharePlanHash;
        return;
    }

    // Publish ctx for main-app code (e.g. Settings' cloud push controls) that
    // needs the unlocked vault but isn't part of this boot closure. Plain field
    // set — must not throw or block the try/catch below that guards the rest
    // of post-unlock boot.
    window.MedTrackerCloud = { ctx };

    // C2e full-vault export/import (Settings → Import/Export, Task 6). Both
    // sides are entirely client-side against the unlocked vault — zero-knowledge
    // forbids the server ever seeing plaintext. exportAll reads every record
    // (live rows plus the derived-slot tombstones that suppress re-materialization;
    // including the unmasked integrations keys, module-to-module, never
    // across the /api shim) and regroups via web/domain/vault.js; importAll
    // wipes+relays the whole record store (preserving device/crypto state the
    // vault never carries — nk, voice provisioning) and forces one snapshot upload
    // so other devices re-bootstrap. Lazy dynamic imports keep this off the
    // boot critical path.
    window.CloudVault = {
        async exportAll({ includeSecrets = true } = {}) {
            const [{ readAllRawRecords }, { recordsToVault }] = await Promise.all([
                import('/js/sync.js'),
                import('/domain/vault.js'),
            ]);
            const records = await readAllRawRecords(ctx);
            return JSON.stringify(recordsToVault(records, { now: Date.now(), includeSecrets }), null, 2);
        },
        // readAllLiveRecords bootstraps first, so a freshly claimed second
        // device sees the server's data, not a stale empty local store.
        async hasUserContent() {
            const [{ readAllLiveRecords, pullOnOpen, getSyncStatus }, { hasUserContent }] = await Promise.all([
                import('/js/sync.js'),
                import('/domain/vault.js'),
            ]);
            // Bootstrap restores only the snapshot; pull the op tail too, and
            // refuse a verdict (undefined → confirm shown) if we could not reach
            // the server, since the account may hold data we have not seen.
            await pullOnOpen(ctx);
            const st = await getSyncStatus(ctx);
            if (st.offline || st.authExpired) return undefined;
            return hasUserContent(await readAllLiveRecords(ctx));
        },
        // mode 'merge' (bd med-o7zq.38): keep every record here and add the
        // file's absent ones (vault.js mergeRecords, receiver wins). Pending
        // writes stay queued: they are rows of the receiver, so they win too.
        async importAll(json, { mode } = {}) {
            const [{ replaceAllRecords, forceSnapshot, markForceSnapshotPending, readAllLiveRecords, bootstrapIfNeeded, isBootstrapped, dropPendingForTypes }, { vaultToRecords, managedTypesForImport, mergeRecords }, { withMaterializationStopped }] = await Promise.all([
                import('/js/sync.js'),
                import('/domain/vault.js'),
                import('/js/apishim.js'),
            ]);
            const vault = typeof json === 'string' ? JSON.parse(json) : json;
            const records = vaultToRecords(vault, { now: Date.now() });
            const merge = mode === 'merge';
            // Managed set is narrowed per-file: a secrets-free vault must not
            // wipe the destination's integrations keys / api tokens.
            const VAULT_MANAGED_TYPES = managedTypesForImport(vault);
            // Replace: preserve records the vault never manages (nk push key,
            // voice provisioning, un-carried secrets) across the wholesale
            // replace. Both paths bootstrap first, so isBootstrapped below
            // reflects whether that bootstrap actually reached the server.
            if (merge) await bootstrapIfNeeded(ctx);
            const survive = merge ? null
                : (await readAllLiveRecords(ctx)).filter((r) => !VAULT_MANAGED_TYPES.has(r.recordType));
            // Refuse to wipe until the account cursor exists. Without it,
            // forceSnapshot can't propagate the import (null cursor → nothing to
            // snapshot at) and the next open re-bootstraps the stale server
            // snapshot over the imported records. Throwing here surfaces the
            // error in importexport.js and skips the reload — no destructive
            // replace happens, so local data is untouched.
            if (!(await isBootstrapped())) {
                throw new Error('Sync not ready — connect to the internet and reopen the app before importing.');
            }
            // Mark before the wipe: a crash between replaceAllRecords and the
            // marker would let the next open re-bootstrap the stale server
            // snapshot over the import (and the old data is already gone).
            await markForceSnapshotPending();
            // No due-dose sweep in flight or started from here on: one that read
            // the old medications would write their doses over the import
            // (bd med-o7zq.41). Writers resume, on the new store, once it ends.
            await withMaterializationStopped(async () => { if (merge) {
                // Merge: every row here stays, tombstones included. The rows
                // are read inside replaceAllRecords' records lock, so a write
                // (a background Health import, a flush) cannot land between
                // the read and the clear and be reverted. A pending row is a
                // receiver row, so it won the merge and its op flushes after
                // the snapshot unchanged (a floored placeholder that yielded
                // is dropped by the overlay). Except a receiver row the merge
                // rewrote (weight trends rewalked, a vitals day gaining the
                // file's samples): the overlay would lay its old copy back, so
                // its pending op goes (under the same lock); the snapshot
                // carries the row.
                // runs inside withRecordsLock (non-reentrant): no record reads/writes through the locked ports here.
                await replaceAllRecords((here) => {
                    const mine = new Set(here);
                    const merged = mergeRecords(here, records);
                    const rewritten = new Set(here.map((r) => r.recordId));
                    for (const r of merged) if (mine.has(r)) rewritten.delete(r.recordId);
                    return { records: merged, dropPendingIds: rewritten };
                });
            } else {
                // Replace: discard any not-yet-flushed managed writes first, or
                // replaceAllRecords' pending overlay resurrects them over the backup
                // (and they later flush over it). Non-managed pending (nk, and
                // the delivery pref when the file carries none) stays queued —
                // those records are in `survive`.
                await dropPendingForTypes(VAULT_MANAGED_TYPES);
                await replaceAllRecords([...records, ...survive]);
            } });
            // Past this line the import HAS happened locally. Propagation to the
            // server is retryable (forceSnapshotPending stays set, next pullOnOpen
            // retries), so a throw here must not reach importexport.js — it would
            // report "Import failed" and skip the reload while the old data is
            // already gone, leaving the user staring at pre-import UI over
            // post-import data.
            // `upload` tells importexport.js whether the account now holds the
            // import, and if not why (sync.js forceSnapshot; bd med-o7zq.6): a
            // move from another device must not be called done while the only
            // durable copy is still elsewhere.
            let upload;
            try {
                upload = await forceSnapshot(ctx);
            } catch (err) {
                console.warn('[cloud] import applied locally; sync to other devices deferred', err);
                upload = 'retrying';
            }
            // One sleep model, no stress (bd med-0xad.4): the file may carry
            // legacy sleep sessions, and a replace keeps the (no longer
            // managed) stress rows. Converted here as ordinary ops on top of
            // the snapshot; a failure is left to the next boot's pass.
            // A merge reads this mirror too: only past a pull in this page load.
            try {
                const [{ recordsPort, pulledThisSession }, { createVitalsDomain }] = await Promise.all([
                    import('/js/sync.js'),
                    import('/domain/vitals.js'),
                ]);
                if (merge && !pulledThisSession()) throw new Error('mirror not pulled this session');
                await createVitalsDomain({ records: recordsPort(ctx), now: Date.now, timeZone: 'UTC' }).unifyLegacy();
            } catch (err) {
                console.warn('[cloud] legacy sleep/stress conversion deferred to the next boot', err);
            }
            return { upload };
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
        async getInboxUnopenableCount() {
            // med-0tp: Settings reads the last drain's un-openable seal count so
            // a "Queued" command stuck on a superseded device key is visible, with
            // the reset escape hatch right next to it. Lazy import like resetLocalSync.
            const { getUnopenableCount } = await import('/js/inbox.js');
            return getUnopenableCount();
        },
        // Leaving the account on this device (here and invite.js Switch account,
        // bd med-erq1.3): the relay stops waking this phone for it. Best-effort,
        // never throws — after an account delete the session is gone and the
        // server already cascaded the row. Time-boxed: a stalled relay or
        // bridge must not hold the user in the account.
        async dropNativePushToken() {
            try {
                await Promise.race([
                    import('/js/push.js').then(({ dropNativePushToken }) => dropNativePushToken()),
                    new Promise((r) => setTimeout(r, 3000)),
                ]);
            } catch (e) {
                console.warn('[cloud-boot] native push token delete failed', e);
            }
        },
        // The iOS and Android apps' way out of the account (bd med-o7zq.30/.32/.33/.34,
        // Android bd med-nt9p.32.13/.15):
        // the shell forgets the account host. After a delete (no opts) it shows
        // its native first-run; Settings → Account "Use this iPhone without an
        // account" passes { then: 'local' } and the shell opens local mode
        // directly (a shell older than .34 ignores it and shows the first-run,
        // whose "Only on this device" starts local mode). Nothing is erased —
        // the account stays on the server and this origin keeps its data, so
        // opening the account address again resumes it. A shell built before
        // the account.leave op answers "unsupported: …": point at the shell's
        // own Switch account (LocalNotifications.copy, per platform).
        async leaveAccount(opts) {
            const native = window.LocalNotifications && window.LocalNotifications.__native;
            if (!native || (native.platform !== 'ios' && native.platform !== 'android')) throw new Error('Open the app on your iPhone to use it without an account.');
            await window.CloudVault.dropNativePushToken();
            try {
                await native.call('account.leave', opts);
            } catch (e) {
                if (/unsupported/.test(String(e && e.message))) {
                    const copy = window.LocalNotifications.copy;
                    throw new Error((copy && copy.leaveFallback) || 'Update Med Tracker, or open iOS Settings → Med Tracker → Switch account, then choose Only on this device.');
                }
                throw e;
            }
        },
    };

    // --- Post-unlock boot. The vault is unlocked; from here on any failure
    // degrades the app in place and is logged — it must NOT redirect to /unlock
    // (see decision above). A failed sync/shim-install is not a reason to evict
    // the user to the unlock screen.
    try {
        const [{ installApiShim }, { pullOnOpen, startReconnectAutoDrain, requestDrain, getSyncStatus, reauthenticate, hasCaughtUp, getRecordsChangeCount, requestFreshDrain, pulledThisSession }] = await Promise.all([
            import('/js/apishim.js'),
            import('/js/sync.js'),
        ]);

        // bd med-ydt2: /api/bootstrap omits needs_first_run until this device
        // has pulled the account (bd med-ejgf) AND the move pickup below has
        // settled without a reload, so no boot-time bootstrap mounts W1 ahead
        // of an import that stamps `firstrun` and reloads the page.
        let moveSettled = false;
        const shimCall = installApiShim(ctx, { documentPolicy: cloudDocumentPolicy, caughtUp: async () => moveSettled && hasCaughtUp() });
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
        // A reminder deeplink that finds no dose at its slot re-reads once
        // after this pull before it calls the reminder out of date (bd
        // med-wi09.4): an edit synced from another device may not be local yet.
        const pulled = Promise.resolve(pullOnOpen(ctx));
        if (window.MedTrackerCloud) window.MedTrackerCloud.pulled = pulled.then(() => {}, () => {});
        await pulled;
        // One sleep model, no stress (bd med-0xad.4): convert whatever legacy
        // rows the mirror has (none: no writes), but only once a pull in this
        // page load reached the tail; an offline boot retries after each
        // drain (onSettled below) until it has run. Not awaited.
        let unified = false;
        const unifyLegacy = () => {
            if (unified) return;
            Promise.resolve().then(() => {
                if (unified || !pulledThisSession()) return null;
                unified = true;
                return shimCall.unifyLegacy();
            }).catch((e) => {
                unified = false; // a failed or paused run retries on the next drain
                console.error('[cloud-boot] legacy sleep/stress conversion failed', e);
            });
        };
        unifyLegacy();
        // Cloud mode has no change-poll loop — the boot pull is the first sync
        // trigger — so every shim-served tag is evicted once a pull lands, or a
        // remote change from another device renders stale until some other
        // refresh path repaints. 'medications'/'history' cover the meds list,
        // Today next-dose tile (next_intake) and per-med history. Only after a
        // pull in this page load reached the tail (bd med-kk1q.1): a pull that
        // failed offline changed nothing, and evicting then wiped exactly the
        // ApiCache rows a cold offline open reads. An offline boot evicts after
        // the first drain that lands instead (onSettled below).
        let evicted = false;
        const evictShimTags = async () => {
            if (evicted || !window.DataStore || typeof window.DataStore.invalidateTags !== 'function' || !pulledThisSession()) return;
            evicted = true;
            await window.DataStore.invalidateTags(['bp', 'weight', 'medications', 'history', 'workout']);
        };
        // bd med-ejgf: the shim reports needs_first_run false until this
        // device has pulled the account once, so W1 never writes flags or the
        // reminder default over an existing account from an empty mirror. The
        // boot-time /api/bootstrap usually ran before that pull: re-ask after
        // it and after every drain (online / visible / sync wake) until the
        // mirror has caught up, then stop. Offline, the app shell simply runs
        // without W1 and the sync status line says so.
        //
        // bd med-ydt2: and not before the local → cloud move pickup has
        // settled. Its import stamps `firstrun` (vault with records) and
        // reloads the page, so a W1 asked meanwhile mounted over the empty new
        // account, then vanished with the reload. An import (page reloading)
        // never asks; no stash, a cancel or a failed import asks as before.
        // The local → cloud move pickup (bd med-nt9p.32.18): after pullOnOpen,
        // as importAll needs the bootstrapped cursor. Not awaited, so a slow
        // shell or a pending confirm never holds the rest of the boot; it then
        // runs alongside it exactly as a Settings → Restore would. A no-op on
        // the web.
        const movePickup = pickUpMovedVault(window).catch((e) => {
            console.error('[cloud-boot] move pickup failed', e);
            return false;
        }).then((reloading) => {
            if (!reloading) moveSettled = true;
            return reloading;
        });
        // The account-zone floor (bd med-wi09.19): an unpinned account takes
        // one zone. The shim's canFloor holds it until a pull in this page load
        // reached the tail and the move pickup settled, so it is tried here
        // and after every drain until it has run once. Not awaited.
        let floored = false;
        const floorTimeZone = () => {
            if (floored) return;
            Promise.resolve().then(() => shimCall.floorTimeZone()).then((wrote) => {
                // A drain that settles while the move pickup is pending must
                // not end the tries: canFloor said no only because of the pickup.
                if (wrote || (moveSettled && pulledThisSession())) floored = true;
            }).catch((e) => console.error('[cloud-boot] time zone floor failed', e));
        };
        movePickup.then(floorTimeZone);
        let firstRunAsked = false;
        const askFirstRun = () => (async () => {
            if (firstRunAsked || (await movePickup) || !(await hasCaughtUp())) return;
            const res = await shimCall('/api/bootstrap', 'GET');
            // Only a real answer ends the re-asking: a throw or a payload
            // without the flag leaves the next drain to try again.
            if (firstRunAsked || !res || typeof res.needs_first_run !== 'boolean' || !window.AuthBootstrap) return;
            firstRunAsked = true;
            window.AuthBootstrap.mountFirstRun(res.needs_first_run);
        })().catch((e) => console.error('[cloud-boot] first-run check failed', e));
        askFirstRun();
        // The kit page's save state (bd med-ckm5.2, kit-state.js): after
        // pullOnOpen, so the record lands on the synced singleton.
        Promise.resolve()
            .then(() => import('/js/kit-state.js'))
            .then(({ drainKitSaved }) => drainKitSaved(shimCall))
            .catch((e) => console.error('[cloud-boot] emergency kit state failed', e));
        if (joinEnrolled) finishJoinErase(window).catch((e) => console.error('[cloud-boot] join erase failed', e));
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
            banner.className = 'wg-banner wg-banner--warn';
            banner.setAttribute('aria-live', 'polite');
            if (window.WGIcons) {
                const ico = document.createElement('i');
                ico.className = 'wg-ico wg-ico--sm';
                ico.appendChild(window.WGIcons.iconSvg('lock'));
                banner.appendChild(ico);
            }
            const text = document.createElement('span');
            text.className = 'wg-banner__text';
            text.textContent = 'Session expired · sync is paused.';
            banner.appendChild(text);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'wg-btn wg-btn--sm';
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
            const host = document.getElementById('app-banners');
            if (host) host.appendChild(banner); else document.body.prepend(banner);
        })().catch((e) => console.error('[cloud-boot] auth-expired surface failed', e));
        // Reconnect auto-drain: online / visibility-regain events re-run the
        // boot drain so queued offline edits sync without a write or reload;
        // a drain that settles auth-expired re-surfaces the banner above.
        // med-wi09.5: the server's writer gate (426) refused this build's
        // pushes. Queued writes stay put and still export; a reload loads the
        // current build, which re-posts them. No reset hint — a reset would
        // discard exactly those writes.
        const surfaceUpdateRequired = () => (async () => {
            if (!(await getSyncStatus(ctx)).updateRequired) return;
            if (!document.body) await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
            if (document.getElementById('update-required-banner')) return;
            // Ask the SW for the current build before offering Reload.
            import('/js/update-check.js').then((m) => m.fetchLatest(window)).catch(() => {});
            const banner = document.createElement('div');
            banner.id = 'update-required-banner';
            banner.className = 'wg-banner wg-banner--warn';
            banner.setAttribute('aria-live', 'polite');
            if (window.WGIcons) {
                const ico = document.createElement('i');
                ico.className = 'wg-ico wg-ico--sm';
                ico.appendChild(window.WGIcons.iconSvg('refresh'));
                banner.appendChild(ico);
            }
            const text = document.createElement('span');
            text.className = 'wg-banner__text';
            text.textContent = 'Update required — reload to keep syncing.';
            banner.appendChild(text);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'wg-btn wg-btn--sm';
            btn.textContent = 'Reload';
            btn.addEventListener('click', () => {
                btn.disabled = true;
                import('/js/update-check.js')
                    .then((m) => m.reloadToLatest(window))
                    .catch(() => location.reload());
            });
            banner.appendChild(btn);
            const host = document.getElementById('app-banners');
            if (host) host.appendChild(banner); else document.body.prepend(banner);
        })().catch((e) => console.error('[cloud-boot] update-required surface failed', e));
        startReconnectAutoDrain(ctx, { onAuthExpired: surfaceAuthExpired, onUpdateRequired: surfaceUpdateRequired, onSettled: () => { unifyLegacy(); floorTimeZone(); evictShimTags().catch((e) => console.error('[cloud-boot] tag eviction failed', e)); return askFirstRun(); } });
        // Pull to refresh (bd med-y7b4.6): one more drain through the same
        // single-slot guard. Registered after the boot pull so the two never
        // overlap. What lands repaints through notifyRecordsChanged.
        // ponytail: "arrived" is the records generation moving, so a local
        // write landing mid-pull also counts; a per-pull op count if it matters.
        // AppRefresh is a classic body script: a boot that gets here while the
        // body still parses registers on DOMContentLoaded instead (never awaited,
        // so nothing below waits on it).
        const registerRefresh = () => {
            if (!window.AppRefresh || typeof window.AppRefresh.setSync !== 'function') return;
            window.AppRefresh.setSync(async () => {
                const before = getRecordsChangeCount();
                await requestFreshDrain(ctx);
                const st = await getSyncStatus(ctx);
                if (st.authExpired) throw new Error('Session expired · tap Re-authenticate to sync');
                if (st.updateRequired) throw new Error('Update required · reload to keep syncing');
                if (st.offline) throw new Error('Offline · showing what\'s on this device');
                return { arrived: getRecordsChangeCount() !== before };
            });
        };
        if (!window.AppRefresh && window.document && window.document.readyState === 'loading') {
            window.document.addEventListener('DOMContentLoaded', registerRefresh, { once: true });
        } else {
            registerRefresh();
        }
        surfaceAuthExpired();
        surfaceUpdateRequired();
        // Runs in the background block (med-gvk.2): the UI already mounted from
        // local, so this simply repaints those tags once the pull lands.
        await evictShimTags();
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
        //
        // recomputeAndPush, NOT the debounced scheduler (bd med-9y9): this is
        // the recovery path the "Open the app to keep reminders running" push
        // sends the user down, and a 2s timer that a quick close (or a
        // frozen/discarded background tab) drops would leave the horizon
        // exactly as empty as it was. Concurrent recomputes are safe —
        // pushSchedule serializes per account (push.js pushChains), and so does
        // the iOS local schedule (reminders.js localChain).
        import('/js/reminders.js')
            .then(({ recomputeAndPush }) => recomputeAndPush(ctx))
            .catch((e) => console.error('[cloud-boot] reminder recompute failed', e));
        // The iOS app shell keeps this page alive across app switches, so an
        // unlock happens once while "open the app" happens many times — and the
        // phone holds only 64 reminders (bd med-w6gx.5). Re-schedule each time
        // the app comes back to the front. Never on the web.
        let localNotifications = false;
        try { localNotifications = window.LocalNotifications?.isSupported?.() === true; } catch { /* native/ stub */ }
        if (localNotifications) {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState !== 'visible') return;
                import('/js/reminders.js')
                    .then(({ recomputeAndPush }) => recomputeAndPush(ctx))
                    .catch((e) => console.error('[cloud-boot] reminder recompute failed', e));
            });
        }
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

        // The app shells' APNs/FCM wake channel (bd med-erq1.3): WKWebView and
        // Android WebView have no Web Push, so the shell's device token is
        // registered with the relay on every unlock (POST is an upsert that
        // refreshes last_seen) and again when the shell reports a new one
        // (kind 'token': first grant, rotation). 'dry-queue' is the relay's
        // "open the app to keep reminders running": refill the horizon now.
        // The inbox-wake kind is handled with the inbox below. Never on the web.
        let nativePush = false;
        try { nativePush = window.NativePush?.isSupported?.() === true; } catch { /* native/ stub */ }
        if (nativePush) {
            const registerToken = () => import('/js/push.js')
                .then(({ registerNativePushTokenWithRetry }) => registerNativePushTokenWithRetry())
                .catch((e) => console.error('[cloud-boot] native push token register failed', e));
            registerToken();
            // true = taken: the shell then shows no fallback notification (bd med-erq1.4).
            window.NativePush.onWake((kind) => {
                if (kind === 'token') {
                    registerToken();
                    return true;
                }
                if (kind !== 'dry-queue') return false;
                import('/js/reminders.js')
                    .then(({ recomputeAndPush }) => recomputeAndPush(ctx))
                    .catch((e) => console.error('[cloud-boot] dry-queue reminder recompute failed', e));
                return true;
            });
        }

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
        // the first unlock after it. Reminders are recomputed afterwards because
        // a confirmed dose removes its own re-reminders.
        //
        // ORDER (bd med-2yl): the poller and the wake listener go in FIRST, and
        // the two network steps each carry their OWN catch. They used to be
        // awaited ahead of both installs under a single shared catch, so one
        // throw — a key PUT that 500s, a drain fetch on a radio that just came
        // back — cost the page BOTH the 5s poller and the wake listener for as
        // long as that page lived, and every later Telegram command sat at
        // "⏳ Queued" until a reload. Neither install depends on those steps:
        // drainInbox reads the private key from the vault itself and no-ops when
        // there is none. ensureInboxKey still runs before the INITIAL drain — on
        // a first-ever unlock it is what puts that key in the vault — it just no
        // longer gates anything else.
        import('/js/inbox.js')
            .then(async ({ ensureInboxKey, drainInbox, startInboxPolling, startInboxEventStream }) => {
                const { createInboxApplier } = await import('/js/inbox-apply.js');
                const apply = createInboxApplier(ctx);
                // Awaited and UN-debounced on purpose (bd med-9y9). A drain is
                // usually triggered by the SW's inbox-wake push into a
                // backgrounded tab, which the browser may freeze or discard
                // well inside scheduleReminderRecompute's 2s timer — and a
                // burst (a .nxk import acking ~100 events) re-armed that timer
                // on every ack, starving it outright. Either way the horizon is
                // never extended, and since only the browser can extend it,
                // reminders stop forever with no error surfaced anywhere. The
                // debounce stays where it earns its keep: apishim's chatty
                // per-write path. Errors are logged, never rethrown — the
                // poller must not treat a failed recompute as a failed drain.
                const afterApply = async () => {
                    const { recomputeAndPush } = await import('/js/reminders.js');
                    await recomputeAndPush(ctx)
                        .catch((e) => console.error('[cloud-boot] post-drain reminder recompute failed', e));
                };

                // Keep draining while the tab is open, so a /bp texted to the
                // bot lands (and its "Queued" reply becomes "Recorded") within
                // seconds instead of waiting for the next page load.
                startInboxPolling(ctx, { apply, onApplied: afterApply });

                // ...and drain the instant the server says mail arrived (bd
                // med-5fo). The SW turns the content-free inbox-wake push into
                // this message; a backgrounded tab's timer is throttled to
                // ~1/min (a frozen one never fires), so the push is what makes
                // "Queued" → "Recorded" feel immediate on a phone. Calling
                // drainInbox directly bypasses the poller's backoff gate;
                // drainInbox's own in-flight guard makes an overlapping poll
                // tick a no-op.
                const wakeDrain = () => drainInbox(ctx, { apply })
                    .then((r) => (r.applied > 0 ? afterApply() : undefined))
                    .catch((e) => console.error('[cloud-boot] inbox wake drain failed', e));
                if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
                    navigator.serviceWorker.addEventListener('message', (event) => {
                        if (!event.data || event.data.type !== 'inbox-wake') return;
                        // Ack on RECEIPT, not on drain completion: the SW only
                        // needs to know a live, unlocked page took the nudge, and
                        // a slow drain must not earn the user a duplicate
                        // notification. This listener exists only post-unlock, so
                        // an ack also means "this window can actually apply it".
                        if (event.ports && event.ports[0]) event.ports[0].postMessage('ack');
                        wakeDrain();
                    });
                }
                // The app shells' APNs/FCM inbox-wake (bd med-erq1.3): the same
                // drain. Returning true is the receipt (the event's
                // preventDefault): the iOS shell then shows no fallback alert.
                if (nativePush) {
                    window.NativePush.onWake((kind) => {
                        if (kind !== 'inbox-wake') return false;
                        wakeDrain();
                        return true;
                    });
                }

                // ...and subscribe to the server's content-free SSE wake (bd
                // med-j0tc): the same instant drain as the push above, but with
                // no permission/subscription prerequisite and no external
                // delivery hop. The 5s poller stays as the fallback when the
                // stream is down.
                // onSyncReady (bd med-eas.9): another device's write wakes this
                // tab over the same stream; the pulled records repaint through
                // the existing cloud-write refresh path.
                startInboxEventStream(ctx, { apply, onApplied: afterApply, onSyncReady: () => requestDrain(ctx, { wake: true }) });

                // Both best-effort, each with its own catch — see the ORDER note
                // above. A failed key publish means the relay refuses inbound
                // events, not that the app degrades; a failed initial drain is
                // just the next poll tick's work.
                await ensureInboxKey(ctx)
                    .catch((e) => console.error('[cloud-boot] inbox key publish failed', e));
                const result = await drainInbox(ctx, { apply })
                    .catch((e) => { console.error('[cloud-boot] initial inbox drain failed', e); return { applied: 0 }; });
                if (result.applied > 0) await afterApply();
            })
            .catch((e) => console.error('[cloud-boot] inbox poller install failed', e));

        // Apple Health import (bd med-w6gx.6): only inside the iOS (or Android,
        // Health Connect: bd med-nt9p.8) app shell,
        // where native/health.js installs the ios impl. On the web isSupported()
        // is false and the module is never even fetched.
        let healthSupported = false;
        try { healthSupported = !!(window.Health && window.Health.isSupported()); } catch { /* stub: native/ not loaded */ }
        if (healthSupported) {
            import('/js/health-import.js')
                .then(({ startHealthImport }) => startHealthImport(ctx))
                .catch((e) => console.error('[cloud-boot] health import failed', e));
        }

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

        // New-device notice (AD11, med-r1j2.6): diff the account's devices
        // against the set this device last saw; a new one toasts once.
        Promise.resolve()
            .then(() => import('/js/devices.js'))
            .then(({ checkNewDevices }) => checkNewDevices())
            .catch((e) => console.error('[cloud-boot] new-device check failed', e));
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
