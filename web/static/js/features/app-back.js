// AppBack — the app's one back step (bd med-y7b4.3, epic med-y7b4 §3).
//
// step() → true when it closed or returned something, false at the root:
//   1. a visible sheet, dialog or page → ModalManager.closeTopMostVisibleModal()
//      (in-page dialog first, then the wg-page / modal stack, most recent first);
//   2. an open Settings sub-page → closed. Sub-pages are WGPages on that same
//      stack (features/settings.js openSettingsPage), so rung 1 already closes
//      them, one page per step;
//   3. a section other than Today → the section it was reached from in this
//      session; with no trail (a restored or deep-linked section) a page returns
//      to its origin tab and any other section to Today (AppNav.backTarget);
//   4. Today with nothing open → false, nothing happens.
//
// Every back path calls step(), so there is one order: the in-app chevron and
// browser Back (back-button.js, modal-history.js popstate), Esc
// (core/modal-manager.js), the page bar's Back (app-nav.js) and the shells'
// system Back (NativeBack.onStep, native/back.js). canStep() is what step()
// would answer right now; NativeBack.setState hears it once on every full load,
// on every change (a modal opens or closes, the section changes) and again on a
// bfcache restore (pageshow persisted). The trail starts when bootstrap calls
// ready() after startup routing, so a restored section plus a deep link is not
// history: Back from there goes to Today.
//
// Switching between the Health tab's segments (bp / weight / health) replaces
// the trail's top instead of stacking: Back leaves the Health tab, not the
// segment. Loaded after app-nav.js and before modal-history.js.

(function () {
    const START = 'today';
    // ponytail: capped trail, oldest dropped; a long session's far past is
    // unreachable by Back, which nobody presses 50 times.
    const MAX_TRAIL = 50;
    let trail = []; // sections passed through before the current one, this session
    let current = null;
    let stepping = false;
    let lastState = null;
    let started = false;
    let observers = [];

    function currentTab() {
        const t = window.AppStore && window.AppStore.get('currentTab');
        if (t) return t;
        return ((document.querySelector('.view.active') || {}).id || '').replace(/-view$/, '');
    }

    function isHealth(tab) {
        return !!(window.AppNav && window.AppNav.HEALTH_SECTIONS.indexOf(tab) !== -1);
    }

    // Index in trail of the section Back returns to from `cur`, -1 for none.
    function trailIndex(cur) {
        let i = trail.length - 1;
        while (i >= 0 && trail[i] === cur) i--;
        return i;
    }

    // Startup routing (the restored section, then a deep link) is where the
    // session starts, not history: bootstrap calls ready() once it is done.
    function ready() {
        started = true;
    }

    function onTab(tab) {
        if (started && !stepping && current && tab !== current && !(isHealth(current) && isHealth(tab))) {
            trail.push(current);
            if (trail.length > MAX_TRAIL) trail.shift();
        }
        if (tab === START) trail = [];
        current = tab;
        publish();
    }

    function canStep() {
        if (window.ModalManager && window.ModalManager.hasClosable()) return true;
        const cur = currentTab();
        return !!cur && cur !== START && typeof window.switchTab === 'function';
    }

    function step() {
        if (window.ModalManager && window.ModalManager.closeTopMostVisibleModal()) return true;
        const cur = currentTab();
        if (!cur || cur === START || typeof window.switchTab !== 'function') return false;
        const i = trailIndex(cur);
        const target = i >= 0 ? trail[i] : (window.AppNav ? window.AppNav.backTarget(cur) : START);
        trail.length = Math.max(i, 0);
        stepping = true;
        try { window.switchTab(target); } finally { stepping = false; }
        return true;
    }

    // force: report even when unchanged (a bfcache restore — the shell re-arms
    // its back callback on every navigation).
    function publish(force) {
        // A closing window tears the document down before its last mutations land.
        if (!window.document) {
            observers.forEach((o) => o.disconnect());
            observers = [];
            return;
        }
        const now = canStep();
        if (now === lastState && force !== true) return;
        lastState = now;
        try { window.NativeBack.setState(now); } catch (_) { /* no native layer (tests, shells) */ }
    }

    if (window.AppStore && typeof window.AppStore.subscribe === 'function') {
        window.AppStore.subscribe('currentTab', onTab);
    }
    try { window.NativeBack.onStep(step); } catch (_) { /* no native layer */ }

    // Modals open and close by class (mt-modal, #modal-overlay) or by mounting
    // on <body> (in-page dialogs, WGPages). Every full load reports once here.
    function watch() {
        const body = new MutationObserver(() => publish());
        body.observe(document.body, { childList: true });
        const modals = new MutationObserver((records) => {
            if (records.some((r) => r.target.tagName === 'MT-MODAL' || r.target.id === 'modal-overlay')) publish();
        });
        modals.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
        observers = [body, modals];
        publish();
    }
    document.body ? watch() : document.addEventListener('DOMContentLoaded', watch);
    window.addEventListener('pageshow', (e) => { if (e.persisted) publish(true); });

    window.AppBack = { step, canStep, ready };
})();
