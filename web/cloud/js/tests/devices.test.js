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
  auditEnvelopeWithKey: vi.fn(async () => true),
  fromBase64: vi.fn((x) => x),
  fromBase64Url: vi.fn((x) => x),
}));

// med-d5t.12: the regenerate flow dynamic-imports these two.
vi.mock('../unlock.js', () => ({ assertPasskey: vi.fn() }));
vi.mock('../signup.js', () => ({ renderEmergencyKit: vi.fn(async () => {}) }));

// med-r1j2.6: the new-device baseline lives in sync.js's device-local store.
const deviceValueMap = vi.hoisted(() => new Map());
vi.mock('../sync.js', () => ({
  deviceValues: {
    get: async (k) => deviceValueMap.get(k) ?? null,
    set: async (k, v) => { deviceValueMap.set(k, v); },
  },
}));

import { assertPasskey } from '../unlock.js';
import { auditEnvelopeWithKey } from '../crypto.js';
import { renderEmergencyKit } from '../signup.js';
import { deviceValues } from '../sync.js';

import { renderDeviceList, renderRegenerateKit, checkNewDevices } from '../devices.js';
import { installDialogs, installRowActions, answerDialog, openDialog, SHELL_DIALOG_SCRIPTS } from './helpers/dialogs.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let dom;
let app;
let hooks;
const ctx = { accountId: 'acct-1', kData: 'fake-kdata', kMac: 'fake-kmac' };

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
  deviceValueMap.clear();
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

const CALM_ERROR = "Couldn't reach the server. Your data is safe — try again.";
const revokeItem = (row) => row.querySelector('.wg-menu__item--danger');

describe('devices.js device list', () => {
  it.each(['fetch', 'body', 'audit', 'known', 'error', 'teardown'])('keeps a pending %s device read from painting the committed or departed mount', async (stage) => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const json = vi.fn(() => stage === 'body' ? pending : Promise.resolve(DEVICES));
    const response = { ok: true, json };
    global.fetch = vi.fn(() => ['fetch', 'error', 'teardown'].includes(stage) ? pending : Promise.resolve(response));
    const audit = vi.mocked(auditEnvelopeWithKey).mockImplementation(() => stage === 'audit' ? pending : Promise.resolve(true));
    audit.mockClear();
    const known = vi.spyOn(deviceValues, 'get').mockImplementation(() => stage === 'known' ? pending : Promise.resolve(null));
    try {
      renderDeviceList(app, ctx, hooks);
      const entered = stage === 'body' ? json : stage === 'audit' ? audit : stage === 'known' ? known : global.fetch;
      await vi.waitFor(() => expect(entered).toHaveBeenCalled());
      const before = app.innerHTML;
      if (stage === 'teardown') app.remove();
      else dom.window.document.documentElement.setAttribute('data-provider-reload-committed', '');
      release(stage === 'fetch' || stage === 'teardown' ? response : stage === 'body' ? DEVICES : stage === 'error' ? { ok: false, status: 403 } : stage === 'audit' ? true : null);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(app.innerHTML).toBe(before);
      expect(hooks.onLoaded).not.toHaveBeenCalled();
      if (stage === 'fetch' || stage === 'teardown') expect(json).not.toHaveBeenCalled();
      if (['fetch', 'body', 'audit', 'error'].includes(stage)) expect(known).not.toHaveBeenCalled();
    } finally {
      known.mockRestore();
      audit.mockImplementation(async () => true);
    }
  });

  it('renders one kit row per device with its audit chip', async () => {
    await renderAndSettle();

    const rows = app.querySelectorAll('#device-list .wg-row.device-row');
    expect(rows).toHaveLength(2);
    // The audit runs on the verify-only K_mac leaf key, never raw DEK bytes
    // (med-5h1t.3); mocked true, so the envelope-less device stays unverified.
    expect(auditEnvelopeWithKey).toHaveBeenCalledWith(expect.objectContaining({ kMac: 'fake-kmac' }));
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
    // A 4xx is final: no automatic retry, the calm copy at once.
    global.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    renderDeviceList(app, ctx, hooks);
    await vi.waitFor(() => {
      if (!app.querySelector('#devices-retry')) throw new Error('not rendered yet');
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(app.querySelector('.wg-error').textContent).toBe(CALM_ERROR);

    global.fetch = vi.fn(async () => ({ ok: true, json: async () => DEVICES }));
    app.querySelector('#devices-retry').click();
    await vi.waitFor(() => {
      if (!app.querySelector('#add-device-button')) throw new Error('not retried yet');
    });
  });

  // med-e92o: a redeploy blip (5xx or network error) is retried once, quietly,
  // before the owner ever sees an error.
  it('retries once after a 503 and renders the list with no error', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValue({ ok: true, status: 200, json: async () => DEVICES });
    renderDeviceList(app, ctx, hooks);
    await vi.waitFor(() => {
      if (!app.querySelector('#add-device-button')) throw new Error('not rendered yet');
    }, { timeout: 4000 });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(app.querySelectorAll('#device-list .device-row')).toHaveLength(2);
    expect(app.querySelector('.wg-error')).toBeNull();
  });

  it('shows the calm error with Try again after the one retry also fails', async () => {
    global.fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('network error'))
      .mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
    renderDeviceList(app, ctx, hooks);
    await vi.waitFor(() => {
      if (!app.querySelector('#devices-retry')) throw new Error('not rendered yet');
    }, { timeout: 4000 });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(app.querySelector('.wg-error').textContent).toBe(CALM_ERROR);
    expect(app.querySelector('#devices-retry').textContent).toBe('Try again');
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

// med-r1j2.6, Spec: screens-add-device.html AD11 (+ "· notice").
describe('devices.js AD11: platform rows, This device, address, new-device notice', () => {
  const ANDROID = { credential_id: 'newandroid01', created_at: '2026-10-23T10:00:00Z', platform: 'android', envelope: null };
  const SELF = { ...DEVICES[0], platform: 'ios', current: true };

  function serve(list) {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => list }));
  }
  function toastSpy() {
    const spy = vi.fn();
    dom.window.safeToast = spy;
    return spy;
  }

  it('titles rows by reported platform, tags only this device, keeps labelless rows as before', async () => {
    serve([SELF, ANDROID, DEVICES[1]]);
    await renderAndSettle();

    const rows = app.querySelectorAll('#device-list .device-row');
    expect(app.querySelector('.wg-eyebrow').textContent).toBe('Devices');
    expect(app.querySelector('#device-count').textContent).toBe('3');
    expect(rows[0].querySelector('.wg-row__title').textContent).toBe('iPhone');
    expect(rows[1].querySelector('.wg-row__title').textContent).toBe('Android phone');
    expect(rows[1].querySelector('.wg-row__meta').textContent).toMatch(/^added 23 Oct/);
    expect(rows[2].querySelector('.wg-row__title').textContent).toBe('Passkey ddddeeee…');
    expect(rows[0].querySelector('.wg-tag.device-this').textContent).toBe('This device');
    expect(app.querySelectorAll('.device-this')).toHaveLength(1);
    expect(app.textContent).toContain('“This device” is our best guess.');
  });

  it('shows the account address and copies it', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const toast = toastSpy();
    await renderAndSettle();

    expect(app.querySelector('#account-address').textContent).toBe('acct.example.test');
    app.querySelector('#copy-account-address').click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Address copied', 'success'));
    expect(writeText).toHaveBeenCalledWith('acct.example.test');
  });

  it('first run seeds the baseline silently; a new credential toasts once', async () => {
    const toast = toastSpy();
    serve([SELF]);
    await checkNewDevices(1000);
    expect(toast).not.toHaveBeenCalled();

    serve([SELF, ANDROID]);
    await checkNewDevices(2000);
    expect(toast).toHaveBeenCalledTimes(1);
    const [msg, type, opts] = toast.mock.calls[0];
    expect(msg).toBe('New device added: Android phone, 23 Oct');
    expect(type).toBe('info');
    expect(opts.detail).toBe('Not you? Revoke it now.');
    expect(opts.action.label).toBe('Revoke');

    await checkNewDevices(3000);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('never announces this device itself', async () => {
    const toast = toastSpy();
    serve([DEVICES[1]]);
    await checkNewDevices(1000);
    serve([DEVICES[1], SELF]);
    await checkNewDevices(2000);
    expect(toast).not.toHaveBeenCalled();
  });

  it('keeps the notice in Devices for 7 days, with Revoke behind the destructive dialog', async () => {
    toastSpy();
    serve([SELF]);
    await checkNewDevices(Date.now() - 1000);
    serve([SELF, ANDROID]);
    await checkNewDevices(Date.now());
    await renderAndSettle();

    const notice = app.querySelector('#device-notices .device-notice');
    expect(notice.querySelector('.wg-row__title').textContent).toBe('New device added: Android phone, 23 Oct');
    global.fetch.mockClear();
    notice.querySelector('button').click();
    await answerDialog(dom.window.document, true);
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/devices/newandroid01', { method: 'DELETE' }));
    await vi.waitFor(() => expect(hooks.onLoaded).toHaveBeenCalledTimes(2));
  });

  it('drops the notice after 7 days; the row stays', async () => {
    toastSpy();
    serve([SELF]);
    await checkNewDevices(1000);
    serve([SELF, ANDROID]);
    await checkNewDevices(2000); // noticed long ago (epoch + 2s)
    await renderAndSettle();

    expect(app.querySelector('#device-notices')).toBeNull();
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
  const regenCtx = { accountId: 'acct-1', kData: 'fake-kdata', kMac: 'fake-kmac' };
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
    // The warm ctx holds no DEK; an unlocked tab on a shared laptop must not be enough.
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
