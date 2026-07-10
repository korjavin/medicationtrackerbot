// Plan 2026-07-05 cloud-c2a, Task 5 — shim-mode contract run of the Settings
// flows against web/domain/settings.js. Drives the real feature code
// (toggleFeatureSetting, saveTabOrder, loadFoodTargets/saveFoodTargets,
// SettingsIntegrations.load/save) through the real window.apiCall
// (core/api.js), which delegates to the cloud shim (web/cloud/js/apishim.js)
// instead of the network. Additive suite — the original (network-mocked)
// settings.*.test.js files keep running unshimmed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApiCache, loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';

describe('cloud shim contract — settings flows (features/settings.js over web/domain/settings.js)', () => {
    let env;

    beforeEach(() => {
        env = loadCloudShimFrontendEnv();
        installApiCache(env.window);
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('toggleFeatureSetting persists through the shim and GET /api/settings/features echoes it back', async () => {
        const { window } = env;
        window.rebuildCanonicalBottomNav = vi.fn();

        await window.toggleFeatureSetting('bp', false);

        const flags = await window.apiCall('/api/settings/features', 'GET');
        expect(flags.bp).toBe(false);
        expect(window.featureSettings.bp).toBe(false);
    });

    it('a fresh vault (no features record) defaults food ON, and an explicit opt-out survives', async () => {
        const { window } = env;
        window.rebuildCanonicalBottomNav = vi.fn();

        expect((await window.apiCall('/api/settings/features', 'GET')).food).toBe(true);

        await window.toggleFeatureSetting('food', false);
        expect((await window.apiCall('/api/settings/features', 'GET')).food).toBe(false);
    });

    it('feature clamp holds: enabling an unported feature never surfaces as enabled from the shim', async () => {
        const { window } = env;
        window.rebuildCanonicalBottomNav = vi.fn();

        // Establish the real post-bootstrap baseline: the shim clamps
        // 'gamification' off (it's not in PORTED_SET, unlike 'bp'/'weight'/
        // 'health'/'medication'/'food'/'workout' — 'workout' joined PORTED_SET
        // in C2d Task 6).
        const boot0 = await window.apiCall('/api/bootstrap');
        window.SettingsState.applyBootstrapFeatures(boot0.features);
        expect(window.featureSettings.gamification).toBe(false);

        await window.toggleFeatureSetting('gamification', true);

        // In-session too: the shim rejects the unported enable so the UI never
        // flips window.featureSettings on (which nav filtering trusts), so no
        // dead tab surfaces before the next reload.
        expect(window.featureSettings.gamification).toBe(false);
        expect(window.rebuildCanonicalBottomNav).not.toHaveBeenCalled();

        const flags = await window.apiCall('/api/settings/features', 'GET');
        expect(flags.gamification).toBe(false);

        const boot = await window.apiCall('/api/bootstrap');
        expect(boot.features.gamification).toBe(false);
    });

    it('saveTabOrder persists through the shim and is echoed by bootstrap', async () => {
        const { window } = env;
        const order = ['weight', 'bp', 'health'];
        await window.saveTabOrder(order);

        const boot = await window.apiCall('/api/bootstrap');
        expect(boot.settings.tab_order).toEqual(order);
    });

    it('saveFoodTargets persists through the shim and loadFoodTargets reads it back', async () => {
        const { window, document } = env;
        document.getElementById('food-target-calories').value = '1900';
        document.getElementById('food-target-carbs').value = '200';
        document.getElementById('food-target-protein').value = '130';
        document.getElementById('food-target-fat').value = '70';
        window.loadFoodLogs = vi.fn();

        await window.saveFoodTargets();

        document.getElementById('food-target-calories').value = '';
        await window.loadFoodTargets();

        expect(document.getElementById('food-target-calories').value).toBe('1900');
        expect(document.getElementById('food-target-carbs').value).toBe('200');
        expect(document.getElementById('food-target-protein').value).toBe('130');
        expect(document.getElementById('food-target-fat').value).toBe('70');
    });

    it('dismissing a tz suggestion persists and GET /api/settings + bootstrap echo it back', async () => {
        const { window } = env;

        await window.apiCall('/api/tz-suggestion/dismiss', 'POST', { detected_tz: 'Europe/Berlin' });

        const settings = await window.apiCall('/api/settings', 'GET');
        expect(settings.dismissed_tz_suggestion).toBe('Europe/Berlin');

        const boot = await window.apiCall('/api/bootstrap');
        expect(boot.settings.dismissed_tz_suggestion).toBe('Europe/Berlin');
    });

    it('a fresh vault needs first run, and completing it durably flips the flag', async () => {
        const { window } = env;

        const before = await window.apiCall('/api/bootstrap');
        expect(before.needs_first_run).toBe(true);

        await window.apiCall('/api/firstrun/complete', 'POST');

        const after = await window.apiCall('/api/bootstrap');
        expect(after.needs_first_run).toBe(false);
    });

    it('a stale device overwriting the settings singleton cannot un-complete first run', async () => {
        const { window, records } = env;

        await window.apiCall('/api/firstrun/complete', 'POST');

        // Records are last-writer-wins per whole record. Simulate a device that
        // never saw the completion writing the shared `settings` singleton.
        await records.put('settings', {
            recordId: 'settings',
            clientTs: Date.now() + 60000,
            deleted: false,
            timezone: 'Europe/Berlin',
        });

        const boot = await window.apiCall('/api/bootstrap');
        expect(boot.needs_first_run).toBe(false);
    });

    it('completing first run leaves GET /api/settings shape unchanged and does not clobber the singleton', async () => {
        const { window } = env;

        await window.apiCall('/api/tz-suggestion/dismiss', 'POST', { detected_tz: 'Europe/Berlin' });
        await window.saveTabOrder(['weight', 'bp']);

        await window.apiCall('/api/firstrun/complete', 'POST');

        const settings = await window.apiCall('/api/settings', 'GET');
        expect(settings.first_run_complete).toBeUndefined();
        expect(settings.general).toBeUndefined();
        expect(settings.dismissed_tz_suggestion).toBe('Europe/Berlin');
        expect(settings.tab_order).toEqual(['weight', 'bp']);
    });

    it('Integrations round-trip: entering a key, saving, then reloading shows the masked value', async () => {
        const { window, document } = env;

        document.getElementById('integrations-openai-api-key').value = 'sk-test-dummy-key';
        document.getElementById('integrations-openai-url').value = 'https://api.openai.example/v1';
        document.getElementById('integrations-food-url').value = 'https://usda.example/v1';

        await window.SettingsIntegrations.save();

        // The save handler reloads the masked GET view straight into the DOM.
        expect(document.getElementById('integrations-openai-api-key').value).toBe('***');
        expect(document.getElementById('integrations-openai-url').value).toBe('https://api.openai.example/v1');

        // Clear the DOM and reload independently to prove the vault (not just
        // in-memory state) round-trips the value.
        document.getElementById('integrations-openai-api-key').value = '';
        document.getElementById('integrations-openai-url').value = '';
        await window.SettingsIntegrations.load();

        expect(document.getElementById('integrations-openai-api-key').value).toBe('***');
        expect(document.getElementById('integrations-openai-url').value).toBe('https://api.openai.example/v1');
        expect(document.getElementById('integrations-food-url').value).toBe('https://usda.example/v1');
    });
});
