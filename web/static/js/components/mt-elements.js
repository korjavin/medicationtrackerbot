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

        this.classList.add('setting-item');
        if (this.hasAttribute('divider')) {
            this.classList.add('setting-item-divider');
        }

        const titleText = this.getAttribute('title') || '';
        const descriptionText = this.getAttribute('description') || '';
        const inputId = this.getAttribute('input-id') || '';

        const content = document.createElement('div');
        const title = document.createElement('h3');
        title.textContent = titleText;
        content.appendChild(title);

        if (descriptionText) {
            const description = document.createElement('p');
            description.className = 'setting-desc';
            description.textContent = descriptionText;
            content.appendChild(description);
        }

        const toggle = document.createElement('label');
        toggle.className = 'toggle';
        const input = document.createElement('input');
        input.type = 'checkbox';
        if (inputId) input.id = inputId;
        const slider = document.createElement('span');
        slider.className = 'toggle-slider';
        toggle.appendChild(input);
        toggle.appendChild(slider);

        this.replaceChildren(content, toggle);
    }
}

if (window.customElements && !window.customElements.get('mt-setting-toggle')) {
    window.customElements.define('mt-setting-toggle', MTSettingToggle);
}
