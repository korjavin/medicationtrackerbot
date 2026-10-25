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
// would answer right now; NativeBack.setState hears it once on load and on
// every change (a modal opens or closes, the section changes).
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

    function onTab(tab) {
        if (!stepping && current && tab !== current && !(isHealth(current) && isHealth(tab))) {
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

    function publish() {
        const now = canStep();
        if (now === lastState) return;
        lastState = now;
        try { window.NativeBack.setState(now); } catch (_) { /* no native layer (tests, shells) */ }
    }

    if (window.AppStore && typeof window.AppStore.subscribe === 'function') {
        window.AppStore.subscribe('currentTab', onTab);
    }
    try { window.NativeBack.onStep(step); } catch (_) { /* no native layer */ }

    // Modals open and close by class (mt-modal, #modal-overlay) or by mounting
    // on <body> (in-page dialogs, WGPages).
    function watch() {
        new MutationObserver(publish).observe(document.body, { childList: true });
        new MutationObserver((records) => {
            if (records.some((r) => r.target.tagName === 'MT-MODAL' || r.target.id === 'modal-overlay')) publish();
        }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
        publish();
    }
    document.body ? watch() : document.addEventListener('DOMContentLoaded', watch);

    window.AppBack = { step, canStep };
})();
