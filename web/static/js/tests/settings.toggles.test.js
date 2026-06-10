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

    it('mounts all six feature toggles inside the Features card', () => {
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
            expect(toggles.length).toBe(6);
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
});
