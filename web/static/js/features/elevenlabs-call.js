// ElevenLabs conversational agent — "Call agent" CTA on the Today screen.
//
// The card mounts a button. On click we:
//   1. Hit /api/elevenlabs/signed-url so the API key never reaches the browser.
//   2. Lazy-load the @elevenlabs/convai-widget-embed UMD bundle.
//   3. Mount <elevenlabs-convai signed-url="…"> inside the card. The web
//      component then renders and drives its own call UI (mic permission
//      prompt, transcript, hang-up).
//
// We render the card in a "ready" state by default and only flip to
// "unavailable" if the backend returns 503 on click.

(function () {
    const WIDGET_SRC = 'https://unpkg.com/@elevenlabs/convai-widget-embed';
    let widgetScriptPromise = null;

    function loadWidgetScript() {
        if (widgetScriptPromise) return widgetScriptPromise;
        widgetScriptPromise = new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[src="${WIDGET_SRC}"]`);
            if (existing) {
                if (existing.dataset.loaded === '1') {
                    resolve();
                    return;
                }
                existing.addEventListener('load', () => resolve(), { once: true });
                existing.addEventListener('error', () => reject(new Error('Failed to load ElevenLabs widget')), { once: true });
                return;
            }
            const s = document.createElement('script');
            s.src = WIDGET_SRC;
            s.async = true;
            s.addEventListener('load', () => {
                s.dataset.loaded = '1';
                resolve();
            }, { once: true });
            s.addEventListener('error', () => reject(new Error('Failed to load ElevenLabs widget')), { once: true });
            document.head.appendChild(s);
        });
        return widgetScriptPromise;
    }

    async function fetchSignedURL() {
        const apiCall = (typeof window.offlineAwareApiCall === 'function')
            ? window.offlineAwareApiCall
            : (typeof window.apiCallDirect === 'function' ? window.apiCallDirect : null);
        const fetcher = apiCall || ((url, opts) => fetch(url, opts));
        const resp = await fetcher('/api/elevenlabs/signed-url', { method: 'GET' });
        if (!resp || !resp.ok) {
            const status = resp ? resp.status : 0;
            const err = new Error(`Failed to get signed URL (${status})`);
            err.status = status;
            throw err;
        }
        const data = await resp.json();
        if (!data || !data.signed_url) {
            throw new Error('Response missing signed_url');
        }
        return data.signed_url;
    }

    function setStatus(card, message, variant) {
        const status = card.querySelector('.wg-call-card__status');
        if (!status) return;
        status.textContent = message || '';
        status.classList.remove('wg-call-card__status--error', 'wg-call-card__status--ready', 'wg-call-card__status--connecting');
        if (variant) status.classList.add(`wg-call-card__status--${variant}`);
        status.hidden = !message;
    }

    async function startCall(card) {
        const btn = card.querySelector('.wg-call-card__btn');
        if (btn) btn.disabled = true;
        setStatus(card, 'Connecting…', 'connecting');

        try {
            const [signedUrl] = await Promise.all([
                fetchSignedURL(),
                loadWidgetScript(),
            ]);

            if (window.customElements && !window.customElements.get('elevenlabs-convai')) {
                await window.customElements.whenDefined('elevenlabs-convai');
            }

            let widget = card.querySelector('elevenlabs-convai');
            if (!widget) {
                widget = document.createElement('elevenlabs-convai');
                const slot = card.querySelector('.wg-call-card__widget');
                if (slot) slot.appendChild(widget);
            }
            widget.setAttribute('signed-url', signedUrl);
            setStatus(card, 'Connected — use the bubble below to talk', 'ready');
            card.classList.add('wg-call-card--active');
        } catch (err) {
            const msg = err && err.status === 503
                ? 'Voice agent is not configured on this server.'
                : (err && err.message) || 'Failed to start call';
            setStatus(card, msg, 'error');
            if (btn) btn.disabled = false;
        }
    }

    function buildCard() {
        const card = document.createElement('section');
        card.className = 'wg-card wg-call-card';
        card.setAttribute('data-section', 'call-agent');

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
        btn.addEventListener('click', () => startCall(card));
        card.appendChild(btn);

        const status = document.createElement('div');
        status.className = 'wg-call-card__status';
        status.setAttribute('aria-live', 'polite');
        status.hidden = true;
        card.appendChild(status);

        const widgetSlot = document.createElement('div');
        widgetSlot.className = 'wg-call-card__widget';
        card.appendChild(widgetSlot);

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

    window.WGCallAgent = { mountCard, startCall, fetchSignedURL, loadWidgetScript };
})();
