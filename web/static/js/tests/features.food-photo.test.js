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

    it('triggerFoodPhotoPicker resets the input value and clicks the hidden picker', () => {
        const { window, document } = env;
        const input = document.getElementById('food-photo-input');
        const clickSpy = vi.spyOn(input, 'click').mockImplementation(() => {});

        window.triggerFoodPhotoPicker();

        // JSDOM's <input type=file> only accepts empty-string writes; assert
        // the file-picker click fired without inspecting the (always-empty)
        // value field.
        expect(clickSpy).toHaveBeenCalledTimes(1);
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
