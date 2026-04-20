// Wandergeek bottom nav — canonical lateral navigation.
// One slot per real section (Today, BP, Food, Meds, Weight, Workouts, Health,
// Settings). No "More" aggregator; every section is a first-class destination.
// Wraps into two rows when item count exceeds what fits comfortably in one
// row (5 per row at the 390px phone width).
//
// API:
//   WGBottomNav.mount(rootEl, { items, active, onChange }) → { root, setActive, destroy }
//   - items:   Array<{ id, label, icon }> — icon name is looked up in WGIcons
//   - active:  id of the initially-active slot (optional)
//   - onChange(id): called on click with the slot's id
//   WGBottomNav.DEFAULT_ITEMS — the canonical 8-slot ordering; consumers may
//                               filter it by feature flags before passing.
//
// Styling: all visuals come from CSS classes on `.wg-bottom-nav` and
// `.wg-nav-item`. The one exception is `--wg-nav-cols` which is set via
// `style.setProperty` on `.wg-bottom-nav__inner` because column count is
// a structural variable (depends on items.length), not a visual constant.
// Allowlisted in architecture.no-inline-styles.test.js (when that test lands).

(function () {
    const DEFAULT_ITEMS = Object.freeze([
        { id: 'today', label: 'Today', icon: 'home' },
        { id: 'bp', label: 'BP', icon: 'activity' },
        { id: 'food', label: 'Food', icon: 'apple' },
        { id: 'meds', label: 'Meds', icon: 'pill' },
        { id: 'weight', label: 'Weight', icon: 'scale' },
        { id: 'workouts', label: 'Workouts', icon: 'dumbbell' },
        { id: 'health', label: 'Health', icon: 'heart' },
        { id: 'settings', label: 'Settings', icon: 'settings' },
    ]);

    // Layout rule: ≤5 items → one row; 6–8 items → two rows; >8 is out of
    // scope for this plan (returns null to surface misuse in tests).
    function colsFor(count) {
        if (count <= 0) return null;
        if (count <= 5) return count;
        if (count <= 8) return Math.ceil(count / 2);
        return null;
    }

    function buildItemButton(item) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wg-nav-item';
        btn.dataset.navId = item.id;
        btn.setAttribute('aria-label', item.label);

        if (!window.WGIcons || typeof window.WGIcons.iconSvg !== 'function') {
            throw new Error('WGBottomNav.mount: WGIcons must be loaded before wg-bottom-nav.js');
        }
        const svg = window.WGIcons.iconSvg(item.icon, { size: 22, stroke: 1.8 });
        btn.appendChild(svg);

        const label = document.createElement('span');
        label.className = 'wg-nav-item__label';
        label.textContent = item.label;
        btn.appendChild(label);

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
        const cols = colsFor(items.length);
        if (cols === null) {
            throw new RangeError(`WGBottomNav.mount: unsupported items.length=${items.length} (must be 1–8)`);
        }

        const nav = document.createElement('nav');
        nav.className = 'wg-bottom-nav';
        nav.setAttribute('aria-label', 'Primary');

        const inner = document.createElement('div');
        inner.className = 'wg-bottom-nav__inner';
        // --wg-nav-cols is a structural variable, not a visual value; allowlisted.
        inner.style.setProperty('--wg-nav-cols', String(cols));
        nav.appendChild(inner);

        const buttonsById = new Map();
        for (const item of items) {
            const btn = buildItemButton(item);
            buttonsById.set(item.id, btn);
            inner.appendChild(btn);
        }

        let activeId = options.active || null;
        function setActive(id) {
            activeId = id;
            for (const [btnId, btn] of buttonsById) {
                const isActive = btnId === id;
                btn.classList.toggle('wg-nav-item--active', isActive);
                if (isActive) {
                    btn.setAttribute('aria-current', 'page');
                } else {
                    btn.removeAttribute('aria-current');
                }
            }
        }
        if (activeId) setActive(activeId);

        const onChange = typeof options.onChange === 'function' ? options.onChange : null;
        function handleClick(event) {
            const btn = event.target.closest('.wg-nav-item');
            if (!btn || !inner.contains(btn)) return;
            const id = btn.dataset.navId;
            if (!id) return;
            setActive(id);
            if (onChange) onChange(id);
        }
        inner.addEventListener('click', handleClick);

        rootEl.appendChild(nav);

        return {
            root: nav,
            setActive,
            getActive: () => activeId,
            destroy() {
                inner.removeEventListener('click', handleClick);
                if (nav.parentNode) nav.parentNode.removeChild(nav);
            },
        };
    }

    window.WGBottomNav = {
        mount: mountBottomNav,
        DEFAULT_ITEMS,
        _colsFor: colsFor,
    };
})();
