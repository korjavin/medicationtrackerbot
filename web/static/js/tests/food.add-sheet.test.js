// Food Add sheet (kit F4–F5, med-xso6.17): one .wg-sheet behind every Add
// (Food app bar, Today's Log food, empty-day shortcuts) with search, the
// Scan / Photo / Describe tiles and a Recent list. Recent re-logs in one
// write; a search pick shows portion picks and an "Add <g> g · <kcal> kcal"
// primary; a scanned barcode with no match falls back to the manual form.
// The Photo / Describe review flow is covered by food.ai-mode.test.js.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

async function settle(n = 5) {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

const RECENT_GROUPS = [
    {
        name: 'Breakfast',
        logs: [
            { id: 'l1', name: 'Greek yogurt', product_id: 'p-yog', weight: 170, carbs: 7, protein: 17, fat: 0, calories: 98, eaten_at: '2026-10-08T08:00:00Z' },
            { id: 'l2', name: 'Greek yogurt', product_id: 'p-yog', weight: 120, carbs: 5, protein: 12, fat: 0, calories: 68, eaten_at: '2026-10-07T08:00:00Z' },
            { id: 'l3', name: 'Banana', weight: 120, carbs: 27, protein: 1, fat: 0, calories: 112, eaten_at: '2026-10-08T07:00:00Z' },
        ],
    },
];

describe('Food Add sheet', () => {
    let env;
    let apiCall;

    beforeEach(() => {
        allowConsoleNoise();
        env = loadFrontendEnv();
        const { window } = env;
        apiCall = vi.fn(async (url, method) => {
            if ((method || 'GET') === 'GET' && String(url).startsWith('/api/food/log?')) return RECENT_GROUPS;
            if (method === 'POST') return { id: 'new-log' };
            return null;
        });
        window.apiCall = apiCall;
        window.loadFoodLogs = vi.fn();
        window.initFoodProductsCache = vi.fn().mockResolvedValue(undefined);
        window.safeToast = vi.fn();
        window.CloudFoodSearch = {
            search: vi.fn(async () => []),
            remoteConfigured: vi.fn(async () => false),
        };
        const video = env.document.getElementById('food-scanner-video');
        if (video) {
            video.pause = vi.fn();
            video.srcObject = null;
        }
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    const posts = () => apiCall.mock.calls.filter(([, m]) => m === 'POST');
    const sheet = () => env.document.getElementById('food-add-sheet');

    it('Add opens one .wg-sheet with search, Scan / Photo / Describe tiles and a Recent list', async () => {
        const { window, document } = env;
        window.showAddFoodModal();
        await settle();

        expect(sheet().classList.contains('hidden')).toBe(false);
        expect(sheet().classList.contains('wg-sheet')).toBe(true);
        expect(document.querySelectorAll('mt-modal.wg-sheet:not(.hidden)')).toHaveLength(1);
        expect(document.getElementById('food-add-search')).not.toBeNull();
        const tiles = Array.from(document.querySelectorAll('#food-add-tiles .wg-action .wg-action__label')).map((n) => n.textContent);
        expect(tiles).toEqual(['Scan', 'Photo', 'Gallery', 'Describe']);

        // Recent: newest first, one row per product (the older yogurt dedupes).
        expect(document.getElementById('food-add-recent-section').classList.contains('hidden')).toBe(false);
        const titles = Array.from(document.querySelectorAll('#food-add-recent .wg-row__title')).map((n) => n.textContent);
        expect(titles).toEqual(['Greek yogurt', 'Banana']);
        expect(document.querySelector('#food-add-recent .wg-row__meta').textContent).toContain('170 g · 98 kcal');
    });

    it('a Recent + tap logs that food with its last portion in exactly one write, then closes', async () => {
        const { window, document } = env;
        window.FoodLog.addSheet.open();
        await settle();

        document.querySelector('#food-add-recent button[aria-label="Add Greek yogurt 170 g"]').click();
        await settle(10);

        expect(posts()).toHaveLength(1);
        expect(posts()[0][0]).toBe('/api/food/log');
        expect(posts()[0][2]).toEqual(expect.objectContaining({
            name: 'Greek yogurt', product_id: 'p-yog', weight: 170, calories: 98, per_100g: false,
        }));
        expect(sheet().classList.contains('hidden')).toBe(true);
        expect(window.safeToast).toHaveBeenCalledWith(expect.stringContaining('Greek yogurt'), 'success');
    });

    it('search shows results in the sheet; a pick shows portion picks and an "Add <g> g · <kcal> kcal" primary that writes once', async () => {
        const { window, document } = env;
        window.CloudFoodSearch.search = vi.fn(async () => [
            { id: 'p-oat', name: 'Oat flakes', carbs_100g: 60, protein_100g: 12, fat_100g: 7, energy_kcal_100g: 360 },
        ]);
        window.FoodLog.addSheet.open();
        await settle();

        document.getElementById('food-add-search').value = 'oat';
        await window.FoodLog.addSheet.runSearch('oat', false);
        const results = document.getElementById('food-add-results');
        expect(results.classList.contains('hidden')).toBe(false);
        expect(document.getElementById('food-add-recent-section').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('food-add-foot').classList.contains('hidden')).toBe(true);

        results.querySelector('button.wg-food-add__result').click();
        const picks = Array.from(results.querySelectorAll('.wg-food-add__portions .wg-pick')).map((b) => b.dataset.grams);
        expect(picks).toEqual(['100', '150', '200', 'other']);
        const primary = document.getElementById('food-add-primary-btn');
        expect(document.getElementById('food-add-foot').classList.contains('hidden')).toBe(false);
        expect(primary.textContent).toBe('Add 100 g · 360 kcal');

        results.querySelector('.wg-pick[data-grams="150"]').click();
        expect(primary.textContent).toBe('Add 150 g · 540 kcal');

        primary.click();
        await settle(10);

        expect(posts()).toHaveLength(1);
        expect(posts()[0][2]).toEqual(expect.objectContaining({
            name: 'Oat flakes', product_id: 'p-oat', weight: 150, carbs: 90, protein: 18, fat: 11, calories: 540,
        }));
        expect(sheet().classList.contains('hidden')).toBe(true);
    });

    it('the search field is pinned above the scrolling body; typing hides the tiles, clearing brings them back; off-home views hide the search', async () => {
        const { window, document } = env;
        window.CloudFoodSearch.search = vi.fn(async () => Array.from({ length: 35 }, (_, i) => ({
            id: `p-${i}`, name: `Oat product ${i}`, carbs_100g: 60, protein_100g: 12, fat_100g: 7, energy_kcal_100g: 360,
        })));
        window.FoodLog.addSheet.open();
        await settle();

        const search = document.getElementById('food-add-search');
        const bar = document.getElementById('food-add-search-bar');
        const body = sheet().querySelector('.wg-sheet__body');
        expect(body.contains(search)).toBe(false);
        expect(bar.contains(search)).toBe(true);
        expect(bar.compareDocumentPosition(body) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(bar.previousElementSibling.tagName).toBe('HEADER');

        const tiles = document.getElementById('food-add-tiles');
        const recent = document.getElementById('food-add-recent-section');
        expect(tiles.classList.contains('hidden')).toBe(false);
        expect(recent.classList.contains('hidden')).toBe(false);

        search.value = 'oat';
        await window.FoodLog.addSheet.runSearch('oat', false);
        expect(document.querySelectorAll('#food-add-results .wg-food-add__result').length).toBeLessThanOrEqual(30);
        expect(document.querySelectorAll('#food-add-results .wg-food-add__result').length).toBeGreaterThan(0);
        expect(tiles.classList.contains('hidden')).toBe(true);
        expect(recent.classList.contains('hidden')).toBe(true);

        search.value = '';
        search.dispatchEvent(new window.Event('input', { bubbles: true }));
        expect(tiles.classList.contains('hidden')).toBe(false);
        expect(recent.classList.contains('hidden')).toBe(false);

        search.value = 'oat';
        window.FoodLog.addSheet.openDescribe();
        expect(bar.classList.contains('hidden')).toBe(true);
        window.FoodLog.addSheet.back();
        expect(bar.classList.contains('hidden')).toBe(false);
        expect(search.value).toBe('oat');
    });

    it('typing with the iOS keyboard up docks the sheet to the visual viewport, so header + search stay in view (med-pe9g)', async () => {
        const { window, document } = env;
        window.FoodLog.addSheet.open();
        await settle();
        const root = document.documentElement;
        // iOS: the layout viewport keeps 800px under a 336px keyboard, and
        // scrolling pans the visual viewport 150px down over it.
        Object.defineProperty(root, 'clientHeight', { value: 800, configurable: true });
        Object.defineProperty(window, 'innerHeight', { value: 464, configurable: true, writable: true });
        Object.defineProperty(window, 'visualViewport', {
            value: { height: 464, offsetTop: 150, scale: 1 }, configurable: true, writable: true,
        });
        window.WGSheet.dock();

        // The sheet's CSS top is --wg-vv-top + --wg-vv-h lifted by its own
        // height, max-height --wg-vv-h minus a gap: it spans 150..614 at most.
        expect(root.style.getPropertyValue('--wg-vv-top')).toBe('150px');
        expect(root.style.getPropertyValue('--wg-vv-h')).toBe('464px');
        expect(sheet().classList.contains('wg-scrim--kb')).toBe(true);
        // Only the results scroll: header and search sit outside .wg-sheet__body.
        const body = sheet().querySelector('.wg-sheet__body');
        expect(body.contains(document.getElementById('food-add-results'))).toBe(true);
        expect(body.contains(document.getElementById('food-add-search'))).toBe(false);
        expect(body.contains(sheet().querySelector('.wg-sheethead'))).toBe(false);
    });

    it('a scanned barcode with no match opens the manual form prefilled with it', async () => {
        const { window, document } = env;
        window.FoodLog.addSheet.open();
        await settle();

        // The scanner (opened from the Scan tile) hands the decode to the sheet.
        expect(window.handleDecodedValue('4600000000001')).toBe(true);
        await settle(10);

        expect(sheet().classList.contains('hidden')).toBe(true);
        expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('food-barcode').value).toBe('4600000000001');
        expect(document.getElementById('food-modal-more').open).toBe(true);
        expect(posts()).toHaveLength(0);
        // No food database to ask: the miss says why, not "No product found".
        expect(window.safeToast).toHaveBeenCalledWith('Barcode lookup needs the food database, which isn’t available right now.', 'info');
    });

    it('a miss with a food database configured keeps "No product found"; a remoteHint replaces the not-configured copy', async () => {
        const { window } = env;
        window.CloudFoodSearch.remoteConfigured = vi.fn(async () => true);
        window.FoodLog.addSheet.open();
        await settle();
        window.handleDecodedValue('4600000000002');
        await settle(10);
        expect(window.safeToast).toHaveBeenCalledWith('No product found for that barcode. Enter it once and it will be found next time.', 'info');

        window.CloudFoodSearch.remoteConfigured = vi.fn(async () => false);
        window.CloudFoodSearch.remoteHint = vi.fn(async () => 'Food lookups paused until tomorrow.');
        window.FoodLog.addSheet.open();
        await settle();
        await window.FoodLog.addSheet.runSearch('oats', true);
        expect(env.document.getElementById('food-add-search-status').textContent).toBe('Food lookups paused until tomorrow.');
    });

    describe('a scanned staple you already have (kit FC1, med-5jq.7)', () => {
        const SCANNED = { name: 'Broccoli - K-Classic - 450 g', barcode: '4600000000116', carbs_100g: 3, protein_100g: 3, fat_100g: 0, energy_kcal_100g: 28 };
        const MINE = { id: 'p-broc', name: 'Broccoli', carbs_100g: 7, protein_100g: 3, fat_100g: 0, energy_kcal_100g: 34 };
        const scan = async (mine) => {
            const { window } = env;
            window.CloudFoodSearch.remoteConfigured = vi.fn(async () => true);
            window.CloudFoodSearch.search = vi.fn(async (q, o) => (o && o.remote ? [{ ...SCANNED }] : []));
            window.CloudFoodSearch.stapleOffer = vi.fn(async () => mine);
            window.FoodLog.addSheet.open();
            await settle();
            window.handleDecodedValue(SCANNED.barcode);
            await settle(10);
        };
        const choices = () => Array.from(env.document.querySelectorAll('#food-add-offer-choices .wg-choice'));

        it('two choices replace the picked row, your food preselected; logging links the barcode to it', async () => {
            const { window, document } = env;
            await scan({ ...MINE });
            expect(window.CloudFoodSearch.stapleOffer).toHaveBeenCalledWith(SCANNED.name, SCANNED.barcode);
            expect(document.getElementById('food-add-offer').classList.contains('hidden')).toBe(false);
            expect(document.querySelector('#food-add-offer .wg-section__head').textContent).toBe('Scannedlog it as');
            expect(document.getElementById('food-add-results').classList.contains('hidden')).toBe(true);
            expect(choices().map((c) => c.textContent)).toEqual([
                'BroccoliYour food · 34 kcal / 100 g', 'Broccoli - K-Classic - 450 gNew food · 28 kcal / 100 g',
            ]);
            expect(choices().map((c) => c.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
            const primary = document.getElementById('food-add-primary-btn');
            document.querySelector('#food-add-offer-portions .wg-pick[data-grams="150"]').click();
            expect(primary.textContent).toBe('Add 150 g · 51 kcal');

            primary.click();
            await settle(10);
            expect(posts()).toHaveLength(1);
            expect(posts()[0][2]).toEqual(expect.objectContaining({
                name: 'Broccoli', product_id: 'p-broc', barcode: SCANNED.barcode, scanned_name: SCANNED.name, weight: 150,
            }));
        });

        it('"New food" logs the scanned product as a first scan; portions and the primary follow it', async () => {
            const { document } = env;
            await scan({ ...MINE });
            choices()[1].click();
            expect(choices().map((c) => c.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
            const primary = document.getElementById('food-add-primary-btn');
            expect(primary.textContent).toBe('Add 100 g · 28 kcal');

            primary.click();
            await settle(10);
            expect(posts()).toHaveLength(1);
            const payload = posts()[0][2];
            expect(payload).toEqual(expect.objectContaining({ name: SCANNED.name, barcode: SCANNED.barcode, weight: 100 }));
            expect(payload.product_id).toBeUndefined();
            expect(payload.scanned_name).toBeUndefined();
        });

        it('a text scan after an offer drops it: its results show and the old primary goes (Argus 16177)', async () => {
            const { window, document } = env;
            await scan({ ...MINE });
            window.CloudFoodSearch.search = vi.fn(async () => [{ id: 'p-milk', name: 'Milk', energy_kcal_100g: 64 }]);
            window.FoodLog.addSheet.onScan('Milk', '');
            await settle(10);
            expect(document.getElementById('food-add-offer').classList.contains('hidden')).toBe(true);
            expect(Array.from(document.querySelectorAll('#food-add-results .wg-food-add__result .wg-row__title')).map((n) => n.textContent)).toEqual(['Milk']);
            expect(document.getElementById('food-add-foot').classList.contains('hidden')).toBe(true);
        });

        it('no offer (a branded product, no match) → the single picked row as before', async () => {
            const { document } = env;
            await scan(null);
            expect(document.getElementById('food-add-offer').classList.contains('hidden')).toBe(true);
            expect(document.querySelectorAll('#food-add-results .wg-food-add__result')).toHaveLength(1);
            expect(document.getElementById('food-add-primary-btn').textContent).toBe('Add 100 g · 28 kcal');
        });
    });

    it('Esc closes the sheet', async () => {
        const { window } = env;
        window.FoodLog.addSheet.open();
        await settle();
        expect(sheet().classList.contains('hidden')).toBe(false);

        const e = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        window.document.body.dispatchEvent(e);

        expect(sheet().classList.contains('hidden')).toBe(true);
        expect(window.FoodLog.addSheet.isOpen()).toBe(false);
    });

    it('the time chip reveals its input when there is no programmatic picker, and re-hides it on the next open', async () => {
        const { window, document } = env;
        window.FoodLog.addSheet.open();
        await settle();
        const input = document.getElementById('food-add-datetime');
        input.showPicker = undefined;

        document.getElementById('food-add-time-btn').click();
        expect(input.classList.contains('hidden')).toBe(false);
        expect(input.value).not.toBe('');

        window.FoodLog.addSheet.close();
        window.FoodLog.addSheet.open();
        await settle();
        expect(input.classList.contains('hidden')).toBe(true);
    });

    // One Log sheet (kit LS1–LS4, med-aa18.4): Today's Log opens this sheet
    // with the other kinds (today.js logKinds, covered by today.render.test.js).
    describe('One Log sheet', () => {
        const asNeeded = JSON.stringify({ type: 'as_needed' });
        const MEDS = [
            { id: 2, name: 'Paracetamol', dosage: '500 mg', schedule: asNeeded, inventory_count: 20, archived: false, created_at: new Date().toISOString() },
            { id: 1, name: 'Ibuprofen', dosage: '400 mg', schedule: asNeeded, inventory_count: 12, archived: false, last_taken_at: new Date(Date.now() - 3600e3).toISOString() },
            { id: 3, name: 'Metformin', dosage: '850 mg', schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }), archived: false },
            { id: 4, name: 'Cetirizine', dosage: '10 mg', schedule: asNeeded, archived: true },
        ];
        const fromToday = (extra) => {
            const runs = { bp: vi.fn(), weight: vi.fn(), note: vi.fn() };
            const kinds = [
                { id: 'bp', icon: 'activity', label: 'BP', run: runs.bp },
                { id: 'weight', icon: 'scale', label: 'Weight', run: runs.weight },
                { id: 'med', icon: 'pill', label: 'Med' },
                { id: 'note', icon: 'note', label: 'Note', run: runs.note },
            ];
            env.window.showAddFoodModal({ from: 'today', food: true, kinds, view: 'home', ...extra });
            return runs;
        };
        const title = () => env.document.getElementById('food-add-title').textContent;
        const hidden = (id) => env.document.getElementById(id).classList.contains('hidden');
        const also = () => Array.from(env.document.querySelectorAll('#food-add-also-row [data-log]')).map((b) => b.textContent);

        beforeEach(() => {
            env.window.medications = MEDS.map((m) => ({ ...m }));
        });

        it('LS1: from Today it is titled "Log" with an Also log row under the food paths, above Recent', async () => {
            const { document } = env;
            fromToday();
            await settle();
            expect(title()).toBe('Log');
            expect(hidden('food-add-also')).toBe(false);
            expect(also()).toEqual(['BP', 'Weight', 'Med', 'Note']);
            expect(document.querySelectorAll('#food-add-also-row .wg-btn.wg-btn--sm')).toHaveLength(4);
            const pane = Array.from(document.querySelector('[data-pane="home"]').children).map((n) => n.id);
            expect(pane.indexOf('food-add-tiles')).toBeLessThan(pane.indexOf('food-add-also'));
            expect(pane.indexOf('food-add-also')).toBeLessThan(pane.indexOf('food-add-recent-section'));
            expect(hidden('food-add-search-bar')).toBe(false);
            expect(hidden('food-add-time-btn')).toBe(false);
            expect(hidden('food-add-recent-section')).toBe(false);
        });

        it('each Also log button closes the sheet and runs its opener', async () => {
            const { document } = env;
            for (const id of ['bp', 'weight', 'note']) {
                const runs = fromToday();
                await settle();
                document.querySelector(`#food-add-also-row [data-log="${id}"]`).click();
                expect(sheet().classList.contains('hidden')).toBe(true);
                expect(runs[id]).toHaveBeenCalledTimes(1);
            }
        });

        it("LS4: Food's + has no row and keeps \"Log food\", even after a Today open", async () => {
            const { window, document } = env;
            fromToday();
            await settle();
            window.FoodLog.addSheet.close();
            document.getElementById('add-food-inline-btn').click();
            await settle();
            expect(sheet().classList.contains('hidden')).toBe(false);
            expect(title()).toBe('Log food');
            expect(hidden('food-add-also')).toBe(true);
            expect(document.querySelectorAll('#food-add-also-row [data-log]')).toHaveLength(0);
        });

        it('LS3: Food off → the kinds are the tiles; no search, food tiles, Recent, manual entry or time chip', async () => {
            const { document } = env;
            fromToday({ food: false });
            await settle();
            expect(title()).toBe('Log');
            expect(document.getElementById('food-add-eyebrow').textContent).toMatch(/^Now · \d\d:\d\d$/);
            const tiles = Array.from(document.querySelectorAll('#food-add-kinds .wg-action .wg-action__label')).map((n) => n.textContent);
            expect(tiles).toEqual(['BP', 'Weight', 'Med', 'Note']);
            expect(document.getElementById('food-add-kinds').classList.contains('wg-actions--4')).toBe(true);
            for (const id of ['food-add-search-bar', 'food-add-tiles', 'food-add-recent-section', 'food-add-manual-btn', 'food-add-time-btn', 'food-add-also']) {
                expect(hidden(id), id).toBe(true);
            }
            expect(apiCall.mock.calls.some(([url]) => String(url).startsWith('/api/food/log?'))).toBe(false);
        });

        it('LS2: Med lists only the When needed group, in My meds order, with stock and last dose', async () => {
            const { document } = env;
            fromToday();
            await settle();
            document.querySelector('#food-add-also-row [data-log="med"]').click();
            expect(sheet().classList.contains('hidden')).toBe(false);
            expect(title()).toBe('Log a med');
            expect(document.getElementById('food-add-eyebrow').textContent).toBe('When needed');
            expect(hidden('food-add-back-btn')).toBe(false);
            expect(document.getElementById('food-add-back-label').textContent).toBe('Log');
            expect(hidden('food-add-search-bar')).toBe(true);
            expect(hidden('food-add-time-btn')).toBe(true);
            const rows = Array.from(document.querySelectorAll('#food-add-med-list .wg-row'));
            expect(rows.map((r) => r.querySelector('.wg-row__title').textContent)).toEqual(['Ibuprofen · 400 mg', 'Paracetamol · 500 mg']);
            expect(rows[0].querySelector('.wg-row__meta').textContent).toMatch(/^12 left · last \d\d:\d\d$/);
            expect(rows[1].querySelector('.wg-row__meta').textContent).toBe('20 left');

            document.getElementById('food-add-back-btn').click();
            expect(title()).toBe('Log');
            expect(hidden('food-add-also')).toBe(false);
        });

        it('LS2 Take: one log-past write at now, the sheet closed first, toast with the re-read count; no Undo', async () => {
            const { window, document } = env;
            let openAtPost = null;
            apiCall.mockImplementation(async (url, method) => {
                if (url === '/api/medications/log-past' && method === 'POST') {
                    openAtPost = !sheet().classList.contains('hidden');
                    return { id: 'intake-manual-1', status: 'TAKEN' };
                }
                if (String(url).startsWith('/api/medications')) {
                    return MEDS.map((m) => (m.id === 1 ? { ...m, inventory_count: 11, last_taken_at: new Date().toISOString() } : m));
                }
                if (String(url).startsWith('/api/food/log?')) return RECENT_GROUPS;
                return null;
            });
            fromToday();
            await settle();
            document.querySelector('#food-add-also-row [data-log="med"]').click();
            const before = Date.now();
            document.querySelector('#food-add-med-list .wg-row[data-med-id="1"] .wg-btn').click();
            await vi.waitFor(() => expect(window.safeToast).toHaveBeenCalledWith('Ibuprofen taken', 'success', expect.any(Object)));

            const writes = apiCall.mock.calls.filter(([u, m]) => u === '/api/medications/log-past' && m === 'POST');
            expect(writes).toHaveLength(1);
            expect(writes[0][2].medication_id).toBe(1);
            expect(Math.abs(Date.parse(writes[0][2].taken_at) - before)).toBeLessThan(5000);
            expect(openAtPost).toBe(false);
            const opts = window.safeToast.mock.calls.find(([m]) => m === 'Ibuprofen taken')[2];
            expect(opts.detail).toMatch(/^Logged \d\d:\d\d · 11 left$/);
            expect(opts.action).toBeUndefined();
            expect(opts.actions).toBeUndefined();
            expect(apiCall.mock.calls.some(([u]) => String(u).startsWith('/api/doses/act'))).toBe(false);
        });

        it('LS2 row tap → the log_past sheet for another time', async () => {
            const { window, document } = env;
            window.logMedicationPast = vi.fn();
            fromToday();
            await settle();
            document.querySelector('#food-add-also-row [data-log="med"]').click();
            document.querySelector('#food-add-med-list .wg-row[data-med-id="2"] .wg-row__title').click();
            expect(sheet().classList.contains('hidden')).toBe(true);
            expect(window.logMedicationPast).toHaveBeenCalledWith(2, 'Paracetamol');
            expect(apiCall.mock.calls.some(([, m]) => m === 'POST')).toBe(false);
        });

        it('Food off with Med the one kind: the Med pane is the sheet, no Back', async () => {
            fromToday({ food: false, kinds: [{ id: 'med', icon: 'pill', label: 'Med' }], view: 'med' });
            await settle();
            expect(title()).toBe('Log a med');
            expect(hidden('food-add-back-btn')).toBe(true);
            expect(env.document.querySelectorAll('#food-add-med-list .wg-row')).toHaveLength(2);
        });
    });
});
