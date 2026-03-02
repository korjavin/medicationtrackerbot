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
window.MTSettingToggle = MTSettingToggle;
