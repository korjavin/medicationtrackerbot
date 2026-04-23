import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const INDEX_HTML = path.join(REPO_ROOT, 'web/static/index.html');

function loadIndex() {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const dom = new JSDOM(html, { url: 'https://example.test/' });
    return { dom, cleanup: () => dom.window.close() };
}

describe('Settings Features section (Phase 9, Task 5)', () => {
    it('renders the Features section as a .wg-card with a mono title and description', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const settingsView = dom.window.document.getElementById('settings-view');
            const sections = settingsView.querySelectorAll('.wg-settings-section');
            const titles = Array.from(sections).map((c) => {
                const t = c.querySelector('.wg-settings-section__title');
                return t ? t.textContent.trim() : '';
            });
            expect(titles).toContain('Features');

            const card = Array.from(sections).find((c) =>
                c.querySelector('.wg-settings-section__title')?.textContent?.trim() === 'Features'
            );
            expect(card).toBeDefined();
            expect(card.classList.contains('wg-card')).toBe(true);

            const desc = card.querySelector('.wg-settings-section__desc');
            expect(desc).not.toBeNull();
            expect(desc.textContent.toLowerCase()).toContain('enable');
        } finally {
            cleanup();
        }
    });

    it('mounts all six feature toggles inside the Features card', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const doc = dom.window.document;
            const featuresCard = Array.from(doc.querySelectorAll('.wg-settings-section')).find(
                (c) => c.querySelector('.wg-settings-section__title')?.textContent?.trim() === 'Features'
            );
            expect(featuresCard).toBeDefined();

            const expected = [
                'bp-feature-toggle',
                'weight-feature-toggle',
                'workout-feature-toggle',
                'medication-feature-toggle',
                'food-intake-toggle',
                'health-feature-toggle',
            ];
            for (const inputId of expected) {
                const setting = doc.querySelector(`mt-setting-toggle[input-id="${inputId}"]`);
                expect(setting, `missing <mt-setting-toggle input-id="${inputId}">`).not.toBeNull();
                expect(featuresCard.contains(setting)).toBe(true);
            }
        } finally {
            cleanup();
        }
    });

    it('does not mount reminder toggles inside the Features card', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const doc = dom.window.document;
            const featuresCard = Array.from(doc.querySelectorAll('.wg-settings-section')).find(
                (c) => c.querySelector('.wg-settings-section__title')?.textContent?.trim() === 'Features'
            );
            const bpReminders = doc.querySelector('mt-setting-toggle[input-id="bp-reminders-toggle"]');
            const weightReminders = doc.querySelector('mt-setting-toggle[input-id="weight-reminders-toggle"]');
            expect(featuresCard.contains(bpReminders)).toBe(false);
            expect(featuresCard.contains(weightReminders)).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('renders feature toggles inside a .wg-settings-row-list', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const doc = dom.window.document;
            const featuresCard = Array.from(doc.querySelectorAll('.wg-settings-section')).find(
                (c) => c.querySelector('.wg-settings-section__title')?.textContent?.trim() === 'Features'
            );
            const list = featuresCard.querySelector('.wg-settings-row-list');
            expect(list).not.toBeNull();
            const toggles = list.querySelectorAll('mt-setting-toggle');
            expect(toggles.length).toBe(6);
        } finally {
            cleanup();
        }
    });
});

describe('Settings Reminders section (Phase 9, Task 5)', () => {
    it('renders the Reminders section as a .wg-card with a mono title and description', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const settingsView = dom.window.document.getElementById('settings-view');
            const sections = settingsView.querySelectorAll('.wg-settings-section');
            const titles = Array.from(sections).map((c) => {
                const t = c.querySelector('.wg-settings-section__title');
                return t ? t.textContent.trim() : '';
            });
            expect(titles).toContain('Reminders');

            const card = Array.from(sections).find((c) =>
                c.querySelector('.wg-settings-section__title')?.textContent?.trim() === 'Reminders'
            );
            expect(card).toBeDefined();
            expect(card.classList.contains('wg-card')).toBe(true);

            const desc = card.querySelector('.wg-settings-section__desc');
            expect(desc).not.toBeNull();
            expect(desc.textContent.toLowerCase()).toContain('remind');
        } finally {
            cleanup();
        }
    });

    it('mounts both reminder toggles inside the Reminders card', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const doc = dom.window.document;
            const remindersCard = Array.from(doc.querySelectorAll('.wg-settings-section')).find(
                (c) => c.querySelector('.wg-settings-section__title')?.textContent?.trim() === 'Reminders'
            );
            expect(remindersCard).toBeDefined();

            const bpReminders = doc.querySelector('mt-setting-toggle[input-id="bp-reminders-toggle"]');
            const weightReminders = doc.querySelector('mt-setting-toggle[input-id="weight-reminders-toggle"]');
            expect(bpReminders).not.toBeNull();
            expect(weightReminders).not.toBeNull();
            expect(remindersCard.contains(bpReminders)).toBe(true);
            expect(remindersCard.contains(weightReminders)).toBe(true);

            const list = remindersCard.querySelector('.wg-settings-row-list');
            expect(list).not.toBeNull();
            expect(list.querySelectorAll('mt-setting-toggle').length).toBe(2);
        } finally {
            cleanup();
        }
    });

    it('does not mount feature toggles inside the Reminders card', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const doc = dom.window.document;
            const remindersCard = Array.from(doc.querySelectorAll('.wg-settings-section')).find(
                (c) => c.querySelector('.wg-settings-section__title')?.textContent?.trim() === 'Reminders'
            );
            const bpFeature = doc.querySelector('mt-setting-toggle[input-id="bp-feature-toggle"]');
            const foodFeature = doc.querySelector('mt-setting-toggle[input-id="food-intake-toggle"]');
            expect(remindersCard.contains(bpFeature)).toBe(false);
            expect(remindersCard.contains(foodFeature)).toBe(false);
        } finally {
            cleanup();
        }
    });
});

describe('Settings toggle `divider` attribute (Phase 9, Task 5)', () => {
    it('removes the `divider` attribute from all feature + reminder toggles in markup', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const doc = dom.window.document;
            const ids = [
                'bp-feature-toggle',
                'weight-feature-toggle',
                'workout-feature-toggle',
                'medication-feature-toggle',
                'food-intake-toggle',
                'health-feature-toggle',
                'bp-reminders-toggle',
                'weight-reminders-toggle',
            ];
            for (const id of ids) {
                const el = doc.querySelector(`mt-setting-toggle[input-id="${id}"]`);
                expect(el, `missing <mt-setting-toggle input-id="${id}">`).not.toBeNull();
                expect(el.hasAttribute('divider')).toBe(false);
            }
        } finally {
            cleanup();
        }
    });

    it('keeps the `divider` attribute working for backwards compatibility (still applies .setting-item-divider)', () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            const manual = document.createElement('mt-setting-toggle');
            manual.setAttribute('title', 'Legacy Toggle');
            manual.setAttribute('description', 'Created with divider attr');
            manual.setAttribute('input-id', 'legacy-divider-toggle');
            manual.setAttribute('divider', '');
            document.body.appendChild(manual);

            expect(manual.classList.contains('setting-item-divider')).toBe(true);
            expect(manual.classList.contains('wg-settings-row')).toBe(true);
        } finally {
            cleanup();
        }
    });
});

describe('Feature toggle round-trip via window.toggleFeatureSetting (Phase 9, Task 5)', () => {
    it('window.toggleFeatureSetting persists feature and invalidates settings tags', async () => {
        const { window, cleanup } = loadFrontendEnv();
        try {
            const apiCallSpy = vi.fn().mockResolvedValue({ ok: true });
            const invalidateSpy = vi.fn().mockResolvedValue(undefined);
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = invalidateSpy;

            await window.toggleFeatureSetting('health', true);

            const call = apiCallSpy.mock.calls.find(
                (args) => typeof args[0] === 'string' && args[0] === '/api/settings/features/health'
            );
            expect(call).toBeDefined();
            expect(call[1]).toBe('POST');
            expect(call[2]).toEqual({ enabled: true });
            expect(invalidateSpy).toHaveBeenCalledWith(['settings', 'feature_settings']);
        } finally {
            cleanup();
        }
    });

    it('window.toggleFeatureSetting routes each feature key to /api/settings/features/<feature>', async () => {
        const { window, cleanup } = loadFrontendEnv();
        try {
            const apiCallSpy = vi.fn().mockResolvedValue({ ok: true });
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);

            const features = ['bp', 'weight', 'workout', 'medication', 'food', 'health'];
            for (const feature of features) {
                apiCallSpy.mockClear();
                await window.toggleFeatureSetting(feature, false);
                const call = apiCallSpy.mock.calls.find(
                    (args) => typeof args[0] === 'string' && args[0] === `/api/settings/features/${feature}`
                );
                expect(call, `expected POST /api/settings/features/${feature}`).toBeDefined();
                expect(call[1]).toBe('POST');
                expect(call[2]).toEqual({ enabled: false });
            }
        } finally {
            cleanup();
        }
    });

    it('feature-toggle checkboxes exist with expected ids after harness boot', () => {
        const { document, cleanup } = loadFrontendEnv();
        try {
            const ids = [
                'bp-feature-toggle',
                'weight-feature-toggle',
                'workout-feature-toggle',
                'medication-feature-toggle',
                'food-intake-toggle',
                'health-feature-toggle',
            ];
            for (const id of ids) {
                const input = document.getElementById(id);
                expect(input, `missing input#${id}`).not.toBeNull();
                expect(input.type).toBe('checkbox');
            }
        } finally {
            cleanup();
        }
    });
});

describe('Reminder toggle round-trip via change event (Phase 9, Task 5)', () => {
    it('flipping bp-reminders-toggle on hits POST /api/bp/reminder/toggle with enabled:true', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            const apiCallSpy = vi.fn().mockResolvedValue({ ok: true });
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);

            const toggle = document.getElementById('bp-reminders-toggle');
            expect(toggle).not.toBeNull();
            toggle.checked = true;
            toggle.dispatchEvent(new window.Event('change'));

            // Flush microtasks so both bound handlers finish before cleanup.
            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));

            const call = apiCallSpy.mock.calls.find(
                (args) => typeof args[0] === 'string' && args[0] === '/api/bp/reminder/toggle'
            );
            expect(call).toBeDefined();
            expect(call[1]).toBe('POST');
            expect(call[2]).toEqual({ enabled: true });
            expect(toggle.checked).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('flipping weight-reminders-toggle off hits POST /api/weight/reminder/toggle with enabled:false', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            const apiCallSpy = vi.fn().mockResolvedValue({ ok: true });
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);

            const toggle = document.getElementById('weight-reminders-toggle');
            expect(toggle).not.toBeNull();
            toggle.checked = false;
            toggle.dispatchEvent(new window.Event('change'));

            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));

            const call = apiCallSpy.mock.calls.find(
                (args) => typeof args[0] === 'string' && args[0] === '/api/weight/reminder/toggle'
            );
            expect(call).toBeDefined();
            expect(call[1]).toBe('POST');
            expect(call[2]).toEqual({ enabled: false });
            expect(toggle.checked).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('reminder toggle reverts its checked state when the API call fails', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            const apiCallSpy = vi.fn().mockResolvedValue(null);
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);

            const toggle = document.getElementById('bp-reminders-toggle');
            toggle.checked = true;
            toggle.dispatchEvent(new window.Event('change'));

            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(apiCallSpy).toHaveBeenCalled();
            expect(toggle.checked).toBe(false);
        } finally {
            cleanup();
        }
    });
});

describe('Settings toggle disabled-state (Phase 9, Task 5)', () => {
    it('setting the checkbox to disabled reflects in the hidden input state', () => {
        const { document, cleanup } = loadFrontendEnv();
        try {
            const toggle = document.getElementById('bp-feature-toggle');
            expect(toggle).not.toBeNull();
            toggle.disabled = true;
            expect(toggle.disabled).toBe(true);

            toggle.disabled = false;
            expect(toggle.disabled).toBe(false);
        } finally {
            cleanup();
        }
    });
});
