// AppRefresh — pull to refresh on Today and Health (bd med-y7b4.6, epic
// med-y7b4 §4; spec docs/design/claude-design/ui_kits/app-v2/
// screens-settings-cleanup.html PR1–PR3).
//
// A touch-only overscroll gesture: a finger that starts with the page at the
// top and drags down shows the .wg-ptr pill under the app bar / segments;
// past THRESHOLD px the arrow flips ("Release to …") and letting go runs
// AppRefresh.run(section). Below the threshold, letting go does nothing. The
// listeners are passive and never preventDefault, so they cannot fight the
// page's scroll; no gesture starts while a sheet, dialog or page is open.
// Mouse / desktop never fires touch events, so it gets no gesture.
//
// run(section) only adds work: the page keeps its local render, and whatever
// lands re-renders through the normal DataStore invalidation (sync.js
// notifyRecordsChanged). Health (bp / weight / health) → the Health import,
// then the sync pull; Today → the sync pull only. One refresh at a time: a
// pull while one runs is ignored. Nothing new → no toast; something new → an
// ok toast; a failure → a danger toast naming the fix. Never a dialog.
//
// The work is registered by the boot code that owns it, so this file needs no
// vault or native access:
//   setImport(fn, label, isOn) — web/cloud/js/health-import.js, inside the
//     app shells only: fn() → Promise<{ added }> (rejects on failure); label
//     names the store ("Apple Health" / "Health Connect"); isOn() → whether
//     the import is switched on in Settings (off: Health pulls sync only).
//   setSync(fn) — web/cloud/js/cloud-boot.js, with an account only:
//     fn() → Promise<{ arrived: boolean }>; rejects with an Error whose
//     message is the toast text.
// A section with nothing registered (Today in local mode, Health in a browser
// without an account) has no gesture at all.
//
// Loaded after app-back.js.
(function () {
    'use strict';

    const THRESHOLD = 64; // px of finger travel past which release refreshes
    const SHOW_AFTER = 8; // px before the pill appears (a tap is not a pull)
    const IMPORT_TIMEOUT_MS = 20000;
    let importer = null;
    let importLabel = 'Apple Health';
    let importIsOn = null;
    let syncer = null;
    let inFlight = null;

    // The import counts only while it is switched on in Settings.
    function canImport() {
        if (!importer) return false;
        try { return !importIsOn || importIsOn() === true; } catch (_) { return false; }
    }

    function isHealth(section) {
        return !!(window.AppNav && window.AppNav.HEALTH_SECTIONS.indexOf(section) !== -1);
    }

    function currentSection() {
        const t = window.AppStore && window.AppStore.get('currentTab');
        if (t) return t;
        return ((document.querySelector('.view.active') || {}).id || '').replace(/-view$/, '');
    }

    function canRefresh(section) {
        if (section === 'today') return !!syncer;
        if (isHealth(section)) return canImport() || !!syncer;
        return false;
    }

    function toast(msg, type) {
        if (typeof window.safeToast === 'function') window.safeToast(msg, type);
    }

    function withTimeout(promise, ms, message) {
        let timer = null;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), ms);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }

    async function work(section) {
        let added = 0;
        let failure = null; // the first failure's toast text
        if (isHealth(section) && canImport()) {
            const fix = `Couldn't read ${importLabel} · check its access in Settings`;
            try {
                const r = await withTimeout(Promise.resolve().then(importer), IMPORT_TIMEOUT_MS, fix);
                added = (r && r.added) || 0;
            } catch (e) {
                console.error('[refresh] health import failed', e);
                failure = fix;
            }
        }
        // The sync leg is independent: a failed import still pulls.
        let arrived = false;
        if (syncer) {
            try {
                const r = await syncer();
                arrived = !!(r && r.arrived);
            } catch (e) {
                console.error('[refresh] sync pull failed', e);
                failure = failure || (e && e.message) || 'Sync failed · try again';
            }
        }
        if (failure) toast(failure, 'error');
        else if (added > 0) toast(`${added} new reading${added === 1 ? '' : 's'} from ${importLabel}`, 'success');
        else if (arrived) toast('Synced · new entries', 'success');
    }

    function run(section) {
        if (inFlight) return inFlight;
        inFlight = work(section || currentSection()).finally(() => { inFlight = null; });
        return inFlight;
    }

    // --- the gesture ---------------------------------------------------------

    let pull = null; // { section, startY, pill, ready } while a finger is down

    function atTop() {
        const el = document.scrollingElement || document.documentElement;
        return (window.scrollY || (el && el.scrollTop) || 0) <= 0;
    }

    function modalOpen() {
        const mm = window.ModalManager;
        return !!(mm && ((typeof mm.isAnyOpen === 'function' && mm.isAnyOpen())
            || (typeof mm.hasClosable === 'function' && mm.hasClosable())));
    }

    function pillText(section, phase) {
        const health = isHealth(section) && canImport();
        if (phase === 'busy') return health ? `Checking ${importLabel}…` : 'Syncing…';
        const verb = phase === 'ready' ? 'Release' : 'Pull';
        return health ? `${verb} to check ${importLabel}` : `${verb} to sync`;
    }

    function paint(state, section, phase) {
        state.pill.className = 'wg-ptr' + (phase === 'pull' ? '' : ` wg-ptr--${phase}`);
        if (phase === 'busy') state.pill.setAttribute('role', 'status');
        else state.pill.removeAttribute('role');
        state.label.textContent = pillText(section, phase);
        state.ico.replaceChildren();
        if (window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
            state.ico.appendChild(window.WGIcons.iconSvg(phase === 'busy' ? 'refresh' : 'download'));
        }
    }

    function mountPill(state) {
        const view = document.getElementById(`${state.section}-view`);
        if (!view) return;
        const pill = document.createElement('div');
        const ico = document.createElement('i');
        ico.className = 'wg-ico wg-ico--sm';
        const label = document.createElement('span');
        pill.append(ico, label);
        state.pill = pill;
        state.ico = ico;
        state.label = label;
        // Under the app bar and the segment strips, above the content.
        const heads = Array.from(view.children).filter((c) => c.matches('.wg-appbar, .wg-seg'));
        if (heads.length) heads[heads.length - 1].after(pill);
        else view.prepend(pill);
    }

    function drop(state) {
        if (state && state.pill) state.pill.remove();
        if (pull === state) pull = null;
    }

    document.addEventListener('touchstart', (e) => {
        drop(pull);
        if (inFlight || !e.touches || e.touches.length !== 1) return;
        const section = currentSection();
        if (!canRefresh(section) || !atTop() || modalOpen()) return;
        pull = { section, startY: e.touches[0].clientY, pill: null, ready: false };
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        const state = pull;
        if (!state || !e.touches || !e.touches.length) return;
        const dy = e.touches[0].clientY - state.startY;
        // Scrolling up or a page that moved: not a pull any more.
        if (dy < 0 || !atTop() || e.touches.length !== 1) { drop(state); return; }
        if (dy < SHOW_AFTER && !state.pill) return;
        if (!state.pill) mountPill(state);
        if (!state.pill) { drop(state); return; }
        const ready = dy >= THRESHOLD;
        if (ready !== state.ready || !state.label.textContent) {
            state.ready = ready;
            paint(state, state.section, ready ? 'ready' : 'pull');
        }
    }, { passive: true });

    document.addEventListener('touchend', () => {
        const state = pull;
        if (!state) return;
        pull = null;
        if (!state.ready || inFlight) { drop(state); return; }
        paint(state, state.section, 'busy');
        run(state.section).finally(() => drop(state));
    }, { passive: true });

    document.addEventListener('touchcancel', () => drop(pull), { passive: true });

    window.AppRefresh = {
        run,
        setImport(fn, label, isOn) {
            importer = typeof fn === 'function' ? fn : null;
            importIsOn = typeof isOn === 'function' ? isOn : null;
            if (label) importLabel = label;
        },
        setSync(fn) {
            syncer = typeof fn === 'function' ? fn : null;
        },
    };
})();
