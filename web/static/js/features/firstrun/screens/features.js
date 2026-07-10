// features/firstrun/screens/features.js — feature picker step (med-4pz.2).
// Sits between "permissions" and "integrations": the user chooses which
// tracking sections they want *before* the BYO-keys screen, because the
// keys only matter for features they kept (the food-DB key is pointless
// with food off).
//
// Catalog scope — the six *tracking* sections, deliberately not every key
// in web/domain/settings.js's DEFAULT_FEATURES:
//   - `gamification` is absent from the cloud shim's PORTED_SET
//     (web/cloud/js/apishim.js:161), so POSTing `enabled:true` there is
//     rejected with a null return and the toggle would silently snap back.
//   - `weekly_digest` is a bot-only Telegram summary, meaningless in the
//     cloud/mobile shells this overlay runs in, and defaults to off.
// The remaining six are exactly PORTED_SET, so every row in this screen
// can actually be turned on in every build that renders the overlay.
//
// Write path: reuse the Settings global `toggleFeatureSetting` rather than
// re-POSTing by hand — it owns the whole write (POST
// /api/settings/features/<key>, SettingsState mirror, bottom-nav rebuild,
// DataStore tag invalidation, tab-visibility sync). Toggles write through
// immediately, one POST per flip; defaults are all-on so a user who keeps
// everything issues zero requests. The `fetch` fallback exists only for
// the Vitest harness, which loads the firstrun modules alone (same reason
// integrations.js carries one — see its _patch helper).
//
// Failure semantics mirror the Settings UI: a rejected write reverts the
// checkbox to its previous value and surfaces one inline message, so the
// overlay never shows a toggle whose state the server disagrees with.
(function () {
    'use strict';

    var FEATURES_URL = '/api/settings/features';

    var CATALOG = [
        {
            key: 'medication',
            label: 'Medications',
            copy: 'Track doses, courses, and refill reminders.',
        },
        {
            key: 'bp',
            label: 'Blood pressure',
            copy: 'Log readings and watch trends over time.',
        },
        {
            key: 'weight',
            label: 'Weight',
            copy: 'Record weigh-ins and see the moving average.',
        },
        {
            key: 'food',
            label: 'Food',
            copy: 'Log meals and daily calorie and macro targets.',
        },
        {
            key: 'workout',
            label: 'Workouts',
            copy: 'Plan sessions, log exercises, and track progress.',
        },
        {
            key: 'health',
            label: 'Vitals',
            copy: 'Sleep, heart rate, and other wearable data.',
        },
    ];

    // Defaults are all-on (web/domain/settings.js DEFAULT_FEATURES), so an
    // absent mirror means "everything enabled", not "everything off".
    function _isEnabled(key) {
        var flags = window.featureSettings;
        if (!flags || typeof flags !== 'object') return true;
        if (typeof flags[key] !== 'boolean') return true;
        return flags[key];
    }

    function _writeFeature(key, enabled) {
        if (typeof window.toggleFeatureSetting === 'function') {
            // Resolves whether or not the POST succeeded; it reverts the
            // Settings DOM itself but tells us nothing, so re-read the
            // mirror below to find out what actually stuck.
            return Promise.resolve(window.toggleFeatureSetting(key, enabled))
                .then(function () {
                    if (_isEnabled(key) !== enabled) throw new Error('rejected');
                });
        }
        return window.fetch(FEATURES_URL + '/' + encodeURIComponent(key), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: enabled }),
        }).then(function (resp) {
            if (!resp || !resp.ok) throw new Error('rejected');
        });
    }

    function _renderRow(item, error) {
        var el = document.createElement('div');
        el.className = 'wg-firstrun-feature';
        el.setAttribute('data-firstrun-feature', item.key);

        var text = document.createElement('div');
        text.className = 'wg-firstrun-feature__text';

        var label = document.createElement('label');
        label.className = 'wg-firstrun-feature__label';
        label.setAttribute('for', 'firstrun-feature-' + item.key);
        label.textContent = item.label;
        text.appendChild(label);

        var copy = document.createElement('p');
        copy.className = 'wg-firstrun-feature__copy';
        copy.textContent = item.copy;
        text.appendChild(copy);

        el.appendChild(text);

        var toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.id = 'firstrun-feature-' + item.key;
        toggle.className = 'wg-firstrun-feature__toggle';
        toggle.checked = _isEnabled(item.key);
        toggle.setAttribute('data-firstrun-feature-toggle', item.key);
        toggle.addEventListener('change', function () {
            var desired = toggle.checked;
            toggle.disabled = true;
            error.textContent = '';
            _writeFeature(item.key, desired)
                .catch(function () {
                    toggle.checked = !desired;
                    error.textContent = 'Couldn’t save that change. It stays as it was — you can adjust features later in Settings.';
                })
                .then(function () {
                    toggle.disabled = false;
                });
        });
        el.appendChild(toggle);

        return el;
    }

    function render(body, helpers) {
        var intro = document.createElement('p');
        intro.className = 'wg-firstrun-screen__tagline';
        intro.textContent = 'Turn off anything you don’t need. Disabled sections disappear from the navigation — you can change this any time in Settings.';
        body.appendChild(intro);

        var error = document.createElement('p');
        error.className = 'wg-firstrun-form__error';
        error.setAttribute('data-firstrun-feature-error', '');

        var rows = document.createElement('div');
        rows.className = 'wg-firstrun-features';
        for (var i = 0; i < CATALOG.length; i++) {
            rows.appendChild(_renderRow(CATALOG[i], error));
        }
        body.appendChild(rows);
        body.appendChild(error);

        var actions = document.createElement('div');
        actions.className = 'wg-firstrun-actions';

        var cont = document.createElement('button');
        cont.type = 'button';
        cont.className = 'wg-firstrun-btn wg-firstrun-btn--primary';
        cont.textContent = 'Continue';
        cont.setAttribute('data-firstrun-action', 'continue');
        cont.addEventListener('click', function () {
            helpers.advance('integrations');
        });

        actions.appendChild(cont);
        body.appendChild(actions);
    }

    window.WGFirstRun = window.WGFirstRun || {};
    window.WGFirstRun.screens = window.WGFirstRun.screens || {};
    window.WGFirstRun.screens.features = {
        title: 'What do you want to track?',
        render: render,
        CATALOG: CATALOG,
    };
})();
