// features/firstrun/screens/done.js — Task 4 of the mobile Phase 2c
// plan. Final screen in the first-run overlay: a confirmation that
// setup is complete, plus a single "Open app" button. Pressing it
// calls POST /api/firstrun/complete (via helpers.complete()) and
// dismisses the overlay. The orchestrator's complete() flips the
// in-memory bootstrap flag to false so a re-mount on the same
// payload is a no-op; the next server-side bootstrap will see
// settings.first_run_complete = 1 and return needs_first_run: false
// for every subsequent launch.
(function () {
    'use strict';

    function render(body, helpers) {
        const message = document.createElement('p');
        message.className = 'wg-firstrun-screen__tagline';
        message.textContent = 'You\'re all set. You can adjust permissions and integrations any time from Settings.';
        body.appendChild(message);

        const actions = document.createElement('div');
        actions.className = 'wg-firstrun-actions';

        const primary = document.createElement('button');
        primary.type = 'button';
        primary.className = 'wg-firstrun-btn wg-firstrun-btn--primary';
        primary.textContent = 'Open app';
        primary.setAttribute('data-firstrun-action', 'open-app');
        primary.addEventListener('click', function () {
            helpers.complete();
        });

        actions.appendChild(primary);
        body.appendChild(actions);
    }

    window.WGFirstRun = window.WGFirstRun || {};
    window.WGFirstRun.screens = window.WGFirstRun.screens || {};
    window.WGFirstRun.screens.done = {
        title: 'You\'re all set',
        render: render,
    };
})();
