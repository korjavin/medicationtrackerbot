// Plan 2026-07-06 cloud-c2c, Task 6 — shim-mode contract run of the food log
// CRUD + grouping + stats flows against web/domain/food.js. Drives the real
// feature code (saveFoodLog / deleteFoodLog / editFoodLog from
// features/food/log.js) through window.apiCall (core/api.js), which
// delegates to the cloud shim (web/cloud/js/apishim.js) instead of the
// network — same pattern as cloud.shim-contract.meds.test.js. Divergences
// here are contract bugs in the JS domain layer, not test bugs; the original
// (network-mocked) food.*.test.js files keep running unshimmed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApiCache, loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

function localDateStr(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function atTime(dateStr, hh, mm) {
    return `${dateStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function fillFoodLogForm(document, {
    id = '', name = '', barcode = '', dateStr, weight = '', carbs = '', protein = '', fat = '', calories = '', per100g = false
}) {
    document.getElementById('food-id').value = id;
    document.getElementById('food-log-product-id').value = '';
    document.getElementById('food-log-is-meal').value = '';
    document.getElementById('food-parse-ai').checked = false;
    document.getElementById('food-name').value = name;
    document.getElementById('food-barcode').value = barcode;
    document.getElementById('food-datetime').value = dateStr;
    document.getElementById('food-weight').value = weight;
    document.getElementById('food-per-100g').checked = per100g;
    document.getElementById('food-carbs').value = carbs;
    document.getElementById('food-protein').value = protein;
    document.getElementById('food-fat').value = fat;
    document.getElementById('food-calories').value = calories;
}

async function createLog(window, { name, eaten_at, weight, carbs, protein, fat, calories }) {
    return window.apiCall('/api/food/log', 'POST', {
        eaten_at, weight, carbs, protein, fat, calories, name, barcode: '', per_100g: false
    });
}

describe('cloud shim contract — food log flows (features/food/log.js over web/domain/food.js)', () => {
    let env;
    const today = localDateStr();

    beforeEach(() => {
        env = loadCloudShimFrontendEnv();
        installApiCache(env.window);
        env.window.loadFoodLogs = vi.fn();
        env.window.loadToday = vi.fn();
        env.window.safeAlert = vi.fn();

        // closeFoodModal() also tears down the barcode-scanner modal, whose
        // video element jsdom doesn't implement .pause() for — stub it like
        // the other food modal tests do, or the noise guard fails the test.
        const video = env.document.getElementById('food-scanner-video');
        if (video) {
            video.pause = vi.fn();
            video.srcObject = null;
        }
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    // med-9z3.9 — the Go handlers guard `days` with `err == nil && d > 0`
    // (food_handlers.go handleGetFoodLogs/handleGetFoodStats), so a non-positive
    // value falls back to the default window. The shim's intParam let 0/-5 reach
    // the domain module, which turned it into an empty window: no data where bot
    // mode returns the default.
    describe('non-positive `days` falls back to the default window (bot-mode parity)', () => {
        const seedOneLog = async (window, document) => {
            fillFoodLogForm(document, {
                name: 'Apple', dateStr: atTime(today, 8, 0), weight: 180, carbs: 25, protein: 0, fat: 0, calories: 95
            });
            await window.saveFoodLog();
        };

        for (const days of ['0', '-5']) {
            it(`GET /api/food/log?days=${days} behaves like the default days=1`, async () => {
                const { window, document } = env;
                await seedOneLog(window, document);

                const withDays = await window.apiCall(`/api/food/log?date=${today}&days=${days}`);
                const withDefault = await window.apiCall(`/api/food/log?date=${today}`);

                expect(withDays.flatMap((g) => g.logs).map((l) => l.name)).toEqual(['Apple']);
                expect(withDays).toEqual(withDefault);
            });

            it(`GET /api/food/stats?days=${days} behaves like the default days=7`, async () => {
                const { window, document } = env;
                await seedOneLog(window, document);

                const withDays = await window.apiCall(`/api/food/stats?date=${today}&days=${days}`);
                const withDefault = await window.apiCall(`/api/food/stats?date=${today}`);

                expect(withDays).toEqual(withDefault);
            });
        }
    });

    it('saveFoodLog (create/edit) round-trips through the shim, deleteFoodLog removes it', async () => {
        const { window, document } = env;
        fillFoodLogForm(document, {
            name: 'Apple', dateStr: atTime(today, 8, 0), weight: 180, carbs: 25, protein: 0, fat: 0, calories: 95
        });

        await window.saveFoodLog();

        const grouped = await window.apiCall(`/api/food/log?date=${today}&days=1`);
        const created = grouped.flatMap((g) => g.logs).find((l) => l.name === 'Apple');
        expect(created).toBeDefined();
        expect(created).toMatchObject({ weight: 180, carbs: 25, protein: 0, fat: 0, calories: 95 });

        fillFoodLogForm(document, {
            id: created.id, name: 'Apple', dateStr: atTime(today, 8, 0), weight: 200, carbs: 30, protein: 1, fat: 0, calories: 124
        });
        await window.saveFoodLog();

        const groupedAfterEdit = await window.apiCall(`/api/food/log?date=${today}&days=1`);
        const updated = groupedAfterEdit.flatMap((g) => g.logs).find((l) => l.id === created.id);
        expect(updated).toMatchObject({ weight: 200, carbs: 30, protein: 1, calories: 124 });

        window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });
        await window.deleteFoodLog(created.id);

        const groupedAfterDelete = await window.apiCall(`/api/food/log?date=${today}&days=1`);
        const stillThere = groupedAfterDelete.flatMap((g) => g.logs).find((l) => l.id === created.id);
        expect(stillThere).toBeUndefined();
    });

    it('groups same-day logs into hour-based meal buckets (Breakfast/Lunch/Dinner)', async () => {
        const { window } = env;
        await createLog(window, { name: 'Eggs', eaten_at: new Date(atTime(today, 8, 0)).toISOString(), weight: 100, carbs: 1, protein: 12, fat: 10, calories: 142 });
        await createLog(window, { name: 'Sandwich', eaten_at: new Date(atTime(today, 13, 0)).toISOString(), weight: 250, carbs: 40, protein: 15, fat: 12, calories: 328 });
        await createLog(window, { name: 'Pasta', eaten_at: new Date(atTime(today, 19, 0)).toISOString(), weight: 300, carbs: 60, protein: 20, fat: 10, calories: 410 });

        const grouped = await window.apiCall(`/api/food/log?date=${today}&days=1`);
        expect(grouped).toHaveLength(3);
        expect(grouped.map((g) => g.name)).toEqual(['Breakfast', 'Lunch', 'Dinner']);
        expect(grouped[0].logs).toHaveLength(1);
        expect(grouped[1].logs).toHaveLength(1);
        expect(grouped[2].logs).toHaveLength(1);
    });

    it('clusters two logs within 30 minutes of each other into a single group with combined totals', async () => {
        const { window } = env;
        await createLog(window, { name: 'Yogurt', eaten_at: new Date(atTime(today, 10, 0)).toISOString(), weight: 150, carbs: 10, protein: 8, fat: 3, calories: 99 });
        await createLog(window, { name: 'Granola', eaten_at: new Date(atTime(today, 10, 10)).toISOString(), weight: 40, carbs: 25, protein: 3, fat: 5, calories: 157 });

        const grouped = await window.apiCall(`/api/food/log?date=${today}&days=1`);
        expect(grouped).toHaveLength(1);
        expect(grouped[0].logs).toHaveLength(2);
        expect(grouped[0].calories).toBe(99 + 157);
        expect(grouped[0].carbs).toBe(10 + 25);
        expect(grouped[0].protein).toBe(8 + 3);
        expect(grouped[0].fat).toBe(3 + 5);
    });

    it('multi-day query (days=2) groups by calendar date instead of meal name', async () => {
        const { window } = env;
        const yesterday = localDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000));
        await createLog(window, { name: 'Toast', eaten_at: new Date(atTime(yesterday, 8, 0)).toISOString(), weight: 60, carbs: 20, protein: 4, fat: 2, calories: 122 });
        await createLog(window, { name: 'Omelette', eaten_at: new Date(atTime(today, 8, 0)).toISOString(), weight: 150, carbs: 2, protein: 18, fat: 14, calories: 214 });

        const grouped = await window.apiCall(`/api/food/log?date=${today}&days=2`);
        expect(grouped).toHaveLength(2);
        // Multi-day grouping labels each group by calendar date ("Wed, Jan 05"),
        // not by meal name (Breakfast/Lunch/...).
        grouped.forEach((g) => {
            expect(g.name).toMatch(/^[A-Za-z]{3}, [A-Za-z]{3} \d{2}$/);
        });
        expect(grouped[0].logs).toHaveLength(1);
        expect(grouped[1].logs).toHaveLength(1);
    });

    it('stats sums the day window and is independent of (but readable alongside) saved targets', async () => {
        const { window } = env;
        await window.apiCall('/api/food/settings/targets', 'POST', { calories: 2000, carbs: 250, protein: 100, fat: 70 });

        await createLog(window, { name: 'A', eaten_at: new Date(atTime(today, 9, 0)).toISOString(), weight: 100, carbs: 10, protein: 5, fat: 2, calories: 78 });
        await createLog(window, { name: 'B', eaten_at: new Date(atTime(today, 20, 0)).toISOString(), weight: 200, carbs: 30, protein: 15, fat: 8, calories: 252 });

        const stats = await window.apiCall(`/api/food/stats?date=${today}&days=1`);
        expect(stats).toEqual({ calories: 78 + 252, carbs: 10 + 30, protein: 5 + 15, fat: 2 + 8 });

        const targets = await window.apiCall('/api/food/settings/targets');
        expect(targets).toMatchObject({ calories: 2000, carbs: 250, protein: 100, fat: 70 });
    });

    it('per-100g edit semantics: editFoodLog re-populates fields close to the original per-100g inputs', async () => {
        const { window, document } = env;
        // weight 250g @ 12.3/7.8/3.1 per 100g carbs/protein/fat, calories left
        // blank so computeFoodTotals derives it from the other three totals.
        fillFoodLogForm(document, {
            name: 'Protein bar', dateStr: atTime(today, 15, 0), weight: 250, per100g: true, carbs: 12.3, protein: 7.8, fat: 3.1, calories: ''
        });
        await window.saveFoodLog();

        const grouped = await window.apiCall(`/api/food/log?date=${today}&days=1`);
        const created = grouped.flatMap((g) => g.logs).find((l) => l.name === 'Protein bar');
        expect(created).toBeDefined();

        window.FoodLog.setCurrent({ [created.id]: created });
        window.editFoodLog(created.id);

        expect(Number(document.getElementById('food-carbs').value)).toBeCloseTo(12.3, 0);
        expect(Number(document.getElementById('food-protein').value)).toBeCloseTo(7.8, 0);
        expect(Number(document.getElementById('food-fat').value)).toBeCloseTo(3.1, 0);
        expect(document.getElementById('food-per-100g').checked).toBe(true);
    });
});

// bd med-d5t.11 — owner logged food via the ElevenLabs voice agent and it never
// appeared in the UI, across reloads, while the agent could still read it back.
//
// Food has no named voice tool that browser-stamps the timestamp (BP does), so
// the LLM writes eaten_at itself and it has no clock. The MCP required-field
// check is warn-only. An omitted or unparseable eaten_at therefore reached
// food.create(), where toISOString() passed it through verbatim — and
// Date.parse(undefined) is NaN, so `NaN >= start` dropped the row from every
// windowed read, permanently.
//
// BP hid the same class of bug behind two protections food lacks: a browser
// stamp, and a rolling 30-day window rather than a single calendar day.
describe('cloud shim contract — food log eaten_at guard (med-d5t.11)', () => {
    let env;
    const today = localDateStr();

    beforeEach(() => {
        env = loadCloudShimFrontendEnv();
        installApiCache(env.window);
        env.window.loadFoodLogs = vi.fn();
        env.window.loadToday = vi.fn();
        env.window.safeAlert = vi.fn();
    });

    afterEach(() => { env.cleanup(); });

    async function todaysLogs(window) {
        const grouped = await window.apiCall(`/api/food/log?date=${today}&days=1`);
        return grouped.flatMap((g) => g.logs);
    }

    // The exact shapes an LLM produces when it has no clock.
    it.each([
        ['omitted', undefined],
        ['an empty string', ''],
        ['unparseable prose', 'with lunch'],
        ['null', null],
    ])('stamps now() when eaten_at is %s, so the meal is visible today', async (_label, eaten_at) => {
        const { window } = env;

        await createLog(window, { name: 'Voice meal', eaten_at, weight: 100, carbs: 1, protein: 2, fat: 3, calories: 40 });

        const logs = await todaysLogs(window);
        const created = logs.find((l) => l.name === 'Voice meal');
        expect(created).toBeDefined();
        expect(Number.isNaN(Date.parse(created.eaten_at))).toBe(false);
    });

    it('counts a now()-stamped meal in today\'s stats, not just the list', async () => {
        const { window } = env;

        await createLog(window, { name: 'Voice meal', eaten_at: undefined, weight: 100, carbs: 0, protein: 0, fat: 0, calories: 250 });

        const stats = await window.apiCall(`/api/food/stats?date=${today}&days=1`);
        expect(stats.calories).toBe(250);
    });

    it('preserves an explicit eaten_at exactly — the guard must not overwrite good input', async () => {
        const { window } = env;
        const explicit = new Date(`${today}T09:30:00`).toISOString();

        await createLog(window, { name: 'Breakfast', eaten_at: explicit, weight: 100, carbs: 1, protein: 1, fat: 1, calories: 20 });

        const created = (await todaysLogs(window)).find((l) => l.name === 'Breakfast');
        expect(created.eaten_at).toBe(explicit);
    });

    it('an update that omits eaten_at keeps the original instant, never nulls it', async () => {
        const { window } = env;
        const explicit = new Date(`${today}T09:30:00`).toISOString();
        await createLog(window, { name: 'Lunch', eaten_at: explicit, weight: 100, carbs: 1, protein: 1, fat: 1, calories: 20 });
        const created = (await todaysLogs(window)).find((l) => l.name === 'Lunch');

        // MCP food.log.update does not require eaten_at (validateInput is
        // warn-only), so an edit of calories alone used to destroy the timestamp.
        await window.apiCall(`/api/food/log/${created.id}`, 'PUT', {
            name: 'Lunch', weight: 100, carbs: 1, protein: 1, fat: 1, calories: 99,
        });

        const after = (await todaysLogs(window)).find((l) => l.name === 'Lunch');
        expect(after).toBeDefined();
        expect(after.eaten_at).toBe(explicit);
        expect(after.calories).toBe(99);
    });

    it('an update must not silently move a meal to now()', async () => {
        const { window } = env;
        // 09:30 today, then edited later in the day.
        const explicit = new Date(`${today}T09:30:00`).toISOString();
        await createLog(window, { name: 'Snack', eaten_at: explicit, weight: 10, carbs: 1, protein: 1, fat: 1, calories: 5 });
        const created = (await todaysLogs(window)).find((l) => l.name === 'Snack');

        await window.apiCall(`/api/food/log/${created.id}`, 'PUT', {
            name: 'Snack', weight: 10, carbs: 1, protein: 1, fat: 1, calories: 6, eaten_at: 'nonsense',
        });

        const after = (await todaysLogs(window)).find((l) => l.name === 'Snack');
        expect(after.eaten_at).toBe(explicit);
    });
});

// bd med-don1 — move a meal group's rows (a late-uploaded photo stamped "now")
// to another day: POST /api/food/log/move -> food.moveLogs, driven from the
// meal-group header sheet (FoodLog.openMove).
describe('cloud shim contract — move a meal group to another day (med-don1)', () => {
    let env;
    const today = localDateStr();
    const yesterday = localDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000));

    beforeEach(() => {
        env = loadCloudShimFrontendEnv();
        installApiCache(env.window);
        env.window.loadFoodLogs = vi.fn();
        env.window.loadToday = vi.fn();
        env.window.safeAlert = vi.fn();
        env.window.safeToast = vi.fn();
    });

    afterEach(() => { env.cleanup(); });

    const logsOn = async (window, day) =>
        (await window.apiCall(`/api/food/log?date=${day}&days=1`)).flatMap((g) => g.logs);

    // 2 real lunch rows at 12:40 + 3 photo rows sharing one stamp at 13:05.
    async function seedLunchAndPhoto(window) {
        const lunch = new Date(atTime(today, 12, 40)).toISOString();
        const photo = new Date(atTime(today, 13, 5)).toISOString();
        await createLog(window, { name: 'Soup', eaten_at: lunch, weight: 300, carbs: 20, protein: 10, fat: 5, calories: 165 });
        await createLog(window, { name: 'Bread', eaten_at: lunch, weight: 50, carbs: 25, protein: 4, fat: 1, calories: 125 });
        await createLog(window, { name: 'Rice', eaten_at: photo, weight: 200, carbs: 56, protein: 5, fat: 1, calories: 260 });
        await createLog(window, { name: 'Chicken', eaten_at: photo, weight: 150, carbs: 0, protein: 40, fat: 6, calories: 220 });
        await createLog(window, { name: 'Salad', eaten_at: photo, weight: 120, carbs: 6, protein: 2, fat: 8, calories: 100 });
        const groups = await window.apiCall(`/api/food/log?date=${today}&days=1`);
        expect(groups).toHaveLength(1);
        return groups[0];
    }

    it('moveLogs re-dates only eaten_at: macros, name and product_id kept, no product upsert', async () => {
        const { window } = env;
        const group = await seedLunchAndPhoto(window);
        const rice = group.logs.find((l) => l.name === 'Rice');
        const productsBefore = await window.apiCall('/api/food/products');
        const target = new Date(atTime(yesterday, 13, 5)).toISOString();

        const res = await window.apiCall('/api/food/log/move', 'POST', { ids: [rice.id], eaten_at: target });

        expect(res).toHaveLength(1);
        const moved = (await logsOn(window, yesterday)).find((l) => l.id === rice.id);
        expect(moved).toEqual({ ...rice, eaten_at: target });
        expect(await window.apiCall('/api/food/products')).toEqual(productsBefore);
        expect((await logsOn(window, today)).map((l) => l.name).sort()).toEqual(['Bread', 'Chicken', 'Salad', 'Soup']);
    });

    it('an unknown id moves nothing; an unparseable eaten_at is rejected', async () => {
        allowConsoleNoise(); // apiCall console.errors the swallowed not_found
        const { window } = env;
        const group = await seedLunchAndPhoto(window);
        const rice = group.logs.find((l) => l.name === 'Rice');
        const target = new Date(atTime(yesterday, 13, 5)).toISOString();

        expect(await window.apiCall('/api/food/log/move', 'POST', { ids: [rice.id, 'foodlog_nope'], eaten_at: target })).toBeNull();
        await expect(window.apiCall('/api/food/log/move', 'POST', { ids: [rice.id], eaten_at: 'nonsense' }))
            .rejects.toMatchObject({ code: 'invalid_request' });
        expect(await logsOn(window, yesterday)).toEqual([]);
    });

    it('the sheet pre-checks only the newest batch and moves it to yesterday as one group', async () => {
        const { window, document } = env;
        const group = await seedLunchAndPhoto(window);
        const optimistic = [];
        const realApply = window.DataStore.applyOptimistic.bind(window.DataStore);
        window.DataStore.applyOptimistic = async (key, mutator, tags) => {
            optimistic.push({ key, mutator });
            return realApply(key, mutator, tags);
        };

        const done = window.FoodLog.openMove(group);
        const boxes = [...document.querySelectorAll('.wg-food-move__box')];
        const checkedNames = boxes.filter((b) => b.checked)
            .map((b) => group.logs.find((l) => String(l.id) === b.value).name).sort();
        expect(checkedNames).toEqual(['Chicken', 'Rice', 'Salad']);
        expect(document.querySelector('.wg-food-move__time').value).toBe('13:05');

        document.querySelector('.wg-food-move__chip[data-days-ago="1"]').click();
        expect(document.querySelector('.wg-food-move__date').value).toBe(yesterday);
        document.querySelector('.mt-confirm-modal__confirm').click();
        await done;

        const moved = await window.apiCall(`/api/food/log?date=${yesterday}&days=1`);
        expect(moved).toHaveLength(1);
        expect(moved[0].logs.map((l) => l.name).sort()).toEqual(['Chicken', 'Rice', 'Salad']);
        expect(moved[0].calories).toBe(260 + 220 + 100);
        expect((await logsOn(window, today)).map((l) => l.name).sort()).toEqual(['Bread', 'Soup']);
        expect(window.safeToast).toHaveBeenCalledWith('Moved 3 items to Yesterday');

        // Optimistic projection touched both days' v2 caches.
        const keys = optimistic.map((o) => o.key);
        expect(keys).toEqual(expect.arrayContaining([`food_${today}_v2`, `food_${yesterday}_v2`]));
        const todayNext = optimistic.find((o) => o.key === `food_${today}_v2`).mutator({ groups: [group], weekStats: null });
        expect(todayNext.groups.flatMap((g) => g.logs).map((l) => l.name).sort()).toEqual(['Bread', 'Soup']);
        const yNext = optimistic.find((o) => o.key === `food_${yesterday}_v2`).mutator(null);
        expect(yNext.groups).toHaveLength(1);
        expect(yNext.groups[0].calories).toBe(580);
    });

    it('Move is disabled with nothing checked; select-all toggles every row', async () => {
        const { window, document } = env;
        const group = await seedLunchAndPhoto(window);

        const done = window.FoodLog.openMove(group);
        const all = document.querySelector('.wg-food-move__all-box');
        const move = document.querySelector('.mt-confirm-modal__confirm');
        all.click();
        expect([...document.querySelectorAll('.wg-food-move__box')].every((b) => b.checked)).toBe(true);
        all.click();
        expect(move.disabled).toBe(true);
        document.querySelector('.mt-confirm-modal__cancel').click();
        expect(await done).toBeNull();
        expect(await logsOn(window, yesterday)).toEqual([]);
    });

    it('a failed move rolls back every optimistic cache', async () => {
        allowConsoleNoise(); // apiCall console.errors the swallowed not_found
        const { window, document } = env;
        const group = await seedLunchAndPhoto(window);
        const ghost = { ...group, logs: [...group.logs, { ...group.logs[0], id: 'foodlog_ghost', eaten_at: group.logs[4].eaten_at }] };
        const rollbacks = [];
        const realApply = window.DataStore.applyOptimistic.bind(window.DataStore);
        window.DataStore.applyOptimistic = async (key, mutator, tags) => {
            const h = await realApply(key, mutator, tags);
            const rb = vi.fn(() => h.rollback());
            rollbacks.push(rb);
            return { ...h, rollback: rb };
        };

        const done = window.FoodLog.openMove(ghost);
        document.querySelector('.wg-food-move__chip[data-days-ago="1"]').click();
        document.querySelector('.mt-confirm-modal__confirm').click();
        expect(await done).toBeNull();

        expect(rollbacks.length).toBeGreaterThan(0);
        rollbacks.forEach((rb) => expect(rb).toHaveBeenCalled());
        expect(await logsOn(window, yesterday)).toEqual([]);
    });
});

// bd med-0sgs.1 — per-day "tracking incomplete" flag over the shim routes.
describe('cloud shim contract — incomplete-day flag (med-0sgs.1)', () => {
    let env;
    const today = localDateStr();
    const yesterday = localDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000));

    beforeEach(() => {
        env = loadCloudShimFrontendEnv();
        installApiCache(env.window);
    });

    afterEach(() => { env.cleanup(); });

    it('PUT /api/food/days/{date} flags an empty day; GET lists it and listGrouped carries the flag', async () => {
        const { window } = env;
        await createLog(window, { name: 'Oats', eaten_at: new Date(atTime(today, 8, 0)).toISOString(), weight: 50, carbs: 30, protein: 5, fat: 3, calories: 167 });

        expect(await window.apiCall(`/api/food/days/${yesterday}`, 'PUT', { incomplete: true }))
            .toEqual({ date: yesterday, incomplete: true });
        await window.apiCall(`/api/food/days/${today}`, 'PUT', { incomplete: true });

        expect(await window.apiCall(`/api/food/days?date=${today}&days=2`)).toEqual([
            { date: yesterday, incomplete: true },
            { date: today, incomplete: true },
        ]);
        expect((await window.apiCall(`/api/food/log?date=${today}&days=1`)).map((g) => g.incomplete)).toEqual([true]);

        await window.apiCall(`/api/food/days/${today}`, 'PUT', { incomplete: false });
        expect((await window.apiCall(`/api/food/log?date=${today}&days=1`)).map((g) => g.incomplete)).toEqual([false]);
    });

    it('rejects a malformed date', async () => {
        allowConsoleNoise(); // apiCall console.errors the rejected write
        await expect(env.window.apiCall('/api/food/days/nope', 'PUT', { incomplete: true }))
            .rejects.toMatchObject({ code: 'invalid_request' });
    });
});

// bd med-0sgs.3 — Food screen UI for the flag: day toggle, badge, nudge chip.
describe('food screen — incomplete-day toggle + nudge chip (med-0sgs.3)', () => {
    let env;
    const daysAgo = (n) => localDateStr(new Date(Date.now() - n * 24 * 60 * 60 * 1000));
    const today = daysAgo(0);
    const yesterday = daysAgo(1);

    beforeEach(() => {
        env = loadCloudShimFrontendEnv();
        installApiCache(env.window);
        env.window.loadToday = vi.fn();
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
    });

    afterEach(() => { env.cleanup(); });

    const logOn = (window, day, calories) => createLog(window, {
        name: 'Meal', eaten_at: new Date(atTime(day, 12, 0)).toISOString(), weight: 100, carbs: 10, protein: 10, fat: 10, calories,
    });
    const nudge = (document) => document.getElementById('food-incomplete-nudge');
    const flagged = async (window, day) =>
        (await window.apiCall(`/api/food/days?date=${day}&days=1`))[0].incomplete;
    const openFood = async (window, document, day) => {
        document.getElementById('food-date-filter').value = day;
        await window.loadFoodLogs();
    };

    it('the toggle flags the selected day optimistically, shows the badge, and survives a reload', async () => {
        const { window, document } = env;
        await logOn(window, yesterday, 2000);
        await logOn(window, today, 1500);
        await openFood(window, document, today);

        const toggle = document.getElementById('food-incomplete-toggle');
        const badge = document.getElementById('food-incomplete-badge');
        expect(toggle.checked).toBe(false);
        expect(badge.classList.contains('hidden')).toBe(true);

        const keys = [];
        const realApply = window.DataStore.applyOptimistic.bind(window.DataStore);
        window.DataStore.applyOptimistic = async (key, mutator, tags) => {
            keys.push(key);
            return realApply(key, mutator, tags);
        };
        toggle.click();
        await vi.waitFor(async () => expect(await flagged(window, today)).toBe(true));
        expect(keys).toContain(`food_${today}_v2`);
        await vi.waitFor(() => expect(badge.classList.contains('hidden')).toBe(false));
        expect(document.getElementById('food-macros-card').classList.contains('wg-food-macros-card--excluded')).toBe(true);
        // A flagged day's logs stay visible.
        expect(document.querySelectorAll('#food-list .wg-food-item-row')).toHaveLength(1);

        // Reload: the flag comes back from the vault, not the in-memory DOM.
        toggle.checked = false;
        await window.DataStore.invalidateTags(['food']);
        await openFood(window, document, today);
        expect(toggle.checked).toBe(true);

        toggle.click();
        await vi.waitFor(async () => expect(await flagged(window, today)).toBe(false));
        await vi.waitFor(() => expect(badge.classList.contains('hidden')).toBe(true));
    });

    it('adding and deleting a log on a flagged day keeps the flag in the optimistic cache and on screen', async () => {
        const { window, document } = env;
        window.safeAlert = vi.fn();
        window.safeConfirm = async (_msg, cb) => { if (cb) await cb(true); return true; };
        const video = document.getElementById('food-scanner-video');
        if (video) { video.pause = vi.fn(); video.srcObject = null; }
        await logOn(window, today, 1500);
        await openFood(window, document, today);
        await window.FoodLog.setDayIncomplete(today, true);

        const projected = [];
        const realApply = window.DataStore.applyOptimistic.bind(window.DataStore);
        window.DataStore.applyOptimistic = async (key, mutator, tags) => {
            if (key === `food_${today}_v2`) projected.push(mutator(await window.DataStore.getCached(key)));
            return realApply(key, mutator, tags);
        };

        // The write handlers fire-and-forget loadFoodLogs; stub it so no reload
        // outlives the test, and reload explicitly (repopulating the v2 row).
        const realLoad = window.loadFoodLogs;
        window.loadFoodLogs = vi.fn();

        fillFoodLogForm(document, { name: 'Apple', dateStr: atTime(today, 8, 0), weight: 180, carbs: 25, protein: 0, fat: 0, calories: 95 });
        await window.FoodLog.save();
        await realLoad();
        const apple = (await window.apiCall(`/api/food/log?date=${today}&days=1`))
            .flatMap((g) => g.logs).find((l) => l.name === 'Apple');
        await window.FoodLog.delete(apple.id);
        await realLoad();

        const rows = projected.filter(Boolean);
        expect(rows.length).toBeGreaterThanOrEqual(2);
        rows.forEach((row) => expect(row.incomplete).toBe(true));
        expect(document.getElementById('food-incomplete-toggle').checked).toBe(true);
        expect(document.getElementById('food-incomplete-badge').classList.contains('hidden')).toBe(false);
    });

    it('nudges about an empty yesterday; one tap flags it and the chip goes away', async () => {
        const { window, document } = env;
        await logOn(window, today, 500);
        await logOn(window, daysAgo(2), 2000);
        await logOn(window, daysAgo(3), 2000);
        await openFood(window, document, today);

        expect(nudge(document).classList.contains('hidden')).toBe(false);
        expect(nudge(document).dataset.date).toBe(yesterday);
        expect(document.getElementById('food-incomplete-nudge-btn').textContent).toContain('Yesterday');

        document.getElementById('food-incomplete-nudge-btn').click();
        // Flagging yesterday must not paint today's (displayed) day as excluded.
        expect(document.getElementById('food-incomplete-toggle').checked).toBe(false);
        await vi.waitFor(async () => expect(await flagged(window, yesterday)).toBe(true));
        await openFood(window, document, today);
        expect(nudge(document).classList.contains('hidden')).toBe(true);
        expect(document.getElementById('food-incomplete-toggle').checked).toBe(false);
    });

    it('nudges about a suspiciously low day (< 800 kcal without a target), not a full one', async () => {
        const { window, document } = env;
        await logOn(window, yesterday, 600);
        await logOn(window, daysAgo(2), 2000);
        await logOn(window, daysAgo(3), 2000);
        await openFood(window, document, today);
        expect(nudge(document).classList.contains('hidden')).toBe(false);
        expect(nudge(document).dataset.date).toBe(yesterday);

        await logOn(window, yesterday, 900);
        await openFood(window, document, today);
        expect(nudge(document).classList.contains('hidden')).toBe(true);
    });

    it('dismiss hides the chip for that date only and flags nothing', async () => {
        const { window, document } = env;
        await logOn(window, daysAgo(2), 2000);
        await logOn(window, daysAgo(3), 2000);
        await openFood(window, document, today);
        expect(nudge(document).dataset.date).toBe(yesterday);

        document.getElementById('food-incomplete-nudge-dismiss').click();
        expect(nudge(document).classList.contains('hidden')).toBe(true);
        await openFood(window, document, today);
        expect(nudge(document).classList.contains('hidden')).toBe(true);
        expect(await flagged(window, yesterday)).toBe(false);
    });
});
