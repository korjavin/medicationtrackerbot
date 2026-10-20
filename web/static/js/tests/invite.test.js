/**
 * invite.test.js — the F1 invite parser (features/invite.js
 * window.InviteSheet.parse, bd med-ta2n.6) against the cross-platform vectors.
 *
 * THE canonical set is `inviteVectors` in ios/Tests/main.swift (contract
 * med-ta2n.7 §5 / A2): read from that file, never copied, so iOS, Android and
 * the web cannot drift. Add a vector there first. The sheet's own behaviour
 * (paste, scan, gates, hand-off) is in cloud.local-mode.test.js "F1 invite sheet".
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');

function inviteVectors() {
    const swift = fs.readFileSync(path.join(REPO_ROOT, 'ios/Tests/main.swift'), 'utf8');
    const block = swift.match(/let inviteVectors: \[\(String, String\)\] = \[([\s\S]*?)\n\]/);
    if (!block) throw new Error('inviteVectors not found in ios/Tests/main.swift');
    return [...block[1].matchAll(/\("((?:[^"\\]|\\.)*)", "((?:[^"\\]|\\.)*)"\)/g)].map((m) => [m[1], m[2]]);
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test/', runScripts: 'outside-only' });
dom.window.eval(fs.readFileSync(path.join(REPO_ROOT, 'web/static/js/features/invite.js'), 'utf8'));
const { parse } = dom.window.InviteSheet;
const url = (raw, base) => (parse(raw, base) || {}).claimUrl || '';
afterAll(() => dom.window.close());

describe('InviteSheet.parse', () => {
    const vectors = inviteVectors();

    it('reads the shared vector set', () => {
        expect(vectors.length).toBeGreaterThanOrEqual(40);
    });

    it.each(vectors)('%j → %j (base app.example.com)', (input, want) => {
        expect(url(input, 'app.example.com')).toBe(want);
    });

    it('names the account', () => {
        expect(parse('https://app.example.com/i/My-Sub#00ff', 'app.example.com')).toEqual({
            claimUrl: 'https://my-sub.app.example.com/#claim=00ff', sub: 'my-sub',
        });
    });

    it('reads the first line of an Emergency Kit QR', () => {
        expect(url('https://abc.app.example.com\nacct-id\nRECOVERY CODE', 'app.example.com')).toBe('https://abc.app.example.com/');
    });

    // No base (the web page could not ask the shell): shape only; the shell's
    // local.leave {url} is the host gate.
    it('without a base checks the shape only', () => {
        expect(url('https://app.example.com/i/abc#0a1b2c')).toBe('https://abc.app.example.com/#claim=0a1b2c');
        expect(url('https://abc.app.example.com/#claim=0a1b2c&kit=1')).toBe('https://abc.app.example.com/#claim=0a1b2c&kit=1');
        expect(url('medtracker://i/abc#0a1b2c')).toBe(''); // no base to build the claim host from
        expect(url('https://example.com/#claim=0a1b2c')).toBe(''); // a base, not an account
        expect(url('https://app.example.com:8443/i/abc#0a1b2c')).toBe('');
        expect(url('https://u@app.example.com/i/abc#0a1b2c')).toBe('');
        expect(url('https://app.example.com/i/abc#0A1B')).toBe('');
        expect(url('https://app.example.com/i/abc?#0a1b')).toBe('');
        expect(url('')).toBe('');
        expect(url(null)).toBe('');
    });
});
