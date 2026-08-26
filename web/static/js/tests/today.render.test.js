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
const WG_RING_STACK_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-ring-stack.js');
const TODAY_JS = path.join(REPO_ROOT, 'web/static/js/features/today.js');

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
    window.eval(fs.readFileSync(WG_RING_STACK_JS, 'utf8'));
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

    it('renders offline banner when state.__offline is set and not first-run', () => {
        const root = env.document.getElementById('today-content');
        const state = allPresentState(now);
        state.__offline = true;
        env.render(state, root, { now });

        const banner = root.querySelector('.today-offline-banner');
        expect(banner).not.toBeNull();
        expect(banner.textContent).toMatch(/offline/i);
    });

    it('first-run while offline shows a single combined message, no separate banner', () => {
        const root = env.document.getElementById('today-content');
        const state = env.aggregate(null, null, now);
        state.__firstRun = true;
        state.__offline = true;
        env.render(state, root, { now });

        expect(root.querySelector('.today-offline-banner')).toBeNull();
        const empty = root.querySelector('.today-empty-firstrun');
        expect(empty).not.toBeNull();
        expect(empty.textContent.toLowerCase()).toMatch(/offline|reconnect/);
    });

    // Gamification rings tile: "X of 3 closed" headline + the "your move"
    // next-step prompt (first open ring in canonical order, deep-linking to its
    // own section, not Journey).
    function ringsState(now, closedRings, syncPendingRings, healthScoreValue) {
        const all = ['bedtime', 'movement', 'nourishment'];
        const pending = syncPendingRings || [];
        const state = allPresentState(now);
        state.gamificationRings = {
            value: {
                level: 4,
                todayHp: 28,
                healthScore: { value: healthScoreValue === undefined ? null : healthScoreValue },
                rings: all.map((ring) => ({
                    ring,
                    hp: closedRings.includes(ring) ? 12 : 2,
                    closed: closedRings.includes(ring),
                    sync_pending: pending.includes(ring)
                }))
            },
            deeplink: 'journey',
            status: 'ok'
        };
        return state;
    }

    it('rings tile headlines "N of 3 rings closed" and checks each closed ring', () => {
        const root = env.document.getElementById('today-content');
        env.render(ringsState(now, ['bedtime', 'movement']), root, { now });

        const tile = root.querySelector('.wg-today-rings');
        expect(tile).not.toBeNull();
        expect(tile.querySelector('.wg-today-rings__title').textContent).toBe('2 of 3 rings closed');
        expect(tile.querySelectorAll('.wg-today-rings__ic--closed').length).toBe(2);
        // Open actionable rings remain → center shows the "2/3" count, not a check.
        expect(tile.querySelector('.wg-ring-stack__center').textContent).toBe('2/3');
    });

    it('"your move" targets the first open ring and deep-links to its section', () => {
        const root = env.document.getElementById('today-content');
        const onDeeplink = vi.fn();
        // bedtime + movement closed → nourishment is the first open ring → "Log a meal".
        env.render(ringsState(now, ['bedtime', 'movement']), root, { now, onDeeplink });

        const move = root.querySelector('.wg-today-rings__move');
        expect(move).not.toBeNull();
        expect(move.textContent).toMatch(/Your move:.*Log a meal.*Nourishment/);

        move.click();
        expect(onDeeplink).toHaveBeenCalledWith('food');
        // The move click must not also trigger the card's Journey deep-link.
        expect(onDeeplink).not.toHaveBeenCalledWith('journey');
    });

    it('all rings closed → celebration, not an actionable move', () => {
        const root = env.document.getElementById('today-content');
        env.render(ringsState(now, ['bedtime', 'movement', 'nourishment']), root, { now });

        const tile = root.querySelector('.wg-today-rings');
        expect(tile.querySelector('.wg-today-rings__title').textContent).toBe('3 of 3 rings closed');
        const move = root.querySelector('.wg-today-rings__move');
        expect(move.textContent.toLowerCase()).toMatch(/all rings closed/);
        // Celebration is not a button — no section deep-link of its own.
        expect(move.getAttribute('role')).toBeNull();
        expect(move.getAttribute('data-section')).toBeNull();
    });

    // Sync-pending rings (Plan 6, Task 3): a device-synced ring (Bedtime/Movement)
    // with no sample yet reads as "waiting", not "failed".
    it('sync-pending ring renders as a dimmed "syncs later" icon, not the goal text', () => {
        const root = env.document.getElementById('today-content');
        env.render(ringsState(now, [], ['bedtime']), root, { now });

        const icons = root.querySelectorAll('.wg-today-rings__ic');
        const bedtime = Array.from(icons).find((el) => (el.getAttribute('aria-label') || '').startsWith('Bedtime'));
        expect(bedtime).not.toBeUndefined();
        expect(bedtime.classList.contains('wg-today-rings__ic--sync')).toBe(true);
        expect(bedtime.getAttribute('aria-label')).toMatch(/syncs later/i);
    });

    it('headline appends "· M waiting for sync" when sync-pending rings exist', () => {
        const root = env.document.getElementById('today-content');
        env.render(ringsState(now, ['nourishment'], ['bedtime', 'movement']), root, { now });

        const tile = root.querySelector('.wg-today-rings');
        expect(tile.querySelector('.wg-today-rings__title').textContent)
            .toBe('1 of 3 rings closed · 2 waiting for sync');
    });

    it('"your move" skips sync-pending rings and targets the first actionable open ring', () => {
        const root = env.document.getElementById('today-content');
        const onDeeplink = vi.fn();
        // bedtime closed, movement sync-pending → nourishment is the first actionable open ring.
        env.render(ringsState(now, ['bedtime'], ['movement']), root, { now, onDeeplink });

        const move = root.querySelector('.wg-today-rings__move');
        expect(move.textContent).toMatch(/Your move:.*Log a meal.*Nourishment/);
        move.click();
        expect(onDeeplink).toHaveBeenCalledWith('food');
    });

    it('only sync-pending rings remaining reads as caught up, not a nag', () => {
        const root = env.document.getElementById('today-content');
        env.render(ringsState(now, ['movement', 'nourishment'], ['bedtime']), root, { now });

        const move = root.querySelector('.wg-today-rings__move');
        expect(move.textContent.toLowerCase()).toMatch(/all caught up/);
        expect(move.getAttribute('role')).toBeNull();
        expect(move.getAttribute('data-section')).toBeNull();
        // The stack center must agree with the "caught up" prompt: all
        // actionable rings closed → check glyph, not the "2/3" count.
        const center = root.querySelector('.wg-ring-stack__center');
        expect(center).not.toBeNull();
        expect(center.querySelector('svg')).not.toBeNull();
        expect(center.textContent).not.toMatch(/\d/);
    });

    // Guard the runtime projection: aggregateToday remaps the raw rings payload
    // into the render cell, and must carry sync_pending through — the other
    // sync-pending tests build the cell by hand and would miss a dropped field.
    it('aggregateToday carries sync_pending from the raw rings payload into the cell', () => {
        const caches = {
            gamification_rings: {
                level: 4,
                today_hp: 28,
                rings: [
                    { ring: 'nourishment', hp: 12, closed: true },
                    { ring: 'bedtime', hp: 2, closed: false, sync_pending: true }
                ]
            }
        };
        const state = env.aggregate({ features: {} }, caches, now);
        const rings = state.gamificationRings.value.rings;
        expect(rings.find((r) => r.ring === 'bedtime').sync_pending).toBe(true);
        expect(rings.find((r) => r.ring === 'nourishment').sync_pending).toBe(false);
    });

    // Headline (Task 8): the Health Score composite replaces the raw "N HP
    // today" number — a 0-100 score with a qualitative band word reads as
    // "good or not" at a glance, which a bare HP count doesn't.
    it('aggregateToday carries health_score from the raw rings payload into the cell', () => {
        const caches = {
            gamification_rings: {
                level: 4,
                today_hp: 28,
                rings: [{ ring: 'nourishment', hp: 12, closed: true }],
                health_score: { value: 82.4, contributors: [], missing: [] }
            }
        };
        const state = env.aggregate({ features: {} }, caches, now);
        expect(state.gamificationRings.value.healthScore.value).toBe(82.4);
    });

    // Adherence safety net (Task 3): a solved habit stays invisible until the
    // trailing PDC actually slips, then Today surfaces one gentle line.
    it('aggregateToday carries an active adherence_alert from the raw rings payload into the cell', () => {
        const caches = {
            gamification_rings: {
                level: 4,
                today_hp: 28,
                rings: [{ ring: 'nourishment', hp: 12, closed: true }],
                adherence_alert: { active: true, pdc: 0.72, missed_doses: 2 }
            }
        };
        const state = env.aggregate({ features: {} }, caches, now);
        expect(state.gamificationRings.value.adherenceAlert).toEqual({ missedDoses: 2 });
    });

    it('aggregateToday drops an inactive adherence_alert — a solved habit stays invisible', () => {
        const caches = {
            gamification_rings: {
                level: 4,
                today_hp: 28,
                rings: [{ ring: 'nourishment', hp: 12, closed: true }],
                adherence_alert: { active: false, pdc: 0.95, missed_doses: 1 }
            }
        };
        const state = env.aggregate({ features: {} }, caches, now);
        expect(state.gamificationRings.value.adherenceAlert).toBeNull();
    });

    it('renders the adherence nudge line when active and deep-links to Meds', () => {
        const root = env.document.getElementById('today-content');
        const onDeeplink = vi.fn();
        const state = ringsState(now, ['bedtime', 'movement']);
        state.gamificationRings.value.adherenceAlert = { missedDoses: 2 };
        env.render(state, root, { now, onDeeplink });

        const nudge = root.querySelector('.wg-today-rings__adherence');
        expect(nudge).not.toBeNull();
        expect(nudge.textContent).toMatch(/2 missed doses/i);

        nudge.click();
        expect(onDeeplink).toHaveBeenCalledWith('meds');
        expect(onDeeplink).not.toHaveBeenCalledWith('journey');
    });

    it('renders no adherence line at all when the alert is inactive', () => {
        const root = env.document.getElementById('today-content');
        env.render(ringsState(now, ['bedtime', 'movement']), root, { now });
        expect(root.querySelector('.wg-today-rings__adherence')).toBeNull();
    });

    it('rings tile headline shows the Health Score number and a token-colored band tag', () => {
        const root = env.document.getElementById('today-content');
        env.render(ringsState(now, ['bedtime', 'movement'], [], 82), root, { now });

        const tile = root.querySelector('.wg-today-rings');
        expect(tile.querySelector('.wg-today-rings__score-value').textContent).toBe('82');
        expect(tile.querySelector('.wg-tag').textContent).toBe('Good');
    });

    it('rings tile headline shows "Not enough data" instead of a misleading number below the min-contributors floor', () => {
        const root = env.document.getElementById('today-content');
        env.render(ringsState(now, ['bedtime', 'movement'], [], null), root, { now });

        const tile = root.querySelector('.wg-today-rings');
        expect(tile.querySelector('.wg-today-rings__score-value').textContent).toBe('—');
        expect(tile.querySelector('.wg-today-rings__score-note').textContent).toBe('Not enough data');
    });
});
