// Custom element definitions for the Med Tracker UI.
// Loaded before app.js — no dependencies on other app files.

class MTModal extends HTMLElement {
    connectedCallback() {
        if (!this.hasAttribute('role')) this.setAttribute('role', 'dialog');
        if (!this.hasAttribute('aria-modal')) this.setAttribute('aria-modal', 'true');
        if (this.classList.contains('hidden')) {
            this.setAttribute('inert', '');
        } else {
            this.removeAttribute('inert');
        }
    }

    open() {
        this.classList.remove('hidden');
        this.removeAttribute('inert');
    }

    close() {
        const activeElement = document.activeElement;
        if (activeElement && this.contains(activeElement) && typeof activeElement.blur === 'function') {
            activeElement.blur();
        }
        this.classList.add('hidden');
        this.setAttribute('inert', '');
    }
}

if (window.customElements && !window.customElements.get('mt-modal')) {
    window.customElements.define('mt-modal', MTModal);
}

class MTSettingToggle extends HTMLElement {
    connectedCallback() {
        if (this.dataset.initialized === 'true') return;
        this.dataset.initialized = 'true';

        // Kit .wg-setting row (med-xso6.23; components.html "Setting row"):
        // optional lead icon, title + description, trailing .wg-toggle. The
        // `divider` attribute keeps its legacy .setting-item-divider class.
        this.classList.add('wg-setting');
        if (this.hasAttribute('divider')) {
            this.classList.add('setting-item-divider');
        }

        const titleText = this.getAttribute('title') || '';
        const descriptionText = this.getAttribute('description') || '';
        const inputId = this.getAttribute('input-id') || '';
        const iconName = this.getAttribute('icon') || '';
        // The title attribute would otherwise show as a hover tooltip on the row.
        this.removeAttribute('title');
        this.dataset.title = titleText;

        const parts = [];
        if (iconName) {
            const lead = document.createElement('span');
            lead.className = 'wg-row__lead';
            const ico = document.createElement('i');
            ico.className = 'wg-ico';
            ico.dataset.icon = iconName;
            lead.appendChild(ico);
            parts.push(lead);
        }

        const body = document.createElement('span');
        body.className = 'wg-setting__body';
        const title = document.createElement('span');
        title.className = 'wg-setting__title';
        title.textContent = titleText;
        body.appendChild(title);
        if (descriptionText) {
            const description = document.createElement('span');
            description.className = 'wg-setting__desc';
            description.textContent = descriptionText;
            body.appendChild(description);
        }
        parts.push(body);

        // Delegate the visual pill + knob to WGToggle if available; fall
        // back to inline markup for test environments that haven't loaded
        // the component script.
        let toggleEl;
        if (window.WGToggle && typeof window.WGToggle.render === 'function') {
            toggleEl = window.WGToggle.render({ id: inputId, ariaLabel: titleText });
        } else {
            toggleEl = document.createElement('label');
            toggleEl.className = 'wg-toggle';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.className = 'wg-toggle__input';
            if (inputId) input.id = inputId;
            if (titleText) input.setAttribute('aria-label', titleText);
            toggleEl.appendChild(input);
        }
        parts.push(toggleEl);

        this.replaceChildren(...parts);
    }
}

if (window.customElements && !window.customElements.get('mt-setting-toggle')) {
    window.customElements.define('mt-setting-toggle', MTSettingToggle);
}
