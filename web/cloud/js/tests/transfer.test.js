// "Add a device" on the origin — protocol v2 (epic med-r1j2, bead med-r1j2.2;
// docs/cloud-crypto.md "Path B"). The flow runs against real WebCrypto, a fake
// server that enforces the v2 state machine, and a simulated new device built
// from the same crypto.js helpers the /claim screen uses — so a passing test
// means the two halves agree byte for byte.
//
// Earlier pins kept here: med-tuv (completion feedback; Cancel deletes the
// slot server-side before leaving), med-5h1t.3 (every code starts with a
// fresh passkey assertion), med-xso6.25 (host page Back = cancel()).
//
// Pure-unit, per the cloud shell's documented exception to repo rule 8. The
// global console guard (tests/helpers/setup.js) fails any test that logs, so
// none of these flows may print the code, TK or DEK.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  toBase64,
  fromBase64,
  fromBase64Url,
  decodeTransferCode,
  transferSlotId,
  generateTransferKeyPair,
  transferCommit,
  transferTranscript,
  transferClaimMac,
  transferRevealMac,
  deriveTransferKeys,
  unwrapTransferDek,
  transferConfirmMac,
  timingSafeEqual,
} from '../crypto.js';

let qrData;
vi.mock('../../vendor/qrcode.mjs', () => ({
  qrcode: () => ({ addData(d) { qrData = d; }, make() {}, createSvgTag: () => '<svg></svg>' }),
}));
vi.mock('../unlock.js', () => ({ assertPasskey: vi.fn() }));

import { renderAddDevice } from '../transfer.js';
import { assertPasskey } from '../unlock.js';

const ctx = { accountId: 'acct-1' };
const ACCOUNT_SUB = 'acct'; // https://acct.example.test
const FRESH_DEK = new Uint8Array(32).fill(7);
const CRED_ID = new Uint8Array([1, 2, 3, 4]);

let dom;
let app;
let onExit;
let flow;
let server;
let calls;

// ---- fake server: the v2 state machine, blind to TK ----------------------
function newServer() {
  return { slot: null, deleteStatus: 204, swapAfterReveal: null };
}

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function originView(slot) {
  const b = (v) => (v ? toBase64(v) : undefined);
  return {
    status: slot.state,
    expires_at: slot.expiresAt,
    platform: slot.platform,
    n_pub: b(slot.nPub),
    mac_n: b(slot.macN),
    o_pub: b(slot.oPub),
    mac_o: b(slot.macO),
    conf_n: b(slot.confN),
  };
}

function installFetch() {
  global.fetch = vi.fn(async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url: u, body, keepalive: init.keepalive });
    const slot = server.slot;
    const id = slot && slot.id;

    if (u === '/api/transfer' && method === 'POST') {
      server.slot = {
        id: body.slot_id,
        commit: fromBase64(body.commit),
        state: 'pending',
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      };
      return json(200, { slot_id: body.slot_id, expires_at: server.slot.expiresAt });
    }
    if (!slot || u.indexOf(`/api/transfer/${id}`) !== 0) throw new Error(`unexpected fetch: ${method} ${u}`);
    if (u === `/api/transfer/${id}` && method === 'DELETE') {
      if (server.deleteStatus === 204) slot.state = 'deleted';
      return json(server.deleteStatus, {});
    }
    if (slot.state === 'deleted') return json(404, {});
    if (u === `/api/transfer/${id}` && method === 'GET') return json(200, originView(slot));
    if (u === `/api/transfer/${id}/reveal` && method === 'POST') {
      if (slot.state !== 'claimed') return json(409, {});
      Object.assign(slot, { state: 'revealed', oPub: fromBase64(body.o_pub), macO: fromBase64(body.mac_o) });
      if (server.swapAfterReveal) Object.assign(slot, server.swapAfterReveal);
      return json(204, {});
    }
    if (u === `/api/transfer/${id}/approve` && method === 'POST') {
      if (slot.state !== 'revealed') return json(409, {});
      Object.assign(slot, { state: 'approved', ct: fromBase64(body.ct), approver: body.approving_credential_id });
      if (server.loseApproveResponse) throw new TypeError('network error');
      return json(204, {});
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  });
}

// ---- the new device, from the QR link ------------------------------------
function scannedTk() {
  const frag = new URL(qrData).hash.slice(1);
  return { slot: frag.split('.')[0], tk: fromBase64Url(frag.split('.')[1]) };
}

async function newDeviceClaims({ platform = 'android', tk = scannedTk().tk } = {}) {
  const slot = server.slot;
  const keyPair = await generateTransferKeyPair();
  const fields = { accountId: ACCOUNT_SUB, slot: slot.id, platform, commit: slot.commit, nPub: keyPair.pub };
  Object.assign(slot, { state: 'claimed', nPub: keyPair.pub, platform, macN: await transferClaimMac(tk, fields) });
  return { keyPair, fields, tk };
}

// What /claim does on `revealed`: check commit + mac_o, derive the same code.
async function newDeviceSeesReveal(device) {
  const slot = server.slot;
  expect(timingSafeEqual(await transferCommit(slot.oPub), slot.commit)).toBe(true);
  const transcript = transferTranscript({ ...device.fields, oPub: slot.oPub });
  expect(timingSafeEqual(await transferRevealMac(device.tk, transcript), slot.macO)).toBe(true);
  return { transcript, ...(await deriveTransferKeys(device.keyPair.privateKey, slot.oPub, transcript)) };
}

const until = (check) => vi.waitFor(() => { if (!check()) throw new Error('not yet'); }, { timeout: 5000 });
const text = () => app.textContent.replace(/\s+/g, ' ');

beforeEach(() => {
  vi.useFakeTimers();
  dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'https://acct.example.test/' });
  global.document = dom.window.document;
  global.location = dom.window.location;
  app = dom.window.document.getElementById('app');
  onExit = vi.fn();
  server = newServer();
  calls = [];
  qrData = null;
  installFetch();
  assertPasskey.mockReset();
  assertPasskey.mockResolvedValue({ accountId: 'acct-1', dek: FRESH_DEK, credentialId: CRED_ID });
});

afterEach(() => {
  if (flow) flow.stop();
  flow = null;
  vi.useRealTimers();
  dom.window.close();
  delete global.document;
  delete global.fetch;
  delete global.location;
});

const posted = (suffix) => calls.filter((c) => c.method === 'POST' && c.url.endsWith(suffix));

async function mountWaiting() {
  flow = renderAddDevice(app, ctx, onExit);
  app.querySelector('#transfer-confirm').click();
  await until(() => app.querySelector('#transfer-cancel'));
}

async function mountApprove(opts) {
  await mountWaiting();
  const device = await newDeviceClaims(opts);
  await until(() => app.querySelector('#transfer-approve'));
  return device;
}

describe('Add a device — AD1 start: a fresh passkey assertion (med-5h1t.3)', () => {
  it('says what the passkey is for, and posts nothing until Unlock', async () => {
    flow = renderAddDevice(app, ctx, onExit);
    await vi.advanceTimersByTimeAsync(0);

    expect(app.querySelector('#transfer-confirm').textContent).toContain('Unlock with passkey');
    expect(text()).toContain('does not create a new passkey');
    expect(text()).toContain('Your passkeys here keep working');
    expect(assertPasskey).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('rejects a passkey for another account before posting anything', async () => {
    assertPasskey.mockResolvedValue({ accountId: 'someone-else', dek: FRESH_DEK, credentialId: CRED_ID });
    flow = renderAddDevice(app, ctx, onExit);
    app.querySelector('#transfer-confirm').click();

    await until(() => text().includes('different account'));
    expect(calls).toEqual([]);
    expect(app.querySelector('#transfer-retry')).not.toBeNull();
  });

  it('a failed assertion shows an error and posts nothing; retry asks again', async () => {
    assertPasskey.mockRejectedValueOnce(new Error('Unlock failed. Please try again.'));
    flow = renderAddDevice(app, ctx, onExit);
    app.querySelector('#transfer-confirm').click();
    await until(() => app.querySelector('#transfer-retry'));
    expect(calls).toEqual([]);

    app.querySelector('#transfer-retry').click();
    app.querySelector('#transfer-confirm').click();
    await until(() => app.querySelector('#transfer-cancel'));
    expect(assertPasskey).toHaveBeenCalledTimes(2);
  });

  it('Back during the passkey prompt leaves nothing behind', async () => {
    let resolveAssertion;
    assertPasskey.mockReturnValue(new Promise((r) => { resolveAssertion = r; }));
    flow = renderAddDevice(app, ctx, onExit);
    app.querySelector('#transfer-confirm').click();

    await expect(flow.cancel()).resolves.toBe(true);
    resolveAssertion({ accountId: 'acct-1', dek: FRESH_DEK, credentialId: CRED_ID });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);
  });
});

describe('Add a device — AD2 waiting: QR, link, typed code', () => {
  it('opens the slot with only the derived id and commit — no ciphertext, no o_pub', async () => {
    await mountWaiting();

    const [create] = posted('/api/transfer');
    expect(Object.keys(create.body).sort()).toEqual(['commit', 'slot_id']);
    expect(fromBase64(create.body.commit)).toHaveLength(32);
    const { slot, tk } = scannedTk();
    expect(tk).toHaveLength(16);
    expect(slot).toBe(await transferSlotId(tk));
    expect(create.body.slot_id).toBe(slot);
    // The base-domain hand-off (med-r1j2.4), and the typed code's hint names it.
    expect(qrData.startsWith('https://example.test/d/acct#')).toBe(true);
    expect(app.querySelector('#transfer-claim-host').textContent).toBe('example.test/d/acct');
  });

  it('shows the typed code as 28 letters in 3-letter groups, decoding to the same TK', async () => {
    await mountWaiting();

    const code = app.querySelector('#transfer-fallback').textContent;
    expect(code).toMatch(/^([A-Z]{3} ){9}[A-Z]$/);
    expect(decodeTransferCode(code)).toEqual(scannedTk().tk);
    expect(text()).toContain('Code for a computer');
    expect(text()).toContain('Works once · expires in 10 min · you approve the new device here');
    expect(app.querySelector('#transfer-copy-link')).not.toBeNull();
    // No sun on the waiting screen: nothing here needs doing.
    expect(app.querySelector('.wg-btn--primary')).toBeNull();
  });

  it('keeps waiting while the slot is still pending', async () => {
    await mountWaiting();
    await vi.advanceTimersByTimeAsync(6000);

    expect(app.querySelector('#transfer-cancel')).not.toBeNull();
    expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThanOrEqual(2);
  });

  it('expires into AD4 · expired; "Make a new code" starts over with a new assertion', async () => {
    await mountWaiting();
    await vi.advanceTimersByTimeAsync(600000);

    await until(() => text().includes('The code expired'));
    expect(text()).toContain('Nobody joined');
    app.querySelector('#transfer-retry').click();
    expect(app.querySelector('#transfer-confirm')).not.toBeNull();
  });
});

describe('Add a device — AD3 approve with the match code (protocol v2)', () => {
  it('claimed → reveal → both devices show the same code; Approve releases the DEK to that receiver only', async () => {
    const device = await mountApprove();

    // Reveal posted o_pub + mac_o, and no ciphertext yet.
    expect(posted('/reveal')).toHaveLength(1);
    expect(posted('/approve')).toHaveLength(0);
    const n = await newDeviceSeesReveal(device);
    const shown = app.querySelector('#transfer-matchcode').textContent;
    expect(shown).toBe(n.sas);
    expect(text()).toContain('An Android phone wants to open your account');
    expect(text()).toContain('Does your new device show this code?');

    app.querySelector('#transfer-approve').click();
    await until(() => server.slot.state === 'approved');

    const dek = await unwrapTransferDek(n.kWrap, server.slot.ct, n.transcript);
    expect(dek).toEqual(FRESH_DEK);
    expect(server.slot.approver).toBe('AQIDBA');
    // A different transcript (e.g. another platform) can't open it.
    const other = transferTranscript({ ...device.fields, platform: 'web', oPub: server.slot.oPub });
    await expect(unwrapTransferDek(n.kWrap, server.slot.ct, other)).rejects.toThrow();

    // The new device enrolls and confirms its key: AD4 done.
    await until(() => text().includes('Finishing on your new device'));
    Object.assign(server.slot, { state: 'enrolled', confN: await transferConfirmMac(n.kConf, n.transcript) });
    await until(() => text().includes('Your Android phone is added'));
    const after = calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(calls.length).toBe(after);
  });

  it('Deny deletes the slot and lands on AD4 · stopped; nothing is approved', async () => {
    await mountApprove({ platform: 'ios' });
    expect(text()).toContain('An iPhone or iPad wants to open your account');

    app.querySelector('#transfer-deny').click();
    await until(() => text().includes('Nobody was added'));
    expect(text()).toContain('You denied the request');
    expect(server.slot.state).toBe('deleted');
    expect(posted('/approve')).toHaveLength(0);
  });

  it('a claim with a bad proof (no TK) is treated as an attacker: AD4 · misuse, no reveal', async () => {
    await mountWaiting();
    await newDeviceClaims({ tk: new Uint8Array(16) });

    await until(() => text().includes('Someone else tried to use this code'));
    expect(text()).toContain('nothing was shared');
    expect(server.slot.state).toBe('deleted');
    expect(posted('/reveal')).toHaveLength(0);
    expect(app.querySelector('#transfer-approve')).toBeNull();
    app.querySelector('#transfer-cancel').click();
    expect(onExit).toHaveBeenCalled();
  });

  it('a receiver swapped after the reveal aborts the pairing — never re-reveal, never approve', async () => {
    const other = await generateTransferKeyPair();
    server.swapAfterReveal = { nPub: other.pub };
    await mountApprove();

    await until(() => text().includes('Someone else tried to use this code'));
    expect(server.slot.state).toBe('deleted');
    expect(posted('/reveal')).toHaveLength(1);
    expect(posted('/approve')).toHaveLength(0);
  });

  it('an approve whose response was lost is reconciled from the next poll, not read as misuse', async () => {
    server.loseApproveResponse = true;
    await mountApprove();
    app.querySelector('#transfer-approve').click();

    await until(() => app.querySelector('#transfer-error').textContent);
    expect(server.slot.state).toBe('approved');
    await until(() => text().includes('Finishing on your new device'));
    expect(text()).not.toContain('Someone else');
    expect(server.slot.state).toBe('approved');
  });

  it('a code that ends after Approve never says "nobody joined" — the device may have enrolled', async () => {
    await mountApprove();
    app.querySelector('#transfer-approve').click();
    await until(() => text().includes('Finishing on your new device'));
    await vi.advanceTimersByTimeAsync(600000);

    await until(() => text().includes("couldn't tell if the new device joined"));
    expect(text()).not.toContain('Nobody joined');
  });

  it('an enrolled device that cannot prove the approved key is flagged, not celebrated', async () => {
    await mountApprove();
    app.querySelector('#transfer-approve').click();
    await until(() => server.slot.state === 'approved');
    Object.assign(server.slot, { state: 'enrolled', confN: new Uint8Array(32) });

    await until(() => text().includes("couldn't confirm the new device"));
    expect(text()).not.toContain('is added');
  });
});

describe('Add a device — Cancel must mean cancelled (med-tuv)', () => {
  it('invalidates the slot server-side before leaving the screen', async () => {
    await mountWaiting();
    app.querySelector('#transfer-cancel').click();

    await until(() => onExit.mock.calls.length > 0);
    expect(server.slot.state).toBe('deleted');
  });

  it('does not navigate away when the cancel fails — that would imply the code is dead', async () => {
    server.deleteStatus = 500;
    await mountWaiting();
    app.querySelector('#transfer-cancel').click();

    await until(() => app.querySelector('#transfer-error').textContent);
    expect(app.querySelector('#transfer-error').textContent).toMatch(/may still work/i);
    expect(onExit).not.toHaveBeenCalled();
    expect(app.querySelector('#transfer-cancel').disabled).toBe(false);
  });

  it('stops polling after a successful cancel', async () => {
    await mountWaiting();
    app.querySelector('#transfer-cancel').click();
    await until(() => onExit.mock.calls.length > 0);

    const after = calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(calls.length).toBe(after);
  });
});

// med-xso6.25: the flow mounts in the app's "Add a device" page, whose Back is
// the controller's cancel() — the same server-side cancel as the Cancel button.
describe('Add a device — host page Back (med-xso6.25)', () => {
  it('cancel() deletes the live slot and resolves true', async () => {
    await mountWaiting();
    await expect(flow.cancel()).resolves.toBe(true);
    expect(server.slot.state).toBe('deleted');
  });

  it('cancel() on the approve screen deletes the slot too', async () => {
    await mountApprove();
    await expect(flow.cancel()).resolves.toBe(true);
    expect(server.slot.state).toBe('deleted');
    expect(posted('/approve')).toHaveLength(0);
  });

  it('cancel() resolves false and shows the error when the delete fails — the page must stay', async () => {
    server.deleteStatus = 500;
    await mountWaiting();
    await expect(flow.cancel()).resolves.toBe(false);
    expect(app.querySelector('#transfer-error').textContent).toMatch(/may still work/i);
  });

  it('stop() from a close that bypassed Back still deletes a live slot', async () => {
    await mountWaiting();
    flow.stop();
    await until(() => server.slot.state === 'deleted');
  });

  // med-e92o / AD4: approved, but the new device never finished (its passkey
  // prompt was cancelled, so no register/finish). The wrapped DEK must not sit
  // on the server until expiry once the origin leaves the screen.
  it('Back after Approve, with the new device unfinished, deletes the slot', async () => {
    await mountApprove();
    app.querySelector('#transfer-approve').click();
    await until(() => text().includes('Finishing on your new device'));
    expect(server.slot.state).toBe('approved');

    await expect(flow.cancel()).resolves.toBe(true);
    expect(server.slot.state).toBe('deleted');
  });

  it('closing the tab after Approve sends a keepalive DELETE (pagehide)', async () => {
    await mountApprove();
    app.querySelector('#transfer-approve').click();
    await until(() => text().includes('Finishing on your new device'));

    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    await until(() => server.slot.state === 'deleted');
    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].keepalive).toBe(true);
  });

  it('pagehide after the new device enrolled sends nothing', async () => {
    const device = await mountApprove();
    app.querySelector('#transfer-approve').click();
    await until(() => server.slot.state === 'approved');
    const n = await newDeviceSeesReveal(device);
    Object.assign(server.slot, { state: 'enrolled', confN: await transferConfirmMac(n.kConf, n.transcript) });
    await until(() => text().includes('Your Android phone is added'));

    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('renders into the mount with no page chrome of its own', async () => {
    await mountWaiting();
    expect(app.querySelector('h1')).toBeNull();
    expect(app.querySelector('#transfer-fallback').closest('.wg-code')).not.toBeNull();
  });
});