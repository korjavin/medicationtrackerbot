// Shared section-header factory: sticky header with back-to-Today button,
// centered title, and optional right slot.
// Used by every non-Today view and by Today itself (without a back button).
// No dependencies.

(function () {
    /**
     * Create a sticky section header element.
     *
     * @param {object} opts
     * @param {string} opts.title                       - Visible section title.
     * @param {function|null} [opts.onBack]             - Called when back pressed.
     *                                                    Pass null/omit to hide back button (Today variant).
     * @param {Node|string|null} [opts.rightSlot]       - Element or text placed on the right.
     * @returns {HTMLElement}
     */
    function createSectionHeader({ title, onBack, rightSlot } = {}) {
        const header = document.createElement('header');
        header.className = 'section-header';
        if (!onBack) {
            header.classList.add('no-back');
        }

        const backBtn = document.createElement('button');
        backBtn.type = 'button';
        backBtn.className = 'section-back btn btn-icon';
        backBtn.setAttribute('aria-label', 'Back to Today');
        backBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg><span class="section-back-label">Today</span>';
        if (typeof onBack === 'function') {
            backBtn.addEventListener('click', onBack);
        }
        header.appendChild(backBtn);

        const titleEl = document.createElement('h2');
        titleEl.className = 'section-title';
        titleEl.textContent = title || '';
        header.appendChild(titleEl);

        const rightEl = document.createElement('div');
        rightEl.className = 'section-header-right';
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
