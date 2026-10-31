// bd med-y5xx.1 — the iOS visual QA driver (tests/visual/driver.js), which only
// the QA=1 bundle carries. Runs the REAL local-boot.js and the real Settings →
// Backup import over a fake-indexeddb store, like cloud.local-mode.test.js, then
// evals the driver as the bundle's last classic script: first load seeds the
// golden vault (and would reload), the next loads navigate to their scene and
// publish the accessible ready node with the probe report.
import 'fake-indexeddb/auto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    afterEach, beforeEach, describe, expect, it, vi
} from 'vitest';
import { loadFrontendEnv, createMockResponse } from './helpers/frontend-harness.js';
import { cancelReminderRecompute } from '../../../cloud/js/reminders.js';
import { allowConsoleNoise } from './helpers/setup.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const LOCAL_BOOT_SRC = read('../../../cloud/js/local-boot.js').replace(/\bimport\(/g, '__imp(');
const DRIVER_SRC = read('../../../../tests/visual/driver.js');
const TODAY_SRC = read('../features/today.js');
const QA_FILES = {
    '/qa/scenes.json': JSON.parse(read('../../../../tests/visual/scenes.json')),
    '/qa/vault-v1.json': JSON.parse(read('../../../../tests/fixtures/vault-v1.json')),
};
const MODULES = {
    '/js/apishim.js': () => import('../../../cloud/js/apishim.js'),
    '/js/sync.js': () => import('../../../cloud/js/sync.js'),
    '/js/local-policy.js': () => import('../../../cloud/js/local-policy.js'),
};

function deleteDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase('medtracker-cloud');
        req.onsuccess = resolve;
        req.onerror = () => reject(req.error);
    });
}

describe('iOS visual QA driver (med-y5xx.1)', () => {
    let env;
    let pendingLoads;

    beforeEach(async () => {
        // Seeding ends in importexport.js's location.reload (a jsdom no-op).
        allowConsoleNoise();
        await deleteDb();
        const fetchImpl = vi.fn(async (url) => {
            const body = QA_FILES[new URL(String(url), 'wgapp://local/').pathname];
            return body ? createMockResponse({ json: body }) : createMockResponse({ status: 503, json: {} });
        });
        vi.stubGlobal('fetch', fetchImpl);
        env = loadFrontendEnv({ withWorkout: true, url: 'https://example.test/?qa=today' });
        env.window.fetch = fetchImpl;
        // Track every Today load so teardown can await them: a load resolving
        // after env.cleanup() hit the removed `document` (med-i7v5).
        pendingLoads = [];
        const realLoadToday = env.window.loadToday;
        env.window.loadToday = (...args) => {
            const p = realLoadToday(...args);
            pendingLoads.push(p.then(() => null, (err) => err || new Error('loadToday rejected')));
            return p;
        };
        env.window.eval(TODAY_SRC);
        const run = new Function('window', '__imp', LOCAL_BOOT_SRC); // eslint-disable-line no-new-func
        run(env.window, (spec) => MODULES[spec]());
        await env.window.MedTrackerCloudReady;
        // The node-env importAll defaults its win to globalThis.window (unset
        // here; the shell's page always has one). Pass the page's, and count.
        const real = env.window.CloudVault.importAll;
        env.window.CloudVault = {
            ...env.window.CloudVault,
            importAll: vi.fn((json) => real(json, { win: env.window })),
        };
        // bootstrap.js's first switchTab: the driver waits for it.
        env.window.switchTab('today');
    });

    afterEach(async () => {
        try {
            // A loader exception still fails the test; teardown runs regardless.
            const failures = (await Promise.all(pendingLoads)).filter(Boolean);
            if (failures.length) throw failures[0];
        } finally {
            cancelReminderRecompute({ accountId: 'local' });
            env.cleanup();
            vi.unstubAllGlobals();
        }
    });

    async function load(scene) {
        const { window } = env;
        window.history.replaceState({}, '', `/?qa=${scene}`);
        window.eval(DRIVER_SRC);
        await window.__wgQA.done;
        const node = window.document.getElementById('wg-qa-ready');
        return node && JSON.parse(node.getAttribute('aria-label'));
    }

    it('boots from a document-start injection before the parser creates the root element', async () => {
        const { window } = env;
        const root = window.document.documentElement;
        window.document.removeChild(root);
        try {
            // The cloud runner uses addInitScript: its initial document has no
            // documentElement, unlike the local bundle's ordinary script tag.
            window.eval(DRIVER_SRC);
        } finally {
            window.document.appendChild(root);
        }
        await window.__wgQA.done;
        expect(window.CloudVault.importAll).toHaveBeenCalledTimes(1);
        expect(await load('today')).toMatchObject({ ok: true, failed: [] });
    });

    it('seeds the golden vault once, then publishes ok ready nodes for today and the food add sheet', async () => {
        const { window } = env;

        // First load: empty store → seed through the Backup import, no scene yet.
        expect(await load('today')).toBeNull();
        expect(window.CloudVault.importAll).toHaveBeenCalledTimes(1);
        // Dates moved to today, so the last week has the fixture's readings.
        expect((await window.apiCall('/api/bp?days=7')).length).toBeGreaterThan(0);

        const today = await load('today');
        expect(today).toMatchObject({ scene: 'today', ok: true, failed: [] });
        expect(today.probes).toMatchObject({ scale: 1, clippedTop: [], canvasOverflow: [], focusUnderKeyboard: false, bottomNavCovered: false });
        const node = window.document.getElementById('wg-qa-ready');
        expect(node.getAttribute('role')).toBe('status');
        expect(node.classList.contains('wg-qa-hidden')).toBe(true);
        expect(window.document.getElementById('today-view').classList.contains('active')).toBe(true);

        const sheet = await load('food-add-sheet');
        expect(sheet).toMatchObject({ scene: 'food-add-sheet', ok: true, failed: [] });
        expect(window.document.getElementById('food-add-sheet').classList.contains('hidden')).toBe(false);

        // Idempotent: the later loads found content and never imported again.
        expect(window.CloudVault.importAll).toHaveBeenCalledTimes(1);
        expect(window.document.querySelectorAll('#wg-qa-ready')).toHaveLength(1);
    });

    it('opens the Generic hint through a real projected reminder slot and keeps its once-only guard', async () => {
        const { window } = env;
        expect(await load('today')).toBeNull();
        // Establish the original scene's failure through the real projection:
        // its arbitrary current instant is not the first medication's slot.
        const meds = await window.apiCall('/api/medications');
        const synthetic = new window.Date().toISOString();
        const absent = await window.apiCall(`/api/doses?at=${encodeURIComponent(synthetic)}`);
        expect(absent.some((row) => row.medId === meds.find((med) => !med.archived).id)).toBe(false);
        await window.apiCall('/api/settings/reminder-delivery', 'PUT', { verbosity: 'detailed' });
        const action = vi.spyOn(window, 'handlePushAction');

        const report = await load('meds-take-reminder-hint');
        expect(report).toMatchObject({ ok: true, failed: [] });
        const [kind, params] = action.mock.calls.at(-1);
        expect(kind).toBe('medication_confirm');
        const scheduled = params.get('scheduled');
        const rows = await window.apiCall(`/api/doses?at=${encodeURIComponent(scheduled)}`);
        const row = rows.find((r) => String(r.medId) === params.get('ids'));
        expect(row).toMatchObject({ state: 'due', plannedAt: scheduled });
        expect(report.reminderSlot).toMatchObject({ occId: row.occId, medId: row.medId, plannedAt: scheduled });
        expect(window.document.querySelector('#med-confirm-list > *')).not.toBeNull();
        expect(window.document.querySelector('#med-confirm-hint [data-reminder-hint]').textContent)
            .toContain('Want the medication name on the lock screen?');

        window.closeMedicationConfirmModal();
        window.handlePushAction(kind, params);
        await new Promise((resolve) => setTimeout(resolve, 650));
        expect(window.document.querySelector('#med-confirm-hint [data-reminder-hint]')).toBeNull();
    });

    it.each([null, 'exercises'])('opens a fresh empty workout after restored subtab %s, including ordered reruns', async (stored) => {
        const { window } = env;
        expect(await load('today')).toBeNull();
        const prior = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
        await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: prior.id, exercise_id: 999, exercise_name: 'Existing row', source: 'library',
            sets: [{ weight_kg: 16, reps: 10 }],
        });
        if (stored) window.localStorage.setItem('mt-workouts-subtab', stored);
        else window.localStorage.removeItem('mt-workouts-subtab');
        let previousId = prior.id;
        for (let run = 0; run < 2; run++) {
            const report = await load('workout-next-step-empty');
            const selected = window.document.querySelector('.workout-tab.active')?.dataset.tab;
            expect({ report, selected }).toMatchObject({ report: { ok: true, failed: [] }, selected: 'history' });
            expect(window.WorkoutSessionsState.data).toMatchObject({ group_id: -1, status: 'in_progress' });
            expect(window.WorkoutSessionsState.logs).toEqual([]);
            expect(window.WorkoutSessionsState.data.id).not.toBe(previousId);
            previousId = window.WorkoutSessionsState.data.id;
            const addStep = window.document.getElementById('workout-session-addstep');
            expect(addStep.querySelector('.wg-ex__name').textContent).toBe('What’s next?');
            expect(addStep.querySelector('#workout-session-addstep-search').placeholder)
                .toBe('Search your exercises and the library');
            expect(window.document.querySelector('#workout-session-logs .wg-set')).toBeNull();
            await window.closeWorkoutSessionModal();
            if (run === 0) {
                // Another real scene changes the persisted subtab between runs.
                expect(await load('workouts-plans')).toMatchObject({ ok: true });
                window.document.querySelector('.workout-tab[data-tab="exercises"]').click();
                expect(window.localStorage.getItem('mt-workouts-subtab')).toBe('exercises');
            }
        }
    }, 30000);

    it('tags the API-key input without changing its product ID and maps both runner lookups to it', async () => {
        const { window } = env;
        expect(await load('today')).toBeNull();
        expect(await load('settings-ai-key-keyboard')).toMatchObject({ ok: true, failed: [] });
        const field = window.document.getElementById('integrations-openai-api-key');
        expect(field).not.toBeNull();
        expect(field.getAttribute('aria-label')).toBe('wg-qa-api-key');
        expect(window.document.getElementById('wg-qa-api-key')).toBeNull();
        const scene = QA_FILES['/qa/scenes.json'].scenes.find((s) => s.name === 'settings-ai-key-keyboard');
        const tap = scene.native.find((s) => s.tap);
        // QA.webElement matches the tag's AX label when WKWebView omits ID.
        expect(tap.tap.slice(1)).toBe(field.getAttribute('aria-label'));
        // Playwright uses the exact placeholder fallback for a retained DOM ID.
        expect(tap.placeholder).toBe(field.placeholder);
        expect([...window.document.querySelectorAll('input')].filter((el) => el.placeholder === tap.placeholder)).toEqual([field]);
        field.focus();
        expect(window.__wgQA.probe().probes.focusContext).toMatchObject({
            target: expect.stringContaining('#integrations-openai-api-key'), editable: true,
        });
    });

    it('does not reschedule or offer permission again for an already Generic reminder fixture', async () => {
        const { window } = env;
        expect(await load('today')).toBeNull();
        expect(await window.apiCall('/api/settings/reminder-delivery')).toMatchObject({ verbosity: 'generic' });
        const api = vi.spyOn(window, 'apiCall');
        const report = await load('meds-take-reminder-hint');
        expect(report).toMatchObject({ ok: true, failed: [] });
        // PUT is a UI-origin write that recomputes reminders with askPermission
        // (reminders.js). Reading an already-correct fixture must not send it.
        expect(api.mock.calls.filter(([path, method]) => path === '/api/settings/reminder-delivery' && method === 'PUT')).toEqual([]);
        expect(window.document.querySelector('#med-confirm-hint [data-reminder-hint]')).not.toBeNull();
    });

    function focusGeometry() {
        const { window } = env;
        const viewport = { offsetTop: 0, width: 390, height: 800, scale: 1, addEventListener() {} };
        let layoutHeight = 800;
        let focusBottom = 350;
        let visualRects = false;
        Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => layoutHeight });
        Object.defineProperty(window.document.documentElement, 'clientHeight', { configurable: true, get: () => layoutHeight });
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
        vi.spyOn(window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
            const top = this.style.position === 'fixed' ? (visualRects ? -viewport.offsetTop : 0)
                : this === window.document.activeElement ? focusBottom - 30 : visualRects ? 0 : viewport.offsetTop;
            return { top, bottom: top + 30, left: 0, right: 100, width: 100, height: 30, x: 0, y: top };
        });
        return {
            viewport,
            shrink: (height) => { layoutHeight = height; viewport.height = height; },
            pan: (offset, fromVisual) => { viewport.offsetTop = offset; visualRects = fromVisual; },
            focusBottom: (bottom) => { focusBottom = bottom; },
        };
    }

    it.each(['non-input', 'background-input'])('does not call a no-keyboard consent focus keyboard occlusion (%s)', async (target) => {
        const { window } = env;
        const geometry = focusGeometry();
        expect(await load('today')).toBeNull();
        expect(await load('trial-consent')).toMatchObject({ ok: true });
        const modal = window.document.getElementById('trial-consent-modal-anon');
        let focused = modal.querySelector('[data-trial-consent-choice="allow"]');
        if (target === 'background-input') {
            focused = window.document.createElement('input');
            focused.id = 'qa-background-focus';
            window.document.body.append(focused);
        }
        focused.focus();
        geometry.focusBottom(900);
        expect(window.document.activeElement).toBe(focused);
        const report = window.__wgQA.probe();
        expect(report.failed).not.toContain('focusUnderKeyboard');
        expect(report.probes).toMatchObject({ keyboardShown: false, focusUnderKeyboard: false });
        expect(report.probes.focusContext).toMatchObject({ target: expect.any(String), editable: target === 'background-input', onTop: target !== 'background-input' });
    });

    it.each([
        { visual: false, occluded: true }, { visual: false, occluded: false },
        { visual: true, occluded: true }, { visual: true, occluded: false },
    ])('keeps true keyboard visibility when both heights shrink (visual rects $visual, occluded $occluded)', async ({ visual, occluded }) => {
        const { window } = env;
        const geometry = focusGeometry();
        expect(await load('today')).toBeNull();
        expect(await load('trial-consent')).toMatchObject({ ok: true });
        const input = window.document.createElement('input');
        input.id = 'qa-modal-focus';
        window.document.getElementById('trial-consent-modal-anon').append(input);
        input.focus();
        geometry.shrink(400);
        geometry.pan(300, visual);
        const top = visual ? 0 : 300;
        geometry.focusBottom(top + (occluded ? 650 : 350));
        const report = window.__wgQA.probe();
        expect(report.probes).toMatchObject({ keyboardShown: true, focusUnderKeyboard: occluded });
        expect(report.failed.includes('focusUnderKeyboard')).toBe(occluded);
        expect(report.probes.focusContext).toMatchObject({ editable: true, onTop: true, viewportTop: top, viewportBottom: top + 400 });
        if (!occluded) expect(report.failed).toEqual([]);
    });

    it('reports an offscreen editable field as visibility, not a keyboard that is absent', async () => {
        const { window } = env;
        const geometry = focusGeometry();
        expect(await load('today')).toBeNull();
        expect(await load('trial-consent')).toMatchObject({ ok: true });
        const input = window.document.createElement('input');
        window.document.getElementById('trial-consent-modal-anon').append(input);
        input.focus();
        geometry.focusBottom(900);
        const report = window.__wgQA.probe();
        expect(report.probes).toMatchObject({ keyboardShown: false, focusUnderKeyboard: false, focusOutsideViewport: true });
        expect(report.failed).toContain('focusOutsideViewport');
        expect(report.failed).not.toContain('focusUnderKeyboard');
    });

    // med-m1x5: iOS WKWebView measures client rects from the visual viewport;
    // the probe used to compare them with vv.offsetTop and flagged an on-screen
    // sheet header. The page behind the open sheet doesn't count either.
    it('clippedTop measures from the visible top in either rect space and ignores the page behind a sheet', async () => {
        const { window } = env;
        expect(await load('today')).toBeNull();
        expect(await load('food-add-sheet')).toMatchObject({ ok: true });

        const sheethead = window.document.querySelector('#food-add-sheet .wg-sheethead');
        expect(sheethead).not.toBeNull();
        let headTop = 50;
        const rectFor = (el) => {
            const fixedMarker = el.style.position === 'fixed';
            let top = 0;
            if (fixedMarker || el.classList.contains('wg-appbar')) top = -300; // layout top, panned away
            else if (el === sheethead) top = headTop;
            return { top, bottom: top + 40, left: 0, right: 100, width: 100, height: 40, x: 0, y: top };
        };
        vi.spyOn(window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () { return rectFor(this); });
        // WebKit: rects relative to the visual viewport, panned 300px by the keyboard.
        Object.defineProperty(window, 'visualViewport', {
            configurable: true,
            value: { offsetTop: 300, height: 400, scale: 1, addEventListener() {} },
        });

        expect(window.__wgQA.probe().probes.clippedTop).toEqual([]);
        headTop = -10;
        expect(window.__wgQA.probe().probes.clippedTop).toEqual(['header.wg-sheethead']);
    });

    // med-y5xx.15: the meds timeline scrolls to today and a scene step scrolls
    // a Settings row into view; the in-flow app bar above was scrolled past.
    it('clippedTop ignores an in-flow header the document scrolled past', async () => {
        const { window } = env;
        expect(await load('today')).toBeNull();
        expect(await load('today')).toMatchObject({ ok: true });

        let pan = 0;
        let hdr = -30; // app bar top in layout coordinates
        vi.spyOn(window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
            let top = 0;
            if (this.style.position === 'fixed') top = -pan; // layout-top marker
            else if (this.classList.contains('wg-appbar')) top = hdr - pan;
            return { top, bottom: top + 40, left: 0, right: 100, width: 100, height: 40, x: 0, y: top };
        });
        const scrollTo = (y) => Object.defineProperty(window, 'scrollY', { configurable: true, value: y });
        scrollTo(0);
        expect(window.__wgQA.probe().probes.clippedTop).toContain('header.wg-appbar');
        scrollTo(100);
        expect(window.__wgQA.probe().probes.clippedTop).toEqual([]);
        // Above the document origin: still clipped, scrolled or not.
        scrollTo(10);
        expect(window.__wgQA.probe().probes.clippedTop).toContain('header.wg-appbar');
        // WebKit: rects from the visual viewport, panned 300px by the keyboard.
        pan = 300;
        Object.defineProperty(window, 'visualViewport', {
            configurable: true,
            value: { offsetTop: pan, height: 400, scale: 1, addEventListener() {} },
        });
        scrollTo(100);
        expect(window.__wgQA.probe().probes.clippedTop).toEqual([]);
        // Scrolled page, header still inside the layout viewport (layout y 10)
        // but panned off by the keyboard: clipped, not scrolled past.
        hdr = 10;
        expect(window.__wgQA.probe().probes.clippedTop).toContain('header.wg-appbar');
    });

    // med-y5xx.11: a shot of another view must not pass (workouts-stats showed
    // Plans with ok:true): the report re-checks the ready selectors.
    it('re-publishes a failed report when the scene view goes away after ready', async () => {
        const { window } = env;
        expect(await load('today')).toBeNull();
        expect(await load('today')).toMatchObject({ ok: true, failed: [] });

        window.document.getElementById('today-view').classList.add('hidden');
        await new Promise((r) => setTimeout(r, 400));
        const report = JSON.parse(window.document.getElementById('wg-qa-ready').getAttribute('aria-label'));
        expect(report).toMatchObject({ scene: 'today', ok: false });
        expect(report.failed).toContain('ready');
        expect(report.probes.readyLost).toContain('#today-view.active');
    });

    it.each(['sleep', 'steps', 'hr', 'spo2', 'missing'])('rejects incorrect rendered Health values (%s) while the API remains correct', async (defect) => {
        const { window } = env;
        expect(await load('today')).toBeNull();
        const overview = {
            average_sleep_hours_7d: 7, average_sleep_hours_30d: 7,
            average_steps_7d: 4000, average_steps_30d: 4000,
            average_heart_rate_7d: 65, average_heart_rate_30d: 65,
            average_spo2_7d: 98, average_spo2_30d: 98,
            sleep_stats_7d: [], sleep_stats_30d: [], step_stats_7d: [], step_stats_30d: [],
            heart_rate_history_7d: [], heart_rate_history_30d: [], spo2_history_7d: [], spo2_history_30d: [],
        };
        const call = window.apiCall;
        window.apiCall = (path, ...args) => path.startsWith('/api/health/overview')
            ? Promise.resolve(overview) : call(path, ...args);
        // Native save/import has its own Simulator proof. Here the real renderer
        // gets a correct API response, then only its DOM output is corrupted.
        const nativeScene = QA_FILES['/qa/scenes.json'].scenes.find((s) => s.name === 'health-kit-import');
        const scene = { ...nativeScene, name: 'health-render-check', steps: [{ tab: 'health' }] };
        window.__wgQAFiles = { ...QA_FILES, '/qa/scenes.json': { scenes: [scene] } };
        expect(await load(scene.name)).toMatchObject({ ok: true, failed: [] });

        const vital = defect === 'missing' ? 'spo2' : defect;
        const value = window.document.querySelector(`.wg-health-summary__tile[data-vital="${vital}"] .wg-health-summary__value`);
        expect(value).not.toBeNull();
        if (defect === 'missing') value.remove();
        else value.textContent = '0';
        expect(await window.apiCall('/api/health/overview')).toEqual(overview);
        await vi.waitFor(() => {
            const report = JSON.parse(window.document.getElementById('wg-qa-ready').getAttribute('aria-label'));
            expect(report.ok).toBe(false);
            expect(report.failed).toContain('rendered');
            expect(report.probes.renderedValues.some((v) => v.expected !== v.actual)).toBe(true);
        });
    });

    it('publishes a failed report for a scene the list does not have', async () => {
        expect(await load('no-such-scene')).toMatchObject({ scene: 'no-such-scene', ok: false });
        expect(env.window.CloudVault.importAll).not.toHaveBeenCalled();
    });
});

describe('web visual scene selection', () => {
    const runner = fileURLToPath(new URL('../../../../tests/visual/playwright/run.mjs', import.meta.url));
    function list(filter) {
        const env = { ...process.env };
        if (filter === undefined) delete env.WG_QA_SCENES;
        else env.WG_QA_SCENES = filter;
        return spawnSync(process.execPath, [runner, '--list-scenes'], { env, encoding: 'utf8' });
    }

    it('keeps the ordinary full run only when the scene filter is absent', () => {
        const absent = list(undefined);
        expect(absent.status).toBe(0);
        expect(JSON.parse(absent.stdout)).toEqual(expect.arrayContaining(['today', 'meds-take-reminder-hint', 'trial-consent']));
        const empty = list('');
        expect(empty.status).toBe(1);
        expect(empty.stderr).toContain('WG_QA_SCENES contains an empty scene name');
    });

    it('selects exactly known eligible scenes and refuses a partial request', () => {
        const chosen = list('meds-take-reminder-hint, trial-consent');
        expect(chosen.status).toBe(0);
        expect(JSON.parse(chosen.stdout)).toEqual(['meds-take-reminder-hint', 'trial-consent']);
        for (const invalid of ['today,no-such-scene', 'today,health-kit-import', 'today,,trial-consent']) {
            const result = list(invalid);
            expect(result.status).toBe(1);
            expect(result.stderr).toContain('WG_QA_SCENES contains');
        }
    });
});
