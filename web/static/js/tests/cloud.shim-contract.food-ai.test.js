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
        document.getElementById('food-datetime').value = '2026-07-06T12:00';
        document.getElementById('food-name').value = '200g grilled chicken with rice';

        await window.saveFoodLog();
        await flushPromises();

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][0]).toBe('https://api.example.test/v1/chat/completions');

        const grouped = await window.apiCall('/api/food/log?days=1');
        const logs = grouped.flatMap((g) => g.logs);
        expect(logs.map((l) => l.name).sort()).toEqual(['Grilled chicken', 'White rice']);

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
        document.getElementById('food-datetime').value = '2026-07-06T08:00';
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
        document.getElementById('food-datetime').value = '2026-07-06T08:00';
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

    it('masked-key assertion: GET /api/settings/integrations never returns the raw key, even after a live AI call', async () => {
        const { window, document } = env;
        await setOpenAIKey(window);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatCompletionResponse([
            { name: 'Toast', weight_grams: 60, carbs_100g: 45, protein_100g: 8, fat_100g: 3 }
        ])));

        document.getElementById('food-id').value = '';
        document.getElementById('food-parse-ai').checked = true;
        document.getElementById('food-datetime').value = '2026-07-06T08:00';
        document.getElementById('food-name').value = 'a slice of toast';
        await window.saveFoodLog();
        await flushPromises();

        const integrations = await window.apiCall('/api/settings/integrations', 'GET');
        expect(integrations.openai.api_key).toBe('***');
        expect(JSON.stringify(integrations)).not.toContain('sk-test-dummy');
    });
});
