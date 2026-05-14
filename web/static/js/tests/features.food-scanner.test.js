// Focused integration tests for the extracted features/food/scanner.js
// sub-file. Covers the closure-private scanner state exposed on
// window.FoodScanner and the open/close modal flows.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('features/food/scanner.js — split-file integration', () => {
    let env;
    let consoleErrorSpy;

    beforeEach(() => {
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        env = loadFrontendEnv();
        // JSDOM doesn't implement HTMLMediaElement.prototype.pause; stub it
        // up front so the close path doesn't blow up.
        const video = env.document.getElementById('food-scanner-video');
        if (video) {
            video.pause = vi.fn();
            video.srcObject = null;
        }
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('exposes the FoodScanner namespace with private state accessors', () => {
        const { window } = env;
        expect(window.FoodScanner).toBeTypeOf('object');
        expect(window.FoodScanner._isRunning()).toBe(false);
        expect(window.FoodScanner._getStream()).toBeNull();
        expect(window.FoodScanner._getLoopTimer()).toBeNull();
    });

    it('openFoodScannerModal toggles the modal visibility', () => {
        const { window, document } = env;
        const modal = document.getElementById('food-scanner-modal');
        expect(modal.classList.contains('hidden')).toBe(true);

        window.openFoodScannerModal();
        expect(modal.classList.contains('hidden')).toBe(false);
    });

    it('closeFoodScannerModal hides the modal', () => {
        const { window, document } = env;
        const modal = document.getElementById('food-scanner-modal');
        window.openFoodScannerModal();
        expect(modal.classList.contains('hidden')).toBe(false);

        window.closeFoodScannerModal();
        expect(modal.classList.contains('hidden')).toBe(true);
    });

    it('stopFoodScanner clears the running flag and any pending loop timer', () => {
        const { window } = env;
        window.FoodScanner._setRunning(true);
        const handle = setTimeout(() => {}, 1000);
        window.FoodScanner._setLoopTimer(handle);

        window.stopFoodScanner();

        expect(window.FoodScanner._isRunning()).toBe(false);
        expect(window.FoodScanner._getLoopTimer()).toBeNull();
    });

    it('setFoodScannerStatus writes a message into the status node', () => {
        const { window, document } = env;
        window.setFoodScannerStatus('Hello there');
        expect(document.getElementById('food-scanner-status').innerText).toBe('Hello there');
    });
});
