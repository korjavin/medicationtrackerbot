// bd med-o7zq.16 — local mode's anonymous trial transport (local-trial.js)
// against the base-domain /api/attest/* contract (internal/cloudserver/attest.go,
// docs/cloud-mode.md → Anonymous trial), faked at the fetch boundary with real
// Response objects, and the shell (window.Attest) faked at its three ops.
// Pins: the signed input, the three headers, challenge reuse, the one retry,
// what Settings remembers, and aiclient's seam + error mapping.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createAttestClient, createLocalTrial } from '../local-trial.js';
import { createAIClient, setTrialTransport } from '../aiclient.js';

const BASE = 'trial.example.test';
const CHAT = '/api/attest/trial/openai/chat/completions';

function reply(status, json, headers = {}) {
  return new Response(JSON.stringify(json), { status, headers });
}

function fakeAttest() {
  return {
    enroll: vi.fn(async () => ({ keyId: 'KEY', attestation: 'QVRU', deviceToken: 'REVW' })),
    assert: vi.fn(async () => ({ keyId: 'KEY', assertion: 'QVNT' })),
  };
}

// Scripted server: each call shifts the next answer for its path.
function fakeServer(script) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    calls.push({ url, path, init });
    const next = script[new URL(url).pathname]?.shift();
    if (!next) throw new Error(`unexpected request ${path}`);
    return next();
  });
  return { fetchImpl, calls };
}

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

describe('createAttestClient', () => {
  it('signs SHA256(pathAndQuery ‖ "\\n" ‖ body), sends the three headers to the base domain, and reuses the next challenge', async () => {
    const attest = fakeAttest();
    const { fetchImpl, calls } = fakeServer({
      '/api/attest/challenge': [() => reply(200, { challenge: 'Q0gx', expires_in: 300 })],
      [CHAT]: [
        () => reply(200, { ok: 1 }, { 'X-Attest-Challenge': 'Q0gy', 'X-Trial-Remaining': '199' }),
        () => reply(200, { ok: 2 }, { 'X-Attest-Challenge': 'Q0gz' }),
      ],
    });
    const client = createAttestClient({ attest, base: BASE, fetchImpl });
    const body = '{"messages":[]}';

    await client.post(`${CHAT}?vision=1`, body);
    await client.post(CHAT, body);

    expect(calls.map((c) => c.path)).toEqual(['/api/attest/challenge', `${CHAT}?vision=1`, CHAT]);
    expect(calls[1].url).toBe(`https://${BASE}${CHAT}?vision=1`);
    const digest = createHash('sha256').update(`${CHAT}?vision=1\n${body}`).digest('base64');
    expect(attest.assert.mock.calls[0]).toEqual(['Q0gx', digest]);
    expect(calls[1].init).toMatchObject({
      method: 'POST',
      body,
      headers: { 'X-Attest-Key-Id': 'KEY', 'X-Attest-Challenge': 'Q0gx', 'X-Attest-Assertion': 'QVNT' },
    });
    // Second request: the challenge the first response carried, no fetch for one.
    expect(attest.assert.mock.calls[1][0]).toBe('Q0gy');
    expect(calls[2].init.headers['X-Attest-Challenge']).toBe('Q0gy');
  });

  it('retries once with a fresh challenge on challenge_invalid', async () => {
    const attest = fakeAttest();
    const { fetchImpl, calls } = fakeServer({
      '/api/attest/challenge': [() => reply(200, { challenge: 'Q0gx' }), () => reply(200, { challenge: 'Q0gy' })],
      [CHAT]: [() => reply(400, { error: 'challenge_invalid' }), () => reply(200, { ok: 1 })],
    });
    const res = await createAttestClient({ attest, base: BASE, fetchImpl }).post(CHAT, '{}');
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.path)).toEqual(['/api/attest/challenge', CHAT, '/api/attest/challenge', CHAT]);
  });

  it('install_unknown enrolls a key (challenge, attestation, device token), then retries once', async () => {
    const attest = fakeAttest();
    const { fetchImpl, calls } = fakeServer({
      '/api/attest/challenge': [() => reply(200, { challenge: 'Q0gx' })],
      [CHAT]: [
        () => reply(401, { error: 'install_unknown' }, { 'X-Attest-Challenge': 'Q0gy' }),
        () => reply(200, { ok: 1 }),
      ],
      '/api/attest/enroll': [() => reply(200, { remaining: 200, daily: 50 }, { 'X-Attest-Challenge': 'Q0gz' })],
    });
    const res = await createAttestClient({ attest, base: BASE, fetchImpl }).post(CHAT, '{}');
    expect(res.status).toBe(200);
    expect(attest.enroll).toHaveBeenCalledWith('Q0gy');
    expect(JSON.parse(calls[2].init.body)).toEqual({
      key_id: 'KEY', attestation: 'QVRU', challenge: 'Q0gy', device_token: 'REVW',
    });
    expect(calls[3].init.headers['X-Attest-Challenge']).toBe('Q0gz');
  });

  it("the shell's no_key enrolls first, reusing the unspent challenge", async () => {
    const attest = fakeAttest();
    attest.assert.mockRejectedValueOnce(new Error('no_key'));
    const { fetchImpl, calls } = fakeServer({
      '/api/attest/challenge': [() => reply(200, { challenge: 'Q0gx' })],
      '/api/attest/enroll': [() => reply(200, { remaining: 200, daily: 50 }, { 'X-Attest-Challenge': 'Q0gy' })],
      [CHAT]: [() => reply(200, { ok: 1 })],
    });
    const res = await createAttestClient({ attest, base: BASE, fetchImpl }).post(CHAT, '{}');
    expect(res.status).toBe(200);
    expect(attest.enroll).toHaveBeenCalledWith('Q0gx');
    expect(calls.map((c) => c.path)).toEqual(['/api/attest/challenge', '/api/attest/enroll', CHAT]);
  });

  it('a request during the first enrollment waits for it: one key, one enroll POST', async () => {
    const attest = fakeAttest();
    let release;
    attest.enroll.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ keyId: 'KEY', attestation: 'QVRU', deviceToken: 'REVW' });
    }));
    const { fetchImpl, calls } = fakeServer({
      '/api/attest/challenge': [() => reply(200, { challenge: 'Q0gx' })],
      '/api/attest/enroll': [() => reply(200, { remaining: 200, daily: 50 }, { 'X-Attest-Challenge': 'Q0gy' })],
      [CHAT]: [() => reply(200, { ok: 1 })],
    });
    const client = createAttestClient({ attest, base: BASE, fetchImpl });
    const enrolled = client.enroll();
    const posted = client.post(CHAT, '{}');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    expect((await enrolled).status).toBe(200);
    expect((await posted).status).toBe(200);
    expect(attest.enroll).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.path)).toEqual(['/api/attest/challenge', '/api/attest/enroll', CHAT]);
    expect(attest.assert.mock.calls[0][0]).toBe('Q0gy');
  });

  it('hands a failed challenge fetch back as is (trial_not_configured)', async () => {
    const attest = fakeAttest();
    const { fetchImpl } = fakeServer({
      '/api/attest/challenge': [() => reply(503, { error: 'trial_not_configured' })],
    });
    const res = await createAttestClient({ attest, base: BASE, fetchImpl }).post(CHAT, '{}');
    expect(res.status).toBe(503);
    expect(attest.assert).not.toHaveBeenCalled();
  });
});

describe('createLocalTrial', () => {
  it('remembers the remaining count and daily cap for Settings', async () => {
    const storage = memoryStorage();
    const { fetchImpl } = fakeServer({
      '/api/attest/challenge': [() => reply(200, { challenge: 'Q0gx' })],
      '/api/attest/enroll': [() => reply(200, { remaining: 200, daily: 50 }, { 'X-Trial-Remaining': '200', 'X-Attest-Challenge': 'Q0gy' })],
      [CHAT]: [() => reply(200, { ok: 1 }, { 'X-Trial-Remaining': '199' })],
    });
    const trial = createLocalTrial({ attest: fakeAttest(), base: BASE, fetchImpl, storage });
    await trial.enroll();
    expect(trial.state()).toEqual({ remaining: 200, daily: 50, used: false });
    // aiclient hands the account route's path; the transport re-points it.
    await trial.post('/api/trial/openai/chat/completions', { body: '{}' });
    expect(trial.state().remaining).toBe(199);
  });

  it('trial_already_used is final: remembered, and later requests never leave the phone', async () => {
    const storage = memoryStorage();
    const { fetchImpl } = fakeServer({
      '/api/attest/challenge': [() => reply(200, { challenge: 'Q0gx' })],
      '/api/attest/enroll': [() => reply(403, { error: 'trial_already_used' })],
    });
    const trial = createLocalTrial({ attest: fakeAttest(), base: BASE, fetchImpl, storage });
    expect((await trial.enroll()).status).toBe(403);
    expect(trial.state().used).toBe(true);
    fetchImpl.mockClear();
    const res = await trial.post('/api/trial/openai/chat/completions', { body: '{}' });
    expect(res.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('aiclient trial transport seam', () => {
  afterEach(() => setTrialTransport(null));

  const settings = (consent) => ({
    readIntegrationsUnmasked: vi.fn().mockResolvedValue({ openai: {} }),
    getTrialConsent: vi.fn().mockResolvedValue(consent),
  });

  it('with no key, routes meal parsing through the transport, gated on the local `anon` consent', async () => {
    const post = vi.fn(async () => reply(200, { choices: [{ message: { content: '{"items":[]}' } }] }));
    setTrialTransport({ post });
    const client = createAIClient({ settingsDomain: settings({ anon: true, ai: null }) });
    await expect(client.parseMealFromDescription('two eggs')).resolves.toEqual({ items: [] });
    const [path, init] = post.mock.calls[0];
    expect(path).toBe('/api/trial/openai/chat/completions');
    expect(JSON.parse(init.body).model).toBeUndefined(); // the server forces the model
  });

  it('refuses without the `anon` consent, asking for that scope', async () => {
    const post = vi.fn();
    setTrialTransport({ post });
    const client = createAIClient({ settingsDomain: settings({ ai: true, anon: null }) });
    await expect(client.parseMealFromDescription('two eggs')).rejects.toMatchObject({ code: 'trial_consent_required', scope: 'anon' });
    expect(post).not.toHaveBeenCalled();
  });

  it('maps the anonymous trial codes onto client errors', async () => {
    const cases = [
      [reply(403, { error: 'trial_already_used' }), { code: 'trial_already_used' }],
      [reply(429, { error: 'trial_budget_exhausted', scope: 'install' }), { code: 'trial_budget_exhausted', scope: 'install' }],
      [reply(429, { error: 'trial_budget_exhausted', scope: 'install-day' }), { code: 'trial_budget_exhausted', scope: 'install-day' }],
      [reply(503, { error: 'trial_unavailable' }), { code: 'trial_budget_unavailable' }],
      [reply(503, { error: 'trial_not_configured' }), { code: 'no_api_key' }],
    ];
    const client = createAIClient({ settingsDomain: settings({ anon: true }) });
    for (const [res, want] of cases) {
      setTrialTransport({ post: async () => res });
      await expect(client.parseMealFromDescription('two eggs')).rejects.toMatchObject(want);
    }
  });

  it('streaming (voice) is not offered on the attest route', async () => {
    setTrialTransport({ post: vi.fn() });
    const client = createAIClient({ settingsDomain: settings({ anon: true, voice: true }) });
    await expect(client.chatStream({ body: {}, onChunk: () => {} })).rejects.toMatchObject({ code: 'no_api_key' });
    await expect(client.usesTrial()).resolves.toBe(false);
  });
});
