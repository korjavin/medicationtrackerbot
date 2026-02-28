class MTTabGroup extends HTMLElement {
    connectedCallback() {
        if (this.dataset.initialized === 'true') return;
        this.dataset.initialized = 'true';

        this.activeClass = this.getAttribute('active-class') || 'active';

        this.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-tab]');
            if (!btn) return;
            // Ensure the tab belongs to this group
            if (btn.closest('mt-tab-group') !== this) return;

            const tabId = btn.getAttribute('data-tab');
            if (tabId) {
                // If the event should be cancelable, we could check event.preventDefault()
                const event = new CustomEvent('tabchange', {
                    detail: { tabId },
                    cancelable: true
                });
                const allowed = this.dispatchEvent(event);

                if (allowed) {
                    this.setActiveTab(tabId);
                }
            }
        });
    }

    setActiveTab(tabId) {
        const tabs = this.querySelectorAll('[data-tab]');
        tabs.forEach(t => {
            if (t.closest('mt-tab-group') !== this) return;
            if (t.getAttribute('data-tab') === tabId) {
                t.classList.add(this.activeClass);
            } else {
                t.classList.remove(this.activeClass);
            }
        });
    }
}
window.MTTabGroup = MTTabGroup;
