// Live heart rate (experimental) card — med-byks.1 POC.
//
// Mounted at the top of the Vitals overview when the `live_hr` feature flag
// is on AND window.Bluetooth.isSupported() is true; hidden otherwise
// (Safari/iOS/Firefox have no Web Bluetooth). All radio access goes through
// window.Bluetooth (CLAUDE.md rule 10) — this file never touches the raw
// browser Bluetooth API or GATT handles.
//
// The card is a hardware-test instrument for the owner, not a product
// surface: Connect opens the 0x180D chooser, live bpm renders while
// subscribed, and an in-memory session log (connect/disconnect events,
// time-to-first-reading, errors) can be copied for the go/no-go writeup in
// docs/research/mi-band-hr-poc.md. NOTHING persists: no hrsample writes, no
// apiCall, no DataStore, no localStorage. Product wiring is med-byks.4.
//
// Lifecycle: self-registers on window.AppKernel (onTabSwitch('health') +
// onAuth) and exposes window.LiveHR.refresh() as the manual seam. The card
// node lives directly under #health-overview-tab — NOT inside
// #health-overview-content, which loadHealthOverview() wipes on every
// render — so connection state survives overview repaints and range flips.
(function () {
    'use strict';

    var CARD_ID = 'live-hr-card';
    var MAX_LOG_LINES = 200;

    var state = {
        mounted: false,
        busy: false,
        connected: false,
        // True once requestHeartRateDevice resolved in this page session;
        // drives the Connect/Reconnect label (the chooser grant survives an
        // unsolicited drop, so a reconnect needs no chooser).
        hasDevice: false,
        deviceName: '',
        bpm: null,
        readings: 0,
        sessionStart: 0,
        connectT0: 0,
        ttfrMs: null,
        status: 'Disconnected',
        log: [],
    };

    var els = {};

    function bt() {
        if (typeof window === 'undefined' || !window.Bluetooth) return null;
        var cap = window.Bluetooth;
        if (typeof cap.isSupported !== 'function'
            || typeof cap.requestHeartRateDevice !== 'function'
            || typeof cap.subscribeHeartRate !== 'function'
            || typeof cap.unsubscribe !== 'function') {
            return null;
        }
        return cap;
    }

    function isFlagOn() {
        try {
            return !!(window.featureSettings && window.featureSettings.live_hr === true);
        } catch (_) {
            return false;
        }
    }

    function isSupported() {
        var cap = bt();
        if (!cap) return false;
        try {
            return cap.isSupported() === true;
        } catch (_) {
            return false;
        }
    }

    function fmtClock(ms) {
        try {
            return new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
        } catch (_) {
            return '';
        }
    }

    function fmtSecs(ms) {
        return (ms / 1000).toFixed(1) + 's';
    }

    function addLog(line) {
        state.log.push(fmtClock(Date.now()) + '  ' + line);
        if (state.log.length > MAX_LOG_LINES) {
            state.log.splice(0, state.log.length - MAX_LOG_LINES);
        }
        if (els.log) els.log.textContent = state.log.join('\n');
    }

    function notifyToast(msg) {
        try {
            if (window.SyncManager && typeof window.SyncManager.showToast === 'function') {
                window.SyncManager.showToast(msg, 'info');
                return;
            }
        } catch (_) { /* fall through */ }
        try {
            if (typeof safeAlert === 'function') safeAlert(msg);
        } catch (_) { /* last resort: silent */ }
    }

    function mk(tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function sessionSummary() {
        var secs = state.sessionStart ? Math.round((Date.now() - state.sessionStart) / 1000) : 0;
        return state.readings + ' readings over ' + secs + 's';
    }

    function render() {
        if (!els.card) return;
        els.status.textContent = state.status;
        els.bpm.textContent = state.bpm === null ? '—' : String(state.bpm);
        els.ttfr.textContent = 'Time to first reading: ' + (state.ttfrMs === null ? '—' : fmtSecs(state.ttfrMs));
        els.device.textContent = state.deviceName ? 'Device: ' + state.deviceName : '';
        els.readings.textContent = state.connected || state.readings > 0
            ? 'Readings: ' + state.readings
            : '';
        els.connect.textContent = state.hasDevice && !state.connected ? 'Reconnect' : 'Connect';
        els.connect.disabled = state.busy || state.connected;
        els.disconnect.classList.toggle('hidden', !state.connected && !state.busy);
        els.disconnect.disabled = state.busy;
        els.copy.disabled = state.log.length === 0;
        if (els.log) els.log.textContent = state.log.join('\n');
    }

    function setStatus(text) {
        state.status = text;
        if (els.status) els.status.textContent = text;
    }

    function ensureMounted() {
        if (state.mounted) return !!document.getElementById(CARD_ID);
        var host = document.getElementById('health-overview-tab');
        if (!host) return false;
        if (document.getElementById(CARD_ID)) {
            cacheEls();
            state.mounted = true;
            return true;
        }
        var card = mk('section', 'wg-card wg-live-hr hidden');
        card.id = CARD_ID;
        card.appendChild(mk('div', 'wg-section-label', 'EXPERIMENTAL'));
        card.appendChild(mk('div', 'wg-mono-display wg-live-hr__title', 'Live heart rate'));
        card.appendChild(mk('p', 'wg-live-hr__hint wg-muted',
            'On the band or its app, enable Discoverable + heart-rate broadcast first ' +
            '(Zepp Life / Mi Fitness). Readings stay on this page — nothing is saved.'));

        els.status = mk('div', 'wg-live-hr__status', state.status);
        els.status.id = 'live-hr-status';
        card.appendChild(els.status);

        var bpmRow = mk('div', 'wg-live-hr__bpm-row');
        els.bpm = mk('span', 'wg-mono-display wg-live-hr__bpm', '—');
        els.bpm.id = 'live-hr-bpm';
        bpmRow.appendChild(els.bpm);
        bpmRow.appendChild(mk('span', 'wg-live-hr__unit wg-muted', 'bpm'));
        card.appendChild(bpmRow);

        els.ttfr = mk('div', 'wg-live-hr__meta', 'Time to first reading: —');
        els.ttfr.id = 'live-hr-ttfr';
        card.appendChild(els.ttfr);
        els.device = mk('div', 'wg-live-hr__meta', '');
        els.device.id = 'live-hr-device';
        card.appendChild(els.device);
        els.readings = mk('div', 'wg-live-hr__meta', '');
        els.readings.id = 'live-hr-readings';
        card.appendChild(els.readings);

        var actions = mk('div', 'wg-live-hr__actions');
        els.connect = mk('button', 'wg-gloss wg-gloss--sun wg-live-hr__connect', 'Connect');
        els.connect.id = 'live-hr-connect-btn';
        els.connect.type = 'button';
        els.connect.addEventListener('click', onConnectClick);
        actions.appendChild(els.connect);
        els.disconnect = mk('button', 'wg-gloss wg-live-hr__disconnect hidden', 'Disconnect');
        els.disconnect.id = 'live-hr-disconnect-btn';
        els.disconnect.type = 'button';
        els.disconnect.addEventListener('click', onDisconnectClick);
        actions.appendChild(els.disconnect);
        els.copy = mk('button', 'wg-gloss wg-live-hr__copy', 'Copy log');
        els.copy.id = 'live-hr-copy-btn';
        els.copy.type = 'button';
        els.copy.addEventListener('click', onCopyClick);
        actions.appendChild(els.copy);
        card.appendChild(actions);

        els.log = mk('pre', 'wg-gloss--inset wg-live-hr__log', '');
        els.log.id = 'live-hr-log';
        els.log.setAttribute('aria-label', 'Live heart rate session log');
        card.appendChild(els.log);

        els.card = card;
        host.insertBefore(card, host.firstChild);
        state.mounted = true;
        render();
        return true;
    }

    function cacheEls() {
        els.card = document.getElementById(CARD_ID);
        els.status = document.getElementById('live-hr-status');
        els.bpm = document.getElementById('live-hr-bpm');
        els.ttfr = document.getElementById('live-hr-ttfr');
        els.device = document.getElementById('live-hr-device');
        els.readings = document.getElementById('live-hr-readings');
        els.connect = document.getElementById('live-hr-connect-btn');
        els.disconnect = document.getElementById('live-hr-disconnect-btn');
        els.copy = document.getElementById('live-hr-copy-btn');
        els.log = document.getElementById('live-hr-log');
    }

    function handleReading(reading) {
        // No connected-gate here on purpose: the impl attaches this listener
        // only for the lifetime of a subscription (removed synchronously on
        // every teardown path), so a delivered reading is definitionally live.
        // Gating on the startNotifications() resolution would drop a first
        // notification that wins the race and skew the TTFR measurement.
        state.readings += 1;
        state.bpm = reading.bpm;
        if (state.ttfrMs === null && state.connectT0) {
            state.ttfrMs = Date.now() - state.connectT0;
            addLog('first reading: ' + reading.bpm + ' bpm (TTFR ' + fmtSecs(state.ttfrMs) + ')');
        }
        render();
    }

    function handleDisconnect() {
        if (!state.connected) return;
        state.connected = false;
        addLog('disconnected by device (' + sessionSummary() + ') — grant kept, Reconnect needs no chooser');
        setStatus('Disconnected');
        render();
    }

    function onConnectClick() {
        var cap = bt();
        if (!cap || state.busy || state.connected) return;
        state.busy = true;
        render();
        var reconnect = state.hasDevice;
        setStatus(reconnect ? 'Reconnecting…' : 'Scanning for HR devices…');
        addLog(reconnect
            ? 'reconnect: reusing stored chooser grant (no chooser)'
            : 'connect: opening chooser (filter: heart_rate / 0x180D)');
        var pickedName = state.deviceName;
        var needPicker = !state.hasDevice;
        var picked = needPicker
            ? cap.requestHeartRateDevice().then(function (info) {
                state.hasDevice = true;
                pickedName = (info && info.name) || '(unnamed device)';
                state.deviceName = pickedName;
                addLog('device chosen: "' + pickedName + '"' + (info && info.id ? ' <' + info.id + '>' : ''));
            })
            : Promise.resolve();
        picked
            .then(function () {
                setStatus('Connecting…');
                state.connectT0 = Date.now();
                state.sessionStart = state.connectT0;
                state.readings = 0;
                state.ttfrMs = null;
                state.bpm = null;
                return cap.subscribeHeartRate({ onReading: handleReading, onDisconnect: handleDisconnect });
            })
            .then(function () {
                state.connected = true;
                addLog('subscribed: 0x2A37 notifications flowing');
                setStatus('Connected — listening…');
            })
            .catch(function (e) {
                var code = (e && e.code) || '';
                var msg = (e && e.message) || String(e);
                if (code === 'NOT_FOUND' && needPicker) {
                    state.hasDevice = false;
                    state.deviceName = '';
                    addLog('chooser dismissed or no 0x180D advertiser found');
                    setStatus('Disconnected');
                } else {
                    addLog('error: ' + msg + (code ? ' (' + code + ')' : ''));
                    setStatus('Error: ' + msg);
                }
            })
            .then(function () {
                state.busy = false;
                render();
            });
    }

    function onDisconnectClick() {
        var cap = bt();
        if (!cap || state.busy) return;
        state.busy = true;
        render();
        cap.unsubscribe()
            .catch(function () { /* teardown is best-effort */ })
            .then(function () {
                addLog('disconnected by user (' + sessionSummary() + ') — next session re-shows the chooser');
                state.connected = false;
                state.hasDevice = false;
                state.deviceName = '';
                setStatus('Disconnected');
                state.busy = false;
                render();
            });
    }

    function onCopyClick() {
        var text = state.log.join('\n');
        if (!text) {
            notifyToast('Log is empty — nothing to copy.');
            return;
        }
        var done = function () { notifyToast('Log copied (' + state.log.length + ' lines).'); };
        var fail = function () { notifyToast('Copy failed — select the log and copy it manually.'); };
        try {
            if (typeof navigator !== 'undefined' && navigator.clipboard
                && typeof navigator.clipboard.writeText === 'function') {
                navigator.clipboard.writeText(text).then(done, fail);
            } else {
                fail();
            }
        } catch (_) {
            fail();
        }
    }

    // Release the radio when the card hides mid-session (flag flipped off
    // while connected); the in-memory log is kept either way.
    function teardownQuietly() {
        var cap = bt();
        state.connected = false;
        state.hasDevice = false;
        state.deviceName = '';
        setStatus('Disconnected');
        if (cap) {
            try {
                cap.unsubscribe().catch(function () {});
            } catch (_) { /* ignore */ }
        }
    }

    function refresh() {
        if (!ensureMounted()) return;
        var show = isFlagOn() && isSupported();
        if (!show && (state.connected || state.hasDevice)) teardownQuietly();
        els.card.classList.toggle('hidden', !show);
        if (show) render();
    }

    function boot() {
        try {
            if (window.AppKernel && typeof window.AppKernel.register === 'function') {
                window.AppKernel.register('liveHR', {
                    onTabSwitch: function (tab) { if (tab === 'health') refresh(); },
                    onAuth: function () { refresh(); },
                });
            }
        } catch (_) { /* a missing kernel must not break the card's manual seam */ }
        refresh();
    }

    window.LiveHR = { refresh: refresh };

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', boot, { once: true });
        } else {
            boot();
        }
    }
})();
