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
// with WGSheet.header(). The keyboard dock is global: while a virtual keyboard
// covers the bottom of the viewport, every open sheet gets .wg-scrim--kb and
// --wg-kb-h, so its body shrinks and the foot sits on top of the keyboard.
//
//   WGSheet.header({ eyebrow, title, actions: [{ label, primary?, icon?, attrs? }] })
//       icon: 'x' renders the icon-only close button, label as its aria-label
//       → <header class="wg-sheethead">; returns { el, buttons: [<button>…] }
//   WGSheet.dock()  re-measure now (also runs on visualViewport resize/scroll)

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

    // Height of the visual viewport's hidden bottom strip (the keyboard). 0 when
    // the layout viewport already shrank (Android resizes-content) or the user
    // is pinch-zoomed (scale > 1 also shrinks visualViewport.height).
    function keyboardHeight() {
        const vv = window.visualViewport;
        if (!vv || vv.scale > 1) return 0;
        return Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    }

    function dock() {
        const kb = keyboardHeight();
        for (const sheet of document.querySelectorAll('mt-modal.wg-sheet')) {
            const on = kb > 0 && !sheet.classList.contains('hidden');
            sheet.classList.toggle('wg-scrim--kb', on);
            // ponytail: a measured length, not a design value — the one
            // custom property the CSS reads (same pattern as wg-macro-bar).
            if (on) sheet.style.setProperty('--wg-kb-h', `${kb}px`);
            else sheet.style.removeProperty('--wg-kb-h');
        }
    }

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', dock);
        window.visualViewport.addEventListener('scroll', dock);
    }

    window.WGSheet = { header, dock };
})();
