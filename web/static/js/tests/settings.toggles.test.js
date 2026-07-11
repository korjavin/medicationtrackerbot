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

describe('Settings Features section (Phase 9, Task 5)', () => {
    it('renders the Features section as a .wg-card with a mono title and description', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const settingsView = dom.window.document.getElementById('settings-view');
            const sections = settingsView.querySelectorAll('.wg-settings-section');
            const titles = Array.from(sections).map((c) => {
                const t = c.querySelector('.wg-settings-section__title');
                return t ? t.textContent.trim() : '';
            });
            expect(titles).toContain('Features');

            const card = Array.from(sections).find((c) =>
                c.querySelector('.wg-settings-section__title')?.textContent?.trim() === 'Features'
            );
            expect(card).toBeDefined();
            expect(card.classList.contains('wg-card')).toBe(true);

            const desc = card.querySelector('.wg-settings-section__desc');
            expect(desc).not.toBeNull();
            expect(desc.textContent.toLowerCase()).toContain('enable');
        } finally {
            cleanup();
        }
    });

    it('mounts all seven feature toggles inside the Features card', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const doc = dom.window.document;
            const featuresCard = Array.from(doc.querySelectorAll('.wg-settings-section')).find(
                (c) => c.querySelector('.wg-settings-section__title')?.textContent?.trim() === 'Features'
            );
            expect(featuresCard).toBeDefined();

            const expected = [
                'bp-feature-toggle',
                'weight-feature-toggle',
                'workout-feature-toggle',
                'medication-feature-toggle',
                'food-intake-toggle',
                'health-feature-toggle',
                'weekly-digest-feature-toggle',
            ];
            for (const inputId of expected) {
                const setting = doc.querySelector(`mt-setting-toggle[input-id="${inputId}"]`);
                expect(setting, `missing <mt-setting-toggle input-id="${inputId}">`).not.toBeNull();
                expect(featuresCard.contains(setting)).toBe(true);
            }
        } finally {
            cleanup();
        }
    });

    it('does not mount reminder toggles inside the Features card', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const doc = dom.window.document;
            const featuresCard = Array.from(doc.querySelectorAll('.wg-settings-section')).find(
                (c) => c.querySelector('.wg-settings-section__title')?.textContent?.trim() === 'Features'
            );
            const bpReminders = doc.querySelector('mt-setting-toggle[input-id="bp-reminders-toggle"]');
            const weightReminders = doc.querySelector('mt-setting-toggle[input-id="weight-reminders-toggle"]');
            expect(featuresCard.contains(bpReminders)).toBe(false);
            expect(featuresCard.contains(weightReminders)).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('renders feature toggles inside a .wg-settings-row-list', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const doc = dom.window.document;
            const featuresCard = Array.from(doc.querySelectorAll('.wg-settings-section')).find(
                (c) => c.querySelector('.wg-settings-section__title')?.textContent?.trim() === 'Features'
            );
            const list = featuresCard.querySelector('.wg-settings-row-list');
            expect(list).not.toBeNull();
            const toggles = list.querySelectorAll('mt-setting-toggle');
            expect(toggles.length).toBe(7);
        } finally {
            cleanup();
        }
    });
});

describe('Settings Reminders section (Phase 9, Task 5)', () => {
    it('renders the Reminders section as a .wg-card with a mono title and description', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const settingsView = dom.window.document.getElementById('settings-view');
            const sections = settingsView.querySelectorAll('.wg-settings-section');
            const titles = Array.from(sections).map((c) => {
                const t = c.querySelector('.wg-settings-section__title');
                return t ? t.textContent.trim() : '';
            });
            expect(titles).toContain('Reminders');

            const card = Array.from(sections).find((c) =>
                c.querySelector('.wg-settings-section__title')?.textContent?.trim() === 'Reminders'
            );
            expect(card).toBeDefined();
            expect(card.classList.contains('wg-card')).toBe(true);

            const desc = card.querySelector('.wg-settings-section__desc');
            expect(desc).not.toBeNull();
            expect(desc.textContent.toLowerCase()).toContain('remind');
        } finally {
            cleanup();
        }
    });

    it('mounts both reminder toggles inside the Reminders card', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const doc = dom.window.document;
            const remindersCard = Array.from(doc.querySelectorAll('.wg-settings-section')).find(
                (c) => c.querySelector('.wg-settings-section__title')?.textContent?.trim() === 'Reminders'
            );
            expect(remindersCard).toBeDefined();

            const bpReminders = doc.querySelector('mt-setting-toggle[input-id="bp-reminders-toggle"]');
            const weightReminders = doc.querySelector('mt-setting-toggle[input-id="weight-reminders-toggle"]');
            expect(bpReminders).not.toBeNull();
            expect(weightReminders).not.toBeNull();
            expect(remindersCard.contains(bpReminders)).toBe(true);
            expect(remindersCard.contains(weightReminders)).toBe(true);

            const list = remindersCard.querySelector('.wg-settings-row-list');
            expect(list).not.toBeNull();
            expect(list.querySelectorAll('mt-setting-toggle').length).toBe(2);
        } finally {
            cleanup();
        }
    });

    it('does not mount feature toggles inside the Reminders card', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const doc = dom.window.document;
            const remindersCard = Array.from(doc.querySelectorAll('.wg-settings-section')).find(
                (c) => c.querySelector('.wg-settings-section__title')?.textContent?.trim() === 'Reminders'
            );
            const bpFeature = doc.querySelector('mt-setting-toggle[input-id="bp-feature-toggle"]');
            const foodFeature = doc.querySelector('mt-setting-toggle[input-id="food-intake-toggle"]');
            expect(remindersCard.contains(bpFeature)).toBe(false);
            expect(remindersCard.contains(foodFeature)).toBe(false);
        } finally {
            cleanup();
        }
    });
});

describe('Settings toggle `divider` attribute (Phase 9, Task 5)', () => {
    it('removes the `divider` attribute from all feature + reminder toggles in markup', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const doc = dom.window.document;
            const ids = [
                'bp-feature-toggle',
                'weight-feature-toggle',
                'workout-feature-toggle',
                'medication-feature-toggle',
                'food-intake-toggle',
                'health-feature-toggle',
                'weekly-digest-feature-toggle',
                'bp-reminders-toggle',
                'weight-reminders-toggle',
            ];
            for (const id of ids) {
                const el = doc.querySelector(`mt-setting-toggle[input-id="${id}"]`);
                expect(el, `missing <mt-setting-toggle input-id="${id}">`).not.toBeNull();
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
            expect(manual.classList.contains('wg-settings-row')).toBe(true);
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
                'weekly-digest-feature-toggle',
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
//   • warm-cache render — applyBundle paints toggles + macros + the stale chip
//   • feature-toggle flips nav visibility — rebuildCanonicalBottomNav re-mount
//     + updateFeatureTabVisibility bounce to Today when the active section's
//     feature is turned off
//   • error/revert — apiCall null restores the toggle, skips the write side
// (warm-cache + stale-badge are also pinned in settings.refresh-on-mount.test.js;
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
    it('loadSettings renders feature toggles, food macros, and the stale chip from a warm cache (offline)', async () => {
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
            // Stale chip mounted from the 90-min-old cache row, offline tone.
            const badge = document.getElementById('settings-stale-badge').querySelector('.wg-stale-badge');
            expect(badge).not.toBeNull();
            expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);
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

    it('shows the Devices row only when window.__MEDTRACKER_CLOUD__ is set (server/mobile builds never render it)', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });

            await window.loadSettings();
            expect(document.querySelector('.wg-settings-cloud-devices').classList.contains('wg-settings-hidden')).toBe(true);

            window.__MEDTRACKER_CLOUD__ = true;
            await window.loadSettings();
            expect(document.querySelector('.wg-settings-cloud-devices').classList.contains('wg-settings-hidden')).toBe(false);
            expect(document.getElementById('settings-devices-link').getAttribute('href')).toBe('/devices');
            // med-lyv split the connector picker onto its own page; the two rows
            // used to land on the same screen, which is what made the MCP
            // controls look like a property of the device list.
            expect(document.getElementById('settings-claude-connector-link').getAttribute('href')).toBe('/connectors');
        } finally {
            delete window.__MEDTRACKER_CLOUD__;
            cleanup();
        }
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

        it('reveals the danger section only in cloud mode', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                window.apiCall = vi.fn(async () => { throw new Error('offline'); });
                await window.loadSettings();
                expect(document.querySelector('.wg-settings-danger').classList.contains('wg-settings-hidden')).toBe(true);

                await mountCloudWithDeleteModule(window);
                expect(document.querySelector('.wg-settings-danger').classList.contains('wg-settings-hidden')).toBe(false);
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });

        it('keeps delete disabled until the exact phrase is typed', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                await mountCloudWithDeleteModule(window);
                document.getElementById('delete-account-open').click();

                const input = document.getElementById('delete-account-confirm-input');
                const btn = document.getElementById('delete-account-confirm');
                expect(btn.disabled).toBe(true);

                input.value = 'delete';
                input.dispatchEvent(new window.Event('input'));
                await Promise.resolve();
                expect(btn.disabled).toBe(true);

                input.value = 'Delete My Account';
                input.dispatchEvent(new window.Event('input'));
                await Promise.resolve();
                expect(btn.disabled).toBe(false);
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });

        it('the export-first button downloads the vault', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                const mod = await mountCloudWithDeleteModule(window);
                document.getElementById('delete-account-open').click();
                document.getElementById('delete-account-export').click();
                await vi.waitFor(() => expect(mod.exportVaultToFile).toHaveBeenCalled());
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
                document.getElementById('delete-account-open').click();
                const input = document.getElementById('delete-account-confirm-input');
                input.value = 'delete my account';
                input.dispatchEvent(new window.Event('input'));
                await Promise.resolve();

                document.getElementById('delete-account-confirm').click();

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
                document.getElementById('delete-account-open').click();
                const input = document.getElementById('delete-account-confirm-input');
                input.value = 'delete my account';
                input.dispatchEvent(new window.Event('input'));
                await Promise.resolve();
                document.getElementById('delete-account-confirm').click();

                await vi.waitFor(() => {
                    expect(document.getElementById('delete-account-error').textContent).toMatch(/cancelled/i);
                });
                expect(mod.clearLocalVault).not.toHaveBeenCalled();
                expect(window.location.href).toBe(before);
                // The user can try again.
                expect(document.getElementById('delete-account-confirm').disabled).toBe(false);
            } finally {
                delete window.__MEDTRACKER_CLOUD__;
                cleanup();
            }
        });

        // med-hzy — the Cancel button must close the modal, and reopening must
        // still work. Root cause was that opening via a raw classList toggle
        // left the `inert` attribute (set by mt-modal.connectedCallback while
        // `.hidden` was present), so the whole subtree stayed non-interactive
        // and the Cancel click never reached its handler. Asserting `inert` is
        // cleared on open is the real regression guard: it fails on the old
        // classList-only open path (jsdom still dispatches synthetic clicks
        // through inert, so a hidden-class-only assertion would pass either way).
        it('the Cancel button closes the modal, and it reopens cleanly', async () => {
            allowConsoleNoise();
            const { window, document, cleanup } = loadFrontendEnv();
            try {
                await mountCloudWithDeleteModule(window);
                const modal = document.getElementById('delete-account-modal');

                document.getElementById('delete-account-open').click();
                expect(modal.classList.contains('hidden')).toBe(false);
                // Regression guard: an opened modal must be interactive.
                expect(modal.hasAttribute('inert')).toBe(false);

                document.getElementById('delete-account-cancel').click();
                expect(modal.classList.contains('hidden')).toBe(true);
                expect(modal.hasAttribute('inert')).toBe(true);

                // Reopening after a cancel still works.
                document.getElementById('delete-account-open').click();
                expect(modal.classList.contains('hidden')).toBe(false);
                expect(modal.hasAttribute('inert')).toBe(false);
                // The typed-confirmation gate is untouched: delete stays disabled.
                expect(document.getElementById('delete-account-confirm').disabled).toBe(true);
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
                expect(document.getElementById('second-device-nudge-add').getAttribute('href')).toBe('/devices');
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
