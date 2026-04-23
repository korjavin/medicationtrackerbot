import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const INDEX_HTML = path.join(REPO_ROOT, 'web/static/index.html');
const STYLES_CSS = path.join(REPO_ROOT, 'web/static/css/styles.css');

function loadIndex() {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const dom = new JSDOM(html, { url: 'https://example.test/' });
    return { dom, cleanup: () => dom.window.close() };
}

describe('Settings version footer (Phase 9, Task 7)', () => {
    it('renders a .wg-settings-version block inside #settings-view', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const settingsView = dom.window.document.getElementById('settings-view');
            expect(settingsView).not.toBeNull();
            const footer = settingsView.querySelector('.wg-settings-version');
            expect(footer).not.toBeNull();
        } finally {
            cleanup();
        }
    });

    it('exposes a mono eyebrow label and a value span carrying VERSION_PLACEHOLDER', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const footer = dom.window.document.querySelector('#settings-view .wg-settings-version');
            expect(footer).not.toBeNull();

            const label = footer.querySelector('.wg-settings-version__label');
            const value = footer.querySelector('.wg-settings-version__value');
            expect(label).not.toBeNull();
            expect(value).not.toBeNull();
            expect(label.textContent.trim().length).toBeGreaterThan(0);
            expect(value.textContent.trim()).toBe('VERSION_PLACEHOLDER');
        } finally {
            cleanup();
        }
    });

    it('the version footer has no inline style attribute (all visual values come from the .wg-settings-version class)', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const footer = dom.window.document.querySelector('#settings-view .wg-settings-version');
            expect(footer).not.toBeNull();
            expect(footer.getAttribute('style')).toBeNull();
            for (const child of footer.querySelectorAll('*')) {
                expect(child.getAttribute('style')).toBeNull();
            }
        } finally {
            cleanup();
        }
    });

    it('.wg-settings-version CSS rule uses the Phase 9 version tokens', () => {
        const css = fs.readFileSync(STYLES_CSS, 'utf8');
        const match = css.match(/\.wg-settings-version\s*\{([^}]+)\}/);
        expect(match).not.toBeNull();
        const body = match[1];
        expect(body).toContain('var(--wg-settings-version-pad)');
        expect(body).toContain('var(--wg-settings-version-size)');
        expect(body).toContain('var(--wg-font-mono)');
    });

    it('sits after the Food Targets section so it renders as a footer', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const settingsView = dom.window.document.getElementById('settings-view');
            const footer = settingsView.querySelector('.wg-settings-version');
            const sections = settingsView.querySelectorAll('.wg-settings-section');
            expect(sections.length).toBeGreaterThan(0);
            const last = sections[sections.length - 1];
            expect(footer.compareDocumentPosition(last) & dom.window.Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
        } finally {
            cleanup();
        }
    });
});
