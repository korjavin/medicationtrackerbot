// ElevenLabs conversational agent — "Call agent" card on the Today screen.
//
// Uses the @elevenlabs/client SDK directly (loaded as ESM via esm.sh) so we
// can drive the call from a single button: idle → connecting → in_call.
//
// State machine:
//   idle       — primary button reads "Call agent"; click → startCall()
//   connecting — button disabled, status line shows "Connecting…"
//   in_call    — primary button reads "End call"; click → endCall()
//                status line reflects agent mode (Listening… / Speaking…)
//   error      — primary button reads "Try again"; click → startCall()
//
// The signed URL is fetched from /api/elevenlabs/signed-url, which keeps
// ELEVENLABS_API_KEY server-side. The SDK handles WebRTC + AudioWorklets;
// CSP must permit blob: + data: scripts and worker-src blob: for the
// rawAudioProcessor / audioConcatProcessor worklets.

(function () {
    const SDK_URL = 'https://esm.sh/@elevenlabs/client';

    let sdkPromise = null;
    function loadSDK() {
        if (!sdkPromise) {
            sdkPromise = import(SDK_URL).catch((err) => {
                sdkPromise = null;
                const e = new Error('Failed to load ElevenLabs SDK');
                e.cause = err;
                throw e;
            });
        }
        return sdkPromise;
    }

    async function fetchSignedURL() {
        const apiCall = (typeof window.offlineAwareApiCall === 'function')
            ? window.offlineAwareApiCall
            : (typeof window.apiCallDirect === 'function' ? window.apiCallDirect : null);
        if (apiCall) {
            const data = await apiCall('/api/elevenlabs/signed-url', 'GET');
            if (!data || !data.signed_url) throw new Error('Response missing signed_url');
            return data.signed_url;
        }
        const resp = await fetch('/api/elevenlabs/signed-url', { method: 'GET' });
        if (!resp.ok) {
            const err = new Error(`Failed to get signed URL (${resp.status})`);
            err.status = resp.status;
            throw err;
        }
        const data = await resp.json();
        if (!data || !data.signed_url) throw new Error('Response missing signed_url');
        return data.signed_url;
    }

    let activeConversation = null;

    function setState(card, state, message) {
        if (!card) return;
        card.dataset.state = state;
        const btn = card.querySelector('.wg-call-card__btn');
        const status = card.querySelector('.wg-call-card__status');
        if (btn) {
            btn.disabled = state === 'connecting';
            if (state === 'idle') btn.textContent = 'Call agent';
            else if (state === 'connecting') btn.textContent = 'Connecting…';
            else if (state === 'in_call') btn.textContent = 'End call';
            else if (state === 'error') btn.textContent = 'Try again';
        }
        if (status) {
            const variant = state === 'error' ? 'error' : (state === 'in_call' ? 'ready' : (state === 'connecting' ? 'connecting' : null));
            status.classList.remove('wg-call-card__status--error', 'wg-call-card__status--ready', 'wg-call-card__status--connecting');
            if (variant) status.classList.add(`wg-call-card__status--${variant}`);
            status.textContent = message || '';
            status.hidden = !message;
        }
    }

    async function endCall() {
        const conv = activeConversation;
        activeConversation = null;
        if (conv && typeof conv.endSession === 'function') {
            try { await conv.endSession(); } catch (_) { /* ignore */ }
        }
    }

    async function startCall(card) {
        if (activeConversation) return;
        setState(card, 'connecting', 'Connecting…');
        try {
            const [signedUrl, sdk] = await Promise.all([
                fetchSignedURL(),
                loadSDK(),
            ]);
            const Conversation = sdk && sdk.Conversation;
            if (!Conversation || typeof Conversation.startSession !== 'function') {
                throw new Error('ElevenLabs SDK missing Conversation.startSession');
            }
            activeConversation = await Conversation.startSession({
                signedUrl,
                onConnect: () => setState(card, 'in_call', 'Connected'),
                onDisconnect: () => {
                    activeConversation = null;
                    setState(card, 'idle');
                },
                onError: (err) => {
                    activeConversation = null;
                    const msg = (err && (err.message || err.error)) || 'Call error';
                    setState(card, 'error', msg);
                },
                onModeChange: (m) => {
                    const mode = m && (m.mode || m);
                    if (mode === 'speaking') setState(card, 'in_call', 'Agent speaking…');
                    else if (mode === 'listening') setState(card, 'in_call', 'Listening…');
                },
            });
        } catch (err) {
            activeConversation = null;
            const msg = err && err.status === 503
                ? 'Voice agent is not configured on this server.'
                : (err && err.message) || 'Failed to start call';
            setState(card, 'error', msg);
        }
    }

    function buildCard() {
        const card = document.createElement('section');
        card.className = 'wg-card wg-call-card';
        card.dataset.section = 'call-agent';
        card.dataset.state = 'idle';

        const head = document.createElement('div');
        head.className = 'wg-call-card__head';
        const title = document.createElement('h2');
        title.className = 'wg-call-card__title';
        title.textContent = 'Talk to your health agent';
        head.appendChild(title);
        card.appendChild(head);

        const body = document.createElement('p');
        body.className = 'wg-call-card__copy';
        body.textContent = 'Voice-call the assistant about meds, vitals, or your day.';
        card.appendChild(body);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wg-gloss wg-gloss--sun wg-call-card__btn';
        btn.textContent = 'Call agent';
        btn.addEventListener('click', () => {
            if (card.dataset.state === 'in_call') {
                endCall();
            } else {
                startCall(card);
            }
        });
        card.appendChild(btn);

        const status = document.createElement('div');
        status.className = 'wg-call-card__status';
        status.setAttribute('aria-live', 'polite');
        status.hidden = true;
        card.appendChild(status);

        return card;
    }

    function mountCard(container) {
        if (!container) return null;
        const existing = container.querySelector('[data-section="call-agent"]');
        if (existing) return existing;
        const card = buildCard();
        container.appendChild(card);
        return card;
    }

    window.WGCallAgent = { mountCard, startCall, endCall, fetchSignedURL };
})();
