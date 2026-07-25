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

// Reuses bot mode's toast classes (web/static/css/styles.css .pwa-update-toast /
// .pwa-update-btn) — cloud serves that same stylesheet, so the prompt looks
// identical in both modes and this file ships no CSS and sets no inline styles
// (CLAUDE.md rule 3).
export function renderUpdateBanner(doc, onReload, onDismiss) {
    const toast = doc.createElement('div');
    toast.className = 'pwa-update-toast';
    toast.id = 'cloud-update-toast';
    toast.setAttribute('role', 'status');

    const text = doc.createElement('span');
    text.textContent = 'A new version is available.';

    const reload = doc.createElement('button');
    reload.className = 'pwa-update-btn';
    reload.id = 'cloud-update-reload';
    reload.textContent = 'Reload';
    reload.onclick = onReload;

    const dismiss = doc.createElement('button');
    dismiss.className = 'pwa-update-btn';
    dismiss.id = 'cloud-update-dismiss';
    dismiss.textContent = 'Later';
    dismiss.setAttribute('aria-label', 'Dismiss update notice');
    dismiss.onclick = () => {
        toast.remove();
        onDismiss?.();
    };

    toast.append(text, reload, dismiss);
    doc.body.appendChild(toast);
    return toast;
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

// Latched when the user taps "Later" so a banner they dismissed does not
// re-appear seconds later. The two triggers race: the build-ID poll shows the
// banner immediately and kicks registration.update(), and when that install
// reaches 'installed' cloud-boot.js's onupdatefound fires showUpdateBanner
// again — so a dismiss inside that install window would otherwise re-nag. The
// latch is a data attribute on the document (both triggers render into the same
// real document, so it's shared across paths) rather than module state — same
// DOM-dedup shape as the cloud-update-toast id, per-tab, and it resets on the
// next cold load, which is when re-prompting is fair. No window.* global
// (rule 4), no inline style (rule 3).
const DISMISSED_ATTR = 'data-cloud-update-dismissed';

// Single entry point for both update triggers (SW-waiting and the build-ID
// poll below). Two dedupes: the DOM id cloud-update-toast (a banner is already
// up) and the dismissed latch (the user said "Later" this session).
export function showUpdateBanner({ doc, win, registration } = {}) {
    doc ??= document;
    win ??= window;
    if (doc.documentElement.hasAttribute(DISMISSED_ATTR)) return;
    if (doc.getElementById('cloud-update-toast')) return;
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
