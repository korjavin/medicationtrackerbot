// Today v2 layout (kit screens-today.html T1/T2, med-xso6.13).
//
// The Today stack emits (top → bottom):
//   call row → Next up → vitals strip (BP · Weight · Fuel) → Goal Line →
//   macros card → sleep / steps tiles
//
// These tests pin the order, the tile anatomy (value + class chip + age as
// separate signals) and where each tap routes.

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
const WG_CHIP_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-chip.js');
const WG_SPARKLINE_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-sparkline.js');
const TODAY_JS = path.join(REPO_ROOT, 'web/static/js/features/today.js');

function loadEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="today-content"></div></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(fs.readFileSync(EMPTY_STATE_JS, 'utf8'));
    window.eval(fs.readFileSync(WG_ICONS_JS, 'utf8'));
    window.eval(fs.readFileSync(WG_CHIP_JS, 'utf8'));
    window.eval(fs.readFileSync(WG_SPARKLINE_JS, 'utf8'));
    window.eval(fs.readFileSync(TODAY_JS, 'utf8'));
    return {
        window,
        document: window.document,
        render: window.TodayDashboard.renderToday,
        cleanup: () => dom.window.close()
    };
}

// Local wall-clock dates keep "today"/"yesterday" independent of the CI zone.
const NOW = new Date(2026, 3, 20, 9, 0);
const at = (h, m, dayOffset = 0) => new Date(2026, 3, 20 + dayOffset, h, m).toISOString();

function presentState() {
    return {
        greeting: { value: 'Good morning', deeplink: null, status: 'ok' },
        nextMed: {
            value: { scheduledAt: at(9, 45), names: ['Aspirin', 'Metformin'], ids: [1, 2] },
            deeplink: 'meds',
            status: 'ok'
        },
        missedDoses: { value: null, deeplink: 'meds', status: 'missing' },
        bpLatest: {
            value: { systolic: 132, diastolic: 84, measured_at: at(8, 0) },
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
            value: { weight: 84.2, measured_at: at(7, 0, -1) },
            deeplink: 'weight',
            status: 'ok'
        },
        weightTrend7d: { value: { direction: 'down', delta: -0.4, points: [84.6, 84.4, 84.2] }, deeplink: 'weight', status: 'ok' },
        caloriesToday: { value: 1100, deeplink: 'food', status: 'ok' },
        caloriesTarget: { value: 2200, deeplink: 'food', status: 'ok' },
        macrosToday: { value: { protein: 75, carbs: 120, fat: 40 }, deeplink: 'food', status: 'ok' },
        macrosTarget: { value: { protein: 150, carbs: 250, fat: 70 }, deeplink: 'food', status: 'ok' },
        nextWorkout: {
            value: { id: 7, scheduled_date: '2026-04-20', scheduled_time: '18:00', group_name: 'Pull day', status: 'pending', is_today: true },
            deeplink: 'workouts',
            status: 'ok'
        },
        sleepLastNight: { value: { hours: 7.7, day: '2026-04-19' }, deeplink: 'health', status: 'ok' },
        stepsLatest: { value: { steps: 3654, day: '2026-04-19' }, deeplink: 'health', status: 'ok' }
    };
}

describe('Today v2 — layout', () => {
    let env;
    let root;
    beforeEach(() => {
        env = loadEnv();
        root = env.document.getElementById('today-content');
    });
    afterEach(() => { env.cleanup(); });

    it('mounts sections in kit order: call row, Next up, vitals, macros, sleep/steps', () => {
        env.render(presentState(), root, { now: NOW, onDoctorBrief: vi.fn() });
        const order = Array.from(root.children).map((n) => n.getAttribute('data-section'));
        expect(order).toEqual(['callbar', 'next-up', 'vitals', 'macros', 'sleep-steps']);
        // The pre-v2 cards are gone.
        expect(root.querySelector('.wg-shortcut-tile, .wg-metric-tile, .wg-fuel-card, .wg-plan-tile, .wg-today-meds')).toBeNull();
    });

    it('the call row holds the Log button and the Doctor brief icon', () => {
        const onDoctorBrief = vi.fn();
        env.render(presentState(), root, { now: NOW, onDoctorBrief });
        const row = root.querySelector('[data-section="callbar"]');
        expect(row.classList.contains('wg-callbar')).toBe(true);
        expect(row.querySelector('[data-action="open-log"]').textContent).toBe('Log');
        const brief = row.querySelector('[data-action="doctor-brief"]');
        expect(brief.getAttribute('aria-label')).toBe('Doctor brief');
        brief.click();
        expect(onDoctorBrief).toHaveBeenCalledTimes(1);
    });

    it('no Doctor brief handler (no cloud brief) → no icon', () => {
        env.render(presentState(), root, { now: NOW });
        expect(root.querySelector('[data-action="doctor-brief"]')).toBeNull();
    });

    it('vitals strip: BP value, class chip and age are separate signals', () => {
        env.render(presentState(), root, { now: NOW });
        const strip = root.querySelector('[data-section="vitals"]');
        expect(strip.classList.contains('wg-grid3')).toBe(true);
        const bp = strip.querySelector('[data-section="bp"]');
        expect(bp.querySelector('.wg-stat__value').textContent).toBe('132/84');
        expect(bp.querySelector('.wg-dia').textContent).toBe('/84');
        const cls = bp.querySelector('.wg-chip');
        expect(cls.textContent).toBe('Stage 1');
        expect(cls.classList.contains('wg-chip--warn')).toBe(true);
        expect(bp.querySelector('.wg-meta').textContent).toBe('today');
        const spark = bp.querySelector('svg.wg-sparkline');
        expect(spark.classList.contains('wg-sparkline--sun')).toBe(true);
    });

    it('BP class chips follow the AHA bands', () => {
        const cases = [[118, 76, 'Normal', 'ok'], [124, 78, 'High-normal', 'warn'], [134, 86, 'Stage 1', 'warn'], [148, 92, 'High', 'danger']];
        for (const [s, d, text, state] of cases) {
            const st = presentState();
            st.bpLatest.value = { systolic: s, diastolic: d, measured_at: at(8, 0) };
            env.render(st, root, { now: NOW });
            const c = root.querySelector('[data-section="bp"] .wg-chip');
            expect(c.textContent).toBe(text);
            expect(c.classList.contains(`wg-chip--${state}`)).toBe(true);
        }
    });

    it('weight tile: value, 7d delta and age; stale reading gets a stale chip', () => {
        env.render(presentState(), root, { now: NOW });
        const w = root.querySelector('[data-section="weight"]');
        expect(w.querySelector('.wg-stat__value').textContent).toBe('84.2kg');
        const metas = Array.from(w.querySelectorAll('.wg-meta')).map((n) => n.textContent);
        expect(metas).toEqual(['−0.4 kg · 7d', 'yesterday']);

        const st = presentState();
        st.weightLatest = { value: { weight: 84.2, measured_at: at(7, 0, -9) }, deeplink: 'weight', status: 'stale' };
        env.render(st, root, { now: NOW });
        const chip = root.querySelector('[data-section="weight"] .wg-chip--stale');
        expect(chip.textContent).toBe('9d ago');
    });

    it('fuel tile: kcal with a --p meter against the target, or "No target"', () => {
        env.render(presentState(), root, { now: NOW });
        const fuel = root.querySelector('[data-section="fuel"]');
        expect(fuel.querySelector('.wg-stat__value').textContent).toBe('1100');
        expect(fuel.querySelector('.wg-meter__fill').style.getPropertyValue('--p')).toBe('50.0%');
        expect(fuel.querySelector('.wg-meta').textContent).toBe('of 2200 kcal');

        const st = presentState();
        st.caloriesTarget = { value: null, deeplink: 'food', status: 'missing' };
        st.caloriesToday = { value: 0, deeplink: 'food', status: 'missing' };
        env.render(st, root, { now: NOW });
        const empty = root.querySelector('[data-section="fuel"]');
        expect(empty.querySelector('.wg-meter')).toBeNull();
        expect(empty.querySelector('.wg-meta').textContent).toBe('No target');
        // Nothing logged and no target → the macros card stays out.
        expect(root.querySelector('[data-section="macros"]')).toBeNull();
    });

    it('missing BP / weight name the next step: a Log link that opens the form, not the tab', () => {
        const st = presentState();
        st.bpLatest = { value: null, deeplink: 'bp', status: 'missing' };
        st.weightLatest = { value: null, deeplink: 'weight', status: 'missing' };
        const onAddBp = vi.fn();
        const onAddWeight = vi.fn();
        const onDeeplink = vi.fn();
        env.render(st, root, { now: NOW, onAddBp, onAddWeight, onDeeplink });
        root.querySelector('[data-section="bp"] [data-action="log"]').click();
        root.querySelector('[data-section="weight"] [data-action="log"]').click();
        expect(onAddBp).toHaveBeenCalledTimes(1);
        expect(onAddWeight).toHaveBeenCalledTimes(1);
        expect(onDeeplink).not.toHaveBeenCalled();
    });

    it('macros card: four kit meters with the target values', () => {
        env.render(presentState(), root, { now: NOW });
        const card = root.querySelector('[data-section="macros"]');
        const labels = Array.from(card.querySelectorAll('.wg-macros__label')).map((n) => n.textContent);
        expect(labels).toEqual(['Energy', 'Protein', 'Carbs', 'Fat']);
        const vals = Array.from(card.querySelectorAll('.wg-macros__val')).map((n) => n.textContent);
        expect(vals).toEqual(['1100 / 2200', '75 / 150 g', '120 / 250 g', '40 / 70 g']);
        const fills = Array.from(card.querySelectorAll('.wg-meter__fill')).map((n) => n.style.getPropertyValue('--p'));
        expect(fills).toEqual(['50.0%', '50.0%', '48.0%', '57.1%']);
    });

    it('sleep and steps tiles', () => {
        env.render(presentState(), root, { now: NOW });
        const sleep = root.querySelector('[data-section="sleep"]');
        expect(sleep.querySelector('.wg-stat__value').textContent).toBe('7h 42m');
        expect(sleep.querySelector('.wg-meta').textContent).toBe('yesterday');
        const steps = root.querySelector('[data-section="steps"]');
        expect(steps.querySelector('.wg-stat__value').textContent).toBe('3,654');
        expect(steps.querySelector('.wg-chip--stale').textContent).toBe('yesterday');
    });

    it('routes tile taps to their sections', () => {
        const onDeeplink = vi.fn();
        env.render(presentState(), root, { now: NOW, onDeeplink });
        for (const s of ['bp', 'weight', 'fuel', 'macros', 'sleep', 'steps']) {
            root.querySelector(`[data-section="${s}"]`).click();
        }
        expect(onDeeplink.mock.calls.map((c) => c[0])).toEqual(['bp', 'weight', 'food', 'food', 'health', 'health']);
    });

    it('sets no inline style beyond the --p / --n custom properties', () => {
        env.render(presentState(), root, { now: NOW });
        for (const node of root.querySelectorAll('[style]')) {
            const props = Array.from(node.style).filter((p) => p !== '--p' && p !== '--n');
            expect(props).toEqual([]);
        }
    });
});
