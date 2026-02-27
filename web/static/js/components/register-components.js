if (window.customElements && !window.customElements.get('mt-modal')) {
    window.customElements.define('mt-modal', window.MTModal);
}

if (window.customElements && !window.customElements.get('mt-setting-toggle')) {
    window.customElements.define('mt-setting-toggle', window.MTSettingToggle);
}
