// ElevenLabs conversational agent — the Today call bar (kit .wg-callbar, T2/T4/T5).
//
// Uses the @elevenlabs/client SDK directly (loaded as ESM from our own origin,
// vendor/elevenlabs-client.min.js) so we can drive the call from a single
// button: idle → connecting → in_call.
//
// State machine:
//   idle       — trigger reads "Call agent"; click → startCall(). With no
//                vault key and no trial it reads "Set up voice agent" and
//                opens Settings → AI & integrations instead; offline it is
//                disabled and reads "Call needs a connection".
//   connecting — the bar goes --live: status "Connecting…", End call cancels;
//                bounded by CONNECT_TIMEOUT_MS
//   in_call    — --live: status reflects agent mode (Listening… / Speaking…),
//                Mute / Send photo / End call icon buttons
//   error      — trigger reads "Try again", the message sits under the bar
//
// There is one control surface: the Today call bar. While a call is in flight
// and the bar is scrolled out of view or Today is not the active tab, the bar
// itself moves to <body> and docks above the tab bar (.wg-callbar--dock); a
// fixed-height slot keeps its place in Today until it comes back.
//
// The signed URL is minted browser-direct from the vault's ElevenLabs key
// (window.CloudElevenLabs; the key never crosses /api). The SDK handles the
// WebSocket session + AudioWorklets; every worklet module it loads is
// self-hosted (WORKLET_PATHS and LIBSAMPLERATE_PATH below) so the
// DEK-bearing document can keep a plain `script-src 'self'` — see
// setSecurityHeaders in internal/cloudserver/router.go (bd med-yor.8,
// med-yor.17).
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
        // There is no server signed-URL route — mint it browser-direct
        // from the vault's ElevenLabs key (BYO; key never crosses /api). First
        // auto-provision the tools + MedTracker agent from code (idempotent;
        // reprovisions only on a toolset-version bump) so the user configures
        // only the API key. Provisioning errors surface as the call status.
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

    // Cloud-only dynamic MCP client-tools. The ElevenLabs agent invokes these
    // by name — for a BYO key the names come from elevenlabs-agent.js
    // TOOL_SPECS, which provisions them; the trial agent's list lives in the
    // operator's ElevenLabs dashboard instead. Each callback
    // dispatches straight into the in-tab MCP dispatcher — no relay, no crypto,
    // since this tab is both the voice client and the MCP responder host.
    // Returns JSON strings the agent reads; dispatcher errors come back as a
    // short string rather than throwing into the SDK.
    function buildClientTools() {
        if (!window.CloudMCPDispatcher) return undefined;
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

    // The connect chain (signed URL → SDK → startSession, which awaits the
    // browser's mic-permission prompt inside the SDK) is unbounded: an
    // unanswered prompt never settles and pins activeState at 'connecting'
    // forever (bd med-i5wi). Two pieces:
    //
    //   callGeneration — bumped by every startCall/endCall and by the
    //     watchdog. The pending chain captures its generation; a stale one
    //     must not paint state and must end a session it belatedly receives
    //     rather than adopting it (that session is live and untracked).
    //   connectTimer   — one watchdog per attempt, cleared when the chain
    //     settles. Deliberately NOT cleared by onConnect: if the promise
    //     hangs after connecting we still have no conversation handle to end.
    const CONNECT_TIMEOUT_MS = 30000;
    let callGeneration = 0;
    let connectTimer = null;

    function clearConnectWatchdog() {
        if (connectTimer !== null) {
            clearTimeout(connectTimer);
            connectTimer = null;
        }
    }

    // Abandon whatever connect chain is in flight: the bump makes its late
    // resolution (and its SDK callbacks) stale.
    function cancelConnect() {
        callGeneration += 1;
        clearConnectWatchdog();
    }

    // Voice readiness for the idle trigger (kit T4): true once a vault key or
    // the operator trial is known to exist, false when neither is, null while
    // unknown (the trigger then reads "Call agent" and a tap tries the call,
    // which surfaces the existing set-your-key error if it was wrong).
    let voiceReady = null;

    function isOffline() {
        return typeof navigator !== 'undefined' && navigator.onLine === false;
    }

    async function refreshReadiness() {
        let ready = false;
        try {
            ready = trialVoiceAvailable()
                || Boolean(window.CloudElevenLabs && await window.CloudElevenLabs.hasKey());
        } catch (_) { /* unreadable key = not set up */ }
        voiceReady = ready;
        applyState(activeCard, activeState, activeMessage);
    }

    // "Set up voice agent": Settings → AI & integrations, scrolled to the
    // ElevenLabs key, instead of a call that can only fail.
    function openVoiceSetup() {
        if (typeof window.switchTab === 'function') window.switchTab('settings');
        const settings = window.SettingsView;
        if (settings && typeof settings.openSettingsPage === 'function') settings.openSettingsPage('integrations');
        const key = document.getElementById('integrations-elevenlabs-api-key');
        if (key && typeof key.scrollIntoView === 'function') key.scrollIntoView({ block: 'center' });
    }

    function icon(name, small) {
        const i = document.createElement('i');
        i.className = small ? 'wg-ico wg-ico--sm' : 'wg-ico';
        i.setAttribute('aria-hidden', 'true');
        setIcon(i, name);
        return i;
    }

    function setIcon(i, name) {
        if (!i || i.getAttribute('data-icon') === name) return;
        i.setAttribute('data-icon', name);
        i.replaceChildren();
        if (window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
            try { i.appendChild(window.WGIcons.iconSvg(name)); } catch (_) { /* ignore */ }
        }
    }

    function applyState(card, state, message) {
        if (!card) return;
        card.dataset.state = state;
        const live = state === 'connecting' || state === 'in_call';
        card.classList.toggle('wg-callbar--live', live);
        const btn = card.querySelector('.wg-callbar__call');
        const label = card.querySelector('.wg-callbar__label');
        const status = card.querySelector('.wg-callbar__status');
        const error = card.querySelector('.wg-callbar__error');
        const muteBtn = card.querySelector('.wg-callbar__mute');
        const photoBtn = card.querySelector('.wg-callbar__photo');
        const offline = !live && isOffline();
        const setup = state === 'idle' && !offline && voiceReady === false;
        if (btn) {
            btn.disabled = state === 'connecting' || offline;
            btn.dataset.action = setup ? 'voice-setup' : 'call-agent';
            setIcon(btn.querySelector('.wg-ico'), offline ? 'phone-off' : 'phone');
        }
        if (label) {
            if (offline) label.textContent = 'Call needs a connection';
            else if (setup) label.textContent = 'Set up voice agent';
            else if (state === 'idle') label.textContent = 'Call agent';
            else if (state === 'connecting') label.textContent = 'Connecting…';
            else if (state === 'in_call') label.textContent = 'End call';
            else if (state === 'error') label.textContent = 'Try again';
        }
        if (status) {
            status.textContent = message || (state === 'connecting' ? 'Connecting…' : 'In call');
        }
        if (error) {
            error.textContent = state === 'error' ? (message || '') : '';
            error.hidden = !error.textContent;
        }
        if (muteBtn) {
            muteBtn.setAttribute('aria-pressed', activeMuted ? 'true' : 'false');
            muteBtn.setAttribute('aria-label', activeMuted ? 'Unmute' : 'Mute');
            setIcon(muteBtn.querySelector('.wg-ico'), activeMuted ? 'mic-off' : 'mic');
            muteBtn.disabled = state === 'connecting';
        }
        if (photoBtn) {
            photoBtn.disabled = state === 'connecting' || activeUploading;
            photoBtn.setAttribute('aria-label', activeUploading ? 'Sending…' : 'Send photo');
        }
    }

    // ---- Docking (kit T2) -------------------------------------------------
    // While a call is in flight and the bar is out of view — scrolled past,
    // or Today is not the active tab (its .view is display:none, so a fixed
    // child would vanish with it) — the bar moves to <body> with --dock. A
    // slot keeps its place in Today: it is the scroll anchor while docked and
    // where the bar returns to.
    let dockSlot = null;

    function isDocked() {
        return Boolean(activeCard && activeCard.classList.contains('wg-callbar--dock'));
    }

    function shouldDock() {
        if (!callInFlight() || !activeCard || !activeCard.classList.contains('wg-callbar')) return false;
        const anchor = isDocked() ? dockSlot : activeCard;
        if (!anchor || !anchor.isConnected) return false;
        const view = anchor.closest('.view');
        if (view && !view.classList.contains('active')) return true;
        const rect = anchor.getBoundingClientRect();
        return rect.height > 0 && rect.bottom <= 0;
    }

    function updateDock() {
        const bar = activeCard;
        if (!bar) return;
        const dock = shouldDock();
        if (dock === isDocked()) return;
        if (dock) {
            dockSlot = document.createElement('div');
            dockSlot.className = 'wg-callbar-slot';
            dockSlot.setAttribute('aria-hidden', 'true');
            bar.parentNode.insertBefore(dockSlot, bar);
            document.body.appendChild(bar);
            bar.classList.add('wg-callbar--dock');
            return;
        }
        bar.classList.remove('wg-callbar--dock');
        if (dockSlot && dockSlot.isConnected) dockSlot.replaceWith(bar);
        else bar.remove(); // Today was rebuilt under it; the new bar is mounted there.
        dockSlot = null;
    }

    window.addEventListener('scroll', () => { if (activeCard) updateDock(); }, { capture: true, passive: true });
    window.addEventListener('online', () => applyState(activeCard, activeState, activeMessage));
    window.addEventListener('offline', () => applyState(activeCard, activeState, activeMessage));
    if (window.AppStore && typeof window.AppStore.subscribe === 'function') {
        window.AppStore.subscribe('currentTab', () => updateDock());
    }

    function setState(state, message) {
        activeState = state;
        activeMessage = message || '';
        if (state === 'idle' || state === 'error') {
            activeMuted = false;
            activeUploading = false;
        }
        applyState(activeCard, state, activeMessage);
        // A call that fails while docked over another tab undocks back into
        // Today, out of sight — say so where the user is.
        if (state === 'error' && isDocked() && typeof window.safeToast === 'function') {
            window.safeToast(activeMessage || 'Call error', 'error');
        }
        updateDock();
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

    // File upload for the in-call "Send photo" control. POSTs multipart
    // straight to api.elevenlabs.io with the user's vault key
    // (window.CloudElevenLabs.uploadFile — the BYO seam, key never crosses /api).
    async function uploadFile(conv, file) {
        const conversationId = resolveConversationId(conv);
        if (!conversationId) {
            throw new Error('Conversation id unavailable');
        }
        return window.CloudElevenLabs.uploadFile(conversationId, file);
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
        cancelConnect();
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
        cancelConnect();
        const gen = callGeneration;
        const live = () => gen === callGeneration;
        setState('connecting', 'Connecting…');
        connectTimer = setTimeout(() => {
            connectTimer = null;
            if (!live()) return;
            callGeneration += 1;
            setState('error', 'Connection timed out — allow microphone access and try again.');
        }, CONNECT_TIMEOUT_MS);
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
            const conv = await Conversation.startSession({
                signedUrl,
                workletPaths: WORKLET_PATHS,
                libsampleratePath: LIBSAMPLERATE_PATH,
                ...(clientTools ? { clientTools } : {}),
                onConnect: () => { if (live()) setState('in_call', 'Connected'); },
                onDisconnect: () => {
                    if (!live()) return;
                    activeConversation = null;
                    setState('idle', '');
                },
                onError: (err) => {
                    if (!live()) return;
                    activeConversation = null;
                    const msg = (err && (err.message || err.error)) || 'Call error';
                    setState('error', msg);
                },
                onModeChange: (m) => {
                    if (!live()) return;
                    const mode = m && (m.mode || m);
                    if (mode === 'speaking') setState('in_call', 'Agent speaking…');
                    else if (mode === 'listening') setState('in_call', 'Listening…');
                },
            });
            if (!live()) {
                // Timed out or hung up while this was pending: the session is
                // live but nothing tracks it. End it instead of adopting it.
                if (conv && typeof conv.endSession === 'function') {
                    try { await conv.endSession(); } catch (_) { /* ignore */ }
                }
                return;
            }
            // Keep the generation: the SDK callbacks above belong to this
            // now-adopted session and must stay live. Never `await` between
            // the !live() check and this clear — the watchdog is still armed
            // and a stall there would flip us to 'error' while the line below
            // still adopts the session, i.e. med-i5wi all over again.
            clearConnectWatchdog();
            activeConversation = conv;
        } catch (err) {
            if (!live()) return;
            clearConnectWatchdog();
            activeConversation = null;
            const msg = err && err.status === 503
                ? 'Voice agent is not configured on this server.'
                : (err && err.message) || 'Failed to start call';
            setState('error', msg);
        }
    }

    function iconButton(cls, iconName, label, onClick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `wg-btn wg-btn--icon wg-btn--sm ${cls}`;
        b.setAttribute('aria-label', label);
        b.dataset.callLive = '';
        b.appendChild(icon(iconName, true));
        b.addEventListener('click', onClick);
        return b;
    }

    // Fills the call bar (kit .wg-callbar markup): the idle trigger first so
    // the kit's `>.wg-btn:first-child{flex:1}` gives it the free width, then
    // the live-only pulse / status / Mute / Send photo / End call
    // ([data-call-live]), then the error line. CSS shows one set or the other
    // by .wg-callbar--live; the caller's own buttons (Log, Doctor brief)
    // follow and hide while live.
    function buildInto(bar) {
        bar.dataset.state = 'idle';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wg-btn wg-callbar__call';
        btn.dataset.action = 'call-agent';
        btn.appendChild(icon('phone'));
        const label = document.createElement('span');
        label.className = 'wg-callbar__label';
        label.textContent = 'Call agent';
        btn.appendChild(label);
        btn.addEventListener('click', () => {
            if (bar.dataset.state === 'in_call') endCall();
            else if (btn.dataset.action === 'voice-setup') openVoiceSetup();
            else startCall(bar);
        });
        bar.insertBefore(btn, bar.firstChild);
        let after = btn.nextSibling;
        const add = (node) => { bar.insertBefore(node, after); };

        const pulse = document.createElement('span');
        pulse.className = 'wg-pulse';
        pulse.dataset.callLive = '';
        pulse.setAttribute('aria-hidden', 'true');
        add(pulse);

        const status = document.createElement('span');
        status.className = 'wg-callbar__status';
        status.dataset.callLive = '';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        add(status);

        const muteBtn = iconButton('wg-callbar__mute', 'mic', 'Mute', () => toggleMute());
        muteBtn.setAttribute('aria-pressed', 'false');
        add(muteBtn);

        // Photo upload POSTs browser-direct to api.elevenlabs.io with the
        // vault key (window.CloudElevenLabs.uploadFile).
        const photoInput = document.createElement('input');
        photoInput.type = 'file';
        photoInput.accept = 'image/*';
        photoInput.capture = 'environment';
        photoInput.className = 'wg-callbar__photo-input';
        photoInput.hidden = true;
        photoInput.addEventListener('change', (event) => {
            const file = event.target && event.target.files && event.target.files[0];
            if (file) {
                sendPhoto(file).catch(() => { /* status surfaced via setState */ });
            }
            try { photoInput.value = ''; } catch (_) { /* ignore */ }
        });
        add(iconButton('wg-callbar__photo', 'camera', 'Send photo', () => photoInput.click()));
        add(photoInput);

        const end = iconButton('wg-callbar__end', 'phone-off', 'End call', () => endCall());
        end.classList.add('wg-btn--danger');
        add(end);

        after = null;
        const error = document.createElement('p');
        error.className = 'wg-hint wg-callbar__error';
        error.setAttribute('role', 'alert');
        error.hidden = true;
        add(error);
    }

    function mountCard(container) {
        if (!container) return null;
        if (!container.querySelector('.wg-callbar__call')) {
            // Today re-renders (sync polling, tab switch back) drop the old
            // bar. If that one was docked it lives in <body>, outside the
            // rebuilt subtree — retire it; the new bar re-docks below.
            if (activeCard && activeCard !== container && isDocked()) {
                activeCard.remove();
                if (dockSlot) dockSlot.remove();
                dockSlot = null;
            }
            buildInto(container);
            refreshReadiness();
        }
        // Live call state paints onto the newest bar, so a re-render mid-call
        // still shows the live controls and End call.
        activeCard = container;
        applyState(container, activeState, activeMessage);
        // Today attaches the row after this returns; dock once it is in.
        Promise.resolve().then(updateDock);
        return container;
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
