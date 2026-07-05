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

    it('feature clamp holds: enabling an unported feature never surfaces as enabled from the shim', async () => {
        const { window } = env;
        window.rebuildCanonicalBottomNav = vi.fn();

        // 'medication' is not in the shim's PORTED_SET, unlike 'bp'/'weight'/'health'.
        await window.toggleFeatureSetting('medication', true);

        const flags = await window.apiCall('/api/settings/features', 'GET');
        expect(flags.medication).toBe(false);

        const boot = await window.apiCall('/api/bootstrap');
        expect(boot.features.medication).toBe(false);
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

    it('Integrations round-trip: entering a key, saving, then reloading shows the masked value', async () => {
        const { window, document } = env;

        document.getElementById('integrations-openai-api-key').value = 'sk-test-dummy-key';
        document.getElementById('integrations-openai-url').value = 'https://api.openai.example/v1';
        document.getElementById('integrations-food-domain').value = 'usda';

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
        expect(document.getElementById('integrations-food-domain').value).toBe('usda');
    });
});
