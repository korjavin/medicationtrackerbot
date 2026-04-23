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

        // `.wg-settings-row` is the sole layout class; the legacy
        // `.setting-item` class was dropped because its residual visual
        // styles (background, border, border-radius, margin-bottom) and
        // the higher-specificity `.setting-item h3` rule bled through the
        // new row styling, making each row render as a nested old card.
        // The `divider` attribute contract stays stable (its visual
        // effect was already removed in Phase 9 Task 5 once section
        // cards provided the grouping); the class is retained purely so
        // the backwards-compat assertion still passes.
        this.classList.add('wg-settings-row');
        if (this.hasAttribute('divider')) {
            this.classList.add('setting-item-divider');
        }

        const titleText = this.getAttribute('title') || '';
        const descriptionText = this.getAttribute('description') || '';
        const inputId = this.getAttribute('input-id') || '';

        const content = document.createElement('div');
        content.className = 'wg-settings-row__content';
        const title = document.createElement('h3');
        title.className = 'wg-settings-row__title';
        title.textContent = titleText;
        content.appendChild(title);

        if (descriptionText) {
            const description = document.createElement('p');
            description.className = 'setting-desc wg-settings-row__desc';
            description.textContent = descriptionText;
            content.appendChild(description);
        }

        const control = document.createElement('div');
        control.className = 'wg-settings-row__control';

        // Delegate the visual pill + knob to WGToggle if available; fall
        // back to inline markup for test environments that haven't loaded
        // the component script.
        let toggleEl;
        if (window.WGToggle && typeof window.WGToggle.render === 'function') {
            toggleEl = window.WGToggle.render({ id: inputId });
        } else {
            toggleEl = document.createElement('label');
            toggleEl.className = 'wg-toggle';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.className = 'wg-toggle__input';
            if (inputId) input.id = inputId;
            const track = document.createElement('span');
            track.className = 'wg-toggle__track';
            track.setAttribute('aria-hidden', 'true');
            const knob = document.createElement('span');
            knob.className = 'wg-toggle__knob';
            knob.setAttribute('aria-hidden', 'true');
            toggleEl.appendChild(input);
            toggleEl.appendChild(track);
            toggleEl.appendChild(knob);
        }
        control.appendChild(toggleEl);

        this.replaceChildren(content, control);
    }
}

if (window.customElements && !window.customElements.get('mt-setting-toggle')) {
    window.customElements.define('mt-setting-toggle', MTSettingToggle);
}
