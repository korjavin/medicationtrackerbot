// Wandergeek ring stack — one large concentric ring object replacing the
// old five-separate-arcs list (Plan 7 "concentric rings", Task 1). Same
// JS/CSS split as wg-ring: this module only computes geometry (per-ring
// radius) and sets the neutral --ring-progress custom property; CSS owns
// dash offset, per-ring hue, and the closed / sync-pending states.
//
// Each arc reuses wg-ring's dash-math contract, but keeps it a flat
// percentage regardless of that ring's radius via the SVG pathLength="100"
// trick, rather than a per-radius circumference constant (RADIUS_OUTER /
// RADIUS_STEP below only shape the arcs, they don't feed the dash math).
//
// API:
//   WGRingStack.render({ rings, centerLabel, label }) → HTMLElement
//
//   rings       — array, outer→inner render order, up to MAX_RINGS entries:
//                 { key, progress, closed, syncPending }
//                   key         — ring identifier (e.g. "adherence"); maps
//                                 to the .wg-ring-stack__arc--<key> color
//                                 variant class. No matching class → arc
//                                 renders with no stroke color override
//                                 (falls through to inherited/none).
//                   progress    — 0..1; clamped, ignored (forced to 1) when
//                                 closed.
//                   closed      — boolean; full arc + brightness variant.
//                   syncPending — boolean; renders the dimmed track only,
//                                 no progress arc at all (never an
//                                 accusatory empty/0% arc).
//   centerLabel — string or Node placed in the center hole. Callers decide
//                 the copy (e.g. "3/5" or a check icon) — this component
//                 only lays it out.
//   label       — optional accessible name for the whole stack.
//
// No inline colors: stroke colors resolve via CSS color tokens through
// the .wg-ring-stack__arc--<key> / --closed CSS classes — same contract as
// wg-ring's neutral progress custom property.

(function () {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const VIEWBOX_SIZE = 100;
    const CENTER = 50;
    const CIRCUMFERENCE = 100; // pathLength trick — keeps dash math a percentage per-ring
    const RADIUS_OUTER = 44;
    const RADIUS_STEP = 7;
    const STROKE_WIDTH = 5; // must match .wg-ring-stack__track/__arc stroke-width in styles.css
    const MAX_RINGS = 5;

    function clamp01(n) {
        const v = Number(n);
        if (!Number.isFinite(v)) return 0;
        if (v < 0) return 0;
        if (v > 1) return 1;
        return v;
    }

    function ringRadius(index) {
        return RADIUS_OUTER - index * RADIUS_STEP;
    }

    function svgEl(tag, attrs) {
        const node = document.createElementNS(SVG_NS, tag);
        for (const key in attrs) {
            node.setAttribute(key, String(attrs[key]));
        }
        return node;
    }

    function appendRing(svg, ring, index) {
        const key = typeof ring.key === 'string' ? ring.key : '';
        const isClosed = !!ring.closed;
        const isSyncPending = !!ring.syncPending;
        const progress = isClosed ? 1 : clamp01(ring.progress);
        const radius = ringRadius(index);

        svg.appendChild(svgEl('circle', {
            class: 'wg-ring-stack__track' + (isSyncPending ? ' wg-ring-stack__track--sync-pending' : ''),
            cx: CENTER, cy: CENTER, r: radius,
        }));

        if (isSyncPending) return; // dimmed track only — no accusatory empty progress arc

        const arc = svgEl('circle', {
            class: 'wg-ring-stack__arc'
                + (key ? ` wg-ring-stack__arc--${key}` : '')
                + (isClosed ? ' wg-ring-stack__arc--closed' : ''),
            cx: CENTER, cy: CENTER, r: radius,
            'stroke-dasharray': CIRCUMFERENCE,
            pathLength: CIRCUMFERENCE,
            transform: `rotate(-90 ${CENTER} ${CENTER})`,
        });
        arc.style.setProperty('--ring-progress', String(progress * CIRCUMFERENCE));
        svg.appendChild(arc);
    }

    function renderRingStack(opts) {
        const options = opts || {};
        const ringsInput = Array.isArray(options.rings) ? options.rings : [];
        const rings = ringsInput.slice(0, MAX_RINGS);

        const wrap = document.createElement('div');
        wrap.className = 'wg-ring-stack';

        const svg = svgEl('svg', {
            class: 'wg-ring-stack__svg',
            viewBox: `0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`,
            role: 'img',
        });
        if (typeof options.label === 'string' && options.label) {
            svg.setAttribute('aria-label', options.label);
        }
        rings.forEach((ring, index) => {
            if (!ring) return;
            appendRing(svg, ring, index);
        });
        wrap.appendChild(svg);

        const center = document.createElement('div');
        center.className = 'wg-ring-stack__center';
        const centerLabel = options.centerLabel;
        if (centerLabel instanceof Node) {
            center.appendChild(centerLabel);
        } else if (typeof centerLabel === 'string' && centerLabel) {
            center.textContent = centerLabel;
        }
        wrap.appendChild(center);

        return wrap;
    }

    window.WGRingStack = {
        render: renderRingStack,
        VIEWBOX_SIZE,
        CIRCUMFERENCE,
        STROKE_WIDTH,
        MAX_RINGS,
        ringRadius,
    };
})();
