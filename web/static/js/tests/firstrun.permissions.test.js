import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const STATE_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/state.js');
const HELPER_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/permissions.js');
const WELCOME_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/screens/welcome.js');
const PERMISSIONS_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/screens/permissions.js');
const DONE_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/screens/done.js');
const INDEX_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/index.js');

// features/firstrun/screens/permissions.js — Task 5. Three rows
// (camera, notifications, location) drive Capacitor permission prompts
// via the helper in features/firstrun/permissions.js, which in turn
// calls into window.MediaCapture / window.Reminders / window.Geolocation.
// On a web build (Capacitor.isNativePlatform() returns false) the screen
// auto-advances to integrations because the browser handles permissions
// inline at first capability use.

const SHELL_HTML = `<!doctype html><html><body></body></html>`;

function loadFlow({
    bootstrap = null,
    fetchMock = null,
    initialStep = null,
    capacitor = null,
    mediaCapture = null,
    reminders = null,
    geolocation = null,
} = {}) {
    const dom = new JSDOM(SHELL_HTML, {
        url: 'https://example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    if (bootstrap) window.__MEDTRACKER_BOOTSTRAP__ = bootstrap;
    if (fetchMock) window.fetch = fetchMock;
    if (initialStep) window.sessionStorage.setItem('wg-firstrun-step', initialStep);
    if (capacitor !== null) window.Capacitor = capacitor;
    if (mediaCapture) window.MediaCapture = mediaCapture;
    if (reminders) window.Reminders = reminders;
    if (geolocation) window.Geolocation = geolocation;

    // Load order mirrors index.html: state + helper + screen modules before
    // the orchestrator. The orchestrator's mount() reads needs_first_run
    // from the bootstrap object set above and dispatches to the screen
    // registered for the current step.
    for (const file of [STATE_JS, HELPER_JS, WELCOME_JS, PERMISSIONS_JS, DONE_JS, INDEX_JS]) {
        const src = fs.readFileSync(file, 'utf8');
        window.eval(`${src}\n//# sourceURL=file://${file}`);
    }

    return { window, document: window.document, cleanup: () => dom.window.close() };
}

describe('firstrun permissions screen', () => {
    it('on native, renders three permission rows + Allow buttons + Continue/Skip', () => {
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            initialStep: 'permissions',
            capacitor: { isNativePlatform: () => true },
        });
        try {
            window.WGFirstRun.mount();

            const title = document.getElementById('wg-firstrun-title');
            expect(title.textContent).toMatch(/permission/i);

            expect(document.querySelector('[data-firstrun-permission="camera"]')).not.toBeNull();
            expect(document.querySelector('[data-firstrun-permission="notifications"]')).not.toBeNull();
            expect(document.querySelector('[data-firstrun-permission="location"]')).not.toBeNull();

            expect(document.querySelector('[data-firstrun-action="allow-camera"]')).not.toBeNull();
            expect(document.querySelector('[data-firstrun-action="allow-notifications"]')).not.toBeNull();
            expect(document.querySelector('[data-firstrun-action="allow-location"]')).not.toBeNull();

            expect(document.querySelector('[data-firstrun-action="continue"]')).not.toBeNull();
            expect(document.querySelector('[data-firstrun-action="skip"]')).not.toBeNull();
        } finally { cleanup(); }
    });

    it('on native, Allow buttons call MediaCapture/Reminders/Geolocation and grant updates UI', async () => {
        const mediaCapture = { pickPhoto: vi.fn().mockResolvedValue(null) };
        const reminders = { schedule: vi.fn().mockResolvedValue({ scheduled: 0 }) };
        const geolocation = { getCurrentPosition: vi.fn().mockResolvedValue({ coords: { latitude: 0, longitude: 0 } }) };
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            initialStep: 'permissions',
            capacitor: { isNativePlatform: () => true },
            mediaCapture, reminders, geolocation,
        });
        try {
            window.WGFirstRun.mount();
            document.querySelector('[data-firstrun-action="allow-camera"]').click();
            document.querySelector('[data-firstrun-action="allow-notifications"]').click();
            document.querySelector('[data-firstrun-action="allow-location"]').click();
            // The click handlers chain through a Promise.resolve — flush
            // microtasks so the status text + class assignments settle.
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(mediaCapture.pickPhoto).toHaveBeenCalledTimes(1);
            expect(reminders.schedule).toHaveBeenCalledTimes(1);
            expect(reminders.schedule.mock.calls[0][0]).toEqual([]);
            expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1);

            const cameraStatus = document.querySelector('[data-firstrun-permission-status="camera"]');
            const notifStatus = document.querySelector('[data-firstrun-permission-status="notifications"]');
            const locStatus = document.querySelector('[data-firstrun-permission-status="location"]');
            expect(cameraStatus.textContent).toMatch(/allowed/i);
            expect(notifStatus.textContent).toMatch(/allowed/i);
            expect(locStatus.textContent).toMatch(/allowed/i);

            // The granted row picks up the modifier class for the CSS
            // border-tint indicator.
            expect(document.querySelector('[data-firstrun-permission="camera"]').classList.contains('wg-firstrun-permission--granted')).toBe(true);

            // Granted rows lock their Allow button to avoid re-prompting.
            expect(document.querySelector('[data-firstrun-action="allow-camera"]').disabled).toBe(true);
        } finally { cleanup(); }
    });

    it('on native, a PERMISSION_DENIED rejection shows a soft warning and lets the user continue', async () => {
        const denied = Object.assign(new Error('Permission denied'), { code: 'PERMISSION_DENIED', name: 'MediaCaptureError' });
        const mediaCapture = { pickPhoto: vi.fn().mockRejectedValue(denied) };
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            initialStep: 'permissions',
            capacitor: { isNativePlatform: () => true },
            mediaCapture,
            reminders: { schedule: vi.fn().mockResolvedValue(null) },
            geolocation: { getCurrentPosition: vi.fn().mockResolvedValue(null) },
        });
        try {
            window.WGFirstRun.mount();
            document.querySelector('[data-firstrun-action="allow-camera"]').click();
            await new Promise(resolve => setTimeout(resolve, 0));

            const status = document.querySelector('[data-firstrun-permission-status="camera"]');
            expect(status.textContent.toLowerCase()).toContain('permission denied');
            expect(document.querySelector('[data-firstrun-permission="camera"]').classList.contains('wg-firstrun-permission--denied')).toBe(true);
            // After a denial the Allow button is re-enabled so the user can
            // retry without leaving the screen.
            expect(document.querySelector('[data-firstrun-action="allow-camera"]').disabled).toBe(false);

            // Continue still works after a denial — every row is optional.
            document.querySelector('[data-firstrun-action="continue"]').click();
            expect(window.WGFirstRun.state.getStep()).toBe('integrations');
        } finally { cleanup(); }
    });

    it('on native, a non-permission failure surfaces a generic try-again message', async () => {
        const unavailable = Object.assign(new Error('Capacitor Camera plugin not available'), { code: 'UNAVAILABLE', name: 'MediaCaptureError' });
        const mediaCapture = { pickPhoto: vi.fn().mockRejectedValue(unavailable) };
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            initialStep: 'permissions',
            capacitor: { isNativePlatform: () => true },
            mediaCapture,
            reminders: { schedule: vi.fn().mockResolvedValue(null) },
            geolocation: { getCurrentPosition: vi.fn().mockResolvedValue(null) },
        });
        try {
            window.WGFirstRun.mount();
            document.querySelector('[data-firstrun-action="allow-camera"]').click();
            await new Promise(resolve => setTimeout(resolve, 0));

            const status = document.querySelector('[data-firstrun-permission-status="camera"]');
            expect(status.textContent.toLowerCase()).toContain('couldn');
            expect(status.textContent.toLowerCase()).not.toContain('permission denied');
        } finally { cleanup(); }
    });

    it('on web (isNativePlatform=false), screen auto-advances to integrations without rendering rows', () => {
        const mediaCapture = { pickPhoto: vi.fn() };
        const reminders = { schedule: vi.fn() };
        const geolocation = { getCurrentPosition: vi.fn() };
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            initialStep: 'permissions',
            capacitor: { isNativePlatform: () => false },
            mediaCapture, reminders, geolocation,
        });
        try {
            window.WGFirstRun.mount();
            expect(window.WGFirstRun.state.getStep()).toBe('integrations');
            // The integrations screen has not been registered yet (Task 6),
            // so the orchestrator's _renderCurrentStep clears the panel.
            // The permissions rows must never have been painted in the
            // first place — auto-advance runs before any DOM is added.
            expect(document.querySelector('[data-firstrun-permission="camera"]')).toBeNull();
            expect(document.querySelector('[data-firstrun-permission="notifications"]')).toBeNull();
            expect(document.querySelector('[data-firstrun-permission="location"]')).toBeNull();
            // None of the native abstractions were poked.
            expect(mediaCapture.pickPhoto).not.toHaveBeenCalled();
            expect(reminders.schedule).not.toHaveBeenCalled();
            expect(geolocation.getCurrentPosition).not.toHaveBeenCalled();
        } finally { cleanup(); }
    });

    it('with no window.Capacitor present at all, screen auto-advances to integrations', () => {
        const { window, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            initialStep: 'permissions',
        });
        try {
            window.WGFirstRun.mount();
            expect(window.WGFirstRun.state.getStep()).toBe('integrations');
        } finally { cleanup(); }
    });

    it('"Skip" advances to integrations without triggering any prompts', () => {
        const mediaCapture = { pickPhoto: vi.fn() };
        const reminders = { schedule: vi.fn() };
        const geolocation = { getCurrentPosition: vi.fn() };
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            initialStep: 'permissions',
            capacitor: { isNativePlatform: () => true },
            mediaCapture, reminders, geolocation,
        });
        try {
            window.WGFirstRun.mount();
            document.querySelector('[data-firstrun-action="skip"]').click();
            expect(window.WGFirstRun.state.getStep()).toBe('integrations');
            expect(mediaCapture.pickPhoto).not.toHaveBeenCalled();
            expect(reminders.schedule).not.toHaveBeenCalled();
            expect(geolocation.getCurrentPosition).not.toHaveBeenCalled();
        } finally { cleanup(); }
    });

    it('"Continue" after granting one permission still advances to integrations', async () => {
        const mediaCapture = { pickPhoto: vi.fn().mockResolvedValue(null) };
        const reminders = { schedule: vi.fn().mockResolvedValue({ scheduled: 0 }) };
        const geolocation = { getCurrentPosition: vi.fn().mockResolvedValue({ coords: { latitude: 0, longitude: 0 } }) };
        const { window, document, cleanup } = loadFlow({
            bootstrap: { needs_first_run: true },
            initialStep: 'permissions',
            capacitor: { isNativePlatform: () => true },
            mediaCapture, reminders, geolocation,
        });
        try {
            window.WGFirstRun.mount();
            document.querySelector('[data-firstrun-action="allow-camera"]').click();
            await new Promise(resolve => setTimeout(resolve, 0));
            document.querySelector('[data-firstrun-action="continue"]').click();
            expect(window.WGFirstRun.state.getStep()).toBe('integrations');
            expect(mediaCapture.pickPhoto).toHaveBeenCalledTimes(1);
            expect(reminders.schedule).not.toHaveBeenCalled();
            expect(geolocation.getCurrentPosition).not.toHaveBeenCalled();
        } finally { cleanup(); }
    });
});
