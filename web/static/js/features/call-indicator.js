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
    let muteEl = null;
    let photoEl = null;
    let photoInputEl = null;
    let hangUpEl = null;
    let stateListener = null;

    function render(state, message, muted, uploading) {
        if (!rootEl) return;
        const isIdle = !state || state === 'idle';
        const isError = state === 'error';
        const hideControls = isIdle || isError;
        rootEl.hidden = isIdle;
        if (isIdle) {
            rootEl.removeAttribute('data-state');
            if (textEl) textEl.textContent = '';
            if (hangUpEl) hangUpEl.disabled = false;
            if (muteEl) {
                muteEl.hidden = true;
                muteEl.setAttribute('aria-pressed', 'false');
                muteEl.textContent = 'Mute';
                muteEl.disabled = false;
            }
            if (photoEl) {
                photoEl.hidden = true;
                photoEl.disabled = false;
                photoEl.textContent = 'Photo';
            }
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
        if (muteEl) {
            muteEl.hidden = hideControls;
            const isMuted = Boolean(muted);
            muteEl.setAttribute('aria-pressed', isMuted ? 'true' : 'false');
            muteEl.textContent = isMuted ? 'Unmute' : 'Mute';
            muteEl.disabled = state === 'connecting';
        }
        if (photoEl) {
            photoEl.hidden = hideControls;
            const isUploading = Boolean(uploading);
            photoEl.disabled = state === 'connecting' || isUploading;
            photoEl.textContent = isUploading ? 'Sending…' : 'Photo';
        }
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

        muteEl = document.createElement('button');
        muteEl.type = 'button';
        muteEl.className = 'wg-call-indicator__mute';
        muteEl.setAttribute('aria-pressed', 'false');
        muteEl.textContent = 'Mute';
        muteEl.hidden = true;
        muteEl.addEventListener('click', () => {
            const agent = window.WGCallAgent;
            if (agent && typeof agent.toggleMute === 'function') {
                agent.toggleMute();
            }
        });
        rootEl.appendChild(muteEl);

        photoEl = document.createElement('button');
        photoEl.type = 'button';
        photoEl.className = 'wg-call-indicator__photo';
        photoEl.textContent = 'Photo';
        photoEl.hidden = true;
        rootEl.appendChild(photoEl);

        photoInputEl = document.createElement('input');
        photoInputEl.type = 'file';
        photoInputEl.accept = 'image/*';
        photoInputEl.capture = 'environment';
        photoInputEl.className = 'wg-call-indicator__photo-input';
        photoInputEl.addEventListener('change', (event) => {
            const file = event.target && event.target.files && event.target.files[0];
            if (file) {
                const agent = window.WGCallAgent;
                if (agent && typeof agent.sendPhoto === 'function') {
                    try {
                        const ret = agent.sendPhoto(file);
                        if (ret && typeof ret.catch === 'function') {
                            ret.catch(() => { /* status surfaced via wg-call-state */ });
                        }
                    } catch (_) { /* ignore */ }
                }
            }
            try { photoInputEl.value = ''; } catch (_) { /* ignore */ }
        });
        rootEl.appendChild(photoInputEl);

        photoEl.addEventListener('click', () => {
            if (photoInputEl) photoInputEl.click();
        });

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
            render(detail.state, detail.message, detail.muted, detail.uploading);
        };
        window.addEventListener('wg-call-state', stateListener);

        const agent = window.WGCallAgent;
        if (agent && typeof agent.getState === 'function') {
            try {
                const initial = agent.getState() || {};
                render(initial.state, initial.message, initial.muted, initial.uploading);
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
        muteEl = null;
        photoEl = null;
        photoInputEl = null;
        hangUpEl = null;
    }

    window.WGCallIndicator = { mount, destroy };
})();
