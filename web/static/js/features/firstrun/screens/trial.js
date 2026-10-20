// features/firstrun/screens/trial.js — W2, the AI trial offer (bd med-ta2n.2,
// screens-onboarding-v3.html W2). The step after the W1 picker, reached only
// when Food was picked and a trial is on offer (index.js _finishPicker reads
// SettingsIntegrations.trialOffer). One real example, one sun, a full-width
// "Not now"; no countdown, no scarcity. The trial is asked once, here: the
// claim wizard's trial step and the first-run key form are gone (Settings →
// AI & integrations keeps the key form).
//
// "Try it free" opens the consent sheet in place, the same opt-in as the
// Settings card:
//   - local mode (window.CloudVault.trial, local-policy.js): the `anon`
//     consent, trial.apply() (which reloads when the CSP must admit our
//     server — the overlay then resumes on this step, sees the trial on and
//     finishes), then trial.enroll() for the grant or rejoin;
//   - cloud mode: the `ai` consent is the whole opt-in (aiclient.js routes
//     through the operator key whenever the user has none of their own).
// A refusal or a failed grant says why; "Not now" stays one tap away.
// "Not now" completes first run and writes nothing — the Today card's own
// per-device dismiss gives it its one later appearance.
(function () {
    'use strict';

    const DECLINED = 'The free trial stays off. You can turn it on later in Settings → AI & integrations.';
    const ERRORS = {
        trial_already_used: `The free trial was already used on this ${window.LocalNotifications?.copy?.device || 'iPhone'}.`,
        trial_not_configured: 'The free trial is not available right now.',
    };
    const FAILED = 'Couldn’t start the free trial. Check your connection and try again.';

    // The frame's example, static copy: a sentence in, three logged rows out.
    const EXAMPLE_SAID = '"Two eggs, toast with butter, coffee with milk"';
    const EXAMPLE_ROWS = [
        ['Eggs, boiled · 2', '156'],
        ['Toast with butter · 1 slice', '128'],
        ['Coffee with milk · 250 ml', '42'],
    ];
    const EXAMPLE_TOTAL = 'Breakfast · 326 kcal · 21 g protein';

    function _el(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text) el.textContent = text;
        return el;
    }

    function _ico(name, small) {
        const i = _el('i', small ? 'wg-ico wg-ico--sm' : 'wg-ico');
        i.setAttribute('data-icon', name);
        i.setAttribute('aria-hidden', 'true');
        return i;
    }

    function _example() {
        const chip = _el('span', 'wg-chip wg-chip--sm');
        chip.append(_ico('mic'), document.createTextNode('or say it'));
        const or = _el('div', 'wg-or');
        or.appendChild(_ico('sparkle', true));
        const list = _el('div', 'wg-list');
        EXAMPLE_ROWS.forEach(function (r) {
            const row = _el('div', 'wg-row wg-row--pad');
            const rowBody = _el('span', 'wg-row__body');
            rowBody.appendChild(_el('span', 'wg-row__title', r[0]));
            const value = _el('span', 'wg-row__value', r[1]);
            value.appendChild(_el('small', null, 'kcal'));
            row.append(rowBody, value);
            list.appendChild(row);
        });
        const card = window.WGOfferCard.create({
            title: 'Example',
            trail: chip,
            body: [_el('div', 'wg-code', EXAMPLE_SAID), or, list, _el('span', 'wg-meta', EXAMPLE_TOTAL)],
        });
        card.setAttribute('data-firstrun-example', '');
        return card;
    }

    function render(body, helpers) {
        const trial = (window.CloudVault && window.CloudVault.trial) || null;

        body.appendChild(_el('p', 'wg-shell__lede', 'Type, say or snap what you ate. The assistant fills in the food and the numbers.'));
        body.appendChild(_example());
        // "No account" is the local-mode truth; a cloud user has one.
        body.appendChild(_el('p', 'wg-shell__fine', trial
            ? 'Free to try. There’s no account, and the daily limits are shown in Settings.'
            : 'Free to try. You can turn it off any time in Settings.'));

        const error = _el('p', 'wg-firstrun-form__error');
        error.setAttribute('data-firstrun-form-error', 'trial');
        body.appendChild(error);

        const foot = _el('div', 'wg-firstrun-foot');
        const tryBtn = _el('button', 'wg-btn wg-btn--primary wg-btn--lg wg-btn--block');
        tryBtn.type = 'button';
        tryBtn.setAttribute('data-firstrun-action', 'trial');
        const tryLabel = _el('span', null, 'Try it free');
        tryBtn.append(_ico('sparkle'), tryLabel);
        // Never disabled: whatever the trial does, the user can move on.
        const notNow = _el('button', 'wg-btn wg-btn--lg wg-btn--block', 'Not now');
        notNow.type = 'button';
        notNow.setAttribute('data-firstrun-action', 'not-now');
        foot.append(tryBtn, notNow);
        body.appendChild(foot);
        if (window.WGIcons && typeof window.WGIcons.hydrate === 'function') window.WGIcons.hydrate(body);

        function fail(text) {
            error.textContent = text;
            tryLabel.textContent = 'Try again';
            tryBtn.disabled = false;
        }
        async function finish() {
            tryBtn.disabled = true;
            error.textContent = '';
            tryLabel.textContent = 'Starting the free trial…';
            let res;
            try { res = await trial.enroll(); } catch (_) { res = { ok: false, code: 'network' }; }
            if (!tryBtn.isConnected) return;
            if (res && res.ok) {
                helpers.advance('done');
                return;
            }
            fail(ERRORS[res && res.code] || FAILED);
        }

        tryBtn.addEventListener('click', async function () {
            tryBtn.disabled = true;
            error.textContent = '';
            let reloading = false;
            try {
                const granted = window.TrialConsent ? await window.TrialConsent.request(trial ? 'anon' : 'ai') : false;
                if (granted !== true) {
                    fail(DECLINED);
                    tryLabel.textContent = 'Try it free';
                    return;
                }
                if (!trial) {
                    helpers.advance('done');
                    return;
                }
                reloading = (await trial.apply()) === true;
            } catch (e) {
                console.error('[firstrun] trial start failed', e);
                fail(FAILED);
                return;
            }
            // The CSP changes on a reload; this step resumes after it.
            if (!reloading) await finish();
        });
        notNow.addEventListener('click', function () {
            helpers.advance('done');
        });

        // Back from apply()'s reload with the trial on → finish the grant.
        if (!trial) return;
        Promise.resolve(trial.status()).catch(function () { return null; }).then(function (status) {
            if (status && status.on && tryBtn.isConnected) finish();
        });
    }

    window.WGFirstRun = window.WGFirstRun || {};
    window.WGFirstRun.screens = window.WGFirstRun.screens || {};
    window.WGFirstRun.screens.trial = {
        title: 'Log a meal by just saying it',
        render: render,
    };
})();
