// ElevenLabs conversational agent — "Call agent" card on the Today screen.
//
// Uses the @elevenlabs/client SDK directly (loaded as ESM from our own origin,
// vendor/elevenlabs-client.min.js) so we can drive the call from a single
// button: idle → connecting → in_call.
//
// State machine:
//   idle       — primary button reads "Call agent"; click → startCall()
//   connecting — button disabled, status line shows "Connecting…"
//   in_call    — primary button reads "End call"; click → endCall()
//                status line reflects agent mode (Listening… / Speaking…)
//   error      — primary button reads "Try again"; click → startCall()
//
// The signed URL is fetched from /api/elevenlabs/signed-url, which keeps
// ELEVENLABS_API_KEY server-side. The SDK handles the WebSocket session +
// AudioWorklets; every worklet module it loads is self-hosted (WORKLET_PATHS
// and LIBSAMPLERATE_PATH below) so the DEK-bearing document can keep a plain
// `script-src 'self'` — see setSecurityHeaders in
// internal/cloudserver/router.go (bd med-yor.8, med-yor.17).
//
// The SDK is vendored (bd med-7e7.1) rather than pulled from esm.sh: in cloud
// mode this page holds the in-memory DEK, and a third-party script executing
// on that origin is the catastrophic case docs/cloud-crypto.md names. Same
// vendored-ESM pattern as core/backup-crypto.js's /static/vendor/age.min.js.

(function () {
    const SDK_URL = '/static/vendor/elevenlabs-client.min.js';

    // Self-hosted AudioWorklet modules. Without these the SDK builds each
    // worklet from a blob: URL (and falls back to data:), which forces the
    // document's CSP to widen `script-src` to `'self' blob: data:` — on the
    // cloud origin that is the DEK-bearing document. Passing explicit paths
    // makes the SDK addModule() these same-origin URLs instead and never mint
    // a blob/data script, so `script-src 'self'` holds. The files are extracted
    // verbatim from the vendored bundle; vendor.elevenlabs-client.test.js fails
    // if they drift from the strings the SDK would otherwise have inlined.
    //
    // Only the WebSocket session (the one `signedUrl` selects) honours these;
    // the SDK's WebRTC path builds its analyser worklet without a path option.
    // We always pass signedUrl, so we are always on the WebSocket path.
    const WORKLET_PATHS = {
        rawAudioProcessor: '/static/vendor/worklets/raw-audio-processor.js',
        audioConcatProcessor: '/static/vendor/worklets/audio-concat-processor.js',
    };

    // Self-hosted libsamplerate worklet (bd med-yor.17). The SDK resamples
    // whenever the engine cannot pin the AudioContext sample rate —
    // getSupportedConstraints().sampleRate false (Firefox, Safari) or a
    // context rate that differs from the agent's — and addModule()s
    // libsamplerate from jsdelivr to do it. Both CSPs are script-src 'self'
    // with no CDN host, so that load is blocked and the whole call throws
    // (MediaDeviceOutput.create rethrows; there is no degraded mode). The file
    // is byte-identical to the CDN/npm artifact for the pinned version the
    // bundle names — vendor.elevenlabs-client.test.js pins both the URL and
    // the bytes.
    const LIBSAMPLERATE_PATH = '/static/vendor/worklets/libsamplerate.worklet.js';

    // …and the same URL again, because @elevenlabs/client (through 1.17.0)
    // accepts `libsampleratePath` on both controllers but only forwards it to
    // the input one: setupWebSocketIO() omits it from MediaDeviceOutput.create.
    // On Firefox both controllers take the resampling branch, so passing the
    // option alone still leaves the output half fetching from jsdelivr and the
    // call still fails. The bundle is marked DO-NOT-EDIT, and the SDK exposes
    // no hook onto the output AudioContext, so we redirect that one known URL
    // at the AudioWorklet.addModule seam instead. Drops out the moment
    // upstream forwards the option.
    const LIBSAMPLERATE_CDN_URL = 'https://cdn.jsdelivr.net/npm/@alexanderolsen/libsamplerate-js@2.1.2/dist/libsamplerate.worklet.js';

    function redirectLibsamplerateWorklet() {
        const proto = window.AudioWorklet && window.AudioWorklet.prototype;
        if (!proto || proto.__medtrackerLibsamplerateRedirect) return;
        const addModule = proto.addModule;
        if (typeof addModule !== 'function') return;
        proto.addModule = function (url, options) {
            return addModule.call(this, url === LIBSAMPLERATE_CDN_URL ? LIBSAMPLERATE_PATH : url, options);
        };
        proto.__medtrackerLibsamplerateRedirect = true;
    }

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

    // Trial-voice fallback (cloud only): no vault key + operator trial flag
    // (<meta name="medtracker-trial-voice">, injected when TRIAL_ELEVENLABS_*
    // is configured) → mint from the same-origin trial proxy, which uses the
    // operator's shared agent — no provisioning, no key in the browser.
    function trialVoiceAvailable() {
        const meta = window.document.querySelector('meta[name="medtracker-trial-voice"]');
        return !!meta && meta.content === '1';
    }

    // Trial voice is gated on the encrypted-vault `trialconsent` record
    // (`voice` scope) — skipping key setup is NOT consent. Read via the shim
    // route; when no consent yet, defer to the interactive prompt seam
    // (window.TrialConsent, Task 4) if present, else refuse. Only literal
    // `true` passes. BYO-key callers never reach this.
    async function ensureTrialVoiceConsent() {
        let consent = null;
        if (typeof window.apiCall === 'function') {
            try {
                consent = await window.apiCall('/api/settings/trial-consent', 'GET');
            } catch (_) { /* unreadable consent = no consent */ }
        }
        if (consent && consent.voice === true) return;
        if (window.TrialConsent && typeof window.TrialConsent.request === 'function') {
            if (await window.TrialConsent.request('voice') === true) return;
        }
        const err = new Error("Using the operator's trial voice agent needs your consent first — allow it in Settings → Integrations.");
        err.code = 'trial_consent_required';
        err.scope = 'voice';
        throw err;
    }

    async function fetchTrialSignedURL() {
        const resp = await fetch('/api/trial/elevenlabs/signed-url', { method: 'GET' });
        if (resp.ok) {
            const data = await resp.json();
            if (!data || !data.signed_url) throw new Error('Response missing signed_url');
            return data.signed_url;
        }
        // Map errors by the trial proxy's machine-readable body, not status
        // code — behind Traefik a 503/429 can come from the reverse proxy
        // itself (backend restarting, proxy throttle) and must not degrade
        // to the misleading "set your key" message.
        let code = '';
        try {
            code = (await resp.json())?.error || '';
        } catch { /* non-JSON body — reverse-proxy error page */ }
        if (code === 'trial_rate_limit') {
            throw new Error('Trial limit reached — try again in a minute or add your own ElevenLabs key in Settings → Integrations.');
        }
        if (code === 'trial_not_configured') {
            // Flag/route mismatch — degrade to the plain BYO message.
            throw new Error('Set your ElevenLabs API key in Settings → Integrations');
        }
        // Deliberately no err.status: startCall() maps status 503 to "Voice
        // agent is not configured on this server", which is exactly the
        // misread a reverse-proxy 503 must not produce on the trial path.
        throw new Error(`Failed to get signed URL (${resp.status})`);
    }

    async function fetchSignedURL() {
        // Cloud mode has no server signed-URL route — mint it browser-direct
        // from the vault's ElevenLabs key (BYO; key never crosses /api). First
        // auto-provision the tools + MedTracker agent from code (idempotent;
        // reprovisions only on a toolset-version bump) so the user configures
        // only the API key. Provisioning errors surface as the call status.
        if (window.__MEDTRACKER_CLOUD__ && window.CloudElevenLabs) {
            const hasKey = await window.CloudElevenLabs.hasKey();
            if (!hasKey && trialVoiceAvailable()) {
                await ensureTrialVoiceConsent();
                return fetchTrialSignedURL();
            }
            // No key + no trial: provision() throws the existing
            // "Set your ElevenLabs API key…" error.
            let agentId;
            if (window.CloudElevenLabsAgent) {
                agentId = await window.CloudElevenLabsAgent.provision();
            }
            return window.CloudElevenLabs.fetchSignedURL(agentId);
        }
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

    // Cloud-only dynamic MCP client-tools. The ElevenLabs agent invokes these
    // by name — for a BYO key the names come from elevenlabs-agent.js
    // TOOL_SPECS, which provisions them; the trial agent's list lives in the
    // operator's ElevenLabs dashboard instead. Each callback
    // dispatches straight into the in-tab MCP dispatcher — no relay, no crypto,
    // since this tab is both the voice client and the MCP responder host.
    // Returns JSON strings the agent reads; dispatcher errors come back as a
    // short string rather than throwing into the SDK.
    function buildClientTools() {
        if (!window.__MEDTRACKER_CLOUD__ || !window.CloudMCPDispatcher) return undefined;
        // guard() is the single place a dispatcher throw becomes a short JSON
        // string. The workout tools chain several dispatches, so the try/catch
        // has to wrap the whole tool body, not one handle() call.
        const guard = async (fn) => {
            try {
                return JSON.stringify(await fn());
            } catch (err) {
                return JSON.stringify({ error: (err && err.message) || 'MCP dispatch failed' });
            }
        };
        const raw = (method, params) => window.CloudMCPDispatcher.handle(method, params);
        const dispatch = (method, params) => guard(() => raw(method, params));
        // The SDK sometimes hands tool args as a JSON string rather than an
        // object; coerce so destructuring works either way.
        const asObj = (a) => {
            if (typeof a === 'string') { try { return JSON.parse(a); } catch (_) { return {}; } }
            return a || {};
        };
        // now() as a stable seam so tests can stamp a deterministic timestamp.
        const nowISO = () => new Date().toISOString();
        const call = (op, params) => dispatch('mcp_call', { op, params });
        // Drop keys the agent left out. The dispatcher's required-field gate
        // tests key PRESENCE, so `{sets: undefined}` reads as "supplied" and a
        // malformed write reaches the domain as a 0 instead of bouncing back at
        // the agent with the field to resend.
        const compact = (o) => {
            const out = {};
            Object.keys(o).forEach((k) => { if (o[k] !== undefined) out[k] = o[k]; });
            return out;
        };
        // Catalog ops with risk:"write" are refused unless the envelope carries
        // mode:"write" and a non-empty intent. The user spoke the request, so
        // the intent is the voice call itself.
        const writeEnvelope = (op, params, pathParams) => {
            const env = {
                op, params: compact(params), mode: 'write',
                intent: 'logged by the user during an ElevenLabs voice call',
            };
            if (pathParams) env.path_params = pathParams;
            return env;
        };
        const write = (op, params) => dispatch('mcp_call', writeEnvelope(op, params));
        const rawWrite = (op, params, pathParams) => raw('mcp_call', writeEnvelope(op, params, pathParams));
        // One flat view of today's workout: the session, plus every exercise as
        // a uniform row. sessions.details returns only PERSISTED logs, and a
        // session nobody has touched has none — the Workouts screen synthesizes
        // the missing planned rows the same way (features/workout/sessions.js),
        // so without this the agent sees an empty workout it cannot write to.
        // A planned row carries log_id 0 and log_exercise creates its log.
        const readWorkout = async () => {
            const next = await raw('mcp_call', { op: 'workouts.sessions.next', params: {} });
            const view = next && next.result;
            const sessionId = view && view.session && view.session.id;
            if (!sessionId) return next;
            const details = await raw('mcp_call', { op: 'workouts.sessions.details', params: { id: sessionId } });
            const logs = (details && details.result && details.result.logs) || [];
            const exercises = logs.map((l) => ({
                log_id: l.id,
                exercise_id: l.exercise_id,
                exercise_name: l.exercise_name,
                sets_completed: l.sets_completed,
                reps_completed: l.reps_completed,
                weight_kg: l.weight_kg,
                status: l.status,
            }));
            // Same plan source as the Workouts screen: the session's
            // exercise_snapshot when it has one (it is the per-session copy, so
            // an exercise removed from TODAY only stays removed), else the live
            // variant. Ad-hoc sessions (variant_id -1) render from logs alone.
            const session = (details && details.result && details.result.session) || {};
            let planned = Array.isArray(session.exercise_snapshot) ? session.exercise_snapshot : null;
            if (!planned && view.variant_id > 0) {
                const listed = await raw('mcp_call', {
                    op: 'workouts.exercises.list', params: { variant_id: view.variant_id },
                });
                planned = ((listed && listed.result) || []).map((e) => ({
                    exercise_id: e.id,
                    exercise_name: e.exercise_name,
                    target_sets: e.target_sets,
                    target_reps_min: e.target_reps_min,
                    target_weight_kg: e.target_weight_kg,
                }));
            }
            // Only schedule-sourced logs consume a planned row: a mid-session
            // "library" log's exercise_id indexes the exercise library, a
            // different id space that can collide with a variant exercise id.
            // Name is the fallback for legacy rows saved without an id.
            const fromPlan = logs.filter((l) => l.source !== 'library');
            const loggedIds = new Set(fromPlan.map((l) => l.exercise_id));
            const loggedNames = new Set(fromPlan.map((l) => l.exercise_name));
            (planned || []).forEach((ex) => {
                const done = ex.exercise_id ? loggedIds.has(ex.exercise_id) : loggedNames.has(ex.exercise_name);
                if (done) return;
                exercises.push({
                    log_id: 0,
                    exercise_id: ex.exercise_id,
                    exercise_name: ex.exercise_name,
                    target_sets: ex.target_sets,
                    target_reps_min: ex.target_reps_min,
                    target_weight_kg: ex.target_weight_kg,
                    status: '',
                });
            });
            return { ...next, result: { ...view, session_id: sessionId, exercises } };
        };
        return {
            // Parity surface: these two reach the whole catalog, so the agent
            // is never stuck without a tool for what the user asked (med-eas.82
            // — it used to file a workout edit as a diary note). Provisioned in
            // TOOL_SPECS alongside the concrete tools, which stay because voice
            // LLMs drive those far more reliably on the frequent paths.
            mcp_help: async (a) => {
                const { query, topic, operation_id: operationId } = asObj(a);
                return dispatch('mcp_help', compact({ query, topic, operation_id: operationId }));
            },
            // Forwards the whole envelope (operation_id/op, params, path_params,
            // body, mode, intent) so a write reaches the dispatcher's gate with
            // the payload and intent the agent stated. ElevenLabs client tools
            // are flat, so the two object fields arrive as JSON strings.
            mcp_call: async (a) => {
                const { params_json, path_params_json, ...rest } = asObj(a);
                const parsed = {};
                try {
                    if (params_json) parsed.params = JSON.parse(params_json);
                    if (path_params_json) parsed.path_params = JSON.parse(path_params_json);
                } catch (err) {
                    return JSON.stringify({
                        error: `params_json / path_params_json must each be a JSON object encoded as a string: ${err.message}`,
                    });
                }
                return dispatch('mcp_call', {
                    ...rest,
                    ...parsed,
                    params: parsed.params || rest.params || {},
                });
            },
            // Concrete tools whose names match the provisioned ElevenLabs tools
            // (elevenlabs-agent.js TOOL_SPECS). Each maps 1:1 to a catalog op.
            get_blood_pressure: async (a) => call('health.bp.list', { days: asObj(a).days }),
            log_blood_pressure: async (a) => {
                const { systolic, diastolic, pulse } = asObj(a);
                return write('health.bp.create', { measured_at: nowISO(), systolic, diastolic, pulse });
            },
            get_weight: async (a) => call('health.weight.list', { days: asObj(a).days }),
            log_weight: async (a) => write('health.weight.create', { measured_at: nowISO(), weight: asObj(a).kg }),
            get_notes: async () => call('health.notes.list', {}),
            add_note: async (a) => {
                const { text, tag } = asObj(a);
                return write('health.notes.create', { content: text, tag });
            },
            // Chains three reads into one tool call because a voice LLM asked
            // to chain them itself before every write mostly won't.
            get_workout: async () => guard(readWorkout),
            // Reads before it writes: the read is what tells it whether the
            // session is even today's, which row the agent means, and what the
            // planned targets are — none of which the agent can be trusted to
            // carry correctly across two turns.
            log_exercise: async (a) => guard(async () => {
                const args = asObj(a);
                const before = await readWorkout();
                const view = (before && before.result) || null;
                const session = view && view.session;
                if (!session) return { error: 'nothing is scheduled, so there is no exercise to log' };
                // sessions.next also surfaces sessions scheduled for a LATER
                // day. Logging actuals into one would record the workout on the
                // wrong date and propagate the numbers into that day's plan;
                // starting it re-keys it onto today first.
                if (session.is_today === false) {
                    return {
                        error: 'that workout is scheduled for a later day — call set_workout_status with '
                            + 'in_progress first (that moves it to today), then log the exercise',
                    };
                }
                const logId = Number(args.log_id) || 0;
                const exerciseId = Number(args.exercise_id) || 0;
                const row = (view.exercises || []).find((r) => (logId
                    ? r.log_id === logId
                    : exerciseId && r.exercise_id === exerciseId));
                if (!row) {
                    // Never silently no-op: logs.update against an unknown id
                    // succeeds with an empty body, so the agent would report a
                    // write that never happened.
                    return {
                        error: 'no such exercise in this workout — call get_workout and use the log_id '
                            + 'or exercise_id from one of its rows',
                    };
                }
                const {
                    sets, reps, weight_kg: weightKg, notes, status,
                } = args;
                if (row.log_id > 0) {
                    // Omitted scalars are dropped, not sent as 0: updateLog
                    // reads an absent sets/reps/weight/status as "no data" and
                    // keeps what is stored, so the agent can log reps without
                    // clobbering the weight. (`notes` is the exception — that op
                    // always rewrites it, exactly as the Workouts screen does.)
                    await rawWrite('workouts.sessions.logs.update', {
                        id: row.log_id, sets_completed: sets, reps_completed: reps, weight_kg: weightKg, notes, status,
                    });
                } else {
                    // No log row yet. logs.create carries the actuals in its
                    // target_* fields — the same call the Workouts screen makes
                    // when you fill in a planned row — falling back to the
                    // planned targets so "skip the rows", which names no
                    // numbers, still satisfies the op's required fields.
                    await rawWrite('workouts.sessions.logs.create', {
                        session_id: view.session_id,
                        exercise_id: row.exercise_id,
                        exercise_name: row.exercise_name,
                        target_sets: sets === undefined ? row.target_sets : sets,
                        target_reps_min: reps === undefined ? row.target_reps_min : reps,
                        target_weight_kg: weightKg === undefined ? row.target_weight_kg : weightKg,
                        status: status || 'completed',
                        notes,
                    });
                }
                // These ops answer with an empty body, so the re-read is the
                // only thing the agent can confirm the write against.
                return { status: 'ok', workout: await readWorkout() };
            }),
            set_workout_status: async (a) => guard(async () => {
                const { session_id: sessionId, status } = asObj(a);
                if (status === 'in_progress') {
                    // sessions.status only flips the field; sessions.start also
                    // stamps started_at, clears a snooze, and re-keys a session
                    // scheduled for another day onto today — which changes the
                    // ids, hence the refreshed read.
                    await rawWrite('workouts.sessions.start', {}, { id: sessionId });
                    return { status: 'ok', workout: await readWorkout() };
                }
                await rawWrite('workouts.sessions.status', { id: sessionId, status });
                // No re-read here: sessions.next excludes terminal sessions, so
                // it would answer with an unrelated future workout and the agent
                // would describe that one instead of the one it just closed.
                return { status: 'ok', session_id: sessionId, session_status: status };
            }),
        };
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

    // A call is "in flight" from the moment startCall() flips to 'connecting',
    // before activeConversation exists. Both the mount path and the start guard
    // need that window: a re-render landing in it must not rebuild an
    // idle-looking trigger the user can tap into a second, untracked session.
    function callInFlight() {
        return Boolean(activeConversation) || activeState === 'connecting';
    }

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

    function resolveConversationId(conv) {
        return (typeof conv.getId === 'function')
            ? conv.getId()
            : (conv.conversationId || conv.id || null);
    }

    // Mode-aware file upload for the in-call "Send photo" control. Cloud mode
    // POSTs multipart straight to api.elevenlabs.io with the user's vault key
    // (window.CloudElevenLabs.uploadFile — the BYO seam, key never crosses /api).
    // Bot mode proxies through the server route so the operator's key stays
    // hidden (see uploadFileViaProxy).
    async function uploadFile(conv, file) {
        if (window.__MEDTRACKER_CLOUD__ && window.CloudElevenLabs
            && typeof window.CloudElevenLabs.uploadFile === 'function') {
            const conversationId = resolveConversationId(conv);
            if (!conversationId) {
                throw new Error('Conversation id unavailable');
            }
            return window.CloudElevenLabs.uploadFile(conversationId, file);
        }
        return uploadFileViaProxy(conv, file);
    }

    // Proxy the file through our backend so the server's xi-api-key can sign
    // the upload. The SDK's conv.uploadFile() posts directly to ElevenLabs
    // from the browser and 401s with `sign_in_required` because we never
    // expose the API key to the client.
    async function uploadFileViaProxy(conv, file) {
        const conversationId = resolveConversationId(conv);
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
            if (resp.status === 429 && window.DemoBanner && typeof window.DemoBanner.tryHandleResponse === 'function') {
                const demoParsed = await window.DemoBanner.tryHandleResponse(resp);
                if (demoParsed) {
                    const demoErr = new Error('Demo rate limit reached');
                    demoErr.status = 429;
                    demoErr.demoLimit = demoParsed;
                    throw demoErr;
                }
            }
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
            const fileId = await uploadFile(conv, file);
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
        if (callInFlight()) return;
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
            const clientTools = buildClientTools();
            redirectLibsamplerateWorklet();
            activeConversation = await Conversation.startSession({
                signedUrl,
                workletPaths: WORKLET_PATHS,
                libsampleratePath: LIBSAMPLERATE_PATH,
                ...(clientTools ? { clientTools } : {}),
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

        // Photo upload is mode-aware: cloud mode POSTs browser-direct to
        // api.elevenlabs.io with the vault key (window.CloudElevenLabs.uploadFile),
        // bot mode proxies through /api/elevenlabs/upload-file. Render in both.
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
            if (callInFlight()) {
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
        if (callInFlight()) {
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
