// Web impl of the Bluetooth abstraction — Heart Rate slice (med-byks.1 POC,
// pulling the HR surface of med-byks.3 forward).
//
// The ONLY file in the tree allowed to touch navigator.bluetooth
// (CLAUDE.md rule 10, enforced by architecture.native-abstractions.test.js).
// Feature code talks to window.Bluetooth and never sees GATT handles:
// requestHeartRateDevice() shows the browser chooser filtered to the
// standard Heart Rate service 0x180D and resolves with plain { id, name }
// data; subscribeHeartRate() connects, enables 0x2A37 (Heart Rate
// Measurement) notifications, and delivers parsed { bpm, contact,
// timestamp } readings to the caller's onReading callback.
//
// Permission model (matters for the POC writeup): the chooser grant is
// per-origin per-device and survives disconnects, so after a
// gattserverdisconnected event the impl keeps the device handle and a later
// subscribeHeartRate() reconnects WITHOUT re-showing the chooser. Only an
// explicit unsubscribe() (user Disconnect) drops the handle and forces the
// chooser again. Chromium-only API: isSupported() is false where
// navigator.bluetooth is absent (Safari/iOS, Firefox) and feature code hides
// its UI on that, never throws.
//
// Errors are normalized to a { name: 'BluetoothError', code, message }
// shape. Codes: NOT_SUPPORTED (no Web Bluetooth), NOT_FOUND (chooser
// dismissed or no matching advertiser), NO_DEVICE (subscribe with no chosen
// device — call requestHeartRateDevice first), UNAVAILABLE (connect/service/
// notification failures and anything else; message carries the detail).
//
// Load order: must be after web/static/js/native/index.js so the foundation's
// registerImpl helper is available.
(function () {
    'use strict';

    // GATT identifiers as the string aliases the Web Bluetooth API accepts
    // ('heart_rate' = 0x180D, 'heart_rate_measurement' = 0x2A37). The filter
    // alone grants access to 0x180D, so no optionalServices list is needed —
    // the impl never touches any other service.
    var HEART_RATE_SERVICE = 'heart_rate';
    var HEART_RATE_MEASUREMENT = 'heart_rate_measurement';

    function bluetoothError(code, message) {
        var err = new Error(message);
        err.name = 'BluetoothError';
        err.code = code;
        return err;
    }

    function normalizeError(e) {
        var msg = (e && e.message) ? String(e.message) : 'Bluetooth error';
        var name = e && e.name ? String(e.name) : '';
        var code = 'UNAVAILABLE';
        if (/NotFoundError/i.test(name)) {
            // Chooser dismissed, or no advertiser matched the 0x180D filter.
            code = 'NOT_FOUND';
        } else if (/NotSupportedError/i.test(name)) {
            code = 'NOT_SUPPORTED';
        }
        return bluetoothError(code, msg);
    }

    // Probed at call time, not module load: the property is installed late by
    // some Chromium builds, and is absent entirely outside secure contexts.
    function isSupported() {
        try {
            return !!(window.navigator && window.navigator.bluetooth);
        } catch (_) {
            return false;
        }
    }

    function bluetoothOrNull() {
        return isSupported() ? window.navigator.bluetooth : null;
    }

    // Parse one Heart Rate Measurement (0x2A37) notification payload.
    // Layout (Bluetooth SIG HRS 1.0): byte 0 flags — bit 0 selects the HR
    // format (0: uint8 at byte 1, 1: uint16 LE at bytes 1-2), bits 1-2 the
    // sensor-contact status, bit 3 energy-expended present (uint16 follows the
    // HR bytes), bit 4 RR-intervals present (uint16 LE each, 1/1024 s units,
    // follow the energy field when present). Returns
    // { bpm, contact, rrIntervals } with contact one of
    // 'unknown' | 'absent' | 'detected' and rrIntervals in whole ms (possibly
    // empty). Throws a BluetoothError on a truncated payload; the notification
    // handler drops that single datagram rather than killing the stream.
    function parseHeartRateMeasurement(value) {
        if (!value || typeof value.byteLength !== 'number' || value.byteLength < 2) {
            throw bluetoothError('UNAVAILABLE', 'Truncated heart-rate measurement');
        }
        var flags = value.getUint8(0);
        var offset = 1;
        var bpm;
        if (flags & 0x01) {
            if (value.byteLength < 3) {
                throw bluetoothError('UNAVAILABLE', 'Truncated 16-bit heart-rate measurement');
            }
            bpm = value.getUint16(1, true);
            offset = 3;
        } else {
            bpm = value.getUint8(1);
            offset = 2;
        }
        var contactBits = (flags >> 1) & 0x03;
        var contact = contactBits === 3 ? 'detected' : (contactBits === 2 ? 'absent' : 'unknown');
        if (flags & 0x08) {
            // Energy Expended (uint16 kJ) — parsed past, not surfaced: the POC
            // only needs live bpm.
            offset += 2;
        }
        var rrIntervals = [];
        if (flags & 0x10) {
            while (offset + 1 < value.byteLength) {
                var raw = value.getUint16(offset, true);
                rrIntervals.push(Math.round(raw * 1000 / 1024));
                offset += 2;
            }
        }
        return { bpm: bpm, contact: contact, rrIntervals: rrIntervals };
    }

    // Chosen-but-not-subscribed device from requestHeartRateDevice(), retained
    // across gattserverdisconnected so a later subscribe reconnects without
    // the chooser. Cleared only by an explicit unsubscribe().
    var pendingDevice = null;
    // Live subscription { device, characteristic, notifyHandler,
    // disconnectHandler, onReading, onDisconnect }, or null when idle.
    var active = null;

    function deviceInfo(device) {
        return {
            id: (device && device.id) || '',
            name: (device && device.name) || '',
        };
    }

    function stopActiveQuietly() {
        if (!active) return;
        var sub = active;
        active = null;
        try {
            if (sub.characteristic && typeof sub.characteristic.removeEventListener === 'function') {
                sub.characteristic.removeEventListener('characteristicvaluechanged', sub.notifyHandler);
            }
        } catch (_) { /* teardown is best-effort */ }
        try {
            if (sub.characteristic && typeof sub.characteristic.stopNotifications === 'function') {
                var stopped = sub.characteristic.stopNotifications();
                if (stopped && typeof stopped.catch === 'function') stopped.catch(function () {});
            }
        } catch (_) { /* teardown is best-effort */ }
        try {
            if (sub.device && typeof sub.device.removeEventListener === 'function') {
                sub.device.removeEventListener('gattserverdisconnected', sub.disconnectHandler);
            }
        } catch (_) { /* teardown is best-effort */ }
        try {
            if (sub.device && sub.device.gatt && typeof sub.device.gatt.disconnect === 'function') {
                sub.device.gatt.disconnect();
            }
        } catch (_) { /* teardown is best-effort */ }
    }

    function requestHeartRateDevice() {
        var bt = bluetoothOrNull();
        if (!bt) {
            return Promise.reject(bluetoothError(
                'NOT_SUPPORTED',
                'Web Bluetooth is not available in this browser'
            ));
        }
        return bt.requestDevice({ filters: [{ services: [HEART_RATE_SERVICE] }] })
            .then(function (device) {
                pendingDevice = device;
                return deviceInfo(device);
            })
            .catch(function (e) {
                throw (e && e.name === 'BluetoothError') ? e : normalizeError(e);
            });
    }

    // callbacks: { onReading({ bpm, contact, rrIntervals, timestamp }),
    //             onDisconnect({ id, name }) } — onDisconnect is optional and
    // fires on an unsolicited gattserverdisconnected (an explicit
    // unsubscribe() never calls it). Resolves with { id, name } once
    // notifications are flowing. A previous live subscription is torn down
    // first so back-to-back subscribes (Reconnect) cannot stack listeners.
    function subscribeHeartRate(callbacks) {
        if (!callbacks || typeof callbacks.onReading !== 'function') {
            return Promise.reject(bluetoothError(
                'UNAVAILABLE',
                'Bluetooth.subscribeHeartRate(web): callbacks.onReading is required'
            ));
        }
        var device = (active && active.device) || pendingDevice;
        if (!device) {
            return Promise.reject(bluetoothError(
                'NO_DEVICE',
                'No heart-rate device chosen — call requestHeartRateDevice first'
            ));
        }
        stopActiveQuietly();
        var onReading = callbacks.onReading;
        var onDisconnect = callbacks.onDisconnect;
        var sub = { device: device, characteristic: null, onReading: onReading };
        sub.notifyHandler = function (event) {
            var target = event && event.target;
            var value = target && target.value;
            var parsed;
            try {
                parsed = parseHeartRateMeasurement(value);
            } catch (_) {
                return; // one malformed datagram must not kill the stream
            }
            try {
                onReading({
                    bpm: parsed.bpm,
                    contact: parsed.contact,
                    rrIntervals: parsed.rrIntervals,
                    timestamp: Date.now(),
                });
            } catch (_) { /* caller errors must not break the listener */ }
        };
        sub.disconnectHandler = function () {
            // Unsolicited drop: keep the device as pendingDevice so the next
            // subscribe reconnects without the chooser, but only when this
            // event belongs to the still-current subscription (a racing
            // unsubscribe() already nulled `active` and cleared the device).
            if (active !== sub) return;
            active = null;
            pendingDevice = device;
            try {
                if (sub.characteristic && typeof sub.characteristic.removeEventListener === 'function') {
                    sub.characteristic.removeEventListener('characteristicvaluechanged', sub.notifyHandler);
                }
            } catch (_) { /* ignore */ }
            if (typeof onDisconnect === 'function') {
                try { onDisconnect(deviceInfo(device)); } catch (_) { /* ignore */ }
            }
        };
        var gatt = device.gatt;
        if (!gatt || typeof gatt.connect !== 'function') {
            return Promise.reject(bluetoothError('UNAVAILABLE', 'Device has no GATT server'));
        }
        return gatt.connect()
            .then(function (server) { return server.getPrimaryService(HEART_RATE_SERVICE); })
            .then(function (service) { return service.getCharacteristic(HEART_RATE_MEASUREMENT); })
            .then(function (characteristic) {
                sub.characteristic = characteristic;
                characteristic.addEventListener('characteristicvaluechanged', sub.notifyHandler);
                if (typeof device.addEventListener === 'function') {
                    device.addEventListener('gattserverdisconnected', sub.disconnectHandler);
                }
                active = sub;
                return characteristic.startNotifications().then(function () {
                    return deviceInfo(device);
                });
            })
            .catch(function (e) {
                stopActiveQuietly();
                pendingDevice = device; // a failed connect keeps the grant for retry
                throw (e && e.name === 'BluetoothError') ? e : normalizeError(e);
            });
    }

    // Best-effort teardown that always resolves: true when a live
    // subscription or a chosen device was dropped, false when already idle.
    // Drops the retained device handle, so the next session re-shows the
    // chooser — unlike an unsolicited disconnect, which preserves it.
    function unsubscribe() {
        var had = !!(active || pendingDevice);
        stopActiveQuietly();
        pendingDevice = null;
        return Promise.resolve(had);
    }

    var impl = {
        isSupported: isSupported,
        requestHeartRateDevice: requestHeartRateDevice,
        subscribeHeartRate: subscribeHeartRate,
        unsubscribe: unsubscribe,
    };

    if (window.Bluetooth && window.Bluetooth.__native && typeof window.Bluetooth.__native.registerImpl === 'function') {
        window.Bluetooth.__native.registerImpl('Bluetooth', 'web', impl);
    }
})();
