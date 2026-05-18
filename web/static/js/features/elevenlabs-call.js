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

    // spike: mcp_help only until production validation;
    // see docs/plans/2026-05-18-elevenlabs-mcp-help-only-spike.md
    const MCP_VOICE_ENABLE_EXECUTE = false;

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

    // Live MCP session state for dynamic client-tool callbacks. The mint
    // endpoint hands back a short-lived (15-min) Bearer token; if any tool
    // call returns 401 mid-conversation we refresh once before failing.
    let mcpSession = null;
    let toolCallCounter = 0;

    async function fetchMCPSessionToken() {
        const apiCall = (typeof window.offlineAwareApiCall === 'function')
            ? window.offlineAwareApiCall
            : (typeof window.apiCallDirect === 'function' ? window.apiCallDirect : null);
        if (apiCall) {
            const data = await apiCall('/api/elevenlabs/mcp-session-token', 'POST');
            if (!data || !data.token || !data.mcp_server_url) {
                throw new Error('Response missing token or mcp_server_url');
            }
            return data;
        }
        const headers = (typeof window.makeAuthHeaders === 'function')
            ? window.makeAuthHeaders()
            : undefined;
        const resp = await fetch('/api/elevenlabs/mcp-session-token', { method: 'POST', headers });
        if (!resp.ok) {
            const err = new Error(`Failed to mint MCP session token (${resp.status})`);
            err.status = resp.status;
            throw err;
        }
        const data = await resp.json();
        if (!data || !data.token || !data.mcp_server_url) {
            throw new Error('Response missing token or mcp_server_url');
        }
        return data;
    }

    async function refreshMCPSession() {
        const data = await fetchMCPSessionToken();
        mcpSession = {
            token: data.token,
            mcpServerUrl: String(data.mcp_server_url || '').replace(/\/$/, ''),
            expiresAt: typeof data.expires_at === 'number' ? data.expires_at : null,
        };
        return mcpSession;
    }

    // Parse an MCP /mcp response body. The Streamable HTTP transport can
    // respond with either application/json (a single JSON-RPC envelope) or
    // text/event-stream (one or more SSE frames, the last `data:` line being
    // the JSON-RPC envelope). Both are accepted.
    function parseMCPResponseBody(text) {
        const trimmed = String(text || '').trim();
        if (!trimmed) {
            throw new Error('Empty MCP response');
        }
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            return JSON.parse(trimmed);
        }
        const dataLines = trimmed.split(/\r?\n/).filter((l) => l.startsWith('data:'));
        if (dataLines.length === 0) {
            throw new Error('MCP response missing JSON-RPC envelope');
        }
        const last = dataLines[dataLines.length - 1].slice(5).trim();
        return JSON.parse(last);
    }

    // POST a JSON-RPC tools/call to the MCP server with the current session
    // token. On 401, refreshes the token and retries exactly once. Returns
    // result.content[0].text when the tool returns text content, or the raw
    // result object otherwise. Throws on JSON-RPC error or HTTP failure.
    async function callMCPTool(name, args, opts) {
        const allowRetry = !opts || opts.allowRetry !== false;
        if (!mcpSession) {
            throw new Error('MCP session not initialised');
        }
        toolCallCounter += 1;
        const body = {
            jsonrpc: '2.0',
            id: toolCallCounter,
            method: 'tools/call',
            params: { name, arguments: args || {} },
        };
        const resp = await fetch(`${mcpSession.mcpServerUrl}/mcp`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${mcpSession.token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
            },
            body: JSON.stringify(body),
        });
        if (resp.status === 401 && allowRetry) {
            await refreshMCPSession();
            return callMCPTool(name, args, { allowRetry: false });
        }
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            const err = new Error(`MCP tool call failed (${resp.status})${text ? `: ${text}` : ''}`);
            err.status = resp.status;
            throw err;
        }
        const text = await resp.text();
        const payload = parseMCPResponseBody(text);
        if (payload && payload.error) {
            const err = new Error((payload.error && payload.error.message) || 'MCP tool call error');
            err.code = payload.error && payload.error.code;
            throw err;
        }
        const result = payload && payload.result;
        if (result && Array.isArray(result.content) && result.content.length > 0) {
            const first = result.content[0];
            if (first && typeof first.text === 'string') {
                return first.text;
            }
        }
        return result;
    }

    // Top-level handler invoked by the ElevenLabs SDK. Catches a final 401 (a
    // refresh-then-retry that also failed) and ends the call gracefully so
    // the user isn't stranded in a session whose tools no longer work. Other
    // errors propagate so the agent receives a tool-error response.
    async function invokeMCPTool(name, args) {
        try {
            return await callMCPTool(name, args);
        } catch (err) {
            if (err && err.status === 401) {
                setState('error', 'Voice session expired');
                endCall().catch(() => { /* ignore */ });
            }
            throw err;
        }
    }

    // Descriptions and schemas mirror the MCP server's tool registration in
    // internal/mcp/mcp.go:236-296. Keep them in sync (or migrate to a
    // shared source) — if they drift, the agent will see a different
    // surface than what the server actually accepts.
    function buildClientTools() {
        const tools = {
            mcp_help: {
                description: "List available backend operations for use in mcp_execute scripts. Filter by topic (one of: 'workouts', 'medications', 'food', 'health'; omit or pass 'all' for the full catalog) or pass operation_id (e.g. 'workouts.groups.list') for a single-entry lookup. operation_id takes precedence over topic when both are passed. Each entry includes params/body schema, return shape, and a Python example. Read-only and safe to call before any write.",
                parameters: {
                    type: 'object',
                    properties: {
                        topic: {
                            type: 'string',
                            description: "Domain to filter by (e.g. 'workouts', 'food', 'health'). Omit or pass 'all' for the full catalog.",
                        },
                        operation_id: {
                            type: 'string',
                            description: "Exact operation ID for a single-entry lookup (e.g. 'workouts.groups.list'). Takes precedence over topic.",
                        },
                    },
                },
                handler: async (args) => invokeMCPTool('mcp_help', args),
            },
        };
        if (MCP_VOICE_ENABLE_EXECUTE) {
            tools.mcp_execute = {
                description: "Run a sandboxed Python script against backend APIs. The script MUST call output(value) exactly once — calling it zero times or more than once aborts the run. Discover operations via mcp_help BEFORE writing the script. For writes, pass mode='write' AND a non-empty intent (a one-sentence human-readable summary of what the script will change, e.g. 'Archive medication Lisinopril'). topic_allowlist (optional) restricts which operation topics the script may access; an empty list means all topics are allowed. Timestamps inside scripts use the user's stored timezone unless an operation accepts an explicit tz/tz_offset. Returns {status, result, error, api_calls, stdout, stderr}.",
                parameters: {
                    type: 'object',
                    required: ['script'],
                    properties: {
                        script: {
                            type: 'string',
                            description: 'Python script to execute. Must call output(value) exactly once to record the result.',
                        },
                        mode: {
                            type: 'string',
                            enum: ['read_only', 'write'],
                            description: "Execution mode. Defaults to 'read_only'. Write operations require mode='write' and a non-empty intent.",
                        },
                        intent: {
                            type: 'string',
                            description: "Required when mode='write'. One short human-readable sentence describing the change (e.g. 'Archive medication Lisinopril', 'Log 200kcal lunch'). Recorded in the audit trail.",
                        },
                        timeout_ms: {
                            type: 'integer',
                            description: 'Wall-clock timeout in milliseconds. Capped by server config (default 30000).',
                        },
                        max_api_calls: {
                            type: 'integer',
                            description: 'Maximum number of API calls the script may make. Capped by server config (default 100).',
                        },
                        topic_allowlist: {
                            type: 'array',
                            items: { type: 'string' },
                            description: "Optional list of topics the script may access (e.g. ['workouts']). Empty means all topics allowed.",
                        },
                    },
                },
                handler: async (args) => invokeMCPTool('mcp_execute', args),
            };
        }
        return tools;
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
        // FormData bodies set their own Content-Type with boundary, so the
        // helper's plain auth-only headers form applies here.
        const resp = await fetch(url, { method: 'POST', headers: window.makeAuthHeaders(), body: form });
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
        mcpSession = null;
        if (conv && typeof conv.endSession === 'function') {
            try { await conv.endSession(); } catch (_) { /* ignore */ }
        }
        // Preserve an error state set immediately before teardown (e.g. the
        // final-401 path in invokeMCPTool) so the failure message remains
        // visible after the SDK cleanly disconnects.
        if (activeState !== 'error') {
            setState('idle', '');
        }
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
            // Mint a short-lived MCP token + register dynamic client tools
            // for the agent. Failure is non-fatal: the call still proceeds
            // (the agent simply won't have mcp_help / mcp_execute as
            // dynamic tools), so a misconfigured MCP server cannot block
            // voice calls entirely.
            let clientTools = null;
            try {
                await refreshMCPSession();
                clientTools = buildClientTools();
            } catch (err) {
                console.warn('MCP client tools unavailable:', err && err.message);
                mcpSession = null;
            }
            const sessionOpts = {
                signedUrl,
                onConnect: () => setState('in_call', 'Connected'),
                onDisconnect: () => {
                    activeConversation = null;
                    mcpSession = null;
                    // Preserve an error state set just before disconnect (the
                    // final-401 path in invokeMCPTool) so the SDK's clean
                    // teardown doesn't bury the failure message.
                    if (activeState !== 'error') {
                        setState('idle', '');
                    }
                },
                onError: (err) => {
                    activeConversation = null;
                    mcpSession = null;
                    const msg = (err && (err.message || err.error)) || 'Call error';
                    setState('error', msg);
                },
                onModeChange: (m) => {
                    const mode = m && (m.mode || m);
                    if (mode === 'speaking') setState('in_call', 'Agent speaking…');
                    else if (mode === 'listening') setState('in_call', 'Listening…');
                },
            };
            if (clientTools) {
                sessionOpts.clientTools = clientTools;
            }
            activeConversation = await Conversation.startSession(sessionOpts);
        } catch (err) {
            activeConversation = null;
            mcpSession = null;
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
