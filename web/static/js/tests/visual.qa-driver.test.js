// bd med-y5xx.1 — the iOS visual QA driver (tests/visual/driver.js), which only
// the QA=1 bundle carries. Runs the REAL local-boot.js and the real Settings →
// Backup import over a fake-indexeddb store, like cloud.local-mode.test.js, then
// evals the driver as the bundle's last classic script: first load seeds the
// golden vault (and would reload), the next loads navigate to their scene and
// publish the accessible ready node with the probe report.
import 'fake-indexeddb/auto';
import fs from 'node:fs';
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

        vi.spyOn(window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
            const top = this.classList.contains('wg-appbar') ? -30 : 0;
            return { top, bottom: top + 40, left: 0, right: 100, width: 100, height: 40, x: 0, y: top };
        });
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
        expect(window.__wgQA.probe().probes.clippedTop).toContain('header.wg-appbar');
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 100 });
        expect(window.__wgQA.probe().probes.clippedTop).toEqual([]);
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

    it('publishes a failed report for a scene the list does not have', async () => {
        expect(await load('no-such-scene')).toMatchObject({ scene: 'no-such-scene', ok: false });
        expect(env.window.CloudVault.importAll).not.toHaveBeenCalled();
    });
});
