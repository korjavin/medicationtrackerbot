// WGChip — kit v2 status chip (components.css `.wg-chip`). Status is shown
// only through the five state modifiers; never emoji (kit rule 4).
//
//   WGChip.create({ text, state, small, icon, title }) → <span class="wg-chip …">
//     state: 'ok' | 'warn' | 'danger' | 'stale' | 'pending' (omit for neutral)
//     icon:  optional WGIcons name rendered as a leading .wg-ico
//   WGChip.sync(row) → the row's sync chip, or null when the row is synced.
//     Rejected (isRejected / errorMessage) → danger "Sync failed" + tooltip;
//     queued (isLocal / pending / _optimistic) → pending "Pending".
(function () {
    const STATES = ['ok', 'warn', 'danger', 'stale', 'pending'];

    function create({ text, state, small, icon, title } = {}) {
        if (state && !STATES.includes(state)) {
            throw new Error(`WGChip.create: unknown state "${state}"`);
        }
        const chip = document.createElement('span');
        chip.className = 'wg-chip';
        if (state) chip.classList.add(`wg-chip--${state}`);
        if (small) chip.classList.add('wg-chip--sm');
        if (icon && window.WGIcons) {
            const ico = document.createElement('i');
            ico.className = 'wg-ico';
            ico.appendChild(window.WGIcons.iconSvg(icon));
            chip.appendChild(ico);
        }
        chip.appendChild(document.createTextNode(String(text == null ? '' : text)));
        if (title) chip.title = title;
        return chip;
    }

    function sync(row) {
        if (!row) return null;
        if (row.isRejected || row.errorMessage) {
            return create({ text: 'Sync failed', state: 'danger', small: true, icon: 'refresh', title: row.errorMessage });
        }
        if (row.isLocal || row.pending || row._optimistic) {
            return create({ text: 'Pending', state: 'pending', small: true, icon: 'cloud-up' });
        }
        return null;
    }

    window.WGChip = { create, sync };
})();
