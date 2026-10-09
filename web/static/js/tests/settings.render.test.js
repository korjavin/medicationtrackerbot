import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

// Parse the shipped index.html and hand back just the #settings-view subtree in a
// live jsdom document, plus the real settings.js helpers (bare global
// function-decls, so window.eval exposes them as window.<name>).
function loadSettingsView() {
    const html = fs.readFileSync(path.join(REPO_ROOT, 'web/static/index.html'), 'utf8');
    const dom = new JSDOM('<!DOCTYPE html>', { url: 'https://example.test/', runScripts: 'outside-only' });
    const { window } = dom;
    const { document } = window;
    const view = new window.DOMParser()
        .parseFromString(html, 'text/html')
        .getElementById('settings-view');
    document.body.appendChild(document.importNode(view, true));
    const src = fs.readFileSync(
        path.join(REPO_ROOT, 'web/static/js/features/settings.js'),
        'utf8'
    );
    window.eval(src);
    return { window, document, cleanup: () => dom.window.close() };
}

// Home row (data-settings-open) → the section selectors its page must contain.
const ROWS = [
    ['features', ['.wg-settings-features', '[input-id="bp-feature-toggle"]', '[input-id="live-hr-feature-toggle"]']],
    ['targets', ['#food-target-settings', '#gamification-targets-settings']],
    ['notifications', ['.wg-settings-notifications-cloud', '.wg-settings-reminders']],
    ['units', ['.wg-settings-units']],
    ['integrations', ['#settings-integrations', '#telegram-settings-mount']],
    ['devices', ['.wg-settings-cloud-devices', '.wg-settings-cloud-invite']],
    ['backup', ['#settings-importexport', '#importexport-reset-sync-group']],
    ['account', ['.wg-settings-privacy', '.wg-settings-danger']],
];

const page = (document, name) => document.querySelector(`.wg-settings-pages > [data-settings-page="${name}"]`);
const row = (document, name) => document.querySelector(`.wg-settings-home [data-settings-open="${name}"]`);

describe('Settings v2 home (kit S1, med-xso6.23)', () => {
    it('renders the everyday and connected groups as .wg-list of .wg-setting rows', () => {
        const { document, cleanup } = loadSettingsView();
        try {
            const groups = Array.from(document.querySelectorAll('.wg-settings-home > .wg-list'));
            expect(groups.map((g) => Array.from(g.querySelectorAll('[data-settings-open]')).map((r) => r.dataset.settingsOpen)))
                .toEqual([
                    ['features', 'targets', 'notifications', 'units'],
                    ['integrations', 'devices', 'backup', 'account'],
                ]);
            for (const r of document.querySelectorAll('.wg-settings-home [data-settings-open]')) {
                expect(r.tagName).toBe('BUTTON');
                expect(r.classList.contains('wg-setting')).toBe(true);
                expect(r.querySelector('.wg-setting__title').textContent.trim()).not.toBe('');
            }
        } finally {
            cleanup();
        }
    });

    it('keeps every page body (and its ids) inside #settings-view in the hidden store', () => {
        const { document, cleanup } = loadSettingsView();
        try {
            expect(document.querySelector('.wg-settings-pages').hasAttribute('hidden')).toBe(true);
            for (const [name, selectors] of ROWS) {
                const body = page(document, name);
                expect(body, name).not.toBeNull();
                expect(row(document, name), name).not.toBeNull();
                for (const sel of selectors) {
                    expect(body.matches(sel) || !!body.querySelector(sel), `${sel} in ${name}`).toBe(true);
                }
            }
            // The legacy collapsible groups are gone.
            expect(document.querySelector('.wg-settings-group, details.wg-settings-group')).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('puts Re-run onboarding (ghost) in the footer with the version', () => {
        const { document, cleanup } = loadSettingsView();
        try {
            const footer = document.querySelector('#settings-view > .wg-settings-footer');
            const rerun = footer.querySelector('#settings-rerun-onboarding');
            expect(rerun.classList.contains('wg-btn')).toBe(true);
            expect(rerun.classList.contains('wg-btn--ghost')).toBe(true);
            expect(footer.querySelector('.wg-settings-version')).not.toBeNull();
        } finally {
            cleanup();
        }
    });

    it('hideEmptySettingsRows() hides a row whose page sections are all hidden and leaves others visible', () => {
        const { window, document, cleanup } = loadSettingsView();
        try {
            // Bot build: the Account page's sections stay hidden.
            window.hideEmptySettingsRows();
            expect(row(document, 'account').classList.contains('wg-settings-hidden')).toBe(true);
            expect(row(document, 'devices').classList.contains('wg-settings-hidden')).toBe(true);
            // Notifications keeps the (always-on) Reminders section.
            expect(row(document, 'notifications').classList.contains('wg-settings-hidden')).toBe(false);
            expect(row(document, 'features').classList.contains('wg-settings-hidden')).toBe(false);

            document.querySelector('.wg-settings-privacy').classList.remove('wg-settings-hidden');
            window.hideEmptySettingsRows();
            expect(row(document, 'account').classList.contains('wg-settings-hidden')).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('updateFeatureTabVisibility() rolls the Targets row up after a feature toggle', () => {
        const { window, document, cleanup } = loadSettingsView();
        try {
            window.featureSettings = { food: false, gamification: false };
            window.updateFeatureTabVisibility();
            expect(row(document, 'targets').classList.contains('wg-settings-hidden')).toBe(true);

            window.featureSettings = { food: true, gamification: false };
            window.updateFeatureTabVisibility();
            expect(row(document, 'targets').classList.contains('wg-settings-hidden')).toBe(false);
            expect(document.querySelector('[data-settings-summary="targets"]').textContent).toBe('Food not set');
        } finally {
            cleanup();
        }
    });
});

describe('Settings v2 pushed pages + summaries (harness)', () => {
    it('a home row pushes a WGPage holding its page body; Back returns the body to the store', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();

            row(document, 'units').click();
            const pushed = document.querySelector('mt-modal.wg-page');
            expect(pushed).not.toBeNull();
            expect(pushed.querySelector('.wg-pagebar__title').textContent).toBe('Units');
            expect(pushed.querySelector('.wg-back').textContent).toContain('Settings');
            expect(pushed.querySelector('#weight-unit-segmented')).not.toBeNull();
            expect(page(document, 'units')).toBeNull(); // moved, not cloned
            expect(document.querySelectorAll('#weight-unit-segmented').length).toBe(1);

            pushed.querySelector('.wg-back').click();
            expect(document.querySelector('mt-modal.wg-page')).toBeNull();
            expect(page(document, 'units').querySelector('#weight-unit-segmented')).not.toBeNull();
        } finally {
            cleanup();
        }
    });

    it('the folded Journey row pushes a nested page backed by "Features"', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();
            window.featureSettings = { gamification: true };
            window.SettingsView.updateFeatureToggles();

            row(document, 'features').click();
            document.querySelector('[data-settings-open="journey-extras"]').click();
            const pages = document.querySelectorAll('mt-modal.wg-page');
            expect(pages.length).toBe(2);
            const nested = pages[1];
            expect(nested.querySelector('.wg-back').textContent).toContain('Features');
            expect(nested.querySelector('#gam-mode-traits-toggle')).not.toBeNull();
            nested.querySelector('.wg-back').click();
            pages[0].querySelector('.wg-back').click();
            expect(document.querySelector('mt-modal.wg-page')).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('row summaries reflect live state: feature count, units, reminder channels', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            delete window.__MEDTRACKER_CLOUD__;
            await window.loadSettings();
            const summary = (name) => document.querySelector(`[data-settings-summary="${name}"]`).textContent;

            window.featureSettings = { bp: true, weight: true, food: false };
            window.SettingsView.updateFeatureToggles();
            expect(summary('features')).toBe('2 of 13 on');

            // Bot build: no cloud delivery channel in the summary.
            document.querySelector('.wg-settings-notifications-cloud').classList.add('wg-settings-hidden');
            document.getElementById('bp-reminders-toggle').checked = true;
            document.getElementById('weight-reminders-toggle').checked = false;
            window.weightUnitPreference = 'lb';
            row(document, 'notifications').click();
            document.querySelector('mt-modal.wg-page .wg-back').click(); // a page close refreshes
            expect(summary('notifications')).toBe('BP');
            expect(summary('units')).toBe('lb');
        } finally {
            cleanup();
        }
    });
});
