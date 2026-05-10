// Wandergeek stroke-icon registry.
// Single source for the 24px line icons used throughout the reskinned app.
// Each entry stores only the inner SVG markup (paths, rects, circles); the
// wrapper <svg> is built by iconSvg() with a shared attribute set — so every
// icon has consistent viewBox, stroke behavior, and aria semantics.
//
// API:
//   WGIcons.paths                        — read-only map of name → inner SVG string
//   WGIcons.iconSvg(name, { size?, stroke? }) — returns an <svg> SVGElement
//
// No inline styles or color literals: consumers style strokes via CSS
// (`currentColor` is the default), matching the no-hardcoded-hex rule.

(function () {
    const SVG_NS = 'http://www.w3.org/2000/svg';

    const PATHS = {
        chevronLeft: '<path d="m15 18-6-6 6-6"/>',
        chevronRight: '<path d="m9 18 6-6-6-6"/>',
        chevronDown: '<path d="m6 9 6 6 6-6"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        more: '<circle cx="12" cy="5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="19" r="1.3"/>',
        trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/>',
        pencil: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
        heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
        drop: '<path d="M12 2.69 17.66 8.35a8 8 0 1 1-11.32 0z"/>',
        pill: '<path d="M10.5 20.5a7.07 7.07 0 0 1-10-10l10-10a7.07 7.07 0 0 1 10 10Z"/><path d="m8.5 8.5 7 7"/>',
        apple: '<path d="M12 7c0-3 2-5 4-5-1 2-2 3-4 5Z"/><path d="M17 7c3 0 5 3 5 6 0 5-4 10-6 10-1 0-2-1-4-1s-3 1-4 1c-2 0-6-5-6-10 0-3 2-6 5-6 2 0 3 1 5 1s2-1 5-1z"/>',
        activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
        home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
        calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
        chart: '<path d="M3 3v18h18"/><path d="m7 14 4-4 4 4 6-6"/>',
        bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
        bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
        dumbbell: '<path d="M6 4v16M18 4v16M2 8v8M22 8v8M6 12h12"/>',
        check: '<path d="M20 6 9 17l-5-5"/>',
        close: '<path d="M18 6 6 18M6 6l12 12"/>',
        barcode: '<path d="M3 5v14M7 5v14M11 5v14M15 5v14M19 5v14"/>',
        camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
        moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
        footprints: '<path d="M4 16v-4a2 2 0 1 1 4 0v4M14 16v-6a2 2 0 1 1 4 0v6"/><circle cx="6" cy="20" r="2"/><circle cx="16" cy="20" r="2"/>',
        scale: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M7 11h10M12 11v4"/>',
        target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
        clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        back: '<path d="m15 18-6-6 6-6"/>',
        // Added beyond the handoff prototype: Settings (gear) for the new
        // bottom-nav Settings slot — there is no "More" aggregator.
        settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
        phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    };

    // Parse the icon's inner markup into SVG-namespaced children. We go via a
    // wrapper <svg> so DOMParser treats descendants as SVG regardless of how
    // the host builds the icon (jsdom's innerHTML setter on SVGElement can
    // otherwise emit HTMLUnknownElement nodes for `<path>` etc.).
    function parseSvgChildren(inner) {
        const doc = new DOMParser().parseFromString(
            `<svg xmlns="${SVG_NS}">${inner}</svg>`,
            'image/svg+xml'
        );
        return Array.from(doc.documentElement.childNodes);
    }

    function iconSvg(name, opts) {
        const inner = PATHS[name];
        if (!inner) {
            throw new Error(`WGIcons.iconSvg: unknown icon "${name}"`);
        }
        const size = (opts && opts.size) || 20;
        const stroke = (opts && opts.stroke) || 1.8;

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', String(stroke));
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('data-wg-icon', name);
        for (const child of parseSvgChildren(inner)) {
            svg.appendChild(child);
        }
        return svg;
    }

    window.WGIcons = {
        paths: PATHS,
        iconSvg,
    };
})();
