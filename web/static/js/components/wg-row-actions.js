// WGRowActions — kit v2 row actions (med-xso6.9; kit components.html "Swipe"
// and "Overflow menu", kit rule 3). Replaces the per-row edit/delete icon
// buttons: a touch swipe left reveals Edit/Delete (.wg-swipe__acts), and an
// overflow "More" button opens a .wg-menu with the same actions — the
// pointer, keyboard and screen-reader path (Tab → Enter opens, arrows move,
// Esc closes and returns focus).
//
//   WGRowActions.attach(row, {
//       onEdit?, onDelete?,                 // called with the triggering event
//       extra?: [{ label, icon, onClick, danger }],   // menu-only actions
//       swipe?: [action],  // the swipe tray instead of Edit/Delete (also list them in extra)
//       label?,       // names the row for the More button ("More actions for …")
//       trail?,       // element the More button goes into (default: row)
//       tapEdits?,    // a tap on the row (outside its controls) → onEdit
//   }) → row
//
// The row itself becomes the swipe host (.wg-swipe.wg-swipe--host): its
// content slides left while the actions slide in, so row layout and
// selectors stay as they were. Deletes keep their own handler — the
// undo-from-toast path is deleteWithUndo inside it. One row is open at a time;
// scroll or a tap elsewhere closes it.
(function () {
    const SWIPE_MIN = 40; // px of horizontal travel before a swipe counts
    let openRow = null;   // the one row with its swipe or menu open
    let docBound = false;

    // Pure gesture math (unit-tested): horizontal-dominant travel past the
    // threshold opens (leftwards) or closes (rightwards); else no intent.
    function swipeIntent(dx, dy) {
        if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) <= Math.abs(dy)) return null;
        return dx < 0 ? 'open' : 'close';
    }

    function icon(name) {
        const ico = document.createElement('i');
        ico.className = 'wg-ico';
        ico.appendChild(window.WGIcons.iconSvg(name, { size: 18 }));
        return ico;
    }

    function close(row, focusTrigger) {
        if (!row) return;
        row.classList.remove('wg-swipe--open', 'wg-swipe--menu');
        const more = row._wgMore;
        if (more) {
            more.setAttribute('aria-expanded', 'false');
            if (focusTrigger) more.focus();
        }
        if (row._wgMenu) row._wgMenu.hidden = true;
        if (openRow === row) openRow = null;
    }

    function claim(row) {
        if (openRow && openRow !== row) close(openRow);
        openRow = row;
    }

    function bindDocument() {
        if (docBound) return;
        docBound = true;
        document.addEventListener('pointerdown', (e) => {
            if (openRow && !openRow.contains(e.target)) close(openRow);
        }, true);
        // Scroll closes a swiped-open row; an open menu stays (focusing its
        // items may scroll it into view) and closes on Esc / tap / focus out.
        window.addEventListener('scroll', () => {
            if (openRow && openRow.classList.contains('wg-swipe--open')) close(openRow);
        }, { capture: true, passive: true });
    }

    function run(row, fn, e) {
        e.preventDefault();
        e.stopPropagation();
        close(row);
        fn(e);
    }

    function attach(row, opts) {
        const o = opts || {};
        const edit = o.onEdit && { label: 'Edit', icon: 'pencil', onClick: o.onEdit };
        const del = o.onDelete && { label: 'Delete', icon: 'trash', onClick: o.onDelete, danger: true };
        // opts.swipe replaces the Edit/Delete tray (e.g. a plan's Copy/Remove);
        // those actions must also be in `extra` so the menu twin carries them.
        const swipeActs = o.swipe || [edit, del].filter(Boolean);
        const actions = [edit, ...(o.extra || []), del].filter(Boolean);
        bindDocument();

        row.classList.add('wg-swipe', 'wg-swipe--host');

        // Swipe tray — touch only; the menu below is the accessible twin, so
        // the tray stays out of the tab order and the a11y tree.
        if (swipeActs.length === 1) row.classList.add('wg-swipe--one');
        const acts = document.createElement('div');
        acts.className = 'wg-swipe__acts';
        acts.setAttribute('aria-hidden', 'true');
        swipeActs.forEach((a) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.tabIndex = -1;
            b.className = a.danger ? 'wg-swipe__act wg-swipe__act--danger' : 'wg-swipe__act';
            b.appendChild(icon(a.icon));
            b.appendChild(document.createTextNode(a.label));
            b.addEventListener('click', (e) => run(row, a.onClick, e));
            acts.appendChild(b);
        });
        row.appendChild(acts);

        // Overflow menu.
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'wg-btn wg-btn--ghost wg-btn--icon wg-swipe__more';
        more.setAttribute('aria-label', o.label ? `More actions for ${o.label}` : 'More actions');
        more.setAttribute('aria-haspopup', 'menu');
        more.setAttribute('aria-expanded', 'false');
        more.appendChild(icon('more'));
        (o.trail || row).appendChild(more);

        const menu = document.createElement('div');
        menu.className = 'wg-menu wg-swipe__menu';
        menu.setAttribute('role', 'menu');
        menu.hidden = true;
        actions.forEach((a) => {
            if (a.danger && menu.children.length) {
                const sep = document.createElement('div');
                sep.className = 'wg-menu__sep';
                sep.setAttribute('role', 'separator');
                menu.appendChild(sep);
            }
            const item = document.createElement('button');
            item.type = 'button';
            item.className = a.danger ? 'wg-menu__item wg-menu__item--danger' : 'wg-menu__item';
            item.setAttribute('role', 'menuitem');
            item.appendChild(icon(a.icon));
            item.appendChild(document.createTextNode(a.label));
            item.addEventListener('click', (e) => run(row, a.onClick, e));
            menu.appendChild(item);
        });
        row.appendChild(menu);
        row._wgMore = more;
        row._wgMenu = menu;

        // Clicks inside the menu never fall through to the row's own handler.
        menu.addEventListener('click', (e) => e.stopPropagation());
        more.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!menu.hidden) { close(row); return; }
            claim(row);
            row.classList.remove('wg-swipe--open');
            row.classList.add('wg-swipe--menu');
            menu.hidden = false;
            more.setAttribute('aria-expanded', 'true');
            const first = menu.querySelector('.wg-menu__item');
            if (first) first.focus();
        });
        row.addEventListener('keydown', (e) => {
            if (menu.hidden) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close(row, true);
                return;
            }
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            const items = Array.from(menu.querySelectorAll('.wg-menu__item'));
            const at = items.indexOf(document.activeElement);
            const next = items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
            if (next) { e.preventDefault(); next.focus(); }
        });
        // Focus leaving the row (Tab / Shift-Tab) closes. A null relatedTarget
        // (Safari blurs on tap without focusing the tapped button) is left to
        // the outside-pointerdown close.
        row.addEventListener('focusout', (e) => {
            if (!menu.hidden && e.relatedTarget && !row.contains(e.relatedTarget)) close(row);
        });

        // Touch swipe. A swipe (or a tap that just closes an open row)
        // swallows the click that follows, so it never also edits/opens.
        let start = null;
        let swallow = false;
        row.addEventListener('pointerdown', (e) => {
            swallow = false;
            if (e.pointerType === 'mouse' || e.target.closest('.wg-menu, .wg-swipe__acts')) return;
            start = { x: e.clientX, y: e.clientY, wasOpen: row.classList.contains('wg-swipe--open') };
        });
        row.addEventListener('pointerup', (e) => {
            if (!start) return;
            const intent = swipeIntent(e.clientX - start.x, e.clientY - start.y);
            if (intent === 'open' && swipeActs.length) {
                claim(row);
                row.classList.add('wg-swipe--open');
                swallow = true;
            } else if (intent === 'close' || start.wasOpen) {
                close(row);
                swallow = true;
            }
            start = null;
        });
        row.addEventListener('pointercancel', () => { start = null; });
        row.addEventListener('click', (e) => {
            if (!swallow) return;
            swallow = false;
            e.preventDefault();
            e.stopImmediatePropagation();
        }, true);

        if (o.tapEdits && o.onEdit) {
            row.addEventListener('click', (e) => {
                if (e.target.closest('button, a, input, select, textarea, .wg-tag')) return;
                o.onEdit(e);
            });
        }
        return row;
    }

    window.WGRowActions = { attach, swipeIntent };
})();
