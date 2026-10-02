import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDataStoreEnv } from './helpers/data-store-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const EMPTY_STATE_JS = path.join(REPO_ROOT, 'web/static/js/components/empty-state.js');
const WG_ICONS_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-icons.js');
const WG_SPARKLINE_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-sparkline.js');
const TODAY_JS = path.join(REPO_ROOT, 'web/static/js/features/today.js');
const CACHE_KEYS_JS = path.join(REPO_ROOT, 'web/static/js/core/cache-keys.js');

function loadRenderEnv() {
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
        aggregate: window.TodayDashboard.aggregateToday,
        render: window.TodayDashboard.renderToday,
        cleanup: () => dom.window.close()
    };
}

function allPresentState(now) {
    return {
        greeting: { value: 'Good morning', deeplink: null, status: 'ok' },
        nextMed: {
            value: { scheduledAt: new Date(now.getTime() + 30 * 60000).toISOString(), names: ['Aspirin'] },
            deeplink: 'meds',
            status: 'ok'
        },
        bpLatest: {
            value: { systolic: 122, diastolic: 80, measured_at: new Date(now.getTime() - 3 * 60 * 60000).toISOString() },
            deeplink: 'bp',
            status: 'ok'
        },
        bpTrend7d: {
            value: {
                systolicDirection: 'down', systolicDelta: -10,
                diastolicDirection: 'down', diastolicDelta: -4,
                systolicPoints: [132, 128, 125, 122]
            },
            deeplink: 'bp',
            status: 'ok'
        },
        weightLatest: {
            value: { weight: 81.6, measured_at: new Date(now.getTime() - 24 * 60 * 60000).toISOString() },
            deeplink: 'weight',
            status: 'ok'
        },
        weightTrend7d: {
            value: { direction: 'down', delta: -0.8, points: [82.4, 82.0, 81.8, 81.6] },
            deeplink: 'weight',
            status: 'ok'
        },
        caloriesToday: { value: 1200, deeplink: 'food', status: 'ok' },
        caloriesTarget: { value: 2200, deeplink: 'food', status: 'ok' },
        macrosToday: { value: { protein: 60, carbs: 130, fat: 40 }, deeplink: 'food', status: 'ok' },
        macrosTarget: { value: { protein: 150, carbs: 250, fat: 70 }, deeplink: 'food', status: 'ok' },
        nextWorkout: {
            value: { scheduled_date: '2026-04-20', scheduled_time: '18:30', group_name: 'Push day', status: 'pending', is_today: false },
            deeplink: 'workouts',
            status: 'ok'
        },
        sleepLastNight: { value: { hours: 7.8, day: '2026-04-19' }, deeplink: 'health', status: 'ok' }
    };
}

function allMissingState() {
    return {
        greeting: { value: 'Good morning', deeplink: null, status: 'ok' },
        nextMed: { value: null, deeplink: 'meds', status: 'missing' },
        bpLatest: { value: null, deeplink: 'bp', status: 'missing' },
        bpTrend7d: { value: null, deeplink: 'bp', status: 'missing' },
        weightLatest: { value: null, deeplink: 'weight', status: 'missing' },
        weightTrend7d: { value: null, deeplink: 'weight', status: 'missing' },
        caloriesToday: { value: 0, deeplink: 'food', status: 'missing' },
        caloriesTarget: { value: null, deeplink: 'food', status: 'missing' },
        macrosToday: { value: { protein: 0, carbs: 0, fat: 0 }, deeplink: 'food', status: 'missing' },
        macrosTarget: { value: null, deeplink: 'food', status: 'missing' },
        nextWorkout: { value: null, deeplink: 'workouts', status: 'missing' },
        sleepLastNight: { value: null, deeplink: 'health', status: 'missing' }
    };
}

function allDisabledState() {
    return {
        greeting: { value: 'Good evening', deeplink: null, status: 'ok' },
        nextMed: { value: null, deeplink: 'meds', status: 'disabled' },
        bpLatest: { value: null, deeplink: 'bp', status: 'disabled' },
        bpTrend7d: { value: null, deeplink: 'bp', status: 'disabled' },
        weightLatest: { value: null, deeplink: 'weight', status: 'disabled' },
        weightTrend7d: { value: null, deeplink: 'weight', status: 'disabled' },
        caloriesToday: { value: null, deeplink: 'food', status: 'disabled' },
        caloriesTarget: { value: null, deeplink: 'food', status: 'disabled' },
        macrosToday: { value: null, deeplink: 'food', status: 'disabled' },
        macrosTarget: { value: null, deeplink: 'food', status: 'disabled' },
        nextWorkout: { value: null, deeplink: 'workouts', status: 'disabled' },
        sleepLastNight: { value: null, deeplink: 'health', status: 'disabled' }
    };
}

describe('TodayDashboard.renderToday', () => {
    let env;
    const now = new Date('2026-04-19T09:00:00Z');

    beforeEach(() => {
        env = loadRenderEnv();
    });

    afterEach(() => {
        env?.cleanup();
        env = null;
    });

    it('renders every canonical section when all data is present', () => {
        const root = env.document.getElementById('today-content');
        env.render(allPresentState(now), root, { now });

        expect(root.classList.contains('wg-today')).toBe(true);

        // No top-of-screen header anymore — the mockup has no greeting/title.
        expect(root.querySelector('.section-header')).toBeNull();

        expect(root.querySelector('.wg-today-shortcuts')).not.toBeNull();
        // 5 quick-log tiles. The Doctor brief tile (med-5k6t.2) is cloud-gated
        // and this env sets no __MEDTRACKER_CLOUD__ — see today.shortcut-row-split.
        expect(root.querySelectorAll('.wg-shortcut-tile').length).toBe(5);
        expect(root.querySelector('.wg-vitals-grid')).not.toBeNull();
        expect(root.querySelectorAll('.wg-metric-tile').length).toBe(2);
        expect(root.querySelector('.wg-fuel-card')).not.toBeNull();
        expect(root.querySelectorAll('.wg-mini-bar').length).toBe(4);
        expect(root.querySelector('.wg-plan-grid')).not.toBeNull();
        expect(root.querySelectorAll('.wg-plan-tile').length).toBe(2);
        expect(root.querySelector('.wg-today-meds')).not.toBeNull();
        expect(root.querySelector('.wg-streak-card')).toBeNull();

        const bpTile = root.querySelector('.wg-metric-tile[data-deeplink="bp"]');
        expect(bpTile.textContent).toMatch(/122/);
        expect(bpTile.textContent).toMatch(/80/);

        const weightTile = root.querySelector('.wg-metric-tile[data-deeplink="weight"]');
        expect(weightTile.textContent).toMatch(/81\.6/);
    });

    it('meds card sits at the bottom of the Today stack', () => {
        const root = env.document.getElementById('today-content');
        env.render(allPresentState(now), root, { now });
        const medsCard = root.querySelector('.wg-today-meds');
        expect(medsCard).not.toBeNull();
        // Meds card is the last non-empty child of root.
        const children = Array.from(root.children);
        expect(children[children.length - 1]).toBe(medsCard);
    });

    it('meds card lists each scheduled medication name', () => {
        const root = env.document.getElementById('today-content');
        const state = allPresentState(now);
        state.nextMed.value.names = ['Aspirin', 'Metformin', 'Vitamin D'];
        env.render(state, root, { now });
        const rows = root.querySelectorAll('.wg-today-meds__row');
        expect(rows.length).toBe(3);
        expect(rows[0].textContent).toMatch(/Aspirin/);
        expect(rows[2].textContent).toMatch(/Vitamin D/);
    });

    it('meds card has NO sun-yellow banner background (plain card surface)', () => {
        const root = env.document.getElementById('today-content');
        env.render(allPresentState(now), root, { now });
        const medsCard = root.querySelector('.wg-today-meds');
        expect(medsCard.classList.contains('wg-next-action-card--plain')).toBe(true);
    });

    it('meds card Take button is a sun-gloss CTA', () => {
        const root = env.document.getElementById('today-content');
        env.render(allPresentState(now), root, { now });
        const cta = root.querySelector('.wg-today-meds .wg-next-action-card__cta');
        expect(cta).not.toBeNull();
        expect(cta.classList.contains('wg-gloss')).toBe(true);
        expect(cta.classList.contains('wg-gloss--sun')).toBe(true);
        expect(cta.textContent).toMatch(/Take/);
    });

    it('renders a missing placeholder meds card when no scheduled dose', () => {
        const root = env.document.getElementById('today-content');
        env.render(allMissingState(), root, { now });

        const medsCard = root.querySelector('.wg-today-meds');
        expect(medsCard).not.toBeNull();
        expect(medsCard.textContent).toMatch(/No scheduled doses/i);
        // Vitals + fuel + plan still render.
        expect(root.querySelector('.wg-vitals-grid')).not.toBeNull();
        expect(root.querySelector('.wg-fuel-card')).not.toBeNull();
        expect(root.querySelector('.wg-plan-grid')).not.toBeNull();
    });

    it('shows the disabled empty state when every feature is off', () => {
        const root = env.document.getElementById('today-content');
        env.render(allDisabledState(), root, { now });

        expect(root.querySelector('.wg-today-shortcuts')).toBeNull();
        expect(root.querySelector('.wg-today-meds')).toBeNull();
        expect(root.querySelector('.wg-vitals-grid')).toBeNull();
        expect(root.querySelector('.wg-fuel-card')).toBeNull();
        expect(root.querySelector('.wg-plan-grid')).toBeNull();
        expect(root.querySelector('.wg-streak-card')).toBeNull();

        const empty = root.querySelector('.today-empty');
        expect(empty).not.toBeNull();
        expect(empty.classList.contains('today-empty-disabled')).toBe(true);
    });

    it('renders partial state: BP present but meds disabled, weight/food/workout missing', () => {
        const root = env.document.getElementById('today-content');
        const state = allMissingState();
        state.bpLatest = {
            value: { systolic: 130, diastolic: 85, measured_at: new Date(now.getTime() - 2 * 60 * 60000).toISOString() },
            deeplink: 'bp',
            status: 'ok'
        };
        state.nextMed = { value: null, deeplink: 'meds', status: 'disabled' };
        env.render(state, root, { now });

        expect(root.querySelector('.wg-today-meds')).toBeNull();
        const bpTile = root.querySelector('.wg-metric-tile[data-deeplink="bp"]');
        expect(bpTile).not.toBeNull();
        expect(bpTile.textContent).toMatch(/130/);
        expect(bpTile.textContent).toMatch(/85/);
    });

    it('surfaces an Overdue kicker on the meds card when medication is overdue', () => {
        const root = env.document.getElementById('today-content');
        const state = allPresentState(now);
        state.nextMed.status = 'overdue';
        env.render(state, root, { now });

        const card = root.querySelector('.wg-today-meds');
        expect(card).not.toBeNull();
        const kicker = card.querySelector('.wg-next-action-card__kicker');
        expect(kicker.textContent).toMatch(/Overdue/);
    });

    it('marks a stale BP latest reading by appending "stale" to the tag text', () => {
        const root = env.document.getElementById('today-content');
        const state = allPresentState(now);
        state.bpLatest.status = 'stale';
        env.render(state, root, { now });

        const bpTile = root.querySelector('.wg-metric-tile[data-deeplink="bp"]');
        const tag = bpTile.querySelector('.wg-tag');
        expect(tag).not.toBeNull();
        expect(tag.textContent.toLowerCase()).toMatch(/stale/);
    });

    it('calls onDeeplink handler when a metric tile is clicked', () => {
        const root = env.document.getElementById('today-content');
        const onDeeplink = vi.fn();
        env.render(allPresentState(now), root, { now, onDeeplink });

        root.querySelector('.wg-metric-tile[data-deeplink="bp"]').click();
        expect(onDeeplink).toHaveBeenCalledWith('bp');
    });

    it('falls back to window.switchTab when no onDeeplink handler is provided', () => {
        const root = env.document.getElementById('today-content');
        env.window.switchTab = vi.fn();
        env.render(allPresentState(now), root, {});

        root.querySelector('.wg-metric-tile[data-deeplink="weight"]').click();
        expect(env.window.switchTab).toHaveBeenCalledWith('weight');
    });

    it('shortcut tiles invoke the modal openers, not tab switches', () => {
        const root = env.document.getElementById('today-content');
        const onLogFood = vi.fn();
        const onScanFood = vi.fn();
        const onPhotoMeal = vi.fn();
        const onAddBp = vi.fn();
        const onAddWeight = vi.fn();
        env.render(allPresentState(now), root, { now, onLogFood, onScanFood, onPhotoMeal, onAddBp, onAddWeight });

        const tiles = root.querySelectorAll('.wg-shortcut-tile');
        expect(tiles.length).toBe(5);
        tiles[0].click(); // Log food
        tiles[1].click(); // Scan food
        tiles[2].click(); // Photo meal
        tiles[3].click(); // Add BP
        tiles[4].click(); // Add weight

        expect(onLogFood).toHaveBeenCalledTimes(1);
        expect(onScanFood).toHaveBeenCalledTimes(1);
        expect(onPhotoMeal).toHaveBeenCalledTimes(1);
        expect(onAddBp).toHaveBeenCalledTimes(1);
        expect(onAddWeight).toHaveBeenCalledTimes(1);
    });

    it('shortcut tiles fall back to the global modal functions when no handler is provided', () => {
        const root = env.document.getElementById('today-content');
        env.window.showAddFoodModal = vi.fn();
        env.window.showBPRecordModal = vi.fn();
        env.window.showWeightModal = vi.fn();
        env.window.FoodActions = { triggerPhotoPicker: vi.fn() };
        env.window.FoodLog = { openAdd: vi.fn() };
        env.window.FoodScanner = { openFoodScannerModal: vi.fn() };
        env.render(allPresentState(now), root, { now });

        const tiles = root.querySelectorAll('.wg-shortcut-tile');
        tiles[0].click(); // Log food
        tiles[1].click(); // Scan food
        tiles[2].click(); // Photo meal
        tiles[3].click(); // Add BP
        tiles[4].click(); // Add weight

        expect(env.window.showAddFoodModal).toHaveBeenCalledTimes(1);
        expect(env.window.FoodLog.openAdd).toHaveBeenCalledTimes(1);
        expect(env.window.FoodScanner.openFoodScannerModal).toHaveBeenCalledTimes(1);
        expect(env.window.FoodActions.triggerPhotoPicker).toHaveBeenCalledTimes(1);
        expect(env.window.showBPRecordModal).toHaveBeenCalledTimes(1);
        expect(env.window.showWeightModal).toHaveBeenCalledTimes(1);
    });

    it('shortcut row omits tiles for disabled features', () => {
        const root = env.document.getElementById('today-content');
        const state = allPresentState(now);
        state.caloriesTarget.status = 'disabled';
        env.render(state, root, { now });

        const tiles = root.querySelectorAll('.wg-shortcut-tile');
        expect(tiles.length).toBe(2); // BP + Weight only
        const labels = Array.from(tiles).map((t) => t.textContent);
        expect(labels.some((l) => /food/i.test(l))).toBe(false);
    });

    it('weight off: BP pane + Add BP shortcut still render, alone in their auto-fit rows', () => {
        // Regression for us0.2 — a disabled metric must not strand its partner
        // pane/button. The vitals grid + vitals shortcut row use an auto-fit
        // template so the lone remaining tile fills the row instead of sitting
        // half-width. Structurally we assert the survivor still renders inside
        // its grid container (CSS auto-fit does the visual fill).
        const root = env.document.getElementById('today-content');
        const state = allPresentState(now);
        state.weightLatest = { value: null, deeplink: 'weight', status: 'disabled' };
        state.weightTrend7d = { value: null, deeplink: 'weight', status: 'disabled' };
        env.render(state, root, { now });

        const grid = root.querySelector('.wg-vitals-grid');
        expect(grid).not.toBeNull();
        const metricTiles = grid.querySelectorAll('.wg-metric-tile');
        expect(metricTiles.length).toBe(1);
        expect(metricTiles[0].getAttribute('data-deeplink')).toBe('bp');
        expect(root.querySelector('.wg-metric-tile[data-deeplink="weight"]')).toBeNull();

        const vitalsRow = root.querySelector('.wg-today-shortcuts--vitals');
        expect(vitalsRow).not.toBeNull();
        const vitalsTiles = vitalsRow.querySelectorAll('.wg-shortcut-tile');
        expect(vitalsTiles.length).toBe(1);
        expect(vitalsTiles[0].textContent).toMatch(/BP/i);
    });

    it('never sets inline style attributes on rendered elements', () => {
        const root = env.document.getElementById('today-content');
        env.render(allPresentState(now), root, { now });

        const withStyle = root.querySelectorAll('[style]');
        expect(withStyle.length).toBe(0);
    });

    it('clears previous content on re-render to avoid duplicates', () => {
        const root = env.document.getElementById('today-content');
        env.render(allPresentState(now), root, { now });
        const firstCount = root.querySelectorAll('.wg-metric-tile').length;
        env.render(allPresentState(now), root, { now });
        const secondCount = root.querySelectorAll('.wg-metric-tile').length;
        expect(firstCount).toBe(secondCount);
        expect(root.querySelectorAll('.wg-today-shortcuts').length).toBe(2);
        expect(root.querySelectorAll('.wg-today-shortcuts--food').length).toBe(1);
        expect(root.querySelectorAll('.wg-today-shortcuts--vitals').length).toBe(1);
        expect(root.querySelectorAll('.wg-today-meds').length).toBe(1);
    });

    it('first-run offline: render shows connect empty state with no cards when __firstRun is set', () => {
        const root = env.document.getElementById('today-content');
        const state = env.aggregate(null, null, now);
        state.__firstRun = true;
        env.render(state, root, { now });

        expect(root.querySelector('.wg-today-shortcuts')).toBeNull();
        expect(root.querySelector('.wg-today-meds')).toBeNull();
        expect(root.querySelector('.wg-vitals-grid')).toBeNull();
        const empty = root.querySelector('.today-empty');
        expect(empty).not.toBeNull();
        expect(empty.classList.contains('today-empty-firstrun')).toBe(true);
        expect(empty.textContent).toMatch(/Connect to load your day/i);
    });

    it('empty bootstrap without caches is NOT auto-flagged first-run by aggregate', () => {
        const state = env.aggregate({ features: {} }, {}, now);
        expect(state.__firstRun).toBeUndefined();
    });

    it('bootstrap with real data is not treated as first-run', () => {
        const bootstrap = {
            features: {},
            bp: { readings: [{ systolic: 118, diastolic: 76, measured_at: new Date(now - 60000).toISOString() }] }
        };
        const state = env.aggregate(bootstrap, {}, now);
        expect(state.__firstRun).toBeUndefined();
    });

    it('omits only disabled sections, keeps enabled ones', () => {
        const root = env.document.getElementById('today-content');
        const state = allPresentState(now);
        state.nextMed = { value: null, deeplink: 'meds', status: 'disabled' };
        state.caloriesToday = { value: null, deeplink: 'food', status: 'disabled' };
        state.caloriesTarget = { value: null, deeplink: 'food', status: 'disabled' };
        state.macrosToday = { value: null, deeplink: 'food', status: 'disabled' };
        state.macrosTarget = { value: null, deeplink: 'food', status: 'disabled' };
        env.render(state, root, { now });

        expect(root.querySelector('.wg-today-meds')).toBeNull();
        expect(root.querySelector('.wg-fuel-card')).toBeNull();
        expect(root.querySelector('.wg-vitals-grid')).not.toBeNull();
        expect(root.querySelector('.wg-plan-grid')).not.toBeNull();
    });

    it('renders workout scheduled_date as a human-readable label when not today', () => {
        const root = env.document.getElementById('today-content');
        const state = allPresentState(now);
        state.nextWorkout.value = {
            scheduled_date: '2026-04-20T00:00:00Z',
            scheduled_time: '18:30',
            group_name: 'Push day',
            status: 'pending',
            is_today: false
        };
        env.render(state, root, { now });

        const workoutTile = root.querySelector('.wg-plan-tile[data-deeplink="workouts"]');
        const detail = workoutTile.querySelector('.wg-plan-tile__detail');
        expect(detail.textContent).not.toContain('T00:00:00Z');
        expect(detail.textContent).toMatch(/18:30/);
    });

    it('does not render a section-header or settings gear on Today', () => {
        const root = env.document.getElementById('today-content');
        env.render(allPresentState(now), root, { now });

        expect(root.querySelector('.section-header')).toBeNull();
        expect(root.querySelector('.today-settings-gear')).toBeNull();
    });

    it('first-run shows the connect message with no banner', () => {
        const root = env.document.getElementById('today-content');
        const state = env.aggregate(null, null, now);
        state.__firstRun = true;
        env.render(state, root, { now });

        expect(root.querySelector('.today-offline-banner')).toBeNull();
        const empty = root.querySelector('.today-empty-firstrun');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toBe('Connect to load your day');
    });

    // Goal Line hero (med-8tur.2, docs/gamification.md §0.3.2): the weight goal
    // on the trend + workout/BP facts + one CTA. Replaces the rings tile and the
    // Tomorrow Forecast that mounted inside it.
    function goalLinePayload(goalOverrides, rest) {
        return {
            enabled: true,
            goal: {
                status: 'ok', target: 78, episode_id: 'g1',
                start_ref: 86, start_ref_source: 'trend_at_set', start_day: '2026-03-01', direction: -1,
                trend_weight: 82.4, latest_reading: { weight: 82.1, measured_at: '2026-04-19T07:00:00Z' },
                distance_to_goal: 4.4, change_7d: -0.4,
                progress: { done_kg: 3.6, total_kg: 8, fraction: 0.45 },
                coverage: { weigh_in_days_28d: 12, last_weigh_in_day: '2026-04-18', min_weigh_in_days: 5 },
                too_fast: false,
                next_milestone: { ordinal: 4, count: 8, weight: 82, distance: 0.4, is_halfway: false, is_goal: false },
                ...goalOverrides
            },
            workouts: { feature_on: true, completed_this_week: 2, next_scheduled: { day: '2026-04-22', time: '18:00', group_title: 'Push' }, scheduled_this_week: null },
            bp: { feature_on: true, recorded_today: true, days_this_week: 3, mean_7d: { systolic: 128.4, diastolic: 82.2, days: 5 }, target: { systolic: 130, diastolic: 85 }, status: 'in_range' },
            weighed_today: false,
            cta: 'weigh_in',
            ...rest
        };
    }

    function goalLineState(now, payload) {
        const state = allPresentState(now);
        state.goalLine = env.aggregate({ features: { gamification: true } }, { gamification_goal_line: payload }, now).goalLine;
        return state;
    }

    it('ok: headline trend → target, progress since the goal, next marker, 7 days, facts and the Weigh in CTA', () => {
        const root = env.document.getElementById('today-content');
        const onAddWeight = vi.fn();
        const onDeeplink = vi.fn();
        env.render(goalLineState(now, goalLinePayload()), root, { now, onAddWeight, onDeeplink });

        const card = root.querySelector('.wg-goal-line');
        expect(card).not.toBeNull();
        expect(card.getAttribute('data-status')).toBe('ok');
        expect(card.querySelector('.wg-goal-line__value').textContent).toBe('82.4 → 78.0 kg');
        expect(card.querySelector('.wg-goal-line__basis').textContent).toBe('trend · 12 weigh-ins/28d');
        expect(card.querySelector('.wg-goal-line__fill').style.getPropertyValue('--fill-pct')).toBe('45.0%');
        expect(card.textContent).toContain('3.6 of 8.0 kg since you set the goal · next marker 82.0 kg');
        expect(card.textContent).toContain('7 days: −0.4 kg');
        const wed = new Date(2026, 3, 22).toLocaleDateString(undefined, { weekday: 'short' });
        expect(card.querySelector('[data-fact="workouts"]').textContent).toBe(`Workouts: 2 done this week · next ${wed} 18:00`);
        expect(card.querySelector('[data-fact="bp"]').textContent).toBe('BP: recorded today · 7d avg 128/82 vs 130/85');
        expect(card.querySelector('.wg-goal-line__safety')).toBeNull();
        // No HP, level, Health Score or rings on this card.
        expect(card.textContent).not.toMatch(/\bHP\b|Lvl|Health Score|rings/i);

        card.querySelector('[data-action="weigh-in"]').click();
        expect(onAddWeight).toHaveBeenCalledTimes(1);
        expect(onDeeplink).not.toHaveBeenCalled();
        card.click();
        expect(onDeeplink).toHaveBeenCalledWith('journey');
    });

    // med-8tur.4: the week's plan picked in the Journey weekly review shows
    // under the rows; a paused week reads "paused" (the domain already dropped
    // change_7d / too_fast for it).
    it('shows the chosen intention + cadence, or "Paused this week"', () => {
        const root = env.document.getElementById('today-content');
        const plan = {
            week: '2026-W17', intention: { id: 'weigh_before_coffee', text: 'When I wake, I will weigh in before coffee' },
            cadence: { weigh_in: 'daily', bp_days: 3 }, paused: false, picked_at: 1,
        };
        env.render(goalLineState(now, goalLinePayload({}, { plan })), root, { now });
        expect(root.querySelector('[data-fact="plan"]').textContent)
            .toBe('This week: When I wake, I will weigh in before coffee · weigh-in daily · BP 3 days');

        env.render(goalLineState(now, goalLinePayload({ change_7d: null }, { plan: { ...plan, paused: true } })), root, { now });
        expect(root.querySelector('[data-fact="plan"]').textContent).toBe('Paused this week');
        expect(root.querySelector('.wg-goal-line').textContent).not.toContain('7 days:');

        env.render(goalLineState(now, goalLinePayload({}, { plan: null })), root, { now });
        expect(root.querySelector('[data-fact="plan"]')).toBeNull();
    });

    it('rings tile and forecast no longer mount on Today', () => {
        const root = env.document.getElementById('today-content');
        env.render(goalLineState(now, goalLinePayload()), root, { now });
        expect(root.querySelector('.wg-goal-line')).not.toBeNull();
        expect(root.querySelector('.wg-today-rings')).toBeNull();
        expect(root.querySelector('.wg-ring-stack')).toBeNull();
        expect(root.querySelector('.wg-forecast-card')).toBeNull();
    });

    it('no_goal: compact "Set a weight goal →" to the Weight tab, facts still shown', () => {
        const root = env.document.getElementById('today-content');
        const onDeeplink = vi.fn();
        const payload = goalLinePayload({ status: 'no_goal', target: null, start_ref: null, start_ref_source: null, direction: null, distance_to_goal: null, next_milestone: null });
        env.render(goalLineState(now, payload), root, { now, onDeeplink });

        const card = root.querySelector('.wg-goal-line');
        expect(card.querySelector('.wg-goal-line__value')).toBeNull();
        expect(card.querySelector('.wg-goal-line__track')).toBeNull();
        const set = card.querySelector('[data-action="set-goal"]');
        expect(set.textContent).toBe('Set a weight goal →');
        set.click();
        expect(onDeeplink).toHaveBeenCalledWith('weight');
        expect(onDeeplink).not.toHaveBeenCalledWith('journey');
        expect(card.querySelector('[data-fact="workouts"]')).not.toBeNull();
        expect(card.querySelector('[data-fact="bp"]')).not.toBeNull();
    });

    it('no_goal with the Weight feature off: no dead "Set a weight goal" link', () => {
        const root = env.document.getElementById('today-content');
        const payload = goalLinePayload({ status: 'no_goal', target: null, start_ref: null, direction: null, next_milestone: null }, { cta: 'none' });
        const state = allPresentState(now);
        state.goalLine = env.aggregate({ features: { gamification: true, weight: false } }, { gamification_goal_line: payload }, now).goalLine;
        env.render(state, root, { now });
        const card = root.querySelector('.wg-goal-line');
        expect(card).not.toBeNull();
        expect(card.querySelector('[data-action="set-goal"]')).toBeNull();
        expect(card.querySelector('[data-fact="workouts"]')).not.toBeNull();
    });

    it('missed-dose safety net: an active adherence alert renders one line to Meds; inactive renders nothing', () => {
        const root = env.document.getElementById('today-content');
        const onDeeplink = vi.fn();
        env.render(goalLineState(now, goalLinePayload({}, { adherence_alert: { active: true, pdc: 0.72, missed_doses: 2 } })), root, { now, onDeeplink });
        const nudge = root.querySelector('.wg-goal-line__adherence');
        expect(nudge).not.toBeNull();
        expect(nudge.textContent).toBe('2 missed doses recently — worth a look');
        nudge.click();
        expect(onDeeplink).toHaveBeenCalledWith('meds');
        expect(onDeeplink).not.toHaveBeenCalledWith('journey');

        env.render(goalLineState(now, goalLinePayload({}, { adherence_alert: { active: false, pdc: 0.95, missed_doses: 1 } })), root, { now });
        expect(root.querySelector('.wg-goal-line__adherence')).toBeNull();
        env.render(goalLineState(now, goalLinePayload({}, { adherence_alert: null })), root, { now });
        expect(root.querySelector('.wg-goal-line__adherence')).toBeNull();
    });

    // med-8tur.5: a reached milestone shows one line until acknowledged.
    const MILESTONE = {
        id: 'gamificationmilestone-weightgoal-1-4', ordinal: 4, count: 8, is_halfway: true, is_goal: false,
        earned_at: '2026-06-10', title: 'Halfway to your weight goal',
    };

    it('milestone: one line with "Got it" that acks without opening Journey; none without a milestone', () => {
        const root = env.document.getElementById('today-content');
        const onDeeplink = vi.fn();
        const onAckMilestone = vi.fn();
        env.render(goalLineState(now, goalLinePayload({}, { milestone: MILESTONE })), root, { now, onDeeplink, onAckMilestone });
        const row = root.querySelector('.wg-goal-line__milestone');
        expect(row.querySelector('.wg-goal-line__milestone-text').textContent).toBe('Halfway to your weight goal');
        row.querySelector('[data-action="ack-milestone"]').click();
        expect(onAckMilestone).toHaveBeenCalledWith(MILESTONE.id);
        expect(onDeeplink).not.toHaveBeenCalled();

        env.render(goalLineState(now, goalLinePayload({}, { milestone: null })), root, { now, onAckMilestone });
        expect(root.querySelector('.wg-goal-line__milestone')).toBeNull();
    });

    it('milestone default ack: optimistic milestone:null on the Goal Line cache, POST ack, commit (rollback on failure)', async () => {
        const root = env.document.getElementById('today-content');
        const handle = { commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };
        let projected = null;
        env.window.DataStore = {
            applyOptimistic: vi.fn(async (key, mutator) => { projected = mutator({ goal: {}, milestone: MILESTONE }); return handle; }),
        };
        env.window.offlineAwareApiCall = vi.fn(async () => ({ ok: true }));
        const click = async () => {
            env.render(goalLineState(now, goalLinePayload({}, { milestone: MILESTONE })), root, { now });
            root.querySelector('[data-action="ack-milestone"]').click();
            await vi.waitFor(() => expect(handle.commit.mock.calls.length + handle.rollback.mock.calls.length).toBeGreaterThan(0));
        };

        await click();
        expect(env.window.DataStore.applyOptimistic).toHaveBeenCalledWith('gamification_goal_line', expect.any(Function), ['gamification']);
        expect(projected).toEqual({ goal: {}, milestone: null });
        expect(env.window.offlineAwareApiCall).toHaveBeenCalledWith(`/api/gamification/milestones/${encodeURIComponent(MILESTONE.id)}/ack`, 'POST');
        expect(handle.commit).toHaveBeenCalledWith(null);
        expect(handle.rollback).not.toHaveBeenCalled();

        handle.commit.mockClear();
        env.window.offlineAwareApiCall = vi.fn(async () => ({ ok: false, error: 'not_found' }));
        await click();
        expect(handle.rollback).toHaveBeenCalled();
        expect(handle.commit).not.toHaveBeenCalled();
    });

    it('preliminary: the latest reading as a reading, and how many weigh-ins until a trend', () => {
        const root = env.document.getElementById('today-content');
        const payload = goalLinePayload({
            status: 'preliminary', trend_weight: null, change_7d: null, next_milestone: null, start_ref_source: 'first_reading',
            latest_reading: { weight: 82.9, measured_at: '2026-04-19T07:00:00Z' },
            coverage: { weigh_in_days_28d: 3, last_weigh_in_day: '2026-04-19', min_weigh_in_days: 5 }
        });
        env.render(goalLineState(now, payload), root, { now });

        const card = root.querySelector('.wg-goal-line');
        expect(card.querySelector('.wg-goal-line__basis').textContent).toBe('latest reading');
        expect(card.textContent).toContain('Latest 82.9 kg · trend forms after 2 more weigh-ins');
        expect(card.querySelector('.wg-goal-line__track')).toBeNull();
        expect(card.textContent).not.toContain('7 days');
    });

    it('at_goal and maintaining get explicit copy, no progress bar', () => {
        const root = env.document.getElementById('today-content');
        env.render(goalLineState(now, goalLinePayload({ status: 'at_goal', trend_weight: 78.2, next_milestone: null })), root, { now });
        expect(root.querySelector('.wg-goal-line').textContent).toContain('At your goal — trend has reached 78.0 kg');
        expect(root.querySelector('.wg-goal-line__track')).toBeNull();

        env.render(goalLineState(now, goalLinePayload({ status: 'maintaining', trend_weight: 77.9, next_milestone: null })), root, { now });
        expect(root.querySelector('.wg-goal-line').textContent).toContain('Maintaining your goal — trend holding at 78.0 kg');
    });

    it('too_fast: one calm safety line, never praise', () => {
        const root = env.document.getElementById('today-content');
        env.render(goalLineState(now, goalLinePayload({ too_fast: true })), root, { now });
        const card = root.querySelector('.wg-goal-line');
        const safety = card.querySelectorAll('.wg-goal-line__safety');
        expect(safety.length).toBe(1);
        expect(safety[0].textContent).toBe('Faster than 1% a week — worth checking with your doctor.');
        expect(card.textContent).not.toMatch(/great|nice|well done|on pace|ahead/i);
    });

    it('start_session CTA routes to the Workouts tab; cta none renders no button', () => {
        const root = env.document.getElementById('today-content');
        const onDeeplink = vi.fn();
        env.render(goalLineState(now, goalLinePayload({}, { cta: 'start_session', weighed_today: true })), root, { now, onDeeplink });
        const cta = root.querySelector('.wg-goal-line__cta');
        expect(cta.getAttribute('data-action')).toBe('start-session');
        cta.click();
        expect(onDeeplink).toHaveBeenCalledWith('workouts');
        expect(onDeeplink).not.toHaveBeenCalledWith('journey');

        env.render(goalLineState(now, goalLinePayload({}, { cta: 'none', weighed_today: true })), root, { now });
        expect(root.querySelector('.wg-goal-line__cta')).toBeNull();
    });

    it('workout / BP rows are hidden when their feature is off', () => {
        const root = env.document.getElementById('today-content');
        const payload = goalLinePayload({}, {
            workouts: { feature_on: false, completed_this_week: null, next_scheduled: null, scheduled_this_week: null },
            bp: { feature_on: false, recorded_today: null, days_this_week: null, mean_7d: null, target: null, status: 'unknown' }
        });
        env.render(goalLineState(now, payload), root, { now });
        const card = root.querySelector('.wg-goal-line');
        expect(card).not.toBeNull();
        expect(card.querySelector('[data-fact]')).toBeNull();
        expect(card.querySelector('.wg-goal-line__facts')).toBeNull();
    });

    it('gamification off (flag or payload) → no card at all', () => {
        const root = env.document.getElementById('today-content');
        const off = allPresentState(now);
        off.goalLine = env.aggregate({ features: { gamification: false } }, { gamification_goal_line: goalLinePayload() }, now).goalLine;
        env.render(off, root, { now });
        expect(root.querySelector('.wg-goal-line')).toBeNull();

        env.render(goalLineState(now, { enabled: false }), root, { now });
        expect(root.querySelector('.wg-goal-line')).toBeNull();
    });

    // med-8tur.12: ED-safe rides the Goal Line payload — no Goal Line card and
    // no weight numbers on Today (the weight metric cells go 'disabled').
    it('ED-safe payload → no Goal Line card and no weight metric on Today', () => {
        const bootstrap = {
            features: { gamification: true, weight: true },
            weight: { logs: [{ measured_at: new Date(now).toISOString(), weight: 82.4 }] },
        };
        const safe = env.aggregate(bootstrap, { gamification_goal_line: { enabled: false, ed_safe: true } }, now);
        expect(safe.goalLine.status).toBe('disabled');
        expect(safe.weightLatest.status).toBe('disabled');
        expect(safe.weightTrend7d.status).toBe('disabled');

        const normal = env.aggregate(bootstrap, { gamification_goal_line: goalLinePayload() }, now);
        expect(normal.weightLatest.status).toBe('ok');
    });

    // The missed-dose alert is a medication safety signal, not a weight one:
    // ED-safe keeps it, rendered on its own with no goal or weight numbers.
    it('ED-safe + active adherence alert → the alert line alone, no weight numbers', () => {
        const root = env.document.getElementById('today-content');
        const bootstrap = {
            features: { gamification: true, weight: true },
            weight: { logs: [{ measured_at: new Date(now).toISOString(), weight: 82.4 }] },
        };
        const payload = { enabled: false, ed_safe: true, adherence_alert: { active: true, pdc: 0.6, missed_doses: 3 } };
        const state = env.aggregate(bootstrap, { gamification_goal_line: payload }, now);
        const onDeeplink = vi.fn();
        env.render(state, root, { now, onDeeplink });

        const alert = root.querySelector('.wg-goal-line__adherence');
        expect(alert).not.toBeNull();
        expect(alert.textContent).toBe('3 missed doses recently — worth a look');
        alert.click();
        expect(onDeeplink).toHaveBeenCalledWith('meds');
        expect(root.querySelector('.wg-goal-line')).toBeNull();
        expect(root.textContent).not.toMatch(/82\.4|kg/);
    });
});

// The card's cache entry must evict on its SOURCE tags: only goal milestones
// sync under 'gamification' (sync.js RECORD_TAGS), so a weigh-in, session, BP
// reading, synced goal edit or feature flip would otherwise repaint a stale
// card. Eviction → Today's loader sees it missing and refetches.
describe('Goal Line cache tags', () => {
    beforeEach(() => { allowConsoleNoise(); });

    it.each(['gamification', 'weight', 'workout', 'bp', 'settings', 'medications', 'history'])('invalidating %s evicts gamification_goal_line', async (tag) => {
        const { window, cacheMap, cleanup } = loadDataStoreEnv({
            initialCache: { gamification_goal_line: { enabled: true }, food_products_cache: { keep: true } }
        });
        try {
            window.eval(fs.readFileSync(CACHE_KEYS_JS, 'utf8'));
            window.CacheKeys.registerAll(window.DataStore);
            await window.DataStore.invalidateTags([tag]);
            expect(cacheMap.has('gamification_goal_line')).toBe(false);
            expect(cacheMap.has('food_products_cache')).toBe(true);
        } finally {
            cleanup();
        }
    });
});
