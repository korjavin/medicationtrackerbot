// Device list + revocation. med-lyv split the Claude/MCP connector picker out
// into connectors.js (see connectors.test.js) and moved Telegram to Settings →
// Integrations, so this list answers exactly one question: which passkeys can
// open this vault. The "renders neither" case below pins that split.
//
// med-xso6.25: the list mounts inside the app's Settings → Devices & connectors
// page (kit S4): kit rows with an audit chip, Revoke behind each row's overflow
// menu → destructive dialog, "Add a device" the one sun primary. The module
// owns no page chrome (no Back, no heading) — the WGPage does.
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

import { renderDeviceList, renderRegenerateKit } from '../devices.js';
import { installDialogs, installRowActions, answerDialog, openDialog, SHELL_DIALOG_SCRIPTS } from './helpers/dialogs.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let dom;
let app;
let hooks;
const ctx = { dek: 'fake-dek' };

const DEVICES = [
  { credential_id: 'aaaabbbbcccc', created_at: '2026-07-01T10:00:00Z', envelope: { nonce: 'n', ct: 'c', mac: 'm' } },
  { credential_id: 'ddddeeeeffff', created_at: '2026-07-02T10:00:00Z', envelope: null },
];

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'https://acct.example.test/', runScripts: 'outside-only' });
  global.document = dom.window.document;
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('window', dom.window);
  installDialogs(dom.window);
  installRowActions(dom.window);
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => DEVICES }));
  app = dom.window.document.getElementById('app');
  hooks = { onAddDevice: vi.fn(), onLoaded: vi.fn() };
});

afterEach(() => {
  dom.window.close();
  vi.unstubAllGlobals();
  delete global.document;
  delete global.fetch;
});

async function renderAndSettle() {
  renderDeviceList(app, ctx, hooks);
  await vi.waitFor(() => {
    if (!app.querySelector('#add-device-button')) throw new Error('not rendered yet');
  });
}

const revokeItem = (row) => row.querySelector('.wg-menu__item--danger');

describe('devices.js device list', () => {
  it('renders one kit row per device with its audit chip', async () => {
    await renderAndSettle();

    const rows = app.querySelectorAll('#device-list .wg-row.device-row');
    expect(rows).toHaveLength(2);
    // auditEnvelope is mocked true; the envelope-less device stays unverified.
    expect(rows[0].querySelector('.wg-chip--ok.device-verified')).not.toBeNull();
    expect(rows[1].querySelector('.wg-chip--danger.device-unverified')).not.toBeNull();
    expect(rows[0].querySelector('.wg-row__title').textContent).toBe('Passkey aaaabbbb…');
  });

  it('hands the audited list to the host (home-row summary, nudge)', async () => {
    await renderAndSettle();
    expect(hooks.onLoaded).toHaveBeenCalledTimes(1);
    expect(hooks.onLoaded.mock.calls[0][0]).toHaveLength(2);
  });

  // Kit S4: "Add a device" is the one sun primary; Revoke is no longer a
  // button beside it but an overflow menu item on each row.
  it('has one sun primary and keeps Revoke behind each row overflow', async () => {
    await renderAndSettle();

    expect(app.querySelectorAll('.wg-btn--primary')).toHaveLength(1);
    expect(app.querySelector('#add-device-button').classList.contains('wg-btn--primary')).toBe(true);
    for (const row of app.querySelectorAll('#device-list .device-row')) {
      expect(row.querySelector('.wg-swipe__more')).not.toBeNull();
      expect(revokeItem(row).textContent).toContain('Revoke');
      expect(row.querySelector('.wg-menu').hidden).toBe(true);
    }
    // No shell chrome: the hosting page owns Back.
    expect(app.querySelector('#devices-back')).toBeNull();
    expect(app.querySelector('h1')).toBeNull();
  });

  it('Add a device hands off to the host', async () => {
    await renderAndSettle();
    app.querySelector('#add-device-button').click();
    expect(hooks.onAddDevice).toHaveBeenCalledTimes(1);
  });

  // The point of med-lyv: devices and connectors are separate pages.
  it('renders neither the connector picker nor the Telegram mount', async () => {
    await renderAndSettle();

    expect(app.querySelector('#claude-remote-connect-button')).toBeNull();
    expect(app.querySelector('#claude-local-connect-button')).toBeNull();
    expect(app.querySelector('#claude-disconnect-button')).toBeNull();
    expect(app.querySelector('#claude-status')).toBeNull();
    expect(app.querySelector('#telegram-mount')).toBeNull();
  });

  it('revokes a device through a destructive dialog and re-renders the list', async () => {
    await renderAndSettle();

    global.fetch.mockClear();
    revokeItem(app.querySelectorAll('#device-list .device-row')[0]).click();
    const dialog = await answerDialog(dom.window.document, true);
    expect(dialog.querySelector('.wg-dialog__title').textContent).toBe('Revoke this device?');
    expect(dialog.querySelector('.mt-confirm-modal__confirm').classList.contains('wg-btn--danger')).toBe(true);

    await vi.waitFor(() => {
      if (global.fetch.mock.calls.length === 0) throw new Error('not called yet');
    });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/devices/aaaabbbbcccc');
    expect(opts.method).toBe('DELETE');
    await vi.waitFor(() => expect(hooks.onLoaded).toHaveBeenCalledTimes(2));
  });

  it('declining the dialog revokes nothing', async () => {
    await renderAndSettle();

    global.fetch.mockClear();
    revokeItem(app.querySelectorAll('#device-list .device-row')[1]).click();
    await answerDialog(dom.window.document, false);
    await new Promise((r) => setTimeout(r, 0));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('shows the error with a retry when the list fails to load', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    renderDeviceList(app, ctx, hooks);
    await vi.waitFor(() => {
      if (!app.querySelector('#devices-retry')) throw new Error('not rendered yet');
    });
    expect(app.querySelector('.wg-error').textContent).toMatch(/Could not load your devices/);

    global.fetch = vi.fn(async () => ({ ok: true, json: async () => DEVICES }));
    app.querySelector('#devices-retry').click();
    await vi.waitFor(() => {
      if (!app.querySelector('#add-device-button')) throw new Error('not retried yet');
    });
  });

  // The passkey shell's storage-blocked unlock menu (unlock.js) mounts the same
  // list without the app's row-actions component: Revoke stays reachable.
  it('falls back to a plain destructive Revoke button where WGRowActions is absent', async () => {
    delete dom.window.WGRowActions;
    await renderAndSettle();

    const button = app.querySelector('#device-list .device-row > button.wg-btn--danger-ghost');
    expect(button.textContent).toBe('Revoke');
    global.fetch.mockClear();
    button.click();
    await answerDialog(dom.window.document, true);
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/devices/aaaabbbbcccc', { method: 'DELETE' }));
  });

  // bd med-kj0w: browser Back over an open dialog cancels just the dialog (its
  // own history entry, via modal-history.js); the page's entry below stays.
  it('browser Back over the revoke dialog cancels it and stays on the page', async () => {
    const signupHtml = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../signup.html'), 'utf8');
    for (const f of SHELL_DIALOG_SCRIPTS) expect(signupHtml).toContain(`<script src="/static/js/${f}"></script>`);

    await renderAndSettle();
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const startLength = dom.window.history.length;

    global.fetch.mockClear();
    revokeItem(app.querySelectorAll('#device-list .device-row')[0]).click();
    await vi.waitFor(() => {
      if (!openDialog(dom.window.document)) throw new Error('no dialog open');
    });
    await vi.waitFor(() => {
      if (dom.window.history.state?.modalDialog !== true) throw new Error('no dialog entry yet');
    });

    dom.window.history.back();
    await vi.waitFor(() => {
      if (openDialog(dom.window.document)) throw new Error('dialog still open');
    });
    await flush(); await flush();

    expect(dom.window.history.state).toBe(null);
    expect(dom.window.history.length).toBe(startLength + 1);
    expect(dom.window.location.href).toBe('https://acct.example.test/');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(app.querySelectorAll('#device-list .device-row')).toHaveLength(2);
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
//
// med-xso6.25: a full-document passkey ceremony — the app's Emergency Kit row
// navigates to /devices?flow=emergency-kit, where app.js runs this screen.
describe('Regenerate Emergency Kit (med-d5t.12)', () => {
  const regenCtx = { dek: 'fake-dek', accountId: 'acct-1' };
  let onDone;

  function openRegenerateScreen() {
    onDone = vi.fn();
    renderRegenerateKit(app, regenCtx, onDone);
    return app;
  }

  function acknowledgeAndConfirm() {
    const checkbox = app.querySelector('#regen-ack-checkbox');
    checkbox.checked = true;
    checkbox.dispatchEvent(new dom.window.Event('change'));
    app.querySelector('#regen-continue').click();
  }

  it('says plainly that the old kit stops working, and that we cannot show the current code', () => {
    openRegenerateScreen();

    expect(app.textContent).toMatch(/cannot show you your current recovery code/i);
    expect(app.textContent).toMatch(/permanently invalidates your old recovery code/i);
  });

  it('will not rotate on a single tap — the acknowledgement gates it', () => {
    openRegenerateScreen();

    expect(app.querySelector('#regen-continue').disabled).toBe(true);
    app.querySelector('#regen-continue').click();
    expect(assertPasskey).not.toHaveBeenCalled();
  });

  it('requires a fresh passkey assertion, and re-wraps the DEK that assertion returns', async () => {
    assertPasskey.mockResolvedValue({ accountId: 'acct-1', dek: 'fresh-dek' });
    openRegenerateScreen();

    acknowledgeAndConfirm();

    await vi.waitFor(() => expect(renderEmergencyKit).toHaveBeenCalled());
    expect(assertPasskey).toHaveBeenCalledTimes(1);
    // Not ctx.dek: an unlocked tab on a shared laptop must not be enough.
    const [, kitCtx] = renderEmergencyKit.mock.calls[0];
    expect(kitCtx.dek).toBe('fresh-dek');
    expect(kitCtx.accountId).toBe('acct-1');
    // The kit's Done returns to the caller (app.js → the in-app Devices page).
    expect(kitCtx.onKitSaved).toBe(onDone);
  });

  it('leaves the old kit working when the passkey assertion fails', async () => {
    assertPasskey.mockRejectedValue(new Error('Unlock failed. Please try again.'));
    openRegenerateScreen();

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
    openRegenerateScreen();

    acknowledgeAndConfirm();

    await vi.waitFor(() => {
      expect(app.querySelector('#regen-error').textContent).toMatch(/Could not save recovery material/);
    });
    expect(app.querySelector('#regen-error').textContent).toMatch(/still works/i);
    expect(app.querySelector('#regen-continue').disabled).toBe(false);
  });

  it('refuses a passkey belonging to a different account', async () => {
    assertPasskey.mockResolvedValue({ accountId: 'someone-else', dek: 'other-dek' });
    openRegenerateScreen();

    acknowledgeAndConfirm();

    await vi.waitFor(() => {
      expect(app.querySelector('#regen-error').textContent).toMatch(/different account/i);
    });
    expect(renderEmergencyKit).not.toHaveBeenCalled();
  });

  it('Cancel returns to the caller without rotating anything', () => {
    openRegenerateScreen();

    app.querySelector('#regen-cancel').click();

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(assertPasskey).not.toHaveBeenCalled();
    expect(renderEmergencyKit).not.toHaveBeenCalled();
  });
});
