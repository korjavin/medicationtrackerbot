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
    });

    it('ios: status, enroll and assert are plain round trips to the shell', async () => {
        const replies = {
            'attest.status': { supported: true, base: 'example.test', attested: false },
            'attest.enroll': { keyId: 'K', attestation: 'QQ==', deviceToken: 'RA==' },
            'attest.assert': { keyId: 'K', assertion: 'Uw==' },
        };
        const { w, sent } = load({ reply: (m) => Promise.resolve(replies[m.op]) });
        expect(w.Attest.isSupported()).toBe(true);
        await expect(w.Attest.status()).resolves.toEqual(replies['attest.status']);
        await expect(w.Attest.enroll('Q0g=')).resolves.toEqual(replies['attest.enroll']);
        await expect(w.Attest.assert('Q0g=', 'RA==')).resolves.toEqual(replies['attest.assert']);
        expect(JSON.parse(JSON.stringify(sent))).toEqual([
            { op: 'attest.status', args: {} },
            { op: 'attest.enroll', args: { challenge: 'Q0g=' } },
            { op: 'attest.assert', args: { challenge: 'Q0g=', bodySha256: 'RA==' } },
        ]);
    });

    it('ios: a locked shell rejects every op', async () => {
        const { w } = load({ reply: () => Promise.reject(new Error('locked')) });
        await expect(w.Attest.status()).rejects.toThrow('locked');
        await expect(w.Attest.assert('Q0g=', 'RA==')).rejects.toThrow('locked');
    });
});
