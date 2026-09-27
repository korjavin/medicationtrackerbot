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

function loadIndex() {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const dom = new JSDOM(html, { url: 'https://example.test/' });
    return { dom, cleanup: () => dom.window.close() };
}

// Split out of settings.sync-timezone.test.js by med-a9n5.8: the Sync and
// Time & Timezone cards are deleted, but #oidc-setup-container stays — it is
// owned by F1 (med-a9n5.4), which removes OIDC + this file.
describe('Settings OIDC setup banner (Phase 9, Task 3)', () => {
    it('wraps #oidc-setup-container in a wg-card shell with :empty hiding rule', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const oidc = dom.window.document.getElementById('oidc-setup-container');
            expect(oidc).not.toBeNull();
            expect(oidc.classList.contains('wg-card')).toBe(true);
            expect(oidc.classList.contains('wg-settings-section')).toBe(true);
            expect(oidc.classList.contains('wg-settings-oidc')).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('initOIDCSetupBanner with OIDC enabled renders wg-settings markup (no paper-era .setting-item / .btn)', () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.OIDC_CONFIG = { enabled: true };
            window.initOIDCSetupBanner();

            const container = document.getElementById('oidc-setup-container');
            expect(container).not.toBeNull();

            expect(container.querySelector('.setting-item')).toBeNull();
            expect(container.querySelector('.setting-desc')).toBeNull();
            expect(container.querySelector('.btn')).toBeNull();
            expect(container.querySelector('.btn-secondary')).toBeNull();

            const title = container.querySelector('.wg-settings-section__title');
            expect(title).not.toBeNull();
            expect(title.textContent.trim()).toBe('OIDC Setup');

            const desc = container.querySelector('.wg-settings-section__desc');
            expect(desc).not.toBeNull();

            const row = container.querySelector('.wg-settings-row-list .wg-settings-row');
            expect(row).not.toBeNull();
            const rowTitle = row.querySelector('.wg-settings-row__title');
            expect(rowTitle).not.toBeNull();
            expect(rowTitle.classList.contains('wg-mono-display')).toBe(true);

            // Round-2 Task 7: the "Open" control is now an <a target="_blank">
            // anchor so `/oidc-setup` opens in a new tab instead of clobbering
            // the mini-app URL (which previously caused a Today fallback on back).
            const actionLink = row.querySelector('.wg-settings-row__control a');
            expect(actionLink).not.toBeNull();
            expect(actionLink.classList.contains('wg-settings-action-btn')).toBe(true);
            expect(actionLink.classList.contains('btn')).toBe(false);
            expect(actionLink.classList.contains('btn-secondary')).toBe(false);
            expect(actionLink.textContent.trim()).toBe('Open');
            expect(actionLink.getAttribute('href')).toBe('/oidc-setup');
            expect(actionLink.getAttribute('target')).toBe('_blank');
            expect(actionLink.getAttribute('rel')).toBe('noopener noreferrer');
            expect(row.querySelector('.wg-settings-row__control button')).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('initOIDCSetupBanner with OIDC disabled leaves the container empty', () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.OIDC_CONFIG = { enabled: false };
            window.initOIDCSetupBanner();

            const container = document.getElementById('oidc-setup-container');
            expect(container.children.length).toBe(0);
        } finally {
            cleanup();
        }
    });
});
