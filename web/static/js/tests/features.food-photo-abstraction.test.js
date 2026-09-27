// Integration tests for the Phase 2b Task 7 abstraction seam in
// features/food/photo.js. Pins the contract that triggerFoodPhotoPicker
// routes through window.MediaCapture.pickPhoto, and that the picked file
// goes into the existing uploadFoodPhotoFile() pipeline (EXIF + CloudFoodAI
// parse + cache invalidation — all unchanged by the refactor).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeImageFile(env, name = 'food.jpg') {
    const W = env.window;
    return new W.File([new W.Blob(['x'])], name, { type: 'image/jpeg' });
}

describe('features/food/photo.js — Phase 2b abstraction seam (Task 7)', () => {
    let env;
    let consoleErrorSpy;

    beforeEach(() => {
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        env = loadFrontendEnv();
        env.window.loadFoodLogs = vi.fn();
        env.window.loadToday = vi.fn();
        env.window.DataStore = env.window.DataStore || {};
        env.window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
        env.window.DataStore.clearCached = vi.fn().mockResolvedValue(undefined);
        env.window.DataStore.advanceCursorSilently = vi.fn();
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('triggerFoodPhotoPicker calls window.MediaCapture.pickPhoto({ capture: false })', async () => {
        const { window } = env;
        const pickPhotoSpy = vi.fn().mockResolvedValue(null);
        window.MediaCapture = { pickPhoto: pickPhotoSpy };

        await window.triggerFoodPhotoPicker();

        expect(pickPhotoSpy).toHaveBeenCalledTimes(1);
        expect(pickPhotoSpy).toHaveBeenCalledWith({ capture: false });
    });

    it('a picked file goes through the existing CloudFoodAI parse pipeline', async () => {
        const { window } = env;
        const file = makeImageFile(env);
        window.MediaCapture = { pickPhoto: vi.fn().mockResolvedValue(file) };

        const parse = vi.fn(async () => ({ items: [{ id: 99, name: 'Salad', calories: 100, carbs: 5, protein: 4, fat: 2 }], failed: 0 }));
        window.CloudFoodAI = { parseMealFromPhoto: parse };

        await window.triggerFoodPhotoPicker();
        await flushPromises();

        // The picked file reached the AI parse with a resolved eaten_at.
        expect(parse).toHaveBeenCalledTimes(1);
        const [sentFile, opts] = parse.mock.calls[0];
        expect(sentFile).toBe(file);
        // Realm-safe Date check (constructed inside the JSDOM window).
        expect(typeof opts.eatenAt.toISOString).toBe('function');
    });

    it('cancelling the picker (pickPhoto resolves null) is a no-op — no POST fires', async () => {
        const { window } = env;
        window.MediaCapture = { pickPhoto: vi.fn().mockResolvedValue(null) };
        const fetchSpy = vi.fn();
        window.fetch = fetchSpy;

        await window.triggerFoodPhotoPicker();
        await flushPromises();

        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('pickPhoto rejection is logged and swallowed (no upload attempt)', async () => {
        const { window } = env;
        const err = new Error('camera blocked');
        err.name = 'MediaCaptureError';
        err.code = 'PERMISSION_DENIED';
        window.MediaCapture = { pickPhoto: vi.fn().mockRejectedValue(err) };
        const fetchSpy = vi.fn();
        window.fetch = fetchSpy;

        // Should not throw — the trigger swallows the error and bails.
        await expect(window.triggerFoodPhotoPicker()).resolves.toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('window.MediaCapture being absent is a defensive no-op (no crash)', async () => {
        const { window } = env;
        // Strip MediaCapture entirely — simulates a stale page that loaded
        // before the abstraction layer landed. Trigger must bail cleanly.
        delete window.MediaCapture;

        await expect(window.triggerFoodPhotoPicker()).resolves.toBeUndefined();
    });

    it('uploadFoodPhotoFile is exposed for direct invocation from the abstraction path', () => {
        const { window } = env;
        // The trigger path calls uploadFoodPhotoFile(file) — assert it exists
        // as a top-level function (the change-handler legacy path goes
        // through uploadFoodPhoto(input) which delegates to it).
        expect(typeof window.uploadFoodPhotoFile).toBe('function');
    });
});
