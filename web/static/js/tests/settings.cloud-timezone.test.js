/** @vitest-environment jsdom */
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('cloud Timezone block visibility (server vs cloud mode)', () => {
    it('server mode: timezone block stays visible', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();

            expect(document.querySelector('.wg-settings-timezone').classList.contains('wg-settings-hidden')).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('cloud mode: hides the timezone block', async () => {
        allowConsoleNoise();
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            window.loadCloudPushModule = () => Promise.resolve({});
            window.loadCloudRemindersModule = () => Promise.resolve({});
            window.apiCall = vi.fn(async () => { throw new Error('offline'); });
            await window.loadSettings();

            expect(document.querySelector('.wg-settings-timezone').classList.contains('wg-settings-hidden')).toBe(true);
        } finally {
            cleanup();
        }
    });
});
