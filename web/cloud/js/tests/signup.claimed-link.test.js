// med-4lt: re-opening an already-claimed #claim= link must never render
// "Create your passkey" (clicking it only ever produced a misleading
// expired-link error). runSignupWizard probes POST /api/webauthn/register/begin
// before rendering; these pin the three outcomes the client branches on.
// The cloud shell has no integration entry point, so this follows the
// pure-unit convention of cloud-boot.test.js (repo rule 8's documented exception).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import { renderEmergencyKit, runSignupWizard } from '../signup.js';
import { establishLdkCache } from '../unlock.js';

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
  isIOS: () => false,
  isMobile: () => false,
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
  });
});

// med-8eh: the wizard used to end on a "the full app arrives with the next
// update" screen. It now warms the LDK cache and navigates to '/'. enterApp is
// module-private, so drive it the way the user does: #kit-continue.
describe('wizard tail (Emergency Kit -> app)', () => {
  const CTX = { accountId: 'acct-1', dek: new Uint8Array(32).fill(7) };

  // vi.clearAllMocks() clears calls but keeps implementations, so a mockRejectedValue
  // set by one case would otherwise leak into the next.
  beforeEach(() => { establishLdkCache.mockResolvedValue(undefined); });

  async function clickKitContinue(ctx) {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const app = dom.window.document.getElementById('app');
    await renderEmergencyKit(app, ctx);
    // #kit-continue needs BOTH gates (med-d5t.2): the kit has to be produced
    // before the checkbox even unlocks. Print rather than download — it opens
    // the same gate without an <a download> click, which jsdom answers with a
    // "navigation not implemented" error. The gate itself is covered in
    // signup.emergency-kit.test.js.
    app.querySelector('#kit-print').click();
    const checkbox = app.querySelector('#kit-saved-checkbox');
    checkbox.checked = true;
    checkbox.dispatchEvent(new dom.window.Event('change'));
    app.querySelector('#kit-continue').click();
    return app;
  }

  it('warms the LDK cache with the ceremony DEK, then enters the app', async () => {
    await clickKitContinue(CTX);

    await vi.waitFor(() => expect(globalThis.location.href).toBe('/'));
    expect(establishLdkCache).toHaveBeenCalledWith(CTX.dek, CTX.accountId);
  });

  it('still enters the app when the warm cache cannot be written (storage-blocked browser)', async () => {
    // Rejects on every call, not just the first: renderTelegramStep's own catch
    // re-invokes enterApp, so a mockRejectedValueOnce would let that retry
    // navigate and mask a deleted `catch` inside enterApp.
    establishLdkCache.mockRejectedValue(new Error('storage blocked'));
    await clickKitContinue(CTX);

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
