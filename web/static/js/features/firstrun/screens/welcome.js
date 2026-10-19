// features/firstrun/screens/welcome.js — Task 4 of the mobile Phase 2c
// plan. First screen in the first-run overlay: short product pitch +
// "Get started" (advances to the features step) and "Skip all"
// (POSTs /api/firstrun/complete and dismisses — unless the free AI trial
// is on offer, which it shows first; bd med-js3k, see index.js _skipAll).
//
// Registration model: the screen attaches itself to
// `window.WGFirstRun.screens.welcome` as `{ title, render }`. The
// orchestrator (features/firstrun/index.js) looks up the screen by
// the current step name returned from state.getStep() and calls
// `render(body, helpers)` after clearing the body container. Helpers
// are `{ advance(stepName), complete(), skipAll(), dismiss() }` — see index.js.
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
        primary.className = 'wg-btn wg-btn--primary wg-btn--lg wg-btn--block';
        primary.textContent = 'Get started';
        primary.setAttribute('data-firstrun-action', 'advance');
        primary.addEventListener('click', function () {
            helpers.advance('features');
        });

        const secondary = document.createElement('button');
        secondary.type = 'button';
        secondary.className = 'wg-btn wg-btn--ghost wg-btn--lg wg-btn--block';
        secondary.textContent = 'Skip all';
        secondary.setAttribute('data-firstrun-action', 'skip-all');
        secondary.addEventListener('click', function () {
            if (secondary.disabled) return;
            secondary.disabled = true;
            helpers.skipAll();
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
