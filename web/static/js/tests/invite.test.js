/**
 * invite.test.js — the F1 invite parser (features/invite.js
 * window.InviteSheet.parse, bd med-ta2n.6) against the cross-platform vectors.
 *
 * THE canonical set is `inviteVectors` in ios/Tests/main.swift (contract
 * med-ta2n.7 §5 / A2): read from that file, never copied, so iOS, Android and
 * the web cannot drift. Add a vector there first. The sheet's own behaviour
 * (paste, scan, gates, hand-off) is in cloud.local-mode.test.js "F1 invite sheet".
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

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

// bd med-ta2n.7: an invite reaching a shell that is in ACCOUNT mode (no
// :root.wg-local-vault) → the "Switch account?" D1. Switch = account.leave
// {url} (the shell drops the move stash, A1); Keep this account = invite.clear.
describe('InviteSheet.boot in account mode — "Switch account?"', () => {
    const CLAIM = 'https://abc.app.example.com/#claim=0a1b2c';
    let env;
    let call;
    let ops;

    beforeEach(() => {
        env = loadFrontendEnv();
        ops = ['shell.ops', 'account.leave', 'move.take', 'move.clear', 'invite.pending', 'invite.clear'];
        call = vi.fn(async (op) => {
            if (op === 'shell.ops') return ops;
            if (op === 'invite.pending') return { url: CLAIM, receivedAt: Date.now() };
            return true;
        });
        env.window.LocalNotifications = {
            ...env.window.LocalNotifications,
            copy: { os: 'Android', device: 'phone' },
            __native: { platform: 'android', call, has: vi.fn(async (op) => ops.includes(op)) },
        };
    });
    afterEach(() => env.cleanup());

    const dialog = (document) => vi.waitFor(() => {
        const d = document.querySelector('mt-modal.mt-confirm-modal');
        if (!d) throw new Error('no dialog');
        return d;
    });

    it('shows the facts with Keep this account raised and Switch as a danger outline; Switch → account.leave {url}', async () => {
        const { window, document } = env;
        await window.InviteSheet.boot();
        const d = await dialog(document);
        expect(d.textContent).toMatch(/Switch account\?/);
        expect(d.textContent).toContain(`This phone leaves ${window.location.hostname}. Your records stay on the server for your other devices.`);
        expect(d.textContent).toMatch(/The invite opens a new, empty account/);
        expect(d.textContent).toMatch(/Nothing is copied across/);
        const keep = d.querySelector('.mt-confirm-modal__cancel');
        const sw = d.querySelector('.mt-confirm-modal__confirm');
        expect(keep.textContent).toBe('Keep this account');
        expect(keep.classList.contains('wg-btn--ghost')).toBe(false);
        expect(sw.textContent).toBe('Switch');
        expect(sw.classList.contains('wg-btn--danger-ghost')).toBe(true);
        sw.click();
        await vi.waitFor(() => expect(call).toHaveBeenCalledWith('account.leave', { url: CLAIM }));
        expect(call).not.toHaveBeenCalledWith('invite.clear');
        expect(document.getElementById('invite-sync-sheet')).toBeNull();
    });

    it('Keep this account → invite.clear, no leave', async () => {
        const { window, document } = env;
        await window.InviteSheet.boot();
        (await dialog(document)).querySelector('.mt-confirm-modal__cancel').click();
        await vi.waitFor(() => expect(call).toHaveBeenCalledWith('invite.clear'));
        expect(call.mock.calls.map(([op]) => op)).not.toContain('account.leave');
    });

    it('offline at Switch → error toast, no leave, the slot kept', async () => {
        const { window, document } = env;
        window.safeToast = vi.fn();
        Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });
        await window.InviteSheet.boot();
        (await dialog(document)).querySelector('.mt-confirm-modal__confirm').click();
        await vi.waitFor(() => expect(window.safeToast).toHaveBeenCalledWith(expect.stringMatching(/You're offline/), 'error'));
        expect(call.mock.calls.map(([op]) => op)).not.toContain('account.leave');
        expect(call).not.toHaveBeenCalledWith('invite.clear');
    });

    it('a pre-v3 shell (no invite.pending): no slot read, no dialog', async () => {
        const { window, document } = env;
        ops = ['shell.ops', 'account.leave'];
        await window.InviteSheet.boot();
        expect(call).not.toHaveBeenCalledWith('invite.pending');
        expect(document.querySelector('mt-modal.mt-confirm-modal')).toBeNull();
    });

    it('the web: boot is null and nothing is asked', () => {
        env.window.LocalNotifications = { ...env.window.LocalNotifications, __native: { platform: 'web', call, has: async () => false } };
        expect(env.window.InviteSheet.boot()).toBeNull();
        expect(call).not.toHaveBeenCalled();
    });
});
