// Time-formatting utilities used by the Settings timezone/server-clock row.
// Loaded early (before app.js) — depends on nothing.
//
// The module owns a small piece of mutable state: the most recent server-time
// sample taken from a bootstrap bundle, used to render a "live" server clock
// without polling. Settings UI calls render() (with or without a fresh bundle)
// and ensureTimer() to start the 1Hz refresh.

window.TimeFormat = (function () {
    let _state = {
        timezone: '',
        serverTime: '',
        serverTimezone: '',
        serverOffsetMinutes: null,
        serverBaseMs: null,
        syncedAtMs: null,
    }; // module-state: settings time-info sample; updated by updateFromBundle()
    let _timer = null;

    function formatSettingsDateTime(date, timeZone) {
        const options = {
            dateStyle: 'medium',
            timeStyle: 'medium',
        };
        if (timeZone) options.timeZone = timeZone;
        try {
            return new Intl.DateTimeFormat(undefined, options).format(date);
        } catch (_) {
            return date.toLocaleString();
        }
    }

    function parseRFC3339OffsetMinutes(value) {
        if (!value || typeof value !== 'string') return null;
        if (value.endsWith('Z')) return 0;
        const match = value.match(/([+-])(\d{2}):(\d{2})$/);
        if (!match) return null;
        const sign = match[1] === '-' ? -1 : 1;
        return sign * (Number(match[2]) * 60 + Number(match[3]));
    }

    function formatFixedOffsetDateTime(date, offsetMinutes) {
        if (!(date instanceof Date) || Number.isNaN(date.getTime()) || typeof offsetMinutes !== 'number') {
            return 'Unavailable';
        }
        const shifted = new Date(date.getTime() + offsetMinutes * 60 * 1000);
        try {
            return new Intl.DateTimeFormat(undefined, {
                dateStyle: 'medium',
                timeStyle: 'medium',
                timeZone: 'UTC',
            }).format(shifted);
        } catch (_) {
            return shifted.toISOString().replace('T', ' ').replace('Z', '');
        }
    }

    function updateFromBundle(bundle) {
        _state.timezone = bundle?.timezone || '';
        _state.serverTimezone = bundle?.serverTimezone || '';
        if (bundle?.serverTime) {
            const parsed = Date.parse(bundle.serverTime);
            _state.serverTime = bundle.serverTime;
            _state.serverOffsetMinutes = parseRFC3339OffsetMinutes(bundle.serverTime);
            if (!Number.isNaN(parsed)) {
                _state.serverBaseMs = parsed;
                _state.syncedAtMs = Date.now();
            }
        }
    }

    function getLiveServerTime() {
        if (typeof _state.serverBaseMs !== 'number' || typeof _state.syncedAtMs !== 'number') {
            return null;
        }
        return new Date(_state.serverBaseMs + (Date.now() - _state.syncedAtMs));
    }

    function render(bundle) {
        if (bundle) updateFromBundle(bundle);

        const timezoneValue = document.getElementById('settings-timezone-value');
        const savedTimeValue = document.getElementById('settings-saved-time-value');
        const localTimeValue = document.getElementById('settings-local-time-value');
        const serverTimeValue = document.getElementById('settings-server-time-value');
        const timezoneNote = document.getElementById('settings-timezone-note');
        if (!timezoneValue || !savedTimeValue || !localTimeValue || !serverTimeValue || !timezoneNote) return;

        timezoneValue.textContent = _state.timezone || 'Not set';
        savedTimeValue.textContent = _state.timezone
            ? formatSettingsDateTime(new Date(), _state.timezone)
            : 'Unavailable until a timezone is saved';
        localTimeValue.textContent = formatSettingsDateTime(new Date());

        const serverNow = getLiveServerTime();
        serverTimeValue.textContent = serverNow
            ? `${formatFixedOffsetDateTime(serverNow, _state.serverOffsetMinutes)}${_state.serverTimezone ? ` • ${_state.serverTimezone}` : ''}`
            : 'Unavailable';

        timezoneNote.textContent = _state.timezone
            ? 'Saved timezone affects all reminders and medication schedules. Changing timezone may trigger a transition plan for gradual dose adjustment.'
            : 'No saved timezone yet. If the browser-detected timezone looks wrong, it will be visible here after the next confirmation.';
    }

    function ensureTimer() {
        if (_timer) return;
        _timer = window.setInterval(() => {
            render();
        }, 1000);
    }

    return {
        formatSettingsDateTime,
        parseRFC3339OffsetMinutes,
        formatFixedOffsetDateTime,
        render,
        ensureTimer,
        getLiveServerTime,
        updateFromBundle,
    };
})();

// Backwards-compat shim: existing call sites use window.renderSettingsTimeInfo.
window.renderSettingsTimeInfo = window.TimeFormat.render;
