// features/firstrun/screens/permissions.js — Task 5 of the mobile Phase 2c
// plan. Second screen in the first-run overlay: three rows (camera,
// notifications, location), each with explanatory copy + an "Allow" button
// that triggers the matching helper in features/firstrun/permissions.js.
// The helper drives a native permission prompt via the Phase 2b
// abstractions; granting updates the row UI, denying surfaces a soft
// warning. A footer "Continue" or "Skip" button always advances to the
// integrations step — every row is optional and the flow stays fully
// skippable per the plan.
//
// Auto-advance on web: the browser handles permission prompts inline at
// first capability use, so this screen has no role in the browser PWA or
// the server-mode build. We check Capacitor.isNativePlatform() (the same
// helper Phase 2b uses to pick web vs. capacitor impls) and call
// helpers.advance('features') immediately when it returns false.
//
// Location intentionally has no current caller — Phase 2b noted no feature
// reads coords yet. Including it here lets the user grant it once for a
// future travel-aware feature without having to dig into device settings
// later. The copy reflects that.
(function () {
    'use strict';

    var ROWS = [
        {
            id: 'camera',
            label: 'Camera',
            copy: 'We use the camera to log food photos. You can change this any time in Settings.',
            request: function () { return window.WGFirstRun.permissions.requestCamera(); },
        },
        {
            id: 'notifications',
            label: 'Notifications',
            copy: 'We send reminders when it’s time to take your medications.',
            request: function () { return window.WGFirstRun.permissions.requestNotifications(); },
        },
        {
            id: 'location',
            label: 'Location',
            copy: 'We don’t use this yet; this enables a future travel-aware feature.',
            request: function () { return window.WGFirstRun.permissions.requestLocation(); },
        },
    ];

    function _isNative() {
        try {
            var cap = window.Capacitor;
            if (!cap || typeof cap.isNativePlatform !== 'function') return false;
            return Boolean(cap.isNativePlatform());
        } catch (_) {
            return false;
        }
    }

    function _renderRow(row) {
        var el = document.createElement('div');
        el.className = 'wg-firstrun-permission';
        el.setAttribute('data-firstrun-permission', row.id);

        var label = document.createElement('div');
        label.className = 'wg-firstrun-permission__label';
        label.textContent = row.label;
        el.appendChild(label);

        var copy = document.createElement('p');
        copy.className = 'wg-firstrun-permission__copy';
        copy.textContent = row.copy;
        el.appendChild(copy);

        var status = document.createElement('p');
        status.className = 'wg-firstrun-permission__status';
        status.setAttribute('data-firstrun-permission-status', row.id);
        el.appendChild(status);

        var allow = document.createElement('button');
        allow.type = 'button';
        allow.className = 'wg-firstrun-btn wg-firstrun-btn--primary';
        allow.textContent = 'Allow';
        allow.setAttribute('data-firstrun-action', 'allow-' + row.id);
        allow.addEventListener('click', function () {
            allow.disabled = true;
            Promise.resolve(row.request()).then(function (result) {
                if (result && result.granted) {
                    status.textContent = 'Allowed';
                    el.classList.add('wg-firstrun-permission--granted');
                    // Successful grant locks the button — re-prompting after
                    // a grant is either a no-op or surfaces a confusing
                    // "already granted" dialog on some Android versions.
                    return;
                }
                var denied = result && result.reason === 'PERMISSION_DENIED';
                status.textContent = denied
                    ? 'Permission denied — you can enable this later in your device settings.'
                    : 'Couldn’t request access. You can try again from Settings.';
                el.classList.add('wg-firstrun-permission--denied');
                // Re-enable so a transient failure (plugin missing, OS
                // dialog interrupted) lets the user try once more before
                // skipping.
                allow.disabled = false;
            }).catch(function () {
                // Defensive: the helper already catches inside _resolveGrant,
                // but if a future caller swaps it out for a stricter API we
                // still want to leave the row in a recoverable state.
                status.textContent = 'Couldn’t request access. You can try again from Settings.';
                el.classList.add('wg-firstrun-permission--denied');
                allow.disabled = false;
            });
        });
        el.appendChild(allow);

        return el;
    }

    function render(body, helpers) {
        if (!_isNative()) {
            // On web builds the browser handles permission prompts inline at
            // first capability use; this screen has no role. Advance
            // synchronously so the orchestrator re-renders into the next
            // step without ever painting permission rows the user would
            // have to dismiss.
            helpers.advance('features');
            return;
        }

        var intro = document.createElement('p');
        intro.className = 'wg-firstrun-screen__tagline';
        intro.textContent = 'Grant the permissions you’d like to use. Each is optional and you can change them later in Settings.';
        body.appendChild(intro);

        var rows = document.createElement('div');
        rows.className = 'wg-firstrun-permissions';
        for (var i = 0; i < ROWS.length; i++) {
            rows.appendChild(_renderRow(ROWS[i]));
        }
        body.appendChild(rows);

        var actions = document.createElement('div');
        actions.className = 'wg-firstrun-actions';

        var cont = document.createElement('button');
        cont.type = 'button';
        cont.className = 'wg-firstrun-btn wg-firstrun-btn--primary';
        cont.textContent = 'Continue';
        cont.setAttribute('data-firstrun-action', 'continue');
        cont.addEventListener('click', function () {
            helpers.advance('features');
        });

        var skip = document.createElement('button');
        skip.type = 'button';
        skip.className = 'wg-firstrun-btn wg-firstrun-btn--secondary';
        skip.textContent = 'Skip';
        skip.setAttribute('data-firstrun-action', 'skip');
        skip.addEventListener('click', function () {
            helpers.advance('features');
        });

        actions.appendChild(cont);
        actions.appendChild(skip);
        body.appendChild(actions);
    }

    window.WGFirstRun = window.WGFirstRun || {};
    window.WGFirstRun.screens = window.WGFirstRun.screens || {};
    window.WGFirstRun.screens.permissions = {
        title: 'Permissions',
        render: render,
    };
})();
