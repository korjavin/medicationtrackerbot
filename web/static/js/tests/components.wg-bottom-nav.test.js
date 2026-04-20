import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ICONS_PATH = path.join(REPO_ROOT, 'web/static/js/components/wg-icons.js');
const NAV_PATH = path.join(REPO_ROOT, 'web/static/js/components/wg-bottom-nav.js');
const CSS_PATH = path.join(REPO_ROOT, 'web/static/css/styles.css');

function loadEnv() {
    const dom = new JSDOM('<!DOCTYPE html><body><div id="app"></div></body>', {
        url: 'https://example.test/',
        runScripts: 'outside-only',
    });
    dom.window.eval(fs.readFileSync(ICONS_PATH, 'utf8'));
    dom.window.eval(fs.readFileSync(NAV_PATH, 'utf8'));
    return { window: dom.window, document: dom.window.document, cleanup: () => dom.window.close() };
}

describe('WGBottomNav — component', () => {
    it('exposes window.WGBottomNav with mount + DEFAULT_ITEMS', () => {
        const { window, cleanup } = loadEnv();
        try {
            expect(window.WGBottomNav).toBeDefined();
            expect(typeof window.WGBottomNav.mount).toBe('function');
            expect(Array.isArray(window.WGBottomNav.DEFAULT_ITEMS)).toBe(true);
            expect(window.WGBottomNav.DEFAULT_ITEMS.length).toBe(8);
            // Verify the canonical ordering: Today first, Settings last.
            expect(window.WGBottomNav.DEFAULT_ITEMS[0].id).toBe('today');
            expect(window.WGBottomNav.DEFAULT_ITEMS[7].id).toBe('settings');
        } finally { cleanup(); }
    });

    it('DEFAULT_ITEMS has one slot per real section with a distinct icon (no "more")', () => {
        const { window, cleanup } = loadEnv();
        try {
            const ids = window.WGBottomNav.DEFAULT_ITEMS.map(i => i.id).sort();
            expect(ids).toEqual(['bp', 'food', 'health', 'meds', 'settings', 'today', 'weight', 'workouts']);
            const icons = window.WGBottomNav.DEFAULT_ITEMS.map(i => i.icon);
            expect(new Set(icons).size).toBe(icons.length);
            expect(icons).not.toContain('more');
        } finally { cleanup(); }
    });

    it('mount() with 5 items lays out a single row (cols=5)', () => {
        const { window, document, cleanup } = loadEnv();
        try {
            const items = window.WGBottomNav.DEFAULT_ITEMS.slice(0, 5);
            window.WGBottomNav.mount(document.getElementById('app'), { items });
            const inner = document.querySelector('.wg-bottom-nav__inner');
            expect(inner).not.toBeNull();
            expect(inner.style.getPropertyValue('--wg-nav-cols')).toBe('5');
            expect(inner.children.length).toBe(5);
        } finally { cleanup(); }
    });

    it('mount() with 8 items lays out two rows of 4 cols', () => {
        const { window, document, cleanup } = loadEnv();
        try {
            window.WGBottomNav.mount(document.getElementById('app'));
            const inner = document.querySelector('.wg-bottom-nav__inner');
            expect(inner.style.getPropertyValue('--wg-nav-cols')).toBe('4');
            expect(inner.children.length).toBe(8);
        } finally { cleanup(); }
    });

    it('mount() with 6 items lays out two rows of 3 cols (Math.ceil(6/2))', () => {
        const { window, document, cleanup } = loadEnv();
        try {
            const items = window.WGBottomNav.DEFAULT_ITEMS.slice(0, 6);
            window.WGBottomNav.mount(document.getElementById('app'), { items });
            const inner = document.querySelector('.wg-bottom-nav__inner');
            expect(inner.style.getPropertyValue('--wg-nav-cols')).toBe('3');
        } finally { cleanup(); }
    });

    it('mount() throws on >8 items (out of plan scope)', () => {
        const { window, document, cleanup } = loadEnv();
        try {
            const items = [
                ...window.WGBottomNav.DEFAULT_ITEMS,
                { id: 'extra', label: 'Extra', icon: 'bolt' },
            ];
            expect(() =>
                window.WGBottomNav.mount(document.getElementById('app'), { items })
            ).toThrow(/items\.length=9/);
        } finally { cleanup(); }
    });

    it('mount() throws TypeError-equivalent on non-Element rootEl', () => {
        const { window, cleanup } = loadEnv();
        try {
            expect(() => window.WGBottomNav.mount(null)).toThrow(/must be an Element/);
            expect(() => window.WGBottomNav.mount('not-an-element')).toThrow(/must be an Element/);
        } finally { cleanup(); }
    });

    it('clicking a slot fires onChange with the slot id and marks it active', () => {
        const { window, document, cleanup } = loadEnv();
        try {
            const onChange = vi.fn();
            window.WGBottomNav.mount(document.getElementById('app'), { active: 'today', onChange });

            const bpBtn = document.querySelector('.wg-nav-item[data-nav-id="bp"]');
            expect(bpBtn).not.toBeNull();
            bpBtn.click();

            expect(onChange).toHaveBeenCalledWith('bp');
            const actives = document.querySelectorAll('.wg-nav-item--active');
            expect(actives.length).toBe(1);
            expect(actives[0].dataset.navId).toBe('bp');
        } finally { cleanup(); }
    });

    it('clicking on the icon inside a slot still routes to onChange', () => {
        const { window, document, cleanup } = loadEnv();
        try {
            const onChange = vi.fn();
            window.WGBottomNav.mount(document.getElementById('app'), { onChange });

            const foodBtn = document.querySelector('.wg-nav-item[data-nav-id="food"]');
            const svg = foodBtn.querySelector('svg');
            svg.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

            expect(onChange).toHaveBeenCalledWith('food');
        } finally { cleanup(); }
    });

    it('setActive(id) updates the active class and aria-current', () => {
        const { window, document, cleanup } = loadEnv();
        try {
            const ctrl = window.WGBottomNav.mount(document.getElementById('app'), { active: 'today' });

            ctrl.setActive('weight');
            const weightBtn = document.querySelector('.wg-nav-item[data-nav-id="weight"]');
            expect(weightBtn.classList.contains('wg-nav-item--active')).toBe(true);
            expect(weightBtn.getAttribute('aria-current')).toBe('page');

            const todayBtn = document.querySelector('.wg-nav-item[data-nav-id="today"]');
            expect(todayBtn.classList.contains('wg-nav-item--active')).toBe(false);
            expect(todayBtn.getAttribute('aria-current')).toBeNull();

            expect(ctrl.getActive()).toBe('weight');
        } finally { cleanup(); }
    });

    it('destroy() removes the nav and stops firing onChange', () => {
        const { window, document, cleanup } = loadEnv();
        try {
            const onChange = vi.fn();
            const ctrl = window.WGBottomNav.mount(document.getElementById('app'), { onChange });

            const btn = document.querySelector('.wg-nav-item[data-nav-id="bp"]');
            ctrl.destroy();
            expect(document.querySelector('.wg-bottom-nav')).toBeNull();
            btn.click();
            expect(onChange).not.toHaveBeenCalled();
        } finally { cleanup(); }
    });

    it('each slot renders an SVG icon from the WGIcons registry', () => {
        const { window, document, cleanup } = loadEnv();
        try {
            window.WGBottomNav.mount(document.getElementById('app'));
            const items = document.querySelectorAll('.wg-nav-item');
            expect(items.length).toBe(8);
            for (const item of items) {
                const svg = item.querySelector('svg');
                expect(svg, `missing svg for ${item.dataset.navId}`).not.toBeNull();
                expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
                // data-wg-icon matches the item's icon key.
                const expected = window.WGBottomNav.DEFAULT_ITEMS.find(i => i.id === item.dataset.navId).icon;
                expect(svg.getAttribute('data-wg-icon')).toBe(expected);
            }
        } finally { cleanup(); }
    });

    it('mount() throws if WGIcons is missing', () => {
        const dom = new JSDOM('<!DOCTYPE html><body><div id="app"></div></body>', {
            url: 'https://example.test/',
            runScripts: 'outside-only',
        });
        dom.window.eval(fs.readFileSync(NAV_PATH, 'utf8'));
        try {
            expect(() =>
                dom.window.WGBottomNav.mount(dom.window.document.getElementById('app'))
            ).toThrow(/WGIcons must be loaded/);
        } finally {
            dom.window.close();
        }
    });

    it('does not use any inline styles except --wg-nav-cols on .wg-bottom-nav__inner (structural variable)', () => {
        const { window, document, cleanup } = loadEnv();
        try {
            window.WGBottomNav.mount(document.getElementById('app'));
            const all = document.querySelectorAll('.wg-bottom-nav, .wg-bottom-nav *');
            for (const el of all) {
                if (el.namespaceURI === 'http://www.w3.org/2000/svg') continue;
                const inline = el.getAttribute('style');
                if (inline === null || inline === '') continue;
                if (el.classList.contains('wg-bottom-nav__inner')) {
                    // Only the --wg-nav-cols custom property is allowed on this element.
                    expect(inline.replace(/\s/g, '')).toMatch(/^--wg-nav-cols:\d+;?$/);
                } else {
                    throw new Error(`unexpected inline style on .${el.className}: ${inline}`);
                }
            }
        } finally { cleanup(); }
    });
});

describe('WGBottomNav — CSS contract', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');

    it.each([
        '.wg-bottom-nav',
        '.wg-bottom-nav__inner',
        '.wg-nav-item',
        '.wg-nav-item--active',
    ])('defines %s in styles.css', (selector) => {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(^|[\\s,{}>+~])${escaped}\\s*[,{]`, 'm');
        expect(re.test(css)).toBe(true);
    });

    it('.wg-bottom-nav__inner uses repeat(var(--wg-nav-cols, …)) for dynamic column count', () => {
        const block = css.match(/\.wg-bottom-nav__inner\s*\{([^}]+)\}/);
        expect(block).not.toBeNull();
        expect(block[1]).toMatch(/grid-template-columns:\s*repeat\(var\(--wg-nav-cols/);
    });

    it('.wg-nav-item--active uses the sun accent color token', () => {
        const block = css.match(/\.wg-nav-item--active\s*\{([^}]+)\}/);
        expect(block).not.toBeNull();
        expect(block[1]).toMatch(/color:\s*var\(--wg-sun\)/);
    });
});

describe('WGIcons — registry', () => {
    it('exposes an iconSvg() function and a paths map', () => {
        const { window, cleanup } = loadEnv();
        try {
            expect(typeof window.WGIcons.iconSvg).toBe('function');
            expect(window.WGIcons.paths).toBeDefined();
        } finally { cleanup(); }
    });

    it('contains every icon name used by the default bottom-nav items', () => {
        const { window, cleanup } = loadEnv();
        try {
            const needed = ['home', 'activity', 'apple', 'pill', 'scale', 'dumbbell', 'heart', 'settings'];
            for (const name of needed) {
                expect(window.WGIcons.paths[name], `missing icon "${name}"`).toBeDefined();
            }
        } finally { cleanup(); }
    });

    it('iconSvg(name) returns an SVG element with the canonical attributes', () => {
        const { window, cleanup } = loadEnv();
        try {
            const svg = window.WGIcons.iconSvg('home');
            expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
            expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
            expect(svg.getAttribute('fill')).toBe('none');
            expect(svg.getAttribute('stroke')).toBe('currentColor');
            expect(svg.getAttribute('aria-hidden')).toBe('true');
            expect(svg.getAttribute('data-wg-icon')).toBe('home');
            expect(svg.childElementCount).toBeGreaterThan(0);
        } finally { cleanup(); }
    });

    it('iconSvg(unknown) throws', () => {
        const { window, cleanup } = loadEnv();
        try {
            expect(() => window.WGIcons.iconSvg('not-a-real-icon')).toThrow(/unknown icon/);
        } finally { cleanup(); }
    });

    it('iconSvg respects a custom size option', () => {
        const { window, cleanup } = loadEnv();
        try {
            const svg = window.WGIcons.iconSvg('home', { size: 32 });
            expect(svg.getAttribute('width')).toBe('32');
            expect(svg.getAttribute('height')).toBe('32');
        } finally { cleanup(); }
    });
});
