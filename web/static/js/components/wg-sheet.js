// WGSheet — the kit bottom sheet on <mt-modal> (med-xso6.7; kit components.html
// "Sheet header · form / flow", README rule 2).
//
// A sheet IS a modal: <mt-modal class="wg-modal wg-sheet"> opened and closed
// through ModalManager, so Back / Esc / popstate keep working. Markup:
//
//   .wg-sheet__grab
//   .wg-sheethead > .wg-sheethead__titles (.wg-eyebrow + .wg-sheethead__title)
//                 + .wg-sheethead__acts  (forms: Save/Log primary + the close X)
//   .wg-sheet__body                      (scrolls)
//   .wg-sheet__foot                      (optional; flows put their primary here)
//
// Static sheets author that markup in index.html; dynamic ones build the header
// with WGSheet.header(). The keyboard dock is global: every sheet and page
// tracks the visual viewport (--wg-vv-top / --wg-vv-h on the root), so a
// sheet's bottom sits on the keyboard, its header stays in view and only its
// body scrolls; while a keyboard is up, open sheets also get .wg-scrim--kb.
//
//   WGSheet.header({ eyebrow, title, actions: [{ label, primary?, icon?, attrs? }] })
//       icon: 'x' renders the icon-only close button, label as its aria-label
//       → <header class="wg-sheethead">; returns { el, buttons: [<button>…] }
//   WGSheet.dock()  re-measure now (also runs on visualViewport resize/scroll)
//   WGSheet.noFocusZoom()  iOS: no zoom-in on a focused field (runs at load)

(function () {
    function header(opts) {
        const o = opts || {};
        const doc = document;
        const el = doc.createElement('header');
        el.className = 'wg-sheethead';

        const titles = doc.createElement('div');
        titles.className = 'wg-sheethead__titles';
        if (o.eyebrow) {
            const eyebrow = doc.createElement('div');
            eyebrow.className = 'wg-eyebrow';
            eyebrow.textContent = o.eyebrow;
            titles.appendChild(eyebrow);
        }
        const title = doc.createElement('div');
        title.className = 'wg-sheethead__title';
        title.textContent = o.title || '';
        titles.appendChild(title);
        el.appendChild(titles);

        const buttons = [];
        if (o.actions && o.actions.length) {
            const acts = doc.createElement('div');
            acts.className = 'wg-sheethead__acts';
            for (const a of o.actions) {
                const btn = doc.createElement('button');
                btn.type = 'button';
                if (a.icon) {
                    // Icon-only (the close X): label becomes the aria-label.
                    btn.className = 'wg-btn wg-btn--ghost wg-btn--icon';
                    btn.setAttribute('aria-label', a.label);
                    const i = doc.createElement('i');
                    i.className = 'wg-ico';
                    i.setAttribute('data-icon', a.icon);
                    btn.appendChild(i);
                    if (window.WGIcons && typeof window.WGIcons.hydrate === 'function') window.WGIcons.hydrate(btn);
                } else {
                    btn.className = a.primary ? 'wg-btn wg-btn--primary wg-btn--sm' : 'wg-btn wg-btn--ghost wg-btn--sm';
                    btn.textContent = a.label;
                }
                for (const [k, v] of Object.entries(a.attrs || {})) btn.setAttribute(k, v);
                acts.appendChild(btn);
                buttons.push(btn);
            }
            el.appendChild(acts);
        }
        return { el, buttons };
    }

    // Sheets and pages are glued to the visual viewport (med-pe9g): the root
    // carries its top and height and the CSS positions .wg-sheet / .wg-page
    // from them. iOS WebKit (Safari and the app's WKWebView) never shrinks the
    // layout viewport for the keyboard — position:fixed and 100dvh keep the
    // full height while iOS pans the visual viewport over it — so a sheet
    // docked to the layout bottom runs under the keyboard and its header pans
    // off the top. Without the vars (no visualViewport, or pinch-zoomed: scale
    // > 1 shrinks the visual viewport too) the :root defaults (0px / 100dvh)
    // give the plain layout-viewport dock.
    function setVar(root, name, value) {
        if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
    }

    function dock() {
        const vv = window.visualViewport;
        const root = document.documentElement;
        const on = Boolean(vv) && !(vv.scale > 1);
        // ponytail: measured lengths, not design values — the custom
        // properties the CSS reads (same pattern as wg-macro-bar).
        if (on) {
            setVar(root, '--wg-vv-top', `${Math.round(vv.offsetTop)}px`);
            setVar(root, '--wg-vv-h', `${Math.round(vv.height)}px`);
        } else {
            root.style.removeProperty('--wg-vv-top');
            root.style.removeProperty('--wg-vv-h');
        }
        // Keyboard up = the visual viewport ends above the layout viewport's
        // bottom. clientHeight, not innerHeight: iOS reports innerHeight as the
        // visible height, so innerHeight - vv.height is ~0 there (why the old
        // innerHeight-based dock never engaged on iOS).
        const kb = on && Math.round(root.clientHeight - vv.height - vv.offsetTop) > 0;
        for (const sheet of document.querySelectorAll('mt-modal.wg-sheet')) {
            sheet.classList.toggle('wg-scrim--kb', kb && !sheet.classList.contains('hidden'));
        }
    }

    // iOS WebKit (Safari and the app's WKWebView) zooms the page in when a
    // field under 16px gets focus, and keeps that zoom after the keyboard
    // closes. Most fields here are 13–15px (.wg-input--text is 14px: the
    // food search zoomed to 16/14 ≈ 1.14). Zoomed, the visual viewport is
    // smaller than the layout one, dock() stands down (scale > 1) and a
    // sheet docked to the layout bottom runs past the screen: the header
    // above the top, the list under the keyboard (med-pe9g, TestFlight 178).
    // maximum-scale=1 stops the focus zoom. In the iOS app it also stops
    // double-tap and pinch zoom (the shell honours the cap, med-r6sh); Mobile
    // Safari ignores the cap for gestures, so pinch-zoom stays there. iOS
    // only: Android Chrome would honour it for pinch too.
    // -webkit-touch-callout exists only in iOS WebKit.
    function noFocusZoom() {
        const meta = document.querySelector('meta[name="viewport"]');
        const ios = Boolean(window.CSS && window.CSS.supports && window.CSS.supports('-webkit-touch-callout', 'none'));
        if (meta && ios && !/maximum-scale/.test(meta.content)) meta.content += ', maximum-scale=1';
    }
    noFocusZoom();

    // visualViewport scroll/resize fire many times per frame while iOS pans
    // for the keyboard: coalesce to one dock() per frame (med-08it).
    let frame = 0;
    function schedule() {
        if (frame) return;
        frame = window.requestAnimationFrame(() => { frame = 0; dock(); });
    }

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', schedule);
        window.visualViewport.addEventListener('scroll', schedule);
        dock();
    }

    window.WGSheet = { header, dock, schedule, noFocusZoom };
})();
