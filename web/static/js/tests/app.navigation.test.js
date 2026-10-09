/**
 * Navigation v2 (bd med-xso6.12) — the booted app's tab bar + app-bar chrome.
 *
 * Boots the real index.html + bootstrap.js (tab bar mounted by bootstrap,
 * chrome driven by features/app-nav.js) and drives it through taps:
 *   - five tabs; bp / weight / health all light the Health tab;
 *   - the Health tab reopens the last segment (mt-health-segment);
 *   - the segment strip hides with ≤1 enabled section, the Health tab only
 *     when all three are off, and a feature toggle rebuilds without reload;
 *   - gear → Settings and route → Journey, Back returns to the origin tab;
 *   - the Meds badge counts missed + overdue doses and clears once taken.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv, createMockResponse } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';
import { macrotask } from './helpers/settle.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const BOOTSTRAP_JS = path.join(REPO_ROOT, 'web/static/js/features/bootstrap.js');

const ALL_ON = Object.freeze({
    bp: true, weight: true, health: true, medication: true,
    food: true, workout: true, gamification: true,
});

async function until(predicate, rounds = 200) {
    for (let i = 0; i < rounds; i++) {
        if (predicate()) return;
        await macrotask();
    }
    throw new Error('until: condition never became true');
}

async function boot({ features = ALL_ON, savedTab = null, savedSegment = null, pageOrigin = null } = {}) {
    allowConsoleNoise();
    const env = loadFrontendEnv();
    const { window } = env;
    vi.spyOn(window, 'fetch').mockImplementation(async (url) => {
        if (url === '/api/bootstrap') return createMockResponse({ json: { features } });
        return createMockResponse({ json: {} });
    });
    window.handleDeepLinks = vi.fn();
    window.featureSettings = { ...features };
    if (savedTab) {
        window.localStorage.setItem('mt-active-tab', savedTab);
        window.localStorage.setItem('mt-active-tab-at', String(Date.now()));
    }
    if (savedSegment) window.localStorage.setItem('mt-health-segment', savedSegment);
    if (pageOrigin) window.localStorage.setItem('mt-page-origin', pageOrigin);
    window.eval(fs.readFileSync(BOOTSTRAP_JS, 'utf8'));
    await until(() => window.document.querySelector('.wg-tabbar') && window.AppStore.get('currentTab'));
    return env;
}

const tab = (document, id) => document.querySelector(`.wg-tabbar [data-nav-id="${id}"]`);
const lit = (document) => Array.from(document.querySelectorAll('.wg-tabbar .wg-tab[aria-current="page"]'))
    .map((b) => b.dataset.navId);
const activeView = (document) => document.querySelector('.view.active').id;

describe('Navigation v2 — tab bar', () => {
    it('mounts five tabs and lights Health for bp / weight / health', async () => {
        const { window, cleanup } = await boot();
        const { document } = window;
        try {
            expect(Array.from(document.querySelectorAll('.wg-tabbar .wg-tab')).map((b) => b.dataset.navId))
                .toEqual(['today', 'food', 'meds', 'workouts', 'health-group']);
            expect(lit(document)).toEqual(['today']);
            for (const section of ['bp', 'weight', 'health']) {
                window.switchTab(section);
                expect(activeView(document)).toBe(`${section}-view`);
                expect(lit(document)).toEqual(['health-group']);
            }
        } finally { cleanup(); }
    });

    it('restores mt-active-tab=weight onto the Health tab with the Weight segment pressed', async () => {
        const { window, cleanup } = await boot({ savedTab: 'weight' });
        const { document } = window;
        try {
            await until(() => activeView(document) === 'weight-view');
            expect(lit(document)).toEqual(['health-group']);
            const strip = document.querySelector('#weight-view .wg-health-seg');
            expect(strip.hidden).toBe(false);
            expect(strip.querySelector('[data-health-seg="weight"]').getAttribute('aria-pressed')).toBe('true');
            expect(window.localStorage.getItem('mt-health-segment')).toBe('weight');
        } finally { cleanup(); }
    });

    it('the Health tab reopens the last segment the user was on', async () => {
        const { window, cleanup } = await boot();
        const { document } = window;
        try {
            tab(document, 'health-group').click();
            expect(activeView(document)).toBe('bp-view'); // no memory yet → first enabled
            document.querySelector('#bp-view [data-health-seg="health"]').click();
            expect(activeView(document)).toBe('health-view');
            tab(document, 'food').click();
            expect(activeView(document)).toBe('food-view');
            tab(document, 'health-group').click();
            expect(activeView(document)).toBe('health-view');
            expect(window.localStorage.getItem('mt-health-segment')).toBe('health');
        } finally { cleanup(); }
    });

    it('a remembered segment whose feature is off falls back to the first enabled one', async () => {
        const { window, cleanup } = await boot({
            features: { ...ALL_ON, bp: false }, savedSegment: 'bp',
        });
        const { document } = window;
        try {
            tab(document, 'health-group').click();
            expect(activeView(document)).toBe('weight-view');
        } finally { cleanup(); }
    });
});

describe('Navigation v2 — feature-driven hiding', () => {
    it('hides the segment strip with one Health section, the Health tab with none, and rebuilds on toggle', async () => {
        const { window, cleanup } = await boot({
            features: { ...ALL_ON, weight: false, health: false },
        });
        const { document } = window;
        try {
            window.switchTab('bp');
            expect(lit(document)).toEqual(['health-group']);
            expect(document.querySelector('#bp-view .wg-health-seg').hidden).toBe(true);

            // Settings toggles Weight on → rebuild, no reload: strip appears with BP + Weight.
            window.featureSettings.weight = true;
            window.rebuildCanonicalBottomNav();
            const strip = document.querySelector('#bp-view .wg-health-seg');
            expect(strip.hidden).toBe(false);
            expect(strip.querySelector('[data-health-seg="weight"]').hidden).toBe(false);
            expect(strip.querySelector('[data-health-seg="health"]').hidden).toBe(true);

            // All three off → the Health tab goes; the bar shrinks to four.
            window.featureSettings.bp = false;
            window.featureSettings.weight = false;
            window.switchTab('today');
            window.rebuildCanonicalBottomNav();
            expect(tab(document, 'health-group')).toBeNull();
            expect(document.querySelectorAll('.wg-tabbar .wg-tab').length).toBe(4);
        } finally { cleanup(); }
    });
});

describe('Navigation v2 — app-bar actions', () => {
    it('every top-level view has an app-bar title', async () => {
        const { window, cleanup } = await boot();
        const { document } = window;
        try {
            for (const id of ['today', 'food', 'meds', 'workouts', 'bp', 'weight', 'health']) {
                const title = document.querySelector(`#${id}-view > .wg-appbar .wg-appbar__title`);
                expect(title, `${id} app bar`).not.toBeNull();
                expect(document.querySelector(`#${id}-view [data-nav-to="settings"]`), `${id} gear`).not.toBeNull();
            }
            for (const id of ['settings', 'journey']) {
                expect(document.querySelector(`#${id}-view > .wg-pagebar [data-nav-back]`), `${id} back`).not.toBeNull();
            }
        } finally { cleanup(); }
    });

    it('gear opens Settings with the origin tab still lit; Back returns to it', async () => {
        const { window, cleanup } = await boot();
        const { document } = window;
        try {
            tab(document, 'food').click();
            document.querySelector('#food-view [data-nav-to="settings"]').click();
            expect(activeView(document)).toBe('settings-view');
            expect(lit(document)).toEqual(['food']);
            document.querySelector('#settings-view [data-nav-back]').click();
            expect(activeView(document)).toBe('food-view');
        } finally { cleanup(); }
    });

    it('a restored Settings page keeps its origin tab lit and Back returns there', async () => {
        const { window, cleanup } = await boot({ savedTab: 'settings', pageOrigin: 'food' });
        const { document } = window;
        try {
            await until(() => activeView(document) === 'settings-view');
            expect(lit(document)).toEqual(['food']);
            document.querySelector('#settings-view [data-nav-back]').click();
            expect(activeView(document)).toBe('food-view');
        } finally { cleanup(); }
    });

    it('route icon on Today opens Journey; Back returns to Today', async () => {
        const { window, cleanup } = await boot();
        const { document } = window;
        try {
            const route = document.querySelector('#today-view [data-nav-to="journey"]');
            expect(route.hidden).toBe(false);
            route.click();
            expect(activeView(document)).toBe('journey-view');
            document.querySelector('#journey-view [data-nav-back]').click();
            expect(activeView(document)).toBe('today-view');
        } finally { cleanup(); }
    });

    it('route icon hides when gamification is off', async () => {
        const { window, cleanup } = await boot({ features: { ...ALL_ON, gamification: false } });
        try {
            expect(window.document.querySelector('#today-view [data-nav-to="journey"]').hidden).toBe(true);
        } finally { cleanup(); }
    });
});

describe('Navigation v2 — Meds badge', () => {
    it('counts missed + overdue doses and clears once they are taken', async () => {
        const { window, cleanup } = await boot();
        const { document } = window;
        try {
            const now = Date.now();
            const iso = (offsetMin) => new Date(now + offsetMin * 60_000).toISOString();
            let rows = [
                { id: 1, medication_id: 1, scheduled_at: iso(-300), status: 'PENDING' }, // missed
                { id: 2, medication_id: 1, scheduled_at: iso(-10), status: 'PENDING' },  // overdue
                { id: 3, medication_id: 2, scheduled_at: iso(-20), status: 'PENDING', snoozed_until: iso(30) },
                { id: 4, medication_id: 2, scheduled_at: iso(120), status: 'PENDING' },  // not due yet
                { id: 5, medication_id: 3, scheduled_at: iso(-60), status: 'TAKEN', taken_at: iso(-55) },
            ];
            window.apiCall = vi.fn(async (url) => (url === '/api/history?days=1' ? rows : null));
            const badge = () => tab(document, 'meds').querySelector('.wg-tab__badge');

            window.dispatchEvent(new window.CustomEvent('datastore:changed', { detail: { changedTags: ['history'] } }));
            await until(() => badge() && badge().textContent === '2');

            rows = rows.map((r) => (r.id <= 2 ? { ...r, status: 'TAKEN', taken_at: iso(0) } : r));
            window.dispatchEvent(new window.CustomEvent('datastore:changed', { detail: { changedTags: ['history'] } }));
            await until(() => badge() === null);
        } finally { cleanup(); }
    });
});
