if (window.customElements && !window.customElements.get('mt-modal')) {
    window.customElements.define('mt-modal', window.MTModal);
}

if (window.customElements && !window.customElements.get('mt-setting-toggle')) {
    window.customElements.define('mt-setting-toggle', window.MTSettingToggle);
}

if (window.customElements && !window.customElements.get('mt-tab-group')) {
    window.customElements.define('mt-tab-group', window.MTTabGroup);
}

if (window.customElements && !window.customElements.get('mt-day-picker')) {
    window.customElements.define('mt-day-picker', window.MTDayPicker);
}
