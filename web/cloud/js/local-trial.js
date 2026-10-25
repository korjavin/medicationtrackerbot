// Local mode's anonymous trial AI (bd med-o7zq.16): the client of our server's
// base-domain /api/attest/* routes (internal/cloudserver/attest.go,
// docs/cloud-mode.md → Anonymous trial). Local mode has no account, so each
// request carries an App Attest assertion from the iOS shell instead
// (window.Attest, web/static/js/native/attest.js).
//
// createAttestClient is the transport alone — challenge reuse, enrollment,
// signed POSTs and GETs — with nothing trial-specific in it, so another attest-gated
// route can reuse it. createLocalTrial puts aiclient's trial transport
// (setTrialTransport) and the Settings state on top.
//
// The trial is only ever installed when the user turned it on (local-policy.js
// registerLocalEgress): off, none of it runs. The same switch covers the
// operator's food database (foodGet, bd med-o7zq.20) and trial voice calls
// (voiceStart, bd med-o7zq.23). The one other caller of the attest client is
// a feedback send the user taps (bd med-ta2n.20, local-policy.js).

const STATE_KEY = 'wg:local-trial';
const ERASE_PATH = '/api/attest/delete';

function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function errorCode(res) {
  try {
    const obj = await res.clone().json();
    return { code: typeof obj?.error === 'string' ? obj.error : '', scope: obj?.scope || '', body: obj };
  } catch {
    return { code: '', scope: '', body: null };
  }
}

// createAttestClient({ attest, base, fetchImpl, onResponse, enrollTrial })
//   enrollTrial()                    → false: enroll asks for a feedback-only key
//                                      (`trial: false`, bd med-ta2n.25), no grant
//   enroll()                         → Response of POST /api/attest/enroll
//                                      (or of the challenge fetch, when that failed)
//   post(pathAndQuery, body, signal) → Response of the signed POST
//   get(pathAndQuery, signal)        → Response of the signed GET (empty body)
//   erase(signal)                    → 'deleted' | 'unknown' | 'no_key' | 'failed'
//                                      (the install record's deletion, bd med-egb3)
// Every response goes to onResponse(res, pathAndQuery) first.
//
// The signed input (attest.go chat): clientDataHash = SHA256(challenge ‖
// SHA256(pathAndQuery ‖ "\n" ‖ body)); this side computes the inner digest
// over the exact bytes it sends, the shell the outer hash. Challenges are
// single-use: the next one rides on the last response (X-Attest-Challenge),
// so the steady state is one round trip per request.
export function createAttestClient({
  attest, base, fetchImpl, onResponse = () => {}, enrollTrial = () => true, subtle = globalThis.crypto.subtle,
}) {
  const origin = `https://${base}`;
  let challenge = '';
  // The challenge JSON's feedback_recipient (bd med-ta2n.19): null until one
  // was read, '' when the server has feedback off (or predates the field).
  let recipient = null;
  const readRecipient = (body) => {
    recipient = typeof body?.feedback_recipient === 'string' ? body.feedback_recipient : '';
  };

  async function send(pathAndQuery, init) {
    const res = await fetchImpl(origin + pathAndQuery, { method: 'POST', ...init });
    const next = res.headers.get('X-Attest-Challenge');
    if (next) challenge = next;
    await onResponse(res, pathAndQuery);
    return res;
  }

  // { challenge } or, when none could be had, { res } to hand back as is
  // (trial_not_configured, the per-IP limit).
  // `signal` (the request's) covers the challenge fetch too.
  async function takeChallenge(signal) {
    if (challenge) {
      const c = challenge;
      challenge = '';
      return { challenge: c };
    }
    const res = await send('/api/attest/challenge', signal ? { signal } : {});
    challenge = '';
    if (!res.ok) return { res };
    const body = await res.json();
    readRecipient(body);
    return { challenge: body.challenge };
  }

  // The feedback recipient (local feedback, bd med-ta2n.20): the last
  // challenge's, else one challenge fetch — whose challenge the next signed
  // request then uses. null when the server could not be asked.
  async function feedbackRecipient() {
    if (recipient !== null) return recipient;
    const res = await send('/api/attest/challenge', {});
    if (!res.ok) return null;
    const body = await res.json();
    readRecipient(body);
    if (typeof body.challenge === 'string') challenge = body.challenge;
    return recipient;
  }

  // Single-flight: the boot-time enroll and a request's install_unknown /
  // no_key retry must share one enrollment. Two would mint two keys, and the
  // second meets DeviceCheck bit0 — trial_already_used for an install that
  // was just granted. Each caller gets its own clone of the one response.
  // `granted` counts successful enrollments: a request signed before one
  // finished re-signs with the new key instead of enrolling yet another.
  let enrolling = null;
  let granted = 0;
  function enroll() {
    if (!enrolling) enrolling = doEnroll().finally(() => { enrolling = null; });
    return enrolling.then((res) => res.clone());
  }

  // Trial pass (bd med-o7zq.26): a fresh grant's body carries the device
  // bucket's pass, which the shell keeps in the Keychain; the shell's enroll
  // reply hands it back after a reinstall, and the server binds the new key
  // to the same bucket — one shared budget, nothing resets. A pass the server
  // refuses (trial_pass_invalid) is dropped and the enroll runs once more
  // without it.
  async function doEnroll(withPass = true) {
    const got = await takeChallenge();
    if (got.res) return got.res;
    const reply = await attest.enroll(got.challenge);
    const pass = withPass && typeof reply.pass === 'string' ? reply.pass : '';
    const res = await send('/api/attest/enroll', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key_id: reply.keyId,
        attestation: reply.attestation,
        challenge: got.challenge,
        device_token: reply.deviceToken,
        // Android (Attest.kt): Play Integrity instead; its reply has no attestation/deviceToken, so both drop out.
        ...(reply.kind === 'android' ? { kind: 'android', public_key: reply.publicKey, integrity_token: reply.integrityToken } : {}),
        ...(pass ? { pass } : {}),
        ...(enrollTrial() ? {} : { trial: false }),
      }),
    });
    if (res.ok) {
      granted += 1;
      const body = await res.clone().json().catch(() => null);
      // A Keychain failure costs only the rejoin after a reinstall.
      if (typeof body?.pass === 'string' && body.pass) await attest.setPass(body.pass).catch(() => {});
      return res;
    }
    if (pass && (await errorCode(res)).code === 'trial_pass_invalid') {
      await attest.setPass('').catch(() => {});
      return doEnroll(false);
    }
    return res;
  }

  async function signedRequest(method, pathAndQuery, body, signal) {
    // A pending enrollment decides which key signs: wait for it.
    if (enrolling) await enrolling.catch(() => {});
    const gen = granted;
    const got = await takeChallenge(signal);
    if (got.res) return { res: got.res, gen };
    const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(`${pathAndQuery}\n${body}`)));
    let signed;
    try {
      signed = await attest.assert(got.challenge, b64(digest));
    } catch (e) {
      challenge = got.challenge; // unused: still good for the enroll
      if (/no_key/.test(String(e && e.message))) return { needsKey: true, gen };
      throw e;
    }
    const headers = {
      'X-Attest-Key-Id': signed.keyId,
      'X-Attest-Challenge': got.challenge,
      'X-Attest-Assertion': signed.assertion,
    };
    const init = method === 'GET'
      ? { method, headers, signal }
      : { method, headers: { 'Content-Type': 'application/json', ...headers }, body, signal };
    return { res: await send(pathAndQuery, init), gen };
  }

  // One retry, for what a fresh attempt fixes: a challenge that expired
  // (challenge_invalid), or a key the server or the shell does not have
  // (install_unknown / no_key → enroll a key first). Anything else goes back
  // to the caller, whose error mapping reads the body.
  async function request(method, rawPathAndQuery, body, signal) {
    // Sign exactly what goes on the wire: fetch serialises the URL (WHATWG),
    // escaping what encodeURIComponent leaves alone — ' → %27 in the query —
    // and the server hashes that RequestURI. Signing the raw string would
    // fail every such request with assertion_invalid.
    const u = new URL(rawPathAndQuery, origin);
    const pathAndQuery = u.pathname + u.search;
    for (let attempt = 0; ; attempt += 1) {
      const out = await signedRequest(method, pathAndQuery, body, signal);
      let { code } = out.res ? await errorCode(out.res) : { code: '' };
      if (out.needsKey) code = 'install_unknown';
      const retry = attempt === 0 && (code === 'challenge_invalid' || code === 'install_unknown');
      if (!retry) {
        if (out.res) return out.res;
        throw Object.assign(new Error('The app has no trial key.'), { code: 'no_key' });
      }
      // An enrollment that succeeded after this attempt was signed already
      // gave the shell a granted key: re-sign with it, never mint another.
      if (code === 'install_unknown' && out.gen === granted) {
        const enrolled = await enroll();
        if (!enrolled.ok) return enrolled;
      }
    }
  }

  // The erase's deletion of this install's record (bd med-egb3; server:
  // attest.go eraseInstall). Unlike request(), it never enrolls: a key the
  // server or the shell does not have has nothing to delete. One re-sign for
  // an expired challenge (the cached one is usually stale by then), nothing
  // else retried. Resolves 'deleted' (204), 'unknown' (install_unknown: the
  // server has no such install), 'no_key' (the shell has none) or 'failed'
  // (offline, an old shell's `invalid path`, a server without the route's
  // 404, 5xx, `signal` aborted, …); never throws. Once `signal` aborts no
  // further request starts (shellPost and fetch both honour it).
  async function erase(signal) {
    try {
      for (let attempt = 0; attempt < 2 && !signal?.aborted; attempt += 1) {
        const out = await signedRequest('POST', ERASE_PATH, '', signal);
        if (out.needsKey) return 'no_key';
        if (out.res.ok) return 'deleted';
        const { code } = await errorCode(out.res);
        if (code === 'install_unknown') return 'unknown';
        if (code !== 'challenge_invalid') break;
      }
    } catch { /* network, op error: below */ }
    return 'failed';
  }

  return {
    enroll,
    erase,
    feedbackRecipient,
    post: (pathAndQuery, body, signal) => request('POST', pathAndQuery, body, signal),
    // An empty body: the digest is SHA256(pathAndQuery ‖ "\n") (attest.go food routes).
    get: (pathAndQuery, signal) => request('GET', pathAndQuery, '', signal),
  };
}

const VOICE_START = '/api/attest/voice/start';

// voiceStart's refusals, by the server's machine-readable error (and the
// budget's scope). Never err.status: the call bar maps a 503 to its own copy.
const device = () => globalThis.LocalNotifications?.copy?.device || 'iPhone';
const voiceCopy = () => ({
  voice_not_configured: 'Voice calls are not available on this server.',
  trial_not_configured: 'Voice calls are not available on this server.',
  'voice:voice': `Free voice minutes used up on this ${device()}. Add your own keys in a cloud account to keep calling.`,
  'voice:voice-day': 'Free voice calls paused until tomorrow.',
  'voice:global': 'The free voice line is busy today — try again tomorrow.',
  // One call per install: the last one is still in the server's 30 s grace.
  call_in_progress: 'Your last call is still ending — try again in a minute.',
  trial_already_used: `The free trial was already used on this ${device()}.`,
});

function voiceError(code, status) {
  const message = voiceCopy()[code] || `Could not start the call${status ? ` (${status})` : ''}.`;
  return Object.assign(new Error(message), { code: code || 'voice_start_failed' });
}

// The operator's voice limits from a server body (bd med-o7zq.28): the copy
// derives from them, so a TRIAL_ANON_VOICE_* change needs no app release. A
// server that sends none leaves the memo's alone.
function voiceLimits(body) {
  const out = {};
  for (const [field, key] of [['voice_lifetime_seconds', 'voiceLifetime'], ['voice_daily_seconds', 'voiceDaily'], ['voice_call_max_seconds', 'voiceCallMax']]) {
    if (typeof body[field] === 'number') out[key] = body[field];
  }
  return out;
}

function readState(storage) {
  try {
    return JSON.parse(storage.getItem(STATE_KEY)) || null;
  } catch {
    return null;
  }
}

// The trial memo says the server granted this install a key: `used: false` is
// only ever written by a successful enroll (createLocalTrial enroll).
export function trialKeyGranted(storage) {
  return readState(storage)?.used === false;
}

function writeState(storage, patch) {
  const next = { ...(readState(storage) || {}), ...patch };
  try { storage.setItem(STATE_KEY, JSON.stringify(next)); } catch { /* storage blocked: Settings just shows less */ }
  return next;
}

// createLocalTrial — aiclient's trial transport plus what Settings shows:
// { remaining, daily, used, voiceRemaining, voiceDailyRemaining, voiceLifetime,
// voiceDaily, voiceCallMax } from the last responses (X-Trial-Remaining, the
// enroll body, trial_already_used, the voice start body). That memo is a per-device convenience
// (localStorage): the server's counters are the truth, a lost memo only
// hides the count until the next request.
//
// `client`: an attest client shared with another attest-gated route (local
// feedback, local-policy.js) so one install never runs two enrollments; its
// owner forwards every response to the returned onResponse.
export function createLocalTrial({ attest, base, fetchImpl, storage, client: shared }) {
  async function onResponse(res) {
    const remaining = res.headers.get('X-Trial-Remaining');
    if (remaining !== null && remaining !== '') writeState(storage, { remaining: Number(remaining) });
    if (res.ok) return;
    const { code, scope } = await errorCode(res);
    if (code === 'trial_already_used') writeState(storage, { used: true });
    if (code === 'trial_budget_exhausted' && scope === 'install') writeState(storage, { remaining: 0 });
  }
  const client = shared || createAttestClient({ attest, base, fetchImpl, onResponse });
  return {
    base,
    onResponse,
    // aiclient (setTrialTransport): the account route's path, re-pointed at
    // the attest route with the same ?vision=1 flag.
    post(trialPath, init = {}) {
      // DeviceCheck's answer is final for this iPhone: no new key, no request.
      if (readState(storage)?.used) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'trial_already_used' }), { status: 403 }));
      }
      return client.post(trialPath.replace('/api/trial/', '/api/attest/trial/'), init.body, init.signal);
    },
    // fooddb.js (local-policy.js LOCAL_FOOD_DB, bd med-o7zq.20): the
    // cloud's same-origin /api/food/* path, re-pointed at the attest route.
    // Same key and challenge as the AI; its own daily cap on the server.
    foodGet(path, signal) {
      return client.get(path.replace('/api/food/', '/api/attest/food/'), signal);
    },
    // A trial voice call (bd med-o7zq.23; server: attest.go voiceStart). One
    // signed POST with an empty body mints the operator's ElevenLabs signed URL
    // (single-use) and the relay call token, and charges the call's whole grant
    // up front. Resolves { call, signedUrl, grantedSeconds, remainingSeconds,
    // dailyRemainingSeconds, callMaxSeconds }; throws an Error whose message is the copy to
    // show. The counters ride in the body: X-Trial-Voice-Remaining is not a
    // CORS-exposed header.
    async voiceStart(signal) {
      if (readState(storage)?.used) throw voiceError('trial_already_used');
      const res = await client.post(VOICE_START, '', signal);
      const body = await res.clone().json().catch(() => null);
      if (res.ok && body && typeof body.signed_url === 'string' && typeof body.call === 'string') {
        writeState(storage, {
          voiceRemaining: body.remaining_seconds,
          voiceDailyRemaining: body.daily_remaining_seconds,
          ...voiceLimits(body),
        });
        return {
          call: body.call,
          signedUrl: body.signed_url,
          grantedSeconds: body.granted_seconds,
          remainingSeconds: body.remaining_seconds,
          dailyRemainingSeconds: body.daily_remaining_seconds,
          callMaxSeconds: body.voice_call_max_seconds,
        };
      }
      const code = body?.error || '';
      if (code === 'trial_budget_exhausted' && body.scope === 'voice') writeState(storage, { voiceRemaining: 0 });
      throw voiceError(code === 'trial_budget_exhausted' ? `voice:${body.scope}` : code, res.status);
    },
    async enroll() {
      const res = await client.enroll();
      if (res.ok) {
        const body = await res.clone().json().catch(() => ({}));
        // Voice fields only where the server has anonymous voice on (bd
        // med-o7zq.28): Settings shows the minutes from the grant or rejoin on.
        const voice = typeof body.voice_remaining_seconds === 'number'
          ? { voiceRemaining: body.voice_remaining_seconds, voiceDailyRemaining: body.voice_daily_remaining_seconds, ...voiceLimits(body) }
          : {};
        // A feedback-only key (granted false) is no trial grant.
        if (body.granted !== false) writeState(storage, { daily: body.daily, used: false, ...voice });
      }
      return res;
    },
    state: () => readState(storage),
  };
}
