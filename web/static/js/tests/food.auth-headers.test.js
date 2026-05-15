// Auth header consolidation — Task 2 of the
// 2026-05-13-auth-header-consolidation plan.
//
// Pins that the four direct-fetch call sites in features/food/ (which
// bypass apiCallDirect because they stream, multipart-upload, or run a
// parallel DELETE fan-out) all build their auth headers via
// window.makeAuthHeaders() rather than constructing
// `X-Telegram-Init-Data` inline. Each case asserts the fetch saw
// exactly the headers the helper returns for the configured
// userInitData, so a regression to inline construction would either
// drop the header or use the wrong key.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function streamingResponse(jsonLines) {
    let idx = 0;
    return {
        status: 200,
        ok: true,
        body: {
            getReader() {
                return {
                    async read() {
                        if (idx >= jsonLines.length) {
                            return { done: true, value: undefined };
                        }
                        const chunk = new TextEncoder().encode(jsonLines[idx] + '\n');
                        idx += 1;
                        return { done: false, value: chunk };
                    }
                };
            }
        }
    };
}

function makeFakeImageFile(env, name = 'food.jpg') {
    const W = env.window;
    return new W.File([new W.Blob(['x'])], name, { type: 'image/jpeg' });
}

function attachFile(input, file) {
    Object.defineProperty(input, 'files', {
        configurable: true,
        get: () => [file],
    });
}

function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('food direct-fetch call sites route through makeAuthHeaders()', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
        Object.defineProperty(env.window.navigator, 'onLine', {
            configurable: true,
            get: () => true
        });
        env.window.TextDecoder = globalThis.TextDecoder;
        env.window.TextEncoder = globalThis.TextEncoder;

        env.window.userInitData = 'food-token-abc';

        env.window.DataStore = env.window.DataStore || {};
        env.window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
        env.window.DataStore.clearCached = vi.fn().mockResolvedValue(undefined);
        env.window.DataStore.advanceCursorSilently = vi.fn();
        env.window.loadFoodLogs = vi.fn();
        env.window.loadToday = vi.fn();
    });

    afterEach(() => {
        try {
            env.document.querySelectorAll('.wg-food-photo-summary').forEach((el) => el.remove());
            env.window.localStorage.clear();
        } catch (_) { /* ignore */ }
        try { vi.useRealTimers(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('name-search streaming fetch sends X-Telegram-Init-Data from window.userInitData', async () => {
        vi.useFakeTimers();
        const { window, document } = env;

        window.fetch = vi.fn(async () =>
            streamingResponse([JSON.stringify([{ id: 1, name: 'Apple', barcode: '111' }])])
        );

        document.getElementById('food-name').value = 'app';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(850);
        await vi.runAllTimersAsync();
        for (let i = 0; i < 30; i++) await Promise.resolve();

        expect(window.fetch).toHaveBeenCalled();
        const [, opts] = window.fetch.mock.calls[0];
        expect(opts.headers).toEqual({ 'X-Telegram-Init-Data': 'food-token-abc' });
    });

    it('barcode-search fetch sends X-Telegram-Init-Data from window.userInitData', async () => {
        vi.useFakeTimers();
        const { window, document } = env;

        window.fetch = vi.fn(async () =>
            streamingResponse([JSON.stringify([{ id: 2, name: 'Banana', barcode: '12345' }])])
        );

        document.getElementById('food-barcode').value = '12345';
        window.onFoodBarcodeChange();
        await vi.advanceTimersByTimeAsync(850);
        await vi.runAllTimersAsync();
        for (let i = 0; i < 30; i++) await Promise.resolve();

        expect(window.fetch).toHaveBeenCalled();
        const [, opts] = window.fetch.mock.calls[0];
        expect(opts.headers).toEqual({ 'X-Telegram-Init-Data': 'food-token-abc' });
    });

    it('uploadFoodPhoto POST sends X-Telegram-Init-Data from window.userInitData', async () => {
        const { window, document } = env;

        window.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            async json() { return { items: [] }; },
            async text() { return JSON.stringify({ items: [] }); },
        });

        const input = document.getElementById('food-photo-input');
        attachFile(input, makeFakeImageFile(env));
        await window.uploadFoodPhoto(input);
        await flushPromises();

        expect(window.fetch).toHaveBeenCalled();
        const postCall = window.fetch.mock.calls.find(
            ([, opts]) => opts && opts.method === 'POST'
        );
        expect(postCall).toBeDefined();
        expect(postCall[1].headers).toEqual({ 'X-Telegram-Init-Data': 'food-token-abc' });
    });

    it('Undo DELETE calls send X-Telegram-Init-Data from window.userInitData', async () => {
        const { window, document } = env;

        const sample = [
            { id: 11, name: 'Oatmeal', weight: 80,  carbs: 50, protein: 10, fat: 5, calories: 280 },
            { id: 12, name: 'Banana',  weight: 120, carbs: 27, protein: 1,  fat: 0, calories: 105 },
        ];
        window.fetch = vi.fn().mockImplementation((url, opts) => {
            if (opts && opts.method === 'POST') {
                return Promise.resolve({
                    ok: true, status: 200,
                    async json() { return { items: sample }; },
                    async text() { return JSON.stringify({ items: sample }); },
                });
            }
            return Promise.resolve({
                ok: true, status: 200,
                async json() { return {}; },
                async text() { return ''; },
            });
        });

        const input = document.getElementById('food-photo-input');
        attachFile(input, makeFakeImageFile(env));
        await window.uploadFoodPhoto(input);
        await flushPromises();

        const card = document.querySelector('.wg-food-photo-summary');
        const undoBtn = card.querySelector('.wg-food-photo-summary__undo');
        undoBtn.click();
        await flushPromises();
        await flushPromises();

        const deleteCalls = window.fetch.mock.calls.filter(
            ([, opts]) => opts && opts.method === 'DELETE'
        );
        expect(deleteCalls.length).toBe(sample.length);
        for (const [, opts] of deleteCalls) {
            expect(opts.headers).toEqual({ 'X-Telegram-Init-Data': 'food-token-abc' });
        }
    });

    it('omits the header entirely when window.userInitData is unset (helper contract)', async () => {
        vi.useFakeTimers();
        const { window, document } = env;
        window.userInitData = '';

        window.fetch = vi.fn(async () =>
            streamingResponse([JSON.stringify([{ id: 1, name: 'Apple' }])])
        );

        document.getElementById('food-name').value = 'app';
        window.onFoodNameChange();
        await vi.advanceTimersByTimeAsync(850);
        await vi.runAllTimersAsync();
        for (let i = 0; i < 30; i++) await Promise.resolve();

        expect(window.fetch).toHaveBeenCalled();
        const [, opts] = window.fetch.mock.calls[0];
        // No token → headers must NOT carry the X-Telegram-Init-Data key
        // (the helper drops it; inline construction would have sent
        // `{ 'X-Telegram-Init-Data': '' }`).
        expect('X-Telegram-Init-Data' in opts.headers).toBe(false);
    });
});
