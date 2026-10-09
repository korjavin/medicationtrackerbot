import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const INDEX_HTML = path.join(REPO_ROOT, 'web/static/index.html');

function loadIndex() {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const dom = new JSDOM(html, { url: 'https://example.test/' });
    return { dom, cleanup: () => dom.window.close() };
}

const featuresPage = (doc) => doc.querySelector('[data-settings-page="features"]');
const eyebrows = (section) => section.querySelector('.wg-section__head .wg-eyebrow')?.textContent.trim();

describe('Settings Features page (kit S2, med-xso6.23)', () => {
    it('groups the feature toggles by intent: Tracking, Journey, Safety, Labs', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const doc = dom.window.document;
            const sections = Array.from(featuresPage(doc).querySelectorAll(':scope > .wg-section'));
            const groups = sections.map((s) => [
                eyebrows(s),
                Array.from(s.querySelectorAll('mt-setting-toggle')).map((t) => t.getAttribute('input-id')),
            ]);
            expect(groups).toEqual([
                ['Tracking · shown in the nav', [
                    'bp-feature-toggle', 'weight-feature-toggle', 'food-intake-toggle',
                    'medication-feature-toggle', 'workout-feature-toggle', 'health-feature-toggle',
                ]],
                ['Journey', ['gamification-feature-toggle', 'weekly-digest-feature-toggle']],
                ['Safety', ['gam-mode-ed-safe-toggle']],
                ['Labs', ['live-hr-feature-toggle']],
            ]);
            for (const s of sections) expect(s.querySelector(':scope > .wg-list')).not.toBeNull();
        } finally {
            cleanup();
        }
    });

    it('folds Experiments / Traits / AI story into one Journey row that opens their own page', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const doc = dom.window.document;
            const fold = featuresPage(doc).querySelector('[data-settings-open="journey-extras"]');
            expect(fold).not.toBeNull();
            expect(fold.classList.contains('wg-setting')).toBe(true);
            const extras = doc.querySelector('[data-settings-page="journey-extras"]');
            expect(Array.from(extras.querySelectorAll('mt-setting-toggle')).map((t) => t.getAttribute('input-id')))
                .toEqual(['gam-mode-experiments-toggle', 'gam-mode-traits-toggle', 'gam-mode-narration-toggle']);
            // 13 toggles across the two pages.
            const all = doc.querySelectorAll('[data-settings-page="features"] mt-setting-toggle, [data-settings-page="journey-extras"] mt-setting-toggle');
            expect(all.length).toBe(13);
        } finally {
            cleanup();
        }
    });

    it('uses plain names — no "Feature:" prefixes', () => {
        const { dom, cleanup } = loadIndex();
        try {
            for (const t of dom.window.document.querySelectorAll('#settings-view mt-setting-toggle')) {
                expect(t.getAttribute('title')).not.toMatch(/^Feature:|^Journey:/);
            }
        } finally {
            cleanup();
        }
    });

    it('renders <mt-setting-toggle> as a kit .wg-setting row with an aria-labelled .wg-toggle', () => {
        const { document, cleanup } = loadFrontendEnv();
        try {
            const bp = document.getElementById('bp-feature-toggle').closest('mt-setting-toggle');
            expect(bp.classList.contains('wg-setting')).toBe(true);
            expect(bp.querySelector('.wg-row__lead .wg-ico').dataset.icon).toBe('activity');
            expect(bp.querySelector('.wg-setting__title').textContent).toBe('Blood pressure');
            expect(bp.hasAttribute('title')).toBe(false); // no hover tooltip on the row
            const input = bp.querySelector('.wg-toggle > .wg-toggle__input');
            expect(input.getAttribute('aria-label')).toBe('Blood pressure');
        } finally {
            cleanup();
        }
    });
});

describe('Settings Reminders section (notifications page)', () => {
    it('mounts both reminder toggles in the Reminders section of the notifications page', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const doc = dom.window.document;
            const reminders = doc.querySelector('[data-settings-page="notifications"] .wg-settings-reminders');
            expect(eyebrows(reminders)).toBe('Reminders');
            expect(Array.from(reminders.querySelectorAll('.wg-list mt-setting-toggle')).map((t) => t.getAttribute('input-id')))
                .toEqual(['bp-reminders-toggle', 'weight-reminders-toggle']);
            expect(featuresPage(doc).querySelector('[input-id="bp-reminders-toggle"]')).toBeNull();
        } finally {
            cleanup();
        }
    });
});

describe('Settings toggle `divider` attribute (Phase 9, Task 5)', () => {
    it('removes the `divider` attribute from all feature + reminder toggles in markup', () => {
        const { dom, cleanup } = loadIndex();
        try {
            for (const el of dom.window.document.querySelectorAll('#settings-view mt-setting-toggle')) {
                expect(el.hasAttribute('divider')).toBe(false);
            }
        } finally {
            cleanup();
        }
    });

    it('keeps the `divider` attribute working for backwards compatibility (still applies .setting-item-divider)', () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            const manual = document.createElement('mt-setting-toggle');
            manual.setAttribute('title', 'Legacy Toggle');
            manual.setAttribute('description', 'Created with divider attr');
            manual.setAttribute('input-id', 'legacy-divider-toggle');
            manual.setAttribute('divider', '');
            document.body.appendChild(manual);

            expect(manual.classList.contains('setting-item-divider')).toBe(true);
            expect(manual.classList.contains('wg-setting')).toBe(true);
        } finally {
            cleanup();
        }
    });
});

describe('Feature toggle round-trip via window.toggleFeatureSetting (Phase 9, Task 5)', () => {
    it('window.toggleFeatureSetting persists feature and invalidates settings tags', async () => {
        const { window, cleanup } = loadFrontendEnv();
        try {
            const apiCallSpy = vi.fn().mockResolvedValue({ ok: true });
            const invalidateSpy = vi.fn().mockResolvedValue(undefined);
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = invalidateSpy;

            await window.toggleFeatureSetting('health', true);

            const call = apiCallSpy.mock.calls.find(
                (args) => typeof args[0] === 'string' && args[0] === '/api/settings/features/health'
            );
            expect(call).toBeDefined();
            expect(call[1]).toBe('POST');
            expect(call[2]).toEqual({ enabled: true });
            expect(invalidateSpy).toHaveBeenCalledWith(['settings', 'feature_settings']);
        } finally {
            cleanup();
        }
    });

    it('window.toggleFeatureSetting persists gamification and flipping the toggle drives it', async () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            const apiCallSpy = vi.fn().mockResolvedValue({ ok: true });
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);

            await window.toggleFeatureSetting('gamification', true);
            let call = apiCallSpy.mock.calls.find(
                (args) => args[0] === '/api/settings/features/gamification'
            );
            expect(call).toBeDefined();
            expect(call[1]).toBe('POST');
            expect(call[2]).toEqual({ enabled: true });

            // Flipping the checkbox drives the same POST via the change listener.
            apiCallSpy.mockClear();
            const toggle = document.getElementById('gamification-feature-toggle');
            toggle.checked = false;
            toggle.dispatchEvent(new window.Event('change'));
            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));

            call = apiCallSpy.mock.calls.find(
                (args) => args[0] === '/api/settings/features/gamification'
            );
            expect(call).toBeDefined();
            expect(call[2]).toEqual({ enabled: false });
        } finally {
            cleanup();
        }
    });

    it('window.toggleFeatureSetting reverts DOM when apiCall fails', async () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            const apiCallSpy = vi.fn().mockResolvedValue(null);
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);

            // set up initial state
            window.featureSettings = { health: false };
            const checkbox = document.getElementById('health-feature-toggle');
            checkbox.checked = true; // user clicked it

            await window.toggleFeatureSetting('health', true);

            expect(apiCallSpy).toHaveBeenCalledWith('/api/settings/features/health', 'POST', { enabled: true });

            // Should be reverted back to false based on window.featureSettings
            expect(checkbox.checked).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('window.toggleFeatureSetting routes each feature key to /api/settings/features/<feature>', async () => {
        const { window, cleanup } = loadFrontendEnv();
        try {
            const apiCallSpy = vi.fn().mockResolvedValue({ ok: true });
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);

            const features = ['bp', 'weight', 'workout', 'medication', 'food', 'health'];
            for (const feature of features) {
                apiCallSpy.mockClear();
                await window.toggleFeatureSetting(feature, false);
                const call = apiCallSpy.mock.calls.find(
                    (args) => typeof args[0] === 'string' && args[0] === `/api/settings/features/${feature}`
                );
                expect(call, `expected POST /api/settings/features/${feature}`).toBeDefined();
                expect(call[1]).toBe('POST');
                expect(call[2]).toEqual({ enabled: false });
            }
        } finally {
            cleanup();
        }
    });

    it('feature-toggle checkboxes exist with expected ids after harness boot', () => {
        const { document, cleanup } = loadFrontendEnv();
        try {
            const ids = [
                'bp-feature-toggle',
                'weight-feature-toggle',
                'workout-feature-toggle',
                'medication-feature-toggle',
                'food-intake-toggle',
                'health-feature-toggle',
                'gamification-feature-toggle',
                'weekly-digest-feature-toggle',
                'live-hr-feature-toggle',
            ];
            for (const id of ids) {
                const input = document.getElementById(id);
                expect(input, `missing input#${id}`).not.toBeNull();
                expect(input.type).toBe('checkbox');
            }
        } finally {
            cleanup();
        }
    });
});

describe('Reminder toggle round-trip via change event (Phase 9, Task 5)', () => {
    it('flipping bp-reminders-toggle on hits POST /api/bp/reminder/toggle with enabled:true', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            const apiCallSpy = vi.fn().mockResolvedValue({ ok: true });
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);

            const toggle = document.getElementById('bp-reminders-toggle');
            expect(toggle).not.toBeNull();
            toggle.checked = true;
            toggle.dispatchEvent(new window.Event('change'));

            // Flush microtasks so both bound handlers finish before cleanup.
            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));

            const call = apiCallSpy.mock.calls.find(
                (args) => typeof args[0] === 'string' && args[0] === '/api/bp/reminder/toggle'
            );
            expect(call).toBeDefined();
            expect(call[1]).toBe('POST');
            expect(call[2]).toEqual({ enabled: true });
            expect(toggle.checked).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('flipping weight-reminders-toggle off hits POST /api/weight/reminder/toggle with enabled:false', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            const apiCallSpy = vi.fn().mockResolvedValue({ ok: true });
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);

            const toggle = document.getElementById('weight-reminders-toggle');
            expect(toggle).not.toBeNull();
            toggle.checked = false;
            toggle.dispatchEvent(new window.Event('change'));

            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));

            const call = apiCallSpy.mock.calls.find(
                (args) => typeof args[0] === 'string' && args[0] === '/api/weight/reminder/toggle'
            );
            expect(call).toBeDefined();
            expect(call[1]).toBe('POST');
            expect(call[2]).toEqual({ enabled: false });
            expect(toggle.checked).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('reminder toggle reverts its checked state when the API call fails', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            const apiCallSpy = vi.fn().mockResolvedValue(null);
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);

            const toggle = document.getElementById('bp-reminders-toggle');
            toggle.checked = true;
            toggle.dispatchEvent(new window.Event('change'));

            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(apiCallSpy).toHaveBeenCalled();
            expect(toggle.checked).toBe(false);
        } finally {
            cleanup();
        }
    });
});

describe('Settings toggle disabled-state (Phase 9, Task 5)', () => {
    it('setting the checkbox to disabled reflects in the hidden input state', () => {
        const { document, cleanup } = loadFrontendEnv();
        try {
            const toggle = document.getElementById('bp-feature-toggle');
            expect(toggle).not.toBeNull();
            toggle.disabled = true;
            expect(toggle.disabled).toBe(true);

            toggle.disabled = false;
            expect(toggle.disabled).toBe(false);
        } finally {
            cleanup();
        }
    });
});

// ----------------------------------------------------------------------------
// Settings view extraction → features/settings.js (Plan 2026-06-10
// finish-app-js-split, Task 2). These exercise the moved code path through the
// frontend harness (which now loads features/settings.js after app.js):
//   • warm-cache render — applyBundle paints toggles + macros
//   • feature-toggle flips nav visibility — rebuildCanonicalBottomNav re-mount
//     + updateFeatureTabVisibility bounce to Today when the active section's
//     feature is turned off
//   • error/revert — apiCall null restores the toggle, skips the write side
// (warm-cache is also pinned in settings.refresh-on-mount.test.js;
//  here we assert the DOM-level outcome of the extracted applyBundle.)
// ----------------------------------------------------------------------------

function installSettingsBundleCache(window, bundle, timestamp) {
    const map = new Map([['settings_bundle', { id: 'settings_bundle', data: bundle, timestamp }]]);
    window.MedTrackerDB = window.MedTrackerDB || {};
    window.MedTrackerDB.ApiCache = {
        async get(key) { const e = map.get(key); return e ? e.data : null; },
        async getWithMeta(key) { const e = map.get(key); return e ? { data: e.data, timestamp: e.timestamp } : null; },
        async set(key, data) { map.set(key, { id: key, timestamp: Date.now(), data }); },
        async setWithMeta(key, data, ts) { map.set(key, { id: key, timestamp: ts, data }); },
        async clear(key) { if (key) map.delete(key); else map.clear(); }
    };
    return map;
}

function setOnline(window, online) {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
}

describe('Settings view extraction → features/settings.js (Plan 2026-06-10 Task 2)', () => {
    it('loadSettings renders feature toggles, food macros from a warm cache (offline)', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            const bundle = {
                featureSettings: { medication: true, workout: false, food: true, bp: true, weight: false, health: true },
                tabOrder: null,
                timezone: 'Europe/Berlin',
                serverTime: new Date().toISOString(),
                serverTimezone: 'UTC',
                weightUnitPreference: 'kg',
                foodTargets: { calories: 1850, carbs: 190, protein: 125, fat: 62 },
                bpReminderStatus: { enabled: true },
                weightReminderStatus: { enabled: false }
            };
            installSettingsBundleCache(window, bundle, Date.now() - 90 * 60 * 1000); // 90 min old
            await window.hydrateSectionsFromDexie();

            // Offline: the fetcher throws so onCached (and the onError fallback)
            // paint the cached bundle without the network advancing anything.
            setOnline(window, false);
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });

            await window.loadSettings();

            // Feature toggle checkboxes mirror the cached flags.
            expect(document.getElementById('medication-feature-toggle').checked).toBe(true);
            expect(document.getElementById('workout-feature-toggle').checked).toBe(false);
            expect(document.getElementById('food-intake-toggle').checked).toBe(true);
            expect(document.getElementById('weight-feature-toggle').checked).toBe(false);
            // Food macro inputs reflect the cached targets.
            expect(document.getElementById('food-target-calories').value).toBe('1850');
            expect(document.getElementById('food-target-protein').value).toBe('125');
            // Reminder toggles mirror the cached statuses.
            expect(document.getElementById('bp-reminders-toggle').checked).toBe(true);
            expect(document.getElementById('weight-reminders-toggle').checked).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('toggling the active section\'s feature OFF re-mounts the canonical nav and bounces to Today', async () => {
        allowConsoleNoise();
        const { window, cleanup } = loadFrontendEnv();
        try {
            window.SettingsState.applyBootstrapFeatures({
                medication: true, workout: true, food: true, bp: true, weight: true, health: true
            });
            window.AppStore.set('currentTab', 'workouts');

            window.apiCall = vi.fn().mockResolvedValue({ ok: true });
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
            const rebuildSpy = vi.fn();
            window.rebuildCanonicalBottomNav = rebuildSpy;
            const switchTabSpy = vi.fn();
            window.switchTab = switchTabSpy;

            await window.toggleFeatureSetting('workout', false);

            // The write succeeded → state flips, nav re-mounts with new flags.
            expect(window.featureSettings.workout).toBe(false);
            expect(rebuildSpy).toHaveBeenCalledTimes(1);
            // updateFeatureTabVisibility saw the active 'workouts' tab map to the
            // now-disabled 'workout' feature and bounced to Today.
            expect(switchTabSpy).toHaveBeenCalledWith('today');
        } finally {
            cleanup();
        }
    });

    it('toggling a NON-active feature OFF re-mounts the nav but does not bounce away from the current tab', async () => {
        allowConsoleNoise();
        const { window, cleanup } = loadFrontendEnv();
        try {
            window.SettingsState.applyBootstrapFeatures({
                medication: true, workout: true, food: true, bp: true, weight: true, health: true
            });
            window.AppStore.set('currentTab', 'today');

            window.apiCall = vi.fn().mockResolvedValue({ ok: true });
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
            window.rebuildCanonicalBottomNav = vi.fn();
            const switchTabSpy = vi.fn();
            window.switchTab = switchTabSpy;

            await window.toggleFeatureSetting('weight', false);

            expect(window.featureSettings.weight).toBe(false);
            expect(window.rebuildCanonicalBottomNav).toHaveBeenCalledTimes(1);
            // Active tab is Today (no feature) → no bounce.
            expect(switchTabSpy).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('a failed feature toggle (apiCall null) reverts the checkbox and skips the write side-effects', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            // Authoritative state: food is OFF.
            window.SettingsState.applyBootstrapFeatures({
                medication: true, workout: true, food: false, bp: true, weight: true, health: true
            });
            // Simulate the user flipping the checkbox ON in the DOM before the
            // POST that is about to fail.
            const foodToggle = document.getElementById('food-intake-toggle');
            foodToggle.checked = true;

            window.apiCall = vi.fn().mockResolvedValue(null); // failure
            const setFeatureSpy = vi.spyOn(window.SettingsState, 'setFeature');
            const invalidateSpy = vi.fn().mockResolvedValue(undefined);
            window.DataStore.invalidateTags = invalidateSpy;
            window.rebuildCanonicalBottomNav = vi.fn();

            await window.toggleFeatureSetting('food', true);

            // updateFeatureToggles re-synced the checkbox back to the (still OFF)
            // authoritative state so the UI doesn't lie.
            expect(foodToggle.checked).toBe(false);
            // The write side-effects never ran on the failure path.
            expect(setFeatureSpy).not.toHaveBeenCalled();
            expect(invalidateSpy).not.toHaveBeenCalled();
            expect(window.rebuildCanonicalBottomNav).not.toHaveBeenCalled();
            expect(window.featureSettings.food).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('weekly-digest toggle: shown only with gamification on (both-on gate, med-eas.58)', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            const weeklyDigest = () => document.querySelector('mt-setting-toggle[input-id="weekly-digest-feature-toggle"]');
            await window.loadSettings(); // mount the DOM

            // Gamification on: visible (the toggle drives the digest push).
            window.featureSettings = { weekly_digest: true, gamification: true };
            window.SettingsView.updateFeatureToggles();
            expect(weeklyDigest().classList.contains('wg-settings-hidden')).toBe(false);

            // Gamification off: hidden (both-on gate).
            window.featureSettings = { weekly_digest: true, gamification: false };
            window.SettingsView.updateFeatureToggles();
            expect(weeklyDigest().classList.contains('wg-settings-hidden')).toBe(true);
        } finally {
            cleanup();
        }
    });

    // med-8tur.12: the Journey mode switches share the gamification gate, load
    // from GET /api/gamification/mode, PUT one key per flip, and revert on failure.
    it('Journey mode switches: gated on gamification, loaded from and written to /api/gamification/mode', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            const row = (id) => document.querySelector(`mt-setting-toggle[input-id="${id}"]`);
            const ids = ['gam-mode-experiments-toggle', 'gam-mode-traits-toggle', 'gam-mode-narration-toggle', 'gam-mode-ed-safe-toggle'];
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();

            window.featureSettings = { gamification: false };
            window.SettingsView.updateFeatureToggles();
            for (const id of ids) expect(row(id).classList.contains('wg-settings-hidden')).toBe(true);
            window.featureSettings = { gamification: true };
            window.SettingsView.updateFeatureToggles();
            for (const id of ids) expect(row(id).classList.contains('wg-settings-hidden')).toBe(false);

            window.apiCall = vi.fn(async (url, method, body) => {
                if (method === 'GET') return { enabled: true, ed_safe: false, experiments: true, traits: false, narration: true };
                return { enabled: true, ed_safe: body.ed_safe === true, experiments: true, traits: false, narration: true };
            });
            await window.SettingsView.loadGamificationMode();
            expect(document.getElementById('gam-mode-traits-toggle').checked).toBe(false);
            expect(document.getElementById('gam-mode-experiments-toggle').checked).toBe(true);

            const edSafe = document.getElementById('gam-mode-ed-safe-toggle');
            edSafe.checked = true;
            edSafe.dispatchEvent(new window.Event('change'));
            await vi.waitFor(() => expect(window.apiCall).toHaveBeenCalledWith('/api/gamification/mode', 'PUT', { ed_safe: true }));

            // A failed write restores the switch.
            window.apiCall = vi.fn(async () => null);
            await window.SettingsView.saveGamificationMode('narration', false);
            expect(document.getElementById('gam-mode-narration-toggle').checked).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('shows the Devices row only when window.__MEDTRACKER_CLOUD__ is set (server/mobile builds never render it)', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });

            delete window.__MEDTRACKER_CLOUD__; // harness defaults to cloud; test the bot-first branch
            await window.loadSettings();
            expect(document.querySelector('.wg-settings-cloud-devices').classList.contains('wg-settings-hidden')).toBe(true);

            window.__MEDTRACKER_CLOUD__ = true;
            await window.loadSettings();
            expect(document.querySelector('.wg-settings-cloud-devices').classList.contains('wg-settings-hidden')).toBe(false);
            // med-xso6.25: no more links out to the passkey shell's /devices and
            // /connectors pages — both are in-app pages now.
            expect(document.querySelector('[data-settings-page="devices"] a[href="/devices"], [data-settings-page="devices"] a[href="/connectors"]')).toBeNull();
        } finally {
            delete window.__MEDTRACKER_CLOUD__;
            cleanup();
        }
    });

    // med-xso6.25 (kit S4–S5): the device list, add-device transfer and Claude
    // connector render inside Settings pages from the cloud modules
    // (web/cloud/js/devices.js, transfer.js, connectors.js — their own suites
    // cover the rendering); this pins the bridge. The modules come in through
    // the load*Module seams, like the privacy module above.
    describe('Devices & connectors page', () => {
        const installCloudModules = (window) => {
            const flow = { cancel: vi.fn(async () => true), stop: vi.fn() };
            const devices = {
                renderDeviceList: vi.fn((mount, ctx, hooks) => {
                    mount.innerHTML = '<button type="button" id="add-device-button" class="wg-btn wg-btn--primary">Add a device</button>';
                    mount.querySelector('#add-device-button').addEventListener('click', hooks.onAddDevice);
                    hooks.onLoaded([{}, {}]);
                }),
            };
            const transfer = { renderAddDevice: vi.fn(() => flow) };
            const connectors = { renderConnectors: vi.fn(), claudeConnectorMode: vi.fn(async () => 'remote') };
            window.loadCloudDevicesModule = () => Promise.resolve(devices);
            window.loadCloudTransferModule = () => Promise.resolve(transfer);
            window.loadCloudConnectorsModule = () => Promise.resolve(connectors);
            return { flow, devices, transfer, connectors };
        };

        const mountCloud = async (window) => {
            window.__MEDTRACKER_CLOUD__ = true;
            window.MedTrackerCloud = { ctx: { accountId: 'acct-1', dek: 'dek' } };
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            window.fetch = vi.fn(async () => ({ ok: true, json: async () => [{ credential_id: 'c', created_at: '2026-07-01T00:00:00Z' }] }));
            await window.loadSettings();
        };

        const topPage = (document) => Array.from(document.querySelectorAll('mt-modal.wg-page[id^="wg-page-"]')).pop();
        const topTitle = (document) => topPage(document)?.querySelector('.wg-pagebar__title').textContent;

        it('mounts the device list into the pushed page and refreshes the row summaries from it', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                const m = installCloudModules(window);
                await mountCloud(window);

                const page = window.SettingsView.openSettingsPage('devices');
                await vi.waitFor(() => expect(m.devices.renderDeviceList).toHaveBeenCalledTimes(1));
                const [mount, ctx] = m.devices.renderDeviceList.mock.calls[0];
                expect(mount.id).toBe('settings-devices-mount');
                expect(page.el.contains(mount)).toBe(true);
                expect(ctx.accountId).toBe('acct-1');

                await vi.waitFor(() => expect(document.querySelector('[data-settings-summary="devices"]').textContent).toBe('2 devices'));
                await vi.waitFor(() => expect(document.getElementById('settings-claude-connector-status').textContent).toBe('Remote · claude.ai / ChatGPT'));

                // Kit S4: "Add a device" is the page's one sun primary; the
                // Emergency Kit row is sensitive (danger) but not a primary.
                expect(page.el.querySelectorAll('.wg-btn--primary')).toHaveLength(1);
                const kit = document.getElementById('settings-emergency-kit-row');
                expect(kit.classList.contains('wg-setting--danger')).toBe(true);
                expect(page.el.contains(kit)).toBe(true);
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });

        it('Add a device pushes the transfer page, whose Back cancels the code server-side first', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                const m = installCloudModules(window);
                await mountCloud(window);
                const page = window.SettingsView.openSettingsPage('devices');
                await vi.waitFor(() => expect(m.devices.renderDeviceList).toHaveBeenCalledTimes(1));

                page.el.querySelector('#add-device-button').click();
                await vi.waitFor(() => expect(topTitle(document)).toBe('Add a device'));
                const [body, ctx] = m.transfer.renderAddDevice.mock.calls[0];
                expect(topPage(document).contains(body)).toBe(true);
                expect(ctx.accountId).toBe('acct-1');

                // A failed cancel keeps the page: leaving would imply the code is dead.
                m.flow.cancel.mockResolvedValueOnce(false);
                topPage(document).querySelector('.wg-back').click();
                await vi.waitFor(() => expect(m.flow.cancel).toHaveBeenCalledTimes(1));
                await new Promise((r) => setTimeout(r, 0));
                expect(topTitle(document)).toBe('Add a device');
                expect(m.flow.stop).not.toHaveBeenCalled();

                topPage(document).querySelector('.wg-back').click();
                await vi.waitFor(() => expect(topTitle(document)).toBe('Devices & connectors'));
                expect(m.flow.stop).toHaveBeenCalledTimes(1);
                // Back on the list, freshly loaded (shows the new device).
                await vi.waitFor(() => expect(m.devices.renderDeviceList).toHaveBeenCalledTimes(2));
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });

        it('the Claude connector row pushes the connector page (kit S5) and refreshes its status on close', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                const m = installCloudModules(window);
                await mountCloud(window);
                window.SettingsView.openSettingsPage('devices');
                await vi.waitFor(() => expect(m.connectors.claudeConnectorMode).toHaveBeenCalledTimes(1));

                document.getElementById('settings-claude-connector-row').click();
                await vi.waitFor(() => expect(topTitle(document)).toBe('Claude connector'));
                const [body, ctx] = m.connectors.renderConnectors.mock.calls[0];
                expect(topPage(document).contains(body)).toBe(true);
                expect(ctx.accountId).toBe('acct-1');
                expect(topPage(document).querySelector('.wg-back').textContent).toBe('Devices');

                const before = m.connectors.claudeConnectorMode.mock.calls.length;
                topPage(document).querySelector('.wg-back').click();
                await vi.waitFor(() => expect(m.connectors.claudeConnectorMode.mock.calls.length).toBeGreaterThan(before));
                expect(topTitle(document)).toBe('Devices & connectors');
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });

        it('the deeplink opens Devices, and Connectors on top of it; never outside cloud mode', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                installCloudModules(window);
                delete window.__MEDTRACKER_CLOUD__;
                window.SettingsView.openDevicesDeeplink('connectors');
                expect(document.querySelector('mt-modal.wg-page[id^="wg-page-"]')).toBeNull();

                await mountCloud(window);
                window.SettingsView.openDevicesDeeplink('connectors');
                await vi.waitFor(() => expect(topTitle(document)).toBe('Claude connector'));
                expect(Array.from(document.querySelectorAll('mt-modal.wg-page[id^="wg-page-"]')).map((p) => p.querySelector('.wg-pagebar__title').textContent))
                    .toEqual(['Devices & connectors', 'Claude connector']);
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });
    });

    // med-d5t.9 — "What can the operator see?" transparency section. settings.js
    // dynamic-imports web/cloud/js/privacy.js via the bare loadPrivacyModule();
    // the harness can't resolve that specifier, so override the window global
    // with the real module imported statically here — the same seam the cloud
    // push modules use — so the actual render runs against jsdom.
    describe('operator-visibility section', () => {
        const mountCloudWithPrivacy = async (window, privacyModule) => {
            window.__MEDTRACKER_CLOUD__ = true;
            window.loadPrivacyModule = () => Promise.resolve(privacyModule);
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            window.fetch = vi.fn(async () => ({ ok: true, json: async () => [] }));
            await window.loadSettings();
        };

        it('reveals the section and renders the three transparency groups in cloud mode', async () => {
            allowConsoleNoise();
            const privacy = await import('../../../cloud/js/privacy.js');
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                // Server/mobile build: hidden.
                window.apiCall = vi.fn(async () => { throw new Error('offline'); });
                delete window.__MEDTRACKER_CLOUD__; // harness defaults to cloud; test the bot-first branch
                await window.loadSettings();
                expect(document.querySelector('.wg-settings-privacy').classList.contains('wg-settings-hidden')).toBe(true);

                await mountCloudWithPrivacy(window, privacy);

                expect(document.querySelector('.wg-settings-privacy').classList.contains('wg-settings-hidden')).toBe(false);
                const mount = document.getElementById('privacy-content');
                expect(mount.querySelectorAll('.wg-privacy-group').length).toBe(privacy.PRIVACY_CATEGORIES.length);
                expect(mount.querySelectorAll('.wg-privacy-item').length).toBe(privacy.PRIVACY_ITEMS.length);
                // The reassuring frame is present.
                expect(mount.textContent).toMatch(/encrypted on your device/i);
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });

        it('does not break Settings if the transparency module fails to load', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                window.__MEDTRACKER_CLOUD__ = true;
                window.loadPrivacyModule = () => Promise.reject(new Error('load failed'));
                window.apiCall = vi.fn(async () => { throw new Error('offline'); });
                window.fetch = vi.fn(async () => ({ ok: true, json: async () => [] }));

                await window.loadSettings();

                // Section still revealed with its own description; other cloud
                // sections still bound.
                expect(document.querySelector('.wg-settings-privacy').classList.contains('wg-settings-hidden')).toBe(false);
                expect(document.getElementById('privacy-content').children.length).toBe(0);
                expect(document.querySelector('.wg-settings-cloud-devices').classList.contains('wg-settings-hidden')).toBe(false);
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });
    });

    // med-d5t.8 — self-service account deletion. The security gate (fresh passkey,
    // stolen-session-can't-delete) is server-side; here we pin the UI flow:
    // reveal, typed-confirm gate, export-first, and that confirm drives the
    // cloud module's reauthAndDelete + redirect.
    describe('delete account flow', () => {
        const mountCloudWithDeleteModule = async (window, overrides = {}) => {
            const mod = {
                DELETE_CONFIRM_PHRASE: 'delete my account',
                exportVaultToFile: vi.fn(async () => {}),
                reauthAndDelete: vi.fn(async () => {}),
                clearLocalVault: vi.fn(async () => {}),
                baseDomainURL: () => 'https://app.example/',
                ...overrides,
            };
            window.__MEDTRACKER_CLOUD__ = true;
            window.loadAccountDeleteModule = () => Promise.resolve(mod);
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            window.fetch = vi.fn(async () => ({ ok: true, json: async () => [] }));
            await window.loadSettings();
            return mod;
        };

        // Delete… opens the shared safeConfirm dialog (med-xso6.6: no bespoke
        // modal) — destructive, typed-confirm gated on the module's phrase.
        const openDeleteDialog = async (window, document) => {
            document.getElementById('delete-account-open').click();
            return vi.waitFor(() => {
                const dialog = document.querySelector('mt-modal.mt-confirm-modal');
                if (!dialog) throw new Error('no dialog open');
                return dialog;
            });
        };
        const typePhrase = (window, dialog, text) => {
            const input = dialog.querySelector('.mt-confirm-modal__input');
            input.value = text;
            input.dispatchEvent(new window.Event('input'));
        };
        const confirmDelete = async (window, document) => {
            const dialog = await openDeleteDialog(window, document);
            typePhrase(window, dialog, 'delete my account');
            dialog.querySelector('.mt-confirm-modal__confirm').click();
        };

        it('reveals the danger section only in cloud mode', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                window.apiCall = vi.fn(async () => { throw new Error('offline'); });
                delete window.__MEDTRACKER_CLOUD__; // harness defaults to cloud; test the bot-first branch
                await window.loadSettings();
                expect(document.querySelector('.wg-settings-danger').classList.contains('wg-settings-hidden')).toBe(true);

                await mountCloudWithDeleteModule(window);
                expect(document.querySelector('.wg-settings-danger').classList.contains('wg-settings-hidden')).toBe(false);
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });

        it('opens the shared destructive dialog and keeps delete disabled until the exact phrase is typed', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                const mod = await mountCloudWithDeleteModule(window);
                const dialog = await openDeleteDialog(window, document);

                const btn = dialog.querySelector('.mt-confirm-modal__confirm');
                expect(btn.classList.contains('wg-btn--danger')).toBe(true);
                expect(btn.disabled).toBe(true);

                typePhrase(window, dialog, 'delete');
                expect(btn.disabled).toBe(true);

                typePhrase(window, dialog, 'Delete My Account');
                expect(btn.disabled).toBe(false);

                // Cancel closes just the dialog; nothing is deleted.
                dialog.querySelector('.mt-confirm-modal__cancel').click();
                expect(document.querySelector('mt-modal.mt-confirm-modal')).toBeNull();
                await Promise.resolve();
                expect(mod.clearLocalVault).not.toHaveBeenCalled();
                expect(mod.reauthAndDelete).not.toHaveBeenCalled();

                // Reopening after a cancel starts gated again.
                const again = await openDeleteDialog(window, document);
                expect(again.querySelector('.mt-confirm-modal__confirm').disabled).toBe(true);
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });

        it('the export-first button downloads the vault and reports the download', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                const mod = await mountCloudWithDeleteModule(window, {
                    exportVaultToFile: vi.fn(async () => true),
                });
                document.getElementById('delete-account-export').click();
                await vi.waitFor(() => expect(mod.exportVaultToFile).toHaveBeenCalled());
                await vi.waitFor(() => {
                    expect(document.getElementById('delete-account-export-status').textContent).toMatch(/downloaded/i);
                });
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });

        // exportVaultToFile resolves false when the user declines the
        // plaintext-secrets warning. The status must NOT claim a download —
        // in a delete flow a false "downloaded" is a data-loss trap.
        it('a declined secrets warning shows "cancelled", never "downloaded"', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                await mountCloudWithDeleteModule(window, {
                    exportVaultToFile: vi.fn(async () => false),
                });
                document.getElementById('delete-account-export').click();
                await vi.waitFor(() => {
                    const text = document.getElementById('delete-account-export-status').textContent;
                    expect(text).toMatch(/cancelled/i);
                    expect(text).not.toMatch(/export downloaded/i);
                });
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });

        it('confirming runs reauthAndDelete, clears local state, and navigates to the base domain', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                // jsdom does not implement navigation, so pin the intent: after
                // the delete, the code consults baseDomainURL to leave the
                // now-deleted subdomain.
                const baseDomainURL = vi.fn(() => 'https://app.example/');
                const mod = await mountCloudWithDeleteModule(window, { baseDomainURL });
                await confirmDelete(window, document);

                await vi.waitFor(() => expect(mod.reauthAndDelete).toHaveBeenCalled());
                expect(mod.clearLocalVault).toHaveBeenCalled();
                await vi.waitFor(() => expect(baseDomainURL).toHaveBeenCalled());
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });

        it('a failed delete shows an error and does not redirect', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                const before = window.location.href;
                const mod = await mountCloudWithDeleteModule(window, {
                    reauthAndDelete: vi.fn(async () => { throw new Error('Passkey verification was cancelled.'); }),
                });
                await confirmDelete(window, document);

                await vi.waitFor(() => {
                    expect(document.getElementById('delete-account-error').textContent).toMatch(/cancelled/i);
                });
                // The pre-delete wipe already ran (safe: the account is intact
                // and the cloud copy re-syncs), but the post-delete wipe and
                // navigation must not.
                expect(mod.clearLocalVault).toHaveBeenCalledTimes(1);
                expect(window.location.href).toBe(before);
                // The user can try again.
                expect(document.getElementById('delete-account-open').disabled).toBe(false);
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });

        // med-yor.3 — clearLocalVault now throws on unverified local erasure
        // (e.g. the IDB delete was blocked). The server account is already
        // gone at that point, so the UI must NOT navigate, and the message
        // must be honest about the account being deleted server-side AND warn
        // that this tab is the last thing able to finish the wipe (the deleted
        // subdomain serves 404s — a reload strands the data forever).
        it('a failed local wipe after server delete shows an honest error and does not redirect', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                const before = window.location.href;
                const baseDomainURL = vi.fn(() => 'https://app.example/');
                const mod = await mountCloudWithDeleteModule(window, {
                    baseDomainURL,
                    // Pre-delete wipe succeeds; the post-delete wipe blocks.
                    clearLocalVault: vi.fn()
                        .mockResolvedValueOnce(undefined)
                        .mockRejectedValue(new Error('Close other open tabs of this app and try again.')),
                });
                await confirmDelete(window, document);

                await vi.waitFor(() => {
                    const text = document.getElementById('delete-account-error').textContent;
                    expect(text).toMatch(/account was deleted/i);
                    expect(text).toMatch(/close other open tabs/i);
                    expect(text).toMatch(/keep this tab open/i);
                });
                expect(mod.reauthAndDelete).toHaveBeenCalled();
                expect(baseDomainURL).not.toHaveBeenCalled();
                expect(window.location.href).toBe(before);
                expect(document.getElementById('delete-account-open').disabled).toBe(false);
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });

        // The advertised recovery ("close other tabs and try again") must
        // actually work: the account is already gone server-side, so the retry
        // click must NOT re-run the re-auth ceremony (it would 401 against the
        // deleted account) nor ask for the phrase again — it retries only the
        // local wipe, then navigates.
        it('retrying after a blocked post-delete wipe skips the dialog and re-auth and completes the wipe', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                const baseDomainURL = vi.fn(() => 'https://app.example/');
                // Pre-delete wipe ok, post-delete wipe blocked, retry ok.
                const clearLocalVault = vi.fn()
                    .mockResolvedValueOnce(undefined)
                    .mockRejectedValueOnce(new Error('Close other open tabs of this app and try again.'))
                    .mockResolvedValueOnce(undefined);
                const mod = await mountCloudWithDeleteModule(window, { baseDomainURL, clearLocalVault });
                await confirmDelete(window, document);
                const openBtn = document.getElementById('delete-account-open');
                await vi.waitFor(() => expect(document.getElementById('delete-account-error').textContent).toMatch(/account was deleted/i));
                await vi.waitFor(() => expect(openBtn.disabled).toBe(false));

                openBtn.click();
                await vi.waitFor(() => expect(baseDomainURL).toHaveBeenCalled());
                expect(document.querySelector('mt-modal.mt-confirm-modal')).toBeNull();
                expect(mod.clearLocalVault).toHaveBeenCalledTimes(3);
                expect(mod.reauthAndDelete).toHaveBeenCalledTimes(1);
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });

        // The wipe also runs BEFORE the server delete: a blocked wipe must
        // fail while the account still exists (no reauth, no delete, no
        // navigation), so abandoning the flow at that point can never strand
        // plaintext data on a dead origin. Retrying runs the full flow.
        it('a blocked pre-delete wipe fails before re-auth and is fully retryable', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                const before = window.location.href;
                const baseDomainURL = vi.fn(() => 'https://app.example/');
                const clearLocalVault = vi.fn()
                    .mockRejectedValueOnce(new Error('Close other open tabs of this app and try again.'))
                    .mockResolvedValue(undefined);
                const mod = await mountCloudWithDeleteModule(window, { baseDomainURL, clearLocalVault });
                await confirmDelete(window, document);

                await vi.waitFor(() => {
                    const text = document.getElementById('delete-account-error').textContent;
                    expect(text).toMatch(/close other open tabs/i);
                    // The account is NOT deleted yet — no misleading prefix.
                    expect(text).not.toMatch(/account was deleted/i);
                });
                expect(mod.reauthAndDelete).not.toHaveBeenCalled();
                expect(window.location.href).toBe(before);

                // The account still exists, so the retry asks for the phrase again.
                await confirmDelete(window, document);
                await vi.waitFor(() => expect(baseDomainURL).toHaveBeenCalled());
                expect(mod.reauthAndDelete).toHaveBeenCalledTimes(1);
                // Retry pre-wipe + post-delete wipe, after the first blocked one.
                expect(mod.clearLocalVault).toHaveBeenCalledTimes(3);
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });
    });

    // med-4pz.4 — nudge a single-device account to add a second one, so a lost
    // or broken phone doesn't lock the user out of their vault.
    describe('second-device nudge', () => {
        // The nudge fetches /api/devices via raw fetch (a real server route, not
        // the domain shim). Returns an N-device list.
        const withDevices = (window, n) => {
            window.fetch = vi.fn(async () => ({
                ok: true,
                json: async () => Array.from({ length: n }, (_, i) => ({ credential_id: `cred-${i}`, created_at: '2026-07-01T00:00:00Z' })),
            }));
        };

        const mountCloud = async (window) => {
            window.__MEDTRACKER_CLOUD__ = true;
            window.MedTrackerCloud = { ctx: { accountId: 'acct-1' } };
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();
        };

        it('shows the nudge when the account has exactly one device', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                window.localStorage.clear();
                withDevices(window, 1);
                await mountCloud(window);

                expect(document.getElementById('second-device-nudge').classList.contains('wg-settings-hidden')).toBe(false);
                // The nudge sits on the Devices page right above its one
                // primary, "Add a device" (kit S4) — it carries no second one.
                expect(document.getElementById('second-device-nudge').querySelector('a, .wg-btn--primary')).toBeNull();
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });

        it('hides the nudge once a second device exists — it self-retires', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                window.localStorage.clear();
                withDevices(window, 2);
                await mountCloud(window);

                expect(document.getElementById('second-device-nudge').classList.contains('wg-settings-hidden')).toBe(true);
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });

        it('stays hidden on a failed device fetch rather than nagging on incomplete info', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                window.localStorage.clear();
                window.fetch = vi.fn(async () => { throw new Error('offline'); });
                await mountCloud(window);

                expect(document.getElementById('second-device-nudge').classList.contains('wg-settings-hidden')).toBe(true);
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });

        // med-0ol.6 — loadSettings() re-runs on every tab repaint, and a cloud
        // write repaints the open tab. A bulk .nxk import fires hundreds of
        // writes, so an un-memoized /api/devices fetch here fanned a single
        // import out into thousands of requests. The count is memoized for the
        // page's lifetime, so a repaint storm can't multiply the fetch.
        it('memoizes the device fetch so a repaint storm cannot fan out into many /api/devices requests', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                window.localStorage.clear();
                withDevices(window, 1);
                await mountCloud(window);
                // Simulate the import's repeated repaints re-running loadSettings.
                for (let i = 0; i < 25; i++) await window.loadSettings();

                const deviceCalls = window.fetch.mock.calls.filter(([u]) => String(u) === '/api/devices');
                expect(deviceCalls.length).toBe(1);
                // The nudge still resolved correctly off that single fetch.
                expect(document.getElementById('second-device-nudge').classList.contains('wg-settings-hidden')).toBe(false);
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });

        it('dismiss hides it and keeps it hidden on the next mount, per account', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                window.localStorage.clear();
                withDevices(window, 1);
                await mountCloud(window);
                expect(document.getElementById('second-device-nudge').classList.contains('wg-settings-hidden')).toBe(false);

                document.getElementById('second-device-nudge-dismiss').click();
                expect(document.getElementById('second-device-nudge').classList.contains('wg-settings-hidden')).toBe(true);

                // Re-mount, still single-device: dismissal persists.
                await window.loadSettings();
                expect(document.getElementById('second-device-nudge').classList.contains('wg-settings-hidden')).toBe(true);

                // A different account has not dismissed it.
                window.MedTrackerCloud = { ctx: { accountId: 'acct-2' } };
                await window.loadSettings();
                expect(document.getElementById('second-device-nudge').classList.contains('wg-settings-hidden')).toBe(false);
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });
    });
});

// Cloud-only "Invite a friend" row (plan 20260707-user-mintable-invites, Task 4).
// settings.js reaches the QR generator through the bare global loadQrcodeModule(),
// so the test overrides window.loadQrcodeModule instead of making jsdom resolve
// a real import('/vendor/qrcode.mjs') — same seam as the cloud push modules.
describe('Settings → Invite a friend (cloud mode)', () => {
    const CLAIM_URL = 'https://sunny-vole-abc123.cloud.example/#claim=deadbeef';

    function enterCloudMode(window) {
        window.__MEDTRACKER_CLOUD__ = true;
        window.apiCall = vi.fn(async () => { throw new Error('offline'); });
        window.loadCloudPushModule = () => Promise.resolve({
            subscribe: vi.fn(), unsubscribe: vi.fn(), getSubscription: vi.fn().mockResolvedValue(null)
        });
        window.loadCloudRemindersModule = () => Promise.resolve({ sendTestPush: vi.fn() });
        window.loadQrcodeModule = () => Promise.resolve({
            qrcode: () => ({ addData() {}, make() {}, createSvgTag: () => '<svg data-qr="1"></svg>' })
        });
        window.SyncManager = { showToast: vi.fn() };
    }

    it('hides the invite row outside cloud mode', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        delete window.__MEDTRACKER_CLOUD__; // harness defaults to cloud; test outside-cloud behavior
        try {
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();
            expect(document.querySelector('.wg-settings-cloud-invite').classList.contains('wg-settings-hidden')).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('mints an invite and shows the claim URL + QR in the modal', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            enterCloudMode(window);
            window.fetch = vi.fn().mockResolvedValue({
                ok: true, status: 200, json: async () => ({ claim_url: CLAIM_URL })
            });

            await window.loadSettings();
            expect(document.querySelector('.wg-settings-cloud-invite').classList.contains('wg-settings-hidden')).toBe(false);

            await window.SettingsView.mintInvite();

            expect(window.fetch).toHaveBeenCalledWith('/api/invite', { method: 'POST' });
            expect(document.getElementById('invite-modal').classList.contains('hidden')).toBe(false);
            expect(document.getElementById('invite-claim-url').textContent).toBe(CLAIM_URL);
            expect(document.querySelector('#invite-qr svg[data-qr]')).not.toBeNull();
        } finally {
            delete window.__MEDTRACKER_CLOUD__;
            cleanup();
        }
    });

    it('shows the limit toast on 429 and leaves the modal closed', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            enterCloudMode(window);
            window.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });

            await window.loadSettings();
            await window.SettingsView.mintInvite();

            expect(window.SyncManager.showToast).toHaveBeenCalledWith(
                expect.stringContaining('Monthly invite limit reached'), 'info'
            );
            expect(document.getElementById('invite-modal').classList.contains('hidden')).toBe(true);
        } finally {
            delete window.__MEDTRACKER_CLOUD__;
            cleanup();
        }
    });
});
