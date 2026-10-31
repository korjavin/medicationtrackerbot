// bd med-jb7.3 — "a new version is available" for cloud mode.
//
// Bot mode gets this from the service worker: app-shell.js registers
// /static/sw.js, and onupdatefound -> showUpdateToast(). Cloud mode bails out of
// that path entirely (app-shell.js returns early on window.__MEDTRACKER_CLOUD__,
// since web/cloud/sw.js already owns this scope), so it had no update prompt at
// all.
//
// index.html is served no-store and its ~105 asset URLs carry a `?v=<build_ts>`
// fingerprint, so a genuine COLD RELOAD always picks up new code. The stuck case
// is the installed home-screen PWA that is RESUMED rather than relaunched — most
// of all on iOS, where Safari's background SW update check is unreliable. Such a
// tab can run last week's JS against this week's server indefinitely, with
// nothing telling the user to reload.
//
// So: compare the build id this tab booted with against the one the server is
// serving right now, on boot and whenever the app comes back to the foreground.
// We never reload on the user's behalf — a silent reload mid-form throws away
// whatever they were typing.

const POLL_MS = 60 * 60 * 1000;

// buildIDFrom (internal/cloudserver/version.go) reports "dev" for an unstamped
// tree. Two dev builds are indistinguishable, so there is nothing to compare and
// nothing useful to say: stay quiet rather than prompt on every `go run`.
const DEV_BUILD_ID = 'dev';

export function bootBuildID(doc) {
    return doc.querySelector('meta[name="medtracker-build-id"]')?.content ?? '';
}

export async function fetchServerBuildID(fetchImpl) {
    const res = await fetchImpl('/api/version', { cache: 'no-store' });
    if (!res.ok) throw new Error(`/api/version returned ${res.status}`);
    const body = await res.json();
    return body?.build_id ?? '';
}

// The kit's info banner (components.css .wg-banner--info, med-xso6.5) in the
// app's #app-banners strip under the top edge; this file ships no CSS and sets
// no inline styles (CLAUDE.md rule 3).
export function renderUpdateBanner(doc, onReload, onDismiss) {
    const banner = doc.createElement('div');
    banner.className = 'wg-banner wg-banner--info';
    banner.id = 'cloud-update-banner';
    banner.setAttribute('role', 'status');

    const text = doc.createElement('span');
    text.className = 'wg-banner__text';
    text.textContent = 'A new version is available.';

    const dismiss = doc.createElement('button');
    dismiss.className = 'wg-btn wg-btn--ghost wg-btn--sm';
    dismiss.id = 'cloud-update-dismiss';
    dismiss.textContent = 'Later';
    dismiss.setAttribute('aria-label', 'Dismiss update notice');
    dismiss.onclick = () => {
        banner.remove();
        onDismiss?.();
    };

    const reload = doc.createElement('button');
    reload.className = 'wg-btn wg-btn--sm';
    reload.id = 'cloud-update-reload';
    reload.textContent = 'Reload';
    reload.onclick = onReload;

    banner.append(text, dismiss, reload);
    (doc.getElementById('app-banners') || doc.body).appendChild(banner);
    return banner;
}

// Activate the waiting SW and reload. Mirrors app-shell.js's showUpdateToast:
// a waiting SW gets SKIP_WAITING and the real reload comes from
// controllerchange (cloud-boot.js), with a 2s fallback in case it doesn't
// fire.
//
// The subtlety is the build-ID poll path: it kicks registration.update() and
// shows the banner immediately, but the new worker only reaches `waiting` once
// its install (warmShell precache) finishes — seconds later. If the user clicks
// Reload during that install window, `waiting` is still null; a plain reload
// then hits the still-controlling OLD SW, which serves '/' stale-first (the
// two-reload path this bead removes). So on a click with no waiting worker we
// re-run update() and wait for the installing worker to finish before running
// the dance. Only when update() finds NO new worker (the SW is already current,
// only the page JS is stale) is a plain reload correct.
async function activateAndReload(registration, win) {
    // An open Undo window owes a delete; send it before the page goes away.
    const owed = win.flushPendingDelete?.();
    if (owed) {
        try { await owed; } catch { /* the boot replay still has it */ }
    }
    if (!registration) {
        win.location.reload();
        return;
    }
    const dance = (worker) => {
        worker.postMessage({ type: 'SKIP_WAITING' });
        win.setTimeout(() => win.location.reload(), 2000);
    };
    if (registration.waiting) {
        dance(registration.waiting);
        return;
    }
    try {
        await registration.update?.();
    } catch {
        // Offline / deploy mid-flight — fall through and re-check below.
    }
    if (registration.waiting) {
        dance(registration.waiting);
        return;
    }
    const installing = registration.installing;
    if (!installing?.addEventListener) {
        win.location.reload();
        return;
    }
    installing.addEventListener('statechange', () => {
        if (installing.state === 'installed') dance(registration.waiting ?? installing);
        else if (installing.state === 'redundant') win.location.reload();
    });
}

// The writer gate's 426 (bd med-wi09.12): start fetching the current build
// the moment the "Update required" banner goes up, so by the time Reload is
// tapped the new SW is installed (or installing) rather than first asked for.
export async function fetchLatest(win = window) {
    try {
        const registration = await win.navigator?.serviceWorker?.getRegistration?.();
        await registration?.update?.();
    } catch { /* offline / no SW — Reload's own update() retries */ }
}

// The "Update required" banner's Reload (med-wi09.5): the same SW dance, so the
// reload lands on the current build instead of the old SW's cached shell.
export async function reloadToLatest(win = window) {
    let registration = null;
    try {
        registration = (await win.navigator?.serviceWorker?.getRegistration?.()) ?? null;
    } catch { /* no SW — plain reload below */ }
    return activateAndReload(registration, win);
}

// module-state: one content-free preparation/committed reload owner per page;
// no key, draft values or origin permissions are stored here.
const providerReloadOperations = new WeakMap();

// Preparation can be cancelled. Once activation is requested, the inert page
// stays committed until its pre-verified worker claims and immediately replaces
// it. A progress deadline returns a retry handle, never editing authority.
export function reloadProviderDocument(options = {}) {
    const win = options.win ?? window;
    const existing = providerReloadOperations.get(win);
    if (existing) return existing.retry();
    const { beforeNavigate = async () => true, isCurrent = () => true, onCommit, onPending = () => {}, onProgress = () => {} } = options;
    const sw = win.navigator?.serviceWorker;
    const target = new URL('/', win.location.href);
    target.searchParams.set('__wg_provider_reload', '1');
    let worker = null;
    let committed = false;
    let navigating = false;
    let superseded = false;
    let running = null;
    let resolveClaim;
    const claimed = new Promise((resolve) => { resolveClaim = resolve; });
    const send = (type, detail) => win.document?.dispatchEvent(new win.CustomEvent(type, { detail }));
    const pending = () => {
        if (!navigating && !superseded) onPending({ retry: operation.retry });
        return { state: 'committed', retry: operation.retry };
    };
    const navigate = () => {
        if (navigating || superseded) return false;
        navigating = true;
        win.location.replace(target.href);
        resolveClaim(true);
        return true;
    };
    const operation = {
        get worker() { return worker; },
        get committed() { return committed; },
        claim() {
            // Boot calls this in the matching controllerchange stack. Support
            // was verified BEFORE commitment: no async probe/dirty check here.
            if (!committed || sw?.controller !== worker || providerReloadOperations.get(win) !== operation) return false;
            return navigate();
        },
        redundant() { if (committed) pending(); },
        supersede() { superseded = true; resolveClaim({ state: 'superseded' }); },
        retry() {
            if (running) return running;
            running = run().finally(() => { running = null; });
            return running;
        },
    };
    providerReloadOperations.set(win, operation);

    function waitForClaim() {
        if (navigating) return Promise.resolve(true);
        if (sw?.controller === worker && operation.claim()) return Promise.resolve(true);
        return new Promise((resolve) => {
            const timer = setTimeout(() => resolve(pending()), 20000);
            claimed.then((result) => { clearTimeout(timer); resolve(result); });
        });
    }

    async function prepare() {
        const cleanups = [];
        let alive = true;
        let timer;
        const ensure = () => {
            if (!alive || superseded || navigating || providerReloadOperations.get(win) !== operation) throw new Error('provider reload cancelled');
        };
        const unrelated = () => { alive = false; };
        win.document?.addEventListener('wg:provider-reload-unrelated', unrelated);
        cleanups.push(() => win.document?.removeEventListener('wg:provider-reload-unrelated', unrelated));
        const probe = (candidate) => new Promise((resolve) => {
            const Channel = win.MessageChannel || globalThis.MessageChannel;
            if (!candidate || !Channel) { resolve(false); return; }
            const channel = new Channel();
            let done = false;
            const finish = (supported) => {
                if (done) return;
                done = true; clearTimeout(probeTimer);
                channel.port1.close(); channel.port2.close();
                resolve(supported);
            };
            const probeTimer = setTimeout(() => finish(false), 500);
            cleanups.push(() => finish(false));
            channel.port1.onmessage = (event) => finish(event.data?.type === 'PROVIDER_RELOAD_CAPABILITY' && event.data.version === 1);
            channel.port1.start?.();
            try { candidate.postMessage({ type: 'PROVIDER_RELOAD_CAPABILITY' }, [channel.port2]); } catch { finish(false); }
        });
        const installed = (registration) => new Promise((resolve, reject) => {
            if (registration.waiting) { resolve(registration.waiting); return; }
            const candidate = registration.installing || registration.active;
            if (!candidate?.addEventListener) { reject(new Error('no supporting worker')); return; }
            const changed = () => {
                if (candidate.state === 'installed' || candidate.state === 'activated') resolve(registration.waiting || candidate);
                else if (candidate.state === 'redundant') reject(new Error('worker install failed'));
            };
            candidate.addEventListener('statechange', changed);
            cleanups.push(() => candidate.removeEventListener('statechange', changed));
            changed();
        });
        try {
            return await Promise.race([
                (async () => {
                    let current = sw?.controller;
                    let ready = !!current && await probe(current) && current === sw.controller;
                    ensure();
                    let candidate = null;
                    let priorController = current;
                    if (sw && !ready) {
                        const registration = await sw.getRegistration?.();
                        ensure();
                        if (!registration && sw.controller) throw new Error('no registration');
                        if (registration) {
                            await registration.update(); ensure();
                            current = sw.controller;
                            ready = !!current && await probe(current) && current === sw.controller;
                            ensure();
                            if (!ready) {
                                priorController = sw.controller;
                                candidate = await installed(registration); ensure();
                                if (!await probe(candidate)) throw new Error('unsupported worker');
                                ensure();
                            }
                        }
                    }
                    // All asynchronous dirty/delete work ends BEFORE activation.
                    if (!committed && !await beforeNavigate()) return false;
                    ensure();
                    if (!ready && !candidate && sw) {
                        if (await sw.getRegistration?.() || sw.controller) return false;
                        ensure();
                    }
                    if (ready && sw.controller !== current) return false;
                    if (candidate && sw.controller !== candidate && sw.controller !== priorController) return false;
                    if (candidate?.state === 'redundant') throw new Error('worker superseded');
                    if (!committed && isCurrent() !== true) return false;
                    // No await from this final check through commitment/send.
                    if (!candidate || sw.controller === candidate) return navigate();
                    worker = candidate;
                    const activation = { operation, accepted: false };
                    send('wg:provider-reload-activation', activation);
                    if (!activation.accepted) throw new Error('boot cannot own activation');
                    if (!committed) {
                        if (typeof onCommit !== 'function' || onCommit({ retry: operation.retry }) !== true) {
                            send('wg:provider-reload-abort', { operation });
                            return false;
                        }
                        committed = true;
                    }
                    clearTimeout(timer);
                    worker.postMessage({ type: 'SKIP_WAITING' });
                    return true;
                })(),
                new Promise((_, reject) => { timer = setTimeout(() => { alive = false; reject(new Error('provider preparation timed out')); }, 20000); }),
            ]);
        } finally {
            alive = false; clearTimeout(timer);
            for (const cleanup of cleanups) cleanup();
            if (!committed) send('wg:provider-reload-abort', { operation });
        }
    }

    async function run() {
        if (navigating) return true;
        if (superseded) return { state: 'superseded' };
        try {
            if (committed) {
                onProgress();
                // Retry joins an already-requested activation; no second skip.
                if (worker?.state !== 'redundant') return await waitForClaim();
            }
            const result = await prepare();
            if (navigating) return true;
            if (committed) return await waitForClaim();
            return result;
        } catch {
            if (committed) return pending();
            return false;
        } finally {
            if (!committed && providerReloadOperations.get(win) === operation) providerReloadOperations.delete(win);
        }
    }
    return operation.retry();
}

// Latched when the user taps "Later" so a banner they dismissed does not
// re-appear seconds later. The two triggers race: the build-ID poll shows the
// banner immediately and kicks registration.update(), and when that install
// reaches 'installed' cloud-boot.js's onupdatefound fires showUpdateBanner
// again — so a dismiss inside that install window would otherwise re-nag. The
// latch is a data attribute on the document (both triggers render into the same
// real document, so it's shared across paths) rather than module state — same
// DOM-dedup shape as the cloud-update-banner id, per-tab, and it resets on the
// next cold load, which is when re-prompting is fair. No window.* global
// (rule 4), no inline style (rule 3).
const DISMISSED_ATTR = 'data-cloud-update-dismissed';

// Single entry point for both update triggers (SW-waiting and the build-ID
// poll below). Two dedupes: the DOM id cloud-update-banner (a banner is already
// up) and the dismissed latch (the user said "Later" this session).
export function showUpdateBanner({ doc, win, registration } = {}) {
    doc ??= document;
    win ??= window;
    if (doc.documentElement.hasAttribute(DISMISSED_ATTR)) return;
    if (doc.getElementById('cloud-update-banner')) return;
    renderUpdateBanner(
        doc,
        () => activateAndReload(registration, win),
        () => doc.documentElement.setAttribute(DISMISSED_ATTR, '1'),
    );
}

// Returns a stop() so tests (and any future teardown) can clear the interval.
export function startUpdateCheck({ doc, win, fetchImpl, showBanner } = {}) {
    doc ??= document;
    win ??= window;
    fetchImpl ??= (...a) => win.fetch(...a);
    // The build-ID poll is the only reliable deploy-detector for an idle OPEN
    // tab: the browser re-checks /sw.js only on navigation or ~24h, so a deploy
    // landing on an open tab is invisible to cloud-boot.js's SW-waiting path —
    // but this poll saw it. So kick registration.update() (installs the new,
    // non-skipWaiting SW → it WAITS) and hand the LIVE registration to the
    // banner. On Reload, activateAndReload posts SKIP_WAITING → controllerchange
    // reloads once — and if the click lands before the new SW has finished
    // installing, activateAndReload waits for it rather than plain-reloading the
    // old still-controlling SW into the stale '/' (stale-while-revalidate),
    // which took two clicks.
    showBanner ??= () => {
        const swc = win.navigator?.serviceWorker;
        if (!swc?.getRegistration) { showUpdateBanner({ doc, win }); return; }
        swc.getRegistration()
            .then((reg) => {
                reg?.update?.().catch(() => {});
                showUpdateBanner({ doc, win, registration: reg });
            })
            .catch(() => showUpdateBanner({ doc, win }));
    };

    const booted = bootBuildID(doc);
    if (!booted || booted === DEV_BUILD_ID) return () => {};

    // Latched once the banner is up, and left latched when the user taps
    // "Later": re-prompting an hour after they said not now is nagging. They
    // get the prompt again on the next cold start, which is the next time the
    // question is actually worth asking.
    let prompted = false;

    const check = async () => {
        if (prompted) return;
        let serving;
        try {
            serving = await fetchServerBuildID(fetchImpl);
        } catch {
            // Offline, or a deploy is mid-flight. Say nothing; the next
            // foreground or tick asks again.
            return;
        }
        if (!serving || serving === DEV_BUILD_ID || serving === booted) return;
        prompted = true;
        showBanner();
    };

    check();
    doc.addEventListener('visibilitychange', () => {
        if (doc.visibilityState === 'visible') check();
    });
    win.addEventListener('focus', check);
    const timer = win.setInterval(check, POLL_MS);
    return () => win.clearInterval(timer);
}

// Auto-start on the real app page. The meta tag is injected only into the
// index.html cmd/cloud serves (injectCloudBoot), so importing this module from a
// test — where no such tag exists — starts nothing and touches no network.
if (typeof document !== 'undefined' && bootBuildID(document)) {
    startUpdateCheck();
}
