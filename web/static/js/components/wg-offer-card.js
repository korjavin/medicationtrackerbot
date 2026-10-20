// WGOfferCard — the one AI-trial offer shape (kit A1, screens-today.html):
// an accent card with a sparkle lead, a title, a mono meta line, one
// sentence and its action(s). Today, Settings → AI & integrations and the
// onboarding trial step (med-ta2n.2) all build it here, so the three never
// drift apart again (med-ckm5.10).
//
//   WGOfferCard.create({
//     title, meta, text,          // strings; meta is the mono line under the title
//     lead,                       // icon name, default 'sparkle'
//     trail,                      // optional Node at the top right (e.g. an "On" chip)
//     onDismiss,                  // optional: an × icon button at the top right ("Not now")
//     body,                       // optional Node[] between the sentence and the actions
//     actions: [{ label, icon, ghost, sm, primary, action, onClick }],
//                                 // block buttons; raised by default (never sun unless asked)
//   }) → <div class="wg-card wg-card--accent wg-vstack" data-offer-card>
(function () {
    function ico(name, small) {
        const i = document.createElement('i');
        i.className = small ? 'wg-ico wg-ico--sm' : 'wg-ico';
        i.setAttribute('data-icon', name);
        i.setAttribute('aria-hidden', 'true');
        return i;
    }

    function span(className, text) {
        const s = document.createElement('span');
        s.className = className;
        if (text != null) s.textContent = text;
        return s;
    }

    function button(a) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wg-btn'
            + (a.primary ? ' wg-btn--primary' : '')
            + (a.ghost ? ' wg-btn--ghost' : '')
            + (a.sm ? ' wg-btn--sm' : ' wg-btn--block');
        if (a.icon) b.appendChild(ico(a.icon, true));
        b.appendChild(document.createTextNode(a.label));
        if (a.action) b.setAttribute('data-action', a.action);
        if (typeof a.onClick === 'function') b.addEventListener('click', a.onClick);
        return b;
    }

    function create(o) {
        const opts = o || {};
        const card = document.createElement('div');
        card.className = 'wg-card wg-card--accent wg-vstack';
        card.setAttribute('data-offer-card', '');

        const head = document.createElement('div');
        head.className = 'wg-hstack';
        const lead = span('wg-row__lead wg-row__lead--sun');
        lead.appendChild(ico(opts.lead || 'sparkle'));
        const titles = span('wg-vstack wg-spacer');
        titles.appendChild(span('wg-card__title', opts.title || ''));
        if (opts.meta) titles.appendChild(span('wg-meta', opts.meta));
        head.append(lead, titles);
        if (opts.trail) head.appendChild(opts.trail);
        if (typeof opts.onDismiss === 'function') {
            const x = document.createElement('button');
            x.type = 'button';
            x.className = 'wg-btn wg-btn--ghost wg-btn--icon wg-btn--sm';
            x.setAttribute('aria-label', 'Not now');
            x.setAttribute('data-action', 'offer-dismiss');
            x.appendChild(ico('x', true));
            x.addEventListener('click', opts.onDismiss);
            head.appendChild(x);
        }
        card.appendChild(head);

        if (opts.text) {
            const p = document.createElement('p');
            p.className = 'wg-hint';
            p.textContent = opts.text;
            card.appendChild(p);
        }
        (opts.body || []).forEach((n) => { if (n) card.appendChild(n); });
        (opts.actions || []).forEach((a) => card.appendChild(button(a)));

        if (window.WGIcons && typeof window.WGIcons.hydrate === 'function') {
            try { window.WGIcons.hydrate(card); } catch (_) { /* unknown icon: leave the slot empty */ }
        }
        return card;
    }

    // meters([{ label, used, total, value }]) → the kit's .wg-macros grid of
    // label · meter · value rows ("Voice 12 / 30 min"). --p is the only
    // inline style, a neutral custom property the meter class reads.
    function meters(rows) {
        const grid = document.createElement('div');
        grid.className = 'wg-macros';
        for (const r of rows) {
            grid.appendChild(span('wg-macros__label', r.label));
            const meter = span('wg-meter');
            const fill = span('wg-meter__fill wg-meter__fill--mint');
            const p = r.total > 0 ? Math.min(100, Math.max(0, Math.round((r.used / r.total) * 100))) : 0;
            fill.style.setProperty('--p', p + '%');
            meter.appendChild(fill);
            grid.append(meter, span('wg-macros__val', r.value));
        }
        return grid;
    }

    window.WGOfferCard = { create, meters };
})();
