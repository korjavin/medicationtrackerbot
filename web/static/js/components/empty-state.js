// Shared empty / error / loading state factories — the kit anatomy from
// docs/design/claude-design/ui_kits/app-v2/components.html (.wg-empty,
// .wg-error, .wg-skel; CSS in css/components.css). Icons come from
// window.WGIcons when it is loaded (resolved at call time, so script order
// does not matter); without it the icon slot is simply omitted.

function _stateIcon(name, size) {
    if (!name || !window.WGIcons || typeof window.WGIcons.iconSvg !== 'function') return null;
    try { return window.WGIcons.iconSvg(name, { size }); } catch (_) { return null; }
}

/**
 * Empty state: icon + title + body + actions. Copy should name the next step
 * ("Log your first reading" + a Log action), never a bare "No data".
 *
 * @param {object} opts
 * @param {string} [opts.icon]     - WGIcons name.
 * @param {string} opts.title
 * @param {string} [opts.body]
 * @param {Array<{label:string, onClick:Function, variant?:string, icon?:string}>} [opts.actions]
 *        variant → `wg-btn--<variant>`; default is a plain .wg-btn because the
 *        view's own toolbar usually already owns the one sun primary.
 * @param {boolean} [opts.inline]  - .wg-empty--inline (row layout, for cards/lists).
 * @param {string} [opts.tag='div'] - 'li' when mounted inside a <ul>.
 * @returns {HTMLElement}
 */
function createEmptyState({ icon, title, body, actions, inline, tag = 'div' } = {}) {
    const el = document.createElement(tag);
    el.className = inline ? 'wg-empty wg-empty--inline' : 'wg-empty';
    const svg = _stateIcon(icon, inline ? 20 : 28);
    if (svg) {
        const slot = document.createElement('span');
        slot.className = 'wg-empty__icon';
        slot.appendChild(svg);
        el.appendChild(slot);
    }
    // Inline layout puts the text in a column beside the icon.
    const text = inline ? document.createElement('div') : el;
    if (inline) { text.className = 'wg-vstack'; el.appendChild(text); }
    const t = document.createElement('p');
    t.className = 'wg-empty__title';
    t.textContent = title || '';
    text.appendChild(t);
    if (body) {
        const b = document.createElement('p');
        b.className = 'wg-empty__body';
        b.textContent = body;
        text.appendChild(b);
    }
    if (actions && actions.length) {
        const acts = document.createElement('div');
        acts.className = 'wg-empty__acts';
        actions.forEach((a) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = a.variant ? `wg-btn wg-btn--${a.variant}` : 'wg-btn';
            const ico = _stateIcon(a.icon, 14);
            if (ico) btn.appendChild(ico);
            btn.appendChild(document.createTextNode(a.label));
            btn.addEventListener('click', a.onClick);
            acts.appendChild(btn);
        });
        text.appendChild(acts);
    }
    return el;
}

/**
 * The offline cold-start state (no cache yet, network down) — one wording
 * for every surface.
 */
function createOfflineEmptyState({ tag = 'div' } = {}) {
    return createEmptyState({
        icon: 'cloud-off',
        title: 'No cached data yet',
        body: 'This loads once you are back online.',
        inline: true,
        tag,
    });
}

/**
 * Error line with an optional Retry button.
 * @param {string} message
 * @param {Function} [retry]
 * @param {object} [opts]
 * @param {string} [opts.tag='div']
 */
function createErrorState(message, retry, { tag = 'div' } = {}) {
    const el = document.createElement(tag);
    el.className = 'wg-error';
    el.setAttribute('role', 'alert');
    const svg = _stateIcon('alert', 14);
    if (svg) el.appendChild(svg);
    const span = document.createElement('span');
    span.textContent = message;
    el.appendChild(span);
    if (typeof retry === 'function') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wg-btn wg-btn--sm';
        btn.textContent = 'Retry';
        btn.addEventListener('click', retry);
        el.appendChild(btn);
    }
    return el;
}

/**
 * Loading skeleton: `count` shimmer blocks of one kind in an aria-busy stack.
 * @param {'line'|'title'|'tile'|'card'|'row'} [kind='line']
 * @param {number} [count=3]
 */
function createSkeleton(kind = 'line', count = 3) {
    const el = document.createElement('div');
    el.className = 'wg-skel-stack';
    el.setAttribute('aria-busy', 'true');
    el.setAttribute('aria-label', 'Loading');
    for (let i = 0; i < count; i++) {
        const s = document.createElement('span');
        s.className = `wg-skel wg-skel--${kind}`;
        el.appendChild(s);
    }
    return el;
}
