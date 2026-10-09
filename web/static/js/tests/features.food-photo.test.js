// Focused integration tests for the extracted features/food/photo.js
// sub-file. Covers the public-API surface of window.FoodPhoto + the EXIF
// helpers that moved out of the monolithic food.js.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('features/food/photo.js — split-file integration', () => {
    let env;
    let consoleErrorSpy;

    beforeEach(() => {
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        env = loadFrontendEnv();
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('exposes the FoodPhoto + FoodActions namespaces on window', () => {
        const { window } = env;
        expect(window.FoodPhoto).toBeTypeOf('object');
        expect(window.FoodPhoto.triggerPicker).toBeTypeOf('function');
        expect(window.FoodPhoto.upload).toBeTypeOf('function');
        expect(window.FoodPhoto.undo).toBeTypeOf('function');

        // Today shortcut path: legacy window.FoodActions namespace must still
        // expose triggerPhotoPicker — the Today tile binds to it at boot.
        expect(window.FoodActions).toBeTypeOf('object');
        expect(window.FoodActions.triggerPhotoPicker).toBeTypeOf('function');
    });

    it('triggerFoodPhotoPicker routes through window.MediaCapture.pickPhoto (Phase 2b abstraction seam)', async () => {
        const { window } = env;
        const pickPhotoSpy = vi.fn().mockResolvedValue(null);
        window.MediaCapture = { pickPhoto: pickPhotoSpy };

        await window.triggerFoodPhotoPicker();

        // The native abstraction is the new picker seam — the static
        // #food-photo-input is kept in the DOM as a fallback surface (its
        // change handler still routes into uploadFoodPhoto for direct dispatch)
        // but the trigger no longer clicks it.
        expect(pickPhotoSpy).toHaveBeenCalledTimes(1);
        // capture: false — the food picker must allow gallery selection, not
        // force the camera (parity with the static input which omits the
        // `capture` attribute).
        expect(pickPhotoSpy).toHaveBeenCalledWith({ capture: false });
    });

    it('parseFoodPhotoExifDateString rejects malformed input and returns null', () => {
        const { window } = env;
        expect(window.parseFoodPhotoExifDateString('')).toBeNull();
        expect(window.parseFoodPhotoExifDateString('not a date')).toBeNull();
    });

    it('readFoodPhotoLastModifiedDate uses file.lastModified when present and within range', () => {
        const { window } = env;
        const ms = new Date('2024-06-01T10:00:00Z').getTime();
        const result = window.readFoodPhotoLastModifiedDate({ lastModified: ms });
        // JSDOM's Date constructor lives in window.Date — instanceof of the
        // outer Vitest scope's Date constructor would fail; verify via the
        // value-side getTime() round-trip instead.
        expect(result).toBeTruthy();
        expect(result.getTime()).toBe(ms);

        expect(window.readFoodPhotoLastModifiedDate({})).toBeNull();
        expect(window.readFoodPhotoLastModifiedDate(null)).toBeNull();
    });
});
