// Characterisation tests for the Wandergeek Today reskin (Task 7).
//
// These complement today.render.test.js: they assert the new section
// taxonomy (next-action, vitals, fuel, plan, streak), route each tile to
// the correct `handleDeepLinks` target, and guard the inline-style ban.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const EMPTY_STATE_JS = path.join(REPO_ROOT, 'web/static/js/components/empty-state.js');
const WG_ICONS_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-icons.js');
const WG_SPARKLINE_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-sparkline.js');
const TODAY_JS = path.join(REPO_ROOT, 'web/static/js/features/today.js');

function loadEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="today-content"></div></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(fs.readFileSync(EMPTY_STATE_JS, 'utf8') + '\nwindow.createEmptyState = createEmptyState;');
    window.eval(fs.readFileSync(WG_ICONS_JS, 'utf8'));
    window.eval(fs.readFileSync(WG_SPARKLINE_JS, 'utf8'));
    window.eval(fs.readFileSync(TODAY_JS, 'utf8'));
    return {
        window,
        document: window.document,
        render: window.TodayDashboard.renderToday,
        cleanup: () => dom.window.close()
    };
}

function presentState(now) {
    return {
        greeting: { value: 'Good morning', deeplink: null, status: 'ok' },
        nextMed: {
            value: { scheduledAt: new Date(now.getTime() + 45 * 60000).toISOString(), names: ['Aspirin', 'Metformin'] },
            deeplink: 'meds',
            status: 'ok'
        },
        bpLatest: {
            value: { systolic: 132, diastolic: 84, measured_at: new Date(now.getTime() - 60 * 60000).toISOString() },
            deeplink: 'bp',
            status: 'ok'
        },
        bpTrend7d: {
            value: {
                systolicDirection: 'up', systolicDelta: 3,
                diastolicDirection: 'flat', diastolicDelta: 0,
                systolicPoints: [128, 130, 132]
            },
            deeplink: 'bp',
            status: 'ok'
        },
        weightLatest: {
            value: { weight: 84.2, measured_at: new Date(now.getTime() - 24 * 60 * 60000).toISOString() },
            deeplink: 'weight',
            status: 'ok'
        },
        weightTrend7d: { value: { direction: 'down', delta: -0.4, points: [84.6, 84.4, 84.2] }, deeplink: 'weight', status: 'ok' },
        caloriesToday: { value: 1100, deeplink: 'food', status: 'ok' },
        caloriesTarget: { value: 2200, deeplink: 'food', status: 'ok' },
        nextWorkout: {
            value: { scheduled_date: '2026-04-20', scheduled_time: '18:00', group_name: 'Pull day', is_today: true },
            deeplink: 'workouts',
            status: 'ok'
        },
        sleepLastNight: { value: { hours: 7.7, day: '2026-04-19' }, deeplink: 'health', status: 'ok' }
    };
}

describe('Wandergeek Today render (Task 7)', () => {
    let env;
    const now = new Date('2026-04-20T09:00:00Z');

    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env?.cleanup(); env = null; });

    it('mounts the canonical sections in order: next-action, vitals, fuel, plan, streak', () => {
        const root = env.document.getElementById('today-content');
        env.render(presentState(now), root, { now });

        const sections = Array.from(root.querySelectorAll('[data-section]'))
            .map((el) => el.getAttribute('data-section'));

        // Next-action first, fuel card before the plan grid, streak last.
        expect(sections[0]).toBe('next-action');
        const idxFuel = sections.indexOf('fuel');
        const idxWorkout = sections.indexOf('workout');
        const idxStreak = sections.indexOf('streak');
        expect(idxFuel).toBeGreaterThan(0);
        expect(idxWorkout).toBeGreaterThan(idxFuel);
        expect(idxStreak).toBeGreaterThan(idxWorkout);
    });

    it('routes each metric tile through handleDeepLinks to the right section', () => {
        const root = env.document.getElementById('today-content');
        const onDeeplink = vi.fn();
        env.render(presentState(now), root, { now, onDeeplink });

        // BP tile → bp
        root.querySelector('.wg-metric-tile[data-deeplink="bp"]').click();
        // Weight tile → weight
        root.querySelector('.wg-metric-tile[data-deeplink="weight"]').click();

        expect(onDeeplink.mock.calls.map((c) => c[0])).toEqual(['bp', 'weight']);
    });

    it('fuel-card click routes to food', () => {
        const root = env.document.getElementById('today-content');
        const onDeeplink = vi.fn();
        env.render(presentState(now), root, { now, onDeeplink });

        root.querySelector('.wg-fuel-card').click();
        expect(onDeeplink).toHaveBeenCalledWith('food');
    });

    it('next-action card click routes to meds', () => {
        const root = env.document.getElementById('today-content');
        const onDeeplink = vi.fn();
        env.render(presentState(now), root, { now, onDeeplink });

        root.querySelector('.wg-next-action-card').click();
        expect(onDeeplink).toHaveBeenCalledWith('meds');
    });

    it('plan tiles deep-link to workouts and health', () => {
        const root = env.document.getElementById('today-content');
        const onDeeplink = vi.fn();
        env.render(presentState(now), root, { now, onDeeplink });

        root.querySelector('.wg-plan-tile[data-deeplink="workouts"]').click();
        root.querySelector('.wg-plan-tile[data-deeplink="health"]').click();
        expect(onDeeplink.mock.calls.map((c) => c[0])).toEqual(['workouts', 'health']);
    });

    it('fuel card energy mini bar reflects kcal / target percentage with SVG width (no inline style)', () => {
        const root = env.document.getElementById('today-content');
        env.render(presentState(now), root, { now });

        const bars = root.querySelectorAll('.wg-mini-bar');
        expect(bars.length).toBe(1);
        const label = bars[0].querySelector('.wg-mini-bar__label').textContent;
        expect(label).toBe('Energy');

        // Energy bar width reflects the kcal / target percentage (1100/2200 → 50%).
        const energyRect = bars[0].querySelector('.wg-mini-bar__fill');
        expect(energyRect).not.toBeNull();
        expect(parseFloat(energyRect.getAttribute('width'))).toBeCloseTo(50, 0);
        // No inline style anywhere in the rendered bar.
        expect(bars[0].querySelectorAll('[style]').length).toBe(0);
    });

    it('renders sparklines inside metric tiles using WGSparkline variants', () => {
        const root = env.document.getElementById('today-content');
        env.render(presentState(now), root, { now });

        const bpSpark = root.querySelector('.wg-metric-tile[data-deeplink="bp"] svg.wg-sparkline');
        expect(bpSpark).not.toBeNull();
        expect(bpSpark.classList.contains('wg-sparkline--sun')).toBe(true);

        const weightSpark = root.querySelector('.wg-metric-tile[data-deeplink="weight"] svg.wg-sparkline');
        expect(weightSpark).not.toBeNull();
        expect(weightSpark.classList.contains('wg-sparkline--mint-soft')).toBe(true);
    });

    it('streak card renders 14 consistency bars and a placeholder label', () => {
        const root = env.document.getElementById('today-content');
        env.render(presentState(now), root, { now });

        const card = root.querySelector('.wg-streak-card');
        expect(card).not.toBeNull();
        expect(card.querySelectorAll('.wg-streak-bar').length).toBe(14);
        expect(card.textContent).toMatch(/streak/i);
    });

    it('fuel card without a calorie target shows "No target set" and dashes the percentage', () => {
        const root = env.document.getElementById('today-content');
        const state = presentState(now);
        state.caloriesTarget = { value: null, deeplink: 'food', status: 'missing' };
        env.render(state, root, { now });

        const pct = root.querySelector('.wg-fuel-card__pct');
        const label = root.querySelector('.wg-fuel-card__pct-label');
        expect(pct.textContent).toBe('—');
        expect(label.textContent).toMatch(/No target set/);
    });
});
