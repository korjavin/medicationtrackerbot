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

    it('weekly_digest now round-trips through the shim (ported as a cloud horizon producer, med-eas.58)', async () => {
        const { window } = env;
        window.rebuildCanonicalBottomNav = vi.fn();

        // weekly_digest defaults off but is now in PORTED_SET — it has no nav tab
        // or /api route, but the flag must persist + read back so the Settings
        // toggle drives the digest push (reminders.js computeDigestEntry).
        const boot0 = await window.apiCall('/api/bootstrap');
        window.SettingsState.applyBootstrapFeatures(boot0.features);
        expect(window.featureSettings.weekly_digest).toBe(false);

        await window.toggleFeatureSetting('weekly_digest', true);

        expect(window.featureSettings.weekly_digest).toBe(true);

        const flags = await window.apiCall('/api/settings/features', 'GET');
        expect(flags.weekly_digest).toBe(true);

        const boot = await window.apiCall('/api/bootstrap');
        expect(boot.features.weekly_digest).toBe(true);
    });

    // med-ja0u: the Tomorrow Forecast card lives on Today — a screen that keeps
    // rendering with Journey off — so the shim route is the feature gate. The
    // card only knows how to hide itself on !enabled.
    it('gamification off gates GET /api/gamification/forecast to {enabled:false}', async () => {
        const { window } = env;
        window.rebuildCanonicalBottomNav = vi.fn();

        const on = await window.apiCall('/api/gamification/forecast', 'GET');
        expect(on.enabled).toBe(true);
        expect(on.calibration).toBeTruthy();

        await window.toggleFeatureSetting('gamification', false);

        expect(await window.apiCall('/api/gamification/forecast', 'GET')).toEqual({ enabled: false });
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

    it('trial-consent GET defaults every scope to null (never asked) on a fresh vault', async () => {
        const { window } = env;

        const consent = await window.apiCall('/api/settings/trial-consent', 'GET');
        expect(consent).toEqual({ ai: null, voice: null, tg: null, updated_at: 0 });
    });

    it('trial-consent PATCH then GET round-trips, and a partial patch preserves other scopes', async () => {
        const { window } = env;

        await window.apiCall('/api/settings/trial-consent', 'PATCH', { ai: true, voice: false });
        let consent = await window.apiCall('/api/settings/trial-consent', 'GET');
        expect(consent.ai).toBe(true);
        expect(consent.voice).toBe(false);
        expect(consent.tg).toBeNull();
        expect(consent.updated_at).toBeGreaterThan(0);

        await window.apiCall('/api/settings/trial-consent', 'PATCH', { tg: true });
        consent = await window.apiCall('/api/settings/trial-consent', 'GET');
        expect(consent.ai).toBe(true);
        expect(consent.voice).toBe(false);
        expect(consent.tg).toBe(true);
    });

    it('trial-consent ignores non-boolean patch values — a malformed patch never widens consent', async () => {
        const { window } = env;

        await window.apiCall('/api/settings/trial-consent', 'PATCH', {
            ai: 'true', voice: 1, tg: {}, extra: true,
        });

        const consent = await window.apiCall('/api/settings/trial-consent', 'GET');
        expect(consent).toEqual({ ai: null, voice: null, tg: null, updated_at: expect.any(Number) });
        expect(consent.extra).toBeUndefined();
    });

    it('trial-consent revocation persists: granted then set false reads back false', async () => {
        const { window } = env;

        await window.apiCall('/api/settings/trial-consent', 'PATCH', { ai: true });
        await window.apiCall('/api/settings/trial-consent', 'PATCH', { ai: false });

        expect((await window.apiCall('/api/settings/trial-consent', 'GET')).ai).toBe(false);
    });

    it('trial-consent writes a trialconsent vault singleton (synced record, not localStorage)', async () => {
        const { window, records } = env;

        await window.apiCall('/api/settings/trial-consent', 'PATCH', { voice: true });

        const all = await records.list('trialconsent');
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({
            recordId: 'trialconsent', deleted: false, voice: true, ai: null, tg: null,
        });
        expect(all[0].clientTs).toBeGreaterThan(0);
        expect(window.localStorage.getItem('trialconsent')).toBeNull();
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
