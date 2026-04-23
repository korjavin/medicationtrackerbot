// Characterisation tests for the Today screen after the Task 3 refactor.
//
// The Today stack now emits (top → bottom):
//   shortcuts → vitals → fuel → plan → next-action (meds at bottom)
//
// The streak card is gone, there is no section-header/greeting, and the
// fuel card exposes four mini-bars (Energy / Protein / Carbs / Fat).

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
        macrosToday: { value: { protein: 75, carbs: 120, fat: 40 }, deeplink: 'food', status: 'ok' },
        macrosTarget: { value: { protein: 150, carbs: 250, fat: 70 }, deeplink: 'food', status: 'ok' },
        nextWorkout: {
            value: { scheduled_date: '2026-04-20', scheduled_time: '18:00', group_name: 'Pull day', is_today: true },
            deeplink: 'workouts',
            status: 'ok'
        },
        sleepLastNight: { value: { hours: 7.7, day: '2026-04-19' }, deeplink: 'health', status: 'ok' }
    };
}

describe('Today render — Task 3 canonical structure', () => {
    let env;
    const now = new Date('2026-04-20T09:00:00Z');

    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env?.cleanup(); env = null; });

    it('mounts sections in order: shortcuts, vitals, fuel, plan, meds (at bottom)', () => {
        const root = env.document.getElementById('today-content');
        env.render(presentState(now), root, { now });

        const sections = Array.from(root.querySelectorAll('[data-section]'))
            .map((el) => el.getAttribute('data-section'));

        const idxShortcut = sections.indexOf('shortcuts');
        const idxFuel = sections.indexOf('fuel');
        const idxWorkout = sections.indexOf('workout');
        const idxNext = sections.indexOf('next-action');
        expect(idxShortcut).toBe(0);
        expect(idxFuel).toBeGreaterThan(idxShortcut);
        expect(idxWorkout).toBeGreaterThan(idxFuel);
        expect(idxNext).toBeGreaterThan(idxWorkout);

        // The consistency streak card is gone.
        expect(sections.indexOf('streak')).toBe(-1);
        expect(root.querySelector('.wg-streak-card')).toBeNull();
    });

    it('routes each metric tile through handleDeepLinks to the right section', () => {
        const root = env.document.getElementById('today-content');
        const onDeeplink = vi.fn();
        env.render(presentState(now), root, { now, onDeeplink });

        root.querySelector('.wg-metric-tile[data-deeplink="bp"]').click();
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

    it('meds-card click routes to meds (the body routes; the Take CTA is a separate button)', () => {
        const root = env.document.getElementById('today-content');
        const onDeeplink = vi.fn();
        env.render(presentState(now), root, { now, onDeeplink });

        root.querySelector('.wg-today-meds').click();
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

    it('fuel card exposes 4 mini-bars (Energy / Protein / Carbs / Fat) and widths track the macro percentage', () => {
        const root = env.document.getElementById('today-content');
        env.render(presentState(now), root, { now });

        const bars = root.querySelectorAll('.wg-mini-bar');
        expect(bars.length).toBe(4);
        const labels = Array.from(bars).map((b) => b.querySelector('.wg-mini-bar__label').textContent);
        expect(labels).toEqual(['Energy', 'Protein', 'Carbs', 'Fat']);

        // Energy bar: 1100/2200 = 50%.
        const energyRect = bars[0].querySelector('.wg-mini-bar__fill');
        expect(parseFloat(energyRect.getAttribute('width'))).toBeCloseTo(50, 0);

        // Protein bar: 75/150 = 50%.
        const proteinRect = bars[1].querySelector('.wg-mini-bar__fill');
        expect(parseFloat(proteinRect.getAttribute('width'))).toBeCloseTo(50, 0);

        // No inline style anywhere in the rendered bars.
        bars.forEach((b) => {
            expect(b.querySelectorAll('[style]').length).toBe(0);
        });
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
