// Local mode's anonymous trial AI (bd med-o7zq.16): the client of our server's
// base-domain /api/attest/* routes (internal/cloudserver/attest.go,
// docs/cloud-mode.md → Anonymous trial). Local mode has no account, so each
// request carries an App Attest assertion from the iOS shell instead
// (window.Attest, web/static/js/native/attest.js).
//
// createAttestClient is the transport alone — challenge reuse, enrollment,
// signed POSTs — with nothing trial-specific in it, so another attest-gated
// route can reuse it. createLocalTrial puts aiclient's trial transport
// (setTrialTransport) and the Settings state on top.
//
// Only ever installed when the user turned the trial on (local-policy.js
// registerLocalEgress): off, nothing here runs and nothing reaches our server.

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
    const res = await fetchImpl(origin + pathAndQuery, { ...init, method: 'POST' });
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
  let enrolling = null;
  function enroll() {
    if (!enrolling) enrolling = doEnroll().finally(() => { enrolling = null; });
    return enrolling.then((res) => res.clone());
  }

  async function doEnroll() {
    const got = await takeChallenge();
    if (got.res) return got.res;
    const reply = await attest.enroll(got.challenge);
    return send('/api/attest/enroll', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key_id: reply.keyId,
        attestation: reply.attestation,
        challenge: got.challenge,
        device_token: reply.deviceToken,
      }),
    });
  }

  async function signedPost(pathAndQuery, body, signal) {
    // A pending enrollment decides which key signs: wait for it.
    if (enrolling) await enrolling.catch(() => {});
    const got = await takeChallenge();
    if (got.res) return { res: got.res };
    const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(`${pathAndQuery}\n${body}`)));
    let signed;
    try {
      signed = await attest.assert(got.challenge, b64(digest));
    } catch (e) {
      challenge = got.challenge; // unused: still good for the enroll
      if (/no_key/.test(String(e && e.message))) return { needsKey: true };
      throw e;
    }
    const res = await send(pathAndQuery, {
      headers: {
        'Content-Type': 'application/json',
        'X-Attest-Key-Id': signed.keyId,
        'X-Attest-Challenge': got.challenge,
        'X-Attest-Assertion': signed.assertion,
      },
      body,
      signal,
    });
    return { res };
  }

  // One retry, for what a fresh attempt fixes: a challenge that expired
  // (challenge_invalid), or a key the server or the shell does not have
  // (install_unknown / no_key → enroll a key first). Anything else goes back
  // to the caller, whose error mapping reads the body.
  async function post(pathAndQuery, body, signal) {
    for (let attempt = 0; ; attempt += 1) {
      const out = await signedPost(pathAndQuery, body, signal);
      let { code } = out.res ? await errorCode(out.res) : { code: '' };
      if (out.needsKey) code = 'install_unknown';
      const retry = attempt === 0 && (code === 'challenge_invalid' || code === 'install_unknown');
      if (!retry) {
        if (out.res) return out.res;
        throw Object.assign(new Error('The app has no trial key.'), { code: 'no_key' });
      }
      if (code === 'install_unknown') {
        const enrolled = await enroll();
        if (!enrolled.ok) return enrolled;
      }
    }
  }

  return { enroll, post };
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
