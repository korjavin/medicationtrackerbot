import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const INDEX_HTML = path.join(REPO_ROOT, 'web/static/index.html');
const OIDC_SETUP_HTML = path.join(REPO_ROOT, 'web/static/oidc-setup.html');
const DEEPLINK_ROUTER_JS = path.join(REPO_ROOT, 'web/static/js/features/deeplink-router.js');

function loadIndex() {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const dom = new JSDOM(html, { url: 'https://example.test/' });
    return { dom, cleanup: () => dom.window.close() };
}

describe('Settings design parity — round 2 (Task 7: external-link rows)', () => {
    it('OIDC setup row renders an <a> with target="_blank" rel="noopener noreferrer", not a button or location.href hack', () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.OIDC_CONFIG = { enabled: true };
            window.initOIDCSetupBanner();

            const container = document.getElementById('oidc-setup-container');
            expect(container).not.toBeNull();

            const control = container.querySelector('.wg-settings-row__control');
            expect(control).not.toBeNull();

            // No button-based navigation (previously used window.location.href).
            expect(control.querySelector('button')).toBeNull();

            const link = control.querySelector('a');
            expect(link).not.toBeNull();
            expect(link.getAttribute('href')).toBe('/oidc-setup');
            expect(link.getAttribute('target')).toBe('_blank');
            const rel = (link.getAttribute('rel') || '').split(/\s+/);
            expect(rel).toContain('noopener');
            expect(rel).toContain('noreferrer');
            expect(link.textContent.trim()).toBe('Open');
            expect(link.getAttribute('aria-label')).toMatch(/new tab/i);
            expect(link.classList.contains('wg-settings-action-btn')).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('OIDC setup row description explains what the link does (no raw URLs as labels)', () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.OIDC_CONFIG = { enabled: true };
            window.initOIDCSetupBanner();

            const container = document.getElementById('oidc-setup-container');
            const desc = container.querySelector('.wg-settings-row__desc');
            expect(desc).not.toBeNull();
            expect(desc.textContent.trim()).not.toBe('');

            // Row title is a human-readable label, not a raw http(s) URL.
            const title = container.querySelector('.wg-settings-row__title');
            expect(title).not.toBeNull();
            expect(title.textContent.trim()).not.toMatch(/^https?:\/\//);
        } finally {
            cleanup();
        }
    });

    it('no Settings row control ships a raw http(s) URL as the rendered label', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const settingsView = dom.window.document.getElementById('settings-view');
            expect(settingsView).not.toBeNull();
            const rows = settingsView.querySelectorAll('.wg-settings-row');
            for (const row of rows) {
                const title = row.querySelector('.wg-settings-row__title');
                if (!title) continue;
                expect(title.textContent.trim()).not.toMatch(/^https?:\/\//);
            }
        } finally {
            cleanup();
        }
    });

    it('deeplink-router intercepts only known internal paths — arbitrary anchors are left to the browser', () => {
        const source = fs.readFileSync(DEEPLINK_ROUTER_JS, 'utf8');
        // The router only runs on page load and keys off a fixed deepLinkRoutes
        // map + query params. No generic addEventListener('click', …) hook on
        // anchors, so external <a target="_blank"> anchors escape the SPA cleanly.
        expect(source).not.toMatch(/addEventListener\(['"]click['"]/);
        expect(source).toMatch(/deepLinkRoutes/);
    });

    it('oidc-setup.html external Pocket-ID links carry rel="noopener noreferrer"', () => {
        const html = fs.readFileSync(OIDC_SETUP_HTML, 'utf8');
        const anchorRe = /<a[^>]+href="https?:[^"]+"[^>]*>/g;
        const anchors = html.match(anchorRe) || [];
        expect(anchors.length).toBeGreaterThan(0);
        for (const anchor of anchors) {
            expect(anchor).toMatch(/target="_blank"/);
            expect(anchor).toMatch(/rel="[^"]*noopener[^"]*"/);
            expect(anchor).toMatch(/rel="[^"]*noreferrer[^"]*"/);
        }
    });
});
