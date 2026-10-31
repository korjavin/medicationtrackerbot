// ==================== Settings view ====================
// Extracted from app.js (Plan 2026-06-10 "finish-app-js-split", Task 2).
//
// This file owns the Settings tab's view orchestration: the SWR settings-bundle
// load (loadSettings), the feature-toggle write path (toggleFeatureSetting), the
// feature-toggle / food-targets / nav-visibility DOM sync helpers and the Settings
// stale badge mount. These functions remain
// global (script-tag loading) and rely on app.js + sibling globals at call time:
// apiCall, safeAlert, readPersistedTabOrder, switchTab, window.featureSettings,
// window.AuthBootstrap, window.SettingsState, window.WeightUnitState,
// window.FoodLog, window.DataStore,
// window.SettingsIntegrations, window.AppStore, window.rebuildCanonicalBottomNav,
// applyWebpushStatus, hideWebpushStatus (both from app.js).
//
// The Integrations card lives in features/settings/integrations.js — already
// extracted; loadSettings() delegates to it. The weight-unit (kg/lb) state
// machine lives in features/weight-unit-state.js.
//
// Cloud-mode Notifications (bindCloudNotifications) dynamic-imports
// web/cloud/js/push.js + reminders.js and reads window.MedTrackerCloud.ctx
// (published by cloud-boot.js post-unlock) — see docs/cloud-mode.md.
//
// Public surface is mirrored on window.SettingsView for discoverability; the
// bare function names are the live call path used by app.js bindings
// (switchTab/reloadCurrentTab → loadSettings; the feature-toggle change handlers
// → toggleFeatureSetting; loadInitData / auth-bootstrap.js →
// updateFeatureTabVisibility) and by tests.

// Cloud-mode Notifications wiring for the .wg-settings-notifications-cloud
// block, driven by the DOM-free web/cloud/js/push.js + reminders.js
// primitives (dynamic-imported so non-cloud builds never pull in
// cloud-only modules).
// ponytail: no memoization — import() already caches by specifier. These
// functions exist only as the test seam (Vitest overrides the window globals).
// Private lexical predicate, not a window API: reads may finish after either
// one-way reload commitment or document teardown, neither permits a repaint.
const settingsRenderBlocked = (doc = document) => !doc?.documentElement
    || doc.documentElement.hasAttribute('data-provider-reload-committed');

let _cloudNotificationsBound = false; // module-state: one-time guard so the cloud toggle/test click listeners bind once across repeated loadSettings() calls
function loadCloudPushModule() { return import('/js/push.js'); }
function loadCloudRemindersModule() { return import('/js/reminders.js'); }

// The toggle plus the S8 status chip (bd med-ckm5.8). Denied swaps the card
// for O3's warn note (NotifyPermission.renderNote, med-ckm5.4), as in local mode.
async function paintCloudPush(toggleBtn, on) {
    if (settingsRenderBlocked()) return;
    toggleBtn.dataset.subscribed = on ? '1' : '0';
    toggleBtn.textContent = on ? 'Disable' : 'Enable';
    // The button's own document: a refresh can land after the page went away.
    const doc = toggleBtn.ownerDocument;
    const chip = doc?.getElementById('cloud-push-chip');
    if (chip) {
        chip.textContent = on ? 'On' : 'Off';
        chip.classList.toggle('wg-chip--ok', on);
    }
    const np = doc?.defaultView?.NotifyPermission;
    const note = doc?.getElementById('cloud-push-note');
    const card = doc?.getElementById('cloud-push-card');
    if (!np || !note || !card) return;
    try {
        // Undecided: the card's Enable is the one-tap path, so the note is for denied only.
        const denied = (await np.state()) === 'denied';
        if (settingsRenderBlocked()) return;
        if (denied) await np.renderNote(note);
        else note.replaceChildren();
        if (settingsRenderBlocked()) return;
        card.hidden = denied && !!note.firstChild;
        chip?.classList.toggle('wg-chip--warn', denied);
    } catch (e) { /* the card still offers Enable */ }
}

// The app shells' APNs/FCM wake channel (bd med-erq1.3, native/push-token.js):
// "on" once the shell has a device token for the relay to wake. Hidden on the
// web and on a page without the capability.
async function paintNativeWake(doc) {
    if (settingsRenderBlocked(doc)) return;
    const line = doc?.getElementById('cloud-push-wake');
    if (!line) return;
    let on = null;
    try {
        if (window.NativePush?.isSupported?.() === true) on = !!(await window.NativePush.token());
    } catch (e) { /* native/ stub: leave the line hidden */ }
    if (settingsRenderBlocked(doc)) return;
    line.hidden = on === null;
    if (on !== null) line.textContent = on ? 'Wake-ups: on' : 'Wake-ups: off (allow notifications)';
}

// status is passed only on the initial bind. After a deliberate Disable click
// the granted-but-unsubscribed state is exactly what the user asked for, and
// warning about it there would stomp the "Notifications disabled" confirmation.
async function refreshCloudPushToggleState(toggleBtn, status) {
    if (settingsRenderBlocked()) return;
    try {
        if (localNotificationsSupported()) {
            // iOS app shell: "subscribed" is the iOS notification permission.
            const granted = (await window.LocalNotifications.permission()) === 'granted';
            if (settingsRenderBlocked()) return;
            paintCloudPush(toggleBtn, granted);
            await paintNativeWake(toggleBtn.ownerDocument);
            return;
        }
        const { getSubscription } = await loadCloudPushModule();
        if (settingsRenderBlocked()) return;
        const sub = await getSubscription();
        if (settingsRenderBlocked()) return;
        paintCloudPush(toggleBtn, !!sub);
        // Permission granted but no subscription means the push service evicted
        // it and the boot-time repair could not restore it (med-d5t.3). A bare
        // "Enable" button reads like a device that was never set up, so it would
        // quietly imply reminders are fine. They are not — say so.
        if (!sub && status && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            applyWebpushStatus(status, 'Reminders are not armed on this device — tap Enable to restore them.', 'error');
        }
    } catch (e) {
        paintCloudPush(toggleBtn, false);
    }
}

// WebKit/iOS implement the LEGACY callback form of Notification.requestPermission():
// it returns undefined and delivers the result via callback. A plain
// `await Notification.requestPermission()` then yields undefined, which reads as
// "not granted" even after the user taps Allow (med-eas.19). Normalize both
// forms. The requestPermission call runs synchronously inside the Promise
// executor, so calling this as the first await in the click handler preserves
// Safari's transient-activation requirement.
//
// med-1n6: resolve with Notification.permission read AFTER the request settles,
// never with the value the callback/promise handed us — WebKit has been seen
// calling the legacy callback with no argument, and that `undefined` beat the
// promise, so a user who tapped Allow was told they had denied. And skip the
// prompt entirely once the permission is decided: on that path WebKit may settle
// nothing at all, hanging the caller (the "second tap does nothing" half of the
// bug).
//
// Deliberate duplicate of push.js's requestNotificationPermission: settings.js
// must reach requestPermission() synchronously inside the click's transient
// activation, before the dynamic import('/js/push.js') await. Keep the two in
// step — settings.ios-push-permission.test.js pins both to the same behavior.
function requestNotificationPermissionNormalized() {
    if (typeof Notification === 'undefined') return Promise.resolve('denied');
    if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
    // Trust a real permission string; otherwise read the authoritative property.
    // WebKit's no-argument callback lands in the fallback.
    const normalize = (v) => (['granted', 'denied', 'default'].includes(v)
        ? v
        : (typeof Notification === 'undefined' ? 'denied' : Notification.permission));
    return new Promise((resolve) => {
        const settle = (value) => resolve(normalize(value));
        const maybe = Notification.requestPermission(settle);
        if (maybe && typeof maybe.then === 'function') maybe.then(settle, () => settle(undefined));
    });
}

// The iOS app shell schedules reminders on the device (bd med-w6gx.5): the
// toggle asks iOS for permission and the test button posts a local
// notification. False on the web, where every branch below is the Web Push one.
function localNotificationsSupported() {
    // The native/ foundation stub throws until an impl registers.
    try {
        return window.LocalNotifications?.isSupported?.() === true;
    } catch (e) {
        return false;
    }
}

// Device wording comes off the capability (native/local-notifications.js);
// the fallbacks are the iOS copy, so iOS and fixtures without `copy` are unchanged.
function nativeCopy() {
    const c = window.LocalNotifications?.copy;
    return {
        os: c?.os || 'iOS',
        device: c?.device || 'iPhone',
        settingsPath: c?.settingsPath || 'iOS Settings → Med Tracker → Notifications',
    };
}

// Static index.html copy names the device in a [data-device-word] span (iOS default).
function fillDeviceWords() {
    const device = nativeCopy().device;
    document.querySelectorAll('[data-device-word]').forEach((el) => { el.textContent = device; });
}

async function toggleLocalNotifications(toggleBtn, status) {
    if (toggleBtn.dataset.subscribed === '1') {
        // An app cannot revoke its own permission; iOS Settings can.
        applyWebpushStatus(status, `To turn reminders off on this ${nativeCopy().device}, use ${nativeCopy().settingsPath}.`, 'muted');
        return;
    }
    const permission = await window.LocalNotifications.requestPermission();
    if (permission !== 'granted') {
        applyWebpushStatus(status, `Notifications are off for Med Tracker. Turn them on in ${nativeCopy().settingsPath}.`, 'error');
        return;
    }
    const ctx = window.MedTrackerCloud?.ctx;
    if (ctx) {
        const { recomputeAndPush } = await loadCloudRemindersModule();
        // Schedules this device's reminders now; a failed relay upload (offline)
        // does not unschedule them, so it is not this toggle's failure.
        await recomputeAndPush(ctx).catch(() => {});
    }
    applyWebpushStatus(status, 'Notifications enabled', 'success');
}

function bindCloudNotifications() {
    if (settingsRenderBlocked()) return;
    const toggleBtn = document.getElementById('cloud-push-toggle');
    const testBtn = document.getElementById('cloud-push-test-btn');
    const status = document.getElementById('cloud-push-status');
    if (!toggleBtn || !testBtn || !status) return;

    // Disable the controls until the async getSubscription() check resolves —
    // the button defaults to 'Enable' with dataset.subscribed unset, so a click
    // in that window could subscribe while already subscribed or wrongly report
    // "Enable push notifications first."
    toggleBtn.disabled = true;
    testBtn.disabled = true;
    const ready = refreshCloudPushToggleState(toggleBtn, status).finally(() => {
        if (settingsRenderBlocked()) return;
        toggleBtn.disabled = false;
        testBtn.disabled = false;
    });
    if (_cloudNotificationsBound) return ready;
    _cloudNotificationsBound = true;

    toggleBtn.addEventListener('click', async () => {
        toggleBtn.disabled = true;
        try {
            if (localNotificationsSupported()) {
                await toggleLocalNotifications(toggleBtn, status);
            } else if (toggleBtn.dataset.subscribed === '1') {
                const { unsubscribe } = await loadCloudPushModule();
                await unsubscribe();
                applyWebpushStatus(status, 'Notifications disabled', 'muted');
            } else if (typeof Notification === 'undefined') {
                // Non-installed iOS Safari exposes no Notification API — Web Push
                // there requires the app be added to the Home Screen first.
                applyWebpushStatus(status, 'To enable notifications on iOS, add this app to your Home Screen, then reopen it from there.', 'error');
            } else if (Notification.permission === 'denied') {
                applyWebpushStatus(status, 'Notifications are blocked in your browser settings.', 'error');
            } else {
                // Reach requestPermission() synchronously inside the click's
                // transient activation — Safari/iOS drop it across the dynamic
                // import() await below, so requesting here (not only inside push.js
                // subscribe()) keeps first-enable working on iOS. The normalized
                // helper handles WebKit's callback form (med-eas.19). subscribe()
                // re-checks and no-ops when already granted.
                const permission = await requestNotificationPermissionNormalized();
                if (permission === 'denied') {
                    applyWebpushStatus(status, 'Notifications are blocked in your browser settings.', 'error');
                } else if (permission !== 'granted') {
                    // 'default' — the user dismissed the prompt without choosing.
                    applyWebpushStatus(status, 'Notification permission was not granted.', 'error');
                } else {
                    applyWebpushStatus(status, 'Requesting permission...', null);
                    const { subscribe } = await loadCloudPushModule();
                    // Anything thrown from here on is a SUBSCRIPTION failure, not
                    // a permission one — the user granted it a moment ago. The
                    // catch below surfaces subscribe()'s own message, which says
                    // so (med-1n6).
                    await subscribe();
                    applyWebpushStatus(status, 'Notifications enabled', 'success');
                }
            }
        } catch (err) {
            applyWebpushStatus(status, err.message || 'Failed to update notifications', 'error');
        } finally {
            // ALWAYS re-arm the button. Whatever went wrong, the next tap must
            // retry — a user stuck behind a permanently disabled Enable button
            // has no path to reminders at all (med-1n6).
            await refreshCloudPushToggleState(toggleBtn).catch(() => {});
            toggleBtn.disabled = false;
        }
        setTimeout(() => hideWebpushStatus(status), 3000);
    });

    testBtn.addEventListener('click', async () => {
        const ctx = window.MedTrackerCloud?.ctx;
        if (!ctx) {
            applyWebpushStatus(status, 'Unlock the vault before sending a test push.', 'error');
        } else if (toggleBtn.dataset.subscribed !== '1') {
            applyWebpushStatus(status, 'Enable push notifications first.', 'error');
        } else {
            testBtn.disabled = true;
            try {
                if (localNotificationsSupported()) {
                    await window.LocalNotifications.test();
                } else {
                    const { sendTestPush } = await loadCloudRemindersModule();
                    await sendTestPush(ctx);
                }
                applyWebpushStatus(status, 'Test sent to this device.', 'success');
            } catch (err) {
                applyWebpushStatus(status, err.message || 'Failed to send test push', 'error');
            }
            testBtn.disabled = false;
        }
        setTimeout(() => hideWebpushStatus(status), 3000);
    });
    bindCloudReminderDelivery();
    return ready;
}

// Reminder delivery channel + Telegram verbosity (bd med-76c.1). Both live in
// the vault (reminderdeliverypref), so they round-trip through the cloud
// reminders domain rather than an /api route. Changing either re-uploads the
// horizon immediately — the relay holds precomputed entries, so a pref change
// that isn't re-pushed wouldn't take effect until the next mutation.
let _cloudReminderDeliveryBound = false; // module-state: bind the choice groups once across repeated loadSettings() calls
function bindCloudReminderDelivery() {
    if (settingsRenderBlocked()) return;
    const deliveryEl = document.getElementById('cloud-reminder-delivery');
    const verbosityEl = document.getElementById('cloud-reminder-verbosity');
    const status = document.getElementById('cloud-reminder-delivery-status');
    if (!deliveryEl || !verbosityEl || !status) return;

    const ctx = window.MedTrackerCloud?.ctx;
    if (ctx) {
        loadCloudRemindersModule()
            .then(({ remindersDomain }) => settingsRenderBlocked()
                ? null : remindersDomain(ctx).getDeliveryPref())
            .then((pref) => {
                if (settingsRenderBlocked() || !pref) return;
                setChoiceValue(deliveryEl, pref.delivery);
                // The resolved lock-screen value (med-5vy0): a floored Detailed shows as Detailed.
                setChoiceValue(verbosityEl, pref.lockscreen || pref.verbosity);
            })
            .catch(() => { /* leave the HTML defaults (webpush/generic) */ });
    }

    if (_cloudReminderDeliveryBound) return;
    _cloudReminderDeliveryBound = true;

    const save = async () => {
        const cloudCtx = window.MedTrackerCloud?.ctx;
        if (!cloudCtx) {
            applyWebpushStatus(status, 'Unlock the vault to change reminder delivery.', 'error');
            setTimeout(() => hideWebpushStatus(status), 3000);
            return;
        }
        setChoicesDisabled(deliveryEl, true);
        setChoicesDisabled(verbosityEl, true);
        try {
            const { remindersDomain, recomputeAndPush } = await loadCloudRemindersModule();
            const saved = await remindersDomain(cloudCtx).setDeliveryPref({
                delivery: choiceValue(deliveryEl),
                verbosity: choiceValue(verbosityEl),
            });
            // The domain may store less than shown (a floored Detailed turns
            // Generic on a move to Telegram, med-5vy0): show what was stored.
            if (saved) {
                setChoiceValue(deliveryEl, saved.delivery);
                setChoiceValue(verbosityEl, saved.lockscreen || saved.verbosity);
            }
            await recomputeAndPush(cloudCtx);
            applyWebpushStatus(status, 'Reminder delivery updated.', 'success');
        } catch (err) {
            applyWebpushStatus(status, err.message || 'Failed to update reminder delivery', 'error');
        }
        setChoicesDisabled(deliveryEl, false);
        setChoicesDisabled(verbosityEl, false);
        setTimeout(() => hideWebpushStatus(status), 3000);
    };

    bindChoices(deliveryEl, save);
    bindChoices(verbosityEl, save);
}

// A .wg-choices group standing in for a <select> (kit rule 7, bd med-ckm5.8):
// its value is the pressed button's data-value.
function choiceValue(group) {
    return group.querySelector('.wg-choice[aria-pressed="true"]')?.dataset.value;
}

function setChoiceValue(group, value) {
    group.querySelectorAll('.wg-choice').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value)));
}

function setChoicesDisabled(group, disabled) {
    group.querySelectorAll('.wg-choice').forEach((b) => { b.disabled = disabled; });
}

// onChange runs after a tap pressed a different choice.
function bindChoices(group, onChange) {
    group.addEventListener('click', (e) => {
        const btn = e.target.closest('.wg-choice');
        if (!btn || btn.disabled || btn.getAttribute('aria-pressed') === 'true') return;
        setChoiceValue(group, btn.dataset.value);
        onChange();
    });
}

// Cloud-mode "Invite a friend": POST /api/invite mints a subdomain + claim
// token for someone else and returns the claim URL. Plain fetch(), not
// apiCall() — the cloud apiCall shim only knows the domain-backed /api/* routes
// and 404s anything else; this one is a real server call on the account
// subdomain. Same test seam as the notification modules: a bare global fn.
let _inviteBound = false; // module-state: one-time guard so the invite click listeners bind once across repeated loadSettings() calls
let _rerunOnboardingBound = false; // module-state: same one-time guard for the "Re-run onboarding" row
function loadQrcodeModule() { return import('/vendor/qrcode.mjs'); }

function inviteToast(message) {
    if (window.SyncManager && typeof window.SyncManager.showToast === 'function') {
        window.SyncManager.showToast(message, 'info');
    } else {
        safeAlert(message);
    }
}

async function showInviteModal(claimUrl) {
    const modal = document.getElementById('invite-modal');
    const urlEl = document.getElementById('invite-claim-url');
    const qrEl = document.getElementById('invite-qr');
    if (!modal || !urlEl || !qrEl) throw new Error('Could not show the invite.');
    urlEl.textContent = claimUrl;
    qrEl.replaceChildren();
    try {
        const { qrcode } = await loadQrcodeModule();
        const qr = qrcode(0, 'M');
        qr.addData(claimUrl);
        qr.make();
        qrEl.innerHTML = qr.createSvgTag(4);
    } catch (e) {
        // The QR is a convenience; the copyable URL is the actual payload.
        console.warn('invite QR render failed', e);
    }
    // The invite row lives on the pushed Devices page, a WGPage appended to
    // <body> at the same z-index as this sheet, so DOM order decides: left in
    // place the sheet opened behind the page and the tap looked dead
    // (med-nyjw). Last in the body puts it on top, like workoutEquipment.
    document.body.appendChild(modal);
    // On the ModalManager stack (overlay + Back/Esc), like every sheet.
    window.ModalManager.open('invite-modal');
}

async function mintInvite() {
    const btn = document.getElementById('settings-invite-btn');
    if (btn) btn.disabled = true;
    try {
        // Online-only: minting an invite is server-side account provisioning
        // with no local vault semantics, so this stays a raw fetch (not apiCall —
        // cloud's shim has no /api/invite route). Offline the fetch throws and is
        // caught below → inviteToast, which is the correct degraded UX; there is
        // nothing meaningful to queue optimistically. (med-gvk.4)
        const res = await fetch('/api/invite', { method: 'POST' });
        if (res.status === 429) {
            inviteToast('Monthly invite limit reached — try again later.');
            return;
        }
        if (!res.ok) throw new Error('Could not create an invite.');
        const payload = await res.json();
        await showInviteModal(payload.claim_url);
    } catch (e) {
        inviteToast(e.message || 'Could not create an invite.');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// Second-device safety nudge (med-4pz.4). A single-device account can only be
// opened from that one device: lose it without the Emergency Kit and the vault
// is gone. Enrollment already exists (Devices & connectors → Add a device), but nothing
// prompted a single-device user toward it. This is a dismissible card, not a
// mandatory step — with the kit properly saved (med-d5t.2) a second device is
// defence in depth, hence a gentle nudge rather than a gate.
//
// Shown only while the account has exactly one device; once a second is added
// the condition is false forever, so the card self-retires. Dismissal is a
// per-account localStorage flag — a per-device UI preference, never vault data.
let _secondDeviceNudgeBound = false; // module-state: one-time guard so the nudge dismiss listener binds once across repeated loadSettings() calls

function secondDeviceNudgeDismissKey() {
    const accountId = window.MedTrackerCloud?.ctx?.accountId || 'unknown';
    return `secondDeviceNudgeDismissed:${accountId}`;
}

// Raw fetch, not apiCall: /api/devices is a real server route (credential
// state), and in cloud mode apiCall routes /api/* through the domain shim,
// which has no such route. devices.js / transfer.js fetch it the same way.
//
// Memoized for the page's lifetime (med-0ol.6): loadSettings() re-runs on every
// tab repaint, and a cloud write repaints the open tab. A bulk .nxk import fires
// hundreds of writes, so an un-memoized fetch here fanned a single import out
// into thousands of /api/devices requests. The count only changes from the
// Devices page, whose list load hands the fresh count back (noteDeviceList).
let _deviceCountPromise = null; // module-state: memoize the /api/devices fetch for the page's lifetime so a repaint storm can't fan it out (med-0ol.6)
function fetchDeviceCount() {
    if (!_deviceCountPromise) {
        _deviceCountPromise = (async () => {
            try {
                const res = await fetch('/api/devices');
                if (!res.ok) return null;
                const devices = await res.json();
                return Array.isArray(devices) ? devices.length : null;
            } catch {
                return null;
            }
        })();
    }
    return _deviceCountPromise;
}

async function bindSecondDeviceNudge() {
    if (settingsRenderBlocked()) return;
    const nudge = document.getElementById('second-device-nudge');
    if (!nudge) return;

    if (!_secondDeviceNudgeBound) {
        _secondDeviceNudgeBound = true;
        document.getElementById('second-device-nudge-dismiss')?.addEventListener('click', () => {
            try { localStorage.setItem(secondDeviceNudgeDismissKey(), '1'); } catch { /* private mode */ }
            nudge.classList.add('wg-settings-hidden');
        });
    }

    let dismissed = false;
    try { dismissed = localStorage.getItem(secondDeviceNudgeDismissKey()) === '1'; } catch { /* private mode */ }
    if (dismissed) {
        nudge.classList.add('wg-settings-hidden');
        return;
    }

    // Reveal only on a confirmed single-device count. A failed fetch leaves the
    // card hidden rather than nagging on incomplete information.
    const count = await fetchDeviceCount();
    if (settingsRenderBlocked()) return;
    nudge.classList.toggle('wg-settings-hidden', count !== 1);
}

// ---- Devices & connectors page (med-xso6.25, kit S4–S5) --------------------
// The cloud modules render into the page (same origin, /js/*.js); this is only
// the bridge. Each open re-renders the list, so it is never stale. The modules
// are dynamic-imported through these seams so a test can swap them.
// ponytail: no memoization — import() caches by specifier.
function loadCloudDevicesModule() { return import('/js/devices.js'); }
function loadCloudTransferModule() { return import('/js/transfer.js'); }
function loadCloudConnectorsModule() { return import('/js/connectors.js'); }

// The Emergency Kit rotation is a full-document ceremony (fresh passkey
// assertion + the Emergency Kit page, bd med-ckm5.2) and stays on the passkey shell;
// it returns here when done. Fixed same-origin path.
const EMERGENCY_KIT_URL = '/devices?flow=emergency-kit';

const CONNECTOR_STATUS_TEXT = {
    remote: 'Connected',
    local: 'Local shim',
    none: 'Not connected',
};

function cloudCtx() {
    return window.__MEDTRACKER_CLOUD__ ? window.MedTrackerCloud?.ctx || null : null;
}

// The list load already fetched /api/devices; reuse it for the home-row
// summary and the nudge instead of a second request.
function noteDeviceList(devices) {
    if (settingsRenderBlocked()) return;
    _deviceCountPromise = Promise.resolve(devices.length);
    refreshDevicesSummary();
    bindSecondDeviceNudge();
}

async function mountCloudDevices() {
    if (settingsRenderBlocked()) return;
    const ctx = cloudCtx();
    const mount = document.getElementById('settings-devices-mount');
    if (!ctx || !mount) return;
    try {
        const { renderDeviceList } = await loadCloudDevicesModule();
        if (settingsRenderBlocked()) return;
        renderDeviceList(mount, ctx, { onAddDevice: () => openAddDevicePage(), onLoaded: noteDeviceList });
    } catch (e) {
        if (settingsRenderBlocked()) return;
        console.error('devices module failed to load', e);
        mount.textContent = 'Could not load your devices. Check your connection and reopen this page.';
    }
    refreshConnectorStatus(ctx);
}

async function refreshConnectorStatus(ctx) {
    if (settingsRenderBlocked()) return;
    const el = document.getElementById('settings-claude-connector-status');
    if (!el) return;
    try {
        const { claudeConnectorMode } = await loadCloudConnectorsModule();
        if (settingsRenderBlocked()) return;
        const mode = await claudeConnectorMode(ctx);
        if (settingsRenderBlocked()) return;
        el.textContent = CONNECTOR_STATUS_TEXT[mode] || '';
    } catch (_) { /* keep the static description */ }
}

// "Add a device" pushes its own page. Back runs the flow's server-side cancel
// and refuses to leave if that fails: leaving would imply a live code is dead.
async function openAddDevicePage(opts) {
    if (settingsRenderBlocked()) return;
    const ctx = cloudCtx();
    if (!ctx || !window.WGPage) return;
    const { renderAddDevice } = await loadCloudTransferModule();
    if (settingsRenderBlocked()) return;
    const body = document.createElement('div');
    body.className = 'wg-vstack';
    let page = null;
    const flow = renderAddDevice(body, ctx, () => page && page.close(), opts);
    page = window.WGPage.push({
        title: 'Add a device',
        back: 'Devices',
        body,
        onBack: () => flow.cancel(),
        onClose: () => {
            flow.stop();
            mountCloudDevices();
        },
    });
}

async function openConnectorPage() {
    if (settingsRenderBlocked()) return;
    const ctx = cloudCtx();
    if (!ctx || !window.WGPage) return;
    const { renderConnectors } = await loadCloudConnectorsModule();
    if (settingsRenderBlocked()) return;
    const body = document.createElement('div');
    body.className = 'wg-vstack';
    renderConnectors(body, ctx);
    window.WGPage.push({
        title: 'Claude connector',
        back: 'Devices',
        body,
        onClose: () => refreshConnectorStatus(ctx),
    });
}

// Kit S6 mode card, cloud (bd med-ckm5.6): "Your vault" · <host> · synced
// HH:MM, off the sync engine's local status; left out when it cannot be read.
// The device count lives on the Devices & connectors row (SC1, bd med-y7b4.1).
// Tapping it opens Account & privacy (data-settings-open, bindSettingsPages).
// Repainted on every Settings open.
function loadCloudSyncModule() { return import('/js/sync.js'); }
async function paintVaultCard() {
    if (settingsRenderBlocked()) return;
    const card = document.getElementById('settings-vault-card');
    const meta = document.getElementById('settings-vault-meta');
    if (!card || !meta) return;
    card.classList.remove('wg-settings-hidden');
    const parts = [window.location.hostname];
    try {
        const { getSyncStatus } = await loadCloudSyncModule();
        if (settingsRenderBlocked()) return;
        const { lastSyncedAt } = await getSyncStatus(cloudCtx());
        if (settingsRenderBlocked()) return;
        if (lastSyncedAt) {
            parts.push(`synced ${new Date(lastSyncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
        }
    } catch { /* no sync status: leave it out */ }
    if (settingsRenderBlocked()) return;
    meta.textContent = parts.join(' · ');
}

// Kit chip on the vault card (SC1; bd med-ckm5.6, epic decision 4): shown while
// the synced emergencykit record says the current kit was never saved (no
// record, or a new code nobody confirmed saving: how 'none'). A failed read
// hides it rather than nag on a guess — hence apiCallDirect, which throws where
// apiCall would hand back the same null as "no record". The same read places
// the S9 Emergency Kit row (bd med-ckm5.9).
async function paintKitState() {
    if (settingsRenderBlocked()) return;
    let unsaved = false;
    try {
        const kit = await window.apiCallDirect('/api/settings/emergency-kit', 'GET');
        unsaved = !kit || kit.how === 'none';
    } catch { /* keep it hidden */ }
    if (settingsRenderBlocked()) return;
    document.getElementById('settings-kit-chip')?.classList.toggle('wg-settings-hidden', !unsaved);
    placeAccountKitRow(unsaved);
}

// Kit S9: while the kit is unsaved the Emergency Kit row leads the Account &
// privacy page, boxed, with a Save chip; once saved it is the last plain row
// of the Account list.
function placeAccountKitRow(unsaved) {
    const row = document.getElementById('settings-account-kit-row');
    const list = document.getElementById('settings-account-list');
    const page = row?.closest('[data-settings-page]');
    if (!row || !list || !page) return;
    row.classList.toggle('wg-setting--boxed', unsaved);
    document.getElementById('settings-account-kit-save')?.classList.toggle('wg-settings-hidden', !unsaved);
    const desc = document.getElementById('settings-account-kit-desc');
    if (desc) desc.textContent = unsaved ? 'Not downloaded on any device yet' : 'Regenerate if you lost the printed copy';
    if (unsaved) page.prepend(row);
    else list.appendChild(row);
}

let _cloudDevicesBound = false; // module-state: bind the Devices page rows once across repeated loadSettings() calls
function bindCloudDevicesPage() {
    if (_cloudDevicesBound) return;
    _cloudDevicesBound = true;
    document.getElementById('settings-claude-connector-row')?.addEventListener('click', openConnectorPage);
    // Devices (S4) and Account & privacy (S9) both open the kit ceremony.
    for (const id of ['settings-emergency-kit-row', 'settings-account-kit-row']) {
        document.getElementById(id)?.addEventListener('click', () => {
            window.location.assign(EMERGENCY_KIT_URL);
        });
    }
}

// ?tab=settings&page=devices|connectors (deeplink-router.js; the old shell
// pages /devices and /connectors redirect here).
function openDevicesDeeplink(target) {
    if (target === 'add-device') {
        resumeAddDevice();
        return;
    }
    if (!cloudCtx() || !openSettingsPage('devices')) return;
    if (target === 'connectors') openConnectorPage();
}

// The "Approve the new device?" tap (med-r1j2.9, AD3). The flow's secrets live
// only in the page that made the code, so a live flow in this window is brought
// back (it polls now and shows Approve with the match code); with none here —
// another device made the code, or the page was closed, which deleted the slot —
// open Add a device on its AD4 "not open here" end state.
async function resumeAddDevice() {
    if (settingsRenderBlocked()) return;
    if (!cloudCtx()) return;
    const { resumeLiveTransfer } = await loadCloudTransferModule();
    if (settingsRenderBlocked()) return;
    if (resumeLiveTransfer()) return;
    openSettingsPage('devices');
    openAddDevicePage({ notHere: true });
}

// "What can the operator see?" transparency section (med-d5t.9). The content
// lives in web/cloud/js/privacy.js (cloud-only) and is dynamic-imported here,
// the same seam Settings uses for the cloud push/reminders modules — so a test
// overrides window.loadPrivacyModule instead of resolving a real import.
// ponytail: no memoization — import() caches by specifier. This is only the
// test seam.
function loadPrivacyModule() { return import('/js/privacy.js'); }

// The account's zone row (bd med-wi09.19, copy: Miles, Zulip 5887/5890).
// Read-only: the one way to change the zone today is the launch prompt
// (bootstrap.js maybeUpdateTimezone). 'floor' = derived automatically;
// 'device' = nothing stored yet (local mode, or before the first pull).
const TZ_SOURCE_COPY = {
    pinned: 'Doses and reminders follow this zone on every device.',
    floor: 'Set automatically. Doses and reminders follow it on every device.',
    device: 'Set from this device. Doses and reminders follow it.',
};
function paintAccountTimeZone(timezone, source) {
    const row = document.getElementById('settings-account-tz-row');
    // A bundle without a zone (a failed /api/settings read) keeps what shows.
    if (!row || !timezone) return;
    row.classList.remove('wg-settings-hidden');
    document.getElementById('settings-account-tz').textContent = timezone;
    document.getElementById('settings-account-tz-desc').textContent = TZ_SOURCE_COPY[source] || TZ_SOURCE_COPY.pinned;
}

let _operatorVisibilityRendered = false; // module-state: render the static content once across repeated loadSettings() calls

async function bindOperatorVisibility() {
    if (settingsRenderBlocked()) return;
    const section = document.querySelector('.wg-settings-privacy');
    const mount = document.getElementById('privacy-content');
    if (!section || !mount) return;
    section.classList.remove('wg-settings-hidden');
    const host = document.getElementById('settings-account-host');
    if (host) host.textContent = window.location.hostname;
    if (_operatorVisibilityRendered) return;
    try {
        const { renderPrivacyInto } = await loadPrivacyModule();
        if (settingsRenderBlocked()) return;
        // Pass document explicitly: privacy.js is a cloud-only module that may be
        // evaluated in a context without a global `document` (the test seam).
        renderPrivacyInto(mount, document);
        _operatorVisibilityRendered = true;
    } catch (e) {
        // Transparency that fails to render must not break Settings; leave the
        // section's own description standing.
        console.error('[settings] operator-visibility render failed', e);
    }
}

// Self-service account deletion (med-d5t.8). The flow logic lives in the
// cloud-only web/cloud/js/account-delete.js, dynamic-imported the same way the
// other cloud modules are (so a test overrides window.loadAccountDeleteModule).
// ponytail: no memoization — import() caches by specifier.
function loadAccountDeleteModule() { return import('/js/account-delete.js'); }

let _deleteAccountBound = false; // module-state: bind the delete modal's listeners once across repeated loadSettings() calls

function bindDeleteAccount() {
    const section = document.querySelector('.wg-settings-danger');
    if (!section) return;
    section.classList.remove('wg-settings-hidden');
    if (_deleteAccountBound) return;
    _deleteAccountBound = true;

    const openBtn = document.getElementById('delete-account-open');
    const errorEl = document.getElementById('delete-account-error');
    if (!openBtn) return;
    // Kit .wg-error (danger text); empty, it takes no space (.wg-page .wg-error:empty).
    const showError = (text) => { if (errorEl) errorEl.textContent = text; };

    // Hoisted across clicks: once the server delete succeeds, the account (and
    // its session) is gone — a retry after a blocked local wipe must skip the
    // re-auth ceremony (it would 401) and go straight back to the wipe.
    let serverDeleted = false;
    openBtn.addEventListener('click', async () => {
        showError('');
        let mod;
        try {
            mod = await loadAccountDeleteModule();
        } catch (err) {
            showError(err.message || 'Could not delete the account.');
            return;
        }
        // The typed-confirmation gate (shared safeConfirm dialog, kit rule 3):
        // the delete stays disabled until the exact phrase is entered. One
        // tap must never erase a vault. Past the server delete there is
        // nothing left to confirm — only the local wipe to retry.
        if (!serverDeleted) {
            // D1 (med-ckm5.5): what goes, what stays, typed DELETE.
            // The link cancels this dialog and opens Backup & import (S9).
            const ok = await window.safeConfirm(
                'if you might want your records later.',
                null,
                {
                    title: 'Delete your account?',
                    icon: 'trash',
                    destructive: true,
                    typedConfirm: mod.DELETE_CONFIRM_PHRASE,
                    confirmLabel: 'Delete account',
                    link: { label: 'Export a backup first', onClick: () => openSettingsPage('backup') },
                    facts: [
                        { text: `Your vault on ${window.location.hostname}, for every device`, gone: true },
                        { text: 'Connectors and the Telegram link', gone: true },
                        { text: nativeLeaveAccount() ? `This ${nativeCopy().device} returns to the start screen` : 'This browser goes back to the start page' },
                    ],
                },
            );
            if (!ok) return;
        }
        openBtn.disabled = true;
        try {
            if (!serverDeleted) {
                // Wipe BEFORE the server delete: once the account is gone its
                // subdomain serves 404s, so a wipe blocked here and then
                // abandoned (tab reloaded/closed) would strand plaintext
                // IndexedDB data with no code left to erase it. Failing
                // pre-delete is always safe — the account is intact and the
                // cloud copy is authoritative, so an erased mirror re-syncs if
                // the user aborts at the passkey prompt.
                await mod.clearLocalVault();
                await mod.reauthAndDelete();
                serverDeleted = true;
            }
            // Wipe again after the server delete: the page kept running through
            // the passkey ceremony, so background sync/reads may have re-created
            // the databases. This is the load-bearing verified erase.
            await mod.clearLocalVault();
            // The subdomain is gone; send the user somewhere that still exists.
            // In the iOS/Android app that is its own first-run (bd med-o7zq.33,
            // med-nt9p.32.15): the base-domain page has no way back into the app. A shell without
            // the account.leave op rejects, so fall back to the redirect.
            const leave = nativeLeaveAccount();
            if (leave) {
                try { await leave(); return; } catch (e) {
                    console.warn('[settings] account.leave after delete failed', e);
                }
            }
            window.location.href = mod.baseDomainURL();
        } catch (err) {
            // Past the server delete, only the local wipe can fail — be honest
            // that the account is gone but this device isn't clean yet, and
            // that this tab is the last thing able to finish the wipe.
            const msg = err.message || 'Could not delete the account.';
            showError(serverDeleted
                ? `Your account was deleted, but this device's local copy could not be erased. ${msg} Keep this tab open and tap Delete account again — once this tab closes, the app can no longer wipe this device.`
                : msg);
            openBtn.disabled = false;
        }
    });
}

// The app shell's way back to its native first-run (bd med-o7zq.32/.33,
// Android bd med-nt9p.32.15): CloudVault.leaveAccount (cloud-boot.js) → bridge
// op account.leave → the shell's Switch account. A shell older than the op
// rejects it; on the web this is null.
function nativeLeaveAccount() {
    const vault = window.CloudVault;
    if (typeof vault?.leaveAccount !== 'function') return null;
    const platform = window.LocalNotifications?.__native?.platform;
    if (platform !== 'ios' && platform !== 'android') return null;
    return (opts) => vault.leaveAccount(opts);
}

// Does this shell answer `op`? The Android shell lists its ops (bridge op
// shell.ops, bd med-nt9p.32.13); an older shell rejects the probe, which reads
// as "no". One probe per page.
let _shellOps = null; // module-state: the memoised shell.ops promise
function nativeHas(op) {
    const native = window.LocalNotifications?.__native;
    if (typeof native?.call !== 'function') return Promise.resolve(false);
    if (!_shellOps) _shellOps = Promise.resolve().then(() => native.call('shell.ops')).then((ops) => (Array.isArray(ops) ? ops : []), () => []);
    return _shellOps.then((ops) => ops.includes(op));
}

// Settings home slot ② "Use this iPhone/phone without an account" (bd med-o7zq.32;
// moved out of Account & privacy by med-y7b4.2), shown only while signed in:
// straight into local mode (bd med-o7zq.34; a shell older than that ignores
// `then` and shows its first-run instead). Nothing is erased: the account
// stays on the server, this origin keeps its data, and opening the account
// address again resumes it. On Android the row waits for shell.ops to list
// account.leave, so a shell without the op never shows it.
let _leaveAccountBound = false; // module-state: bind the button once across repeated loadSettings() calls
function bindLeaveAccount() {
    const leave = nativeLeaveAccount();
    if (!leave || document.documentElement.classList.contains('wg-local-vault')) return;
    if (window.LocalNotifications.__native.platform === 'android') {
        nativeHas('account.leave').then((has) => { if (has) showLeaveAccount(leave); });
        return;
    }
    showLeaveAccount(leave);
}

function showLeaveAccount(leave) {
    if (settingsRenderBlocked()) return;
    fillDeviceWords(); // the row may show before loadSettings' own fill (Android: after the probe)
    document.querySelector('.wg-settings-leave-account')?.classList.remove('wg-settings-hidden');
    const btn = document.getElementById('settings-leave-account-btn');
    if (!btn || _leaveAccountBound) return;
    _leaveAccountBound = true;
    btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        try {
            const device = nativeCopy().device;
            // bd med-o7zq.36: a shell with leave.stash carries a copy of the
            // vault into local mode; an older one starts it empty.
            const stash = await nativeHas('leave.stash');
            // D1 (med-ckm5.5): warn tone, what stays and what stops. Nothing is
            // destroyed, so Leave is a raised button, not clay (kit S9).
            const ok = await safeConfirm(
                '',
                null,
                {
                    title: `Use this ${device} without an account?`, icon: 'device', tone: 'warn', confirmLabel: 'Leave',
                    facts: [
                        stash
                            ? { text: `A copy of your records stays on this ${device}` }
                            : { text: `This ${device} starts empty: restore a backup file to bring your records`, gone: true },
                        { text: `Your account stays on ${window.location.hostname}` },
                        { text: `This ${device} stops syncing with your other devices`, gone: true },
                    ],
                },
            );
            if (!ok) return;
            if (stash) {
                try {
                    const vault = await window.CloudVault.exportAll({ includeSecrets: true });
                    await window.LocalNotifications.__native.call('leave.stash', { vault });
                } catch (e) {
                    // Never leave silently without the records.
                    const go = await safeConfirm(
                        `Your records could not be carried over (${e?.message || e}). Continue without them? Your account keeps them; a backup file can bring them here later.`,
                        null,
                        { title: 'Records not carried over', icon: 'alert', tone: 'warn', confirmLabel: 'Continue' },
                    );
                    if (!go) return;
                }
            }
            await leave({ then: 'local' });
        } catch (e) {
            await safeAlert(e?.message || 'Couldn’t leave the account.');
        } finally {
            btn.disabled = false;
        }
    });
}

function bindCloudInvite() {
    document.querySelector('.wg-settings-cloud-invite')?.classList.remove('wg-settings-hidden');
    if (_inviteBound) return;
    _inviteBound = true;
    document.getElementById('settings-invite-btn')?.addEventListener('click', mintInvite);
    document.getElementById('invite-close-btn')?.addEventListener('click', () => {
        window.ModalManager.close('invite-modal');
    });
    document.getElementById('invite-copy-btn')?.addEventListener('click', async () => {
        const url = document.getElementById('invite-claim-url')?.textContent || '';
        try {
            await navigator.clipboard.writeText(url);
            inviteToast('Invite link copied.');
        } catch (e) {
            inviteToast('Copy failed — select the link and copy it manually.');
        }
    });
}

// Re-open the first-run overlay on demand (med-4pz.6).
//
// This deliberately does NOT reset the vault's `first_run_complete` flag.
// That singleton is write-once by design (web/domain/settings.js setFirstRunComplete
// only ever writes `true`) so a stale last-writer-wins device can't un-complete
// onboarding for every other device. Re-running is therefore a purely local
// re-mount: pass `needs_first_run` straight to WGFirstRun.mount(), which reads
// the payload before consulting the bootstrap mirror. Finishing the flow again
// re-POSTs /api/firstrun/complete, which is idempotent.
//
// state.clear() first: a leftover sessionStorage step from an earlier flow would
// otherwise resume the overlay mid-wizard (or straight at "done") instead of
// starting over at "welcome".
function bindRerunOnboarding() {
    if (_rerunOnboardingBound) return;
    const btn = document.getElementById('settings-rerun-onboarding');
    if (!btn) return;
    _rerunOnboardingBound = true;
    btn.addEventListener('click', () => {
        const firstRun = window.WGFirstRun;
        if (!firstRun || typeof firstRun.mount !== 'function') return;
        if (firstRun.state && typeof firstRun.state.clear === 'function') firstRun.state.clear();
        firstRun.mount({ needs_first_run: true });
    });
}

// Local-only mode's lock-screen reminder text (bd med-o7zq.3): the
// verbosity half of the vault's reminder delivery pref, through the shim
// (GET/PUT /api/settings/reminder-delivery), which reschedules on a change.
// The choice pair is its own optimistic state; a failed save puts it back.
// The .wg-notif preview mirrors what reminders.js schedules for a dose.
let _localReminderTextBound = false; // module-state: bind the choice pair once across repeated loadSettings() calls
function setLocalReminderText(group, value) {
    if (settingsRenderBlocked()) return;
    setChoiceValue(group, value);
    const preview = document.getElementById('local-reminder-preview');
    if (preview) preview.textContent = value === 'detailed' ? 'Time to take: Metformin' : 'Medication time';
}

async function bindLocalReminderText() {
    if (settingsRenderBlocked()) return;
    const group = document.getElementById('local-reminder-verbosity');
    if (!group) return;
    const pref = await apiCall('/api/settings/reminder-delivery', 'GET');
    if (settingsRenderBlocked()) return;
    setLocalReminderText(group, (pref && pref.verbosity) || choiceValue(group));
    group.dataset.saved = choiceValue(group);
    if (_localReminderTextBound) return;
    _localReminderTextBound = true;
    bindChoices(group, async () => {
        setLocalReminderText(group, choiceValue(group));
        setChoicesDisabled(group, true);
        const res = await apiCall('/api/settings/reminder-delivery', 'PUT', { verbosity: choiceValue(group) });
        if (res && res.verbosity) group.dataset.saved = res.verbosity;
        setLocalReminderText(group, group.dataset.saved);
        setChoicesDisabled(group, false);
    });
}

// Local-only mode's notification permission (bd med-o7zq.9): local-policy.js
// hands the device's reminders to the iOS scheduler, which drops them all
// until the user allows notifications, so the page says which state it is in
// and asks. Once allowed, the schedule is rebuilt right away
// (local-policy.js RESCHEDULE_EVENT); coming back from iOS Settings refreshes
// the state.
let _localNotificationsBound = false; // module-state: bind the buttons once across repeated loadSettings() calls
async function refreshLocalNotifyState() {
    if (settingsRenderBlocked()) return;
    const state = document.getElementById('local-notify-state');
    const enable = document.getElementById('local-notify-enable');
    const test = document.getElementById('local-notify-test');
    // Kit S8 (bd med-ckm5.8): a status chip; denied swaps the card for O3's
    // warn note (NotifyPermission.renderNote), the one sun on the page.
    const chip = document.getElementById('local-notify-chip');
    const note = document.getElementById('local-notify-note');
    const card = document.getElementById('local-notify-card');
    if (!state || !enable || !test) return;
    let permission = 'unsupported';
    if (localNotificationsSupported()) {
        try {
            permission = await window.LocalNotifications.permission();
        } catch (e) {
            permission = 'unknown';
        }
    }
    if (settingsRenderBlocked()) return;
    enable.hidden = permission !== 'default';
    test.hidden = permission !== 'granted';
    const [text, tone] = localNotifyText(permission, window.CloudVault?.lastReminderSchedule?.() || null);
    state.textContent = text;
    if (chip) {
        chip.textContent = tone === 'success' ? 'On' : 'Off';
        chip.classList.toggle('wg-chip--ok', tone === 'success');
        chip.classList.toggle('wg-chip--warn', tone === 'error');
    }
    try {
        // Undecided: Enable above is the one-tap path, so the note is for denied only.
        if (permission === 'denied') await state.ownerDocument?.defaultView?.NotifyPermission?.renderNote(note);
        else note?.replaceChildren();
    } catch (e) { /* the card still says what is wrong */ }
    if (settingsRenderBlocked()) return;
    if (card) card.hidden = permission === 'denied' && !!note?.firstChild;
}

// "On" needs both the iOS permission and a device schedule that took
// (local-policy.js lastReminderSchedule: { ok, items, scheduled } or
// { ok: false, error }). Returns [text, tone].
function localNotifyText(permission, last) {
    const retry = 'Reopen the app to try again.';
    if (permission === 'granted') {
        if (!last) return ['Notifications are allowed. Scheduling reminders…', null];
        if (!last.ok) return [`Reminders couldn't be scheduled: ${last.error}. ${retry}`, 'error'];
        if (last.items > 0 && !(last.scheduled > 0)) {
            return [`Reminders couldn't be scheduled: ${nativeCopy().os} accepted none of them. ${retry}`, 'error'];
        }
        return [`Reminders are on for this ${nativeCopy().device}.`, 'success'];
    }
    if (permission === 'denied') {
        return [`Reminders are off: notifications are blocked for Med Tracker. Turn them on in ${nativeCopy().settingsPath}.`, 'error'];
    }
    if (permission === 'default') return ['Reminders are off until you allow notifications.', null];
    if (permission === 'unsupported') return [`Reminders need the Med Tracker ${nativeCopy().device} app.`, null];
    return [`Could not read the notification permission. ${retry}`, 'error'];
}

async function bindLocalNotifications() {
    if (settingsRenderBlocked()) return;
    const enable = document.getElementById('local-notify-enable');
    const test = document.getElementById('local-notify-test');
    const state = document.getElementById('local-notify-state');
    if (!enable || !test || !state) return;
    if (!_localNotificationsBound) {
        _localNotificationsBound = true;
        enable.addEventListener('click', async () => {
            enable.disabled = true;
            try {
                const permission = await window.LocalNotifications.requestPermission();
                if (permission === 'granted') document.dispatchEvent(new CustomEvent('wg:local-reminders-reschedule'));
            } catch (e) {
                console.error('[settings] notification permission request failed', e);
            }
            enable.disabled = false;
            await refreshLocalNotifyState();
        });
        test.addEventListener('click', async () => {
            test.disabled = true;
            try {
                await window.LocalNotifications.test();
                state.textContent = 'Test sent. It shows in a moment.';
            } catch (e) {
                state.textContent = e.message || 'The test notification could not be sent.';
            }
            test.disabled = false;
        });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') refreshLocalNotifyState();
        });
        // local-policy.js SCHEDULED_EVENT: every device schedule attempt.
        document.addEventListener('wg:local-reminders-scheduled', () => { refreshLocalNotifyState(); });
    }
    await refreshLocalNotifyState();
}

// Local-only mode's destructive reset (bd med-o7zq.9): window.CloudVault is
// local-policy.js LOCAL_VAULT, whose eraseDevice wipes only this origin and
// reloads the empty app. A failure stays on screen: nothing claims "erased".
let _localEraseBound = false; // module-state: bind the button once across repeated loadSettings() calls
function bindLocalErase() {
    const btn = document.getElementById('importexport-local-erase-btn');
    const errorEl = document.getElementById('importexport-local-erase-error');
    if (!btn || !errorEl || _localEraseBound) return;
    _localEraseBound = true;
    btn.addEventListener('click', async () => {
        const device = nativeCopy().device;
        const ok = await safeConfirm(
            '',
            null,
            {
                title: `Erase data on this ${device}?`, icon: 'trash', confirmLabel: 'Erase', destructive: true, typedConfirm: 'ERASE',
                facts: [
                    { text: `All records, settings and keys on this ${device}`, gone: true },
                    // bd med-egb3: eraseDevice asks our server to delete it first.
                    { text: `This ${device}'s anonymous install record on the server (a phone restored from this one's backup loses its remaining trial too)`, gone: true },
                    { text: `The anonymous trial pass, kept in the ${device}'s secure storage so a trial isn't lost` },
                    { text: 'Backup files you exported stay where you saved them' },
                ],
            },
        );
        if (!ok) return;
        btn.disabled = true;
        errorEl.hidden = true;
        try {
            // { erased: false }: the server record could not be deleted and
            // the user kept everything (local-policy.js eraseDevice).
            const res = await window.CloudVault.eraseDevice();
            if (res && res.erased === false) btn.disabled = false;
        } catch (e) {
            errorEl.textContent = `The erase did not finish: ${e.message || 'the data could not be deleted.'} Try again.`;
            errorEl.hidden = false;
            btn.disabled = false;
        }
    });
}

// W5 slot-① card, local mode (bd med-ta2n.5): "Sync & backup", its chip off
// GET /api/protection/status (the W4 status, bd med-ta2n.4). lastBackupAt (a
// confirmed Share) → "Backed up · …"; else lastSavedAt (Save to device, whose
// picker never reports a cancel) → a neutral "Saved · …", so a Save-only user
// (Android WebView has no file Share) is not told "Unprotected" forever; else
// "Unprotected". No status (a failed read) hides the chip rather than guess.
// Repainted on every Settings open and when the page closes.
function daysAgo(at) {
    const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86400000);
    return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

function paintSyncChip(status) {
    if (settingsRenderBlocked()) return;
    const chip = document.getElementById('settings-sync-chip');
    const meta = document.getElementById('settings-sync-meta');
    if (!chip || !meta) return;
    const s = status && typeof status === 'object' ? status : null;
    const where = `only on this ${nativeCopy().device}`;
    const n = Number.isFinite(s?.records) ? s.records : null;
    meta.textContent = n == null ? where : `${n === 1 ? '1 record' : `${n} records`} · ${where}`;
    chip.classList.toggle('wg-settings-hidden', !s);
    if (!s) return;
    const tone = s.lastBackupAt ? 'ok' : s.lastSavedAt ? null : 'warn';
    chip.textContent = s.lastBackupAt ? `Backed up · ${daysAgo(s.lastBackupAt)}`
        : s.lastSavedAt ? `Saved · ${daysAgo(s.lastSavedAt)}` : 'Unprotected';
    chip.classList.toggle('wg-chip--ok', tone === 'ok');
    chip.classList.toggle('wg-chip--warn', tone === 'warn');
}

// The same cache entry the Today W4 card reads (protection_status).
function paintSyncCard() {
    if (settingsRenderBlocked()) return;
    const fetcher = () => settingsRenderBlocked()
        ? null : window.apiCall('/api/protection/status');
    const ds = window.DataStore;
    if (typeof ds?.loadSWR === 'function') {
        ds.loadSWR({ key: 'protection_status', tags: ['protection'], fetcher, onCached: paintSyncChip, onFresh: paintSyncChip, onError: () => {} })
            .catch(() => {});
        return;
    }
    Promise.resolve().then(fetcher).then(paintSyncChip, () => paintSyncChip(null));
}

// W5 page Sync section (bd med-ta2n.5; replaces the Move row and section —
// the move runs from P3, features/invite.js). No invite: Paste / Scan run the
// F1 sheet's action (entered from Settings, so the claim gets &kit=1) and
// "How to get an invite" opens the deployment's base landing. An invite in
// the shell slot (InviteSheet.pending reads it only where the shell lists
// invite.pending — the A7 shell gate): "Turn on sync" opens P3, whose button
// holds the A7 offline gate. Re-read on every Settings open.
let _syncSectionBound = false; // module-state: bind the buttons once across repeated loadSettings() calls
let _syncInvite = null; // module-state: the slot's claim URL from the last paint
async function paintSyncSection() {
    if (settingsRenderBlocked()) return;
    const none = document.getElementById('settings-sync-none');
    const waiting = document.getElementById('settings-sync-waiting');
    const how = document.getElementById('settings-sync-how');
    const sheet = window.InviteSheet;
    if (!none || !waiting || !how || !sheet) return;
    if (!_syncSectionBound) {
        _syncSectionBound = true;
        const f1 = (action) => document.dispatchEvent(new window.CustomEvent('wg:invite-open', { detail: { kit: true, action } }));
        document.getElementById('settings-sync-paste')?.addEventListener('click', () => f1('paste'));
        document.getElementById('settings-sync-scan')?.addEventListener('click', () => f1('scan'));
        // bd med-ta2n.14: the email request sheet (InviteSheet.request).
        document.getElementById('settings-sync-request')?.addEventListener('click', () => sheet.request());
        // bd med-r1j2.5: Path 0, "Open my account" (AD10).
        document.getElementById('settings-sync-open')?.addEventListener('click', () => sheet.openAccount());
        document.getElementById('settings-sync-turn-on')?.addEventListener('click', () => {
            if (_syncInvite) sheet.offer(_syncInvite, { kit: true });
        });
    }
    const [invite, base, canRequest] = await Promise.all([
        Promise.resolve().then(() => sheet.pending()).catch(() => null),
        Promise.resolve().then(() => sheet.base()).catch(() => ''),
        // The shell POSTs the request (base.post); without the op, no button.
        Promise.resolve().then(() => sheet.canRequest && sheet.canRequest()).catch(() => false),
    ]);
    if (settingsRenderBlocked()) return;
    _syncInvite = invite || null;
    none.hidden = !!_syncInvite;
    waiting.hidden = !_syncInvite;
    // IM3 (bd med-er5x): one invite link. "No invite? Request one" opens the
    // request sheet where the shell can POST; else the base landing.
    const request = document.getElementById('settings-sync-request');
    if (request) request.hidden = canRequest !== true;
    how.hidden = !base || (!!request && canRequest === true);
    if (base) how.href = `https://${base}/`;
    // The address check needs the base: without it, no Path 0 entry.
    const openGroup = document.getElementById('settings-sync-open-group');
    if (openGroup) openGroup.hidden = !base;
}

// Load settings (BP reminders status, etc.)
async function loadSettings({ source } = {}) {
    if (settingsRenderBlocked()) return;
    // Ungated: the first-run overlay ships in the server, cloud, and mobile
    // builds alike, so the row is not wrapped in a wg-settings-cloud-* reveal.
    bindRerunOnboarding();
    bindSettingsPages();
    if (window.__MEDTRACKER_CLOUD__) {
        // weekly_digest now drives a cloud horizon producer (med-eas.58), so the
        // toggle is live in cloud. It only makes sense alongside gamification
        // (the digest is a gamification summary, both-on gate per the bot), so
        // updateWeeklyDigestVisibility hides it when gamification is off.
        document.querySelector('.wg-settings-notifications-cloud')?.classList.remove('wg-settings-hidden');
        await bindCloudNotifications();
        if (settingsRenderBlocked()) return;
        // Devices & connectors only make sense in cloud mode — server/mobile
        // builds have no vault devices or relay.
        document.querySelector('.wg-settings-cloud-devices')?.classList.remove('wg-settings-hidden');
        bindCloudDevicesPage();
        // Local mode has its own card (.wg-local-only) and no account.
        if (!document.documentElement.classList.contains('wg-local-vault')) {
            // Neither throws; not awaited so Settings never waits on the sync module.
            paintVaultCard();
            paintKitState();
        }
        await bindSecondDeviceNudge();
        if (settingsRenderBlocked()) return;
        await bindOperatorVisibility();
        if (settingsRenderBlocked()) return;
        bindLeaveAccount();
        bindDeleteAccount();
        bindCloudInvite();
    }
    // Local-only mode (web/cloud/js/local-boot.js sets the class).
    if (document.documentElement.classList.contains('wg-local-vault')) {
        bindLocalReminderText();
        bindLocalNotifications();
        bindLocalErase();
        paintSyncCard();
        paintSyncSection();
    }
    const applyBundle = async (rawBundle) => {
        if (settingsRenderBlocked()) return;
        const bundle = window.AuthBootstrap.normalizeSettingsBundle(rawBundle);
        paintAccountTimeZone(bundle.timezone, bundle.timezoneSource);
        window.SettingsState.applyBootstrapFeatures(bundle.featureSettings);
        window.WeightUnitState.applyAuthoritative(bundle.weightUnitPreference);
        applyBundleBody(bundle.body);
        updateFeatureToggles();
        updateFeatureTabVisibility();

        window.FoodLog.targets = { ...bundle.foodTargets };
        const targets = window.FoodLog.targets;
        const calsInput = document.getElementById('food-target-calories');
        const carbsInput = document.getElementById('food-target-carbs');
        const protInput = document.getElementById('food-target-protein');
        const fatInput = document.getElementById('food-target-fat');
        if (calsInput) calsInput.value = targets.calories || '';
        if (carbsInput) carbsInput.value = targets.carbs || '';
        if (protInput) protInput.value = targets.protein || '';
        if (fatInput) fatInput.value = targets.fat || '';

        document.getElementById('bp-reminders-toggle').checked = !!bundle.bpReminderStatus.enabled;
        document.getElementById('weight-reminders-toggle').checked = !!bundle.weightReminderStatus.enabled;
        applyReminderSummaries(bundle.bpReminderStatus, bundle.weightReminderStatus);
    };

    const fetchBundle = async () => {
        const [featureSettingsRes, foodTargetsRes, bpReminderStatus, weightReminderStatus, settingsRes] = await Promise.all([
            apiCall('/api/settings/features', 'GET'),
            apiCall('/api/food/settings/targets', 'GET'),
            apiCall('/api/bp/reminder/status', 'GET'),
            apiCall('/api/weight/reminder/status', 'GET'),
            apiCall('/api/settings', 'GET')
        ]);
        // /api/settings now returns the same slices the four legacy endpoints
        // return (features, food_targets, bp_reminder_status,
        // weight_reminder_status). Treat it as a fallback for any legacy slice
        // that came back null, so a partial outage of one legacy endpoint
        // doesn't make us skip onFresh and leave Settings stale.
        const features = featureSettingsRes !== null
            ? featureSettingsRes
            : (settingsRes && settingsRes.features !== undefined ? settingsRes.features : null);
        const foodTargetsData = foodTargetsRes !== null
            ? foodTargetsRes
            : (settingsRes && settingsRes.food_targets !== undefined ? settingsRes.food_targets : null);
        const bpReminder = bpReminderStatus !== null
            ? bpReminderStatus
            : (settingsRes && settingsRes.bp_reminder_status !== undefined ? settingsRes.bp_reminder_status : null);
        const weightReminder = weightReminderStatus !== null
            ? weightReminderStatus
            : (settingsRes && settingsRes.weight_reminder_status !== undefined ? settingsRes.weight_reminder_status : null);
        // apiCall returns null silently on offline / 5xx. Defaulting null
        // slices to {} / 0 / {enabled:false} here would produce a non-null
        // bundle that fetchFresh would then write to ApiCache, blanking the
        // good cached bundle and the rendered UI (toggles off, macros 0,
        // weight unit back to kg). Surface the failure to loadSWR by
        // returning null — it skips onFresh and the cached row + onCached
        // already-painted UI stay intact.
        if (
            settingsRes === null
            || features === null
            || foodTargetsData === null
            || bpReminder === null
            || weightReminder === null
        ) {
            return null;
        }
        // tab_order: /api/settings includes it (when set) but for compat with
        // clients that haven't migrated to consuming it from here, prefer the
        // existing cache, then fall back to localStorage, then to the /api/settings
        // response. This preserves the user's saved Today card order across SWR
        // re-writes and invalidations of settings_bundle.
        let tabOrder = null;
        try {
            const existing = await window.DataStore.getCached('settings_bundle');
            if (existing && Array.isArray(existing.tabOrder)) tabOrder = existing.tabOrder;
        } catch (_) { /* no cache available — leave tabOrder null */ }
        if (!tabOrder) tabOrder = readPersistedTabOrder();
        if (!tabOrder && Array.isArray(settingsRes?.tab_order)) tabOrder = settingsRes.tab_order;
        return {
            featureSettings: features || {},
            tabOrder,
            timezone: settingsRes?.timezone || '',
            timezoneSource: settingsRes?.timezone_source || '',
            serverTime: settingsRes?.server_time || '',
            serverTimezone: settingsRes?.server_timezone || '',
            dismissedTzSuggestion: settingsRes?.dismissed_tz_suggestion || '',
            weightUnitPreference: settingsRes?.weight_unit_preference || window.weightUnitPreference || 'kg',
            body: window.AuthBootstrap.normalizeSettingsBundle({ settings: settingsRes }).body,
            foodTargets: {
                calories: foodTargetsData?.calories || 0,
                carbs: foodTargetsData?.carbs || 0,
                protein: foodTargetsData?.protein || 0,
                fat: foodTargetsData?.fat || 0
            },
            bpReminderStatus: bpReminder || { enabled: false },
            weightReminderStatus: weightReminder || { enabled: false }
        };
    };

    try {
        await window.DataStore.loadSWR({
            key: 'settings_bundle',
            tags: ['settings', 'food_targets', 'feature_settings'],
            fetcher: fetchBundle,
            onCached: async (cached) => {
                await applyBundle(cached);
            },
            onFresh: async (fresh) => {
                await applyBundle(fresh);
            },
            onError: async (error, cached) => {
                console.error('Failed to load settings:', error);
                if (cached) applyBundle(cached);
            }
        });
    } catch (error) {
        console.error('Failed to load settings:', error);
    }
    if (settingsRenderBlocked()) return;
    // The Integrations section is loaded lazily from its own endpoint so
    // the settings_bundle SWR fetch stays focused on the feature-flags +
    // food-targets + reminders + weight-unit slice that bootstrap also
    // returns. Best-effort: never blocks the rest of Settings.
    if (window.SettingsIntegrations && typeof window.SettingsIntegrations.load === 'function') {
        try { await window.SettingsIntegrations.load({ preserveDraft: source === 'optimistic-commit' }); } catch (_) { /* no-op */ }
    }
    if (settingsRenderBlocked()) return;
    // Import/Export section (C2e Task 6) — static, so load() just (re)binds its
    // controls; safe in both bot and cloud modes.
    if (window.SettingsImportExport && typeof window.SettingsImportExport.load === 'function') {
        try { window.SettingsImportExport.load(); } catch (_) { /* no-op */ }
    }
    // Journey targets editor — loaded lazily off its own endpoint (best-effort;
    // internally gated on the gamification flag).
    await loadGamificationTargets();
    if (settingsRenderBlocked()) return;
    await loadGamificationMode();
    if (settingsRenderBlocked()) return;
    // Hide any home row whose page sections are all hidden (e.g. a cloud-only
    // page in bot mode) so it never opens onto an empty page.
    fillDeviceWords();
    hideEmptySettingsRows();
    refreshSettingsSummaries();
    refreshIntegrationsSummary();
    await refreshDevicesSummary();
}

// ---- Settings v2 home + pushed pages (med-xso6.23, kit S1/S2) ---------------
// Each home row ([data-settings-open=<name>]) pushes a WGPage whose body is the
// matching [data-settings-page=<name>] node from the hidden .wg-settings-pages
// store. The node is MOVED (never cloned) so ids and bound listeners survive,
// and goes back to the store when the page closes.
function settingsPageBody(name) {
    return document.querySelector(`.wg-settings-pages > [data-settings-page="${name}"]`);
}

// Pages with one Save in the page bar. Targets closes on success; AI &
// integrations stays open (its Telegram row is one tap away) and toasts.
function settingsPagePrimary(name, getPage) {
    if (name === 'targets') {
        return { label: 'Save', onClick: async () => { if (await saveTargets() && getPage()) getPage().close(); } };
    }
    if (name === 'integrations' && window.SettingsIntegrations) {
        return { label: 'Save', onClick: () => window.SettingsIntegrations.save() };
    }
    return undefined;
}

function openSettingsPage(name) {
    if (settingsRenderBlocked()) return null;
    const store = document.querySelector('.wg-settings-pages');
    const body = settingsPageBody(name);
    if (!store || !body || !window.WGPage) return null; // absent, or already open
    // The row this mode shows: local mode opens 'backup' from the W5 card.
    const rows = Array.from(document.querySelectorAll(`[data-settings-open="${name}"]`));
    const row = rows.find((r) => !isSettingsSectionHidden(r)) || rows[0];
    const title = row?.dataset.settingsTitle || row?.querySelector('.wg-setting__title, .wg-row__title')?.textContent.trim() || name;
    let page = null;
    page = window.WGPage.push({
        title,
        back: body.dataset.settingsParent || 'Settings',
        // Kit S8: icon-only Back so "Reminders & notifications" fits (bd med-ckm5.8).
        longTitle: name === 'notifications',
        body,
        primary: settingsPagePrimary(name, () => page),
        onClose: () => {
            _openSettingsPages.delete(name);
            store.appendChild(body);
            if (name === 'integrations') window.SettingsIntegrations?.bindPage(null);
            if (name === 'units' && _heightDirty) {
                // An unsaved (invalid) height is dropped with the page.
                _heightDirty = false;
                paintBodySettings();
            }
            refreshSettingsSummaries();
            if (name === 'backup' && document.documentElement.classList.contains('wg-local-vault')) paintSyncCard();
        },
    });
    _openSettingsPages.set(name, page);
    if (name === 'integrations') window.SettingsIntegrations?.bindPage(page);
    if (name === 'devices') mountCloudDevices();
    if (name === 'units') refreshBmiHint().catch(() => {});
    return page;
}

const _openSettingsPages = new Map(); // module-state: page name → its open WGPage handle
let _settingsPagesBound = false; // module-state: bind the home/page row clicks once across repeated loadSettings() calls
function bindSettingsPages() {
    if (_settingsPagesBound) return;
    _settingsPagesBound = true;
    document.querySelectorAll('[data-settings-open]').forEach((row) => {
        row.addEventListener('click', () => openSettingsPage(row.dataset.settingsOpen));
    });
    // Reminders → Medications: per-medication times live in the Meds editor.
    document.getElementById('settings-reminders-meds')?.addEventListener('click', () => {
        _openSettingsPages.get('notifications')?.close();
        switchTab('meds');
    });
}

// Read-only reminder time summaries (kit S8) from the bundle's reminder statuses.
function reminderHour(status) {
    const h = Number(status && status.preferred_reminder_hour);
    return Number.isInteger(h) && h >= 0 && h < 24 ? `${String(h).padStart(2, '0')}:00` : null;
}

function setReminderDesc(inputId, text) {
    const desc = document.getElementById(inputId)?.closest('mt-setting-toggle')?.querySelector('.wg-setting__desc');
    if (desc && text) desc.textContent = text;
}

function applyReminderSummaries(bp, weight) {
    const bpAt = reminderHour(bp);
    if (bpAt) setReminderDesc('bp-reminders-toggle', `At ${bpAt} unless you measured recently`);
    const weightAt = reminderHour(weight);
    if (weightAt) {
        setReminderDesc('weight-reminders-toggle', weight.cadence === 'daily'
            ? `Daily at ${weightAt}`
            : `At ${weightAt}, a week after your last weigh-in`);
    }
}

// Hide a home row when every top-level section of its page is hidden.
// Per-section gating stays the source of truth; this only rolls it up.
function hideEmptySettingsRows() {
    // Rows only: the slot-① cards have their own mode gating (paintVaultCard, .wg-local-only).
    document.querySelectorAll('.wg-settings-home .wg-setting[data-settings-open]').forEach((row) => {
        const body = settingsPageBody(row.dataset.settingsOpen);
        if (!body) return;
        const sections = Array.from(body.children);
        const allHidden = sections.length > 0 && sections.every(isSettingsSectionHidden);
        row.classList.toggle('wg-settings-hidden', allHidden);
    });
}

// A section counts as hidden when any of its gating mechanisms has hidden it:
// the wg-settings-hidden / hidden class toggles, the [hidden] attribute, or the
// local-only mode classes (styles.css, bd med-o7zq.3).
function isSettingsSectionHidden(s) {
    return s.matches('.wg-settings-hidden, .hidden, [hidden], '
        + ':root.wg-local-vault .wg-cloud-only, :root:not(.wg-local-vault) .wg-local-only');
}

function setSettingsSummary(name, text) {
    if (settingsRenderBlocked()) return;
    const el = document.querySelector(`[data-settings-summary="${name}"]`);
    if (el && typeof text === 'string') el.textContent = text;
}

function countToggles(selector) {
    const inputs = Array.from(document.querySelectorAll(selector));
    return { on: inputs.filter((i) => i.checked).length, total: inputs.length };
}

// Row summaries read the live controls. A summary is only visible once the
// page above it closes, so refreshing on load, on flag/mode application and
// on every page close keeps them right.
function refreshSettingsSummaries() {
    const features = countToggles('[data-settings-page="features"] .wg-toggle__input, [data-settings-page="journey-extras"] .wg-toggle__input');
    if (features.total) setSettingsSummary('features', `${features.on} of ${features.total} on`);
    const extras = countToggles('[data-settings-page="journey-extras"] .wg-toggle__input');
    if (extras.total) setSettingsSummary('journey-extras', `${extras.on} of ${extras.total} on`);

    const targets = [];
    const food = document.getElementById('food-target-settings');
    const calories = window.FoodLog && window.FoodLog.targets && window.FoodLog.targets.calories;
    if (food && !isSettingsSectionHidden(food)) targets.push(calories ? `Food ${calories} kcal` : 'Food not set');
    const gam = document.getElementById('gamification-targets-settings');
    if (gam && !isSettingsSectionHidden(gam)) targets.push('Journey bands');
    setSettingsSummary('targets', targets.join(' · '));

    const parts = [];
    const cloudNotifications = document.querySelector('.wg-settings-notifications-cloud');
    const delivery = document.getElementById('cloud-reminder-delivery');
    if (cloudNotifications && delivery && !isSettingsSectionHidden(cloudNotifications)) {
        parts.push({ webpush: 'Push', telegram: 'Telegram', both: 'Push + Telegram' }[choiceValue(delivery)] || 'Push');
    }
    const reminders = [
        document.getElementById('bp-reminders-toggle')?.checked && 'BP',
        document.getElementById('weight-reminders-toggle')?.checked && 'weight',
    ].filter(Boolean);
    parts.push(reminders.length ? reminders.join(', ') : 'No reminders');
    setSettingsSummary('notifications', parts.join(' · '));

    setSettingsSummary('units', window.weightUnitPreference === 'lb' ? 'lb' : 'kg');
    // Telegram row on the AI & integrations page (linked / unlinked since).
    window.SettingsIntegrations?.syncTelegramRow?.();
}

// Refresh after SettingsIntegrations.load()/save() accepted masked settings,
// not on page close, where an unsaved edit would read as set.
// A stored secret comes back as "***".
function refreshIntegrationsSummary() {
    const filled = (id) => !!document.getElementById(id)?.value.trim();
    const set = [
        window.SettingsIntegrations?.savedProviderLabel(),
        filled('integrations-elevenlabs-api-key') && 'Voice',
        document.getElementById('telegram-settings-mount')?.dataset.tgState === 'linked' && 'Telegram',
    ].filter(Boolean);
    setSettingsSummary('integrations', set.length ? set.join(' · ') : 'AI, voice, Telegram');
}

async function refreshDevicesSummary() {
    if (settingsRenderBlocked()) return;
    if (!window.__MEDTRACKER_CLOUD__) return;
    const count = await fetchDeviceCount();
    if (settingsRenderBlocked()) return;
    if (typeof count === 'number') setSettingsSummary('devices', count === 1 ? '1 device' : `${count} devices`);
}

function updateFeatureToggles() {
    const flags = window.featureSettings || {};
    document.getElementById('food-intake-toggle').checked = !!flags.food;
    document.getElementById('bp-feature-toggle').checked = !!flags.bp;
    document.getElementById('weight-feature-toggle').checked = !!flags.weight;
    document.getElementById('health-feature-toggle').checked = !!flags.health;
    document.getElementById('medication-feature-toggle').checked = !!flags.medication;
    document.getElementById('workout-feature-toggle').checked = !!flags.workout;
    document.getElementById('weekly-digest-feature-toggle').checked = !!flags.weekly_digest;
    document.getElementById('gamification-feature-toggle').checked = !!flags.gamification;
    document.getElementById('live-hr-feature-toggle').checked = !!flags.live_hr;
    updateWeeklyDigestVisibility(flags);
    refreshSettingsSummaries();
}

// The weekly-digest toggle drives a gamification-summary push, so it's only
// meaningful when gamification is on (both-on gate). The Journey mode switches
// (med-8tur.12) share the same gate — except ED-safe: it hides weight numbers
// on Today and BMI with Journey off too (med-njny), so its Safety group stays
// reachable.
function updateWeeklyDigestVisibility(flags) {
    const row = document.querySelector('mt-setting-toggle[input-id="weekly-digest-feature-toggle"]');
    row?.classList.toggle('wg-settings-hidden', !flags.gamification);
    for (const key of GAMIFICATION_MODE_KEYS) {
        if (key === 'ed_safe') continue;
        document.querySelector(`mt-setting-toggle[input-id="${gamificationModeToggleId(key)}"]`)
            ?.classList.toggle('wg-settings-hidden', !flags.gamification);
    }
    // Features page: the folded Journey-extras row shares the gate, so no
    // empty row lingers.
    document.querySelectorAll('.wg-settings-journey-extras')
        .forEach((el) => el.classList.toggle('wg-settings-hidden', !flags.gamification));
}

// ---- Journey mode switches (med-8tur.12, docs/gamification.md §0.5) ---------
// Per-mechanic switches + ED-safe, stored on the gamificationmode record via
// GET/PUT /api/gamification/mode.
const GAMIFICATION_MODE_KEYS = ['experiments', 'traits', 'narration', 'ed_safe'];

function gamificationModeToggleId(key) {
    return `gam-mode-${key.replace(/_/g, '-')}-toggle`;
}

function applyGamificationMode(mode) {
    if (settingsRenderBlocked()) return;
    for (const key of GAMIFICATION_MODE_KEYS) {
        const input = document.getElementById(gamificationModeToggleId(key));
        if (input && typeof mode[key] === 'boolean') input.checked = mode[key];
    }
    refreshSettingsSummaries();
}

// Not gated on Journey: the ED-safe switch is visible with it off (med-njny)
// and /api/gamification/mode is not feature-gated.
async function loadGamificationMode() {
    if (settingsRenderBlocked()) return;
    try {
        const mode = await apiCall('/api/gamification/mode', 'GET');
        if (settingsRenderBlocked()) return;
        if (mode && mode.enabled !== false) applyGamificationMode(mode);
    } catch (e) {
        console.warn('Failed to load journey mode:', e);
    }
}

// Optimistic write (Critical Rule #9), same shape as saveGamificationTargets:
// the switch already flipped in the DOM; a failure rolls the 'gamification'
// cache back and restores the switch, success invalidates the tag so Today's
// Goal Line and the Journey re-read under the new mode.
async function saveGamificationMode(key, value) {
    const ds = window.DataStore;
    const handle = (ds && typeof ds.applyOptimistic === 'function')
        ? await ds.applyOptimistic('gamification', (prev) => prev, ['gamification'])
        : null;
    let res = null;
    try {
        res = await apiCall('/api/gamification/mode', 'PUT', { [key]: value });
    } catch (e) {
        console.error('Failed to save journey mode:', e);
    }
    if (!res || res.ok === false) {
        if (handle) await handle.rollback();
        const input = document.getElementById(gamificationModeToggleId(key));
        if (input) input.checked = !value;
        refreshSettingsSummaries();
        return;
    }
    if (handle) await handle.commit(null);
    applyGamificationMode(res);
    try { await ds.invalidateTags(['gamification']); } catch (_) { /* best-effort */ }
}

function updateFoodTargetsVisibility() {
    const settingsBlock = document.getElementById('food-target-settings');
    if (!settingsBlock) return;
    settingsBlock.classList.toggle('wg-settings-hidden', !window.featureSettings.food);
}

// ---- Journey (gamification) targets editor (Plan 3, Task 4) -----------------
// The overridable band-shaped metrics, in the same display order the backend
// returns (internal/domain/gamification/scoreday.go targetMetricKeys). Labels +
// units live in the static HTML; JS only addresses fields by metric_key.
const GAMIFICATION_TARGET_METRICS = ['bp_systolic', 'bp_diastolic', 'resting_hr', 'sleep_hours', 'steps', 'bedtime'];

// Metric keys the user has a custom override for, per the last applied view.
// saveGamificationTargets consults this so clearing a previously-custom band
// sends an explicit reset (not just a skip) and actually reverts to default.
const gamCustomMetrics = new Set();

// Format an effective/recommended band value for display: round to ≤1 decimal
// (sleep hours are fractional, the rest integral) and stringify. Empty string
// for absent/non-numeric so a blank input keeps its recommended placeholder.
function fmtGamTargetVal(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '';
    return String(Math.round(Number(n) * 10) / 10);
}

// Populate the Journey Targets fields from a GET/PUT /api/gamification/targets
// view: recommended bounds become the placeholder + hint; custom overrides
// prefill the inputs (so a recommended metric shows faint placeholders and a
// customized one shows its own values).
function applyGamificationTargets(view) {
    if (settingsRenderBlocked()) return;
    if (!view || view.enabled === false || !Array.isArray(view.targets)) return;
    gamCustomMetrics.clear();
    for (const t of view.targets) {
        const key = t.metric_key;
        if (t.is_custom) gamCustomMetrics.add(key);
        const lowEl = document.getElementById(`gam-target-${key}-low`);
        const highEl = document.getElementById(`gam-target-${key}-high`);
        const hintEl = document.querySelector(`[data-gam-hint="${key}"]`);
        if (!lowEl || !highEl) continue;
        const recLow = fmtGamTargetVal(t.recommended_low);
        const recHigh = fmtGamTargetVal(t.recommended_high);
        lowEl.placeholder = recLow;
        highEl.placeholder = recHigh;
        lowEl.value = t.is_custom ? fmtGamTargetVal(t.low) : '';
        highEl.value = t.is_custom ? fmtGamTargetVal(t.high) : '';
        if (hintEl) {
            hintEl.textContent = t.is_custom
                ? `custom · rec ${recLow}–${recHigh}`
                : `recommended ${recLow}–${recHigh}`;
        }
    }
}

// Best-effort field population — fetched separately from the settings_bundle SWR
// (mirrors SettingsIntegrations.load) so a targets-endpoint outage never blanks
// the rest of Settings. Skips entirely when the feature is off.
async function loadGamificationTargets() {
    if (settingsRenderBlocked()) return;
    if (!window.featureSettings || !window.featureSettings.gamification) return;
    try {
        const view = await apiCall('/api/gamification/targets', 'GET');
        if (settingsRenderBlocked()) return;
        if (view) applyGamificationTargets(view);
    } catch (e) {
        console.warn('Failed to load journey targets:', e);
    }
}

function updateGamificationTargetsVisibility() {
    const block = document.getElementById('gamification-targets-settings');
    if (!block) return;
    const on = !!(window.featureSettings && window.featureSettings.gamification);
    block.classList.toggle('hidden', !on);
}

// Save the edited bands. Only metrics the user actually filled are sent (a blank
// pair keeps the recommended default). Optimistic write (Critical Rule #9) on the
// shared 'gamification' cache key: a band change can't retro-repaint the Journey
// without a re-score, so the mutator is a no-op — the value is the rollback +
// tag-refresh lifecycle, which on failure restores the prior journey cache and on
// success invalidates it so the next Journey load re-scores against the new bands.
// Resolves true on success; `toast: false` is the shared Targets Save (saveTargets).
async function saveGamificationTargets({ toast = true } = {}) {
    const targets = [];
    for (const key of GAMIFICATION_TARGET_METRICS) {
        const lowEl = document.getElementById(`gam-target-${key}-low`);
        const highEl = document.getElementById(`gam-target-${key}-high`);
        if (!lowEl || !highEl) continue;
        const lowStr = lowEl.value.trim();
        const highStr = highEl.value.trim();
        const low = lowStr === '' ? null : parseDecimal(lowStr);
        const high = highStr === '' ? null : parseDecimal(highStr);
        const pretty = key.replace(/_/g, ' ');
        // Client-side guard against obviously unsafe values before the PUT (the
        // service validates the same, but catch it early for a clearer message).
        if ((low !== null && (Number.isNaN(low) || low < 0)) || (high !== null && (Number.isNaN(high) || high < 0))) {
            safeAlert(`Enter valid non-negative numbers for ${pretty}`);
            return false;
        }
        if (low !== null && high !== null && low > high) {
            safeAlert(`${pretty}: low must not exceed high`);
            return false;
        }
        if (low === null && high === null) {
            // Both blank. If this metric was a custom override, the user cleared it
            // to revert to the recommended default — send an all-nil reset so the
            // backend deletes the override (honouring the "leave blank to keep the
            // recommended default" copy). A never-custom metric is genuinely
            // unchanged, so skip it.
            if (gamCustomMetrics.has(key)) targets.push({ metric_key: key });
            continue;
        }
        const t = { metric_key: key };
        if (low !== null) t.low_val = low;
        if (high !== null) t.high_val = high;
        targets.push(t);
    }

    const ds = window.DataStore;
    const handle = (ds && typeof ds.applyOptimistic === 'function')
        ? await ds.applyOptimistic('gamification', (prev) => prev, ['gamification'])
        : null;

    let res;
    try {
        res = await apiCall('/api/gamification/targets', 'PUT', { targets });
    } catch (e) {
        if (handle) await handle.rollback();
        console.error('Failed to save journey targets:', e);
        safeToast('Failed to save targets', 'error');
        return false;
    }
    if (!res) {
        if (handle) await handle.rollback();
        // apiCall already surfaced the failure alert for the write; don't stack a second.
        return false;
    }
    if (handle) await handle.commit(null);
    applyGamificationTargets(res);
    try { await ds.invalidateTags(['gamification']); } catch (_) { /* best-effort */ }
    if (toast) safeToast('Targets saved', 'info');
    return true;
}

// The Targets page's one Save (kit S1, med-xso6.23): Journey bands first — their
// validation is the only one that can refuse — then food targets, each through
// its own optimistic write. Only the visible sections are saved. Resolves true
// when everything visible saved, so the page can close.
async function saveTargets() {
    const visible = (id) => {
        const el = document.getElementById(id);
        return !!el && !isSettingsSectionHidden(el);
    };
    // Read the food inputs first: the Journey save's optimistic tab reload
    // re-fills them from the cached bundle before saveFoodTargets would read.
    const food = visible('food-target-settings') ? window.FoodLog.readTargetsForm() : null;
    if (visible('gamification-targets-settings') && !(await saveGamificationTargets({ toast: false }))) return false;
    if (food && !(await window.saveFoodTargets({ toast: false, payload: food }))) return false;
    safeToast('Targets saved', 'info');
    return true;
}

async function toggleFeatureSetting(feature, enabled) {
    const result = await apiCall(`/api/settings/features/${feature}`, 'POST', { enabled });
    if (!result) {
        // apiCall returns null on failure and has already surfaced the error.
        // Revert the DOM toggle to the last-known state so the UI doesn't lie.
        updateFeatureToggles();
        return;
    }
    window.SettingsState.setFeature(feature, enabled);
    if (typeof window.rebuildCanonicalBottomNav === 'function') {
        window.rebuildCanonicalBottomNav();
    }
    try {
        await window.DataStore.invalidateTags(['settings', 'feature_settings']);
    } catch (e) {
        console.warn(`Failed to invalidate settings cache after toggling ${feature}:`, e);
    }
    updateFeatureTabVisibility();
    // The Journey mode switches are revealed with gamification; a Settings load
    // made while it was off never hydrated them.
    if (feature === 'gamification' && enabled) await loadGamificationMode();
}

function updateFeatureTabVisibility() {
    const tabToFeature = {
        food: 'food',
        health: 'health',
        bp: 'bp',
        weight: 'weight',
        meds: 'medication',
        workouts: 'workout',
        journey: 'gamification'
    };

    const currentTab = window.AppStore && window.AppStore.get('currentTab');
    const currentFeature = tabToFeature[currentTab];
    if (currentFeature && !window.featureSettings[currentFeature]) {
        switchTab('today');
    }
    // Live-HR POC (med-byks.1): live_hr gates a Vitals card, not a tab, so the
    // tab-visibility sync never touches it — refresh it explicitly so flipping
    // the flag off tears down a live subscription immediately. Both flag-change
    // paths funnel through here (the local toggle and an authoritative bundle
    // carrying another device's toggle).
    if (window.LiveHR && typeof window.LiveHR.refresh === 'function') {
        try { window.LiveHR.refresh(); } catch (_) { /* card is best-effort */ }
    }
    updateFoodTargetsVisibility();
    updateGamificationTargetsVisibility();
    // Gamification toggling here also gates the weekly-digest row (both-on), so
    // refresh its visibility on the toggle success path — not just on load.
    updateWeeklyDigestVisibility(window.featureSettings || {});
    // Reminders → Medications jumps to the Meds tab, which bounces to Today when
    // off (med-v7bp). Boot/bundle and the live toggle both funnel through here.
    document.getElementById('settings-reminders-meds')
        ?.classList.toggle('wg-settings-hidden', !(window.featureSettings && window.featureSettings.medication));
    // A toggle just changed a target section's visibility; roll that up to the
    // home row so an all-hidden Targets row doesn't linger (and reappears when a
    // target is re-enabled) without a full Settings reload.
    hideEmptySettingsRows();
    refreshSettingsSummaries();
}

// ---- Units & body: height for BMI (med-a6fb.4, kit BM2) ---------------------
// One value, stored in whole cm (PATCH /api/settings/body), shown in its own
// unit (cm | ft + in) — not the weight unit. Read from settings_bundle
// (GET /api/settings, bootstrap.settings), never /api/weight/bmi, which nulls
// values under ED-safe.
const HEIGHT_MIN_CM = 100;
const HEIGHT_MAX_CM = 250;
const HEIGHT_RANGE_ERROR = {
    cm: `Enter a height between ${HEIGHT_MIN_CM} and ${HEIGHT_MAX_CM} cm.`,
    ftin: 'Enter a height between 3′ 3″ and 8′ 2″.',
};
let _body = { height_cm: null, height_unit: 'cm', show_bmi: true, bmi_nudge_dismissed: false }; // module-state: last painted body settings
let _heightDirty = false; // module-state: mid-edit, so a bundle repaint must not overwrite the typed value

function cmToFtIn(cm) {
    const total = Math.round(cm / 2.54);
    return { ft: Math.floor(total / 12), inch: total % 12 };
}

function formatHeight(cm, unit) {
    if (cm === null) return 'Not set';
    if (unit !== 'ftin') return `${cm} cm`;
    const { ft, inch } = cmToFtIn(cm);
    return `${ft}′ ${inch}″`;
}

function setInputValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value;
}

function showHeightError(message) {
    const err = document.getElementById('settings-height-error');
    if (err) {
        err.textContent = message;
        err.classList.toggle('wg-settings-hidden', !message);
    }
    document.getElementById('settings-height-field')?.classList.toggle('wg-field--error', !!message);
    for (const id of ['settings-height-input', 'settings-height-ft', 'settings-height-in']) {
        const input = document.getElementById(id);
        if (!input) continue;
        if (message) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
    }
}

function paintBodySettings(body) {
    if (settingsRenderBlocked()) return;
    if (body) _body = { ..._body, ...body };
    const unit = _body.height_unit === 'ftin' ? 'ftin' : 'cm';
    document.querySelectorAll('#height-unit-segmented [data-height-unit]').forEach((btn) => {
        const on = btn.dataset.heightUnit === unit;
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    document.getElementById('settings-height-cm')?.classList.toggle('wg-settings-hidden', unit === 'ftin');
    document.getElementById('settings-height-ftin')?.classList.toggle('wg-settings-hidden', unit !== 'ftin');
    if (!_heightDirty) {
        const cm = typeof _body.height_cm === 'number' ? _body.height_cm : null;
        const ftin = cm === null ? null : cmToFtIn(cm);
        setInputValue('settings-height-input', cm === null ? '' : String(cm));
        setInputValue('settings-height-ft', ftin ? String(ftin.ft) : '');
        setInputValue('settings-height-in', ftin ? String(ftin.inch) : '');
        showHeightError('');
    }
    const toggle = document.getElementById('settings-show-bmi-toggle');
    if (toggle) toggle.checked = _body.show_bmi !== false;
    setSettingsSummary('body', `Height · ${formatHeight(_body.height_cm ?? null, unit)}`);
    paintBmiHint();
}

// Live BMI hint under the height field (BM2): the typed height against the
// latest log. GET /api/weight/bmi nulls latest_kg under ED-safe and has none
// without a log; the formula is the domain's bmi() (web/domain/weight.js).
let _bmiFacts = null; // module-state: last GET /api/weight/bmi payload
let _weightDomain = null; // module-state: web/domain/weight.js once imported
// Test seam (as loadPrivacyModule): tests swap in the module by path.
function loadWeightDomain() { return import('/domain/weight.js'); }

async function refreshBmiHint() {
    if (settingsRenderBlocked()) return;
    try {
        const [facts, domain] = await Promise.all([
            apiCall('/api/weight/bmi', 'GET'),
            _weightDomain || loadWeightDomain(),
        ]);
        if (settingsRenderBlocked()) return;
        _bmiFacts = facts || null;
        _weightDomain = domain;
    } catch (_) {
        _bmiFacts = null; // no hint is the safe failure
    }
    paintBmiHint();
}

function paintBmiHint() {
    // The fetch can land after the page (or a test's jsdom) is gone.
    if (typeof document === 'undefined' || !document) return;
    if (settingsRenderBlocked()) return;
    const hint = document.getElementById('settings-height-bmi-hint');
    if (!hint) return;
    const kg = _bmiFacts && !_bmiFacts.ed_safe && Number.isFinite(_bmiFacts.latest_kg) ? _bmiFacts.latest_kg : null;
    // Untouched: the stored cm, not the rounded ft + in display read back.
    const stored = typeof _body.height_cm === 'number' ? _body.height_cm : null;
    const typed = kg === null || _body.show_bmi === false || !_weightDomain ? null
        : (_heightDirty ? readHeightInput() : { cm: stored });
    const value = typed && !typed.error && typed.cm !== null ? _weightDomain.bmi(kg, typed.cm) : null;
    hint.classList.toggle('wg-settings-hidden', value === null);
    if (value === null) {
        hint.textContent = '';
        return;
    }
    const w = formatWeight(kg, window.weightUnitPreference);
    hint.textContent = `BMI ${value.toFixed(1)} at your latest weight, ${w.value.toFixed(1)} ${w.label}.`;
}

// The typed height → { cm } (null when cleared) or { error }.
function readHeightInput() {
    const text = (id) => (document.getElementById(id)?.value || '').trim().replace(',', '.');
    if (_body.height_unit === 'ftin') {
        const ft = text('settings-height-ft');
        const inch = text('settings-height-in');
        if (!ft && !inch) return { cm: null };
        const f = Number(ft || 0);
        const i = Number(inch || 0);
        const total = f * 12 + i;
        // 3′ 3″ (39 in) – 8′ 2″ (98 in); 39 in is 99.06 cm, so clamp into the stored range.
        if (!Number.isFinite(total) || f < 0 || i < 0 || i >= 12 || total < 39 || total > 98) {
            return { error: HEIGHT_RANGE_ERROR.ftin };
        }
        return { cm: Math.min(HEIGHT_MAX_CM, Math.max(HEIGHT_MIN_CM, Math.round(total * 2.54))) };
    }
    const raw = text('settings-height-input');
    if (!raw) return { cm: null };
    const cm = Math.round(Number(raw));
    if (!Number.isFinite(cm) || cm < HEIGHT_MIN_CM || cm > HEIGHT_MAX_CM) return { error: HEIGHT_RANGE_ERROR.cm };
    return { cm };
}

let _bodyWrites = Promise.resolve(); // module-state: body PATCHes run one at a time
let _bodyPending = 0; // module-state: body writes painted but not yet settled
let _bodyFailed = false; // module-state: a write in the current run of pending writes failed
let _bodyConfirmed = { ..._body }; // module-state: the last server-confirmed body settings

// A bundle repaint with no body write in flight is the confirmed state.
function applyBundleBody(body) {
    if (_bodyPending === 0 && body) _bodyConfirmed = { ..._bodyConfirmed, ...body };
    paintBodySettings(body);
}

// Optimistic partial patch (rule 9): paint at once, then settings_bundle +
// PATCH on one serial queue, each settling before the next starts. A failure
// never restores a snapshot: once every pending write has settled, the form
// repaints from the confirmed baseline (successes merged in, failures not).
function saveBodySettings(patch) {
    paintBodySettings(patch);
    _bodyPending++;
    const run = _bodyWrites.then(async () => {
        const ds = window.DataStore;
        let handle = null;
        let ok = false;
        try {
            if (ds && typeof ds.applyOptimistic === 'function') {
                handle = await ds.applyOptimistic('settings_bundle',
                    (prev) => (prev ? { ...prev, body: { ...(prev.body || {}), ...patch } } : prev),
                    ['settings', 'food_targets', 'feature_settings']);
            }
            // apiCall surfaces its own failure (null).
            ok = !!(await apiCall('/api/settings/body', 'PATCH', patch));
            if (ok) {
                await handle?.commit();
                _bodyConfirmed = { ..._bodyConfirmed, ...patch };
            } else {
                await handle?.rollback();
            }
        } catch (e) {
            ok = false;
            await handle?.rollback();
            console.error('Failed to save body settings:', e);
            safeToast('Failed to save', 'error');
        }
        if (!ok) _bodyFailed = true;
        if (--_bodyPending === 0 && _bodyFailed) {
            _bodyFailed = false;
            paintBodySettings(_bodyConfirmed);
        }
        return ok;
    });
    _bodyWrites = run.catch(() => {});
    return run;
}

async function commitHeight() {
    // Untouched fields never write: 179 cm shows as 5′ 10″, which reads back as 178.
    if (!_heightDirty) return true;
    const typed = readHeightInput();
    if (typed.error) {
        showHeightError(typed.error);
        return false;
    }
    _heightDirty = false;
    if (typed.cm === _body.height_cm) {
        paintBodySettings();
        return true;
    }
    return saveBodySettings({ height_cm: typed.cm });
}

// Units & body with the height field focused: the Weight page's "Add your
// height" nudge (med-a6fb.7) and ?tab=settings&page=units&focus=height.
function openHeightField() {
    if (!_openSettingsPages.has('units')) openSettingsPage('units');
    const id = _body.height_unit === 'ftin' ? 'settings-height-ft' : 'settings-height-input';
    document.getElementById(id)?.focus();
}

(function bindBodySettings() {
    document.getElementById('height-unit-segmented')?.addEventListener('click', (event) => {
        const unit = event.target.closest('[data-height-unit]')?.dataset.heightUnit;
        if (!unit || unit === _body.height_unit) return;
        _heightDirty = false;
        saveBodySettings({ height_unit: unit });
    });
    const markDirty = () => {
        _heightDirty = true;
        paintBmiHint();
    };
    const cmInput = document.getElementById('settings-height-input');
    cmInput?.addEventListener('input', markDirty);
    cmInput?.addEventListener('change', commitHeight);
    // ft + in commits once focus leaves the pair, not between the two fields.
    const ftin = document.getElementById('settings-height-ftin');
    ftin?.addEventListener('input', markDirty);
    ftin?.addEventListener('focusout', (event) => {
        if (!ftin.contains(event.relatedTarget)) commitHeight();
    });
    for (const input of document.querySelectorAll('#settings-height-field .wg-input')) {
        input.addEventListener('keydown', (event) => { if (event.key === 'Enter') input.blur(); });
    }
    // Delegated: the toggle's input is built by <mt-setting-toggle>.
    document.querySelector('.wg-settings-body')?.addEventListener('change', (event) => {
        if (event.target.id === 'settings-show-bmi-toggle') saveBodySettings({ show_bmi: event.target.checked });
    });
    paintBodySettings();
})();

// Public surface mirror — bare names above are the live call path; this object
// documents the module's API and satisfies the globals allowlist.
window.SettingsView = {
    refreshIntegrationsSummary,
    loadSettings,
    openSettingsPage,
    openDevicesDeeplink,
    openHeightField,
    saveTargets,
    mintInvite,
    updateFeatureToggles,
    updateFoodTargetsVisibility,
    toggleFeatureSetting,
    updateFeatureTabVisibility,
    loadGamificationTargets,
    applyGamificationTargets,
    loadGamificationMode,
    saveGamificationMode,
    saveGamificationTargets,
    updateGamificationTargetsVisibility
};
