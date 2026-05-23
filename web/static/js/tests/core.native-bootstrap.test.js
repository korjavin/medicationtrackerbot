/**
 * core.native-bootstrap.test.js
 *
 * Pins two behaviors of web/static/js/core/native-bootstrap.js:
 *   1. The MedtrackerNative shim mirrors apiBase() into
 *      window.__MEDTRACKER_BOOTSTRAP__ (Phase 2a Task 5).
 *   2. The reminder pre-schedule loop is started after DOMContentLoaded when
 *      window.Capacitor.isNativePlatform() is true (Phase 2b Task 5 wiring —
 *      without this, the Capacitor build's headline LocalNotifications feature
 *      never fires because nothing schedules anything).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const NATIVE_BOOTSTRAP_JS = path.join(REPO_ROOT, 'web/static/js/core/native-bootstrap.js');

function loadEnv({ medtrackerNative, capacitor, reminders, readyState = 'loading' } = {}) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'http://app.example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    if (medtrackerNative !== undefined) window.MedtrackerNative = medtrackerNative;
    if (capacitor !== undefined) window.Capacitor = capacitor;
    if (reminders !== undefined) window.Reminders = reminders;
    // JSDOM defaults to 'complete' for documents created with outside-only
    // runScripts. Force the readyState so DOMContentLoaded is the trigger we
    // exercise rather than the immediate-fire shortcut.
    Object.defineProperty(window.document, 'readyState', {
        configurable: true,
        get: () => readyState,
    });
    const src = fs.readFileSync(NATIVE_BOOTSTRAP_JS, 'utf8');
    window.eval(`${src}\n//# sourceURL=file://${NATIVE_BOOTSTRAP_JS}`);
    return { window, cleanup: () => dom.window.close() };
}

describe('native-bootstrap.js — MedtrackerNative apiBase shim', () => {
    let env;
    afterEach(() => { if (env) env.cleanup(); env = null; });

    it('mirrors MedtrackerNative.apiBase() into window.__MEDTRACKER_BOOTSTRAP__', () => {
        env = loadEnv({ medtrackerNative: { apiBase: () => 'http://127.0.0.1:34567' } });
        expect(env.window.__MEDTRACKER_BOOTSTRAP__).toEqual({ apiBase: 'http://127.0.0.1:34567' });
    });

    it('is a no-op when MedtrackerNative is absent (browser PWA / server mode)', () => {
        env = loadEnv();
        expect(env.window.__MEDTRACKER_BOOTSTRAP__).toBeUndefined();
    });
});

describe('native-bootstrap.js — reminder pre-schedule loop startup', () => {
    let env;
    afterEach(() => { if (env) env.cleanup(); env = null; });

    it('calls window.Reminders.startPreScheduleLoop() on DOMContentLoaded under Capacitor', () => {
        const startPreScheduleLoop = vi.fn();
        env = loadEnv({
            capacitor: { isNativePlatform: () => true },
            reminders: { startPreScheduleLoop },
        });
        // Before DOMContentLoaded fires, the bootstrap listens but hasn't run.
        expect(startPreScheduleLoop).not.toHaveBeenCalled();
        env.window.document.dispatchEvent(new env.window.Event('DOMContentLoaded'));
        expect(startPreScheduleLoop).toHaveBeenCalledTimes(1);
    });

    it('does not start the loop when isNativePlatform() is false (browser PWA)', () => {
        const startPreScheduleLoop = vi.fn();
        env = loadEnv({
            capacitor: { isNativePlatform: () => false },
            reminders: { startPreScheduleLoop },
        });
        env.window.document.dispatchEvent(new env.window.Event('DOMContentLoaded'));
        expect(startPreScheduleLoop).not.toHaveBeenCalled();
    });

    it('does not throw when window.Capacitor is absent', () => {
        const startPreScheduleLoop = vi.fn();
        env = loadEnv({ reminders: { startPreScheduleLoop } });
        expect(() => env.window.document.dispatchEvent(new env.window.Event('DOMContentLoaded'))).not.toThrow();
        expect(startPreScheduleLoop).not.toHaveBeenCalled();
    });

    it('does not throw when window.Reminders is absent (impls failed to load)', () => {
        env = loadEnv({ capacitor: { isNativePlatform: () => true } });
        expect(() => env.window.document.dispatchEvent(new env.window.Event('DOMContentLoaded'))).not.toThrow();
    });

    it('fires immediately when document.readyState is already past loading', () => {
        const startPreScheduleLoop = vi.fn();
        env = loadEnv({
            capacitor: { isNativePlatform: () => true },
            reminders: { startPreScheduleLoop },
            readyState: 'complete',
        });
        // The bootstrap detects readyState !== 'loading' and runs synchronously.
        expect(startPreScheduleLoop).toHaveBeenCalledTimes(1);
    });
});
