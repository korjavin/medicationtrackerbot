// Wandergeek stroke-icon registry.
// Single source for the 24px line icons used throughout the reskinned app.
// Each entry stores only the inner SVG markup (paths, rects, circles); the
// wrapper <svg> is built by iconSvg() with a shared attribute set — so every
// icon has consistent viewBox, stroke behavior, and aria semantics.
//
// API:
//   WGIcons.paths                        — read-only map of name → inner SVG string
//   WGIcons.iconSvg(name, { size?, stroke? }) — returns an <svg> SVGElement
//   WGIcons.hydrate(root = document)     — fills <i class="wg-ico" data-icon="…">
//                                           placeholders with iconSvg(); idempotent
//   WGIcons.aliases                      — kit name → existing registry name
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
        printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
        share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
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
        // Equipment-row implement icons (med-jx0i): a long bar with two plates
        // a side, and a bell body under a handle.
        barbell: '<path d="M1 12h22M5 7v10M8 5v14M16 5v14M19 7v10"/>',
        kettlebell: '<path d="M8.5 10.1V7a3.5 3.5 0 0 1 7 0v3.1"/><circle cx="12" cy="15" r="6"/>',
        check: '<path d="M20 6 9 17l-5-5"/>',
        close: '<path d="M18 6 6 18M6 6l12 12"/>',
        barcode: '<path d="M3 5v14M7 5v14M11 5v14M15 5v14M19 5v14"/>',
        camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
        image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
        moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
        footprints: '<path d="M4 16v-4a2 2 0 1 1 4 0v4M14 16v-6a2 2 0 1 1 4 0v6"/><circle cx="6" cy="20" r="2"/><circle cx="16" cy="20" r="2"/>',
        scale: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M7 11h10M12 11v4"/>',
        target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
        clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        back: '<path d="m15 18-6-6 6-6"/>',
        // Added beyond the handoff prototype: Settings (gear) — the app-bar
        // button that opens Settings (alias `gear`).
        settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
        phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',

        // App UI kit v2 (docs/design/claude-design/ui_kits/app-v2/icons.js).
        // Names the kit shares with the registry above (home, pill, trash, …)
        // keep the existing path; only kit-only names are added here.
        minus: '<path d="M5 12h14"/>',
        'chev-u': '<path d="M6 14.5l6-6 6 6"/>',
        search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/>',
        sparkle: '<path d="M11 3.5l1.8 5.2 5.2 1.8-5.2 1.8L11 17.5l-1.8-5.2L4 10.5l5.2-1.8z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
        flag: '<path d="M5 21V4M5 4h12l-2 4 2 4H5"/>',
        refresh: '<path d="M20 11.5a8 8 0 1 0-2.3 5.6"/><path d="M20 5v6.5h-6.5"/>',
        'cloud-off': '<path d="M3.5 3.5l17 17"/><path d="M9 6.8A5.5 5.5 0 0 1 17 10a4 4 0 0 1 2.9 6.7M16 19H7a4.5 4.5 0 0 1-1.7-8.7"/>',
        'cloud-up': '<path d="M7 18.5a4.5 4.5 0 0 1-.9-8.9A6 6 0 0 1 17.6 9.5 4 4 0 0 1 17 18.5"/><path d="M12 12.5v7M9 15.5l3-3 3 3"/>',
        alert: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 9.5v4.5M12 17v.1"/>',
        info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.1"/>',
        'phone-off': '<path d="M5 3.5h3.5l2 5-2.5 1.5c.6 1.3 1.4 2.5 2.4 3.5M15 16l1.5-2.5 5 2v3.5a2 2 0 0 1-2 2A16.5 16.5 0 0 1 3 5.5a2 2 0 0 1 2-2"/><path d="M3.5 3.5l17 17"/>',
        file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
        upload: '<path d="M12 16V4.5M7 9l5-5 5 5M4.5 20h15"/>',
        download: '<path d="M12 4v11.5M7 11l5 5 5-5M4.5 20h15"/>',
        device: '<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/>',
        plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>',
        key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16.5 6.5l3 3"/>',
        lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
        user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
        timer: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 2M9.5 2.5h5"/>',
        play: '<path d="M8 5l11 7-11 7z"/>',
        pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
        skip: '<path d="M5.5 5.5l9 6.5-9 6.5zM18.5 5.5v13"/>',
        grip: '<circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none"/>',
        flame: '<path d="M12 21c3.9 0 7-2.7 7-6.5 0-3.2-2-5.3-3.5-7 .1 2-1 3.5-2.5 3.5 0-3-1.5-5.5-4-8 0 3.5-4 6-4 11 0 3.8 3.1 7 7 7z"/>',
        mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
        'mic-off': '<path d="M15 10V6a3 3 0 0 0-5.8-1M9 9v2a3 3 0 0 0 4.6 2.5M5.5 11a6.5 6.5 0 0 0 10.8 4.9M18.5 11c0 .7-.1 1.4-.3 2M12 17.5V21M3.5 3.5l17 17"/>',
        note: '<path d="M5 4h14v11l-5 5H5z"/><path d="M14 20v-5h5M8.5 9h7M8.5 12.5h4"/>',
        shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
        qr: '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1"/><path d="M14 14h3v3h-3zM20.5 14v.1M14 20.5h.1M17.5 17.5h3v3h-3z"/>',
        link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
        copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M15.5 8.5V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9.5a1 1 0 0 0 1 1h3.5"/>',
        route: '<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8.2 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.8"/>',
        swap: '<path d="M7 4L4 7l3 3M4 7h13M17 20l3-3-3-3M20 17H7"/>',
        archive: '<path d="M3.5 4.5h17v4h-17zM5 8.5V20h14V8.5M10 12.5h4"/>',
        globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.3 3.5 8.5s-1 5.9-3.5 8.5M12 3.5C9.5 6.1 8.5 8.8 8.5 12s1 5.9 3.5 8.5"/>',
        scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7.5 12h9"/>',
        message: '<path d="M4 5h16v11H9.5L4 20z"/>',
        eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
        snooze: '<circle cx="12" cy="13" r="7.5"/><path d="M9.5 10.5h5l-5 5h5M5 3.5 2.5 6M19 3.5 21.5 6"/>',
        history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 4v4h4M12 7.5V12l3 2"/>',
        box: '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>',
        sig: '<path d="M3 18h2.4v2.5H3zM7.7 15h2.4v5.5H7.7zM12.4 12h2.4v8.5h-2.4zM17.1 9h2.4v11.5h-2.4z" fill="currentColor" stroke="none"/>',
        wifi: '<path d="M2.5 9.5a14 14 0 0 1 19 0M5.5 13a9.5 9.5 0 0 1 13 0M8.6 16.4a5 5 0 0 1 6.8 0"/><circle cx="12" cy="19.5" r="1.2" fill="currentColor" stroke="none"/>',
        batt: '<rect x="2" y="7" width="18" height="10" rx="2.5"/><rect x="4" y="9" width="12.5" height="6" rx="1" fill="currentColor" stroke="none"/><path d="M22 10.5v3"/>',
    };

    // Kit names that collide with an existing registry icon resolve to the
    // same path string (alias → existing name).
    const ALIASES = {
        health: 'heart',
        gear: 'settings',
        food: 'apple',
        edit: 'pencil',
        x: 'close',
        'chev-l': 'chevronLeft',
        'chev-r': 'chevronRight',
        'chev-d': 'chevronDown',
    };
    for (const alias of Object.keys(ALIASES)) PATHS[alias] = PATHS[ALIASES[alias]];

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

    // Turn markup-authored placeholders (<i class="wg-ico" data-icon="pill">)
    // under `root` into inline SVG. Idempotent: a placeholder that already
    // holds an <svg> is skipped. Unknown names throw, like iconSvg.
    function hydrate(root) {
        const scope = root || document;
        const nodes = [];
        if (scope.matches && scope.matches('.wg-ico[data-icon]')) nodes.push(scope);
        nodes.push(...scope.querySelectorAll('.wg-ico[data-icon]'));
        for (const el of nodes) {
            if (el.querySelector('svg')) continue;
            el.replaceChildren(iconSvg(el.getAttribute('data-icon')));
        }
    }

    window.WGIcons = {
        paths: PATHS,
        aliases: ALIASES,
        iconSvg,
        hydrate,
    };
})();
