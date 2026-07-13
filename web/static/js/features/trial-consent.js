// features/trial-consent.js — the trial-provider consent ceremony
// (bd med-yor.2, Task 4). window.TrialConsent.request(scope) shows a modal
// disclosure for one of the three independent consent scopes (`ai` — meal
// text/photo parsing, `voice` — trial ElevenLabs calls, `tg` — the Telegram
// free-text agent incl. the vault data its tool calls feed back to the
// model) and persists the user's choice to the encrypted-vault
// `trialconsent` singleton via PATCH /api/settings/trial-consent. The
// request-time gates (web/cloud/js/aiclient.js, features/elevenlabs-call.js)
// refuse unless the scope reads exactly `true`, so a dismissed or failed
// dialog never widens consent.
//
// retryAfterConsent(fn) is the shared interactive-retry seam: run fn, and if
// it throws the gate's `trial_consent_required` error, ask for that scope
// and rerun fn once on Allow. The food AI call sites (features/food/log.js,
// features/food/photo.js) wrap their CloudFoodAI calls in it; the tg drain
// path deliberately does NOT (no user present — it must refuse, never prompt).
(function () {
    'use strict';

    const CONSENT_URL = '/api/settings/trial-consent';

    // Disclosure copy per scope. Must name: the data categories sent, that
    // the content transits the OPERATOR's provider account, and the BYO
    // alternative. Rendered via textContent only.
    const COPY = {
        ai: {
            title: 'Use the trial AI key?',
            data: 'Your meal descriptions and meal photos will be sent to an AI model for parsing.',
            transit: 'This content transits the operator’s OpenAI account — the operator’s provider processes it on the operator’s key.',
        },
        voice: {
            title: 'Use the trial voice agent?',
            data: 'Your voice audio and the agent conversation (including transcripts) will be processed by the voice service.',
            transit: 'This content transits the operator’s ElevenLabs agent — the operator’s provider processes it on the operator’s key.',
        },
        tg: {
            title: 'Let the Telegram assistant use the trial AI?',
            data: 'Your Telegram messages AND the health data the assistant reads from your vault to answer them — blood pressure history, notes, and other records — will be sent to an AI model.',
            transit: 'This content transits the operator’s OpenAI account — the operator’s provider processes it on the operator’s key.',
        },
    };
    const ALTERNATIVE = 'Alternative: add your own key in Settings → Integrations, and this data goes only to your own provider account.';

    // Best-effort persist; resolves true only when the PATCH actually landed.
    // Resolving true without persistence would just bounce off the gate again
    // (it re-reads the vault record), so honesty here is also correctness.
    async function persist(scope, allowed) {
        if (typeof window.apiCall !== 'function') return false;
        try {
            const res = await window.apiCall(CONSENT_URL, 'PATCH', { [scope]: allowed });
            return res !== null && res !== undefined;
        } catch (_) {
            return false;
        }
    }

    // One in-flight dialog per scope: a gate retry racing a manual click must
    // not stack two modals for the same question.
    const _pending = {};

    function request(scope) {
        const copy = COPY[scope];
        if (!copy) return Promise.resolve(false);
        if (_pending[scope]) return _pending[scope];

        const promise = new Promise((resolve) => {
            const doc = document;
            const backdrop = doc.createElement('div');
            backdrop.className = 'mt-confirm-backdrop';

            const modal = doc.createElement('mt-modal');
            modal.className = 'wg-modal wg-trial-consent-modal';
            modal.setAttribute('data-trial-consent-scope', scope);

            const header = doc.createElement('div');
            header.className = 'wg-modal__header';
            const title = doc.createElement('h3');
            title.className = 'wg-modal__title';
            title.textContent = copy.title;
            header.appendChild(title);

            const body = doc.createElement('div');
            body.className = 'wg-modal__body';
            for (const text of [copy.data, copy.transit, ALTERNATIVE]) {
                const p = doc.createElement('p');
                p.className = 'wg-trial-consent-modal__text';
                p.textContent = text;
                body.appendChild(p);
            }

            const actions = doc.createElement('div');
            actions.className = 'wg-modal__actions';
            const denyBtn = doc.createElement('button');
            denyBtn.type = 'button';
            denyBtn.className = 'wg-gloss';
            denyBtn.setAttribute('data-trial-consent-choice', 'deny');
            denyBtn.textContent = 'Not now';
            const allowBtn = doc.createElement('button');
            allowBtn.type = 'button';
            allowBtn.className = 'wg-gloss wg-gloss--sun';
            allowBtn.setAttribute('data-trial-consent-choice', 'allow');
            allowBtn.textContent = 'Allow';
            actions.appendChild(denyBtn);
            actions.appendChild(allowBtn);

            modal.appendChild(header);
            modal.appendChild(body);
            modal.appendChild(actions);

            let settled = false;
            // choice: true → persist grant, false → persist refusal,
            // null → dismissed (Escape/backdrop) — no decision, nothing stored.
            function settle(choice) {
                if (settled) return;
                settled = true;
                doc.removeEventListener('keydown', onKeydown, true);
                if (typeof modal.close === 'function') {
                    try { modal.close(); } catch (_) { /* ignore */ }
                }
                if (modal.parentNode) modal.parentNode.removeChild(modal);
                if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
                delete _pending[scope];
                if (choice === null) {
                    resolve(false);
                    return;
                }
                persist(scope, choice).then((stored) => {
                    resolve(choice === true && stored);
                });
            }

            function onKeydown(e) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    settle(null);
                }
            }

            denyBtn.addEventListener('click', () => settle(false));
            allowBtn.addEventListener('click', () => settle(true));
            backdrop.addEventListener('click', () => settle(null));
            doc.addEventListener('keydown', onKeydown, true);

            doc.body.appendChild(backdrop);
            doc.body.appendChild(modal);
            if (typeof modal.open === 'function') {
                try { modal.open(); } catch (_) { /* ignore */ }
            }
            try { allowBtn.focus(); } catch (_) { /* ignore */ }
        });

        _pending[scope] = promise;
        return promise;
    }

    async function retryAfterConsent(fn) {
        try {
            return await fn();
        } catch (err) {
            if (!err || err.code !== 'trial_consent_required' || !err.scope) throw err;
            const allowed = await request(err.scope);
            if (allowed !== true) throw err;
            return fn();
        }
    }

    window.TrialConsent = { request, retryAfterConsent };
})();
