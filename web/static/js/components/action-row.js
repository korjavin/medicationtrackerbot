// Shared action element factories: delete button and sync-pending badge.
// No dependencies.

/**
 * Create a standard delete button (×) for list items.
 *
 * @param {function} onDelete - Called when the button is clicked.
 * @returns {HTMLButtonElement}
 */
function createDeleteButton(onDelete) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'delete-btn';
    btn.title = 'Delete';
    btn.textContent = '×';
    btn.addEventListener('click', onDelete);
    return btn;
}

/**
 * Create a "Pending" sync badge shown on locally-queued items.
 *
 * @returns {HTMLSpanElement}
 */
function createSyncBadge() {
    const badge = document.createElement('span');
    badge.className = 'sync-pending-badge';
    badge.textContent = 'Pending';
    return badge;
}
