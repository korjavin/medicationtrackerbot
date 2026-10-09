// Shared row action button factories (edit / delete). Icons come from
// WGIcons at call time; sync state chips live in components/wg-chip.js.

function _actionRowButton(className, title, iconName, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.appendChild(window.WGIcons.iconSvg(iconName, { size: 16 }));
    btn.addEventListener('click', onClick);
    return btn;
}

/** Standard delete button (trash icon) for list items. */
function createDeleteButton(onDelete) {
    return _actionRowButton('icon-action-btn delete', 'Delete', 'trash', onDelete);
}

/** Standard edit button (pencil icon) for list items. */
function createEditButton(onClick) {
    return _actionRowButton('icon-action-btn', 'Edit', 'pencil', onClick);
}
