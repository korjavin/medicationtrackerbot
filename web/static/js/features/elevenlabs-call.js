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
    // Live call state tracked outside the DOM so we can restore the correct
    // button text / status when the Today screen re-renders mid-call (sync
    // refresh, tab switch). Without this, a fresh card always mounts in
    // 'idle' state while activeConversation is still set, so clicking the
    // "Call agent" button hits the early-return in startCall() and does
    // nothing — leaving the user with no way to end the call.
    let activeCard = null;
    let activeState = 'idle';
    let activeMessage = '';
    let activeMuted = false;
    let activeUploading = false;

    function applyState(card, state, message) {
        if (!card) return;
        card.dataset.state = state;
        const btn = card.querySelector('.wg-call-card__btn');
        const label = card.querySelector('.wg-call-card__label');
        const status = card.querySelector('.wg-call-card__status');
        const muteBtn = card.querySelector('.wg-call-card__mute');
        const photoBtn = card.querySelector('.wg-call-card__photo');
        if (btn) {
            btn.disabled = state === 'connecting';
        }
        if (label) {
            if (state === 'idle') label.textContent = 'Call agent';
            else if (state === 'connecting') label.textContent = 'Connecting…';
            else if (state === 'in_call') label.textContent = 'End call';
            else if (state === 'error') label.textContent = 'Try again';
        }
        if (status) {
            const variant = state === 'error' ? 'error' : (state === 'in_call' ? 'ready' : (state === 'connecting' ? 'connecting' : null));
            status.classList.remove('wg-call-card__status--error', 'wg-call-card__status--ready', 'wg-call-card__status--connecting');
            if (variant) status.classList.add(`wg-call-card__status--${variant}`);
            status.textContent = message || '';
            status.hidden = !message;
        }
        if (muteBtn) {
            muteBtn.setAttribute('aria-pressed', activeMuted ? 'true' : 'false');
            muteBtn.textContent = activeMuted ? 'Unmute' : 'Mute';
            muteBtn.disabled = state === 'connecting';
        }
        if (photoBtn) {
            photoBtn.disabled = state === 'connecting' || activeUploading;
            photoBtn.textContent = activeUploading ? 'Sending…' : 'Send photo';
        }
    }

    function setState(state, message) {
        activeState = state;
        activeMessage = message || '';
        if (state === 'idle' || state === 'error') {
            activeMuted = false;
            activeUploading = false;
        }
        applyState(activeCard, state, activeMessage);
        try {
            window.dispatchEvent(new CustomEvent('wg-call-state', {
                detail: {
                    state: activeState,
                    message: activeMessage,
                    muted: activeMuted,
                    uploading: activeUploading,
                },
            }));
        } catch (_) { /* ignore */ }
    }

    function getState() {
        return {
            state: activeState,
            message: activeMessage,
            muted: activeMuted,
            uploading: activeUploading,
        };
    }

    function setMute(muted) {
        if (!activeConversation) return;
        const next = Boolean(muted);
        if (typeof activeConversation.setMicMuted !== 'function') {
            // Same privacy concern as the throw path below: never claim the
            // mic is muted when we couldn't actually mute it.
            setState(activeState, 'Mute unsupported');
            return;
        }
        try {
            activeConversation.setMicMuted(next);
            activeMuted = next;
            // Clear a stale failure message so a successful toggle doesn't
            // re-broadcast "Mute failed" / "Mute unsupported".
            const nextMessage = (activeMessage === 'Mute failed' || activeMessage === 'Mute unsupported')
                ? ''
                : activeMessage;
            setState(activeState, nextMessage);
        } catch (_) {
            // SDK failed — do NOT update activeMuted. Showing "muted" while
            // the mic is still hot would mislead the user about whether the
            // agent can hear them. Surface the failure instead.
            setState(activeState, 'Mute failed');
        }
    }

    function toggleMute() {
        setMute(!activeMuted);
    }

    // Proxy the file through our backend so the server's xi-api-key can sign
    // the upload. The SDK's conv.uploadFile() posts directly to ElevenLabs
    // from the browser and 401s with `sign_in_required` because we never
    // expose the API key to the client.
    async function uploadFileViaProxy(conv, file) {
        const conversationId = (typeof conv.getId === 'function')
            ? conv.getId()
            : (conv.conversationId || conv.id || null);
        if (!conversationId) {
            throw new Error('Conversation id unavailable');
        }
        const form = new FormData();
        form.append('file', file, (file && file.name) || 'photo.jpg');
        const url = `/api/elevenlabs/upload-file?conversation_id=${encodeURIComponent(conversationId)}`;
        const headers = {};
        // Mirror the auth pattern used by /api/food/log/from-photo: pass the
        // Telegram init data so the apiMux AuthMiddleware accepts the call.
        // FormData bodies set their own Content-Type with boundary, so we
        // don't add Content-Type here.
        if (typeof window !== 'undefined' && window.userInitData) {
            headers['X-Telegram-Init-Data'] = window.userInitData;
        }
        const resp = await fetch(url, { method: 'POST', headers, body: form });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            const err = new Error(`Upload failed (${resp.status})${text ? `: ${text}` : ''}`);
            err.status = resp.status;
            throw err;
        }
        const data = await resp.json().catch(() => null);
        const fileId = data && (data.file_id || data.fileId);
        if (!fileId) {
            throw new Error('Upload missing file_id');
        }
        return fileId;
    }

    async function sendPhoto(file) {
        if (!activeConversation) {
            throw new Error('No active call');
        }
        if (activeState !== 'in_call') {
            throw new Error('Not in call');
        }
        const isBlob = (file && typeof file === 'object'
            && typeof Blob !== 'undefined' && file instanceof Blob);
        const type = isBlob ? (file.type || '').toString() : '';
        if (!isBlob || !type.startsWith('image/')) {
            // Surface a status so the user sees why nothing happened.
            setState(activeState, 'Image required');
            throw new Error('File must be an image');
        }
        // Capture the conversation reference so we can detect a hang-up
        // during the await and avoid clobbering UI state back to in_call
        // after the user has already ended the call.
        const conv = activeConversation;
        activeUploading = true;
        // Clear a prior photo-failure message so a retry starts clean, but
        // preserve live mode-change messages like "Listening…" / "Agent
        // speaking…" — wiping those would leave the call card looking dead
        // for the duration of the upload.
        const startMessage = (activeMessage === 'Photo upload failed' || activeMessage === 'Image required')
            ? ''
            : activeMessage;
        setState(activeState, startMessage);
        try {
            const fileId = await uploadFileViaProxy(conv, file);
            if (conv !== activeConversation) {
                // Call ended mid-upload — bail without touching UI state.
                return;
            }
            if (typeof conv.sendMultimodalMessage !== 'function') {
                throw new Error('SDK missing sendMultimodalMessage');
            }
            conv.sendMultimodalMessage({ fileId });
        } catch (err) {
            if (conv === activeConversation && activeState === 'in_call') {
                activeUploading = false;
                setState('in_call', 'Photo upload failed');
            }
            throw err;
        }
        if (conv === activeConversation && activeState === 'in_call') {
            activeUploading = false;
            // Re-broadcast whatever the controller currently shows (could be
            // a mode-change status set during the upload). Don't clobber it
            // with an empty string.
            setState(activeState, activeMessage);
        }
    }

    async function endCall() {
        const conv = activeConversation;
        activeConversation = null;
        if (conv && typeof conv.endSession === 'function') {
            try { await conv.endSession(); } catch (_) { /* ignore */ }
        }
        setState('idle', '');
    }

    async function startCall(card) {
        if (activeConversation) return;
        activeCard = card;
        setState('connecting', 'Connecting…');
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
                onConnect: () => setState('in_call', 'Connected'),
                onDisconnect: () => {
                    activeConversation = null;
                    setState('idle', '');
                },
                onError: (err) => {
                    activeConversation = null;
                    const msg = (err && (err.message || err.error)) || 'Call error';
                    setState('error', msg);
                },
                onModeChange: (m) => {
                    const mode = m && (m.mode || m);
                    if (mode === 'speaking') setState('in_call', 'Agent speaking…');
                    else if (mode === 'listening') setState('in_call', 'Listening…');
                },
            });
        } catch (err) {
            activeConversation = null;
            const msg = err && err.status === 503
                ? 'Voice agent is not configured on this server.'
                : (err && err.message) || 'Failed to start call';
            setState('error', msg);
        }
    }

    function buildCard() {
        const card = document.createElement('section');
        card.className = 'wg-card wg-call-card';
        card.dataset.section = 'call-agent';
        card.dataset.state = 'idle';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wg-call-card__btn';
        btn.setAttribute('data-section', 'shortcut');

        const iconWrap = document.createElement('span');
        iconWrap.className = 'wg-call-card__icon';
        if (window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
            try {
                iconWrap.appendChild(window.WGIcons.iconSvg('phone', { size: 15 }));
            } catch (_) { /* ignore */ }
        }
        btn.appendChild(iconWrap);

        const label = document.createElement('span');
        label.className = 'wg-call-card__label';
        label.textContent = 'Call agent';
        btn.appendChild(label);

        btn.addEventListener('click', () => {
            if (card.dataset.state === 'in_call') {
                endCall();
            } else {
                startCall(card);
            }
        });
        card.appendChild(btn);

        const controls = document.createElement('div');
        controls.className = 'wg-call-card__controls';
        card.appendChild(controls);

        const muteBtn = document.createElement('button');
        muteBtn.type = 'button';
        muteBtn.className = 'wg-call-card__mute';
        muteBtn.setAttribute('aria-pressed', 'false');
        muteBtn.textContent = 'Mute';
        muteBtn.addEventListener('click', () => {
            toggleMute();
        });
        controls.appendChild(muteBtn);

        const photoBtn = document.createElement('button');
        photoBtn.type = 'button';
        photoBtn.className = 'wg-call-card__photo';
        photoBtn.textContent = 'Send photo';
        controls.appendChild(photoBtn);

        const photoInput = document.createElement('input');
        photoInput.type = 'file';
        photoInput.accept = 'image/*';
        photoInput.capture = 'environment';
        photoInput.className = 'wg-call-card__photo-input';
        photoInput.addEventListener('change', (event) => {
            const file = event.target && event.target.files && event.target.files[0];
            if (file) {
                sendPhoto(file).catch(() => { /* status surfaced via setState */ });
            }
            try { photoInput.value = ''; } catch (_) { /* ignore */ }
        });
        controls.appendChild(photoInput);

        photoBtn.addEventListener('click', () => {
            photoInput.click();
        });

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
        if (existing) {
            // Re-bind the live call state to the existing card (e.g. when the
            // same DOM node is queried again without a re-render).
            if (activeConversation) {
                activeCard = existing;
                applyState(existing, activeState, activeMessage);
            }
            return existing;
        }
        const card = buildCard();
        container.appendChild(card);
        // Today re-renders during a call (sync polling, tab switch back to
        // Today) drop the previous DOM node. Reattach the live call state to
        // the freshly built card so the user still sees "End call" and can
        // hang up.
        if (activeConversation) {
            activeCard = card;
            applyState(card, activeState, activeMessage);
        }
        return card;
    }

    window.WGCallAgent = {
        mountCard,
        startCall,
        endCall,
        fetchSignedURL,
        getState,
        toggleMute,
        setMute,
        sendPhoto,
    };
})();
