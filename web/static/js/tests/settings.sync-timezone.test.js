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

describe('Settings sync + timezone cards (Phase 9, Task 3)', () => {
    it('renders the Sync section as a wg-card with a mono title', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const settingsView = dom.window.document.getElementById('settings-view');
            expect(settingsView).not.toBeNull();
            const section = settingsView.querySelector('.wg-settings-section');
            expect(section).not.toBeNull();
            expect(section.classList.contains('wg-card')).toBe(true);
            const title = section.querySelector('.wg-settings-section__title');
            expect(title).not.toBeNull();
            expect(title.textContent.trim()).toBe('Sync');
        } finally {
            cleanup();
        }
    });

    it('mounts #sync-status-bar inside the sync card with the hidden class and no inline style', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const bar = dom.window.document.getElementById('sync-status-bar');
            expect(bar).not.toBeNull();
            expect(bar.closest('.wg-settings-section')).not.toBeNull();
            expect(bar.classList.contains('wg-settings-hidden')).toBe(true);
            expect(bar.getAttribute('style')).toBeNull();
        } finally {
            cleanup();
        }
    });

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

    it('renders the Time & Timezone card with a mono title + muted description', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const settingsView = dom.window.document.getElementById('settings-view');
            const cards = settingsView.querySelectorAll('.wg-settings-section');
            const titles = Array.from(cards).map((c) => {
                const t = c.querySelector('.wg-settings-section__title');
                return t ? t.textContent.trim() : '';
            });
            expect(titles).toContain('Time & Timezone');
            const tzCard = Array.from(cards).find((c) =>
                c.querySelector('.wg-settings-section__title')?.textContent?.trim() === 'Time & Timezone'
            );
            expect(tzCard).toBeDefined();
            const desc = tzCard.querySelector('.wg-settings-section__desc');
            expect(desc).not.toBeNull();
            expect(desc.textContent).toContain('Read-only info');
        } finally {
            cleanup();
        }
    });

    it('renders the info grid in a .wg-gloss--inset frame with four labelled rows', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const grid = dom.window.document.querySelector('.wg-settings-info-grid');
            expect(grid).not.toBeNull();
            expect(grid.classList.contains('wg-gloss--inset')).toBe(true);
            const rows = grid.querySelectorAll('.wg-settings-info-row');
            expect(rows.length).toBe(4);

            const labels = Array.from(rows).map((r) =>
                r.querySelector('.wg-settings-info-row__label').textContent.trim()
            );
            expect(labels).toEqual([
                'Saved Timezone',
                'Time In Saved Timezone',
                'Browser Local Time',
                'Server Time',
            ]);
        } finally {
            cleanup();
        }
    });

    it('keeps the existing timezone value mount IDs so app.js can populate them', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const doc = dom.window.document;
            for (const id of [
                'settings-timezone-value',
                'settings-saved-time-value',
                'settings-local-time-value',
                'settings-server-time-value',
                'settings-timezone-note',
            ]) {
                const el = doc.getElementById(id);
                expect(el, `#${id} should exist in index.html`).not.toBeNull();
            }

            const tzValue = doc.getElementById('settings-timezone-value');
            expect(tzValue.classList.contains('wg-settings-info-row__value')).toBe(true);
            expect(tzValue.classList.contains('wg-mono-display')).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('has no paper-era `setting-item` / `settings-info-*` classes remaining in the sync/oidc/timezone blocks', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const doc = dom.window.document;
            const syncBar = doc.getElementById('sync-status-bar');
            const syncCard = syncBar.closest('.wg-settings-section');
            expect(syncCard.querySelector('.setting-item')).toBeNull();
            expect(syncCard.querySelector('.sync-status-item')).toBeNull();

            const oidc = doc.getElementById('oidc-setup-container');
            expect(oidc.classList.contains('setting-item')).toBe(false);

            const tzValue = doc.getElementById('settings-timezone-value');
            const tzCard = tzValue.closest('.wg-settings-section');
            expect(tzCard.querySelector('.setting-item')).toBeNull();
            expect(tzCard.querySelector('.setting-info-block')).toBeNull();
            expect(tzCard.querySelector('.settings-info-grid')).toBeNull();
            expect(tzCard.querySelector('.settings-info-row')).toBeNull();
            expect(tzCard.querySelector('.settings-info-label')).toBeNull();
            expect(tzCard.querySelector('.settings-info-value')).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('renderSettingsTimeInfo populates every info-row value end-to-end', () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.renderSettingsTimeInfo({
                timezone: 'Europe/Berlin',
                serverTime: '2026-04-08T12:34:56+04:00',
                serverTimezone: 'UTC+04:00',
            });

            const tzValue = document.getElementById('settings-timezone-value');
            const savedValue = document.getElementById('settings-saved-time-value');
            const localValue = document.getElementById('settings-local-time-value');
            const serverValue = document.getElementById('settings-server-time-value');
            const tzNote = document.getElementById('settings-timezone-note');

            expect(tzValue.textContent).toBe('Europe/Berlin');
            expect(savedValue.textContent).not.toBe('');
            expect(localValue.textContent).not.toBe('');
            expect(serverValue.textContent).toContain('12:34:56');
            expect(serverValue.textContent).toContain('UTC+04:00');
            expect(tzNote.textContent).toContain('Changing timezone');

            for (const el of [tzValue, savedValue, localValue, serverValue]) {
                expect(el.classList.contains('wg-settings-info-row__value')).toBe(true);
                expect(el.classList.contains('wg-mono-display')).toBe(true);
            }
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

    it('renderSettingsTimeInfo with no saved timezone falls back to the "Not set" branch', () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.renderSettingsTimeInfo({
                timezone: '',
                serverTime: '',
                serverTimezone: '',
            });

            const tzValue = document.getElementById('settings-timezone-value');
            const savedValue = document.getElementById('settings-saved-time-value');
            const tzNote = document.getElementById('settings-timezone-note');

            expect(tzValue.textContent).toBe('Not set');
            expect(savedValue.textContent).toContain('Unavailable');
            expect(tzNote.textContent).toContain('No saved timezone');
        } finally {
            cleanup();
        }
    });
});
