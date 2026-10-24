// "Add a device" on the new device — protocol v2 (epic med-r1j2, bead
// med-r1j2.3; docs/cloud-crypto.md "Path B"; screens AD5–AD7). /claim runs
// against real WebCrypto, a fake server that enforces the v2 state machine
// (blind to TK), and a simulated origin built from the same crypto.js helpers
// transfer.js uses — so a passing test means both halves agree byte for byte.
//
// Pure-unit, per the cloud shell's documented exception to repo rule 8. The
// global console guard fails any test that logs, so nothing here may print
// TK, the code or the DEK.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

vi.mock('../crypto.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, unwrapTransferDek: vi.fn(real.unwrapTransferDek) };
});
vi.mock('../unlock.js', () => ({ establishLdkCache: vi.fn(async () => {}) }));
vi.mock('../signup.js', () => ({ renderUnsupportedAuthenticator: vi.fn() }));
vi.mock('../passkey-diag.js', () => ({ diagHttp: (_op, res) => res }));
vi.mock('../passkey-get.js', () => ({
  passkeyCeremony: (_app, _copy, run) => run(),
  createCredential: vi.fn(async () => ({
    rawId: new Uint8Array([9, 9, 9]).buffer,
    toJSON: () => ({ id: 'cred', clientExtensionResults: { prf: { enabled: true } } }),
  })),
  prfProbe: vi.fn(async () => ({
    getClientExtensionResults: () => ({ prf: { results: { first: new Uint8Array(32).fill(5).buffer } } }),
  })),
  iosShellBridge: () => null,
  inAndroidShell: () => false,
}));

import {
  toBase64,
  fromBase64,
  toBase64Url,
  base32Encode,
  timingSafeEqual,
  generateTransferKey,
  transferSlotId,
  encodeTransferCode,
  generateTransferKeyPair,
  transferCommit,
  transferTranscript,
  transferClaimMac,
  transferRevealMac,
  deriveTransferKeys,
  wrapTransferDek,
  unwrapTransferDek,
  transferConfirmMac,
} from '../crypto.js';
import { runClaimFlow } from '../claim.js';
import { createCredential } from '../passkey-get.js';

const ACCOUNT_SUB = 'acct';
const DEK = new Uint8Array(32).fill(7);

let dom;
let app;
let server;
let origin;
let calls;

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// ---- the origin (transfer.js's half), from the shared helpers -------------
async function newOrigin() {
  const tk = generateTransferKey();
  const keyPair = await generateTransferKeyPair();
  const commit = await transferCommit(keyPair.pub);
  const slot = await transferSlotId(tk);
  server.slot = { id: slot, commit, state: 'pending', expiresAt: Date.now() + 600000 };
  return { tk, keyPair, commit, slot };
}

async function originReveals() {
  const s = server.slot;
  const fields = { accountId: ACCOUNT_SUB, slot: s.id, platform: s.platform, commit: origin.commit, nPub: s.nPub };
  expect(timingSafeEqual(await transferClaimMac(origin.tk, fields), s.macN)).toBe(true);
  origin.transcript = transferTranscript({ ...fields, oPub: origin.keyPair.pub });
  origin.keys = await deriveTransferKeys(origin.keyPair.privateKey, s.nPub, origin.transcript);
  Object.assign(s, { state: 'revealed', oPub: origin.keyPair.pub, macO: await transferRevealMac(origin.tk, origin.transcript) });
}

async function originApproves() {
  Object.assign(server.slot, { state: 'approved', ct: await wrapTransferDek(origin.keys.kWrap, DEK, origin.transcript) });
}

// ---- fake server: the v2 state machine, as the new device sees it --------
function installFetch() {
  global.fetch = vi.fn(async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    const headers = init.headers || {};
    calls.push({ method, url: u, body, headers });
    if (server.offline) throw new TypeError('network error');
    // The enrollment token lives only while the slot is approved and unexpired.
    const tokenLive = server.slot.state === 'approved' && Date.now() < server.slot.expiresAt;
    if (u === '/api/webauthn/register/begin') return tokenLive ? json(200, { publicKey: {} }) : json(403, {});
    if (u === '/api/webauthn/register/finish') {
      if (!tokenLive) return json(409, {});
      server.slot.state = 'enrolled';
      return json(200, {});
    }
    const s = server.slot;
    if (!s || u.indexOf(`/api/transfer/${s.id}`) !== 0) return json(410, {});
    if (s.state === 'deleted' || Date.now() >= s.expiresAt) return json(410, {});
    if (u === `/api/transfer/${s.id}/claim` && method === 'POST') {
      if (s.state !== 'pending') return json(409, {});
      Object.assign(s, { state: 'claimed', nPub: fromBase64(body.n_pub), macN: fromBase64(body.mac_n), platform: body.platform, token: 'claim-tok' });
      return json(200, { status: 'claimed', claim_token: 'claim-tok' });
    }
    if (u === `/api/transfer/${s.id}` && method === 'GET') {
      const v = { status: s.state, expires_at: new Date(s.expiresAt).toISOString(), commit: toBase64(s.commit) };
      if (s.state === 'revealed' || s.state === 'approved') Object.assign(v, { o_pub: toBase64(s.oPub), mac_o: toBase64(s.macO) });
      if (s.state === 'approved' && headers['X-Transfer-Token'] === s.token) {
        Object.assign(v, { ct: toBase64(s.ct), enrollment_token: s.token, account_id: 'acct-1' });
      }
      return json(200, v);
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  });
}

const until = (check) => vi.waitFor(() => { if (!check()) throw new Error('not yet'); }, { timeout: 5000 });
const text = () => app.textContent.replace(/\s+/g, ' ');
const posted = (suffix) => calls.filter((c) => c.method === 'POST' && c.url.endsWith(suffix));

function openAt(hash) {
  globalThis.location = { hostname: 'acct.example.test', pathname: '/claim', hash, href: '' };
  return runClaimFlow();
}

const linkHash = () => `#${origin.slot}.${toBase64Url(origin.tk)}`;

beforeEach(async () => {
  vi.useFakeTimers();
  dom = new JSDOM('<!doctype html><main id="app"></main>');
  globalThis.document = dom.window.document;
  globalThis.history = { replaceState: vi.fn() };
  globalThis.PublicKeyCredential = { parseCreationOptionsFromJSON: (o) => o };
  app = dom.window.document.getElementById('app');
  server = { slot: null };
  calls = [];
  installFetch();
  unwrapTransferDek.mockClear();
  createCredential.mockClear();
  origin = await newOrigin();
});

afterEach(() => {
  vi.useRealTimers();
  dom.window.close();
  delete globalThis.document;
  delete globalThis.location;
  delete globalThis.history;
  delete globalThis.fetch;
  delete globalThis.PublicKeyCredential;
});

describe('/claim — AD5: claim with proof of the scan, then the match code', () => {
  it('claims with n_pub, platform and a MAC the origin verifies; keeps the link out of history', async () => {
    await openAt(linkHash());
    await until(() => server.slot.state === 'claimed');

    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/claim');
    const [claim] = posted('/claim');
    expect(Object.keys(claim.body).sort()).toEqual(['mac_n', 'n_pub', 'platform']);
    expect(fromBase64(claim.body.n_pub)).toHaveLength(33);
    expect(claim.body.platform).toBe('web');
    // AD5 · connecting: the slots are drawn, no digits yet.
    expect(app.querySelector('.wg-matchcode--wait')).not.toBeNull();
    expect(text()).toContain('Connecting to your other device');
    await originReveals(); // asserts mac_n under TK
  });

  it('shows the same 6 digits as the origin once it reveals, with the passkey line; no DEK yet', async () => {
    await openAt(linkHash());
    await until(() => server.slot.state === 'claimed');
    await originReveals();
    await until(() => app.querySelector('.wg-matchcode:not(.wg-matchcode--wait)'));

    const digits = app.querySelector('#claim-matchcode').textContent;
    expect(digits).toBe(origin.keys.sas);
    expect(text()).toContain('Waiting for approval');
    expect(text()).toContain('This device gets its own passkey. Your existing passkeys keep working.');
    // Polls identify the claimant.
    const polls = calls.filter((c) => c.method === 'GET').slice(1);
    expect(polls.length).toBeGreaterThan(0);
    expect(polls.every((c) => c.headers['X-Transfer-Token'] === 'claim-tok')).toBe(true);
    expect(unwrapTransferDek).not.toHaveBeenCalled();
  });

  it('accepts the typed 28-letter code without separators, in lower case', async () => {
    await openAt('');
    const input = app.querySelector('#claim-code-input');
    const submit = app.querySelector('#claim-code-submit');
    expect(submit.disabled).toBe(true);
    input.value = encodeTransferCode(origin.tk).replace(/ /g, '').toLowerCase();
    input.dispatchEvent(new dom.window.Event('input'));
    expect(submit.disabled).toBe(false);
    submit.click();

    await until(() => server.slot.state === 'claimed');
    await originReveals();
  });

  it('answers an old (v1) code with "ask for a new code", posting nothing', async () => {
    const v1 = `abcdefghijklmnop.${base32Encode(new Uint8Array(32).fill(1))}`;
    await openAt('');
    const input = app.querySelector('#claim-code-input');
    input.value = v1;
    input.dispatchEvent(new dom.window.Event('input'));
    app.querySelector('#claim-code-submit').click();

    await until(() => text().includes('older version'));
    expect(text()).toContain('Ask for a new code on your other device');
    expect(calls).toEqual([]);
  });

  it('an old (v1) link opens the form with the same answer', async () => {
    await openAt(`#abcdefghijklmnop.${toBase64Url(new Uint8Array(32).fill(1))}`);
    await until(() => text().includes('older version'));
    expect(calls).toEqual([]);
  });
});

describe('/claim — AD6: approval, then this device\'s own passkey', () => {
  it('happy path: decrypts only after approval, registers with conf_n, opens the account', async () => {
    await openAt(linkHash());
    await until(() => server.slot.state === 'claimed');
    await originReveals();
    await until(() => app.querySelector('#claim-matchcode') && !app.querySelector('.wg-matchcode--wait'));
    expect(unwrapTransferDek).not.toHaveBeenCalled();

    await originApproves();
    await until(() => app.querySelector('#claim-enroll'));
    expect(unwrapTransferDek).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Approved on your other device');
    expect(createCredential).not.toHaveBeenCalled(); // the sheet waits for the tap

    app.querySelector('#claim-enroll').click();
    await until(() => location.href === '/');
    const [begin] = posted('/register/begin');
    expect(begin.body.enrollment_token).toBe('claim-tok');
    const expected = await transferConfirmMac(origin.keys.kConf, origin.transcript);
    expect(timingSafeEqual(fromBase64(begin.body.conf_n), expected)).toBe(true);
    expect(posted('/register/finish')).toHaveLength(1);
  });

  it('approval arriving after a poll gap (never saw revealed) still checks the reveal first', async () => {
    await openAt(linkHash());
    await until(() => server.slot.state === 'claimed');
    server.offline = true;
    await originReveals();
    await originApproves();
    await vi.advanceTimersByTimeAsync(6000);
    server.offline = false;

    await until(() => app.querySelector('#claim-enroll'));
    expect(unwrapTransferDek).toHaveBeenCalledTimes(1);
  });

  it('a ciphertext that fails to open ends the flow; nothing is registered', async () => {
    await openAt(linkHash());
    await until(() => server.slot.state === 'claimed');
    await originReveals();
    await originApproves();
    server.slot.ct = new Uint8Array(server.slot.ct.length).fill(1);

    await until(() => app.querySelector('#claim-untrusted'));
    expect(posted('/register/begin')).toEqual([]);
  });

  it('a reveal whose key does not match the commit is refused before any code shows', async () => {
    await openAt(linkHash());
    await until(() => server.slot.state === 'claimed');
    await originReveals();
    const other = await generateTransferKeyPair();
    server.slot.oPub = other.pub;

    await until(() => app.querySelector('#claim-untrusted'));
    expect(app.querySelector('#claim-matchcode')).toBeNull();
    expect(unwrapTransferDek).not.toHaveBeenCalled();
  });
});

// bd med-r1j2.10: the in-app Scan, through window.MediaCapture / window.Barcode
// (stubbed here; CLAUDE.md rule 10). AD13 when the camera is off.
describe('/claim — in-app Scan and AD13 (camera off)', () => {
  const denied = () => Object.assign(new Error('denied'), { name: 'MediaCaptureError', code: 'PERMISSION_DENIED' });
  let stopped;

  function installCamera({ open, decoded = [] } = {}) {
    stopped = 0;
    const stream = { getTracks: () => [{ stop: () => { stopped++; } }] };
    globalThis.MediaCapture = {
      openCameraStream: vi.fn(open || (async () => stream)),
      openSettings: vi.fn(async () => ({ opened: false, hint: 'Allow the camera for this site in your browser settings, then reload.' })),
    };
    globalThis.Barcode = {
      supportsLiveScan: () => true,
      scan: vi.fn(async () => (decoded.length ? { format: 'qr_code', rawValue: decoded.shift() } : null)),
    };
    dom.window.HTMLMediaElement.prototype.play = vi.fn(async () => {});
  }

  function scanAt(hash) {
    globalThis.location = { hostname: 'acct.example.test', host: 'acct.example.test', protocol: 'https:', pathname: '/claim', hash, href: '' };
    return runClaimFlow();
  }

  afterEach(() => {
    delete globalThis.MediaCapture;
    delete globalThis.Barcode;
  });

  it('camera denied: AD13 — the typed code field, Allow camera in Settings, and a typed code claims', async () => {
    installCamera({ open: async () => { throw denied(); } });
    await scanAt('#scan');
    await until(() => app.querySelector('#claim-camera-off'));

    expect(text()).toContain('Scan code');
    expect(text()).toContain('The camera is off for this app');
    expect(text()).toContain('Type the code shown under the QR on your other device instead.');
    expect(app.querySelector('label[for="claim-code-input"]').textContent).toBe('Code for a computer');
    expect(app.querySelector('.wg-pagefoot #claim-code-submit')).not.toBeNull();
    expect(globalThis.Barcode.scan).not.toHaveBeenCalled();

    // The ghost link: no shell to open Settings here, so it says where.
    app.querySelector('#claim-camera-settings').click();
    await until(() => app.querySelector('#claim-camera-hint'));
    expect(globalThis.MediaCapture.openSettings).toHaveBeenCalledTimes(1);
    expect(app.querySelector('#claim-camera-hint').textContent).toContain('browser settings');

    const input = app.querySelector('#claim-code-input');
    const submit = app.querySelector('#claim-code-submit');
    expect(submit.disabled).toBe(true);
    input.value = encodeTransferCode(origin.tk);
    input.dispatchEvent(new dom.window.Event('input'));
    expect(submit.disabled).toBe(false);
    submit.click();
    await until(() => server.slot.state === 'claimed');
    await originReveals();
  });

  it('no camera or decoder at all: the same typed code, without the Settings link', async () => {
    await scanAt('#scan'); // no MediaCapture / Barcode installed
    await until(() => app.querySelector('#claim-camera-off'));
    expect(text()).toContain("Scanning isn't available here");
    expect(app.querySelector('#claim-code-input')).not.toBeNull();
    expect(app.querySelector('#claim-camera-settings')).toBeNull();
  });

  it('AD7 "Scan a new code" scans this account\'s QR, releases the camera and claims', async () => {
    server.slot.state = 'deleted';
    await openAt(linkHash());
    await until(() => app.querySelector('#claim-ended'));
    const sun = app.querySelector('#claim-new-code');
    expect(sun.textContent).toBe('Scan a new code');
    expect(sun.className).toContain('wg-btn--primary');

    origin = await newOrigin();
    installCamera({ decoded: ['not an add-device code', `https://example.test/d/acct${linkHash()}`] });
    globalThis.location = { hostname: 'acct.example.test', host: 'acct.example.test', protocol: 'https:', pathname: '/claim', hash: '', href: '' };
    sun.click();
    await vi.advanceTimersByTimeAsync(500);
    await until(() => server.slot.state === 'claimed');
    expect(stopped).toBe(1);
    expect(globalThis.Barcode.scan).toHaveBeenCalledWith(expect.objectContaining({ formats: ['qr_code'] }));
    await originReveals();
  });

  // In a shell, navigation off this account host would open the system
  // browser: the switch goes through account.leave {url}.
  it('in a shell, another account\'s QR switches via account.leave {url}', async () => {
    const call = vi.fn(async () => null);
    globalThis.LocalNotifications = { __native: { platform: 'ios', call } };
    try {
      installCamera({ decoded: [`https://example.test/d/other${linkHash()}`] });
      await scanAt('#scan');
      await until(() => call.mock.calls.length > 0);
      expect(call).toHaveBeenCalledWith('account.leave', { url: `https://other.example.test/claim${linkHash()}` });
      expect(globalThis.location.href).toBe('');
      expect(calls).toEqual([]);
    } finally {
      delete globalThis.LocalNotifications;
    }
  });

  it('in a shell without account.leave {url}, the form says so and nothing navigates', async () => {
    const call = vi.fn(async () => { throw new Error('unsupported: account.leave'); });
    globalThis.LocalNotifications = { __native: { platform: 'android', call } };
    try {
      installCamera({ decoded: [`https://example.test/d/other${linkHash()}`] });
      await scanAt('#scan');
      await until(() => text().includes('This code is for another account'));
      expect(app.querySelector('#claim-code-input')).not.toBeNull();
      expect(globalThis.location.href).toBe('');
      expect(calls).toEqual([]);
    } finally {
      delete globalThis.LocalNotifications;
    }
  });

  it('on the web, another account\'s QR opens that account\'s /claim', async () => {
    installCamera({ decoded: [`medtracker://d/other${linkHash()}`] });
    await scanAt('#scan');
    await until(() => globalThis.location.href !== '');
    expect(globalThis.location.href).toBe(`https://other.example.test/claim${linkHash()}`);
    expect(calls).toEqual([]);
  });
});

describe('/claim — AD7: end states', () => {
  it('409 on claim: the code was already used', async () => {
    server.slot.state = 'claimed'; // someone else claimed between our GET and POST
    const realFetch = global.fetch;
    let first = true;
    global.fetch = vi.fn(async (url, init) => {
      if (first && (!init || !init.method)) {
        first = false;
        return json(200, { status: 'pending', expires_at: new Date(server.slot.expiresAt).toISOString(), commit: toBase64(origin.commit) });
      }
      return realFetch(url, init);
    });
    await openAt(linkHash());

    await until(() => app.querySelector('#claim-used'));
    expect(text()).toContain('This code was already used');
    expect(text()).toContain('Ask for a new code on your other device');
  });

  it('410 while waiting (denied / cancelled): the code no longer works', async () => {
    await openAt(linkHash());
    await until(() => server.slot.state === 'claimed');
    await originReveals();
    await until(() => app.querySelector('#claim-matchcode') && !app.querySelector('.wg-matchcode--wait'));
    server.slot.state = 'deleted';

    await until(() => app.querySelector('#claim-ended'));
    expect(text()).toContain('This code no longer works');
    expect(text()).toContain('Stopped');
    expect(unwrapTransferDek).not.toHaveBeenCalled();
  });

  it('stopped on the origin after approval: the passkey step ends, and a new code can be entered', async () => {
    await openAt(linkHash());
    await until(() => server.slot.state === 'claimed');
    await originReveals();
    await originApproves();
    await until(() => app.querySelector('#claim-enroll'));
    server.slot.state = 'deleted';

    app.querySelector('#claim-enroll').click();
    await until(() => app.querySelector('#claim-ended'));
    expect(text()).toContain('Stopped');
    expect(app.querySelector('#claim-enroll')).toBeNull();
    expect(posted('/register/finish')).toEqual([]);

    app.querySelector('#claim-new-code').click();
    expect(app.querySelector('#claim-code-input')).not.toBeNull();
  });

  it('expired after approval: the passkey step says Expired instead of retrying', async () => {
    await openAt(linkHash());
    await until(() => server.slot.state === 'claimed');
    await originReveals();
    await originApproves();
    await until(() => app.querySelector('#claim-enroll'));
    await vi.advanceTimersByTimeAsync(601000);

    app.querySelector('#claim-enroll').click();
    await until(() => app.querySelector('#claim-ended'));
    expect(text()).toContain('Expired');
  });

  it('local expiry while waiting says Expired', async () => {
    await openAt(linkHash());
    await until(() => server.slot.state === 'claimed');
    await vi.advanceTimersByTimeAsync(601000);

    await until(() => app.querySelector('#claim-ended'));
    expect(text()).toContain('Expired');
  });
});
