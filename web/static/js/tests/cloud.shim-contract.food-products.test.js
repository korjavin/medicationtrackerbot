// Plan 2026-07-06 cloud-c2c, Task 6 — shim-mode contract run of the food
// products flows (features/food/{products,db}.js) against web/domain/food.js
// + the browser food-DB client (web/cloud/js/fooddb.js). Drives the real
// feature code through window.apiCall (core/api.js), which delegates to the
// cloud shim (web/cloud/js/apishim.js) instead of the network — same pattern
// as cloud.shim-contract.meds.test.js. Divergences here are contract bugs in
// the JS domain layer, not test bugs; the original (network-mocked)
// food.*.test.js files keep running unshimmed.
//
// fooddb.js's search()/barcode path is a real ES module (not a classic
// script injected into env.window), so its bare `fetch`/`document` calls
// resolve against THIS test file's own realm (vitest runs with
// environment: 'node', see vitest.config.mjs) rather than env.window's
// separate JSDOM instance. `document` isn't a Node global, so remote-search
// tests stub it from env.window (which does have a real DOM) for the
// duration of the test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryRecordsPort, loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';
import { createFoodDomain } from '../../../domain/food.js';

function installApiCache(window, seed = {}) {
    const map = new Map(Object.entries(seed));
    window.MedTrackerDB = {
        ...(window.MedTrackerDB || {}),
        ApiCache: {
            async get(key) { return map.has(key) ? map.get(key) : null; },
            async set(key, value) { map.set(key, value); },
            async clear(key) { map.delete(key); },
            async keys(prefix) {
                const all = [...map.keys()];
                return typeof prefix === 'string' && prefix
                    ? all.filter((k) => k.startsWith(prefix))
                    : all;
            }
        },
        // products.js/meals.js call these unconditionally whenever
        // window.MedTrackerDB is truthy — no-op stand-ins so
        // initFoodProductsCache() always refetches through the real shim
        // instead of touching a real IndexedDB-backed store.
        FoodProductsStore: {
            getCache: async () => null,
            saveCache: async () => undefined,
            clearCache: async () => undefined
        }
    };
    return map;
}

async function createLog(window, { name, eaten_at, weight, carbs, protein, fat, calories }) {
    return window.apiCall('/api/food/log', 'POST', {
        eaten_at, weight, carbs, protein, fat, calories, name, barcode: '', per_100g: false
    });
}

describe('cloud shim contract — food products flows (features/food/{products,db}.js over web/domain/food.js)', () => {
    let env;

    beforeEach(() => {
        env = loadCloudShimFrontendEnv();
        installApiCache(env.window);
        env.window.safeAlert = vi.fn();
        env.window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        env.cleanup();
        env = null;
    });

    it('loadFoodDB lists + sorts products created via named food logs', async () => {
        const { window, document } = env;
        await createLog(window, { name: 'Almond milk', eaten_at: new Date().toISOString(), weight: 250, carbs: 3, protein: 1, fat: 3, calories: 35 });
        await createLog(window, { name: 'Banana', eaten_at: new Date().toISOString(), weight: 120, carbs: 27, protein: 1, fat: 0, calories: 112 });

        window.FoodDB.sort = 'name';
        window.FoodDB.page = 0;
        await window.loadFoodDB();

        const cards = document.querySelectorAll('#fooddb-list .food-db-name');
        expect([...cards].map((el) => el.textContent)).toEqual(['Almond milk', 'Banana']);

        const byName = await window.apiCall('/api/food/products?sort=name&limit=100&offset=0&is_meal=false');
        expect(byName.products.map((p) => p.name)).toEqual(['Almond milk', 'Banana']);
    });

    it('saveFoodProduct edits a product created via a named food log; deleteFoodProduct removes it', async () => {
        const { window, document } = env;
        await createLog(window, { name: 'Oat bar', eaten_at: new Date().toISOString(), weight: 40, carbs: 20, protein: 4, fat: 5, calories: 143 });

        const before = await window.apiCall('/api/food/products?is_meal=false');
        const product = before.products.find((p) => p.name === 'Oat bar');
        expect(product).toBeDefined();

        document.getElementById('food-product-id').value = product.id;
        document.getElementById('food-product-name').value = 'Oat bar (updated)';
        document.getElementById('food-product-barcode').value = '';
        document.getElementById('food-product-carbs').value = '55';
        document.getElementById('food-product-protein').value = '10';
        document.getElementById('food-product-fat').value = '12';
        document.getElementById('food-product-calories').value = '400';
        document.getElementById('food-product-is-meal').value = 'false';
        document.getElementById('food-product-total-weight').value = '0';

        await window.saveFoodProduct();

        const afterEdit = await window.apiCall('/api/food/products?is_meal=false');
        const edited = afterEdit.products.find((p) => p.id === product.id);
        expect(edited).toMatchObject({
            name: 'Oat bar (updated)', carbs_100g: 55, protein_100g: 10, fat_100g: 12, energy_kcal_100g: 400
        });

        await window.deleteFoodProduct(product.id, 'Oat bar (updated)');
        const afterDelete = await window.apiCall('/api/food/products?is_meal=false');
        expect(afterDelete.products.find((p) => p.id === product.id)).toBeUndefined();
    });

    it('creates a meal from selected logs via POST /api/food/products/from-logs', async () => {
        const { window } = env;
        const log1 = await createLog(window, { name: 'Rice', eaten_at: new Date().toISOString(), weight: 200, carbs: 56, protein: 4, fat: 1, calories: 249 });
        const log2 = await createLog(window, { name: 'Chicken', eaten_at: new Date().toISOString(), weight: 150, carbs: 0, protein: 45, fat: 6, calories: 234 });

        const meal = await window.apiCall('/api/food/products/from-logs', 'POST', {
            name: 'Rice + chicken bowl', log_ids: [log1.id, log2.id]
        });

        expect(meal.is_meal).toBe(true);
        expect(meal.total_weight_g).toBe(350);
        // per-100g macros = summed totals scaled by 100/totalWeight.
        const mult = 100 / 350;
        expect(meal.carbs_100g).toBeCloseTo(56 * mult, 5);
        expect(meal.protein_100g).toBeCloseTo(49 * mult, 5);
        expect(meal.fat_100g).toBeCloseTo(7 * mult, 5);
    });

    // med-5jq.2: a product's name and per-100 g macros are the user's; logs
    // never rewrite them. create finds+touches or creates; update/move write none.
    describe('food logs never rewrite shared products (med-5jq.2)', () => {
        const products = async (window) => (await window.apiCall('/api/food/products?limit=100')).products;
        const eaten = () => new Date().toISOString();

        it('a new food creates exactly one product; a repeat log bumps usage once and keeps the macros', async () => {
            const { window } = env;
            await createLog(window, { name: 'Skyr', eaten_at: eaten(), weight: 200, carbs: 8, protein: 22, fat: 0, calories: 120 });
            const [created] = await products(window);
            expect(await products(window)).toHaveLength(1);
            expect(created).toMatchObject({ name: 'Skyr', usage_count: 1, protein_100g: 11, energy_kcal_100g: 60 });

            const second = await createLog(window, { name: 'Skyr', eaten_at: eaten(), weight: 100, carbs: 9, protein: 5, fat: 3, calories: 90 });
            const after = await products(window);
            expect(after).toHaveLength(1);
            expect(after[0]).toMatchObject({ id: created.id, usage_count: 2, protein_100g: 11, energy_kcal_100g: 60 });
            expect(second.product_id).toBe(created.id);
        });

        it('a log update with other macros, or a rename to an unknown name, leaves the products alone', async () => {
            const { window } = env;
            const log = await createLog(window, { name: 'Oat bar', eaten_at: eaten(), weight: 40, carbs: 20, protein: 4, fat: 5, calories: 143 });
            const [product] = await products(window);
            // The user's own edit of the product must stick through later log edits.
            await window.apiCall(`/api/food/products/${product.id}`, 'PUT', { ...product, carbs_100g: 60, energy_kcal_100g: 380 });
            const edited = (await products(window))[0];

            const body = { eaten_at: log.eaten_at, weight: 50, carbs: 40, protein: 9, fat: 9, calories: 280, name: 'Oat bar' };
            const updated = await window.apiCall(`/api/food/log/${log.id}`, 'PUT', body);
            expect(updated).toMatchObject({ carbs: 40, calories: 280, product_id: product.id });
            expect(await products(window)).toEqual([edited]);

            const renamed = await window.apiCall(`/api/food/log/${log.id}`, 'PUT', { ...body, name: 'Granola square' });
            expect(renamed.name).toBe('Granola square');
            expect(renamed.product_id).toBeUndefined();
            expect(await products(window)).toEqual([edited]);
        });

        // The usage touch lands on the CURRENT row: a product edit (or synced op)
        // that arrives while the log write is in flight survives it. Port-level,
        // since the shim cannot interleave two writes inside one request.
        it('a product edit landing during a product_id log create survives the usage touch', async () => {
            const records = createInMemoryRecordsPort();
            const food = createFoodDomain({ records, now: () => Date.now(), timeZone: 'UTC', foodDb: null });
            await food.create({ name: 'Lentils', weight: 100, carbs: 20, protein: 5, fat: 1, calories: 110 });
            const [product] = await food.listProducts().then((r) => r.products);
            const put = records.put.bind(records);
            records.put = async (type, record) => {
                const stored = await put(type, record);
                if (type === 'foodlog') await food.updateProduct(product.id, { ...product, protein_100g: 42 });
                return stored;
            };
            await food.create({ product_id: product.id, weight: 50, carbs: 10, protein: 3, fat: 0, calories: 55 });
            const [after] = (await food.listProducts()).products;
            expect(after).toMatchObject({ protein_100g: 42, usage_count: 2 });

            await food.removeProduct(product.id);
            records.put = put;
            await food.create({ name: 'Lentils', weight: 100, carbs: 20, protein: 5, fat: 1, calories: 110 });
            expect((await food.listProducts()).products).toHaveLength(1); // deleted stays deleted; a new one is created
        });

        it('moving three logs bumps no product', async () => {
            const { window } = env;
            const ids = [];
            for (const name of ['Rice', 'Chicken', 'Salad']) {
                ids.push((await createLog(window, { name, eaten_at: eaten(), weight: 100, carbs: 10, protein: 10, fat: 1, calories: 89 })).id);
            }
            const before = await products(window);
            await window.apiCall('/api/food/log/move', 'POST', { ids, eaten_at: new Date(Date.now() - 86400000).toISOString() });
            expect(await products(window)).toEqual(before);
        });
    });

    it('CloudFoodSearch.search: local-only finds a product created via a food log; remote merges a mocked food-DB response', async () => {        const { window } = env;
        env.window.__MEDTRACKER_CLOUD__ = true;
        vi.stubGlobal('document', window.document);

        await createLog(window, { name: 'Local Yogurt', eaten_at: new Date().toISOString(), weight: 150, carbs: 10, protein: 8, fat: 3, calories: 99 });

        const localOnly = await window.CloudFoodSearch.search('yogurt', { remote: false });
        expect(localOnly.map((p) => p.name)).toEqual(['Local Yogurt']);

        await window.apiCall('/api/settings/integrations', 'PATCH', {
            food: { url: 'https://fooddb.example.test', api_key: 'test-key' }
        });

        const fetchSpy = vi.fn().mockResolvedValue({
            ok: true,
            async json() {
                return { results: [{ name: 'Remote Yogurt', barcode: '', carbs: 12, protein: 9, fat: 2, kcal100g: 105 }] };
            }
        });
        vi.stubGlobal('fetch', fetchSpy);

        const merged = await window.CloudFoodSearch.search('yogurt', { remote: true });
        expect(merged.map((p) => p.name).sort()).toEqual(['Local Yogurt', 'Remote Yogurt']);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, opts] = fetchSpy.mock.calls[0];
        expect(url).toBe('https://fooddb.example.test/api/v1/food/search?q=yogurt&limit=20');
        expect(opts.headers).toMatchObject({ 'X-API-Key': 'test-key' });
    });

    it('CloudFoodSearch.search: remote rows drop all-zero entries, collapse same-nutrition case duplicates, rank name matches first (med-43ma)', async () => {
        const { window } = env;
        env.window.__MEDTRACKER_CLOUD__ = true;
        vi.stubGlobal('document', window.document);
        await window.apiCall('/api/settings/integrations', 'PATCH', {
            food: { url: 'https://fooddb.example.test', api_key: 'test-key' }
        });
        const row = (name, kcal100g, carbs = 0, protein = 0, fat = 0) => ({ name, barcode: '', kcal100g, carbs, protein, fat });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            async json() {
                return { results: [
                    row('Banana chips', 519, 58, 2, 33),
                    row('BANANA', 169, 38, 1, 0.3),
                    row('Banana', 336, 80, 3, 1),
                    row('Banana', 97, 22, 1, 0.3),
                    row('Banana', 168, 38, 1, 0.3),
                    row('Banana', 0),
                    row('Wana banana', 42, 10),
                    row('Banana sliced', 0),
                    row('Banana diet drink', 0, 0.5),
                ] };
            }
        }));

        const results = await window.CloudFoodSearch.search('banana', { remote: true });
        expect(results.map((p) => [p.name, p.energy_kcal_100g])).toEqual([
            // BANANA 169 and Banana 168 are one product (the non-caps name
            // wins); 336 (dried) and 97 (fresh) are different and both stay.
            ['Banana', 168],
            ['Banana', 336],
            ['Banana', 97],
            ['Banana chips', 519],
            ['Banana diet drink', 0],
            ['Wana banana', 42],
        ]);
    });

    it('decodes HTML entities in an untrusted product name without parsing tags into live DOM', async () => {
        const { window } = env;
        env.window.__MEDTRACKER_CLOUD__ = true;
        vi.stubGlobal('document', window.document);
        window.__XSS__ = undefined;

        await window.apiCall('/api/settings/integrations', 'PATCH', {
            food: { url: 'https://fooddb.example.test', api_key: 'test-key' }
        });

        const hostile = "Ben &amp; Jerry's <img src=x onerror=window.__XSS__=1>";
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            async json() { return { results: [{ name: hostile, barcode: '', carbs: 1, protein: 1, fat: 1, kcal100g: 50 }] }; }
        }));

        const results = await window.CloudFoodSearch.search('jerry', { remote: true });
        const remote = results.find((p) => p.name.startsWith('Ben'));
        // Entities decode (matches Go html.UnescapeString) but the <img> tag
        // stays inert text — a div+innerHTML sink would have stripped it and
        // could fire onerror. Tag text preserved proves the RCDATA decode.
        expect(remote.name).toBe("Ben & Jerry's <img src=x onerror=window.__XSS__=1>");
        expect(window.__XSS__).toBeUndefined();
    });

    it('an 8+ digit all-numeric query is treated as a barcode lookup, not a text search', async () => {
        const { window } = env;
        env.window.__MEDTRACKER_CLOUD__ = true;
        vi.stubGlobal('document', window.document);

        await window.apiCall('/api/settings/integrations', 'PATCH', {
            food: { url: 'https://fooddb.example.test', api_key: 'test-key' }
        });

        const fetchSpy = vi.fn().mockResolvedValue({
            ok: true,
            async json() { return { name: 'Barcode Product', barcode: '12345678', carbs: 1, protein: 1, fat: 1, kcal100g: 50 }; }
        });
        vi.stubGlobal('fetch', fetchSpy);

        const results = await window.CloudFoodSearch.search('12345678', { remote: true });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][0]).toBe('https://fooddb.example.test/api/v1/food/barcode/12345678');
        expect(results).toEqual([expect.objectContaining({ name: 'Barcode Product', barcode: '12345678' })]);
    });

    it('med-e0r: a barcode the user already has locally resolves from the local DB without any remote fetch', async () => {
        const { window } = env;
        env.window.__MEDTRACKER_CLOUD__ = true;
        vi.stubGlobal('document', window.document);

        // Logging with a barcode upserts a local product carrying that code —
        // this is how a user's own scanned product gets into the vault.
        await window.apiCall('/api/food/log', 'POST', {
            eaten_at: new Date().toISOString(), weight: 100, carbs: 5, protein: 20, fat: 4,
            calories: 140, name: 'My Own Skyr', barcode: '87654321', per_100g: false
        });

        await window.apiCall('/api/settings/integrations', 'PATCH', {
            food: { url: 'https://fooddb.example.test', api_key: 'test-key' }
        });

        const fetchSpy = vi.fn().mockResolvedValue({
            ok: true,
            async json() { return { name: 'Remote Skyr', barcode: '87654321', carbs: 9, protein: 9, fat: 9, kcal100g: 9 }; }
        });
        vi.stubGlobal('fetch', fetchSpy);

        const results = await window.CloudFoodSearch.search('87654321', { remote: true });

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(results).toEqual([expect.objectContaining({ name: 'My Own Skyr', barcode: '87654321' })]);
    });

    it('med-e0r: a text query equal to a product\'s free-form barcode field still searches remote', async () => {
        const { window } = env;
        env.window.__MEDTRACKER_CLOUD__ = true;
        vi.stubGlobal('document', window.document);

        // `barcode` is user-editable free text, so it can hold a non-numeric
        // value. The local-first skip must stay gated on the 8+ digit barcode
        // heuristic — otherwise this plain text search would be suppressed.
        await window.apiCall('/api/food/log', 'POST', {
            eaten_at: new Date().toISOString(), weight: 100, carbs: 5, protein: 20, fat: 4,
            calories: 140, name: 'Hand-entered Skyr', barcode: 'skyrcode', per_100g: false
        });

        await window.apiCall('/api/settings/integrations', 'PATCH', {
            food: { url: 'https://fooddb.example.test', api_key: 'test-key' }
        });

        const fetchSpy = vi.fn().mockResolvedValue({
            ok: true,
            async json() {
                return { results: [{ name: 'Remote Skyrcode', barcode: '', carbs: 9, protein: 9, fat: 9, kcal100g: 9 }] };
            }
        });
        vi.stubGlobal('fetch', fetchSpy);

        const results = await window.CloudFoodSearch.search('skyrcode', { remote: true });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][0]).toBe('https://fooddb.example.test/api/v1/food/search?q=skyrcode&limit=20');
        expect(results.map((p) => p.name).sort()).toEqual(['Hand-entered Skyr', 'Remote Skyrcode']);
    });

    // med-1j1: a fresh cloud account has no BYO food URL, and if the operator
    // never set CLOUD_FOOD_DB_URL there is no remote DB at all. fooddb.js's
    // search() then returns [] and the old UI rendered that as "no results",
    // so the user blamed the search. The UI must name the real cause.
    describe('no food DB configured (med-1j1)', () => {
        it('CloudFoodSearch.remoteConfigured is false with no vault URL and no operator meta tag', async () => {
            const { window } = env;
            window.__MEDTRACKER_CLOUD__ = true;
            vi.stubGlobal('document', window.document);
            // The harness DOM carries no <meta name="medtracker-food-db">.
            expect(window.document.querySelector('meta[name="medtracker-food-db"]')).toBeNull();

            expect(await window.CloudFoodSearch.remoteConfigured()).toBe(false);
            expect(await window.CloudFoodSearch.search('yogurt', { remote: true })).toEqual([]);
        });

        it('the search UI says "Food database not available right now" instead of reporting zero results', async () => {
            const { window } = env;
            window.__MEDTRACKER_CLOUD__ = true;
            vi.stubGlobal('document', window.document);
            vi.useFakeTimers();
            try {
                window.document.getElementById('food-name').value = 'yogurt';
                window.onFoodNameChange();
                await vi.runAllTimersAsync();

                const status = window.document.getElementById('food-search-status');
                expect(status.textContent).toBe('Food database not available right now.');
                expect(status.classList.contains('error')).toBe(true);
            } finally {
                vi.useRealTimers();
            }
        });

        it('once a food DB is configured the UI searches it and never shows the not-configured message', async () => {
            const { window } = env;
            window.__MEDTRACKER_CLOUD__ = true;
            vi.stubGlobal('document', window.document);
            await window.apiCall('/api/settings/integrations', 'PATCH', {
                food: { url: 'https://fooddb.example.test' }
            });
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                async json() { return { results: [{ name: 'Remote Yogurt', carbs: 12, protein: 9, fat: 2, kcal100g: 105 }] }; }
            }));
            vi.useFakeTimers();
            try {
                window.document.getElementById('food-name').value = 'yogurt';
                window.onFoodNameChange();
                await vi.runAllTimersAsync();

                const status = window.document.getElementById('food-search-status');
                expect(status.textContent).not.toMatch(/not configured/);
                expect(status.textContent).toMatch(/Found 1 result/);
            } finally {
                vi.useRealTimers();
            }
        });
    });
});

// bd med-5jq.3 — a named food log reconciles against the catalog before it
// creates a product: exact key → learnt alias → one bounded typo match. The
// epic's duplicate table (foodname.domain.test.js) is the fixture, logged
// through POST /api/food/log and the MCP router the Telegram agent also uses.
describe('food logs reconcile against the catalog (med-5jq.3)', () => {
    let env;
    const product = (id, name, extra = {}) => ({
        recordId: id, clientTs: 1, deleted: false, name, barcode: null,
        carbs_100g: 1, protein_100g: 1, fat_100g: 1, energy_kcal_100g: 20,
        usage_count: 1, is_meal: false, total_weight_g: 0,
        created_at: '2026-01-01T00:00:00Z', last_used_at: '2026-01-01T00:00:00Z', ...extra,
    });
    // Rows written before name_key existed: the key is computed on read.
    const catalog = [
        product('p-egg', 'Boiled egg', { usage_count: 7 }),
        product('p-sandwich', 'Sandwich'),
        product('p-yogurt', 'Yogurt'),
        product('p-cappuccino', 'Cappuccino'),
        product('p-kimchi', 'Kimchi'),
        product('p-rye', 'Rye bread'),
        product('p-spaghetti', 'Dry spaghetti'),
        product('p-coffee', 'Coffee'),
        product('p-banana', 'Banana'),
    ];
    const body = (name) => ({ name, eaten_at: new Date().toISOString(), weight: 100, carbs: 9, protein: 9, fat: 9, calories: 153 });
    const viaApi = (name) => env.window.apiCall('/api/food/log', 'POST', body(name));
    const viaMcp = async (name) => (await env.window.CloudMCPDispatcher.handle('mcp_call', { op: 'food.log.create', mode: 'write', intent: 'log a meal', body: body(name) })).result;
    const productRows = async () => (await env.records.list('foodproduct')).filter((p) => !p.deleted);

    beforeEach(() => {
        env = loadCloudShimFrontendEnv({ seedRecords: { foodproduct: catalog.map((p) => ({ ...p })) } });
        env.window.__MEDTRACKER_CLOUD__ = true;
        installApiCache(env.window);
    });

    afterEach(() => { env.cleanup(); env = null; });

    const linked = [
        ['Boiled eggs', 'p-egg', 'exact'], ['boiled egg', 'p-egg', 'exact'], ['hard-boiled eggs', 'p-egg', 'exact'],
        ['2 boiled eggs', 'p-egg', 'exact'], ['boiled eggs breakfast', 'p-egg', 'exact'], ['Boiled eggs (airline)', 'p-egg', 'exact'],
        ['Night sandwiches', 'p-sandwich', 'exact'],
        ['Yugurt', 'p-yogurt', 'typo'], ['capuccino', 'p-cappuccino', 'typo'], ['Swandwich', 'p-sandwich', 'typo'], ['Kim Chi', 'p-kimchi', 'typo'],
    ];
    for (const [via, log] of [['POST /api/food/log', viaApi], ['MCP food.log.create', viaMcp]]) {
        it.each(linked)(`${via}: %j links to the one existing product (%s, %s), creates none`, async (name, id, matched) => {
            const res = await log(name);
            const target = catalog.find((p) => p.recordId === id);
            expect(res).toMatchObject({ product_id: id, matched, name: target.name });
            expect(await productRows()).toHaveLength(catalog.length);
        });
    }

    it.each([['Fried egg'], ['White bread'], ['Cooked spaghetti'], ['Coffee with milk'], ['Dried banana']])(
        'must-not-merge: %j creates its own product, as typed', async (name) => {
            const res = await viaApi(name);
            expect(res).toMatchObject({ matched: 'new', name });
            const rows = await productRows();
            expect(rows).toHaveLength(catalog.length + 1);
            expect(rows.find((p) => p.recordId === res.product_id)).toMatchObject({ name, name_key: name.toLowerCase() });
        });

    it('a typo match learns the typed key: the next log matches by alias, search finds it, an edit keeps it', async () => {
        await viaApi('Yugurt');
        expect((await productRows()).find((p) => p.recordId === 'p-yogurt')).toMatchObject({ aliases: ['yugurt'], usage_count: 2, name_key: 'yogurt' });
        expect(await viaApi('yugurts')).toMatchObject({ product_id: 'p-yogurt', matched: 'alias', name: 'Yogurt' });
        expect((await env.window.apiCall('/api/food/products/search?q=yugurt')).map((p) => p.id)).toEqual(['p-yogurt']);

        const [row] = (await productRows()).filter((p) => p.recordId === 'p-yogurt');
        await env.window.apiCall('/api/food/products/p-yogurt', 'PUT', { ...row, name: 'Greek yogurt', energy_kcal_100g: 97 });
        expect((await productRows()).find((p) => p.recordId === 'p-yogurt'))
            .toMatchObject({ name: 'Greek yogurt', name_key: 'greek yogurt', aliases: ['yugurt'], energy_kcal_100g: 97 });
        expect(await viaApi('Yugurt')).toMatchObject({ product_id: 'p-yogurt', matched: 'alias', name: 'Greek yogurt' });
    });

    it('search matches on the key: "boiled eggs" and "Hard-boiled" find the Boiled egg product', async () => {
        for (const q of ['boiled eggs', 'Hard-boiled']) {
            expect((await env.window.apiCall(`/api/food/products/search?q=${encodeURIComponent(q)}`)).map((p) => p.id), q).toContain('p-egg');
        }
    });

    it('same-key duplicates: the log links to the more used product', async () => {
        await env.records.put('foodproduct', product('p-eggs-dup', 'Boiled eggs', { usage_count: 2 }));
        expect(await viaApi('boiled egg')).toMatchObject({ product_id: 'p-egg', matched: 'exact' });
    });

    it('a stale name_key (renamed by an older bundle, which spreads the row) never matches', async () => {
        await env.records.put('foodproduct', product('p-renamed', 'Fried egg', { name_key: 'boiled egg', usage_count: 99 }));
        expect(await viaApi('Boiled egg')).toMatchObject({ product_id: 'p-egg', matched: 'exact', name: 'Boiled egg' });
        expect((await env.window.apiCall('/api/food/products/search?q=boiled')).map((p) => p.id)).not.toContain('p-renamed');
    });

    it('two near keys never guess: a typo between them creates a new product', async () => {
        await env.records.put('foodproduct', product('p-pasta', 'Pasta'));
        await env.records.put('foodproduct', product('p-paste', 'Paste'));
        expect(await viaApi('Pastu')).toMatchObject({ matched: 'new', name: 'Pastu' });
    });

    it('update: a changed name relinks to the canonical product; an unchanged name keeps its link; no product write', async () => {
        const log = await viaApi('Fried egg');
        const before = await productRows();
        const relinked = await env.window.apiCall(`/api/food/log/${log.id}`, 'PUT', { ...body('2 boiled eggs'), eaten_at: log.eaten_at });
        expect(relinked).toMatchObject({ product_id: 'p-egg', name: 'Boiled egg', matched: 'exact' });
        const kept = await env.window.apiCall(`/api/food/log/${log.id}`, 'PUT', { ...body('Boiled egg'), eaten_at: log.eaten_at, calories: 99 });
        expect(kept).toMatchObject({ product_id: 'p-egg', calories: 99 });
        expect(kept.matched).toBeUndefined();
        const unmatched = await env.window.apiCall(`/api/food/log/${log.id}`, 'PUT', { ...body('Granola square'), eaten_at: log.eaten_at });
        expect(unmatched).toMatchObject({ name: 'Granola square', matched: null });
        expect(unmatched.product_id).toBeUndefined();
        expect(await productRows()).toEqual(before);
    });
});
