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
const DEEPLINK_ROUTER_JS = path.join(REPO_ROOT, 'web/static/js/features/deeplink-router.js');

function loadIndex() {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const dom = new JSDOM(html, { url: 'https://example.test/' });
    return { dom, cleanup: () => dom.window.close() };
}

describe('Settings design parity — round 2 (Task 7: external-link rows)', () => {
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
            // Kit rows/links (Settings v2): a link names its target, never the URL.
            for (const el of settingsView.querySelectorAll('.wg-setting__title, .wg-link, .wg-label')) {
                expect(el.textContent.trim()).not.toMatch(/^https?:\/\//);
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

});
