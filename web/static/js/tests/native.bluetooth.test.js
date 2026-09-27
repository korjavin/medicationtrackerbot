/**
 * native.bluetooth.test.js
 *
 * Pins the Bluetooth abstraction contract (HR slice, med-byks.1, show-all
 * mode med-byks.7): a web impl that owns the only navigator.bluetooth call
 * site, shows the chooser filtered to the Heart Rate service 0x180D (or
 * unfiltered with { all: true }), maps a missing 0x180D to NO_SERVICE, and
 * delivers parsed 0x2A37 readings — feature code never sees GATT handles.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const NATIVE_INDEX_JS = path.join(REPO_ROOT, 'web/static/js/native/index.js');
const WEB_BT_JS = path.join(REPO_ROOT, 'web/static/js/native/web/bluetooth.js');

function loadEnv({ bluetooth } = {}) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'http://app.example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    if (bluetooth !== undefined) {
        Object.defineProperty(window.navigator, 'bluetooth', {
            value: bluetooth,
            configurable: true,
        });
    }
    const evalFile = (file) => {
        const src = fs.readFileSync(file, 'utf8');
        window.eval(`${src}\n//# sourceURL=file://${file}`);
    };
    evalFile(NATIVE_INDEX_JS);
    evalFile(WEB_BT_JS);
    return { window, cleanup: () => dom.window.close() };
}

function loadStubOnlyEnv() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'http://app.example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    const src = fs.readFileSync(NATIVE_INDEX_JS, 'utf8');
    window.eval(`${src}\n//# sourceURL=file://${NATIVE_INDEX_JS}`);
    return { window, cleanup: () => dom.window.close() };
}

function namedError(name, message) {
    const e = new Error(message);
    e.name = name;
    return e;
}

function makeListeners() {
    const handlers = new Map();
    return {
        addEventListener: vi.fn((type, fn) => {
            handlers.set(type, fn);
        }),
        removeEventListener: vi.fn((type) => {
            handlers.delete(type);
        }),
        emit: (type, event) => {
            const fn = handlers.get(type);
            if (fn) fn(event);
        },
        has: (type) => handlers.has(type),
    };
}

// Fake GATT chain: device -> server -> service -> characteristic, wired so
// device.gatt.connect() resolves through to the characteristic. `services`
// is the UUID list the fake server's getPrimaryServices() reports.
function makeFakeDevice({ id = 'dev-1', name = 'Mi Band 7', services = ['heart_rate'] } = {}) {
    const charListeners = makeListeners();
    const deviceListeners = makeListeners();
    const characteristic = {
        ...charListeners,
        startNotifications: vi.fn(() => Promise.resolve()),
        stopNotifications: vi.fn(() => Promise.resolve()),
        _listeners: charListeners,
    };
    const service = {
        getCharacteristic: vi.fn(() => Promise.resolve(characteristic)),
    };
    const server = {
        getPrimaryService: vi.fn(() => Promise.resolve(service)),
        getPrimaryServices: vi.fn(() => Promise.resolve(services.map((uuid) => ({ uuid })))),
    };
    const gatt = {
        connect: vi.fn(() => Promise.resolve(server)),
        disconnect: vi.fn(),
    };
    const device = {
        id,
        name,
        gatt,
        ...deviceListeners,
        _listeners: deviceListeners,
        _characteristic: characteristic,
        _service: service,
        _server: server,
    };
    return device;
}

function hrPayload(bytes) {
    return new DataView(new Uint8Array(bytes).buffer);
}

function notify(characteristic, bytes) {
    characteristic._listeners.emit('characteristicvaluechanged', {
        target: { value: hrPayload(bytes) },
    });
}

describe('native/web/bluetooth.js — web impl', () => {
    let env;
    afterEach(() => { if (env) env.cleanup(); env = null; });

    it('is registered as window.Bluetooth with the HR-only surface', () => {
        env = loadEnv({ bluetooth: { requestDevice: vi.fn() } });
        const webImpl = env.window.Bluetooth.__native.getImpl('Bluetooth', 'web');
        expect(env.window.Bluetooth).toBe(webImpl);
        for (const method of ['isSupported', 'requestHeartRateDevice', 'subscribeHeartRate', 'unsubscribe']) {
            expect(typeof env.window.Bluetooth[method]).toBe('function');
        }
    });

    it('stub throws NotImplementedError before the web impl registers', () => {
        env = loadStubOnlyEnv();
        let caught;
        try { env.window.Bluetooth.isSupported(); } catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('NotImplementedError');
        expect(caught.capability).toBe('Bluetooth');
        expect(caught.method).toBe('isSupported');
    });

    it('isSupported is false without navigator.bluetooth (Safari/iOS/Firefox)', () => {
        env = loadEnv();
        expect(env.window.Bluetooth.isSupported()).toBe(false);
    });

    it('isSupported is true when navigator.bluetooth exists', () => {
        env = loadEnv({ bluetooth: { requestDevice: vi.fn() } });
        expect(env.window.Bluetooth.isSupported()).toBe(true);
    });

    it('requestHeartRateDevice filters the chooser to the heart_rate service', async () => {
        const device = makeFakeDevice();
        const requestDevice = vi.fn(() => Promise.resolve(device));
        env = loadEnv({ bluetooth: { requestDevice } });
        const info = await env.window.Bluetooth.requestHeartRateDevice();
        expect(requestDevice).toHaveBeenCalledTimes(1);
        expect(requestDevice).toHaveBeenCalledWith({ filters: [{ services: ['heart_rate'] }] });
        expect(info).toEqual({ id: 'dev-1', name: 'Mi Band 7' });
    });

    it('requestHeartRateDevice rejects NOT_SUPPORTED without Web Bluetooth', async () => {
        env = loadEnv();
        const err = await env.window.Bluetooth.requestHeartRateDevice().catch((e) => e);
        expect(err.name).toBe('BluetoothError');
        expect(err.code).toBe('NOT_SUPPORTED');
    });

    it('requestHeartRateDevice maps a dismissed chooser to NOT_FOUND', async () => {
        const requestDevice = vi.fn(() => Promise.reject(namedError('NotFoundError', 'User cancelled')));
        env = loadEnv({ bluetooth: { requestDevice } });
        const err = await env.window.Bluetooth.requestHeartRateDevice().catch((e) => e);
        expect(err.name).toBe('BluetoothError');
        expect(err.code).toBe('NOT_FOUND');
    });

    it('subscribeHeartRate rejects NO_DEVICE before any chooser grant', async () => {
        env = loadEnv({ bluetooth: { requestDevice: vi.fn() } });
        const err = await env.window.Bluetooth
            .subscribeHeartRate({ onReading: () => {} })
            .catch((e) => e);
        expect(err.name).toBe('BluetoothError');
        expect(err.code).toBe('NO_DEVICE');
    });

    it('subscribeHeartRate rejects without an onReading callback', async () => {
        const device = makeFakeDevice();
        const requestDevice = vi.fn(() => Promise.resolve(device));
        env = loadEnv({ bluetooth: { requestDevice } });
        await env.window.Bluetooth.requestHeartRateDevice();
        const err = await env.window.Bluetooth.subscribeHeartRate({}).catch((e) => e);
        expect(err.name).toBe('BluetoothError');
    });

    it('subscribe connects GATT and resolves once notifications flow', async () => {
        const device = makeFakeDevice();
        const requestDevice = vi.fn(() => Promise.resolve(device));
        env = loadEnv({ bluetooth: { requestDevice } });
        await env.window.Bluetooth.requestHeartRateDevice();
        const info = await env.window.Bluetooth.subscribeHeartRate({ onReading: () => {} });
        expect(info).toEqual({ id: 'dev-1', name: 'Mi Band 7' });
        expect(device.gatt.connect).toHaveBeenCalledTimes(1);
        expect(device._server.getPrimaryService).toHaveBeenCalledWith('heart_rate');
        expect(device._service.getCharacteristic).toHaveBeenCalledWith('heart_rate_measurement');
        expect(device._characteristic.startNotifications).toHaveBeenCalledTimes(1);
    });

    it('delivers 8-bit bpm readings with contact + timestamp', async () => {
        const device = makeFakeDevice();
        env = loadEnv({ bluetooth: { requestDevice: vi.fn(() => Promise.resolve(device)) } });
        const onReading = vi.fn();
        await env.window.Bluetooth.requestHeartRateDevice();
        await env.window.Bluetooth.subscribeHeartRate({ onReading });
        notify(device._characteristic, [0x00, 72]);
        expect(onReading).toHaveBeenCalledTimes(1);
        const reading = onReading.mock.calls[0][0];
        expect(reading.bpm).toBe(72);
        expect(reading.contact).toBe('unknown');
        expect(reading.rrIntervals).toEqual([]);
        expect(typeof reading.timestamp).toBe('number');
    });

    it('parses 16-bit bpm when the flags byte selects it', async () => {
        const device = makeFakeDevice();
        env = loadEnv({ bluetooth: { requestDevice: vi.fn(() => Promise.resolve(device)) } });
        const onReading = vi.fn();
        await env.window.Bluetooth.requestHeartRateDevice();
        await env.window.Bluetooth.subscribeHeartRate({ onReading });
        notify(device._characteristic, [0x01, 0x2c, 0x01]); // 300 bpm LE
        expect(onReading).toHaveBeenCalledTimes(1);
        expect(onReading.mock.calls[0][0].bpm).toBe(300);
    });

    it('parses sensor-contact status bits', async () => {
        const device = makeFakeDevice();
        env = loadEnv({ bluetooth: { requestDevice: vi.fn(() => Promise.resolve(device)) } });
        const onReading = vi.fn();
        await env.window.Bluetooth.requestHeartRateDevice();
        await env.window.Bluetooth.subscribeHeartRate({ onReading });
        notify(device._characteristic, [0x06, 65]); // contact bits 11
        notify(device._characteristic, [0x04, 66]); // contact bits 10
        expect(onReading.mock.calls[0][0].contact).toBe('detected');
        expect(onReading.mock.calls[1][0].contact).toBe('absent');
    });

    it('parses RR intervals (and skips energy-expended) into whole ms', async () => {
        const device = makeFakeDevice();
        env = loadEnv({ bluetooth: { requestDevice: vi.fn(() => Promise.resolve(device)) } });
        const onReading = vi.fn();
        await env.window.Bluetooth.requestHeartRateDevice();
        await env.window.Bluetooth.subscribeHeartRate({ onReading });
        // flags 0x18: energy present + RR present; HR 8-bit; energy uint16;
        // one RR interval of 1024 ticks = 1000 ms.
        notify(device._characteristic, [0x18, 70, 0x10, 0x00, 0x00, 0x04]);
        expect(onReading).toHaveBeenCalledTimes(1);
        const reading = onReading.mock.calls[0][0];
        expect(reading.bpm).toBe(70);
        expect(reading.rrIntervals).toEqual([1000]);
    });

    it('drops a malformed datagram without killing the stream', async () => {
        const device = makeFakeDevice();
        env = loadEnv({ bluetooth: { requestDevice: vi.fn(() => Promise.resolve(device)) } });
        const onReading = vi.fn();
        await env.window.Bluetooth.requestHeartRateDevice();
        await env.window.Bluetooth.subscribeHeartRate({ onReading });
        notify(device._characteristic, [0x00]); // truncated: flags only
        expect(onReading).not.toHaveBeenCalled();
        notify(device._characteristic, [0x00, 71]);
        expect(onReading).toHaveBeenCalledTimes(1);
        expect(onReading.mock.calls[0][0].bpm).toBe(71);
    });

    it('fires onDisconnect on gattserverdisconnected and reconnects without the chooser', async () => {
        const device = makeFakeDevice();
        const requestDevice = vi.fn(() => Promise.resolve(device));
        env = loadEnv({ bluetooth: { requestDevice } });
        const onReading = vi.fn();
        const onDisconnect = vi.fn();
        await env.window.Bluetooth.requestHeartRateDevice();
        await env.window.Bluetooth.subscribeHeartRate({ onReading, onDisconnect });
        device._listeners.emit('gattserverdisconnected', {});
        expect(onDisconnect).toHaveBeenCalledTimes(1);
        expect(onDisconnect).toHaveBeenCalledWith({ id: 'dev-1', name: 'Mi Band 7' });
        // Reconnect: grant persists, so no second chooser.
        await env.window.Bluetooth.subscribeHeartRate({ onReading, onDisconnect });
        expect(requestDevice).toHaveBeenCalledTimes(1);
        expect(device.gatt.connect).toHaveBeenCalledTimes(2);
        notify(device._characteristic, [0x00, 74]);
        expect(onReading.mock.calls[onReading.mock.calls.length - 1][0].bpm).toBe(74);
    });

    it('unsubscribe tears down the subscription and resolves true, then false when idle', async () => {
        const device = makeFakeDevice();
        env = loadEnv({ bluetooth: { requestDevice: vi.fn(() => Promise.resolve(device)) } });
        await env.window.Bluetooth.requestHeartRateDevice();
        const onDisconnect = vi.fn();
        await env.window.Bluetooth.subscribeHeartRate({ onReading: () => {}, onDisconnect });
        expect(await env.window.Bluetooth.unsubscribe()).toBe(true);
        expect(device._characteristic.stopNotifications).toHaveBeenCalledTimes(1);
        expect(device.gatt.disconnect).toHaveBeenCalledTimes(1);
        expect(device._characteristic.removeEventListener)
            .toHaveBeenCalledWith('characteristicvaluechanged', expect.any(Function));
        // Explicit teardown is not an unsolicited drop.
        expect(onDisconnect).not.toHaveBeenCalled();
        expect(await env.window.Bluetooth.unsubscribe()).toBe(false);
    });

    it('requestHeartRateDevice({ all: true }) opens the unfiltered chooser with heart_rate optional', async () => {
        const device = makeFakeDevice();
        const requestDevice = vi.fn(() => Promise.resolve(device));
        env = loadEnv({ bluetooth: { requestDevice } });
        const info = await env.window.Bluetooth.requestHeartRateDevice({ all: true });
        expect(requestDevice).toHaveBeenCalledTimes(1);
        expect(requestDevice).toHaveBeenCalledWith({ acceptAllDevices: true, optionalServices: ['heart_rate'] });
        expect(info).toEqual({ id: 'dev-1', name: 'Mi Band 7' });
    });

    it('requestHeartRateDevice without all:true keeps the filtered chooser', async () => {
        const device = makeFakeDevice();
        const requestDevice = vi.fn(() => Promise.resolve(device));
        env = loadEnv({ bluetooth: { requestDevice } });
        await env.window.Bluetooth.requestHeartRateDevice({});
        await env.window.Bluetooth.requestHeartRateDevice({ all: false });
        expect(requestDevice).toHaveBeenCalledTimes(2);
        for (const call of requestDevice.mock.calls) {
            expect(call[0]).toEqual({ filters: [{ services: ['heart_rate'] }] });
        }
    });

    it('subscribe maps a missing 0x180D to NO_SERVICE, disconnects, and keeps the grant', async () => {
        const device = makeFakeDevice();
        device._server.getPrimaryService
            .mockRejectedValueOnce(namedError('NotFoundError', 'No such service'));
        const requestDevice = vi.fn(() => Promise.resolve(device));
        env = loadEnv({ bluetooth: { requestDevice } });
        await env.window.Bluetooth.requestHeartRateDevice({ all: true });
        const err = await env.window.Bluetooth
            .subscribeHeartRate({ onReading: () => {} })
            .catch((e) => e);
        expect(err.name).toBe('BluetoothError');
        expect(err.code).toBe('NO_SERVICE');
        expect(err.message).toContain('0x180D');
        // The failed subscribe leaves no stranded GATT connection ...
        expect(device.gatt.disconnect).toHaveBeenCalledTimes(1);
        // ... but the chooser grant survives for retry once HR broadcast is on.
        await env.window.Bluetooth.subscribeHeartRate({ onReading: () => {} });
        expect(requestDevice).toHaveBeenCalledTimes(1);
        expect(device.gatt.connect).toHaveBeenCalledTimes(2);
    });

    it('subscribe maps a non-NotFound service failure to UNAVAILABLE, not NO_SERVICE', async () => {
        const device = makeFakeDevice();
        device._server.getPrimaryService
            .mockRejectedValueOnce(namedError('NetworkError', 'link dropped'));
        env = loadEnv({ bluetooth: { requestDevice: vi.fn(() => Promise.resolve(device)) } });
        await env.window.Bluetooth.requestHeartRateDevice();
        const err = await env.window.Bluetooth
            .subscribeHeartRate({ onReading: () => {} })
            .catch((e) => e);
        expect(err.name).toBe('BluetoothError');
        expect(err.code).toBe('UNAVAILABLE');
    });

    it('subscribe reports the primary-services dump via onServices', async () => {
        const device = makeFakeDevice({ services: ['heart_rate', 'battery_service'] });
        env = loadEnv({ bluetooth: { requestDevice: vi.fn(() => Promise.resolve(device)) } });
        const onServices = vi.fn();
        await env.window.Bluetooth.requestHeartRateDevice();
        await env.window.Bluetooth.subscribeHeartRate({ onReading: () => {}, onServices });
        expect(device._server.getPrimaryServices).toHaveBeenCalledTimes(1);
        expect(onServices).toHaveBeenCalledTimes(1);
        expect(onServices).toHaveBeenCalledWith(['heart_rate', 'battery_service']);
    });

    it('subscribe continues when the services dump rejects', async () => {
        const device = makeFakeDevice();
        device._server.getPrimaryServices
            .mockRejectedValueOnce(namedError('SecurityError', 'denied'));
        env = loadEnv({ bluetooth: { requestDevice: vi.fn(() => Promise.resolve(device)) } });
        const onServices = vi.fn();
        const onReading = vi.fn();
        await env.window.Bluetooth.requestHeartRateDevice();
        await env.window.Bluetooth.subscribeHeartRate({ onReading, onServices });
        expect(onServices).not.toHaveBeenCalled();
        notify(device._characteristic, [0x00, 72]);
        expect(onReading).toHaveBeenCalledTimes(1);
    });

    it('subscribe continues when the server has no getPrimaryServices', async () => {
        const device = makeFakeDevice();
        delete device._server.getPrimaryServices;
        env = loadEnv({ bluetooth: { requestDevice: vi.fn(() => Promise.resolve(device)) } });
        const onReading = vi.fn();
        await env.window.Bluetooth.requestHeartRateDevice();
        await env.window.Bluetooth.subscribeHeartRate({ onReading, onServices: vi.fn() });
        notify(device._characteristic, [0x00, 73]);
        expect(onReading).toHaveBeenCalledTimes(1);
        expect(onReading.mock.calls[0][0].bpm).toBe(73);
    });

    it('a failed connect keeps the grant for retry and surfaces UNAVAILABLE', async () => {
        const device = makeFakeDevice();
        device.gatt.connect
            .mockRejectedValueOnce(namedError('NetworkError', 'connect failed'));
        const requestDevice = vi.fn(() => Promise.resolve(device));
        env = loadEnv({ bluetooth: { requestDevice } });
        await env.window.Bluetooth.requestHeartRateDevice();
        const err = await env.window.Bluetooth
            .subscribeHeartRate({ onReading: () => {} })
            .catch((e) => e);
        expect(err.name).toBe('BluetoothError');
        expect(err.code).toBe('UNAVAILABLE');
        // Retry reuses the grant: no second chooser.
        await env.window.Bluetooth.subscribeHeartRate({ onReading: () => {} });
        expect(requestDevice).toHaveBeenCalledTimes(1);
        expect(device.gatt.connect).toHaveBeenCalledTimes(2);
    });
});
