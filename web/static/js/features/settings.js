// ==================== Settings view ====================
// Extracted from app.js (Plan 2026-06-10 "finish-app-js-split", Task 2).
//
// This file owns the Settings tab's view orchestration: the SWR settings-bundle
// load (loadSettings), the feature-toggle write path (toggleFeatureSetting), the
// feature-toggle / food-targets / nav-visibility DOM sync helpers, the Settings
// stale badge mount, and the OIDC setup banner renderer. These functions remain
// global (script-tag loading) and rely on app.js + sibling globals at call time:
// apiCall, safeAlert, readPersistedTabOrder, switchTab, window.featureSettings,
// window.AuthBootstrap, window.SettingsState, window.WeightUnitState,
// window.FoodLog, window.TimeFormat, window.DataStore, window.WGStaleBadge,
// window.SettingsIntegrations, window.AppStore, window.rebuildCanonicalBottomNav,
// window.OIDC_CONFIG, applyWebpushStatus, hideWebpushStatus (both from app.js).
//
// The timezone info renderer (window.renderSettingsTimeInfo) lives in
// core/time-format.js and the Integrations card lives in
// features/settings/integrations.js — both already extracted; loadSettings()
// delegates to them. The weight-unit (kg/lb) state machine lives in
// features/weight-unit-state.js.
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

function initOIDCSetupBanner() {
    const container = document.getElementById('oidc-setup-container');
    if (!container) return;

    const oidcConfig = window.OIDC_CONFIG || { enabled: false };
    if (!oidcConfig.enabled) {
        container.replaceChildren();
        return;
    }

    const title = document.createElement('h3');
    title.className = 'wg-settings-section__title';
    title.textContent = 'OIDC Setup';

    const desc = document.createElement('p');
    desc.className = 'wg-settings-section__desc';
    desc.textContent = 'Copy redirect URIs for Pocket-ID / OIDC clients.';

    const rowList = document.createElement('div');
    rowList.className = 'wg-settings-row-list';

    const row = document.createElement('div');
    row.className = 'wg-settings-row';

    const rowContent = document.createElement('div');
    rowContent.className = 'wg-settings-row__content';
    const rowTitle = document.createElement('div');
    rowTitle.className = 'wg-settings-row__title wg-mono-display';
    rowTitle.textContent = 'Redirect URIs';
    const rowDesc = document.createElement('div');
    rowDesc.className = 'wg-settings-row__desc';
    rowDesc.textContent = 'Opens the setup page (new tab) to copy redirect URIs and client credentials into your Pocket-ID / OIDC clients.';
    rowContent.appendChild(rowTitle);
    rowContent.appendChild(rowDesc);

    const rowControl = document.createElement('div');
    rowControl.className = 'wg-settings-row__control';
    // Opens in a new tab so the mini-app URL isn't clobbered — returning via
    // browser-back otherwise re-runs handleDeepLinks() with no matching path
    // and switchTab('today') fires as a fallback.
    const actionLink = document.createElement('a');
    actionLink.className = 'wg-gloss wg-settings-action-btn';
    actionLink.textContent = 'Open';
    actionLink.href = '/oidc-setup';
    actionLink.target = '_blank';
    actionLink.rel = 'noopener noreferrer';
    actionLink.setAttribute('aria-label', 'Open OIDC setup page in a new tab');
    rowControl.appendChild(actionLink);

    row.appendChild(rowContent);
    row.appendChild(rowControl);
    rowList.appendChild(row);

    container.replaceChildren();
    container.appendChild(title);
    container.appendChild(desc);
    container.appendChild(rowList);
}

// Cloud-mode Notifications wiring. The server block's Web Push toggle +
// Test buttons POST to bot-mode /api/webpush/* + /api/bp/reminder/test
// routes cmd/cloud never registers, so cloud mode swaps in the
// .wg-settings-notifications-cloud block instead, driven by the DOM-free
// web/cloud/js/push.js + reminders.js primitives (dynamic-imported so
// server/mobile builds never pull in cloud-only modules).
// ponytail: no memoization — import() already caches by specifier. These
// functions exist only as the test seam (Vitest overrides the window globals).
let _cloudNotificationsBound = false; // module-state: one-time guard so the cloud toggle/test click listeners bind once across repeated loadSettings() calls
function loadCloudPushModule() { return import('/js/push.js'); }
function loadCloudRemindersModule() { return import('/js/reminders.js'); }

// status is passed only on the initial bind. After a deliberate Disable click
// the granted-but-unsubscribed state is exactly what the user asked for, and
// warning about it there would stomp the "Notifications disabled" confirmation.
async function refreshCloudPushToggleState(toggleBtn, status) {
    try {
        const { getSubscription } = await loadCloudPushModule();
        const sub = await getSubscription();
        toggleBtn.dataset.subscribed = sub ? '1' : '0';
        toggleBtn.textContent = sub ? 'Disable' : 'Enable';
        // Permission granted but no subscription means the push service evicted
        // it and the boot-time repair could not restore it (med-d5t.3). A bare
        // "Enable" button reads like a device that was never set up, so it would
        // quietly imply reminders are fine. They are not — say so.
        if (!sub && status && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            applyWebpushStatus(status, 'Reminders are not armed on this device — tap Enable to restore them.', 'error');
        }
    } catch (e) {
        toggleBtn.dataset.subscribed = '0';
        toggleBtn.textContent = 'Enable';
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

function bindCloudNotifications() {
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
        toggleBtn.disabled = false;
        testBtn.disabled = false;
    });
    if (_cloudNotificationsBound) return ready;
    _cloudNotificationsBound = true;

    toggleBtn.addEventListener('click', async () => {
        toggleBtn.disabled = true;
        try {
            if (toggleBtn.dataset.subscribed === '1') {
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
                const { sendTestPush } = await loadCloudRemindersModule();
                await sendTestPush(ctx);
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
let _cloudReminderDeliveryBound = false; // module-state: bind the selects once across repeated loadSettings() calls
function bindCloudReminderDelivery() {
    const deliverySel = document.getElementById('cloud-reminder-delivery');
    const verbositySel = document.getElementById('cloud-reminder-verbosity');
    const status = document.getElementById('cloud-reminder-delivery-status');
    if (!deliverySel || !verbositySel || !status) return;

    const ctx = window.MedTrackerCloud?.ctx;
    if (ctx) {
        loadCloudRemindersModule()
            .then(({ remindersDomain }) => remindersDomain(ctx).getDeliveryPref())
            .then((pref) => {
                deliverySel.value = pref.delivery;
                verbositySel.value = pref.verbosity;
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
        deliverySel.disabled = true;
        verbositySel.disabled = true;
        try {
            const { remindersDomain, recomputeAndPush } = await loadCloudRemindersModule();
            await remindersDomain(cloudCtx).setDeliveryPref({
                delivery: deliverySel.value,
                verbosity: verbositySel.value,
            });
            await recomputeAndPush(cloudCtx);
            applyWebpushStatus(status, 'Reminder delivery updated.', 'success');
        } catch (err) {
            applyWebpushStatus(status, err.message || 'Failed to update reminder delivery', 'error');
        }
        deliverySel.disabled = false;
        verbositySel.disabled = false;
        setTimeout(() => hideWebpushStatus(status), 3000);
    };

    deliverySel.addEventListener('change', save);
    verbositySel.addEventListener('change', save);
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
    if (!modal || !urlEl || !qrEl) return;
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
    if (typeof modal.open === 'function') modal.open();
    else modal.classList.remove('hidden');
}

async function mintInvite() {
    const btn = document.getElementById('settings-invite-btn');
    if (btn) btn.disabled = true;
    try {
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
// is gone. Enrollment already exists (/devices → Add a device), but nothing
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
// into thousands of /api/devices requests. The single-device count is stable
// within a session — adding a device navigates through the /devices shell (full
// reload, which re-inits this module) — so one fetch per load is all it needs.
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
    nudge.classList.toggle('wg-settings-hidden', count !== 1);
}

// "What can the operator see?" transparency section (med-d5t.9). The content
// lives in web/cloud/js/privacy.js (cloud-only) and is dynamic-imported here,
// the same seam Settings uses for the cloud push/reminders modules — so a test
// overrides window.loadPrivacyModule instead of resolving a real import.
// ponytail: no memoization — import() caches by specifier. This is only the
// test seam.
function loadPrivacyModule() { return import('/js/privacy.js'); }

let _operatorVisibilityRendered = false; // module-state: render the static content once across repeated loadSettings() calls

async function bindOperatorVisibility() {
    const section = document.querySelector('.wg-settings-privacy');
    const mount = document.getElementById('privacy-content');
    if (!section || !mount) return;
    section.classList.remove('wg-settings-hidden');
    if (_operatorVisibilityRendered) return;
    try {
        const { renderPrivacyInto } = await loadPrivacyModule();
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

    const modal = document.getElementById('delete-account-modal');
    const openBtn = document.getElementById('delete-account-open');
    const cancelBtn = document.getElementById('delete-account-cancel');
    const exportBtn = document.getElementById('delete-account-export');
    const exportStatus = document.getElementById('delete-account-export-status');
    const confirmInput = document.getElementById('delete-account-confirm-input');
    const confirmBtn = document.getElementById('delete-account-confirm');
    const errorEl = document.getElementById('delete-account-error');
    if (!modal || !openBtn || !confirmBtn) return;

    // Prefer the <mt-modal>.open()/.close() methods so the `inert` attribute
    // the component's connectedCallback set (while `.hidden` was present) is
    // cleared on open and restored on close. A raw classList toggle leaves the
    // subtree inert, so the Cancel button never receives the click (med-hzy).
    // Fall back to classList for any shell that mounts without the element.
    const closeModal = () => {
        if (typeof modal.close === 'function') modal.close();
        else modal.classList.add('hidden');
    };
    openBtn.addEventListener('click', () => {
        if (errorEl) errorEl.textContent = '';
        if (exportStatus) exportStatus.textContent = '';
        if (confirmInput) confirmInput.value = '';
        confirmBtn.disabled = true;
        if (typeof modal.open === 'function') modal.open();
        else modal.classList.remove('hidden');
    });
    cancelBtn?.addEventListener('click', closeModal);

    // The typed-confirmation gate: the delete button stays disabled until the
    // exact phrase is entered. One tap must never erase a vault.
    let confirmPhrase = 'delete my account';
    loadAccountDeleteModule().then((m) => { confirmPhrase = m.DELETE_CONFIRM_PHRASE; }).catch(() => {});
    confirmInput?.addEventListener('input', () => {
        confirmBtn.disabled = confirmInput.value.trim().toLowerCase() !== confirmPhrase;
    });

    exportBtn?.addEventListener('click', async () => {
        if (exportStatus) exportStatus.textContent = 'Preparing your export…';
        try {
            const { exportVaultToFile } = await loadAccountDeleteModule();
            await exportVaultToFile();
            if (exportStatus) exportStatus.textContent = 'Export downloaded. Keep it somewhere safe.';
        } catch (err) {
            if (exportStatus) exportStatus.textContent = err.message || 'Export failed.';
        }
    });

    confirmBtn.addEventListener('click', async () => {
        confirmBtn.disabled = true;
        if (errorEl) errorEl.textContent = '';
        try {
            const { reauthAndDelete, clearLocalVault, baseDomainURL } = await loadAccountDeleteModule();
            await reauthAndDelete();
            await clearLocalVault();
            // The subdomain is gone; send the user somewhere that still exists.
            window.location.href = baseDomainURL();
        } catch (err) {
            if (errorEl) errorEl.textContent = err.message || 'Could not delete the account.';
            confirmBtn.disabled = false;
        }
    });
}

function bindCloudInvite() {
    document.querySelector('.wg-settings-cloud-invite')?.classList.remove('wg-settings-hidden');
    if (_inviteBound) return;
    _inviteBound = true;
    document.getElementById('settings-invite-btn')?.addEventListener('click', mintInvite);
    document.getElementById('invite-close-btn')?.addEventListener('click', () => {
        const modal = document.getElementById('invite-modal');
        if (!modal) return;
        if (typeof modal.close === 'function') modal.close();
        else modal.classList.add('hidden');
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

// Load settings (BP reminders status, etc.)
async function loadSettings() {
    // Ungated: the first-run overlay ships in the server, cloud, and mobile
    // builds alike, so the row is not wrapped in a wg-settings-cloud-* reveal.
    bindRerunOnboarding();
    if (window.__MEDTRACKER_CLOUD__) {
        document.querySelector('.wg-settings-timezone')?.classList.add('wg-settings-hidden');
        document.querySelector('.wg-settings-notifications')?.classList.add('wg-settings-hidden');
        // The Sync pane reports the bot-mode offline queue drained against
        // /api/changes. Cloud mode replaces that wholesale with the encrypted
        // oplog sync engine, which never touches this status bar — so the pane
        // sits empty under its own heading (med-8q2).
        document.querySelector('.wg-settings-sync')?.classList.add('wg-settings-hidden');
        // weekly_digest is a bot/server-mode scheduler feature (Telegram Sunday
        // summary); cloud mode has no digest sender and clamps the flag to false,
        // so hide the dead toggle row rather than render a no-op control (med-eas.44).
        document.querySelector('mt-setting-toggle[input-id="weekly-digest-feature-toggle"]')?.classList.add('wg-settings-hidden');
        document.querySelector('.wg-settings-notifications-cloud')?.classList.remove('wg-settings-hidden');
        await bindCloudNotifications();
        // Devices row (add/manage a second device) only makes sense in cloud
        // mode — server/mobile builds have no /devices shell route.
        document.querySelector('.wg-settings-cloud-devices')?.classList.remove('wg-settings-hidden');
        await bindSecondDeviceNudge();
        await bindOperatorVisibility();
        bindDeleteAccount();
        bindCloudInvite();
    }
    const applyBundle = async (rawBundle) => {
        const bundle = window.AuthBootstrap.normalizeSettingsBundle(rawBundle);
        window.SettingsState.applyBootstrapFeatures(bundle.featureSettings);
        window.WeightUnitState.applyAuthoritative(bundle.weightUnitPreference);
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
        window.TimeFormat.render(bundle);
        window.TimeFormat.ensureTimer();
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
            serverTime: settingsRes?.server_time || '',
            serverTimezone: settingsRes?.server_timezone || '',
            dismissedTzSuggestion: settingsRes?.dismissed_tz_suggestion || '',
            weightUnitPreference: settingsRes?.weight_unit_preference || window.weightUnitPreference || 'kg',
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

    // Mount the stale badge from the bootstrap-warmed settings_bundle row so
    // the user can see "Offline · 2h old" when Settings is opened on a cold
    // start without network — and "Updated just now" after the SWR fetch
    // lands a fresh bundle. Best-effort: never blocks Settings render.
    const mountStaleBadge = async () => {
        try { await renderSettingsStaleBadge(); } catch (_) { /* no-op */ }
    };

    try {
        await window.DataStore.loadSWR({
            key: 'settings_bundle',
            tags: ['settings', 'food_targets', 'feature_settings'],
            fetcher: fetchBundle,
            onCached: async (cached) => {
                await applyBundle(cached);
                await mountStaleBadge();
            },
            onFresh: async (fresh) => {
                await applyBundle(fresh);
                await mountStaleBadge();
            },
            onError: async (error, cached) => {
                console.error('Failed to load settings:', error);
                if (cached) applyBundle(cached);
                await mountStaleBadge();
            }
        });
    } catch (error) {
        console.error('Failed to load settings:', error);
    }
    // Safety-net mount for the case where no callback fires (e.g., no cached
    // row AND fetcher returns null) — mountFromKey gracefully no-ops if
    // there's nothing to surface.
    await mountStaleBadge();
    // The Integrations section is loaded lazily from its own endpoint so
    // the settings_bundle SWR fetch stays focused on the feature-flags +
    // food-targets + reminders + weight-unit slice that bootstrap also
    // returns. Best-effort: never blocks the rest of Settings.
    if (window.SettingsIntegrations && typeof window.SettingsIntegrations.load === 'function') {
        try { await window.SettingsIntegrations.load(); } catch (_) { /* no-op */ }
    }
    // Import/Export section (C2e Task 6) — static, so load() just (re)binds its
    // controls; safe in both bot and cloud modes.
    if (window.SettingsImportExport && typeof window.SettingsImportExport.load === 'function') {
        try { window.SettingsImportExport.load(); } catch (_) { /* no-op */ }
    }
    // Journey targets editor — loaded lazily off its own endpoint (best-effort;
    // internally gated on the gamification flag).
    await loadGamificationTargets();
    // Collapse any <details> group whose sections are all hidden (e.g. a
    // cloud-only group in bot mode) so an empty fold doesn't render.
    hideEmptySettingsGroups();
}

// Hide a collapsible settings <details> group when every .wg-settings-section
// inside it is hidden. Per-section gating stays the source of truth; this only
// rolls the group visibility up from it.
function hideEmptySettingsGroups() {
    document.querySelectorAll('.wg-settings-group').forEach((group) => {
        const sections = group.querySelectorAll('.wg-settings-section');
        const allHidden = sections.length > 0 && Array.from(sections).every(isSettingsSectionHidden);
        group.classList.toggle('wg-settings-hidden', allHidden);
    });
}

// A section counts as hidden when any of its gating mechanisms has hidden it:
// the wg-settings-hidden / hidden class toggles, an inline style.display='none'
// (food-target-settings), or the CSS `.wg-settings-oidc:empty` rule (the OIDC
// container once its setup banner has left it empty). Missing any of these
// leaves an all-hidden group rendering as an empty fold.
function isSettingsSectionHidden(s) {
    return s.matches('.wg-settings-hidden, .hidden, [hidden]')
        || s.style.display === 'none'
        || (s.matches('.wg-settings-oidc') && s.childElementCount === 0);
}

// Mounts the wg-stale-badge into the Settings section header from the
// `settings_bundle` api_cache row (warmed by /api/bootstrap and refreshed by
// loadSettings()'s SWR fetcher). Mirrors the BP/Weight/Workout/Health pattern.
async function renderSettingsStaleBadge() {
    const slot = document.getElementById('settings-stale-badge');
    if (!slot) return;
    const api = (typeof window !== 'undefined') ? window.WGStaleBadge : null;
    if (!api || typeof api.mountFromKey !== 'function') {
        slot.replaceChildren();
        slot.classList.add('hidden');
        return;
    }
    await api.mountFromKey({ slot, key: 'settings_bundle' });
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
}

function updateFoodTargetsVisibility() {
    const settingsBlock = document.getElementById('food-target-settings');
    if (!settingsBlock) return;
    settingsBlock.style.display = window.featureSettings.food ? 'flex' : 'none';
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
    if (!window.featureSettings || !window.featureSettings.gamification) return;
    try {
        const view = await apiCall('/api/gamification/targets', 'GET');
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
async function saveGamificationTargets() {
    const targets = [];
    for (const key of GAMIFICATION_TARGET_METRICS) {
        const lowEl = document.getElementById(`gam-target-${key}-low`);
        const highEl = document.getElementById(`gam-target-${key}-high`);
        if (!lowEl || !highEl) continue;
        const lowStr = lowEl.value.trim();
        const highStr = highEl.value.trim();
        const low = lowStr === '' ? null : Number(lowStr);
        const high = highStr === '' ? null : Number(highStr);
        const pretty = key.replace(/_/g, ' ');
        // Client-side guard against obviously unsafe values before the PUT (the
        // service validates the same, but catch it early for a clearer message).
        if ((low !== null && (Number.isNaN(low) || low < 0)) || (high !== null && (Number.isNaN(high) || high < 0))) {
            safeAlert(`Enter valid non-negative numbers for ${pretty}`);
            return;
        }
        if (low !== null && high !== null && low > high) {
            safeAlert(`${pretty}: low must not exceed high`);
            return;
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
        safeAlert('Failed to save targets');
        return;
    }
    if (!res) {
        if (handle) await handle.rollback();
        // apiCall already surfaced the failure alert for the write; don't stack a second.
        return;
    }
    if (handle) await handle.commit(null);
    applyGamificationTargets(res);
    try { await ds.invalidateTags(['gamification']); } catch (_) { /* best-effort */ }
    safeAlert('Targets saved');
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
    updateFoodTargetsVisibility();
    updateGamificationTargetsVisibility();
    // A toggle just changed a target section's visibility; roll that back up to
    // the parent <details> group so an all-hidden Targets fold doesn't linger
    // (and reappears when a target is re-enabled) without a full Settings reload.
    hideEmptySettingsGroups();
}

window.initOIDCSetupBanner = initOIDCSetupBanner;

// Public surface mirror — bare names above are the live call path; this object
// documents the module's API and satisfies the globals allowlist.
window.SettingsView = {
    initOIDCSetupBanner,
    loadSettings,
    mintInvite,
    renderSettingsStaleBadge,
    updateFeatureToggles,
    updateFoodTargetsVisibility,
    toggleFeatureSetting,
    updateFeatureTabVisibility,
    loadGamificationTargets,
    applyGamificationTargets,
    saveGamificationTargets,
    updateGamificationTargetsVisibility
};
