// bd med-jb7.3 — cloud mode's "a new version is available" prompt. Bot mode gets
// this from the service worker's onupdatefound; cloud opts out of that path, so
// it compares the build id in the served index.html against GET /api/version.
//
// The environment is node (vitest.config.mjs), so we build a real jsdom document
// per test and inject it — which also means importing this module here starts
// nothing: its auto-start guard reads the global `document`, which is undefined.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import { bootBuildID, fetchServerBuildID, renderUpdateBanner, startUpdateCheck } from '../update-check.js';

function setup({ booted = '20260710-1000' } = {}) {
    const meta = booted ? `<meta name="medtracker-build-id" content="${booted}">` : '';
    const dom = new JSDOM(`<!doctype html><html><head>${meta}</head><body></body></html>`);
    const doc = dom.window.document;
    // A detached JSDOM has no browsing context, so its visibilityState is
    // 'prerender', never 'visible'. The production guard only re-checks on a
    // real foreground, so the test has to supply one.
    Object.defineProperty(doc, 'visibilityState', { value: 'visible', configurable: true });
    const win = {
        addEventListener: vi.fn(),
        setInterval: vi.fn(() => 42),
        clearInterval: vi.fn(),
        location: { reload: vi.fn() },
    };
    const foreground = () => doc.dispatchEvent(new dom.window.Event('visibilitychange'));
    return { doc, win, foreground };
}

const serving = (build_id, ok = true) => vi.fn().mockResolvedValue({ ok, json: async () => ({ build_id }) });

// Lets the promise chain inside startUpdateCheck's fire-and-forget check() settle.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('bootBuildID', () => {
    it('reads the meta tag injectCloudBoot writes', () => {
        const { doc } = setup({ booted: '20260710-1432' });
        expect(bootBuildID(doc)).toBe('20260710-1432');
    });

    it('is empty when no meta tag is present', () => {
        const { doc } = setup({ booted: '' });
        expect(bootBuildID(doc)).toBe('');
    });
});

describe('fetchServerBuildID', () => {
    it('asks /api/version with no-store and returns the id', async () => {
        const fetchImpl = serving('20260710-1500');
        await expect(fetchServerBuildID(fetchImpl)).resolves.toBe('20260710-1500');
        expect(fetchImpl).toHaveBeenCalledWith('/api/version', { cache: 'no-store' });
    });

    it('throws on a non-2xx so the caller can stay quiet', async () => {
        await expect(fetchServerBuildID(serving('x', false))).rejects.toThrow('/api/version');
    });
});

describe('startUpdateCheck', () => {
    let showBanner;
    beforeEach(() => {
        showBanner = vi.fn();
    });

    it('prompts when the server is serving a different build', async () => {
        const { doc, win } = setup({ booted: '20260710-1000' });
        startUpdateCheck({ doc, win, fetchImpl: serving('20260710-1500'), showBanner });
        await flush();
        expect(showBanner).toHaveBeenCalledOnce();
    });

    it('stays quiet when the server build matches', async () => {
        const { doc, win } = setup({ booted: '20260710-1000' });
        startUpdateCheck({ doc, win, fetchImpl: serving('20260710-1000'), showBanner });
        await flush();
        expect(showBanner).not.toHaveBeenCalled();
    });

    it('stays quiet on an unstamped dev tree rather than prompting every `go run`', async () => {
        const { doc, win } = setup({ booted: 'dev' });
        const fetchImpl = serving('20260710-1500');
        startUpdateCheck({ doc, win, fetchImpl, showBanner });
        await flush();
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(showBanner).not.toHaveBeenCalled();
        expect(win.setInterval).not.toHaveBeenCalled();
    });

    it('stays quiet when offline — a failed poll is not an update', async () => {
        const { doc, win } = setup();
        const fetchImpl = vi.fn().mockRejectedValue(new TypeError('network'));
        startUpdateCheck({ doc, win, fetchImpl, showBanner });
        await flush();
        expect(showBanner).not.toHaveBeenCalled();
    });

    // The whole point of the bead: the installed PWA that is RESUMED, not
    // relaunched. iOS never fires load again, so boot-time checks alone miss it.
    it('re-checks when the app returns to the foreground', async () => {
        const { doc, win, foreground } = setup();
        const fetchImpl = serving('20260710-1000'); // same build at boot
        startUpdateCheck({ doc, win, fetchImpl, showBanner });
        await flush();
        expect(showBanner).not.toHaveBeenCalled();

        fetchImpl.mockResolvedValue({ ok: true, json: async () => ({ build_id: '20260710-1500' }) });
        foreground();
        await flush();
        expect(showBanner).toHaveBeenCalledOnce();

        expect(win.addEventListener).toHaveBeenCalledWith('focus', expect.any(Function));
        expect(win.setInterval).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);
    });

    it('does not poll while the app is backgrounded', async () => {
        const { doc, win } = setup();
        Object.defineProperty(doc, 'visibilityState', { value: 'hidden', configurable: true });
        const fetchImpl = serving('20260710-1000');
        startUpdateCheck({ doc, win, fetchImpl, showBanner });
        await flush();
        fetchImpl.mockClear();

        doc.dispatchEvent(new doc.defaultView.Event('visibilitychange'));
        await flush();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('prompts at most once, however many times it re-checks', async () => {
        const { doc, win, foreground } = setup();
        startUpdateCheck({ doc, win, fetchImpl: serving('20260710-1500'), showBanner });
        await flush();
        foreground();
        await flush();
        expect(showBanner).toHaveBeenCalledOnce();
    });

    it('stop() clears the poll timer', () => {
        const { doc, win } = setup();
        startUpdateCheck({ doc, win, fetchImpl: serving('20260710-1000'), showBanner })();
        expect(win.clearInterval).toHaveBeenCalledWith(42);
    });
});

describe('renderUpdateBanner', () => {
    it('reloads only when the user asks, and reuses the shared toast classes', () => {
        const { doc } = setup();
        const onReload = vi.fn();
        renderUpdateBanner(doc, onReload);

        const toast = doc.getElementById('cloud-update-toast');
        expect(toast.className).toBe('pwa-update-toast');
        expect(toast.textContent).toContain('A new version is available.');
        expect(onReload).not.toHaveBeenCalled(); // never reload out from under a user

        doc.getElementById('cloud-update-reload').click();
        expect(onReload).toHaveBeenCalledOnce();
    });

    it('"Later" removes the banner without reloading', () => {
        const { doc } = setup();
        const onReload = vi.fn();
        const onDismiss = vi.fn();
        renderUpdateBanner(doc, onReload, onDismiss);

        doc.getElementById('cloud-update-dismiss').click();
        expect(doc.getElementById('cloud-update-toast')).toBeNull();
        expect(onDismiss).toHaveBeenCalledOnce();
        expect(onReload).not.toHaveBeenCalled();
    });

    it('sets no inline styles (CLAUDE.md rule 3)', () => {
        const { doc } = setup();
        renderUpdateBanner(doc, () => {});
        expect(doc.getElementById('cloud-update-toast').getAttribute('style')).toBeNull();
    });
});
