// features/firstrun/screens/welcome.js — Task 4 of the mobile Phase 2c
// plan. First screen in the first-run overlay: short product pitch +
// "Get started" (advances to the features step) and "Skip all"
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
            helpers.complete();
        });

        actions.appendChild(primary);
        actions.appendChild(secondary);
        body.appendChild(actions);

        const vault = window.CloudVault;
        if (_onIOS() && vault && typeof vault.leaveAccount === 'function') {
            body.appendChild(_deviceOnly(vault));
        }
    }

    // iOS app, signed into an account (bd med-o7zq.30): the native first-run
    // offers "Only on this device", so this overlay — the account's own
    // first-run — offers the way there too. CloudVault.leaveAccount exists
    // only on the account origin (cloud-boot.js); local mode never shows it.
    function _onIOS() {
        const native = window.LocalNotifications && window.LocalNotifications.__native;
        return !!native && native.platform === 'ios';
    }

    const LEAVE_MESSAGE = 'Med Tracker will close this account on this iPhone and start without one. '
        + 'Nothing is deleted: the account and its data stay on the server, and you can open it again '
        + 'with your account address.';

    function _deviceOnly(vault) {
        const wrap = document.createElement('div');
        wrap.className = 'wg-firstrun-actions';
        const hint = document.createElement('p');
        hint.className = 'wg-hint';
        hint.textContent = 'Rather not use an account? Keep your records only on this iPhone.';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wg-btn wg-btn--ghost wg-btn--lg wg-btn--block';
        btn.textContent = 'Use only on this device';
        btn.setAttribute('data-firstrun-action', 'device-only');
        btn.addEventListener('click', async function () {
            if (btn.disabled) return;
            btn.disabled = true;
            try {
                const ok = await window.safeConfirm(LEAVE_MESSAGE, null, {
                    title: 'Use only on this device?',
                    confirmLabel: 'Continue',
                });
                if (ok) await vault.leaveAccount();
            } catch (e) {
                await window.safeAlert(e && e.message ? e.message : 'Couldn’t leave the account.');
            } finally {
                btn.disabled = false;
            }
        });
        wrap.appendChild(hint);
        wrap.appendChild(btn);
        return wrap;
    }

    window.WGFirstRun = window.WGFirstRun || {};
    window.WGFirstRun.screens = window.WGFirstRun.screens || {};
    window.WGFirstRun.screens.welcome = {
        title: 'Welcome to MedTracker',
        render: render,
    };
})();
