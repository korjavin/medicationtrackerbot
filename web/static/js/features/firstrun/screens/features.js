// features/firstrun/screens/features.js — feature picker step (med-4pz.2).
// Sits between "welcome" and "integrations": the user chooses which
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
// immediately, one POST per flip. The `fetch` fallback exists only for
// the Vitest harness, which loads the firstrun modules alone (same reason
// integrations.js carries one — see its _patch helper).
//
// Continue persists an EXPLICIT boolean for all six, not just the deviations
// (med-t05.1). web/domain/settings.js DEFAULT_FEATURES is all-on and
// getFeatures() spreads it under the stored flags, so a feature this screen
// showed UNCHECKED but never wrote would come back ON. Per-flip writes alone
// cannot fix that: a user who accepts the defaults flips nothing, writes
// nothing, and gets all-on. DEFAULT_FEATURES itself must stay all-on — it is
// also the fallback for existing accounts that never wrote a features record,
// and flipping it would strip sections from current users.
//
// Failure semantics mirror the Settings UI: a rejected write reverts the
// checkbox to its previous value and surfaces one inline message, so the
// overlay never shows a toggle whose state the server disagrees with.
(function () {
    'use strict';

    var FEATURES_URL = '/api/settings/features';

    // `on` is the first-run pre-check state (owner call, med-t05.1): the three
    // low-friction daily-logging sections start on; the three that only pay off
    // with a device, a prescription, or a clinical reason start off.
    var CATALOG = [
        {
            key: 'medication',
            label: 'Medications',
            copy: 'Track doses, courses, and refill reminders.',
            on: false,
        },
        {
            key: 'bp',
            label: 'Blood pressure',
            copy: 'Log readings and watch trends over time.',
            on: false,
        },
        {
            key: 'weight',
            label: 'Weight',
            copy: 'Record weigh-ins and see the moving average.',
            on: true,
        },
        {
            key: 'food',
            label: 'Food',
            copy: 'Log meals and daily calorie and macro targets.',
            on: true,
        },
        {
            key: 'workout',
            label: 'Workouts',
            copy: 'Plan sessions, log exercises, and track progress.',
            on: true,
        },
        {
            key: 'health',
            label: 'Vitals',
            copy: 'Sleep, heart rate, and other wearable data.',
            on: false,
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

    // What the box shows on mount. A user resuming the wizard, or one whose
    // account already has flags, sees their own state; everyone else sees the
    // first-run pre-check set. Reads the mirror directly rather than through
    // _isEnabled, whose absent-mirror answer is the all-on *fallback* default.
    function _initialChecked(item) {
        var flags = window.featureSettings;
        if (flags && typeof flags === 'object' && typeof flags[item.key] === 'boolean') {
            return flags[item.key];
        }
        return item.on;
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

    // Writes every row's current state, one at a time. Sequential is required,
    // not just tidy: the cloud shim's setFeature (web/domain/settings.js) reads
    // the whole flags map, mutates one key, and puts it back, so concurrent
    // writes would last-write-wins each other's keys away.
    function _persistAll(rows) {
        return rows.reduce(function (chain, row) {
            return chain.then(function () {
                return _writeFeature(row.key, row.toggle.checked);
            });
        }, Promise.resolve());
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
        toggle.checked = _initialChecked(item);
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
        var picked = [];
        for (var i = 0; i < CATALOG.length; i++) {
            var rowEl = _renderRow(CATALOG[i], error);
            rows.appendChild(rowEl);
            picked.push({
                key: CATALOG[i].key,
                toggle: rowEl.querySelector('[data-firstrun-feature-toggle]'),
            });
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
            cont.disabled = true;
            error.textContent = '';
            _persistAll(picked)
                .then(function () {
                    helpers.advance('integrations');
                })
                .catch(function () {
                    // Advancing here would leave the unchecked features silently
                    // ON, since an unwritten flag falls back to DEFAULT_FEATURES.
                    // Better to stay put and let the user retry.
                    cont.disabled = false;
                    error.textContent = 'Couldn’t save your choices. Check your connection and try again — you can also adjust features later in Settings.';
                });
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
