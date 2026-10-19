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
            transit: 'This content transits the operator’s AI provider account (OpenAI or Anthropic, the operator’s choice) — the operator’s provider processes it on the operator’s key.',
        },
        voice: {
            title: 'Use the trial voice agent?',
            data: 'Your voice audio and the agent conversation (including transcripts) will be processed by the voice service, and the agent\u2019s answers are written by the operator\u2019s AI provider, which receives each turn (the conversation so far) — AND the health data the agent reads from your vault to answer you: blood pressure, weight, workouts, medications, food, sleep, notes, whatever you ask it about.',
            transit: 'This content transits the operator’s ElevenLabs agent and then the operator’s server (in transit only, not stored) on its way to the operator’s AI provider account — the operator’s providers process it on the operator’s keys.',
        },
        tg: {
            title: 'Let the Telegram assistant use the trial AI?',
            data: 'Your Telegram messages AND the health data the assistant reads from your vault to answer them — blood pressure history, notes, and other records — will be sent to an AI model. The in-app story narrator shares this consent: it sends computed health summaries (weekly weight-goal progress, workout and blood-pressure stats) to the same model.',
            transit: 'This content transits the operator’s AI provider account (OpenAI or Anthropic, the operator’s choice) — the operator’s provider processes it on the operator’s key.',
        },
    };
    const ALTERNATIVE = 'Alternative: add your own key in Settings → Integrations, and this data goes only to your own provider account.';

    // iOS local mode (bd med-o7zq.16): no account, so the trial is anonymous —
    // it goes through our server and is counted per device trial bucket. One switch,
    // the `anon` scope, covers the AI, the operator's food database and, from
    // bd med-o7zq.23, voice calls. The copy must say what the server keeps and
    // that a reinstall continues it (bd med-o7zq.26). The minutes are the operator's
    // TRIAL_ANON_VOICE_LIFETIME / _DAILY / _CALL_MAX_SECONDS: this copy shows before
    // the grant — before the app may reach our server at all — so it names no
    // numbers; Settings shows them from the server once granted (bd med-o7zq.28).
    const LOCAL_COPY = {
        anon: {
            title: 'Try the AI, food database and voice calls without your own keys?',
            data: 'What you ask the AI to read — meal and activity descriptions, meal photos, workout-sheet photos with your plan’s exercise names, and exercise names to tag — and the barcodes and food names you look up will be sent through our server: AI requests to the operator’s AI provider account (OpenAI or Anthropic, the operator’s choice), lookups to the operator’s food database. Our server keeps no prompts, photos or searches.',
            voice: 'Voice calls: your voice audio and the transcript go to the operator’s ElevenLabs account. The agent’s answers are written by the operator’s AI provider through our server, which receives each turn AND the health data the agent reads from this phone to answer you — blood pressure, weight, workouts, medications, food, sleep, notes. Our server keeps no call content.',
            transit: 'To count the trial without an account, our server stores an anonymous install id from Apple’s App Attest and how many requests and seconds of calls this iPhone’s trial has used, and Apple’s DeviceCheck keeps a mark that this iPhone had its trial. You get a limited number of free AI requests on this iPhone, a daily allowance of food lookups, and a limited number of free minutes of voice calls on this iPhone, with a daily limit (the minutes left are shown in Settings), counted by our server as call time: each call uses its full length limit when it starts, even if you hang up sooner. Reinstalling the app continues the same allowance — a trial pass kept in this iPhone’s keychain links the new install to it — and the trial does not start again.',
            alternative: 'Alternative: add your own keys in Settings → AI & integrations, and this data goes only to your own providers, never through our server.',
        },
    };

    function copyFor(scope) {
        const local = document.documentElement.classList.contains('wg-local-vault');
        if (!local) return COPY[scope] && { ...COPY[scope], alternative: ALTERNATIVE };
        // The Android shell names its own attestation (bd med-nt9p.32.8.4); the iOS impl has no override.
        const transit = window.Attest?.copy?.trialTransit;
        return LOCAL_COPY[scope] && transit ? { ...LOCAL_COPY[scope], transit } : LOCAL_COPY[scope];
    }

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
        const copy = copyFor(scope);
        if (!copy) return Promise.resolve(false);
        if (_pending[scope]) return _pending[scope];

        const promise = new Promise((resolve) => {
            const doc = document;
            const backdrop = doc.createElement('div');
            backdrop.className = 'mt-confirm-backdrop wg-sheet-backdrop';

            // Kit sheet (med-xso6.7): a decision flow, so the choice lives in
            // the foot and the header carries only the question.
            const modal = doc.createElement('mt-modal');
            modal.id = `trial-consent-modal-${scope}`;
            modal.className = 'wg-modal wg-sheet wg-trial-consent-modal';
            modal.setAttribute('data-trial-consent-scope', scope);

            const grab = doc.createElement('div');
            grab.className = 'wg-sheet__grab';
            const header = window.WGSheet.header({ eyebrow: 'Trial', title: copy.title }).el;

            const body = doc.createElement('div');
            body.className = 'wg-sheet__body';
            for (const text of [copy.data, copy.voice, copy.transit, copy.alternative].filter(Boolean)) {
                const p = doc.createElement('p');
                p.className = 'wg-trial-consent-modal__text';
                p.textContent = text;
                body.appendChild(p);
            }

            const foot = doc.createElement('div');
            foot.className = 'wg-sheet__foot';
            const denyBtn = doc.createElement('button');
            denyBtn.type = 'button';
            denyBtn.className = 'wg-btn';
            denyBtn.setAttribute('data-trial-consent-choice', 'deny');
            denyBtn.textContent = 'Not now';
            const allowBtn = doc.createElement('button');
            allowBtn.type = 'button';
            allowBtn.className = 'wg-btn wg-btn--primary';
            allowBtn.setAttribute('data-trial-consent-choice', 'allow');
            allowBtn.textContent = 'Allow';
            foot.appendChild(denyBtn);
            foot.appendChild(allowBtn);

            modal.append(grab, header, body, foot);

            let settled = false;
            // choice: true → persist grant, false → persist refusal,
            // null → dismissed (Escape/backdrop) — no decision, nothing stored.
            function settle(choice) {
                if (settled) return;
                settled = true;
                doc.removeEventListener('keydown', onKeydown, true);
                window.ModalManager.close(modal.id);
                window.ModalManager.register(modal.id, null);
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
            // On the ModalManager stack so Back / Esc dismiss it like any sheet.
            window.ModalManager.register(modal.id, () => settle(null));
            window.ModalManager.open(modal.id);
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

    // grant(scope): persist an Allow the user already gave on a screen that
    // showed this exact disclosure but could not write the vault — the claim
    // wizard's trial step (bd med-nt9p.40). No dialog; resolves true only when stored.
    function grant(scope) {
        return COPY[scope] ? persist(scope, true) : Promise.resolve(false);
    }

    window.TrialConsent = { request, retryAfterConsent, grant };
})();
