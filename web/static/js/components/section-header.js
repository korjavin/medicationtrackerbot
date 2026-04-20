// Shared section-header factory: Wandergeek app header with a gloss back pill,
// centered JetBrains-Mono title (+ optional uppercase caps subtitle), and
// optional right slot. Used by every non-Today view and by Today itself
// (without a back button).
//
// Dual-classed: emits both the legacy `.section-header` class (for sticky
// positioning + badge styles + Today-view compatibility) and the new
// `.wg-app-header` class (for the Wandergeek visual reskin).
//
// No dependencies.

(function () {
    /**
     * Create a section header element.
     *
     * @param {object} opts
     * @param {string} opts.title                       - Visible section title.
     * @param {string} [opts.subtitle]                  - Optional uppercase caps line rendered as <small>.
     * @param {function|null} [opts.onBack]             - Called when back pressed.
     *                                                    Pass null/omit to hide back button (Today variant).
     * @param {Node|string|null} [opts.rightSlot]       - Element or text placed on the right.
     * @returns {HTMLElement}
     */
    function createSectionHeader({ title, subtitle, onBack, rightSlot } = {}) {
        const header = document.createElement('header');
        header.className = 'section-header wg-app-header';
        if (!onBack) {
            header.classList.add('no-back');
            header.classList.add('wg-app-header--no-back');
        }

        const backBtn = document.createElement('button');
        backBtn.type = 'button';
        backBtn.className = 'section-back wg-icon-btn';
        backBtn.setAttribute('aria-label', 'Back to Today');
        backBtn.innerHTML = '<span class="wg-gloss"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></span>';
        if (typeof onBack === 'function') {
            backBtn.addEventListener('click', onBack);
        }
        header.appendChild(backBtn);

        const titleEl = document.createElement('h2');
        titleEl.className = 'section-title wg-app-header__title';
        titleEl.textContent = title || '';
        if (typeof subtitle === 'string' && subtitle.length > 0) {
            const sub = document.createElement('small');
            sub.textContent = subtitle;
            titleEl.appendChild(sub);
        }
        header.appendChild(titleEl);

        const rightEl = document.createElement('div');
        rightEl.className = 'section-header-right wg-app-header__right';
        if (rightSlot instanceof Node) {
            rightEl.appendChild(rightSlot);
        } else if (typeof rightSlot === 'string' && rightSlot.length > 0) {
            rightEl.textContent = rightSlot;
        }
        header.appendChild(rightEl);

        return header;
    }

    window.SectionHeader = { create: createSectionHeader };
})();
