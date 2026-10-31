// Plan 2026-07-05 cloud-c2a, Task 5 — shim-mode contract run of the Settings
// flows against web/domain/settings.js. Drives the real feature code
// (toggleFeatureSetting, saveTabOrder, loadFoodTargets/saveFoodTargets,
// SettingsIntegrations.load/save) through the real window.apiCall
// (core/api.js), which delegates to the cloud shim (web/cloud/js/apishim.js)
// instead of the network. Additive suite — the original (network-mocked)
// settings.*.test.js files keep running unshimmed.
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApiCache, loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';
import { userContentCount } from '../../../domain/vault.js';
import { installApiShim } from '../../../cloud/js/apishim.js';

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
        vi.restoreAllMocks();
        env.cleanup();
        env = null;
    });

    it('Check uses a direct in-memory port; registration failure/retry never upgrades this document policy', async () => {
        allowConsoleNoise(); // the genuine egress helper logs a rejected registration status
        const uploads = [];
        let rejectRegistration = false;
        env.window.fetch = vi.fn(async (url, init) => {
            expect(url).toBe('/api/egress-hosts');
            uploads.push(init.body);
            return new Response(null, { status: rejectRegistration ? 503 : 204 });
        });
        const capability = { origins: '["https://api.openai.com"]', origin: 'https://account.example' };
        const shim = installApiShim({}, { records: env.records, win: env.window, documentPolicy: capability });
        await shim('/api/settings/integrations', 'PATCH', { openai: { api_key: 'fixture-first-key', url: 'https://api.openai.com/v1', model: 'gpt-6-luna' } });
        expect(await shim.aiProviderRegistration()).toEqual({ state: 'registered' });
        const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'fixture-check', object: 'chat.completion', created: 1, model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'length' }] }), { status: 200 }));
        expect(await shim.checkAIKey({ intent: 'saved', draft: { api_key: '***', url: 'https://api.openai.com/v1' } })).toMatchObject({ state: 'success' });
        expect(provider.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture-first-key');
        rejectRegistration = true;
        await shim('/api/settings/integrations', 'PATCH', { openai: { api_key: 'fixture-second-key', url: 'https://b.example/v1' } });
        expect(await shim.aiProviderRegistration()).toEqual({ state: 'failed' });
        const args = { intent: 'saved', draft: { api_key: '***', url: 'https://b.example/v1' } };
        expect(await shim.checkAIKey(args)).toMatchObject({ state: 'needs_reload' });
        rejectRegistration = false;
        await shim('/api/settings/integrations', 'PATCH', { openai: { api_key: '***' } });
        expect(await shim.aiProviderRegistration()).toEqual({ state: 'registered' });
        capability.origins = '["https://b.example"]';
        const meta = env.document.createElement('meta');
        meta.name = 'medtracker-connect-origins'; meta.content = capability.origins; env.document.head.appendChild(meta);
        expect(await shim.checkAIKey(args)).toMatchObject({ state: 'needs_reload' });
        expect(provider).toHaveBeenCalledTimes(1);
        expect(uploads.every((body) => !body.includes('fixture-') && !body.includes('api_key'))).toBe(true);
        expect(JSON.stringify(await env.window.MedTrackerDB.ApiCache.get('settings_integrations'))).not.toContain('fixture-');
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
        expect(await window.apiCall('/api/gamification/goal-line', 'GET')).toEqual({ enabled: false, ed_safe: false });
    });

    // med-njny: ED-safe is its own promise — with Journey off the disabled
    // payload still carries ed_safe, so Today keeps hiding weight numbers.
    it('GET /api/gamification/goal-line carries ed_safe with Journey off', async () => {
        const { window } = env;
        window.rebuildCanonicalBottomNav = vi.fn();
        await window.saveGamificationMode('ed_safe', true);
        await window.toggleFeatureSetting('gamification', false);
        expect(await window.apiCall('/api/gamification/goal-line', 'GET')).toEqual({ enabled: false, ed_safe: true });
        expect((await window.apiCall('/api/bootstrap')).gamification_goal_line).toEqual({ enabled: false, ed_safe: true });
    });

    // med-njny: with Journey off the ED-safe switch stays visible and loaded,
    // and turning it off brings Today's weight numbers back.
    it('Journey off + ED-safe on → the Safety switch is visible and checked; off restores Today weight', async () => {
        allowConsoleNoise(); // loadSettings touches routes this suite does not map
        const { window, document } = env;
        window.rebuildCanonicalBottomNav = vi.fn();
        await window.apiCall('/api/weight', 'POST', { weight: 82.4, measured_at: new Date().toISOString() });
        await window.saveGamificationMode('ed_safe', true);
        await window.toggleFeatureSetting('gamification', false);
        await window.loadSettings();

        const row = document.querySelector('mt-setting-toggle[input-id="gam-mode-ed-safe-toggle"]');
        const edSafe = document.getElementById('gam-mode-ed-safe-toggle');
        expect(row.classList.contains('wg-settings-hidden')).toBe(false);
        expect(row.closest('.wg-settings-features__safety').classList.contains('wg-settings-hidden')).toBe(false);
        expect(edSafe.checked).toBe(true);

        // The frontend harness does not load features/today.js; eval it for
        // the aggregator Today renders from.
        window.eval(fs.readFileSync(new URL('../features/today.js', import.meta.url), 'utf8'));
        const todayWeight = async () => {
            const boot = await window.apiCall('/api/bootstrap');
            const caches = { gamification_goal_line: await window.apiCall('/api/gamification/goal-line', 'GET') };
            return window.TodayDashboard.aggregateToday(boot, caches, new Date()).weightLatest.status;
        };
        expect(await todayWeight()).toBe('disabled');

        edSafe.checked = false;
        edSafe.dispatchEvent(new window.Event('change'));
        await vi.waitFor(async () => expect((await window.apiCall('/api/gamification/mode', 'GET')).ed_safe).toBe(false));
        expect(await todayWeight()).toBe('ok');
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

    // bd med-ta2n.22: the harness port stamps recordType on every row the way
    // sync.js stampAndPut does, so a cross-type count (the W4 protection
    // route's userContentCount over records.list) sees production's shape.
    it('rows written through the shim carry their recordType, so userContentCount counts them', async () => {
        const { window, records } = env;
        await window.apiCall('/api/bp', 'POST', { systolic: 118, diastolic: 76, pulse: 64, measured_at: new Date().toISOString() });
        await records.put('weight', { recordId: 'w1', clientTs: 1, deleted: false, weight: 80 });
        await records.put('weight', { recordId: 'w2', clientTs: 1, deleted: false, weight: 81 });
        await records.del('weight', 'w2');

        const rows = [...await records.list('bp'), ...await records.list('weight')];
        expect(rows.map((r) => r.recordType).sort()).toEqual(['bp', 'weight']);
        expect(userContentCount(rows)).toBe(2);
        expect((await records.listRaw('weight')).find((r) => r.recordId === 'w2')).toMatchObject({ deleted: true, recordType: 'weight' });
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

    // bd med-wi09.19: the floored zone shows as the account's zone, then an
    // explicit pick replaces it (copy: Miles, Zulip 5852).
    it('Account page: the floored zone reads as the account zone; an explicit pick replaces it', async () => {
        allowConsoleNoise(); // loadSettings touches routes this suite does not map
        env.cleanup();
        env = loadCloudShimFrontendEnv({ timeZone: 'Europe/Berlin' });
        installApiCache(env.window);
        env.window.SettingsIntegrations._setTelegramLoader(() => Promise.resolve({ mountTelegram: () => {} }));
        const { window, document } = env;
        const rowEl = document.getElementById('settings-account-tz-row');
        expect(rowEl.classList.contains('wg-settings-hidden')).toBe(true);
        expect(await window.offlineAwareApiCall.floorTimeZone()).toBe(true); // the boot, after its pull

        await window.loadSettings();
        await vi.waitFor(() => expect(rowEl.classList.contains('wg-settings-hidden')).toBe(false));
        expect(document.getElementById('settings-account-tz').textContent).toBe('Europe/Berlin');
        expect(document.getElementById('settings-account-tz-desc').textContent)
            .toBe('Set automatically. Doses and reminders follow it on every device.');
        expect((await env.records.list('tzfloor'))[0]).toMatchObject({ timezone: 'Europe/Berlin', clientTs: 0 });
        // A bundle without a zone never blanks or hides what shows.
        window.paintAccountTimeZone('', '');
        expect(rowEl.classList.contains('wg-settings-hidden')).toBe(false);
        expect(document.getElementById('settings-account-tz').textContent).toBe('Europe/Berlin');

        await window.apiCall('/api/settings', 'POST', { timezone: 'Asia/Tokyo' });
        await window.DataStore.invalidateKey('settings_bundle');
        await window.loadSettings();
        await vi.waitFor(() => expect(document.getElementById('settings-account-tz').textContent).toBe('Asia/Tokyo'));
        expect(document.getElementById('settings-account-tz-desc').textContent)
            .toBe('Doses and reminders follow this zone on every device.');
    });

    // Argus r1 (1): Today's refetch writes the shared settings_bundle row;
    // Settings opening on that cached row must show the floor's copy, and a
    // Today refetch whose /api/settings read failed must not overwrite it.
    it('Settings opens on the bundle Today cached and shows the floor copy, even with /api/settings down', async () => {
        allowConsoleNoise();
        env.cleanup();
        env = loadCloudShimFrontendEnv({ timeZone: 'Europe/Berlin' });
        installApiCache(env.window);
        env.window.SettingsIntegrations._setTelegramLoader(() => Promise.resolve({ mountTelegram: () => {} }));
        const { window, document } = env;
        await window.offlineAwareApiCall.floorTimeZone();
        const bundle = await window.fetchSettingsBundle();
        expect(bundle).toMatchObject({ timezone: 'Europe/Berlin', timezoneSource: 'floor' });
        await window.DataStore.setCached('settings_bundle', bundle);

        const realApiCall = window.apiCall;
        window.apiCall = (endpoint, ...rest) => (endpoint === '/api/settings'
            ? Promise.resolve(null) : realApiCall(endpoint, ...rest));
        expect(await window.fetchSettingsBundle()).toBeNull();
        await window.loadSettings();
        await vi.waitFor(() => expect(document.getElementById('settings-account-tz').textContent).toBe('Europe/Berlin'));
        expect(document.getElementById('settings-account-tz-desc').textContent)
            .toBe('Set automatically. Doses and reminders follow it on every device.');
    });

    it('local mode: the row reads as this device\'s zone', async () => {
        const { document } = env;
        env.window.paintAccountTimeZone('Asia/Tokyo', 'device');
        expect(document.getElementById('settings-account-tz-desc').textContent)
            .toBe('Set from this device. Doses and reminders follow it.');
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
        await window.SettingsIntegrations.load();

        document.getElementById('integrations-openai-api-key').value = 'sk-test-dummy-key';
        document.getElementById('integrations-openai-url').value = 'https://api.openai.example/v1';
        // A custom food URL stored before the UI was removed (med-bpp9) must
        // survive a save from the form that no longer has the field.
        await window.apiCall('/api/settings/integrations', 'PATCH', { food: { url: 'https://usda.example/v1' } });

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
        expect((await window.apiCall('/api/settings/integrations', 'GET')).food.url).toBe('https://usda.example/v1');
    });
});
