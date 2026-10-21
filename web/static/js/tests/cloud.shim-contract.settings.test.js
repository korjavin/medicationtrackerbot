// Plan 2026-07-05 cloud-c2a, Task 5 — shim-mode contract run of the Settings
// flows against web/domain/settings.js. Drives the real feature code
// (toggleFeatureSetting, saveTabOrder, loadFoodTargets/saveFoodTargets,
// SettingsIntegrations.load/save) through the real window.apiCall
// (core/api.js), which delegates to the cloud shim (web/cloud/js/apishim.js)
// instead of the network. Additive suite — the original (network-mocked)
// settings.*.test.js files keep running unshimmed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApiCache, loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

describe('cloud shim contract — settings flows (features/settings.js over web/domain/settings.js)', () => {
    let env;

    beforeEach(() => {
        env = loadCloudShimFrontendEnv();
        installApiCache(env.window);
        // The integrations screen mounts web/cloud/js/telegram.js via dynamic
        // import on load; JSDOM has no import callback, so stub the loader
        // seam (the module itself is covered by its own suite).
        env.window.SettingsIntegrations._setTelegramLoader(
            () => Promise.resolve({ mountTelegram: () => {} }));
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

    it('live_hr defaults off and round-trips through the shim (ported flag, no nav tab — med-byks.1)', async () => {
        const { window } = env;
        window.rebuildCanonicalBottomNav = vi.fn();

        // Same shape as weekly_digest: default off, in PORTED_SET, no nav tab
        // or /api route — the flag just persists + reads back so the Settings
        // toggle gates the experimental Vitals live-HR card.
        const boot0 = await window.apiCall('/api/bootstrap');
        window.SettingsState.applyBootstrapFeatures(boot0.features);
        expect(window.featureSettings.live_hr).toBe(false);

        await window.toggleFeatureSetting('live_hr', true);

        expect(window.featureSettings.live_hr).toBe(true);

        const flags = await window.apiCall('/api/settings/features', 'GET');
        expect(flags.live_hr).toBe(true);

        const boot = await window.apiCall('/api/bootstrap');
        expect(boot.features.live_hr).toBe(true);
    });

    // med-8tur.1: the Goal Line route carries the flag map into the read-model —
    // a feature toggled off reports feature_on:false on its row, and the
    // gamification flag gates the whole payload.
    it('GET /api/gamification/goal-line honors the workout/bp/gamification flags', async () => {
        const { window } = env;
        window.rebuildCanonicalBottomNav = vi.fn();

        const on = await window.apiCall('/api/gamification/goal-line', 'GET');
        expect(on.enabled).toBe(true);
        expect(on.goal.status).toBe('no_goal');
        expect(on.workouts.feature_on).toBe(true);
        expect(on.bp.feature_on).toBe(true);

        await window.toggleFeatureSetting('workout', false);
        await window.toggleFeatureSetting('bp', false);
        const off = await window.apiCall('/api/gamification/goal-line', 'GET');
        expect(off.workouts.feature_on).toBe(false);
        expect(off.workouts.scheduled_this_week).toBeNull();
        expect(off.bp.feature_on).toBe(false);

        await window.toggleFeatureSetting('gamification', false);
        expect(await window.apiCall('/api/gamification/goal-line', 'GET')).toEqual({ enabled: false });
    });

    // med-8tur.12: the Journey mode switches persist through the shim and gate
    // the routes — ED-safe hides the Goal Line, narration off turns the probe
    // off and every narrate POST into {text:null}.
    it('saveGamificationMode persists ED-safe / narration and the routes honor them', async () => {
        const { window } = env;

        expect(await window.apiCall('/api/gamification/mode', 'GET'))
            .toEqual({ enabled: true, ed_safe: false, experiments: true, traits: true, narration: true });
        expect((await window.apiCall('/api/gamification/narrate', 'GET')).enabled).toBe(true);

        await window.saveGamificationMode('ed_safe', true);
        await window.saveGamificationMode('narration', false);

        expect(await window.apiCall('/api/gamification/mode', 'GET')).toMatchObject({ ed_safe: true, narration: false });
        expect(await window.apiCall('/api/gamification/goal-line', 'GET')).toMatchObject({ enabled: false, ed_safe: true });
        expect(await window.apiCall('/api/gamification/narrate', 'GET')).toEqual({ enabled: false });
        expect(await window.apiCall('/api/gamification/narrate/weekly', 'POST', {})).toEqual({ text: null });
    });

    // med-8tur.5: the route materializes a reached milestone (floored) and
    // serves it as `milestone` until POST .../ack retires it.
    it('GET /api/gamification/goal-line serves a reached milestone until POST /milestones/:id/ack', async () => {
        const { window, records } = env;
        const ago = (days, hour = 7) => new Date(Date.now() - days * 86400000 - hour * 3600000).toISOString();
        for (let d = 0; d <= 20; d++) {
            await records.put('weight', { recordId: `w-${d}`, clientTs: 1, deleted: false, measured_at: ago(d), weight: 83.8 });
        }
        await records.put('weightgoal', { recordId: 'g1', clientTs: 1, deleted: false, set_at: ago(21), target_weight: 80, start_weight: 85 });

        const first = await window.apiCall('/api/gamification/goal-line', 'GET');
        expect(first.milestone).toMatchObject({ id: 'gamificationmilestone-g1-1', ordinal: 1, count: 5 });
        expect((await records.list('gamificationmilestone'))[0].clientTs).toBe(0);

        expect(await window.apiCall('/api/gamification/milestones/gamificationmilestone-g1-1/ack', 'POST')).toEqual({ ok: true });
        expect((await window.apiCall('/api/gamification/goal-line', 'GET')).milestone).toBeNull();
        expect((await records.list('gamificationmilestone'))[0].acknowledged).toBe(true);
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

    it('completing first run stores the W1 picks on the firstrun record (bd med-ta2n.1)', async () => {
        const { window, records } = env;

        await window.apiCall('/api/firstrun/complete', 'POST', { picked: ['medication', 'food', 'diary', 7] });

        const all = await records.list('firstrun');
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({ first_run_complete: true, picked: ['medication', 'food', 'diary'] });
        expect(all[0].clientTs).toBeGreaterThan(0);
    });

    // bd med-ta2n.3 — W3 Today "Start here": read-only, over the records port.
    it('GET /api/today/start-here: picks in W1 order, a module drops out of missing at its first live record', async () => {
        const { window, records } = env;
        await window.apiCall('/api/firstrun/complete', 'POST', { picked: ['food', 'medication', 'bp', 'weight'] });

        expect(await window.apiCall('/api/today/start-here', 'GET')).toEqual({
            picked: ['medication', 'bp', 'weight', 'food'],
            missing: ['medication', 'bp', 'weight', 'food'],
        });

        // A tombstone is not a record.
        await records.put('bp', { recordId: 'gone', clientTs: 1, deleted: true });
        expect((await window.apiCall('/api/today/start-here', 'GET')).missing).toContain('bp');

        await window.apiCall('/api/bp', 'POST', { systolic: 118, diastolic: 76, pulse: 64, measured_at: new Date().toISOString() });
        const after = await window.apiCall('/api/today/start-here', 'GET');
        expect(after.missing).toEqual(['medication', 'weight', 'food']);
        // Reading it wrote nothing.
        expect((await records.list('firstrun'))[0].picked).toEqual(['food', 'medication', 'bp', 'weight']);
    });

    it('GET /api/today/start-here never lists a module whose feature is off; Diary rides the Vitals flag', async () => {
        const { window } = env;
        window.rebuildCanonicalBottomNav = vi.fn();
        await window.apiCall('/api/firstrun/complete', 'POST', { picked: ['bp', 'food', 'diary'] });
        await window.toggleFeatureSetting('food', false);

        expect(await window.apiCall('/api/today/start-here', 'GET')).toEqual({ picked: ['bp', 'diary'], missing: ['bp', 'diary'] });

        await window.toggleFeatureSetting('health', false);
        expect((await window.apiCall('/api/today/start-here', 'GET')).picked).toEqual(['bp']);
    });

    it('GET /api/today/start-here: a pre-v3 vault (no stored picks) already holding user content gets no block', async () => {
        const { window } = env;
        await window.apiCall('/api/firstrun/complete', 'POST');
        await window.apiCall('/api/bp', 'POST', { systolic: 118, diastolic: 76, pulse: 64, measured_at: new Date().toISOString() });

        expect(await window.apiCall('/api/today/start-here', 'GET')).toEqual({ picked: [], missing: [] });
    });

    it('GET /api/today/start-here falls back to the six feature flags (never Diary) without stored picks or content', async () => {
        const { window } = env;
        window.rebuildCanonicalBottomNav = vi.fn();
        await window.apiCall('/api/firstrun/complete', 'POST');
        await window.toggleFeatureSetting('workout', false);

        const res = await window.apiCall('/api/today/start-here', 'GET');
        expect(res.picked).toEqual(['medication', 'bp', 'weight', 'health', 'food']);
        expect(res.missing).toEqual(res.picked);
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
        expect(consent).toEqual({ ai: null, voice: null, tg: null, anon: null, updated_at: 0 });
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
        expect(consent).toEqual({ ai: null, voice: null, tg: null, anon: null, updated_at: expect.any(Number) });
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

    it('emergency-kit: the kit page stash files into the synced emergencykit singleton on unlock (bd med-ckm5.2)', async () => {
        const { window, records } = env;
        expect(await window.apiCall('/api/settings/emergency-kit', 'GET')).toBeFalsy();

        // The ceremony page (signup.html) stashes; cloud-boot drains through the shim.
        const { stashKitSaved, drainKitSaved } = await import('../../../cloud/js/kit-state.js');
        stashKitSaved({ savedAt: 1700000000000, how: 'download' }, window.localStorage);
        await drainKitSaved((path, method, body) => window.apiCall(path, method, body), window.localStorage);

        expect(window.localStorage.getItem('wg-emergency-kit-saved')).toBeNull();
        expect(await window.apiCall('/api/settings/emergency-kit', 'GET')).toEqual({ savedAt: 1700000000000, how: 'download' });
        const all = await records.list('emergencykit');
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({ recordId: 'emergencykit', deleted: false, how: 'download' });
    });

    it('emergency-kit: an older stash drained late never replaces a newer kit state from another device', async () => {
        const { window } = env;
        await window.apiCall('/api/settings/emergency-kit', 'PUT', { savedAt: 2000, how: 'none' });

        const { stashKitSaved, drainKitSaved } = await import('../../../cloud/js/kit-state.js');
        stashKitSaved({ savedAt: 1000, how: 'download' }, window.localStorage);
        await drainKitSaved((path, method, body) => window.apiCall(path, method, body), window.localStorage);

        expect(await window.apiCall('/api/settings/emergency-kit', 'GET')).toEqual({ savedAt: 2000, how: 'none' });
        await window.apiCall('/api/settings/emergency-kit', 'PUT', { savedAt: 3000, how: 'print' });
        expect(await window.apiCall('/api/settings/emergency-kit', 'GET')).toEqual({ savedAt: 3000, how: 'print' });
    });

    it('emergency-kit: an unknown save method is refused and nothing is written', async () => {
        const { window, records } = env;
        allowConsoleNoise(); // the api layer may log the refused write

        await Promise.resolve(window.apiCall('/api/settings/emergency-kit', 'PUT', { savedAt: 1, how: 'maybe' })).catch(() => {});

        expect(await records.list('emergencykit')).toHaveLength(0);
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
