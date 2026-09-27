/**
 * live-hr.test.js
 *
 * Owns the Live-HR card (features/live-hr.js, med-byks.1 POC): the
 * experimental Vitals card behind the `live_hr` flag. Mocks
 * window.Bluetooth (the profile-level seam — the card never sees GATT) and
 * pins the two chooser modes (filtered Connect vs show-all, med-byks.7),
 * the NO_SERVICE log line, and the primary-services log line.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const LIVE_HR_JS = path.join(REPO_ROOT, 'web/static/js/features/live-hr.js');

function bluetoothError(code, message) {
    const e = new Error(message);
    e.name = 'BluetoothError';
    e.code = code;
    return e;
}

function loadLiveHrEnv() {
    const env = loadFrontendEnv();
    const src = fs.readFileSync(LIVE_HR_JS, 'utf8');
    env.window.eval(`${src}\n//# sourceURL=file://${LIVE_HR_JS}`);
    // Flag on, Chromium-like radio present.
    env.window.featureSettings = { ...(env.window.featureSettings || {}), live_hr: true };
    const bt = {
        isSupported: vi.fn(() => true),
        requestHeartRateDevice: vi.fn(() => Promise.resolve({ id: 'dev-1', name: 'Mi Band 7' })),
        subscribeHeartRate: vi.fn(() => Promise.resolve({ id: 'dev-1', name: 'Mi Band 7' })),
        unsubscribe: vi.fn(() => Promise.resolve(true)),
    };
    env.window.Bluetooth = bt;
    env.window.LiveHR.refresh();
    return { env, bt };
}

// Flush the card's promise chains (request → subscribe → render).
async function flush() {
    for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

function logText(env) {
    return env.document.getElementById('live-hr-log').textContent;
}

describe('features/live-hr.js — live-HR card', () => {
    let loaded;
    afterEach(() => { if (loaded) loaded.env.cleanup(); loaded = null; });

    it('mounts Connect + Show all devices when the flag is on and Bluetooth is supported', () => {
        loaded = loadLiveHrEnv();
        const { env } = loaded;
        const card = env.document.getElementById('live-hr-card');
        expect(card).not.toBeNull();
        expect(card.classList.contains('hidden')).toBe(false);
        const connect = env.document.getElementById('live-hr-connect-btn');
        const showAll = env.document.getElementById('live-hr-show-all-btn');
        expect(connect).not.toBeNull();
        expect(connect.textContent).toBe('Connect');
        expect(showAll).not.toBeNull();
        expect(showAll.textContent).toBe('Show all devices');
    });

    it('stays hidden when the flag is off', () => {
        loaded = loadLiveHrEnv();
        const { env } = loaded;
        env.window.featureSettings = { ...(env.window.featureSettings || {}), live_hr: false };
        env.window.LiveHR.refresh();
        expect(env.document.getElementById('live-hr-card').classList.contains('hidden')).toBe(true);
    });

    it('Connect uses the filtered chooser and logs the mode', async () => {
        loaded = loadLiveHrEnv();
        const { env, bt } = loaded;
        env.document.getElementById('live-hr-connect-btn').click();
        await flush();
        expect(bt.requestHeartRateDevice).toHaveBeenCalledTimes(1);
        expect(bt.requestHeartRateDevice).toHaveBeenCalledWith(undefined);
        expect(bt.subscribeHeartRate).toHaveBeenCalledTimes(1);
        const log = logText(env);
        expect(log).toContain('filter: heart_rate / 0x180D');
        expect(log).toContain('device chosen: "Mi Band 7" <dev-1> (mode: filter)');
        expect(log).toContain('subscribed: 0x2A37 notifications flowing');
        expect(env.document.getElementById('live-hr-status').textContent).toBe('Connected — listening…');
    });

    it('Show all devices passes { all: true } and logs show-all mode', async () => {
        loaded = loadLiveHrEnv();
        const { env, bt } = loaded;
        env.document.getElementById('live-hr-show-all-btn').click();
        await flush();
        expect(bt.requestHeartRateDevice).toHaveBeenCalledTimes(1);
        expect(bt.requestHeartRateDevice).toHaveBeenCalledWith({ all: true });
        const log = logText(env);
        expect(log).toContain('show all devices; optionalServices: heart_rate');
        expect(log).toContain('device chosen: "Mi Band 7" <dev-1> (mode: show-all)');
    });

    it('Show all devices re-opens the chooser even with a stored grant', async () => {
        loaded = loadLiveHrEnv();
        const { env, bt } = loaded;
        env.document.getElementById('live-hr-connect-btn').click();
        await flush();
        // Simulate an unsolicited drop: the card keeps the grant ...
        bt.subscribeHeartRate.mock.calls[0][0].onDisconnect({ id: 'dev-1', name: 'Mi Band 7' });
        expect(env.document.getElementById('live-hr-connect-btn').textContent).toBe('Reconnect');
        // ... yet Show all devices still opens a fresh chooser.
        env.document.getElementById('live-hr-show-all-btn').click();
        await flush();
        expect(bt.requestHeartRateDevice).toHaveBeenCalledTimes(2);
        expect(bt.requestHeartRateDevice).toHaveBeenLastCalledWith({ all: true });
    });

    it('NO_SERVICE logs the actionable line, never throws, and keeps the grant', async () => {
        loaded = loadLiveHrEnv();
        const { env, bt } = loaded;
        bt.subscribeHeartRate.mockRejectedValueOnce(
            bluetoothError('NO_SERVICE', '"Mi Band 7" has no heart_rate service (0x180D)')
        );
        env.document.getElementById('live-hr-show-all-btn').click();
        await flush();
        const log = logText(env);
        expect(log).toContain('Mi Band 7: no heart_rate service (0x180D) — enable HR broadcast on the band');
        expect(log).not.toContain('Error:');
        expect(env.document.getElementById('live-hr-status').textContent).toBe('No heart-rate service on Mi Band 7');
        // Grant kept: the next attempt reconnects without the chooser.
        expect(env.document.getElementById('live-hr-connect-btn').textContent).toBe('Reconnect');
        env.document.getElementById('live-hr-connect-btn').click();
        await flush();
        expect(bt.requestHeartRateDevice).toHaveBeenCalledTimes(1);
        expect(bt.subscribeHeartRate).toHaveBeenCalledTimes(2);
    });

    it('logs the primary-services dump via onServices', async () => {
        loaded = loadLiveHrEnv();
        const { env, bt } = loaded;
        bt.subscribeHeartRate.mockImplementation((callbacks) => {
            callbacks.onServices(['heart_rate', 'battery_service']);
            return Promise.resolve({ id: 'dev-1', name: 'Mi Band 7' });
        });
        env.document.getElementById('live-hr-connect-btn').click();
        await flush();
        expect(logText(env)).toContain('primary services: heart_rate, battery_service');
    });

    it('dismissing the show-all chooser keeps a previously stored grant', async () => {
        loaded = loadLiveHrEnv();
        const { env, bt } = loaded;
        env.document.getElementById('live-hr-connect-btn').click();
        await flush();
        bt.subscribeHeartRate.mock.calls[0][0].onDisconnect({ id: 'dev-1', name: 'Mi Band 7' });
        bt.requestHeartRateDevice.mockRejectedValueOnce(bluetoothError('NOT_FOUND', 'User cancelled'));
        env.document.getElementById('live-hr-show-all-btn').click();
        await flush();
        expect(logText(env)).toContain('show-all chooser dismissed — previous grant kept');
        expect(env.document.getElementById('live-hr-connect-btn').textContent).toBe('Reconnect');
    });
});
