// Integration tests for the Phase 2b Task 7 abstraction seam in
// features/food/scanner.js. Pins the contract that scanner.js calls into
// window.Barcode.scan and window.MediaCapture.pickPhoto, and that a decoded
// rawValue still routes into the food form fields (the existing handler
// chain — onFoodBarcodeChange + safeAlert + closeFoodScannerModal — is
// unchanged by the refactor).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('features/food/scanner.js — Phase 2b abstraction seam (Task 7)', () => {
    let env;
    let consoleErrorSpy;

    beforeEach(() => {
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        env = loadFrontendEnv();
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

    it('openPhotoPickerAndDecode → MediaCapture.pickPhoto → Barcode.scan routes a numeric barcode into #food-barcode', async () => {
        const { window, document } = env;

        // Fake the abstraction seam: pickPhoto returns a Blob, Barcode.scan
        // returns a decoded EAN-13.
        const fakeFile = new window.Blob(['x'], { type: 'image/jpeg' });
        const pickPhotoSpy = vi.fn().mockResolvedValue(fakeFile);
        const scanSpy = vi.fn().mockResolvedValue({ format: 'ean_13', rawValue: '1234567890123' });
        window.MediaCapture = { pickPhoto: pickPhotoSpy };
        window.Barcode = { scan: scanSpy };

        // Wire spies on the downstream callbacks so we know handleDecodedValue
        // ran end-to-end after the decode.
        const onChangeSpy = vi.fn();
        window.onFoodBarcodeChange = onChangeSpy;

        // Open the modal so closeFoodScannerModal has something to close.
        window.openFoodScannerModal();
        const modal = document.getElementById('food-scanner-modal');
        expect(modal.classList.contains('hidden')).toBe(false);

        await window.openPhotoPickerAndDecode();

        expect(pickPhotoSpy).toHaveBeenCalledTimes(1);
        // capture: false so mobile browsers don't force the camera and the
        // user can pick an existing barcode photo from their gallery.
        expect(pickPhotoSpy).toHaveBeenCalledWith({ capture: false });
        expect(scanSpy).toHaveBeenCalledTimes(1);
        // Barcode.scan is called with { source: <blob>, formats: [...] }.
        const scanArg = scanSpy.mock.calls[0][0];
        expect(scanArg.source).toBe(fakeFile);
        expect(Array.isArray(scanArg.formats)).toBe(true);
        expect(scanArg.formats).toContain('ean_13');

        // Decoded value lands in #food-barcode and onFoodBarcodeChange fires.
        expect(document.getElementById('food-barcode').value).toBe('1234567890123');
        expect(onChangeSpy).toHaveBeenCalledTimes(1);
        // The scanner modal closes after a successful decode.
        expect(modal.classList.contains('hidden')).toBe(true);
    });

    it('openPhotoPickerAndDecode bails out silently when MediaCapture.pickPhoto returns null', async () => {
        const { window } = env;

        const pickPhotoSpy = vi.fn().mockResolvedValue(null);
        const scanSpy = vi.fn();
        window.MediaCapture = { pickPhoto: pickPhotoSpy };
        window.Barcode = { scan: scanSpy };

        await window.openPhotoPickerAndDecode();

        expect(pickPhotoSpy).toHaveBeenCalledTimes(1);
        // No file => no decode attempt.
        expect(scanSpy).not.toHaveBeenCalled();
    });

    it('openPhotoPickerAndDecode shows "No barcode/QR found" when Barcode.scan returns null', async () => {
        const { window, document } = env;

        const fakeFile = new window.Blob(['x'], { type: 'image/jpeg' });
        window.MediaCapture = { pickPhoto: vi.fn().mockResolvedValue(fakeFile) };
        window.Barcode = { scan: vi.fn().mockResolvedValue(null) };

        const alertSpy = vi.fn();
        window.safeAlert = alertSpy;

        await window.openPhotoPickerAndDecode();

        const status = document.getElementById('food-scanner-status');
        expect(status.innerText).toMatch(/no barcode\/qr found/i);
        expect(alertSpy).toHaveBeenCalledWith('No barcode or QR code found in the selected photo.');
    });

    it('openPhotoPickerAndDecode surfaces decode errors with an alert', async () => {
        const { window, document } = env;

        const fakeFile = new window.Blob(['x'], { type: 'image/jpeg' });
        window.MediaCapture = { pickPhoto: vi.fn().mockResolvedValue(fakeFile) };
        window.Barcode = { scan: vi.fn().mockRejectedValue(new Error('decode crashed')) };

        const alertSpy = vi.fn();
        window.safeAlert = alertSpy;

        await window.openPhotoPickerAndDecode();

        const status = document.getElementById('food-scanner-status');
        expect(status.innerText).toMatch(/failed to decode/i);
        expect(alertSpy).toHaveBeenCalledWith('Could not decode barcode/QR from image.');
    });

    it('scanFrameLoop calls window.Barcode.scan({ source: video }) per tick and dispatches the decoded value', async () => {
        const { window, document } = env;

        const video = document.getElementById('food-scanner-video');
        // JSDOM video.readyState defaults to 0; force it past HAVE_CURRENT_DATA
        // so the loop's "wait for stream" guard doesn't short-circuit.
        Object.defineProperty(video, 'readyState', { configurable: true, value: 4 });

        const scanSpy = vi.fn().mockResolvedValue({ format: 'ean_13', rawValue: '1234567890123' });
        window.Barcode = { scan: scanSpy };

        const onChangeSpy = vi.fn();
        window.onFoodBarcodeChange = onChangeSpy;

        // Open + arm the loop, then call it manually (one tick) so we don't
        // depend on the setTimeout chain.
        window.openFoodScannerModal();
        window.FoodScanner._setRunning(true);
        await window.scanFrameLoop();

        expect(scanSpy).toHaveBeenCalledTimes(1);
        const scanArg = scanSpy.mock.calls[0][0];
        expect(scanArg.source).toBe(video);
        expect(Array.isArray(scanArg.formats)).toBe(true);

        // handleDecodedValue ran end-to-end.
        expect(document.getElementById('food-barcode').value).toBe('1234567890123');
        expect(onChangeSpy).toHaveBeenCalledTimes(1);
    });

    it('scanFrameLoop does not write to the form if the scanner was stopped while the decode was in flight', async () => {
        const { window, document } = env;

        const video = document.getElementById('food-scanner-video');
        Object.defineProperty(video, 'readyState', { configurable: true, value: 4 });

        // Pin a known sentinel value so we can prove the loop did not overwrite
        // the field after the user dismissed the modal.
        const barcodeField = document.getElementById('food-barcode');
        barcodeField.value = 'PRE-EXISTING';

        // The mocked decode resolves with a barcode AFTER the test flips
        // _setRunning(false) — simulating the user closing the modal between
        // when scanFrameLoop kicked off Barcode.scan and when the decode
        // resolved.
        const scanSpy = vi.fn().mockImplementation(() => {
            window.FoodScanner._setRunning(false);
            return Promise.resolve({ format: 'ean_13', rawValue: '9999999999999' });
        });
        window.Barcode = { scan: scanSpy };

        const onChangeSpy = vi.fn();
        window.onFoodBarcodeChange = onChangeSpy;

        window.openFoodScannerModal();
        window.FoodScanner._setRunning(true);
        await window.scanFrameLoop();

        expect(scanSpy).toHaveBeenCalledTimes(1);
        // Form field untouched, onFoodBarcodeChange not invoked — the late
        // decode result was dropped because the scanner had already been
        // stopped while the await was in flight.
        expect(barcodeField.value).toBe('PRE-EXISTING');
        expect(onChangeSpy).not.toHaveBeenCalled();
        // The loop also did not schedule a follow-up tick once it saw the
        // running flag was cleared.
        expect(window.FoodScanner._getLoopTimer()).toBeNull();
    });

    it('scanFrameLoop swallows Barcode.scan errors and re-arms the next tick', async () => {
        const { window, document } = env;

        const video = document.getElementById('food-scanner-video');
        Object.defineProperty(video, 'readyState', { configurable: true, value: 4 });

        const scanSpy = vi.fn().mockRejectedValue(new Error('boom'));
        window.Barcode = { scan: scanSpy };

        // Reset state before opening so the test doesn't pick up a residual
        // running flag from prior cases.
        window.FoodScanner._setRunning(false);
        window.openFoodScannerModal();
        window.FoodScanner._setRunning(true);
        await window.scanFrameLoop();

        expect(scanSpy).toHaveBeenCalledTimes(1);
        // Loop scheduled a follow-up timer (post-error continuation).
        expect(window.FoodScanner._getLoopTimer()).not.toBeNull();
        window.stopFoodScanner();
    });

    it('startFoodScanner routes through window.Barcode.scan on the Capacitor shell (no modal, no getUserMedia)', async () => {
        const { window } = env;

        // Simulate the Capacitor build's runtime: isNativePlatform() returns
        // true so the scanner should hand control to MLKit instead of opening
        // the in-app live-camera modal.
        window.Capacitor = { isNativePlatform: () => true };

        const scanSpy = vi.fn().mockResolvedValue({ format: 'ean_13', rawValue: '1234567890123' });
        window.Barcode = { scan: scanSpy };

        const onChangeSpy = vi.fn();
        window.onFoodBarcodeChange = onChangeSpy;

        // If the scanner accidentally falls through to the web modal path it
        // would call getUserMedia; spy to assert that does NOT happen.
        const getUserMedia = vi.fn();
        const origMediaDevices = window.navigator.mediaDevices;
        Object.defineProperty(window.navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia },
        });

        try {
            await window.startFoodScanner();
            expect(scanSpy).toHaveBeenCalledTimes(1);
            // No source means "let the plugin own the UI" — MLKit on Android.
            const arg = scanSpy.mock.calls[0][0];
            expect(arg.source).toBeUndefined();
            expect(Array.isArray(arg.formats)).toBe(true);
            // Decoded value lands in #food-barcode through handleDecodedValue.
            expect(env.document.getElementById('food-barcode').value).toBe('1234567890123');
            expect(onChangeSpy).toHaveBeenCalledTimes(1);
            // Web modal path is NOT taken — getUserMedia stays untouched.
            expect(getUserMedia).not.toHaveBeenCalled();
        } finally {
            Object.defineProperty(window.navigator, 'mediaDevices', {
                configurable: true,
                value: origMediaDevices,
            });
        }
    });

    it('Capacitor scanner closes the empty in-app modal when the user cancels MLKit (returns null)', async () => {
        // Repro: ModalManager.foodScanner.open() reveals #food-scanner-modal
        // and then calls startFoodScanner(). On Capacitor the scanner delegates
        // to MLKit's full-screen overlay, but if the user backs out without
        // scanning anything the in-app modal must close — otherwise the user
        // stares at an empty surface they can't visually dismiss.
        const { window, document } = env;

        window.Capacitor = { isNativePlatform: () => true };
        const scanSpy = vi.fn().mockResolvedValue(null);
        window.Barcode = { scan: scanSpy };

        const modal = document.getElementById('food-scanner-modal');
        modal.classList.remove('hidden');

        await window.startFoodScanner();

        expect(scanSpy).toHaveBeenCalledTimes(1);
        expect(modal.classList.contains('hidden')).toBe(true);
    });

    it('Capacitor scanner closes the in-app modal when MLKit throws (permission denied, etc.)', async () => {
        const { window, document } = env;

        window.Capacitor = { isNativePlatform: () => true };
        const scanSpy = vi.fn().mockRejectedValue(new Error('permission denied'));
        window.Barcode = { scan: scanSpy };
        const origAlert = window.alert;
        window.alert = vi.fn();

        const modal = document.getElementById('food-scanner-modal');
        modal.classList.remove('hidden');

        try {
            await window.startFoodScanner();
            expect(modal.classList.contains('hidden')).toBe(true);
        } finally {
            window.alert = origAlert;
        }
    });
});
