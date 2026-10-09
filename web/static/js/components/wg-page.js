// WGPage — pushed full-screen page with the kit page bar (med-xso6.8; kit
// components.html "Page bar · pushed sub-page"). It replaces modal-on-modal for
// nested editors (Plan → Day → Exercise, Meds editor, Settings subpages).
//
// A page IS a modal: it is an <mt-modal class="wg-page"> on the ModalManager
// stack, so Back / Esc / popstate close the topmost page only, and
// #modal-overlay stays up until the last page closes.
//
//   const page = WGPage.push({
//       title, crumb?, back? = 'Back',      // back = the parent page's name
//       body,                               // Node placed in the scrolling .wg-content
//       primary?: { label: 'Save'|'Done', onClick },
//       onBack?,   // Back chevron / Esc / popstate; return false (or a promise
//                  // of false) to keep the page open (e.g. unsaved draft)
//       onClose?,  // after the page is gone, however it closed
//   });
//   page.close(); page.setPrimaryEnabled(bool); page.el
//
// Screens own what Save/Done do (root Save writes via DataStore.applyOptimistic).

(function () {
    let seq = 0;

    function push(opts) {
        const o = opts || {};
        const doc = document;
        const id = `wg-page-${++seq}`;
        const returnFocus = doc.activeElement;

        const page = doc.createElement('mt-modal');
        page.id = id;
        page.className = 'wg-page';
        page.setAttribute('aria-label', o.title || '');

        const bar = doc.createElement('header');
        bar.className = 'wg-pagebar';

        const backBtn = doc.createElement('button');
        backBtn.type = 'button';
        backBtn.className = 'wg-back';
        const ico = doc.createElement('i');
        ico.className = 'wg-ico';
        ico.dataset.icon = 'chev-l';
        backBtn.append(ico, o.back || 'Back');

        const center = doc.createElement('div');
        center.className = 'wg-pagebar__center';
        if (o.crumb) {
            const crumb = doc.createElement('div');
            crumb.className = 'wg-pagebar__crumb';
            crumb.textContent = o.crumb;
            center.appendChild(crumb);
        }
        const title = doc.createElement('div');
        title.className = 'wg-pagebar__title';
        title.textContent = o.title || '';
        center.appendChild(title);

        // The page bar is a 3-column grid; an empty cell keeps the title centred.
        let primaryBtn = null;
        let end = doc.createElement('span');
        if (o.primary) {
            primaryBtn = doc.createElement('button');
            primaryBtn.type = 'button';
            primaryBtn.className = 'wg-btn wg-btn--primary wg-btn--sm';
            primaryBtn.textContent = o.primary.label || 'Save';
            primaryBtn.addEventListener('click', () => {
                if (typeof o.primary.onClick === 'function') o.primary.onClick();
            });
            end = primaryBtn;
        }
        bar.append(backBtn, center, end);

        const content = doc.createElement('div');
        content.className = 'wg-content';
        if (o.body) content.appendChild(o.body);
        page.append(bar, content);

        let closed = false;
        function close() {
            if (closed) return;
            closed = true;
            window.ModalManager.close(id);
            page.remove();
            if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') {
                returnFocus.focus();
            }
            if (typeof o.onClose === 'function') o.onClose();
        }

        function back() {
            const r = typeof o.onBack === 'function' ? o.onBack() : undefined;
            if (r && typeof r.then === 'function') {
                r.then((ok) => { if (ok !== false) close(); });
            } else if (r !== false) {
                close();
            }
        }
        backBtn.addEventListener('click', back);

        doc.body.appendChild(page);
        if (window.WGIcons && typeof window.WGIcons.hydrate === 'function') window.WGIcons.hydrate(page);
        window.ModalManager.register(id, back);
        window.ModalManager.open(id);
        backBtn.focus();

        return {
            el: page,
            close,
            setPrimaryEnabled(on) {
                if (primaryBtn) primaryBtn.disabled = !on;
            },
        };
    }

    window.WGPage = { push };
})();
