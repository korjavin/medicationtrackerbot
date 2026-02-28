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
        this._syncOverlay();
    }

    close() {
        const activeElement = document.activeElement;
        if (activeElement && this.contains(activeElement) && typeof activeElement.blur === 'function') {
            activeElement.blur();
        }
        this.classList.add('hidden');
        this.setAttribute('inert', '');
        this._syncOverlay();
    }

    _syncOverlay() {
        const overlay = document.getElementById('modal-overlay');
        if (!overlay) return;
        // Show overlay if any mt-modal is visible; hide if none are.
        const anyVisible = Array.from(document.querySelectorAll('mt-modal')).some(
            m => !m.classList.contains('hidden')
        );
        if (anyVisible) {
            overlay.classList.remove('hidden');
        } else {
            overlay.classList.add('hidden');
        }
    }
}
window.MTModal = MTModal;
