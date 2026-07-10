// Device list + revocation. med-lyv split the Claude/MCP connector picker out
// into connectors.js (see connectors.test.js) and moved Telegram to Settings →
// Integrations, so this page now answers exactly one question: which passkeys
// can open this vault. The "renders neither" case below pins that split — it is
// the assertion that fails if the connector UI creeps back onto this screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

vi.mock('../crypto.js', () => ({
  auditEnvelope: vi.fn(async () => true),
  fromBase64: vi.fn((x) => x),
  fromBase64Url: vi.fn((x) => x),
}));

// med-d5t.12: the regenerate flow dynamic-imports these two.
vi.mock('../unlock.js', () => ({ assertPasskey: vi.fn() }));
vi.mock('../signup.js', () => ({ renderEmergencyKit: vi.fn(async () => {}) }));

import { assertPasskey } from '../unlock.js';
import { renderEmergencyKit } from '../signup.js';

import { renderDeviceList } from '../devices.js';

let dom;
let app;
let onExit;
const ctx = { dek: 'fake-dek' };

const DEVICES = [
  { credential_id: 'aaaabbbbcccc', created_at: '2026-07-01T10:00:00Z', envelope: { nonce: 'n', ct: 'c', mac: 'm' } },
  { credential_id: 'ddddeeeeffff', created_at: '2026-07-02T10:00:00Z', envelope: null },
];

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'https://acct.example.test/' });
  global.document = dom.window.document;
  vi.stubGlobal('navigator', dom.window.navigator);
  global.confirm = vi.fn(() => true);
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => DEVICES }));
  app = dom.window.document.getElementById('app');
  onExit = vi.fn();
});

afterEach(() => {
  dom.window.close();
  vi.unstubAllGlobals();
  delete global.document;
  delete global.confirm;
  delete global.fetch;
});

async function renderAndSettle() {
  renderDeviceList(app, ctx, onExit);
  await vi.waitFor(() => {
    if (!app.querySelector('#add-device-button')) throw new Error('not rendered yet');
  });
}

describe('devices.js device list', () => {
  it('renders one row per device with its audit badge', async () => {
    await renderAndSettle();

    const rows = app.querySelectorAll('#device-list .device-row');
    expect(rows).toHaveLength(2);
    // auditEnvelope is mocked true; the envelope-less device stays unverified.
    expect(rows[0].querySelector('.device-verified')).not.toBeNull();
    expect(rows[1].querySelector('.device-unverified')).not.toBeNull();
  });

  // The point of med-lyv: devices and connectors are separate pages now.
  it('renders neither the connector picker nor the Telegram mount', async () => {
    await renderAndSettle();

    expect(app.querySelector('#claude-remote-connect-button')).toBeNull();
    expect(app.querySelector('#claude-local-connect-button')).toBeNull();
    expect(app.querySelector('#claude-disconnect-button')).toBeNull();
    expect(app.querySelector('#claude-status')).toBeNull();
    expect(app.querySelector('#telegram-mount')).toBeNull();
  });

  it('revokes a device and re-renders the list', async () => {
    await renderAndSettle();

    global.fetch.mockClear();
    app.querySelectorAll('#device-list .device-row button')[0]
      .dispatchEvent(new dom.window.Event('click'));

    await vi.waitFor(() => {
      if (global.fetch.mock.calls.length === 0) throw new Error('not called yet');
    });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/devices/aaaabbbbcccc');
    expect(opts.method).toBe('DELETE');
  });

  it('Back exits the page', async () => {
    await renderAndSettle();

    app.querySelector('#devices-back').dispatchEvent(new dom.window.Event('click'));
    expect(onExit).toHaveBeenCalled();
  });
});

// bd med-d5t.12 — the Emergency Kit used to be obtainable only during
// onboarding. Tap through that screen once and you could never get one again,
// which is the entire recovery story for an account whose passkeys are lost.
//
// This is a ROTATION, never a reveal: the recovery code is derived client-side
// and only its verifier + the recovery-wrapped envelope reach the server, so
// nobody — including the account's owner — can be shown the existing code. The
// only possible action is to mint a new one, which invalidates the old.
describe('Regenerate Emergency Kit (med-d5t.12)', () => {
  const regenCtx = { dek: 'fake-dek', accountId: 'acct-1' };

  async function openRegenerateScreen() {
    renderDeviceList(app, regenCtx, onExit);
    await vi.waitFor(() => {
      if (!app.querySelector('#regenerate-kit-button')) throw new Error('not rendered yet');
    });
    app.querySelector('#regenerate-kit-button').click();
    return app;
  }

  function acknowledgeAndConfirm() {
    const checkbox = app.querySelector('#regen-ack-checkbox');
    checkbox.checked = true;
    checkbox.dispatchEvent(new dom.window.Event('change'));
    app.querySelector('#regen-continue').click();
  }

  it('offers the entry point on the devices page, beside "Add a device"', async () => {
    renderDeviceList(app, regenCtx, onExit);
    await vi.waitFor(() => {
      if (!app.querySelector('#regenerate-kit-button')) throw new Error('not rendered yet');
    });
    expect(app.querySelector('#regenerate-kit-button')).not.toBeNull();
  });

  it('says plainly that the old kit stops working, and that we cannot show the current code', async () => {
    await openRegenerateScreen();

    expect(app.textContent).toMatch(/cannot show you your current recovery code/i);
    expect(app.textContent).toMatch(/permanently invalidates your old recovery code/i);
  });

  it('will not rotate on a single tap — the acknowledgement gates it', async () => {
    await openRegenerateScreen();

    expect(app.querySelector('#regen-continue').disabled).toBe(true);
    app.querySelector('#regen-continue').click();
    expect(assertPasskey).not.toHaveBeenCalled();
  });

  it('requires a fresh passkey assertion, and re-wraps the DEK that assertion returns', async () => {
    assertPasskey.mockResolvedValue({ accountId: 'acct-1', dek: 'fresh-dek' });
    await openRegenerateScreen();

    acknowledgeAndConfirm();

    await vi.waitFor(() => expect(renderEmergencyKit).toHaveBeenCalled());
    expect(assertPasskey).toHaveBeenCalledTimes(1);
    // Not ctx.dek: an unlocked tab on a shared laptop must not be enough.
    const [, kitCtx] = renderEmergencyKit.mock.calls[0];
    expect(kitCtx.dek).toBe('fresh-dek');
    expect(kitCtx.accountId).toBe('acct-1');
  });

  it('leaves the old kit working when the passkey assertion fails', async () => {
    assertPasskey.mockRejectedValue(new Error('Unlock failed. Please try again.'));
    await openRegenerateScreen();

    acknowledgeAndConfirm();

    await vi.waitFor(() => {
      expect(app.querySelector('#regen-error').textContent).toMatch(/still works/i);
    });
    // Nothing was uploaded: no half-rotation.
    expect(renderEmergencyKit).not.toHaveBeenCalled();
    // And the user can try again.
    expect(app.querySelector('#regen-continue').disabled).toBe(false);
  });

  it('leaves the old kit working when the recovery-material upload fails', async () => {
    assertPasskey.mockResolvedValue({ accountId: 'acct-1', dek: 'fresh-dek' });
    // renderEmergencyKit uploads envelope + verifier atomically before it
    // renders anything; a failure there must not strand the account.
    renderEmergencyKit.mockRejectedValue(new Error('Could not save recovery material.'));
    await openRegenerateScreen();

    acknowledgeAndConfirm();

    await vi.waitFor(() => {
      expect(app.querySelector('#regen-error').textContent).toMatch(/Could not save recovery material/);
    });
    expect(app.querySelector('#regen-error').textContent).toMatch(/still works/i);
    expect(app.querySelector('#regen-continue').disabled).toBe(false);
  });

  it('refuses a passkey belonging to a different account', async () => {
    assertPasskey.mockResolvedValue({ accountId: 'someone-else', dek: 'other-dek' });
    await openRegenerateScreen();

    acknowledgeAndConfirm();

    await vi.waitFor(() => {
      expect(app.querySelector('#regen-error').textContent).toMatch(/different account/i);
    });
    expect(renderEmergencyKit).not.toHaveBeenCalled();
  });

  it('Cancel returns to the device list without rotating anything', async () => {
    await openRegenerateScreen();

    app.querySelector('#regen-cancel').click();

    await vi.waitFor(() => {
      if (!app.querySelector('#add-device-button')) throw new Error('not back yet');
    });
    expect(assertPasskey).not.toHaveBeenCalled();
    expect(renderEmergencyKit).not.toHaveBeenCalled();
  });
});
