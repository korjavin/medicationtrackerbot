// med-4lt: re-opening an already-claimed #claim= link must never render
// the sign-in button (clicking it only ever produced a misleading
// expired-link error). runSignupWizard probes POST /api/webauthn/register/begin
// before rendering; these pin the three outcomes the client branches on.
// The cloud shell has no integration entry point, so this follows the
// pure-unit convention of cloud-boot.test.js (repo rule 8's documented exception).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import { renderEmergencyKit, runSignupWizard } from '../signup.js';
import { establishLdkCache } from '../unlock.js';
import { isIOS, isMobile } from '../push.js';

vi.mock('../unlock.js', () => ({ establishLdkCache: vi.fn(async () => {}) }));
// Telegram self-gates and calls onDone immediately when disabled; the wizard
// tail is what's under test, not the step itself.
vi.mock('../telegram.js', () => ({ mountTelegram: async (_app, { onDone }) => onDone() }));
// The install step that follows Telegram derives its state from push.js's
// window-based probe; report standalone so it auto-skips (this env has no
// window) — the install step's own behavior is covered in
// signup.install-step.test.js.
// Every export signup.js imports must be present: a factory mock throws on a
// missing one, and `isStandalone() || !isMobile()` only short-circuits by luck.
vi.mock('../push.js', () => ({
  isStandalone: () => true,
  isIOS: vi.fn(() => false),
  isMobile: vi.fn(() => false),
  iosInstallStepsHtml: () => '',
}));

let dom;

function beginResponse(status, body) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

beforeEach(() => {
  dom = new JSDOM('<div id="app"></div>');
  globalThis.document = dom.window.document;
  globalThis.location = { origin: 'https://acct.example', href: '' };
});

afterEach(() => {
  delete globalThis.document;
  delete globalThis.fetch;
  delete globalThis.location;
  vi.clearAllMocks();
});

describe('runSignupWizard claim-state probe', () => {
  it('renders the already-claimed screen and no passkey button on 409 already_claimed', async () => {
    globalThis.fetch = beginResponse(409, { error: 'already_claimed' });
    await runSignupWizard('tok123');

    const app = dom.window.document.getElementById('app');
    expect(app.querySelector('#create-passkey')).toBeNull();
    expect(app.textContent).toContain('already been claimed');
    expect(app.textContent).toContain('Unlock your vault');
    expect(app.textContent).toContain('former device');
    expect(app.querySelector('#unlock-instead')).not.toBeNull();
  });

  it('renders the passkey button on 200 (pending invite)', async () => {
    globalThis.fetch = beginResponse(200, { publicKey: {} });
    await runSignupWizard('tok123');

    const app = dom.window.document.getElementById('app');
    expect(app.querySelector('#create-passkey')).not.toBeNull();
    expect(app.querySelector('.wizard-error')).toBeNull();
    // Without the probe this case renders identically, so pin the call itself.
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/webauthn/register/begin',
      expect.objectContaining({ body: JSON.stringify({ claim_token: 'tok123' }) }),
    );
  });

  it('shows a wait screen while the probe is in flight, never a blank page', async () => {
    globalThis.fetch = vi.fn(() => new Promise(() => {}));
    runSignupWizard('tok123');
    await Promise.resolve();

    const app = dom.window.document.getElementById('app');
    expect(app.textContent).toContain('Checking your invite');
    expect(app.querySelector('#create-passkey')).toBeNull();
  });

  it('routes to the already-claimed screen when the invite is claimed between probe and click', async () => {
    const responses = [
      { ok: true, status: 200, json: async () => ({ publicKey: {} }) },
      { ok: false, status: 409, json: async () => ({ error: 'already_claimed' }) },
    ];
    globalThis.fetch = vi.fn(async () => responses.shift());
    await runSignupWizard('tok123');

    const app = dom.window.document.getElementById('app');
    app.querySelector('#create-passkey').click();
    await vi.waitFor(() => expect(app.querySelector('#unlock-instead')).not.toBeNull());
    expect(app.querySelector('#create-passkey')).toBeNull();
    expect(app.textContent).toContain('already been claimed');
  });

  it('renders the passkey button with the expired-link message on 403', async () => {
    globalThis.fetch = beginResponse(403, {});
    await runSignupWizard('tok123');

    const app = dom.window.document.getElementById('app');
    expect(app.querySelector('#create-passkey')).not.toBeNull();
    expect(app.querySelector('.wizard-error').textContent).toContain('may be expired');
    expect(app.textContent).not.toMatch(/passkey|vault|encrypt/i);
  });
});

// bd med-ta2n.8, design W5 · sign in: the platform's own unlock words, one
// privacy sentence, and never "passkey" / "vault" / "encrypt".
describe('W5 sign-in step copy', () => {
  async function welcome() {
    globalThis.fetch = beginResponse(200, { publicKey: {} });
    await runSignupWizard('tok123');
    return dom.window.document.getElementById('app');
  }

  it('desktop web: sign in with this device', async () => {
    const app = await welcome();
    expect(app.querySelector('h1').textContent).toBe('Sign in with this device');
    expect(app.textContent).toContain("That's your login from now on. There's no password to remember.");
    expect(app.querySelector('#create-passkey').textContent).toBe('Continue');
    expect(app.textContent).toContain("The server stores your log but can't read it.");
    expect(app.textContent).not.toMatch(/passkey|vault|encrypt/i);
  });

  afterEach(() => {
    isIOS.mockReturnValue(false);
    isMobile.mockReturnValue(false);
  });

  it('iOS: Face ID', async () => {
    isIOS.mockReturnValue(true);
    const app = await welcome();
    expect(app.querySelector('h1').textContent).toBe('Sign in with Face ID');
    expect(app.querySelector('#create-passkey').textContent).toBe('Continue with Face ID');
    expect(app.querySelector('#create-passkey [data-icon="faceid"]')).not.toBeNull();
    expect(app.textContent).not.toMatch(/passkey|vault|encrypt/i);
  });

  it('Android: fingerprint', async () => {
    isMobile.mockReturnValue(true);
    const app = await welcome();
    expect(app.querySelector('h1').textContent).toBe('Sign in with your fingerprint');
    expect(app.querySelector('#create-passkey').textContent).toBe('Continue with fingerprint');
    expect(app.textContent).not.toMatch(/passkey|vault|encrypt/i);
  });
});

// med-8eh: the wizard used to end on a "the full app arrives with the next
// update" screen. It now warms the LDK cache and navigates to '/'. enterApp is
// module-private, so drive it the way the user does: the kit offer's Done.
describe('wizard tail (Emergency Kit offer -> app)', () => {
  const CTX = { accountId: 'acct-1', dek: new Uint8Array(32).fill(7) };

  // vi.clearAllMocks() clears calls but keeps implementations, so a mockRejectedValue
  // set by one case would otherwise leak into the next.
  beforeEach(() => { establishLdkCache.mockResolvedValue(undefined); });

  async function clickKitDone(ctx) {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const app = dom.window.document.getElementById('app');
    await renderEmergencyKit(app, { ...ctx, offer: true });
    app.querySelector('#kit-done').click();
    return app;
  }

  // recover.js / devices.js keep the O1 page: Print ticks "I saved it" and arms
  // #kit-continue (print rather than download — jsdom answers an <a download>
  // click with a "navigation not implemented" error).
  async function clickKitContinue(ctx) {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const app = dom.window.document.getElementById('app');
    await renderEmergencyKit(app, ctx);
    app.querySelector('#kit-print').click();
    app.querySelector('#kit-continue').click();
    return app;
  }

  it('warms the LDK cache with the ceremony DEK, then enters the app', async () => {
    await clickKitDone(CTX);

    await vi.waitFor(() => expect(globalThis.location.href).toBe('/'));
    expect(establishLdkCache).toHaveBeenCalledWith(CTX.dek, CTX.accountId);
  });

  it('still enters the app when the warm cache cannot be written (storage-blocked browser)', async () => {
    // Rejects on every call, not just the first: renderTelegramStep's own catch
    // re-invokes enterApp, so a mockRejectedValueOnce would let that retry
    // navigate and mask a deleted `catch` inside enterApp.
    establishLdkCache.mockRejectedValue(new Error('storage blocked'));
    await clickKitDone(CTX);

    // cloud-boot bounces this to /unlock; a dead-end here is the bug.
    await vi.waitFor(() => expect(globalThis.location.href).toBe('/'));
    // Exactly once: enterApp swallowed the failure itself rather than bubbling
    // out to the telegram-step error path.
    expect(establishLdkCache).toHaveBeenCalledTimes(1);
  });

  it('lets ctx.onKitSaved override the tail, so recover.js is unaffected', async () => {
    const onKitSaved = vi.fn();
    await clickKitContinue({ ...CTX, onKitSaved });

    expect(onKitSaved).toHaveBeenCalled();
    expect(establishLdkCache).not.toHaveBeenCalled();
    expect(globalThis.location.href).toBe('');
  });
});

// med-nt9p.19: the post-create PRF probe (shared with claim.js via
// passkey-get.js prfProbe). Web/iOS: one get restricted to the new credential,
// exactly as before. Android shell (window.wgNative): GPM files WebView-created
// passkeys as app credentials that no allowlist get matches, so the probe is
// discoverable and must come back with the credential just created.
describe('post-create PRF probe', () => {
  const RAW_ID = new Uint8Array([1, 2, 3, 4]).buffer;
  let getCalls;

  // Node exposes navigator as a getter-only global.
  function setNavigator(value) {
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  }

  function install(getImpl) {
    getCalls = [];
    globalThis.window = globalThis;
    globalThis.PublicKeyCredential = {
      parseCreationOptionsFromJSON: () => ({ user: { id: new TextEncoder().encode('acct-1') } }),
    };
    setNavigator({
      credentials: {
        create: vi.fn(async () => ({ rawId: RAW_ID, toJSON: () => ({}) })),
        get: vi.fn(async (opts) => {
          getCalls.push(opts.publicKey);
          return getImpl(getCalls.length);
        }),
      },
    });
    globalThis.fetch = beginResponse(200, { publicKey: {} });
  }

  // No PRF in the probe result → the unsupported-authenticator screen: the
  // probe itself got through, nothing after it runs.
  const noPrf = (rawId) => ({ rawId, getClientExtensionResults: () => ({}) });
  const notReadable = () => Object.assign(new Error('credential manager'), { name: 'NotReadableError' });
  // Android shell: the probe waits PROBE_SETTLE_MS after create and retries
  // back off 1/2/4 s, so the shell cases run on a fake setTimeout. settle()
  // steps the clock and yields a real macrotask (WebCrypto) until it passes.
  const bridge = (post = () => {}) => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    globalThis.wgNative = { postMessage: post, addEventListener() {} };
  };
  async function settle(assertion) {
    for (let i = 0; i < 200; i++) {
      try { assertion(); return; } catch { /* not yet */ }
      await vi.advanceTimersByTimeAsync(100);
      await new Promise((r) => setImmediate(r));
    }
    assertion();
  }
  const withPrf = (rawId) => ({
    rawId,
    getClientExtensionResults: () => ({ prf: { results: { first: new Uint8Array(32).fill(5).buffer } } }),
  });
  const calls = (url) => globalThis.fetch.mock.calls.filter(([u]) => u === url).length;

  async function clickCreate(opts) {
    await runSignupWizard('tok123', opts);
    const app = dom.window.document.getElementById('app');
    app.querySelector('#create-passkey').click();
    return app;
  }

  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.window;
    delete globalThis.wgNative;
    delete globalThis.PublicKeyCredential;
    delete globalThis.navigator;
  });

  it('web: one get restricted to the created credential', async () => {
    install(() => noPrf(RAW_ID));
    const app = await clickCreate();
    await vi.waitFor(() => expect(app.textContent).toContain("can't be used yet"));
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0].allowCredentials).toEqual([{ type: 'public-key', id: RAW_ID }]);
    expect(getCalls[0].userVerification).toBe('required');
    expect(getCalls[0].extensions.prf.eval.first).toBeInstanceOf(Uint8Array);
  });

  it('web: a NotReadableError is surfaced, not retried', async () => {
    install(() => { throw notReadable(); });
    const app = await clickCreate();
    await vi.waitFor(() => expect(app.querySelector('.wizard-error')).not.toBeNull());
    expect(getCalls).toHaveLength(1);
    // The browser's own message, and no shell busy step on the way.
    expect(app.querySelector('.wizard-error').textContent).toBe('credential manager');
  });

  it('web: a failed kit upload offers Try again, and a double tap rotates the code once', async () => {
    install(() => withPrf(RAW_ID));
    let failed = false;
    globalThis.fetch = vi.fn(async (url) => {
      if (url === '/api/recovery-material' && !failed) {
        failed = true;
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ publicKey: {} }) };
    });
    const app = await clickCreate({ kit: true });
    await vi.waitFor(() => expect(app.querySelector('#kit-retry')).not.toBeNull());
    expect(app.textContent).toContain("Couldn't create your Emergency Kit");

    const retry = app.querySelector('#kit-retry');
    retry.click();
    retry.click();
    await vi.waitFor(() => expect(app.textContent).toContain('One more thing: a way back in'));
    expect(calls('/api/recovery-material')).toBe(2); // the failed one + exactly one retry
  });

  // bd med-ta2n.8: &kit=1 (entered from Settings) ends on the W5 kit offer;
  // without it (P3, an old shell's paste screen) the ceremony skips the kit
  // entirely — no code is minted — and goes on to the app.
  it('web, kit flag: registration ends on the kit offer, Done goes on to the app', async () => {
    install(() => withPrf(RAW_ID));
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ publicKey: {} }) }));
    const app = await clickCreate({ kit: true });
    await vi.waitFor(() => expect(app.querySelector('#kit-done')).not.toBeNull());
    expect(app.textContent).toContain('Sync is on');
    expect(app.querySelector('#kit-saved')).toBeNull(); // an offer, not a gate
    expect(app.querySelector('#kit-done').disabled).toBe(false);

    app.querySelector('#kit-done').click();
    await vi.waitFor(() => expect(globalThis.location.href).toBe('/'));
    expect(calls('/api/loss-ack')).toBe(1);
  });

  it('web, no kit flag: no kit page, no recovery code minted, "not saved" filed, straight on to the app', async () => {
    const storage = new JSDOM('', { url: 'https://acct.example/unlock' }).window.localStorage;
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
    try {
      install(() => withPrf(RAW_ID));
      globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ publicKey: {} }) }));
      const app = await clickCreate();
      await vi.waitFor(() => expect(globalThis.location.href).toBe('/'));
      expect(calls('/api/webauthn/register/finish')).toBe(1);
      expect(calls('/api/recovery-material')).toBe(0);
      expect(app.querySelector('#kit-done, #kit-continue')).toBeNull();
      // The Settings Kit chip's source: an explicit "not saved", not a missing record.
      expect(JSON.parse(storage.getItem('wg-emergency-kit-saved'))).toEqual({ savedAt: expect.any(Number), how: 'none' });
    } finally {
      delete globalThis.localStorage;
    }
  });

  it('Android shell: discoverable probe, accepted when it returns the created credential', async () => {
    install(() => noPrf(new Uint8Array([1, 2, 3, 4]).buffer));
    bridge();
    const app = await clickCreate();
    await settle(() => expect(app.textContent).toContain("can't be used yet"));
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0].allowCredentials).toEqual([]);
  });

  it('Android shell: a different passkey from the discoverable probe fails clearly', async () => {
    install(() => noPrf(new Uint8Array([9, 9, 9, 9]).buffer));
    bridge();
    const app = await clickCreate();
    await settle(() => expect(app.querySelector('.wizard-error')).not.toBeNull());
    expect(app.querySelector('.wizard-error').textContent).toContain('choose the passkey you just created');
    expect(app.textContent).not.toContain("can't be used yet");
  });

  it('Android shell: a NotReadableError is retried, then the probe proceeds', async () => {
    install((n) => { if (n === 1) throw notReadable(); return noPrf(RAW_ID); });
    bridge();
    const app = await clickCreate();
    await settle(() => expect(app.textContent).toContain("can't be used yet"));
    expect(getCalls).toHaveLength(2);
  });

  it('Android shell: a NotAllowedError on the post-create probe is retried too', async () => {
    install((n) => {
      if (n === 1) throw Object.assign(new Error('not allowed'), { name: 'NotAllowedError' });
      return noPrf(RAW_ID);
    });
    bridge();
    const app = await clickCreate();
    await settle(() => expect(app.textContent).toContain("can't be used yet"));
    expect(getCalls).toHaveLength(2);
  });

  it('Android shell: a cancelled probe sheet reopens at most once, then one plain message', async () => {
    install(() => { throw Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }); });
    bridge();
    const app = await clickCreate();
    await settle(() => expect(app.querySelector('.wizard-error')).not.toBeNull());
    expect(getCalls).toHaveLength(2);
    expect(app.querySelectorAll('.wizard-error')).toHaveLength(1);
    expect(app.querySelector('.wizard-error').textContent)
      .toBe("Couldn't finish signing in. Tap Continue with fingerprint to try again.");
    expect(calls('/api/webauthn/register/finish')).toBe(0);
  });

  it('Android shell: waits ~1.5 s after create before the first probe', async () => {
    install(() => noPrf(RAW_ID));
    bridge();
    await clickCreate();
    await settle(() => expect(navigator.credentials.create).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(getCalls).toHaveLength(0);
    await settle(() => expect(getCalls).toHaveLength(1));
  });

  // The device log (Pixel 7): probe 1 fails, a tap ~1 s later — while the
  // retry backs off — started a second register/begin + create ("A request is
  // already pending") and finish then 400'd on the superseded challenge.
  it('Android shell: one ceremony from begin to finish; a tap during the retry backoff starts nothing', async () => {
    install((n) => { if (n === 1) throw notReadable(); return withPrf(RAW_ID); });
    bridge();
    await runSignupWizard('tok123');
    const app = dom.window.document.getElementById('app');
    const button = app.querySelector('#create-passkey');
    button.click();

    // One steady busy step: no button left, no error, says what comes next.
    expect(app.querySelector('#create-passkey')).toBeNull();
    expect(app.textContent).toContain('Signing you in');
    expect(app.querySelector('.wizard-spinner')).not.toBeNull();
    expect(app.textContent).toContain('confirm the sign-in you just created');

    await settle(() => expect(getCalls).toHaveLength(1)); // probe 1 failed, now backing off
    expect(app.querySelector('.wizard-error')).toBeNull();
    // A stray tap on the old button (even one that bypasses the DOM) is dropped.
    button.click();
    button.dispatchEvent(new dom.window.Event('click'));

    await settle(() => expect(globalThis.location.href).toBe('/')); // no kit flag: on to the app
    expect(calls('/api/webauthn/register/begin')).toBe(2); // the wizard's claim-state probe + this ceremony
    expect(navigator.credentials.create).toHaveBeenCalledTimes(1);
    expect(getCalls).toHaveLength(2);
    expect(calls('/api/webauthn/register/finish')).toBe(1);
  });

  it('Android shell: every probe attempt failing shows one plain message, and the button restarts with a fresh begin', async () => {
    install((n) => { if (n <= 4) throw notReadable(); return withPrf(RAW_ID); });
    bridge();
    const app = await clickCreate();
    await settle(() => expect(app.querySelector('.wizard-error')).not.toBeNull());
    expect(getCalls).toHaveLength(4); // 1 + 3 bounded retries
    expect(app.querySelectorAll('.wizard-error')).toHaveLength(1);
    expect(app.querySelector('.wizard-error').textContent)
      .toBe("Couldn't finish signing in. Tap Continue with fingerprint to try again.");
    expect(calls('/api/webauthn/register/finish')).toBe(0);

    app.querySelector('#create-passkey').click();
    await settle(() => expect(globalThis.location.href).toBe('/'));
    expect(calls('/api/webauthn/register/begin')).toBe(3);
    expect(navigator.credentials.create).toHaveBeenCalledTimes(2);
    expect(calls('/api/webauthn/register/finish')).toBe(1);
  });

  // med-nt9p.22: the ceremony log goes to the shell as diag.append entries.
  const diagEntries = (post) => post.mock.calls
    .map(([m]) => JSON.parse(m))
    .filter((m) => m.op === 'diag.append')
    .map((m) => JSON.parse(m.args.entry));

  it('Android shell: logs begin, create, probe and the probe retry, without secrets', async () => {
    install((n) => { if (n === 1) throw notReadable(); return noPrf(RAW_ID); });
    const post = vi.fn();
    bridge(post);
    const app = await clickCreate();
    await settle(() => expect(app.textContent).toContain("can't be used yet"));
    await settle(() => expect(diagEntries(post)).toHaveLength(4));

    const entries = diagEntries(post);
    const find = (op, attempt) => entries.find((e) => e.op === op && (attempt === undefined || e.attempt === attempt));
    expect(entries.map((e) => e.op).sort()).toEqual(['create', 'http', 'probe', 'probe']);
    expect(find('http')).toMatchObject({ step: 'register/begin', status: 200 });
    const created = find('create', 1);
    expect(created).toMatchObject({ result: 'ok', id: expect.stringMatching(/^[0-9a-f]{6}$/) });
    expect(find('probe', 1)).toMatchObject({ error: 'NotReadableError', allow: 1, uv: 'required', prf: true });
    expect(find('probe', 2)).toMatchObject({ result: 'ok', match: true, prfLen: 0, id: created.id });
    // No raw credential id, salt, challenge or claim token in any entry.
    const all = JSON.stringify(entries);
    expect(all).not.toContain('tok123');
    expect(all).not.toMatch(/"(rawId|challenge|salt|eval|first)"/);
    expect(all).not.toContain('[1,2,3,4]');
    for (const e of entries) expect(typeof e.ms).toBe('number');
  });

  it('iOS shell: the log goes to its handler, create gets the options untouched', async () => {
    install(() => noPrf(RAW_ID));
    const post = vi.fn();
    const iosPost = vi.fn(() => Promise.resolve(null));
    // iOS's handler wins over a wgNative-shaped global, so this is not the Android shell.
    globalThis.webkit = { messageHandlers: { wgNative: { postMessage: iosPost } } };
    globalThis.wgNative = { postMessage: post, addEventListener() {} };
    try {
      const app = await clickCreate();
      await vi.waitFor(() => expect(app.textContent).toContain("can't be used yet"));
      expect(post).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(iosPost.mock.calls.length).toBeGreaterThanOrEqual(3));
      const ops = iosPost.mock.calls.map(([m]) => m.op === 'diag.append' && JSON.parse(m.args.entry).op);
      expect(ops).toEqual(expect.arrayContaining(['http', 'create', 'probe']));
      expect(navigator.credentials.create).toHaveBeenCalledTimes(1);
      const [arg] = navigator.credentials.create.mock.calls[0];
      expect(Object.keys(arg)).toEqual(['publicKey']);
      expect(getCalls[0].allowCredentials).toEqual([{ type: 'public-key', id: RAW_ID }]);
    } finally {
      delete globalThis.webkit;
    }
  });

  it('Android shell: any other error is not retried, and reads as plain English', async () => {
    install(() => { throw Object.assign(new Error('blocked'), { name: 'SecurityError' }); });
    bridge();
    const app = await clickCreate();
    await settle(() => expect(app.querySelector('.wizard-error')).not.toBeNull());
    expect(getCalls).toHaveLength(1);
    expect(app.querySelector('.wizard-error').textContent).toContain('Tap Continue with fingerprint to try again');
  });
});
