// Integration tests for the Phase 2b Task 7 abstraction seam in
// features/food/photo.js. Pins the contract that triggerFoodPhotoPicker
// routes through window.MediaCapture.pickPhoto, and that the picked file
// goes into the existing uploadFoodPhotoFile() pipeline (EXIF + POST
// /api/food/log/from-photo + cache invalidation — all unchanged by the
// refactor).

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
        env.window.userInitData = '';
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

    it('a picked file goes through the existing POST /api/food/log/from-photo pipeline', async () => {
        const { window } = env;
        const file = makeImageFile(env);
        window.MediaCapture = { pickPhoto: vi.fn().mockResolvedValue(file) };

        const fetchSpy = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            async json() { return { items: [{ id: 99, name: 'Salad', calories: 100, carbs: 5, protein: 4, fat: 2 }] }; },
            async text() { return ''; },
        });
        window.fetch = fetchSpy;

        await window.triggerFoodPhotoPicker();
        await flushPromises();

        // The POST hit /api/food/log/from-photo.
        const postCalls = fetchSpy.mock.calls.filter(([url, opts]) =>
            url === '/api/food/log/from-photo' && opts && opts.method === 'POST'
        );
        expect(postCalls.length).toBe(1);

        const formBody = postCalls[0][1].body;
        // FormData is opaque in jsdom; check it has the image field via .get().
        expect(formBody.get('image')).toBeTruthy();
        expect(formBody.get('eaten_at')).toBeTruthy();
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
