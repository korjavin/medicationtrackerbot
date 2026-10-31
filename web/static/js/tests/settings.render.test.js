import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

// feedback-ui's send path is not under test here (its own suite covers it).
vi.mock('../../../cloud/js/feedback-submit.js', () => ({ enqueueFeedback: vi.fn(), takeFeedbackNotice: () => '' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

// Parse the shipped index.html and hand back just the #settings-view subtree in a
// live jsdom document, plus the real settings.js helpers (bare global
// function-decls, so window.eval exposes them as window.<name>).
function loadSettingsView() {
    const html = fs.readFileSync(path.join(REPO_ROOT, 'web/static/index.html'), 'utf8');
    const dom = new JSDOM('<!DOCTYPE html>', { url: 'https://example.test/', runScripts: 'outside-only' });
    const { window } = dom;
    const { document } = window;
    const view = new window.DOMParser()
        .parseFromString(html, 'text/html')
        .getElementById('settings-view');
    document.body.appendChild(document.importNode(view, true));
    const src = fs.readFileSync(
        path.join(REPO_ROOT, 'web/static/js/features/settings.js'),
        'utf8'
    );
    window.eval(src);
    return { window, document, cleanup: () => dom.window.close() };
}

// Home row (data-settings-open) → the section selectors its page must contain.
const ROWS = [
    ['features', ['.wg-settings-features', '[input-id="bp-feature-toggle"]', '[input-id="live-hr-feature-toggle"]']],
    ['targets', ['#food-target-settings', '#gamification-targets-settings']],
    ['notifications', ['.wg-settings-notifications-cloud', '.wg-settings-reminders']],
    ['units', ['.wg-settings-units']],
    ['integrations', ['#settings-integrations', '[data-settings-open="telegram"]']],
    ['devices', ['.wg-settings-cloud-devices']],
    ['backup', ['#settings-importexport', '#importexport-reset-sync-group']],
    ['account', ['.wg-settings-privacy', '.wg-settings-danger']],
];

const page = (document, name) => document.querySelector(`.wg-settings-pages > [data-settings-page="${name}"]`);
const row = (document, name) => document.querySelector(`.wg-settings-home [data-settings-open="${name}"]`);

describe('Settings reads crossing provider reload commitment', () => {
    // The actual presenter/worker integration owns setting this content-free
    // flag. These cases pause each real Settings helper at its injected read
    // port, then verify the committed form cannot be repainted by that result.
    it.each(['targets', 'mode', 'devices', 'nudge', 'bmi', 'kit', 'vault', 'privacy',
        'sync-card', 'sync-section', 'local-text', 'local-permission', 'native-wake',
        'push-permission', 'push-module', 'push-subscription', 'push-note',
        'reminder-module', 'reminder-pref'])('%s cannot mutate the committed document or begin more lazy work', async (kind) => {
        const { window, document, cleanup } = loadFrontendEnv();
        let observer;
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            window.MedTrackerCloud = { ctx: { accountId: 'fixture' } };
            let release;
            let started = false;
            const pending = new Promise((resolve) => { release = resolve; });
            const pause = vi.fn(() => { started = true; return pending; });
            const unused = vi.fn(async () => null);
            let begin, reply;
            if (kind === 'targets') {
                window.featureSettings.gamification = true;
                window.apiCall = pause; begin = () => window.loadGamificationTargets();
                reply = { enabled: true, targets: [{ metric_key: 'bp_systolic', is_custom: true, low: 111, high: 139, recommended_low: 110, recommended_high: 140 }] };
            } else if (kind === 'mode') {
                window.apiCall = pause; begin = () => window.loadGamificationMode();
                reply = { experiments: true, traits: true, narration: true, ed_safe: true };
            } else if (kind === 'devices' || kind === 'nudge') {
                window.fetch = pause;
                begin = () => kind === 'devices' ? window.refreshDevicesSummary() : window.bindSecondDeviceNudge();
                reply = { ok: true, json: async () => kind === 'devices' ? [{}, {}] : [{}] };
            } else if (kind === 'bmi') {
                window.applyBundleBody({ height_cm: 180, height_unit: 'cm', show_bmi: true });
                window.loadWeightDomain = async () => ({ bmi: () => 24.7 });
                window.apiCall = pause; begin = () => window.refreshBmiHint(); reply = { latest_kg: 80, ed_safe: false };
            } else if (kind === 'kit') {
                window.apiCallDirect = pause; begin = () => window.paintKitState(); reply = { how: 'none' };
            } else if (kind === 'vault') {
                window.loadCloudSyncModule = async () => ({ getSyncStatus: pause });
                begin = () => window.paintVaultCard(); reply = { lastSyncedAt: Date.now() };
            } else if (kind === 'privacy') {
                window.loadPrivacyModule = pause; begin = () => window.bindOperatorVisibility(); reply = { renderPrivacyInto: unused };
            } else if (kind === 'sync-card') {
                window.DataStore = null; window.apiCall = pause;
                begin = () => window.paintSyncCard(); reply = { records: 43, lastSavedAt: new Date().toISOString() };
            } else if (kind === 'sync-section') {
                window.InviteSheet = { pending: pause, base: async () => 'fixture.example', canRequest: async () => true };
                begin = () => window.paintSyncSection(); reply = 'https://fixture.example/claim';
            } else if (kind === 'local-text') {
                window.apiCall = pause; begin = () => window.bindLocalReminderText(); reply = { verbosity: 'detailed' };
            } else if (kind === 'local-permission' || kind === 'push-permission') {
                window.localNotificationsSupported = () => true;
                window.LocalNotifications.permission = pause;
                window.NativePush = { isSupported: () => true, token: unused };
                begin = () => kind === 'local-permission' ? window.refreshLocalNotifyState()
                    : window.refreshCloudPushToggleState(document.getElementById('cloud-push-toggle'), document.getElementById('cloud-push-status'));
                reply = 'granted';
            } else if (kind === 'native-wake') {
                window.NativePush = { isSupported: () => true, token: pause };
                begin = () => window.paintNativeWake(document); reply = 'fixture-token';
            } else if (kind === 'push-module' || kind === 'push-subscription') {
                window.localNotificationsSupported = () => false;
                window.loadCloudPushModule = kind === 'push-module' ? pause : async () => ({ getSubscription: pause });
                begin = () => window.refreshCloudPushToggleState(document.getElementById('cloud-push-toggle'), document.getElementById('cloud-push-status'));
                reply = kind === 'push-module' ? { getSubscription: unused } : {};
            } else if (kind === 'push-note') {
                window.NotifyPermission.state = pause;
                window.NotifyPermission.renderNote = unused;
                begin = () => window.paintCloudPush(document.getElementById('cloud-push-toggle'), true); reply = 'denied';
            } else {
                window.loadCloudRemindersModule = kind === 'reminder-module' ? pause
                    : async () => ({ remindersDomain: () => ({ getDeliveryPref: pause }) });
                begin = () => window.bindCloudReminderDelivery();
                reply = kind === 'reminder-module' ? { remindersDomain: unused }
                    : { delivery: 'telegram', verbosity: 'detailed', lockscreen: 'detailed' };
            }
            const work = begin();
            await vi.waitFor(() => expect(started).toBe(true));
            const controls = () => [...document.querySelectorAll('input, button, select')]
                .map((el) => [el.id, el.value, el.checked, el.disabled, el.hidden, el.placeholder]);
            const before = controls();
            const mutations = [];
            observer = new window.MutationObserver((records) => mutations.push(...records.map((r) => r.target.id || r.target.nodeName)));
            observer.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true });
            document.documentElement.setAttribute('data-provider-reload-committed', '');
            release(reply);
            await work;
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(controls()).toEqual(before);
            expect(mutations).toEqual([]);
            expect(unused).not.toHaveBeenCalled();
        } finally { observer?.disconnect(); cleanup(); }
    });
});

describe('Settings v2 home (kit S1, med-xso6.23)', () => {
    it('renders the everyday and connected groups as .wg-list of .wg-setting rows', () => {
        const { document, cleanup } = loadSettingsView();
        try {
            const groups = Array.from(document.querySelectorAll('.wg-settings-home > .wg-settings-slot > .wg-list:not(.wg-local-only):not(.wg-settings-leave-account)'));
            expect(groups.map((g) => Array.from(g.querySelectorAll('[data-settings-open]')).map((r) => r.dataset.settingsOpen)))
                .toEqual([
                    ['features', 'targets', 'notifications', 'units'],
                    ['integrations', 'devices', 'backup'],
                ]);
            // The slot-① cards (cloud vault, local Sync & backup) are cards, not rows.
            for (const r of document.querySelectorAll('.wg-settings-home .wg-list [data-settings-open]')) {
                expect(r.tagName).toBe('BUTTON');
                expect(r.classList.contains('wg-setting')).toBe(true);
                expect(r.querySelector('.wg-setting__title').textContent.trim()).not.toBe('');
            }
        } finally {
            cleanup();
        }
    });

    it('keeps every page body (and its ids) inside #settings-view in the hidden store', () => {
        const { document, cleanup } = loadSettingsView();
        try {
            expect(document.querySelector('.wg-settings-pages').hasAttribute('hidden')).toBe(true);
            for (const [name, selectors] of ROWS) {
                const body = page(document, name);
                expect(body, name).not.toBeNull();
                expect(row(document, name), name).not.toBeNull();
                for (const sel of selectors) {
                    expect(body.matches(sel) || !!body.querySelector(sel), `${sel} in ${name}`).toBe(true);
                }
            }
            // The legacy collapsible groups are gone.
            expect(document.querySelector('.wg-settings-group, details.wg-settings-group')).toBeNull();
            // Kit S9 (bd med-ckm5.9): Account & privacy is all kit rows.
            for (const name of ['account', 'operator']) {
                expect(page(document, name).querySelector('.wg-settings-section, .wg-settings-row, .wg-mono-display, details'), name).toBeNull();
            }
        } finally {
            cleanup();
        }
    });

    it('puts Re-run onboarding (ghost) in the footer with the version', () => {
        const { document, cleanup } = loadSettingsView();
        try {
            const footer = document.querySelector('#settings-view > .wg-settings-footer');
            const rerun = footer.querySelector('#settings-rerun-onboarding');
            expect(rerun.classList.contains('wg-btn')).toBe(true);
            expect(rerun.classList.contains('wg-btn--ghost')).toBe(true);
            expect(footer.querySelector('.wg-settings-version')).not.toBeNull();
        } finally {
            cleanup();
        }
    });

    it('hideEmptySettingsRows() hides a row whose page sections are all hidden and leaves others visible', () => {
        const { window, document, cleanup } = loadSettingsView();
        try {
            // Bot build: the Devices page's sections stay hidden.
            window.hideEmptySettingsRows();
            expect(row(document, 'devices').classList.contains('wg-settings-hidden')).toBe(true);
            // Notifications keeps the (always-on) Reminders section.
            expect(row(document, 'notifications').classList.contains('wg-settings-hidden')).toBe(false);
            expect(row(document, 'features').classList.contains('wg-settings-hidden')).toBe(false);

            document.querySelector('.wg-settings-cloud-devices').classList.remove('wg-settings-hidden');
            window.hideEmptySettingsRows();
            expect(row(document, 'devices').classList.contains('wg-settings-hidden')).toBe(false);
            // The vault card (the Account & privacy entry) is never revealed by it.
            document.querySelector('.wg-settings-privacy').classList.remove('wg-settings-hidden');
            window.hideEmptySettingsRows();
            expect(row(document, 'account').classList.contains('wg-settings-hidden')).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('updateFeatureTabVisibility() rolls the Targets row up after a feature toggle', () => {
        const { window, document, cleanup } = loadSettingsView();
        try {
            window.featureSettings = { food: false, gamification: false };
            window.updateFeatureTabVisibility();
            expect(row(document, 'targets').classList.contains('wg-settings-hidden')).toBe(true);

            window.featureSettings = { food: true, gamification: false };
            window.updateFeatureTabVisibility();
            expect(row(document, 'targets').classList.contains('wg-settings-hidden')).toBe(false);
            expect(document.querySelector('[data-settings-summary="targets"]').textContent).toBe('Food not set');
        } finally {
            cleanup();
        }
    });
});

describe('Settings v2 pushed pages + summaries (harness)', () => {
    it.each(['connector', 'add-device', 'device-list'])('a deferred %s module cannot render or push another page after reload commitment', async (kind) => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            window.MedTrackerCloud = { ctx: { accountId: 'fixture' } };
            let resolveModule;
            const pending = new Promise((resolve) => { resolveModule = resolve; });
            const render = vi.fn();
            window.loadCloudConnectorsModule = vi.fn(() => pending);
            window.loadCloudTransferModule = vi.fn(() => pending);
            window.loadCloudDevicesModule = vi.fn(() => pending);
            const pages = () => document.querySelectorAll('mt-modal.wg-page[id^="wg-page-"]').length;
            const before = pages();
            const work = kind === 'connector' ? window.openConnectorPage()
                : kind === 'add-device' ? window.openAddDevicePage() : window.mountCloudDevices();
            document.documentElement.setAttribute('data-provider-reload-committed', '');
            resolveModule({ renderConnectors: render, renderAddDevice: render, renderDeviceList: render });
            await work;
            expect(render).not.toHaveBeenCalled();
            expect(pages()).toBe(before);
            if (kind === 'device-list') expect(window.loadCloudConnectorsModule).not.toHaveBeenCalled();
        } finally { cleanup(); }
    });

    it('a home row pushes a WGPage holding its page body; Back returns the body to the store', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();

            row(document, 'units').click();
            const pushed = document.querySelector('mt-modal.wg-page[id^="wg-page-"]');
            expect(pushed).not.toBeNull();
            expect(pushed.querySelector('.wg-pagebar__title').textContent).toBe('Units & body');
            expect(pushed.querySelector('.wg-back').textContent).toContain('Settings');
            expect(pushed.querySelector('#weight-unit-segmented')).not.toBeNull();
            expect(page(document, 'units')).toBeNull(); // moved, not cloned
            expect(document.querySelectorAll('#weight-unit-segmented').length).toBe(1);

            pushed.querySelector('.wg-back').click();
            expect(document.querySelector('mt-modal.wg-page[id^="wg-page-"]')).toBeNull();
            expect(page(document, 'units').querySelector('#weight-unit-segmented')).not.toBeNull();
        } finally {
            cleanup();
        }
    });

    it('the folded Journey row pushes a nested page backed by "Features"', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();
            window.featureSettings = { gamification: true };
            window.SettingsView.updateFeatureToggles();

            row(document, 'features').click();
            document.querySelector('[data-settings-open="journey-extras"]').click();
            const pages = document.querySelectorAll('mt-modal.wg-page[id^="wg-page-"]');
            expect(pages.length).toBe(2);
            const nested = pages[1];
            expect(nested.querySelector('.wg-back').textContent).toContain('Features');
            expect(nested.querySelector('#gam-mode-traits-toggle')).not.toBeNull();
            nested.querySelector('.wg-back').click();
            pages[0].querySelector('.wg-back').click();
            expect(document.querySelector('mt-modal.wg-page[id^="wg-page-"]')).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('row summaries reflect live state: feature count, units, reminder channels', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            delete window.__MEDTRACKER_CLOUD__;
            await window.loadSettings();
            const summary = (name) => document.querySelector(`[data-settings-summary="${name}"]`).textContent;

            window.featureSettings = { bp: true, weight: true, food: false };
            window.SettingsView.updateFeatureToggles();
            expect(summary('features')).toBe('2 of 13 on');

            // Bot build: no cloud delivery channel in the summary.
            document.querySelector('.wg-settings-notifications-cloud').classList.add('wg-settings-hidden');
            document.getElementById('bp-reminders-toggle').checked = true;
            document.getElementById('weight-reminders-toggle').checked = false;
            window.weightUnitPreference = 'lb';
            row(document, 'notifications').click();
            document.querySelector('mt-modal.wg-page .wg-back').click(); // a page close refreshes
            expect(summary('notifications')).toBe('BP');
            expect(summary('units')).toBe('lb');
        } finally {
            cleanup();
        }
    });
});

// Kit S6 (bd med-ckm5.6): the home is a fixed row of named slots and the
// modules that boot on their own (App lock, health import, feedback) mount
// INTO theirs, so the order never depends on which one finished first.
describe('Settings home slots + mode card (kit S6)', () => {
    const SLOTS = ['mode-card', 'mode-actions', 'health', 'everyday', 'connected', 'feedback'];
    const ROWS_IN_ORDER = ['#settings-vault-card', '#settings-sync-card', '#settings-local-lock', '#health-import-row',
        '[data-settings-open="features"]', '[data-settings-open="devices"]', '#feedback-launcher'];
    const order = (document) => Array.from(document.querySelectorAll(ROWS_IN_ORDER.join(', ')))
        .map((el) => ROWS_IN_ORDER.find((sel) => el.matches(sel)));
    const permutations = (xs) => (xs.length <= 1 ? [xs]
        : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])));

    it('mounts App lock, health import and feedback into their slots in every boot order', async () => {
        const { window, document, cleanup } = loadFrontendEnv();
        // feedback-ui reads the page globals (it runs in the account document).
        const saved = { window: globalThis.window, document: globalThis.document };
        globalThis.window = window;
        globalThis.document = document;
        try {
            expect(Array.from(document.querySelectorAll('.wg-settings-home > *')).map((el) => el.dataset.settingsSlot))
                .toEqual(SLOTS);
            const [{ mountLocalLockRow }, { startHealthImport }, { mountFeedbackLauncher }] = await Promise.all([
                import('../../../cloud/js/local-policy.js'),
                import('../../../cloud/js/health-import.js'),
                import('../../../cloud/js/feedback-ui.js'),
            ]);
            window.LocalNotifications = {
                __native: { platform: 'ios', call: async (op) => (op === 'lock.status' ? { on: false, available: true } : null) },
            };
            const health = { isSupported: () => true, label: 'Apple Health' };
            const mounts = {
                lock: () => mountLocalLockRow({ win: window }),
                health: () => startHealthImport({}, { health, storage: window.localStorage, doc: document, run: async () => null }),
                feedback: () => mountFeedbackLauncher({}),
            };
            for (const boot of permutations(Object.keys(mounts))) {
                for (const id of ['settings-local-lock', 'health-import-row', 'feedback-launcher']) {
                    document.getElementById(id)?.closest('.wg-list').remove();
                }
                for (const name of boot) await mounts[name]();
                expect(order(document), boot.join(' → ')).toEqual(ROWS_IN_ORDER);
                expect(document.getElementById('settings-local-lock').closest('[data-settings-slot]').dataset.settingsSlot).toBe('mode-actions');
                expect(document.getElementById('health-import-row').closest('[data-settings-slot]').dataset.settingsSlot).toBe('health');
                expect(document.getElementById('feedback-launcher').closest('[data-settings-slot]').dataset.settingsSlot).toBe('feedback');
            }
        } finally {
            globalThis.window = saved.window;
            globalThis.document = saved.document;
            cleanup();
        }
    });

    it('cloud: "Your vault" card names the host and last sync, carries the Kit chip and opens Account & privacy', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            let kit = null;
            window.MedTrackerCloud = { ctx: { accountId: 'acct-1' } };
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            let kitReadFails = false;
            window.apiCallDirect = vi.fn(async (url) => {
                if (url === '/api/settings/emergency-kit' && !kitReadFails) return kit;
                throw new Error('offline');
            });
            window.fetch = vi.fn(async () => ({ ok: true, json: async () => [{}, {}] }));
            const syncedAt = new Date(2026, 9, 20, 9, 40).getTime();
            window.loadCloudSyncModule = () => Promise.resolve({ getSyncStatus: async () => ({ lastSyncedAt: syncedAt }) });
            const card = document.getElementById('settings-vault-card');
            const chip = document.getElementById('settings-kit-chip');
            expect(card.classList.contains('wg-settings-hidden')).toBe(true);

            await window.loadSettings();
            const hhmm = new Date(syncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            await vi.waitFor(() => expect(document.getElementById('settings-vault-meta').textContent)
                .toBe(`example.test · synced ${hhmm}`));
            expect(card.classList.contains('wg-settings-hidden')).toBe(false);
            expect(card.querySelector('.wg-chip').textContent).toBe('Cloud');
            // No kit save on any device yet → the chip nudges.
            await vi.waitFor(() => expect(chip.classList.contains('wg-settings-hidden')).toBe(false));
            expect(chip.closest('[data-settings-open]').dataset.settingsOpen).toBe('account');
            // Kit S9 (bd med-ckm5.9): the Emergency Kit row leads the Account
            // page, boxed, with a Save chip …
            const kitRow = document.getElementById('settings-account-kit-row');
            const accountPage = page(document, 'account');
            expect(accountPage.firstElementChild).toBe(kitRow);
            expect(kitRow.classList.contains('wg-setting--boxed')).toBe(true);
            expect(kitRow.textContent).toMatch(/Not downloaded on any device yet/);
            expect(document.getElementById('settings-account-kit-save').classList.contains('wg-settings-hidden')).toBe(false);

            kit = { savedAt: 1, how: 'download' };
            await window.loadSettings();
            await vi.waitFor(() => expect(chip.classList.contains('wg-settings-hidden')).toBe(true));
            // … and once saved it is the Account list's last plain row.
            expect(document.getElementById('settings-account-list').lastElementChild).toBe(kitRow);
            expect(kitRow.classList.contains('wg-setting--boxed')).toBe(false);
            expect(document.getElementById('settings-account-kit-save').classList.contains('wg-settings-hidden')).toBe(true);

            // A new code nobody confirmed saving: the kit is unsaved again.
            kit = { savedAt: 2, how: 'none' };
            await window.loadSettings();
            await vi.waitFor(() => expect(chip.classList.contains('wg-settings-hidden')).toBe(false));

            // A failed read is no evidence the kit is unsaved: no nag.
            kitReadFails = true;
            await window.loadSettings();
            await vi.waitFor(() => expect(chip.classList.contains('wg-settings-hidden')).toBe(true));

            const topPage = () => Array.from(document.querySelectorAll('mt-modal.wg-page[id^="wg-page-"]')).pop();
            const pushedTitle = () => topPage()?.querySelector('.wg-pagebar__title').textContent;
            // SC1/SC2 (bd med-y7b4.1): the card opens Account & privacy, which
            // keeps its title and has no Leave section (that row is on the home).
            card.click();
            await vi.waitFor(() => expect(pushedTitle()).toBe('Account & privacy'));
            expect(topPage().querySelector('.wg-settings-privacy')).not.toBeNull();
            expect(topPage().querySelector('.wg-settings-leave-account, #settings-leave-account-btn')).toBeNull();
            expect(topPage().textContent).not.toMatch(/without an account/);
            topPage().querySelector('.wg-back').click();
            // The Account & privacy row is gone from the list: the card is the only entry.
            expect(document.querySelectorAll('.wg-settings-home [data-settings-open="account"]').length).toBe(1);
            expect(document.querySelector('.wg-settings-home [data-settings-open="account"]')).toBe(card);

            // Devices & connectors keeps its row (its modules stubbed, as in settings.toggles).
            window.loadCloudDevicesModule = () => Promise.resolve({ renderDeviceList: vi.fn() });
            window.loadCloudConnectorsModule = () => Promise.resolve({ claudeConnectorMode: async () => 'remote' });
            row(document, 'devices').click();
            // Let the page's async connector refresh land before cleanup.
            await vi.waitFor(() => expect(document.getElementById('settings-claude-connector-status').textContent)
                .toBe('Connected'));
            await vi.waitFor(() => expect(pushedTitle()).toBe('Devices & connectors'));
        } finally {
            delete window.__MEDTRACKER_CLOUD__;
            cleanup();
        }
    });

    it('local mode keeps its own card: the vault card and Kit chip stay hidden', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            document.documentElement.classList.add('wg-local-vault');
            window.apiCall = vi.fn(async () => null);
            window.apiCallDirect = vi.fn(async () => null);
            // The local-mode binders need a shell this harness lacks; only the cloud branch matters here.
            await window.loadSettings().catch(() => {});
            expect(document.getElementById('settings-vault-card').classList.contains('wg-settings-hidden')).toBe(true);
            expect(document.getElementById('settings-kit-chip').classList.contains('wg-settings-hidden')).toBe(true);
            expect(window.apiCallDirect).not.toHaveBeenCalledWith('/api/settings/emergency-kit', 'GET');
        } finally {
            delete window.__MEDTRACKER_CLOUD__;
            cleanup();
        }
    });

    // W5 (bd med-ta2n.5): slot ① in local mode is "Sync & backup"; it opens
    // the backup page under its own title, and the Backup & import row is
    // the account's entry only.
    const pagedTitle = (document) => Array.from(document.querySelectorAll('mt-modal.wg-page[id^="wg-page-"]')).pop()
        ?.querySelector('.wg-pagebar__title').textContent;

    it('local mode: the Sync & backup card, its chip off the protection status, opens "Sync & backup"', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            document.documentElement.classList.add('wg-local-vault');
            let status = { records: 43, lastBackupAt: null, lastSavedAt: null };
            window.apiCall = vi.fn(async (path) => (path === '/api/protection/status' ? status : null));
            const chip = document.getElementById('settings-sync-chip');
            const meta = document.getElementById('settings-sync-meta');
            window.paintSyncCard();
            await vi.waitFor(() => expect(chip.classList.contains('wg-settings-hidden')).toBe(false));
            expect(chip.textContent).toBe('Unprotected');
            expect(chip.classList.contains('wg-chip--warn')).toBe(true);
            expect(meta.textContent).toBe('43 records · only on this iPhone');

            const day = 24 * 60 * 60 * 1000;
            status = { records: 43, lastBackupAt: null, lastSavedAt: Date.now() - 3 * day };
            window.paintSyncCard();
            await vi.waitFor(() => expect(chip.textContent).toBe('Saved · 3 days ago'));
            expect(chip.classList.contains('wg-chip--warn')).toBe(false);

            status = { records: 1, lastBackupAt: Date.now(), lastSavedAt: Date.now() - 3 * day };
            window.paintSyncCard();
            await vi.waitFor(() => expect(chip.textContent).toBe('Backed up · today'));
            expect(chip.classList.contains('wg-chip--ok')).toBe(true);
            expect(meta.textContent).toBe('1 record · only on this iPhone');

            const row = document.querySelector('.wg-settings-home .wg-setting[data-settings-open="backup"]');
            expect(row.classList.contains('wg-cloud-only')).toBe(true);
            window.SettingsView.openSettingsPage('backup');
            await vi.waitFor(() => expect(pagedTitle(document)).toBe('Sync & backup'));
        } finally {
            cleanup();
        }
    });

    it('cloud mode: the backup page keeps its Backup & import title', async () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.SettingsView.openSettingsPage('backup');
            await vi.waitFor(() => expect(pagedTitle(document)).toBe('Backup & import'));
        } finally {
            cleanup();
        }
    });
});
