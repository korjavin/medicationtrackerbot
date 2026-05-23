// features/firstrun/screens/welcome.js — Task 4 of the mobile Phase 2c
// plan. First screen in the first-run overlay: short product pitch +
// "Get started" (advances to the permissions step) and "Skip all"
// (calls POST /api/firstrun/complete and dismisses without touching
// any further screens). The flow is fully skippable per the plan.
//
// Registration model: the screen attaches itself to
// `window.WGFirstRun.screens.welcome` as `{ title, render }`. The
// orchestrator (features/firstrun/index.js) looks up the screen by
// the current step name returned from state.getStep() and calls
// `render(body, helpers)` after clearing the body container. Helpers
// are `{ advance(stepName), complete(), dismiss() }` — see index.js.
(function () {
    'use strict';

    function render(body, helpers) {
        const tagline = document.createElement('p');
        tagline.className = 'wg-firstrun-screen__tagline';
        tagline.textContent = 'Track medications, vitals, food, workouts, and more — all in one place. Let\'s get a few things set up.';
        body.appendChild(tagline);

        const actions = document.createElement('div');
        actions.className = 'wg-firstrun-actions';

        const primary = document.createElement('button');
        primary.type = 'button';
        primary.className = 'wg-firstrun-btn wg-firstrun-btn--primary';
        primary.textContent = 'Get started';
        primary.setAttribute('data-firstrun-action', 'advance');
        primary.addEventListener('click', function () {
            helpers.advance('permissions');
        });

        const secondary = document.createElement('button');
        secondary.type = 'button';
        secondary.className = 'wg-firstrun-btn wg-firstrun-btn--secondary';
        secondary.textContent = 'Skip all';
        secondary.setAttribute('data-firstrun-action', 'skip-all');
        secondary.addEventListener('click', function () {
            helpers.complete();
        });

        actions.appendChild(primary);
        actions.appendChild(secondary);
        body.appendChild(actions);
    }

    window.WGFirstRun = window.WGFirstRun || {};
    window.WGFirstRun.screens = window.WGFirstRun.screens || {};
    window.WGFirstRun.screens.welcome = {
        title: 'Welcome to MedTracker',
        render: render,
    };
})();
