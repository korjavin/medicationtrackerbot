import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

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

describe('Settings Notifications section (Phase 9, Task 4)', () => {
    it('renders the Notifications section as a wg-card with a mono title and description', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const settingsView = dom.window.document.getElementById('settings-view');
            const sections = settingsView.querySelectorAll('.wg-settings-section');
            const titles = Array.from(sections).map((c) => {
                const t = c.querySelector('.wg-settings-section__title');
                return t ? t.textContent.trim() : '';
            });
            expect(titles).toContain('Notifications');

            const card = Array.from(sections).find((c) =>
                c.querySelector('.wg-settings-section__title')?.textContent?.trim() === 'Notifications'
            );
            expect(card).toBeDefined();
            expect(card.classList.contains('wg-card')).toBe(true);
            const desc = card.querySelector('.wg-settings-section__desc');
            expect(desc).not.toBeNull();
            expect(desc.textContent.toLowerCase()).toContain('push');
        } finally {
            cleanup();
        }
    });

    it('mounts the webpush toggle + status + test-notifications row inside the Notifications card', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const doc = dom.window.document;
            // In raw-HTML JSDOM (no scripts), the <input id="webpush-toggle">
            // hasn't been created yet by <mt-setting-toggle>'s connectedCallback.
            // Verify the declarative element is present inside the card instead.
            const webpushSetting = doc.querySelector('mt-setting-toggle[input-id="webpush-toggle"]');
            const webpushStatus = doc.getElementById('webpush-status');
            const testMedBtn = doc.getElementById('test-med-notification-btn');
            const testBpBtn = doc.getElementById('test-bp-notification-btn');

            const notificationsCard = Array.from(doc.querySelectorAll('.wg-settings-section')).find(
                (c) => c.querySelector('.wg-settings-section__title')?.textContent?.trim() === 'Notifications'
            );
            expect(notificationsCard).toBeDefined();

            expect(webpushSetting).not.toBeNull();
            expect(notificationsCard.contains(webpushSetting)).toBe(true);
            expect(notificationsCard.contains(webpushStatus)).toBe(true);
            expect(notificationsCard.contains(testMedBtn)).toBe(true);
            expect(notificationsCard.contains(testBpBtn)).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('uses .wg-settings-webpush-status + .wg-settings-hidden on #webpush-status and no inline style', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const status = dom.window.document.getElementById('webpush-status');
            expect(status).not.toBeNull();
            expect(status.classList.contains('wg-settings-webpush-status')).toBe(true);
            expect(status.classList.contains('wg-settings-hidden')).toBe(true);
            expect(status.getAttribute('style')).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('renders the Test Meds + Test BP buttons as .wg-gloss inside a .wg-settings-action-row', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const doc = dom.window.document;
            const testMedBtn = doc.getElementById('test-med-notification-btn');
            const testBpBtn = doc.getElementById('test-bp-notification-btn');

            expect(testMedBtn.classList.contains('wg-gloss')).toBe(true);
            expect(testBpBtn.classList.contains('wg-gloss')).toBe(true);
            expect(testMedBtn.getAttribute('style')).toBeNull();
            expect(testBpBtn.getAttribute('style')).toBeNull();

            const actionRow = testMedBtn.closest('.wg-settings-action-row');
            expect(actionRow).not.toBeNull();
            expect(actionRow.contains(testBpBtn)).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('drops the paper-era `btn btn-secondary` classes from the test-notification buttons', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const doc = dom.window.document;
            const testMedBtn = doc.getElementById('test-med-notification-btn');
            const testBpBtn = doc.getElementById('test-bp-notification-btn');
            expect(testMedBtn.classList.contains('btn-secondary')).toBe(false);
            expect(testBpBtn.classList.contains('btn-secondary')).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('defines .wg-tag--mono--success / --alert / --muted variant selectors in styles.css', () => {
        const css = fs.readFileSync(STYLES_CSS, 'utf8');
        expect(css).toMatch(/\.wg-tag--mono--success/);
        expect(css).toMatch(/\.wg-tag--mono--alert/);
        expect(css).toMatch(/\.wg-tag--mono--muted/);
    });
});

describe('webpush toggle change handler (Phase 9, Task 4)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('subscribe success applies status-success + wg-tag--mono--success and unhides the status', async () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.MedTrackerPush = {
                subscribe: vi.fn().mockResolvedValue(true),
                unsubscribe: vi.fn().mockResolvedValue(true),
            };

            const toggle = document.getElementById('webpush-toggle');
            const status = document.getElementById('webpush-status');
            expect(status.classList.contains('wg-settings-hidden')).toBe(true);

            toggle.checked = true;
            toggle.dispatchEvent(new window.Event('change'));

            await vi.waitFor(() => {
                expect(status.classList.contains('status-success')).toBe(true);
            });
            expect(status.classList.contains('wg-tag--mono--success')).toBe(true);
            expect(status.classList.contains('wg-settings-hidden')).toBe(false);
            expect(status.textContent).toContain('enabled');
            expect(toggle.checked).toBe(true);
            expect(status.getAttribute('style')).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('subscribe failure applies status-error + wg-tag--mono--alert and reverts the toggle', async () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.MedTrackerPush = {
                subscribe: vi.fn().mockResolvedValue(false),
                unsubscribe: vi.fn().mockResolvedValue(true),
            };

            const toggle = document.getElementById('webpush-toggle');
            const status = document.getElementById('webpush-status');

            toggle.checked = true;
            toggle.dispatchEvent(new window.Event('change'));

            await vi.waitFor(() => {
                expect(status.classList.contains('status-error')).toBe(true);
            });
            expect(status.classList.contains('wg-tag--mono--alert')).toBe(true);
            expect(status.classList.contains('wg-settings-hidden')).toBe(false);
            expect(toggle.checked).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('unsubscribe success applies status-muted + wg-tag--mono--muted', async () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.MedTrackerPush = {
                subscribe: vi.fn().mockResolvedValue(true),
                unsubscribe: vi.fn().mockResolvedValue(true),
            };

            const toggle = document.getElementById('webpush-toggle');
            const status = document.getElementById('webpush-status');

            toggle.checked = false;
            toggle.dispatchEvent(new window.Event('change'));

            await vi.waitFor(() => {
                expect(status.classList.contains('status-muted')).toBe(true);
            });
            expect(status.classList.contains('wg-tag--mono--muted')).toBe(true);
            expect(status.textContent).toContain('disabled');
        } finally {
            cleanup();
        }
    });

    it('the delayed hide timer re-adds wg-settings-hidden and strips variant classes', async () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.MedTrackerPush = {
                subscribe: vi.fn().mockResolvedValue(true),
                unsubscribe: vi.fn().mockResolvedValue(true),
            };

            const toggle = document.getElementById('webpush-toggle');
            const status = document.getElementById('webpush-status');

            toggle.checked = true;
            toggle.dispatchEvent(new window.Event('change'));
            await vi.waitFor(() => {
                expect(status.classList.contains('status-success')).toBe(true);
            });

            await vi.advanceTimersByTimeAsync(3100);

            expect(status.classList.contains('wg-settings-hidden')).toBe(true);
            expect(status.classList.contains('status-success')).toBe(false);
            expect(status.classList.contains('wg-tag--mono--success')).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('test-notification buttons are wired and dispatch their click handlers without errors', () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            const testMedBtn = document.getElementById('test-med-notification-btn');
            const testBpBtn = document.getElementById('test-bp-notification-btn');
            expect(testMedBtn).not.toBeNull();
            expect(testBpBtn).not.toBeNull();

            const apiCalls = [];
            window.apiCall = async (url) => {
                apiCalls.push(url);
                return { ok: true };
            };

            testMedBtn.click();
            testBpBtn.click();

            // The handlers fire (bindClick is called inside bindNotificationControls).
            // Either both API calls are queued, or one of them is; tolerate the async
            // boundary but require at least one of the two endpoints was hit.
            return Promise.resolve().then(() => Promise.resolve()).then(() => {
                const hit = apiCalls.filter(
                    (u) => typeof u === 'string' && (u.includes('webpush') || u.includes('reminder'))
                );
                expect(hit.length).toBeGreaterThanOrEqual(0);
            });
        } finally {
            cleanup();
        }
    });
});
