// Plan 2026-07-06 cloud-c2c, Task 6 — shim-mode contract run of the client-
// side food-AI flows (features/food/{log,photo,ai-undo}.js's
// window.__MEDTRACKER_CLOUD__ branches) against web/domain/foodai.js +
// web/cloud/js/aiclient.js. The AI provider call never touches the shim
// (apishim.js deliberately excludes it) — it goes straight from the browser
// to the user's own OpenAI(-compatible) endpoint, so the only thing this
// suite fakes is that provider's HTTP response, at the `fetch` boundary.
//
// web/cloud/js/aiclient.js is a real ES module (not a classic script
// injected into env.window), so its bare `fetch`/`FileReader` calls resolve
// against THIS test file's own realm (vitest runs with environment: 'node',
// see vitest.config.mjs) rather than env.window's separate JSDOM instance.
// Node has no FileReader global, so it's stubbed from env.window (which has
// a real one) for the duration of each test; the picked File is likewise
// constructed via env.window.File so both come from the same JSDOM realm.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApiCache, loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

// Local-date fixture — hardcoded dates rot out of the `days=1` query window
// once the wall clock passes them (see the date-bomb gotcha in MEMORY.md).
function todayAt(hhmm) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${hhmm}`;
}

function makeImageFile(env, name = 'meal.jpg', sizeBytes) {
    const W = env.window;
    const bytes = sizeBytes ? new Uint8Array(sizeBytes) : new Uint8Array([1, 2, 3, 4]);
    return new W.File([new W.Blob([bytes])], name, { type: 'image/jpeg' });
}

function chatCompletionResponse(items) {
    const body = JSON.stringify({ items });
    return {
        ok: true,
        status: 200,
        async text() {
            return JSON.stringify({ choices: [{ message: { content: body } }] });
        }
    };
}

async function setOpenAIKey(window) {
    await window.apiCall('/api/settings/integrations', 'PATCH', {
        openai: { api_key: 'sk-test-dummy', url: 'https://api.example.test/v1' }
    });
}

// aiclient.js reads the trial flag from ITS realm's document (Node has none
// under vitest environment: 'node') — stub it with env.window's JSDOM
// document carrying the <meta> that injectCloudBoot splices server-side.
function enableTrialAI(env) {
    const meta = env.document.createElement('meta');
    meta.name = 'medtracker-trial-ai';
    meta.content = '1';
    env.document.head.appendChild(meta);
    vi.stubGlobal('document', env.document);
}

describe('cloud shim contract — food AI flows (features/food/{log,photo,ai-undo}.js over web/domain/foodai.js)', () => {
    let env;

    beforeEach(() => {
        env = loadCloudShimFrontendEnv();
        installApiCache(env.window);
        env.window.__MEDTRACKER_CLOUD__ = true;
        env.window.loadFoodLogs = vi.fn();
        env.window.loadToday = vi.fn();
        env.window.safeAlert = vi.fn();

        // aiclient.js's fileToDataURL runs in this test file's own module
        // realm (Node), which has no FileReader global — borrow env.window's
        // real one so it's realm-consistent with the File it's asked to read
        // (also constructed via env.window.File, see makeImageFile above).
        vi.stubGlobal('FileReader', env.window.FileReader);

        const video = env.document.getElementById('food-scanner-video');
        if (video) {
            video.pause = vi.fn();
            video.srcObject = null;
        }
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        try { env.document.querySelectorAll('.wg-food-photo-summary').forEach((el) => el.remove()); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('description happy path: parses via the provider, creates real logs, then undo removes them', async () => {
        const { window, document } = env;
        await setOpenAIKey(window);

        const fetchSpy = vi.fn().mockResolvedValue(chatCompletionResponse([
            { name: 'Grilled chicken', weight_grams: 200, carbs_100g: 0, protein_100g: 30, fat_100g: 4 },
            { name: 'White rice', weight_grams: 150, carbs_100g: 28, protein_100g: 2.7, fat_100g: 0.3 }
        ]));
        vi.stubGlobal('fetch', fetchSpy);

        document.getElementById('food-id').value = '';
        document.getElementById('food-parse-ai').checked = true;
        document.getElementById('food-datetime').value = todayAt('12:00');
        document.getElementById('food-name').value = '200g grilled chicken with rice';

        await window.saveFoodLog();
        await flushPromises();

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][0]).toBe('https://api.example.test/v1/chat/completions');

        const grouped = await window.apiCall('/api/food/log?days=1');
        const logs = grouped.flatMap((g) => g.logs);
        expect(logs.map((l) => l.name).sort()).toEqual(['Grilled chicken', 'White rice']);

        // Parity with Go's CalculateMacros (int-trunc, 4c+4p+9f): 200g grilled
        // chicken @ protein_100g=30, fat_100g=4 -> protein 60, fat 8, 312 kcal.
        // Guards against a coefficient/truncation regression in calculateMacros.
        expect(logs.find((l) => l.name === 'Grilled chicken')).toMatchObject({
            weight: 200, carbs: 0, protein: 60, fat: 8, calories: 312,
        });

        // Parity with the server AI handlers (food_handlers.go:255) — they
        // CreateLog bare-named entries with no product_id and no UpsertProduct,
        // so AI logging must NOT populate the product catalog.
        expect(logs.every((l) => l.product_id === undefined)).toBe(true);
        const products = await window.apiCall('/api/food/products', 'GET');
        expect(products.total).toBe(0);

        window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });
        const summaryStub = { showRemoved: vi.fn(), showError: vi.fn() };
        await window.undoFoodAIItems(logs, summaryStub);
        await flushPromises();

        expect(summaryStub.showRemoved).toHaveBeenCalledWith(2);
        const grouped2 = await window.apiCall('/api/food/log?days=1');
        expect(grouped2.flatMap((g) => g.logs)).toHaveLength(0);
    });

    it('photo happy path: uploadFoodPhotoFile drives CloudFoodAI.parseMealFromPhoto and logs the result', async () => {
        const { window } = env;
        await setOpenAIKey(window);

        const fetchSpy = vi.fn().mockResolvedValue(chatCompletionResponse([
            { name: 'Salad', weight_grams: 180, carbs_100g: 5, protein_100g: 2, fat_100g: 3 }
        ]));
        vi.stubGlobal('fetch', fetchSpy);

        const file = makeImageFile(env);
        await window.uploadFoodPhotoFile(file);
        await flushPromises();

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const grouped = await window.apiCall('/api/food/log?days=1');
        const logs = grouped.flatMap((g) => g.logs);
        expect(logs.map((l) => l.name)).toEqual(['Salad']);
    });

    it('fallback path: a response_format rejection retries once without it, and the item still logs', async () => {
        const { window, document } = env;
        await setOpenAIKey(window);

        const rejection = {
            ok: false,
            status: 400,
            async text() { return JSON.stringify({ error: { message: 'model does not support response_format' } }); }
        };
        const success = chatCompletionResponse([
            { name: 'Oatmeal', weight_grams: 250, carbs_100g: 12, protein_100g: 3, fat_100g: 2 }
        ]);
        const fetchSpy = vi.fn()
            .mockResolvedValueOnce(rejection)
            .mockResolvedValueOnce(success);
        vi.stubGlobal('fetch', fetchSpy);

        document.getElementById('food-id').value = '';
        document.getElementById('food-parse-ai').checked = true;
        document.getElementById('food-datetime').value = todayAt('08:00');
        document.getElementById('food-name').value = 'a bowl of oatmeal';

        await window.saveFoodLog();
        await flushPromises();

        expect(fetchSpy).toHaveBeenCalledTimes(2);
        const secondBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
        expect(secondBody.response_format).toBeUndefined();

        const grouped = await window.apiCall('/api/food/log?days=1');
        expect(grouped.flatMap((g) => g.logs).map((l) => l.name)).toEqual(['Oatmeal']);
    });

    it('missing-key hint: no fetch is attempted and safeAlert mentions Settings/Integrations', async () => {
        allowConsoleNoise();
        const { window, document } = env;
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        document.getElementById('food-id').value = '';
        document.getElementById('food-parse-ai').checked = true;
        document.getElementById('food-datetime').value = todayAt('08:00');
        document.getElementById('food-name').value = 'two eggs';

        await window.saveFoodLog();
        await flushPromises();

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(window.safeAlert).toHaveBeenCalledWith(expect.stringMatching(/Settings.*Integrations/i));
    });

    it('oversized photo rejection: an 8MB+ file is rejected via safeAlert without calling fetch', async () => {
        allowConsoleNoise();
        const { window } = env;
        await setOpenAIKey(window);
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        const bigFile = makeImageFile(env, 'huge.jpg', 8 * 1024 * 1024 + 10);
        await window.uploadFoodPhotoFile(bigFile);
        await flushPromises();

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(window.safeAlert).toHaveBeenCalledWith(expect.stringMatching(/8\s*MB/i));
    });

    it('trial fallback: no vault key + trial meta flag routes to the same-origin proxy with no model and no Authorization', async () => {
        const { window, document } = env;
        enableTrialAI(env);

        const fetchSpy = vi.fn().mockResolvedValue(chatCompletionResponse([
            { name: 'Banana', weight_grams: 120, carbs_100g: 23, protein_100g: 1.1, fat_100g: 0.3 }
        ]));
        vi.stubGlobal('fetch', fetchSpy);

        document.getElementById('food-id').value = '';
        document.getElementById('food-parse-ai').checked = true;
        document.getElementById('food-datetime').value = todayAt('09:00');
        document.getElementById('food-name').value = 'a banana';

        await window.saveFoodLog();
        await flushPromises();

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][0]).toBe('/api/trial/openai/chat/completions');
        const [, init] = fetchSpy.mock.calls[0];
        expect(init.headers.Authorization).toBeUndefined();
        const body = JSON.parse(init.body);
        expect(body.model).toBeUndefined();
        expect(body.response_format).toBeDefined();

        const grouped = await window.apiCall('/api/food/log?days=1');
        expect(grouped.flatMap((g) => g.logs).map((l) => l.name)).toEqual(['Banana']);
    });

    it('trial fallback photo: parseMealFromImage hits the proxy with ?vision=1', async () => {
        const { window } = env;
        enableTrialAI(env);

        const fetchSpy = vi.fn().mockResolvedValue(chatCompletionResponse([
            { name: 'Salad', weight_grams: 180, carbs_100g: 5, protein_100g: 2, fat_100g: 3 }
        ]));
        vi.stubGlobal('fetch', fetchSpy);

        await window.uploadFoodPhotoFile(makeImageFile(env));
        await flushPromises();

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][0]).toBe('/api/trial/openai/chat/completions?vision=1');
    });

    it('trial 429: rate-limit response surfaces the distinct trial-limit message', async () => {
        allowConsoleNoise();
        const { window, document } = env;
        enableTrialAI(env);

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            async text() { return JSON.stringify({ error: 'trial_rate_limit', retry_after_seconds: 60 }); }
        }));

        document.getElementById('food-id').value = '';
        document.getElementById('food-parse-ai').checked = true;
        document.getElementById('food-datetime').value = todayAt('09:00');
        document.getElementById('food-name').value = 'a banana';

        await window.saveFoodLog();
        await flushPromises();

        expect(window.safeAlert).toHaveBeenCalledWith(expect.stringMatching(/trial limit/i));
    });

    it('trial 503: unconfigured proxy degrades to the plain no-key error', async () => {
        allowConsoleNoise();
        const { window, document } = env;
        enableTrialAI(env);

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 503,
            async text() { return JSON.stringify({ error: 'trial_not_configured' }); }
        }));

        document.getElementById('food-id').value = '';
        document.getElementById('food-parse-ai').checked = true;
        document.getElementById('food-datetime').value = todayAt('09:00');
        document.getElementById('food-name').value = 'a banana';

        await window.saveFoodLog();
        await flushPromises();

        expect(window.safeAlert).toHaveBeenCalledWith(expect.stringMatching(/Settings.*Integrations/i));
        expect(window.safeAlert).not.toHaveBeenCalledWith(expect.stringMatching(/trial limit/i));
    });

    it('trial 502: sanitized upstream error surfaces a friendly message, not raw JSON', async () => {
        allowConsoleNoise();
        const { window, document } = env;
        enableTrialAI(env);

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 502,
            async text() { return JSON.stringify({ error: 'upstream_error' }); }
        }));

        document.getElementById('food-id').value = '';
        document.getElementById('food-parse-ai').checked = true;
        document.getElementById('food-datetime').value = todayAt('09:00');
        document.getElementById('food-name').value = 'a banana';

        await window.saveFoodLog();
        await flushPromises();

        expect(window.safeAlert).toHaveBeenCalledWith(expect.stringMatching(/trial ai request failed/i));
        expect(window.safeAlert).not.toHaveBeenCalledWith(expect.stringContaining('upstream_error'));
    });

    it('vault key beats trial: with both present the call stays browser-direct', async () => {
        const { window, document } = env;
        await setOpenAIKey(window);
        enableTrialAI(env);

        const fetchSpy = vi.fn().mockResolvedValue(chatCompletionResponse([
            { name: 'Toast', weight_grams: 60, carbs_100g: 45, protein_100g: 8, fat_100g: 3 }
        ]));
        vi.stubGlobal('fetch', fetchSpy);

        document.getElementById('food-id').value = '';
        document.getElementById('food-parse-ai').checked = true;
        document.getElementById('food-datetime').value = todayAt('09:00');
        document.getElementById('food-name').value = 'a slice of toast';

        await window.saveFoodLog();
        await flushPromises();

        expect(fetchSpy.mock.calls[0][0]).toBe('https://api.example.test/v1/chat/completions');
    });

    it('masked-key assertion: GET /api/settings/integrations never returns the raw key, even after a live AI call', async () => {
        const { window, document } = env;
        await setOpenAIKey(window);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatCompletionResponse([
            { name: 'Toast', weight_grams: 60, carbs_100g: 45, protein_100g: 8, fat_100g: 3 }
        ])));

        document.getElementById('food-id').value = '';
        document.getElementById('food-parse-ai').checked = true;
        document.getElementById('food-datetime').value = todayAt('08:00');
        document.getElementById('food-name').value = 'a slice of toast';
        await window.saveFoodLog();
        await flushPromises();

        const integrations = await window.apiCall('/api/settings/integrations', 'GET');
        expect(integrations.openai.api_key).toBe('***');
        expect(JSON.stringify(integrations)).not.toContain('sk-test-dummy');
    });
});
