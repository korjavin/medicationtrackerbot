// WGBottomNav — the 5-tab kit .wg-tabbar (Navigation v2, bd med-xso6.12).
// Pure-unit by necessity: the component has no integration entry point of its
// own; how bootstrap/app-nav drive it is covered in app.navigation.test.js.
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

function loadEnv() {
    const dom = new JSDOM('<!DOCTYPE html><body><div id="app"></div></body>', {
        url: 'https://example.test/',
        runScripts: 'outside-only',
    });
    dom.window.eval(fs.readFileSync(ICONS_PATH, 'utf8'));
    dom.window.eval(fs.readFileSync(NAV_PATH, 'utf8'));
    return { window: dom.window, document: dom.window.document, cleanup: () => dom.window.close() };
}

describe('WGBottomNav — tab bar component', () => {
    it('DEFAULT_ITEMS is the five-tab order Today · Food · Meds · Train · Health', () => {
        const { window, cleanup } = loadEnv();
        try {
            const items = window.WGBottomNav.DEFAULT_ITEMS;
            expect(items.map((i) => i.id)).toEqual(['today', 'food', 'meds', 'workouts', 'health-group']);
            expect(items.map((i) => i.label)).toEqual(['Today', 'Food', 'Meds', 'Train', 'Health']);
            // Settings and Journey are not tabs (gear / route icon in the app bars).
            expect(items.map((i) => i.id)).not.toContain('settings');
            expect(items.map((i) => i.id)).not.toContain('journey');
            // Health owns the three stable section ids.
            expect(Array.from(items[4].sections)).toEqual(['bp', 'weight', 'health']);
            for (const item of items) {
                expect(() => window.WGIcons.iconSvg(item.icon)).not.toThrow();
            }
        } finally { cleanup(); }
    });

    it('mount() renders the kit markup: nav.wg-tabbar of button.wg-tab with an .wg-ico icon, --n = tab count', () => {
        const { window, document, cleanup } = loadEnv();
        try {
            window.WGBottomNav.mount(document.getElementById('app'));
            const nav = document.querySelector('nav.wg-tabbar');
            expect(nav).not.toBeNull();
            expect(nav.getAttribute('aria-label')).toBe('Primary');
            const tabs = nav.querySelectorAll(':scope > button.wg-tab');
            expect(tabs.length).toBe(5);
            for (const tab of tabs) {
                expect(tab.querySelector('i.wg-ico > svg')).not.toBeNull();
            }
            expect(tabs[3].textContent).toBe('Train');
            // The only inline value is the kit's structural column count.
            expect(nav.getAttribute('style').replace(/\s/g, '')).toMatch(/^--n:5;?$/);
            expect(document.querySelector('.wg-bottom-nav, .wg-nav-item')).toBeNull();
        } finally { cleanup(); }
    });

    it('--n follows a feature-filtered item list', () => {
        const { window, document, cleanup } = loadEnv();
        try {
            const items = window.WGBottomNav.DEFAULT_ITEMS.filter((i) => i.id !== 'food' && i.id !== 'meds');
            window.WGBottomNav.mount(document.getElementById('app'), { items });
            const nav = document.querySelector('.wg-tabbar');
            expect(nav.querySelectorAll('.wg-tab').length).toBe(3);
            expect(nav.getAttribute('style').replace(/\s/g, '')).toMatch(/^--n:3;?$/);
        } finally { cleanup(); }
    });

    it('setActive maps a section onto its tab: bp / weight / health all light Health', () => {
        const { window, document, cleanup } = loadEnv();
        try {
            const nav = window.WGBottomNav.mount(document.getElementById('app'), { active: 'today' });
            const current = () => Array.from(document.querySelectorAll('.wg-tab[aria-current="page"]'))
                .map((b) => b.dataset.navId);
            expect(current()).toEqual(['today']);
            for (const section of ['bp', 'weight', 'health']) {
                nav.setActive(section);
                expect(current()).toEqual(['health-group']);
                expect(nav.getActive()).toBe('health-group');
            }
            nav.setActive('workouts');
            expect(current()).toEqual(['workouts']);
            nav.setActive('settings'); // not a tab: nothing lit
            expect(current()).toEqual([]);
        } finally { cleanup(); }
    });

    it('a tap fires onChange with the tab id and lights the tab', () => {
        const { window, document, cleanup } = loadEnv();
        try {
            const onChange = vi.fn();
            window.WGBottomNav.mount(document.getElementById('app'), { onChange });
            document.querySelector('[data-nav-id="health-group"] svg').dispatchEvent(
                new window.MouseEvent('click', { bubbles: true })
            );
            expect(onChange).toHaveBeenCalledWith('health-group');
            expect(document.querySelector('[data-nav-id="health-group"]').getAttribute('aria-current')).toBe('page');
        } finally { cleanup(); }
    });

    it('setBadge paints .wg-tab__badge, clears on 0, and survives a re-mount', () => {
        const { window, document, cleanup } = loadEnv();
        try {
            const app = document.getElementById('app');
            const nav = window.WGBottomNav.mount(app);
            const badge = () => document.querySelector('[data-nav-id="meds"] .wg-tab__badge');
            window.WGBottomNav.setBadge('meds', 2);
            expect(badge().textContent).toBe('2');
            nav.destroy();
            window.WGBottomNav.mount(app);
            expect(badge().textContent).toBe('2');
            window.WGBottomNav.setBadge('meds', 0);
            expect(badge()).toBeNull();
        } finally { cleanup(); }
    });

    it('destroy() removes the bar and stops firing onChange', () => {
        const { window, document, cleanup } = loadEnv();
        try {
            const onChange = vi.fn();
            const nav = window.WGBottomNav.mount(document.getElementById('app'), { onChange });
            const tab = document.querySelector('.wg-tab');
            nav.destroy();
            expect(document.querySelector('.wg-tabbar')).toBeNull();
            tab.click();
            expect(onChange).not.toHaveBeenCalled();
        } finally { cleanup(); }
    });

    it('mount() rejects a non-Element root and a missing WGIcons', () => {
        const { window, cleanup } = loadEnv();
        try {
            expect(() => window.WGBottomNav.mount(null)).toThrow(/rootEl must be an Element/);
        } finally { cleanup(); }
        const dom = new JSDOM('<!DOCTYPE html><body><div id="app"></div></body>', { runScripts: 'outside-only' });
        dom.window.eval(fs.readFileSync(NAV_PATH, 'utf8'));
        try {
            expect(() => dom.window.WGBottomNav.mount(dom.window.document.getElementById('app')))
                .toThrow(/WGIcons must be loaded/);
        } finally { dom.window.close(); }
    });
});

describe('WGIcons — registry', () => {
    it('contains every icon the tab bar and app bars use', () => {
        const { window, cleanup } = loadEnv();
        try {
            const needed = ['home', 'food', 'pill', 'dumbbell', 'health', 'gear', 'route', 'chev-l'];
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
