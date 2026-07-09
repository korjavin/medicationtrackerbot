// med-4lt: re-opening an already-claimed #claim= link must never render
// "Create your passkey" (clicking it only ever produced a misleading
// expired-link error). runSignupWizard probes POST /api/webauthn/register/begin
// before rendering; these pin the three outcomes the client branches on.
// The cloud shell has no integration entry point, so this follows the
// pure-unit convention of cloud-boot.test.js (repo rule 8's documented exception).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import { runSignupWizard } from '../signup.js';

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
});

afterEach(() => {
  delete globalThis.document;
  delete globalThis.fetch;
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

  it('renders the passkey button with the expired-link message on 403', async () => {
    globalThis.fetch = beginResponse(403, {});
    await runSignupWizard('tok123');

    const app = dom.window.document.getElementById('app');
    expect(app.querySelector('#create-passkey')).not.toBeNull();
    expect(app.querySelector('.wizard-error').textContent).toContain('may be expired');
  });
});
