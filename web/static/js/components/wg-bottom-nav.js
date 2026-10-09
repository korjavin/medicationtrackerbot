// Wandergeek tab bar — canonical lateral navigation (App UI kit v2, N2).
// Five tabs in one row: Today · Food · Meds · Train · Health. Spec:
// docs/design/claude-design/ui_kits/app-v2/navigation.html.
//
// Tab ids are nav ids, not section ids. Most tabs map 1:1 onto a section
// (today/food/meds/workouts — "Train" is only the label); the Health tab
// ('health-group') owns the bp / weight / health(Vitals) sections, so it
// highlights for any of them. Settings and Journey are not tabs: they open
// from the app-bar gear / Today route icon (features/app-nav.js).
//
// API:
//   WGBottomNav.mount(rootEl, { items, active, onChange }) → controller
//     items:    Array<{ id, label, icon, sections? }> — icon looked up in WGIcons
//     active:   section id (or tab id) to highlight initially
//     onChange: called with the tapped tab's id ('health-group' for Health)
//     controller: { root, setActive(sectionOrId), getActive(), setBadge(id, n), destroy() }
//   WGBottomNav.DEFAULT_ITEMS — canonical tab order; consumers filter it by
//                               feature flags before mounting.
//   WGBottomNav.itemFor(items, sectionOrId) — the tab that owns a section.
//   WGBottomNav.setBadge(id, n) — badge count on a tab (0/blank clears); the
//                                 count survives a re-mount.
//
// Styling: kit .wg-tabbar / .wg-tab / .wg-tab__badge (components.css). The
// one inline value is `--n` (column count), a structural variable the kit
// reserves for exactly this (kit README rule 5).

(function () {
    const DEFAULT_ITEMS = Object.freeze([
        { id: 'today', label: 'Today', icon: 'home' },
        { id: 'food', label: 'Food', icon: 'food' },
        { id: 'meds', label: 'Meds', icon: 'pill' },
        { id: 'workouts', label: 'Train', icon: 'dumbbell' },
        { id: 'health-group', label: 'Health', icon: 'health', sections: Object.freeze(['bp', 'weight', 'health']) },
    ]);

    // Badge counts by tab id, kept across re-mounts (feature toggles rebuild
    // the bar). Closure-private.
    const badges = new Map();
    const mounted = new Set();

    function itemFor(items, id) {
        if (!id) return null;
        return items.find((it) => it.id === id)
            || items.find((it) => Array.isArray(it.sections) && it.sections.indexOf(id) !== -1)
            || null;
    }

    function paintBadge(btn, n) {
        let el = btn.querySelector('.wg-tab__badge');
        if (!n) {
            if (el) el.remove();
            return;
        }
        if (!el) {
            el = document.createElement('span');
            el.className = 'wg-tab__badge';
            btn.appendChild(el);
        }
        el.textContent = n > 99 ? '99+' : String(n);
    }

    function buildTab(item) {
        if (!window.WGIcons || typeof window.WGIcons.iconSvg !== 'function') {
            throw new Error('WGBottomNav.mount: WGIcons must be loaded before wg-bottom-nav.js');
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wg-tab';
        btn.dataset.navId = item.id;
        const ico = document.createElement('i');
        ico.className = 'wg-ico';
        ico.dataset.icon = item.icon;
        ico.appendChild(window.WGIcons.iconSvg(item.icon));
        btn.appendChild(ico);
        btn.appendChild(document.createTextNode(item.label));
        paintBadge(btn, badges.get(item.id));
        return btn;
    }

    function mountBottomNav(rootEl, opts) {
        if (!rootEl || !(rootEl instanceof Element)) {
            throw new TypeError('WGBottomNav.mount: rootEl must be an Element');
        }
        const options = opts || {};
        const items = Array.isArray(options.items) && options.items.length > 0
            ? options.items
            : DEFAULT_ITEMS.slice();

        const nav = document.createElement('nav');
        nav.className = 'wg-tabbar';
        nav.setAttribute('aria-label', 'Primary');
        // --n is the kit's structural column-count variable, not a visual value.
        nav.style.setProperty('--n', String(items.length));

        const buttonsById = new Map();
        for (const item of items) {
            const btn = buildTab(item);
            buttonsById.set(item.id, btn);
            nav.appendChild(btn);
        }

        let activeId = null;
        function setActive(sectionOrId) {
            const item = itemFor(items, sectionOrId);
            activeId = item ? item.id : null;
            for (const [btnId, btn] of buttonsById) {
                if (btnId === activeId) btn.setAttribute('aria-current', 'page');
                else btn.removeAttribute('aria-current');
            }
        }
        if (options.active) setActive(options.active);

        const onChange = typeof options.onChange === 'function' ? options.onChange : null;
        function handleClick(event) {
            const btn = event.target.closest('.wg-tab');
            if (!btn || !nav.contains(btn)) return;
            const id = btn.dataset.navId;
            if (!id) return;
            setActive(id);
            if (onChange) onChange(id);
        }
        nav.addEventListener('click', handleClick);

        rootEl.appendChild(nav);

        const ctrl = {
            root: nav,
            setActive,
            getActive: () => activeId,
            setBadge(id, n) {
                const btn = buttonsById.get(id);
                if (btn) paintBadge(btn, n);
            },
            destroy() {
                nav.removeEventListener('click', handleClick);
                mounted.delete(ctrl);
                if (nav.parentNode) nav.parentNode.removeChild(nav);
            },
        };
        mounted.add(ctrl);
        return ctrl;
    }

    function setBadge(id, n) {
        const count = Number(n) > 0 ? Math.floor(Number(n)) : 0;
        if (count) badges.set(id, count);
        else badges.delete(id);
        for (const ctrl of mounted) ctrl.setBadge(id, count);
    }

    window.WGBottomNav = {
        mount: mountBottomNav,
        DEFAULT_ITEMS,
        itemFor,
        setBadge,
    };
})();
