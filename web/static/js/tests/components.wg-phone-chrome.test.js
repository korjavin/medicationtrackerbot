import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const COMPONENT_PATH = path.join(REPO_ROOT, 'web/static/js/components/wg-phone-chrome.js');
const CSS_PATH = path.join(REPO_ROOT, 'web/static/css/styles.css');

function loadComponent() {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', {
        url: 'https://example.test/',
        runScripts: 'outside-only',
    });
    const src = fs.readFileSync(COMPONENT_PATH, 'utf8');
    dom.window.eval(src);
    return { window: dom.window, cleanup: () => dom.window.close() };
}

describe('WGPhoneChrome', () => {
    it('exposes window.WGPhoneChrome with mount + create', () => {
        const { window, cleanup } = loadComponent();
        try {
            expect(window.WGPhoneChrome).toBeDefined();
            expect(typeof window.WGPhoneChrome.mount).toBe('function');
            expect(typeof window.WGPhoneChrome.create).toBe('function');
        } finally {
            cleanup();
        }
    });

    it('create() returns a phone shell with dynamic island, status bar, content slot, and home indicator', () => {
        const { window, cleanup } = loadComponent();
        try {
            const { root, screen, slot } = window.WGPhoneChrome.create();
            expect(root.classList.contains('wg-phone')).toBe(true);
            expect(screen.classList.contains('wg-phone-screen')).toBe(true);
            expect(slot.classList.contains('wg-phone-screen__content')).toBe(true);

            expect(root.querySelector('.wg-dynamic-island')).not.toBeNull();
            expect(root.querySelector('.wg-status-bar')).not.toBeNull();
            expect(root.querySelector('.wg-home-indicator')).not.toBeNull();
            expect(root.querySelector('.wg-phone-screen__content')).toBe(slot);
        } finally {
            cleanup();
        }
    });

    it('status bar shows "9:41" and three SVG icons (signal, wifi, battery)', () => {
        const { window, cleanup } = loadComponent();
        try {
            const { root } = window.WGPhoneChrome.create();
            const bar = root.querySelector('.wg-status-bar');
            expect(bar).not.toBeNull();

            const time = bar.querySelector('.wg-status-bar__time');
            expect(time).not.toBeNull();
            expect(time.textContent).toBe('9:41');

            const icons = bar.querySelectorAll('.wg-status-bar__icons svg');
            expect(icons.length).toBe(3);

            // Signal: 4 stacked rects, viewBox 0 0 17 11
            expect(icons[0].getAttribute('viewBox')).toBe('0 0 17 11');
            expect(icons[0].querySelectorAll('rect').length).toBe(4);

            // Wifi: 2 arc paths + 1 dot circle, viewBox 0 0 16 11
            expect(icons[1].getAttribute('viewBox')).toBe('0 0 16 11');
            expect(icons[1].querySelectorAll('path').length).toBe(2);
            expect(icons[1].querySelectorAll('circle').length).toBe(1);

            // Battery: 2 rects + 1 nub path, viewBox 0 0 26 12
            expect(icons[2].getAttribute('viewBox')).toBe('0 0 26 12');
            expect(icons[2].querySelectorAll('rect').length).toBe(2);
            expect(icons[2].querySelectorAll('path').length).toBe(1);
        } finally {
            cleanup();
        }
    });

    it('dynamic-island and home-indicator are aria-hidden (decorative)', () => {
        const { window, cleanup } = loadComponent();
        try {
            const { root } = window.WGPhoneChrome.create();
            expect(root.querySelector('.wg-dynamic-island').getAttribute('aria-hidden')).toBe('true');
            expect(root.querySelector('.wg-home-indicator').getAttribute('aria-hidden')).toBe('true');
        } finally {
            cleanup();
        }
    });

    it('mount(rootEl) wraps an existing element in the chrome in place', () => {
        const { window, cleanup } = loadComponent();
        try {
            const host = window.document.createElement('div');
            host.id = 'host';
            window.document.body.appendChild(host);

            const app = window.document.createElement('div');
            app.id = 'app';
            app.textContent = 'app content';
            host.appendChild(app);

            const chrome = window.WGPhoneChrome.mount(app);

            // Chrome occupies the original parent; app is now nested in the slot.
            expect(chrome.classList.contains('wg-phone')).toBe(true);
            expect(chrome.parentNode).toBe(host);
            expect(host.firstElementChild).toBe(chrome);

            const slot = chrome.querySelector('.wg-phone-screen__content');
            expect(slot.firstElementChild).toBe(app);
            expect(slot.textContent).toContain('app content');
        } finally {
            cleanup();
        }
    });

    it('mount() throws on a non-Element argument', () => {
        // Match by message — jsdom's TypeError is a different constructor
        // across realms, so `toThrow(TypeError)` won't identify it.
        const { window, cleanup } = loadComponent();
        try {
            expect(() => window.WGPhoneChrome.mount(null)).toThrow(/must be an Element/);
            expect(() => window.WGPhoneChrome.mount(undefined)).toThrow(/must be an Element/);
            expect(() => window.WGPhoneChrome.mount('not-an-element')).toThrow(/must be an Element/);
        } finally {
            cleanup();
        }
    });

    it('does not assign any inline styles to the chrome elements', () => {
        // Architectural rule: all visual values come from CSS classes.
        const { window, cleanup } = loadComponent();
        try {
            const { root } = window.WGPhoneChrome.create();
            const all = [root, ...root.querySelectorAll('*')];
            for (const el of all) {
                if (el.namespaceURI === 'http://www.w3.org/2000/svg') continue;
                const inline = el.getAttribute('style');
                expect(inline === null || inline === '', `inline style on ${el.className || el.tagName}: ${inline}`).toBe(true);
            }
        } finally {
            cleanup();
        }
    });
});

describe('WGPhoneChrome — CSS contract', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');

    it.each([
        '.wg-phone',
        '.wg-phone-screen',
        '.wg-phone-screen__content',
        '.wg-dynamic-island',
        '.wg-status-bar',
        '.wg-status-bar__icons',
        '.wg-home-indicator',
    ])('defines %s in styles.css', (selector) => {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(^|[\\s,{}>+~])${escaped}\\s*\\{`, 'm');
        expect(re.test(css)).toBe(true);
    });

    it('collapses chrome on small viewports via @media (max-width: 480px)', () => {
        // Find a media query block whose condition matches mobile width.
        const mobileMediaRe = /@media\s*\(\s*max-width:\s*480px\s*\)\s*\{([\s\S]*?)\n\}/m;
        const m = css.match(mobileMediaRe);
        expect(m, 'expected a @media (max-width: 480px) block').not.toBeNull();
        const body = m[1];
        // Inside the block: .wg-phone full-viewport, ornaments hidden.
        expect(body).toMatch(/\.wg-phone\s*\{/);
        expect(body).toMatch(/\.wg-dynamic-island\s*,?\s*\n?\s*\.wg-status-bar\s*,?\s*\n?\s*\.wg-home-indicator/);
        expect(body).toMatch(/display:\s*none/);
    });

    it('chrome dimensional values resolve through --wg-* tokens (not raw px in tokenized properties)', () => {
        // Spot-check: .wg-phone uses var() for padding, border-radius, box-shadow
        const phoneBlock = css.match(/\.wg-phone\s*\{([^}]+)\}/);
        expect(phoneBlock).not.toBeNull();
        const body = phoneBlock[1];
        expect(body).toMatch(/padding:\s*var\(--wg-phone-pad\)/);
        expect(body).toMatch(/border-radius:\s*var\(--wg-phone-radius\)/);
        expect(body).toMatch(/box-shadow:\s*var\(--wg-phone-shadow\)/);
    });
});
