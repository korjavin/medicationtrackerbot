// bd med-tuv — "Add a device" showed a QR and a countdown, and kept showing
// them after the other device had already enrolled. Two defects; the second is
// the one that matters.
//
//   1. No completion feedback. The screen only decremented a countdown. It never
//      asked the server whether the slot had been claimed, so the user could not
//      tell whether it had worked.
//   2. Cancel did not cancel. It cleared a local timer and navigated away,
//      making no server call at all. The slot stayed live and claimable for the
//      rest of its 10-minute window. In an E2EE product that code enrolls a NEW
//      DEVICE onto the vault, so the button taught the user a false belief about
//      a live credential.
//
// Pure-unit, per the cloud shell's documented exception to repo rule 8.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

vi.mock('../crypto.js', () => ({
  encryptTransferPayload: vi.fn(async () => new Uint8Array([1, 2, 3])),
  toBase64: vi.fn(() => 'Y3Q='),
  toBase64Url: vi.fn(() => 'dGs'),
  base32Encode: vi.fn(() => 'AAAA-BBBB'),
}));
vi.mock('../../vendor/qrcode.mjs', () => ({
  qrcode: () => ({ addData() {}, make() {}, createSvgTag: () => '<svg></svg>' }),
}));

import { renderAddDevice } from '../transfer.js';

const SLOT_ID = 'slot-abc';
const ctx = { accountId: 'acct-1', dek: new Uint8Array(32) };

let dom;
let app;
let onExit;
let slotStatus;   // what GET /api/transfer/<id> reports
let deleteStatus; // what DELETE returns
let calls;

function installFetch() {
  global.fetch = vi.fn(async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    calls.push(`${method} ${u}`);

    if (u === '/api/transfer' && method === 'POST') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ slot_id: SLOT_ID, expires_at: new Date(Date.now() + 600000).toISOString() }),
      };
    }
    if (u === `/api/transfer/${SLOT_ID}` && method === 'GET') {
      if (slotStatus === 404) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ status: slotStatus }) };
    }
    if (u === `/api/transfer/${SLOT_ID}` && method === 'DELETE') {
      return { ok: deleteStatus === 204, status: deleteStatus, json: async () => ({}) };
    }
    if (u === '/api/devices') {
      return {
        ok: true,
        status: 200,
        json: async () => ([
          { credential_id: 'oldoldold1111', created_at: '2026-07-01T10:00:00Z' },
          { credential_id: 'newnewnew2222', created_at: '2026-07-09T10:00:00Z' },
        ]),
      };
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'https://acct.example.test/' });
  global.document = dom.window.document;
  global.location = dom.window.location;
  vi.stubGlobal('crypto', { getRandomValues: (a) => a });
  app = dom.window.document.getElementById('app');
  onExit = vi.fn();
  slotStatus = 'pending';
  deleteStatus = 204;
  calls = [];
  installFetch();
});

afterEach(() => {
  vi.useRealTimers();
  dom.window.close();
  vi.unstubAllGlobals();
  delete global.document;
  delete global.fetch;
  delete global.location;
});

// renderAddDevice kicks off async work; settle it, then let the fake clock run.
async function mountTransferScreen() {
  renderAddDevice(app, ctx, onExit);
  await vi.waitFor(() => {
    if (!app.querySelector('#transfer-cancel')) throw new Error('not rendered yet');
  });
}

describe('Add a device — completion feedback (med-tuv)', () => {
  it('polls the slot and swaps to a success state once it is claimed', async () => {
    await mountTransferScreen();
    expect(app.querySelector('#transfer-countdown')).not.toBeNull();

    slotStatus = 'claimed';
    await vi.advanceTimersByTimeAsync(2000);

    await vi.waitFor(() => {
      if (!app.textContent.includes('Device added')) throw new Error('no success state');
    });
    // The countdown is gone — nothing is still ticking toward "expired".
    expect(app.querySelector('#transfer-countdown')).toBeNull();
    expect(app.querySelector('#transfer-cancel')).toBeNull();
  });

  it('names the newly enrolled device, so an unexpected one is visible', async () => {
    await mountTransferScreen();
    slotStatus = 'claimed';
    await vi.advanceTimersByTimeAsync(2000);

    await vi.waitFor(() => {
      const detail = app.querySelector('#transfer-complete-detail');
      if (!detail || !detail.textContent.includes('newnewne')) throw new Error('device not named yet');
    });
    expect(app.textContent).toMatch(/did not expect this/i);
  });

  it('stops polling once claimed — no requests after the success screen', async () => {
    await mountTransferScreen();
    slotStatus = 'claimed';
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => {
      if (!app.textContent.includes('Device added')) throw new Error('no success state');
    });

    const after = calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(calls.length).toBe(after);
  });

  it('keeps waiting while the slot is still pending', async () => {
    await mountTransferScreen();

    await vi.advanceTimersByTimeAsync(6000);

    expect(app.textContent).not.toContain('Device added');
    expect(app.querySelector('#transfer-cancel')).not.toBeNull();
    expect(calls.filter((c) => c === `GET /api/transfer/${SLOT_ID}`).length).toBeGreaterThanOrEqual(2);
  });

  it('survives a transient poll failure rather than showing a false result', async () => {
    await mountTransferScreen();
    slotStatus = 404; // expired/swept server-side

    await vi.advanceTimersByTimeAsync(4000);

    expect(app.textContent).not.toContain('Device added');
    expect(app.querySelector('#transfer-cancel')).not.toBeNull();
  });
});

describe('Add a device — Cancel must mean cancelled (med-tuv)', () => {
  it('invalidates the slot server-side before leaving the screen', async () => {
    await mountTransferScreen();

    app.querySelector('#transfer-cancel').click();

    await vi.waitFor(() => expect(onExit).toHaveBeenCalled());
    expect(calls).toContain(`DELETE /api/transfer/${SLOT_ID}`);
  });

  it('does not navigate away when the cancel fails — that would imply the code is dead', async () => {
    deleteStatus = 500;
    await mountTransferScreen();

    app.querySelector('#transfer-cancel').click();

    await vi.waitFor(() => {
      const err = app.querySelector('#transfer-error');
      if (!err || !err.textContent) throw new Error('no error yet');
    });
    expect(app.querySelector('#transfer-error').textContent).toMatch(/may still work/i);
    expect(onExit).not.toHaveBeenCalled();
    // And the user can try again.
    expect(app.querySelector('#transfer-cancel').disabled).toBe(false);
  });

  it('stops polling after a successful cancel', async () => {
    await mountTransferScreen();

    app.querySelector('#transfer-cancel').click();
    await vi.waitFor(() => expect(onExit).toHaveBeenCalled());

    const after = calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(calls.length).toBe(after);
  });
});
