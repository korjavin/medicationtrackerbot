// bd med-jb7.3 — cloud mode's "a new version is available" prompt. Bot mode gets
// this from the service worker's onupdatefound; cloud opts out of that path, so
// it compares the build id in the served index.html against GET /api/version.
//
// The environment is node (vitest.config.mjs), so we build a real jsdom document
// per test and inject it — which also means importing this module here starts
// nothing: its auto-start guard reads the global `document`, which is undefined.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import { bootBuildID, fetchServerBuildID, renderUpdateBanner, showUpdateBanner, startUpdateCheck, reloadProviderDocument } from '../update-check.js';
import { maskPath, startLifecycleDiag } from '../passkey-diag.js';

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
        setTimeout: vi.fn(),
        location: { reload: vi.fn() },
    };
    const foreground = () => doc.dispatchEvent(new dom.window.Event('visibilitychange'));
    return { doc, win, foreground };
}

const serving = (build_id, ok = true) => vi.fn().mockResolvedValue({ ok, json: async () => ({ build_id }) });

// Lets the promise chain inside startUpdateCheck's fire-and-forget check() settle.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('explicit provider document freshness handoff', () => {
    afterEach(() => vi.useRealTimers());
    function environment() {
        const dom = new JSDOM('<html></html>');
        const serviceWorker = new dom.window.EventTarget();
        const win = { document: dom.window.document, CustomEvent: dom.window.CustomEvent,
            navigator: { serviceWorker }, location: { href: 'https://account.example/?ordinary=1#settings', replace: vi.fn(), reload: vi.fn() } };
        const worker = (supports, onActivate) => {
            const instance = new dom.window.EventTarget();
            instance.state = 'installed';
            instance.postMessage = vi.fn((message, ports) => {
                if (message.type === 'PROVIDER_RELOAD_CAPABILITY' && supports) ports[0].postMessage({ type: message.type, version: 1 });
                if (message.type === 'SKIP_WAITING') onActivate?.();
            });
            return instance;
        };
        const change = (controller) => { serviceWorker.controller = controller; serviceWorker.dispatchEvent(new dom.window.Event('controllerchange')); };
        let operation;
        // Unit seam only; owning cloud-boot tests exercise the actual handler.
        win.document.addEventListener('wg:provider-reload-activation', (event) => { operation = event.detail.operation; event.detail.accepted = true; });
        serviceWorker.addEventListener('controllerchange', () => operation?.claim());
        return { win, worker, serviceWorker, change, dom };
    }

    it('uses the actual supporting controller, then one content-free marked root navigation', async () => {
        const { win, worker, serviceWorker, dom } = environment();
        serviceWorker.controller = worker(true);
        const guard = vi.fn(async () => true);
        expect(await reloadProviderDocument({ win, beforeNavigate: guard })).toBe(true);
        expect(guard).toHaveBeenCalledOnce();
        expect(win.location.replace).toHaveBeenCalledExactlyOnceWith('https://account.example/?__wg_provider_reload=1');
        expect(win.location.reload).not.toHaveBeenCalled();
        dom.window.close();
    });

    it.each([false, true])('old controller: awaits real supported handoff even when control changes during the old probe (%s)', async (delayed) => {
        const { win, worker, serviceWorker, change, dom } = environment();
        serviceWorker.controller = worker(false);
        const next = worker(true, () => { if (delayed) setTimeout(() => change(next), 20); else change(next); });
        next.state = 'installing';
        const registration = { installing: next, waiting: null, update: vi.fn(async () => {}) };
        serviceWorker.getRegistration = vi.fn(async () => registration);
        const running = reloadProviderDocument({ win, onCommit: () => true });
        await vi.waitFor(() => expect(registration.update).toHaveBeenCalledOnce());
        expect(win.location.replace).not.toHaveBeenCalled();
        next.state = 'installed'; registration.waiting = next;
        next.dispatchEvent(new dom.window.Event('statechange'));
        expect(await running).toBe(true);
        expect(serviceWorker.controller).toBe(next);
        expect(next.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
        expect(win.location.replace).toHaveBeenCalledOnce();
        expect(win.location.reload).not.toHaveBeenCalled();
        dom.window.close();
    });

    it.each(['update', 'install', 'unsupported'])('fails closed for %s preparation failure without a stale timed reload', async (failure) => {
        vi.useFakeTimers();
        const { win, worker, serviceWorker, dom } = environment();
        serviceWorker.controller = worker(false);
        const candidate = worker(failure !== 'unsupported');
        candidate.state = failure === 'install' ? 'redundant' : 'installed';
        const registration = { installing: candidate, waiting: failure === 'install' ? null : candidate,
            update: failure === 'update' ? vi.fn(async () => { throw new Error('offline'); }) : vi.fn(async () => {}) };
        serviceWorker.getRegistration = vi.fn(async () => registration);
        const running = reloadProviderDocument({ win });
        await vi.advanceTimersByTimeAsync(21000);
        expect(await running).toBe(false);
        expect(win.location.replace).not.toHaveBeenCalled();
        expect(win.location.reload).not.toHaveBeenCalled();
        dom.window.close();
    });

    it('does not navigate after an edit/guard cancellation or a late update result', async () => {
        vi.useFakeTimers();
        const { win, worker, serviceWorker, dom } = environment();
        serviceWorker.controller = worker(true);
        expect(await reloadProviderDocument({ win, beforeNavigate: async () => false })).toBe(false);
        serviceWorker.controller = worker(false);
        let resolveUpdate;
        const next = worker(true);
        serviceWorker.getRegistration = async () => ({ waiting: next, update: () => new Promise((resolve) => { resolveUpdate = resolve; }) });
        const running = reloadProviderDocument({ win, onCommit: () => true });
        await vi.advanceTimersByTimeAsync(21000);
        expect(await running).toBe(false);
        resolveUpdate();
        await vi.advanceTimersByTimeAsync(1);
        expect(next.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
        expect(win.location.replace).not.toHaveBeenCalled();
        dom.window.close();
    });

    it('with no controller, requests a genuine root navigation without inventing worker capability', async () => {
        const { win, serviceWorker, dom } = environment();
        serviceWorker.controller = null;
        expect(await reloadProviderDocument({ win })).toBe(true);
        expect(win.location.replace).toHaveBeenCalledExactlyOnceWith('https://account.example/?__wg_provider_reload=1');
        dom.window.close();
    });

    it('controller-null with an applicable installing registration waits for a real first claim', async () => {
        const { win, worker, serviceWorker, change, dom } = environment();
        serviceWorker.controller = null;
        const next = worker(true, () => change(next)); next.state = 'installing';
        const registration = { installing: next, active: null, waiting: null, update: vi.fn(async () => {}) };
        serviceWorker.getRegistration = async () => registration;
        const running = reloadProviderDocument({ win, onCommit: () => true });
        await vi.waitFor(() => expect(registration.update).toHaveBeenCalled());
        expect(win.location.replace).not.toHaveBeenCalled();
        registration.waiting = next; next.state = 'installed';
        next.dispatchEvent(new dom.window.Event('statechange'));
        expect(await running).toBe(true);
        expect(serviceWorker.controller).toBe(next);
        expect(win.location.replace).toHaveBeenCalledOnce();
        dom.window.close();
    });

    it('controller-null with an old active registration fails closed instead of assuming no SW', async () => {
        vi.useFakeTimers();
        const { win, worker, serviceWorker, dom } = environment();
        serviceWorker.controller = null;
        const active = worker(false); active.state = 'activated';
        serviceWorker.getRegistration = async () => ({ active, update: async () => {} });
        const running = reloadProviderDocument({ win });
        await vi.advanceTimersByTimeAsync(21000);
        expect(await running).toBe(false);
        expect(win.location.replace).not.toHaveBeenCalled();
        dom.window.close();
    });

    it.each([false, true])('an already-active noncontroller is not an activation candidate (support=%s)', async (supports) => {
        const { win, worker, serviceWorker, dom } = environment();
        serviceWorker.controller = null;
        const active = worker(supports); active.state = 'activated';
        serviceWorker.getRegistration = async () => ({ active, installing: null, waiting: null, update: async () => {} });
        const commit = vi.fn(() => true);
        expect(await reloadProviderDocument({ win, onCommit: commit })).toBe(false);
        expect(commit).not.toHaveBeenCalled();
        expect(active.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
        expect(win.location.replace).not.toHaveBeenCalled();
        expect(win.location.reload).not.toHaveBeenCalled();
        dom.window.close();
    });

    it('rechecks candidate state/registration identity after the final awaited preparation', async () => {
        const { win, worker, serviceWorker, dom } = environment();
        serviceWorker.controller = null;
        const next = worker(true);
        const registration = { waiting: next, update: async () => {} };
        serviceWorker.getRegistration = async () => registration;
        const commit = vi.fn(() => true);
        expect(await reloadProviderDocument({ win, onCommit: commit, beforeNavigate: async () => {
            next.state = 'activated'; registration.waiting = null; registration.active = next;
            return true;
        } })).toBe(false);
        expect(commit).not.toHaveBeenCalled();
        expect(next.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
        expect(win.location.replace).not.toHaveBeenCalled();
        dom.window.close();
    });

    it('an actual supporting claim during preparation takes the current-controller path without skip', async () => {
        const { win, worker, serviceWorker, change, dom } = environment();
        serviceWorker.controller = null;
        const active = worker(true); active.state = 'activated';
        serviceWorker.getRegistration = async () => ({ active, update: async () => change(active) });
        const commit = vi.fn(() => true);
        expect(await reloadProviderDocument({ win, onCommit: commit })).toBe(true);
        expect(commit).not.toHaveBeenCalled();
        expect(active.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
        expect(win.location.replace).toHaveBeenCalledOnce();
        dom.window.close();
    });

    it('a registration appearing during the final guard prevents unverified first-claim navigation', async () => {
        const { win, serviceWorker, dom } = environment();
        serviceWorker.controller = null;
        let registration;
        serviceWorker.getRegistration = async () => registration;
        expect(await reloadProviderDocument({ win, beforeNavigate: async () => { registration = { active: {} }; return true; } })).toBe(false);
        expect(win.location.replace).not.toHaveBeenCalled();
        dom.window.close();
    });

    it('ignores a late capability reply after the bounded operation has failed', async () => {
        vi.useFakeTimers();
        const { win, serviceWorker, dom } = environment();
        let replyPort;
        serviceWorker.controller = { postMessage(_message, ports) { replyPort = ports[0]; } };
        serviceWorker.getRegistration = async () => undefined;
        const guard = vi.fn(async () => true);
        const running = reloadProviderDocument({ win, beforeNavigate: guard });
        await vi.advanceTimersByTimeAsync(21000);
        expect(await running).toBe(false);
        replyPort.postMessage({ type: 'PROVIDER_RELOAD_CAPABILITY', version: 1 });
        await vi.advanceTimersByTimeAsync(1);
        expect(guard).not.toHaveBeenCalled();
        expect(win.location.replace).not.toHaveBeenCalled();
        dom.window.close();
    });
});

// A minimal ServiceWorker stand-in: postMessage + an addEventListener/fire pair
// so a test can drive its 'statechange' just like the browser would.
function makeWorker() {
    const listeners = {};
    return {
        state: 'installing',
        postMessage: vi.fn(),
        addEventListener: (ev, cb) => ((listeners[ev] ??= []).push(cb)),
        fire: (ev) => (listeners[ev] || []).forEach((cb) => cb()),
    };
}

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

    it('default banner drives the SKIP_WAITING dance for an open tab (med-7gw)', async () => {
        // No injected showBanner → exercises the real default: it must kick
        // registration.update() (the browser will not re-check /sw.js on an idle
        // tab) and hand the live registration to the banner so Reload activates
        // the waiting SW instead of a plain reload the old SW serves stale.
        const { doc, win } = setup({ booted: '20260710-1000' });
        const waiting = { postMessage: vi.fn() };
        const registration = { waiting, update: vi.fn().mockResolvedValue() };
        win.navigator = { serviceWorker: { getRegistration: vi.fn().mockResolvedValue(registration) } };
        startUpdateCheck({ doc, win, fetchImpl: serving('20260710-1500') });
        await flush();
        expect(registration.update).toHaveBeenCalled();
        doc.getElementById('cloud-update-reload').click();
        expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
        expect(win.location.reload).not.toHaveBeenCalled(); // reload comes from controllerchange
    });

    it('default banner still reloads directly when no SW registration exists', async () => {
        const { doc, win } = setup({ booted: '20260710-1000' });
        win.navigator = {}; // no serviceWorker (e.g. unsupported / disabled)
        startUpdateCheck({ doc, win, fetchImpl: serving('20260710-1500') });
        await flush();
        doc.getElementById('cloud-update-reload').click();
        expect(win.location.reload).toHaveBeenCalledOnce();
    });

    it('stop() clears the poll timer', () => {
        const { doc, win } = setup();
        startUpdateCheck({ doc, win, fetchImpl: serving('20260710-1000'), showBanner })();
        expect(win.clearInterval).toHaveBeenCalledWith(42);
    });
});

describe('renderUpdateBanner', () => {
    it('reloads only when the user asks, rendered as the kit info banner', () => {
        const { doc } = setup();
        const onReload = vi.fn();
        renderUpdateBanner(doc, onReload);

        const toast = doc.getElementById('cloud-update-banner');
        expect(toast.className).toBe('wg-banner wg-banner--info');
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
        expect(doc.getElementById('cloud-update-banner')).toBeNull();
        expect(onDismiss).toHaveBeenCalledOnce();
        expect(onReload).not.toHaveBeenCalled();
    });

    it('sets no inline styles (CLAUDE.md rule 3)', () => {
        const { doc } = setup();
        renderUpdateBanner(doc, () => {});
        expect(doc.getElementById('cloud-update-banner').getAttribute('style')).toBeNull();
    });

    // med-s8q0: the tap shows at once that it took; more taps do nothing.
    it('one tap shows "Updating…" busy and disabled, "Later" disabled; a second tap calls nothing', () => {
        const { doc } = setup();
        const onReload = vi.fn(() => new Promise(() => {}));
        renderUpdateBanner(doc, onReload);
        const reload = doc.getElementById('cloud-update-reload');
        const dismiss = doc.getElementById('cloud-update-dismiss');

        reload.click();
        expect(reload.disabled).toBe(true);
        expect(reload.classList.contains('wg-btn--busy')).toBe(true);
        expect(reload.textContent).toBe('Updating…');
        expect(dismiss.disabled).toBe(true);
        expect(doc.getElementById('cloud-update-banner').textContent).toContain('Updating… the app will restart.');
        expect(reload.getAttribute('style')).toBeNull();

        reload.dispatchEvent(new doc.defaultView.MouseEvent('click'));
        reload.onclick();
        expect(onReload).toHaveBeenCalledOnce();
    });

    it('a failed update says so and gives Reload back; the next tap runs it again', async () => {
        const { doc } = setup();
        const onReload = vi.fn().mockRejectedValue(new Error('update reload failed offline'));
        renderUpdateBanner(doc, onReload);
        const reload = doc.getElementById('cloud-update-reload');
        const dismiss = doc.getElementById('cloud-update-dismiss');

        reload.click();
        await flush();
        expect(doc.getElementById('cloud-update-banner').textContent).toContain("Couldn't update. Try again.");
        expect(reload.disabled).toBe(false);
        expect(dismiss.disabled).toBe(false);
        expect(reload.classList.contains('wg-btn--busy')).toBe(false);
        expect(reload.textContent).toBe('Reload');

        reload.click();
        expect(onReload).toHaveBeenCalledTimes(2);
        expect(reload.textContent).toBe('Updating…');
    });
});

// A controlled page: navigator.serviceWorker with a controller and a real
// controllerchange event, and win.setTimeout on vitest's fake clock.
function controlled(win) {
    const sw = new EventTarget();
    sw.controller = { scriptURL: '/sw.js' };
    win.navigator = { serviceWorker: sw };
    win.setTimeout = (fn, ms) => setTimeout(fn, ms);
    return sw;
}

describe('showUpdateBanner', () => {
    describe('on the fake clock', () => {
        beforeEach(() => vi.useFakeTimers());
        afterEach(() => vi.useRealTimers());

        // med-s8q0: a reload before activation finishes lands on the OLD worker
        // (stale '/'), so a controlled page never reloads from here: the reload
        // is cloud-boot's controllerchange. 10 s without one → "Couldn't update".
        it('controlled page: SKIP_WAITING once, no reload at 2 s nor 10 s, then "Couldn\'t update"', async () => {
            const { doc, win } = setup();
            controlled(win);
            const registration = { waiting: { postMessage: vi.fn() } };
            showUpdateBanner({ doc, win, registration });

            const reload = doc.getElementById('cloud-update-reload');
            reload.click();
            await vi.advanceTimersByTimeAsync(0);
            expect(registration.waiting.postMessage).toHaveBeenCalledOnce();
            expect(registration.waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
            await vi.advanceTimersByTimeAsync(2000);
            expect(win.location.reload).not.toHaveBeenCalled();
            expect(reload.textContent).toBe('Updating…');
            await vi.advanceTimersByTimeAsync(8000);
            expect(win.location.reload).not.toHaveBeenCalled();
            expect(doc.getElementById('cloud-update-banner').textContent).toContain("Couldn't update. Try again.");
            expect(reload.disabled).toBe(false);
        });

        it('controlled page: controllerchange inside the deadline keeps "Updating…" and never reloads from here', async () => {
            const { doc, win } = setup();
            const sw = controlled(win);
            const registration = { waiting: { postMessage: vi.fn() } };
            showUpdateBanner({ doc, win, registration });

            const reload = doc.getElementById('cloud-update-reload');
            reload.click();
            await vi.advanceTimersByTimeAsync(3000);
            sw.dispatchEvent(new Event('controllerchange'));
            await vi.advanceTimersByTimeAsync(10000);
            expect(win.location.reload).not.toHaveBeenCalled();
            expect(reload.textContent).toBe('Updating…');
            expect(reload.disabled).toBe(true);
        });

        it('controller changed but nobody reloaded (claimed after boot) → one reload at the deadline, under the new worker', async () => {
            const { doc, win } = setup();
            const sw = controlled(win);
            const registration = { waiting: { postMessage: vi.fn() } };
            showUpdateBanner({ doc, win, registration });

            doc.getElementById('cloud-update-reload').click();
            await vi.advanceTimersByTimeAsync(3000);
            sw.controller = registration.waiting;
            sw.dispatchEvent(new Event('controllerchange'));
            await vi.advanceTimersByTimeAsync(6999);
            expect(win.location.reload).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(win.location.reload).toHaveBeenCalledOnce();
        });

        it('uncontrolled page (first load / hard reload): the 2 s fallback reload still fires', async () => {
            const { doc, win } = setup();
            win.setTimeout = (fn, ms) => setTimeout(fn, ms);
            const registration = { waiting: { postMessage: vi.fn() } };
            showUpdateBanner({ doc, win, registration });

            doc.getElementById('cloud-update-reload').click();
            await vi.advanceTimersByTimeAsync(0);
            expect(registration.waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
            expect(win.location.reload).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(2000);
            expect(win.location.reload).toHaveBeenCalledOnce();
        });

        it('installing → installed on a controlled page runs the dance under the deadline', async () => {
            const { doc, win } = setup();
            controlled(win);
            const installing = makeWorker();
            const registration = { waiting: null, installing, update: vi.fn().mockResolvedValue() };
            showUpdateBanner({ doc, win, registration });

            doc.getElementById('cloud-update-reload').click();
            await vi.advanceTimersByTimeAsync(5000); // a slow install: no deadline yet
            installing.state = 'installed';
            registration.waiting = installing;
            installing.fire('statechange');
            expect(installing.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
            await vi.advanceTimersByTimeAsync(9999);
            expect(doc.getElementById('cloud-update-reload').textContent).toBe('Updating…');
            await vi.advanceTimersByTimeAsync(1);
            expect(doc.getElementById('cloud-update-banner').textContent).toContain("Couldn't update. Try again.");
            expect(win.location.reload).not.toHaveBeenCalled();
        });
    });

    it('offline: update() fails with nothing waiting or installing → no reload, "Couldn\'t update"', async () => {
        const { doc, win } = setup();
        const registration = { waiting: null, installing: null, update: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) };
        showUpdateBanner({ doc, win, registration });

        doc.getElementById('cloud-update-reload').click();
        await flush();
        expect(win.location.reload).not.toHaveBeenCalled();
        expect(doc.getElementById('cloud-update-banner').textContent).toContain("Couldn't update. Try again.");
    });

    it('a failed install (installing → redundant) → no reload under the old worker, "Couldn\'t update"', async () => {
        const { doc, win } = setup();
        const installing = makeWorker();
        const registration = { waiting: null, installing, update: vi.fn().mockResolvedValue() };
        showUpdateBanner({ doc, win, registration });

        doc.getElementById('cloud-update-reload').click();
        await flush();
        installing.state = 'redundant';
        installing.fire('statechange');
        await flush();
        expect(win.location.reload).not.toHaveBeenCalled();
        expect(installing.postMessage).not.toHaveBeenCalled();
        expect(doc.getElementById('cloud-update-banner').textContent).toContain("Couldn't update. Try again.");
    });

    it('an open Undo window is flushed and its delete awaited before SKIP_WAITING (med-xso6.5)', async () => {
        const { doc, win } = setup();
        let finishDelete;
        win.flushPendingDelete = vi.fn(() => new Promise((r) => { finishDelete = r; }));
        const registration = { waiting: { postMessage: vi.fn() } };
        showUpdateBanner({ doc, win, registration });

        doc.getElementById('cloud-update-reload').click();
        expect(win.flushPendingDelete).toHaveBeenCalledOnce();
        await flush();
        expect(registration.waiting.postMessage).not.toHaveBeenCalled(); // delete still in flight

        finishDelete('deleted');
        await flush();
        expect(registration.waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    });

    it('with no waiting SW, Reload reloads directly (build-ID fallback path)', () => {
        const { doc, win } = setup();
        showUpdateBanner({ doc, win });

        doc.getElementById('cloud-update-reload').click();
        expect(win.location.reload).toHaveBeenCalledOnce();
    });

    // med-7gw: the build-ID poll shows the banner while registration.update() is
    // still INSTALLING the new SW, so `waiting` is null when a fast Reload lands.
    // A plain reload then would serve the stale old shell (two-reload path) — so
    // the click waits for the installing worker to finish, then runs the dance.
    it('waits for an installing SW before deciding, never plain-reloads early', async () => {
        const { doc, win } = setup();
        const installing = makeWorker();
        const registration = { waiting: null, installing, update: vi.fn().mockResolvedValue() };
        showUpdateBanner({ doc, win, registration });

        doc.getElementById('cloud-update-reload').click();
        await flush();
        // Still installing → do nothing yet (a reload now would be stale).
        expect(win.location.reload).not.toHaveBeenCalled();
        expect(installing.postMessage).not.toHaveBeenCalled();

        installing.state = 'installed';
        registration.waiting = installing;
        installing.fire('statechange');
        expect(installing.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
        expect(win.location.reload).not.toHaveBeenCalled(); // reload comes from controllerchange
    });

    it('plain-reloads when update() finds no new SW (page stale but SW already current)', async () => {
        const { doc, win } = setup();
        const registration = { waiting: null, installing: null, update: vi.fn().mockResolvedValue() };
        showUpdateBanner({ doc, win, registration });

        doc.getElementById('cloud-update-reload').click();
        await flush();
        expect(win.location.reload).toHaveBeenCalledOnce();
    });

    // med-kk1q.6: cloud-boot.js runs in <head>; state C (waiting worker) fires
    // before <body> is parsed. Wait for DOMContentLoaded instead of throwing.
    it('waits for the body when called before it is parsed, then renders into #app-banners', () => {
        const { doc, win } = setup();
        const body = doc.body;
        body.remove();
        expect(() => showUpdateBanner({ doc, win })).not.toThrow();
        expect(doc.getElementById('cloud-update-banner')).toBeNull();

        doc.documentElement.appendChild(body);
        body.innerHTML = '<div id="app-banners"></div>';
        doc.dispatchEvent(new doc.defaultView.Event('DOMContentLoaded'));
        expect(doc.querySelectorAll('#app-banners #cloud-update-banner')).toHaveLength(1);
    });

    it('stays out of the way when the degraded banner is up (one banner, degraded wins)', () => {
        const { doc, win } = setup();
        doc.body.innerHTML = '<div id="app-banners"><div id="boot-degraded-banner"></div></div>';
        showUpdateBanner({ doc, win });
        expect(doc.getElementById('cloud-update-banner')).toBeNull();
    });

    it('adds only one banner however many times it is called (dedupe)', () => {
        const { doc, win } = setup();
        showUpdateBanner({ doc, win });
        showUpdateBanner({ doc, win });
        expect(doc.querySelectorAll('#cloud-update-banner')).toHaveLength(1);
    });

    // med-7gw: after the user taps "Later", a re-fire from the other trigger
    // (poll shows it, then cloud-boot's onupdatefound lands seconds later) must
    // NOT re-nag. The dismiss latches on the document; a fresh doc re-prompts.
    it('does not re-show after the user dismissed it (cross-trigger re-nag latch)', () => {
        const { doc, win } = setup();
        showUpdateBanner({ doc, win });
        doc.getElementById('cloud-update-dismiss').click();
        expect(doc.getElementById('cloud-update-banner')).toBeNull();

        // A later trigger (e.g. cloud-boot onupdatefound after the poll) re-fires.
        showUpdateBanner({ doc, win, registration: { waiting: { postMessage: vi.fn() } } });
        expect(doc.getElementById('cloud-update-banner')).toBeNull();
    });
});

// bd med-vjxz.1: lifecycle and update-check lines for the app shells'
// diagnostic log (passkey-diag.js). Words, counts and statuses only.
describe('shell diagnostic lines', () => {
    let ios;
    const entries = () => ios.postMessage.mock.calls.map(([m]) => (expect(m.op).toBe('diag.append'), JSON.parse(m.args.entry)));
    const lines = () => entries().map((e) => e.line);
    const shell = (pathname) => {
        ios = { postMessage: vi.fn() };
        vi.stubGlobal('window', { webkit: { messageHandlers: { wgNative: ios } } });
        vi.stubGlobal('location', { pathname });
    };
    afterEach(() => vi.unstubAllGlobals());

    it('logs boot, then hidden and visible, with the account label masked out of the path', () => {
        shell('/d/abc123');
        const { doc } = setup();
        let state = 'visible';
        Object.defineProperty(doc, 'visibilityState', { get: () => state, configurable: true });
        const win = { document: doc, location: { pathname: '/d/abc123' }, addEventListener: vi.fn() };
        startLifecycleDiag(win);
        state = 'hidden';
        doc.dispatchEvent(new doc.defaultView.Event('visibilitychange'));
        state = 'visible';
        doc.dispatchEvent(new doc.defaultView.Event('visibilitychange'));
        expect(lines()).toEqual(['boot /d/<sub> build 20260710-1000', 'hidden', 'visible']);
        expect(entries().every((e) => e.path === '/d/<sub>' && Number.isFinite(e.ms) && Number.isFinite(e.up))).toBe(true);
        expect(JSON.stringify(ios.postMessage.mock.calls)).not.toContain('abc123');
        expect(win.addEventListener.mock.calls.map(([t]) => t)).toEqual(['pageshow', 'pagehide']);
    });

    it('masks every path segment that names an account or a token; other paths pass', () => {
        expect(maskPath('/d/abc123')).toBe('/d/<sub>');
        expect(maskPath('/i/abc123')).toBe('/i/<sub>');
        expect(maskPath('/s/Xy9')).toBe('/s/<token>');
        expect(maskPath('/mcp/secret/tools')).toBe('/mcp/<token>/tools');
        expect(maskPath('/unlock')).toBe('/unlock');
        expect(maskPath('/')).toBe('/');
    });

    it('logs the update check outcome as same | new | failed <status or class>, never the error text', async () => {
        shell('/');
        for (const fetchImpl of [
            serving('20260710-1000'),
            vi.fn().mockResolvedValue({ ok: false, status: 503 }),
            vi.fn().mockRejectedValue(new TypeError('Failed to fetch https://acct.example.com/api/version')),
            serving('20260711-0900'),
        ]) {
            const { doc, win } = setup();
            startUpdateCheck({ doc, win, fetchImpl, showBanner: vi.fn() });
            await flush();
        }
        expect(lines()).toEqual(['update check same', 'update check failed 503', 'update check failed TypeError', 'update check new']);
        expect(JSON.stringify(ios.postMessage.mock.calls)).not.toMatch(/acct|example|Failed to fetch/);
    });

    it('logs the Reload tap and its failure reason as words, never the error text (med-s8q0)', async () => {
        shell('/');
        const { doc, win } = setup();
        const registration = { waiting: null, installing: null, update: vi.fn().mockRejectedValue(new TypeError('Failed to fetch https://acct.example.com/sw.js')) };
        showUpdateBanner({ doc, win, registration });
        doc.getElementById('cloud-update-reload').click();
        await flush();
        expect(lines()).toEqual(['update reload', 'update reload failed offline']);
        expect(JSON.stringify(ios.postMessage.mock.calls)).not.toMatch(/acct|example|Failed to fetch/);
    });

    it('logs a repeated same outcome once, and again after a failed check', async () => {
        shell('/');
        const { doc, win } = setup();
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce({ ok: true, json: async () => ({ build_id: '20260710-1000' }) })
            .mockResolvedValueOnce({ ok: true, json: async () => ({ build_id: '20260710-1000' }) })
            .mockResolvedValueOnce({ ok: false, status: 503 })
            .mockResolvedValue({ ok: true, json: async () => ({ build_id: '20260710-1000' }) });
        startUpdateCheck({ doc, win, fetchImpl, showBanner: vi.fn() });
        await flush();
        for (let i = 0; i < 3; i++) {
            win.addEventListener.mock.calls.find(([t]) => t === 'focus')[1]();
            await flush();
        }
        expect(lines()).toEqual(['update check same', 'update check failed 503', 'update check same']);
    });

    it('installs nothing on the web (no shell bridge)', () => {
        vi.stubGlobal('window', {});
        const { doc, win } = setup();
        const add = vi.spyOn(doc, 'addEventListener');
        startLifecycleDiag({ ...win, document: doc });
        expect(add).not.toHaveBeenCalled();
        expect(win.addEventListener).not.toHaveBeenCalled();
    });
});
