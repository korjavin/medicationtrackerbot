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
// Only ever installed when the user turned the trial on (local-policy.js
// registerLocalEgress): off, nothing here runs and nothing reaches our server.
// The same switch covers the operator's food database (foodGet, bd
// med-o7zq.20).

const STATE_KEY = 'wg:local-trial';

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

// createAttestClient({ attest, base, fetchImpl, onResponse })
//   enroll()                         → Response of POST /api/attest/enroll
//                                      (or of the challenge fetch, when that failed)
//   post(pathAndQuery, body, signal) → Response of the signed POST
//   get(pathAndQuery, signal)        → Response of the signed GET (empty body)
// Every response goes to onResponse(res, pathAndQuery) first.
//
// The signed input (attest.go chat): clientDataHash = SHA256(challenge ‖
// SHA256(pathAndQuery ‖ "\n" ‖ body)); this side computes the inner digest
// over the exact bytes it sends, the shell the outer hash. Challenges are
// single-use: the next one rides on the last response (X-Attest-Challenge),
// so the steady state is one round trip per request.
export function createAttestClient({
  attest, base, fetchImpl, onResponse = () => {}, subtle = globalThis.crypto.subtle,
}) {
  const origin = `https://${base}`;
  let challenge = '';

  async function send(pathAndQuery, init) {
    const res = await fetchImpl(origin + pathAndQuery, { method: 'POST', ...init });
    const next = res.headers.get('X-Attest-Challenge');
    if (next) challenge = next;
    await onResponse(res, pathAndQuery);
    return res;
  }

  // { challenge } or, when none could be had, { res } to hand back as is
  // (trial_not_configured, the per-IP limit).
  async function takeChallenge() {
    if (challenge) {
      const c = challenge;
      challenge = '';
      return { challenge: c };
    }
    const res = await send('/api/attest/challenge', {});
    challenge = '';
    if (!res.ok) return { res };
    const body = await res.json();
    return { challenge: body.challenge };
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

  async function doEnroll() {
    const got = await takeChallenge();
    if (got.res) return got.res;
    const reply = await attest.enroll(got.challenge);
    const res = await send('/api/attest/enroll', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key_id: reply.keyId,
        attestation: reply.attestation,
        challenge: got.challenge,
        device_token: reply.deviceToken,
      }),
    });
    if (res.ok) granted += 1;
    return res;
  }

  async function signedRequest(method, pathAndQuery, body, signal) {
    // A pending enrollment decides which key signs: wait for it.
    if (enrolling) await enrolling.catch(() => {});
    const gen = granted;
    const got = await takeChallenge();
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

  return {
    enroll,
    post: (pathAndQuery, body, signal) => request('POST', pathAndQuery, body, signal),
    // An empty body: the digest is SHA256(pathAndQuery ‖ "\n") (attest.go food routes).
    get: (pathAndQuery, signal) => request('GET', pathAndQuery, '', signal),
  };
}

function readState(storage) {
  try {
    return JSON.parse(storage.getItem(STATE_KEY)) || null;
  } catch {
    return null;
  }
}

function writeState(storage, patch) {
  const next = { ...(readState(storage) || {}), ...patch };
  try { storage.setItem(STATE_KEY, JSON.stringify(next)); } catch { /* storage blocked: Settings just shows less */ }
  return next;
}

// createLocalTrial — aiclient's trial transport plus what Settings shows:
// { remaining, daily, used } from the last responses (X-Trial-Remaining, the
// enroll body, trial_already_used). That memo is a per-device convenience
// (localStorage): the server's counters are the truth, a lost memo only
// hides the count until the next request.
export function createLocalTrial({ attest, base, fetchImpl, storage }) {
  const client = createAttestClient({
    attest,
    base,
    fetchImpl,
    async onResponse(res) {
      const remaining = res.headers.get('X-Trial-Remaining');
      if (remaining !== null && remaining !== '') writeState(storage, { remaining: Number(remaining) });
      if (res.ok) return;
      const { code, scope } = await errorCode(res);
      if (code === 'trial_already_used') writeState(storage, { used: true });
      if (code === 'trial_budget_exhausted' && scope === 'install') writeState(storage, { remaining: 0 });
    },
  });
  return {
    base,
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
    async enroll() {
      const res = await client.enroll();
      if (res.ok) {
        const body = await res.clone().json().catch(() => ({}));
        writeState(storage, { daily: body.daily, used: false });
      }
      return res;
    },
    state: () => readState(storage),
  };
}
