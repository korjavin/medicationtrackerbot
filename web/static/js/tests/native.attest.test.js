/**
 * native.attest.test.js
 *
 * window.Attest (bd med-o7zq.16): unsupported on web, the three attest ops
 * inside the iOS shell (the wgNative reply handler present), answered by
 * ios/App/Attest.swift. Platform selection itself is pinned in
 * native.local-notifications.test.js.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE = path.resolve(__dirname, '../native');

let dom;
afterEach(() => { if (dom) dom.window.close(); dom = null; });

function load({ reply } = {}) {
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://acct.example.test/', runScripts: 'outside-only' });
    const w = dom.window;
    const sent = [];
    if (reply) w.webkit = { messageHandlers: { wgNative: { postMessage: (m) => { sent.push(m); return reply(m); } } } };
    for (const f of ['index.js', 'attest.js']) w.eval(fs.readFileSync(path.join(NATIVE, f), 'utf8'));
    return { w, sent };
}

describe('native/attest.js', () => {
    it('stub throws NotImplementedError before the impl loads', () => {
        dom = new JSDOM('', { runScripts: 'outside-only' });
        dom.window.eval(fs.readFileSync(path.join(NATIVE, 'index.js'), 'utf8'));
        expect(() => dom.window.Attest.isSupported()).toThrow(/window\.Attest\.isSupported/);
    });

    it('web: unsupported, with no op that could reach the bridge', () => {
        const { w } = load();
        expect(w.Attest.isSupported()).toBe(false);
        expect(w.Attest.status).toBeUndefined();
        expect(w.Attest.enroll).toBeUndefined();
        expect(w.Attest.assert).toBeUndefined();
        expect(w.Attest.setPass).toBeUndefined();
    });

    it('ios: status, enroll, assert and setPass are plain round trips to the shell', async () => {
        const replies = {
            'attest.status': { supported: true, base: 'example.test', attested: false },
            'attest.enroll': { keyId: 'K', attestation: 'QQ==', deviceToken: 'RA==', pass: 'B.c2VjcmV0' },
            'attest.setPass': null,
            'attest.assert': { keyId: 'K', assertion: 'Uw==' },
        };
        const { w, sent } = load({ reply: (m) => Promise.resolve(replies[m.op]) });
        expect(w.Attest.isSupported()).toBe(true);
        await expect(w.Attest.status()).resolves.toEqual(replies['attest.status']);
        await expect(w.Attest.enroll('Q0g=')).resolves.toEqual(replies['attest.enroll']);
        await expect(w.Attest.assert('Q0g=', 'RA==')).resolves.toEqual(replies['attest.assert']);
        await expect(w.Attest.setPass('B.c2VjcmV0')).resolves.toBeNull();
        expect(JSON.parse(JSON.stringify(sent))).toEqual([
            { op: 'attest.status', args: {} },
            { op: 'attest.enroll', args: { challenge: 'Q0g=' } },
            { op: 'attest.assert', args: { challenge: 'Q0g=', bodySha256: 'RA==' } },
            { op: 'attest.setPass', args: { pass: 'B.c2VjcmV0' } },
        ]);
    });

    it('ios: a locked shell rejects every op', async () => {
        const { w } = load({ reply: () => Promise.reject(new Error('locked')) });
        await expect(w.Attest.status()).rejects.toThrow('locked');
        await expect(w.Attest.assert('Q0g=', 'RA==')).rejects.toThrow('locked');
    });

    it('ios: no consent-copy override (trial-consent.js keeps its iOS text)', () => {
        const { w } = load({ reply: () => Promise.resolve(null) });
        expect(w.Attest.copy).toBeUndefined();
    });
});

// bd med-nt9p.32.8.4: the Android shell's WebMessageListener (window.wgNative),
// answered by android/.../Attest.kt in local mode — the fake answers like
// MainActivity.kt onBridge, by id.
function loadAndroid(replies) {
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://appassets.androidplatform.net/', runScripts: 'outside-only' });
    const w = dom.window;
    const sent = [];
    const bridge = new w.EventTarget();
    bridge.postMessage = (data) => {
        const msg = JSON.parse(data);
        sent.push(msg);
        const reply = msg.op in replies ? { id: msg.id, result: replies[msg.op] } : { id: msg.id, error: 'unsupported: ' + msg.op };
        setTimeout(() => bridge.dispatchEvent(new w.MessageEvent('message', { data: JSON.stringify(reply) })), 0);
    };
    w.wgNative = bridge;
    for (const f of ['index.js', 'attest.js']) w.eval(fs.readFileSync(path.join(NATIVE, f), 'utf8'));
    return { w, sent };
}

describe('native/attest.js on android', () => {
    it('the same four ops over the bridge, with the Play Integrity enroll reply', async () => {
        const replies = {
            'attest.status': { supported: true, base: 'example.test', attested: false },
            'attest.enroll': { kind: 'android', keyId: 'a2V5', publicKey: 'UEs=', integrityToken: 'play.token', pass: 'B.c2VjcmV0' },
            'attest.setPass': null,
            'attest.assert': { keyId: 'a2V5', assertion: 'AAAAAVM=' },
        };
        const { w, sent } = loadAndroid(replies);
        expect(w.Attest.__native.platform).toBe('android');
        expect(w.Attest.isSupported()).toBe(true);
        await expect(w.Attest.status()).resolves.toEqual(replies['attest.status']);
        await expect(w.Attest.enroll('Q0g=')).resolves.toEqual(replies['attest.enroll']);
        await expect(w.Attest.assert('Q0g=', 'RA==')).resolves.toEqual(replies['attest.assert']);
        await expect(w.Attest.setPass('')).resolves.toBeNull();
        expect(sent.map((m) => [m.op, m.args])).toEqual([
            ['attest.status', {}],
            ['attest.enroll', { challenge: 'Q0g=' }],
            ['attest.assert', { challenge: 'Q0g=', bodySha256: 'RA==' }],
            ['attest.setPass', { pass: '' }],
        ]);
    });

    it('an account page (not local mode) gets unsupported: the trial reads that as no attest', async () => {
        const { w } = loadAndroid({});
        await expect(w.Attest.status()).rejects.toThrow('unsupported: attest.status');
    });

    it('carries the Android consent copy: Play Integrity, never Apple or the iPhone', () => {
        const { w } = loadAndroid({});
        const transit = w.Attest.copy.trialTransit;
        expect(transit).toMatch(/Google Play Integrity/);
        expect(transit).toMatch(/Android Keystore/);
        expect(transit).toMatch(/each call uses its full length limit when it starts/);
        expect(transit).not.toMatch(/iPhone|Apple|App Attest|DeviceCheck|keychain/i);
        expect(transit).not.toMatch(/\d+ (free )?minutes/);
    });
});
