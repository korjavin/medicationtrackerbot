// Persistent call indicator — floating pill anchored above the bottom nav
// that surfaces ElevenLabs call state across tab switches.
//
// Subscribes to the `wg-call-state` window event emitted by elevenlabs-call.js.
// Visible whenever state is connecting / in_call / error; hidden on idle.
// State variants drive the status-dot color via the [data-state] attribute.

(function () {
    const STATUS_TEXT = {
        connecting: 'Connecting…',
        in_call: 'In call',
        error: 'Call error',
    };

    let rootEl = null;
    let dotEl = null;
    let textEl = null;
    let hangUpEl = null;
    let stateListener = null;

    function render(state, message) {
        if (!rootEl) return;
        const isIdle = !state || state === 'idle';
        rootEl.hidden = isIdle;
        if (isIdle) {
            rootEl.removeAttribute('data-state');
            if (textEl) textEl.textContent = '';
            if (hangUpEl) hangUpEl.disabled = false;
            return;
        }
        rootEl.dataset.state = state;
        const fallback = STATUS_TEXT[state] || '';
        if (textEl) textEl.textContent = message || fallback;
        // Mirror the Today card's behavior: disable hang-up during
        // 'connecting' to avoid a race where startSession() is still in
        // flight (activeConversation is null), endCall() would no-op the
        // teardown, and the live conversation gets assigned afterwards
        // with no UI left to end it.
        if (hangUpEl) hangUpEl.disabled = state === 'connecting';
    }

    function mount(parent) {
        const host = parent || document.body;
        if (!host) return null;
        if (rootEl && rootEl.parentNode === host) {
            return rootEl;
        }
        if (rootEl) destroy();

        rootEl = document.createElement('div');
        rootEl.className = 'wg-call-indicator';
        rootEl.hidden = true;
        rootEl.setAttribute('role', 'status');
        rootEl.setAttribute('aria-live', 'polite');

        dotEl = document.createElement('span');
        dotEl.className = 'wg-call-indicator__dot';
        dotEl.setAttribute('aria-hidden', 'true');
        rootEl.appendChild(dotEl);

        textEl = document.createElement('span');
        textEl.className = 'wg-call-indicator__text';
        rootEl.appendChild(textEl);

        hangUpEl = document.createElement('button');
        hangUpEl.type = 'button';
        hangUpEl.className = 'wg-call-indicator__hang-up wg-gloss wg-gloss--clay';
        hangUpEl.textContent = 'End call';
        hangUpEl.addEventListener('click', () => {
            const agent = window.WGCallAgent;
            if (agent && typeof agent.endCall === 'function') {
                agent.endCall();
            }
        });
        rootEl.appendChild(hangUpEl);

        host.appendChild(rootEl);

        stateListener = (ev) => {
            const detail = (ev && ev.detail) || {};
            render(detail.state, detail.message);
        };
        window.addEventListener('wg-call-state', stateListener);

        const agent = window.WGCallAgent;
        if (agent && typeof agent.getState === 'function') {
            try {
                const initial = agent.getState() || {};
                render(initial.state, initial.message);
            } catch (_) { /* ignore */ }
        }

        return rootEl;
    }

    function destroy() {
        if (stateListener) {
            window.removeEventListener('wg-call-state', stateListener);
            stateListener = null;
        }
        if (rootEl && rootEl.parentNode) {
            rootEl.parentNode.removeChild(rootEl);
        }
        rootEl = null;
        dotEl = null;
        textEl = null;
        hangUpEl = null;
    }

    window.WGCallIndicator = { mount, destroy };
})();
