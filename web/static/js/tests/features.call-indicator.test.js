/**
 * features.call-indicator.test.js
 *
 * Persistent call indicator — floating pill above the bottom nav that
 * surfaces ElevenLabs call state across tab switches.
 *
 * features/call-indicator.js subscribes to the `wg-call-state` window event
 * (emitted by elevenlabs-call.js) and toggles visibility / status text /
 * data-state via the [hidden] attribute and CSS classes — never inline styles.
 *
 * Tests cover: mount, hidden initial state, idle keeps it hidden,
 * connecting / in_call / error each render visible with correct status text
 * and data-state, and the hang-up button calls WGCallAgent.endCall().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CALL_INDICATOR_JS = path.join(REPO_ROOT, 'web/static/js/features/call-indicator.js');

function createEnv({ agent } = {}) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://example.test/',
        runScripts: 'outside-only'
    });
    const { window } = dom;

    if (agent) {
        window.WGCallAgent = agent;
    }

    window.eval(fs.readFileSync(CALL_INDICATOR_JS, 'utf8'));

    return {
        window,
        document: window.document,
        cleanup: () => dom.window.close()
    };
}

function dispatchState(window, detail) {
    window.dispatchEvent(new window.CustomEvent('wg-call-state', { detail }));
}

describe('features/call-indicator.js — persistent call-state pill', () => {
    it('exposes window.WGCallIndicator with mount + destroy', () => {
        const { window, cleanup } = createEnv();
        try {
            expect(window.WGCallIndicator).toBeDefined();
            expect(typeof window.WGCallIndicator.mount).toBe('function');
            expect(typeof window.WGCallIndicator.destroy).toBe('function');
        } finally {
            cleanup();
        }
    });

    it('mount() appends a hidden pill to the supplied parent', () => {
        const { window, document, cleanup } = createEnv();
        try {
            window.WGCallIndicator.mount(document.body);
            const pill = document.querySelector('.wg-call-indicator');
            expect(pill).not.toBeNull();
            expect(pill.hasAttribute('hidden')).toBe(true);
            expect(pill.parentNode).toBe(document.body);
            expect(pill.querySelector('.wg-call-indicator__dot')).not.toBeNull();
            expect(pill.querySelector('.wg-call-indicator__text')).not.toBeNull();
            expect(pill.querySelector('.wg-call-indicator__hang-up')).not.toBeNull();
        } finally {
            cleanup();
        }
    });

    it('stays hidden when state is idle', () => {
        const { window, document, cleanup } = createEnv();
        try {
            window.WGCallIndicator.mount(document.body);
            dispatchState(window, { state: 'idle' });
            const pill = document.querySelector('.wg-call-indicator');
            expect(pill.hasAttribute('hidden')).toBe(true);
            expect(pill.hasAttribute('data-state')).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('renders visible with data-state="connecting" and status text on connecting event', () => {
        const { window, document, cleanup } = createEnv();
        try {
            window.WGCallIndicator.mount(document.body);
            dispatchState(window, { state: 'connecting' });
            const pill = document.querySelector('.wg-call-indicator');
            expect(pill.hasAttribute('hidden')).toBe(false);
            expect(pill.dataset.state).toBe('connecting');
            const text = pill.querySelector('.wg-call-indicator__text').textContent;
            expect(text.length).toBeGreaterThan(0);
        } finally {
            cleanup();
        }
    });

    it('renders visible with data-state="in_call" on in_call event', () => {
        const { window, document, cleanup } = createEnv();
        try {
            window.WGCallIndicator.mount(document.body);
            dispatchState(window, { state: 'in_call' });
            const pill = document.querySelector('.wg-call-indicator');
            expect(pill.hasAttribute('hidden')).toBe(false);
            expect(pill.dataset.state).toBe('in_call');
            const text = pill.querySelector('.wg-call-indicator__text').textContent;
            expect(text.length).toBeGreaterThan(0);
        } finally {
            cleanup();
        }
    });

    it('renders visible with data-state="error" on error event', () => {
        const { window, document, cleanup } = createEnv();
        try {
            window.WGCallIndicator.mount(document.body);
            dispatchState(window, { state: 'error' });
            const pill = document.querySelector('.wg-call-indicator');
            expect(pill.hasAttribute('hidden')).toBe(false);
            expect(pill.dataset.state).toBe('error');
            const text = pill.querySelector('.wg-call-indicator__text').textContent;
            expect(text.length).toBeGreaterThan(0);
        } finally {
            cleanup();
        }
    });

    it('uses the supplied detail.message as status text when provided', () => {
        const { window, document, cleanup } = createEnv();
        try {
            window.WGCallIndicator.mount(document.body);
            dispatchState(window, { state: 'in_call', message: 'Custom status' });
            const text = document.querySelector('.wg-call-indicator__text').textContent;
            expect(text).toBe('Custom status');
        } finally {
            cleanup();
        }
    });

    it('returns to hidden when state transitions back to idle', () => {
        const { window, document, cleanup } = createEnv();
        try {
            window.WGCallIndicator.mount(document.body);
            dispatchState(window, { state: 'connecting' });
            dispatchState(window, { state: 'idle' });
            const pill = document.querySelector('.wg-call-indicator');
            expect(pill.hasAttribute('hidden')).toBe(true);
            expect(pill.hasAttribute('data-state')).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('disables the hang-up button while connecting and re-enables for in_call / error / idle', () => {
        const { window, document, cleanup } = createEnv();
        try {
            window.WGCallIndicator.mount(document.body);
            const button = document.querySelector('.wg-call-indicator__hang-up');

            dispatchState(window, { state: 'connecting' });
            expect(button.disabled).toBe(true);

            dispatchState(window, { state: 'in_call' });
            expect(button.disabled).toBe(false);

            dispatchState(window, { state: 'connecting' });
            expect(button.disabled).toBe(true);

            dispatchState(window, { state: 'error', message: 'boom' });
            expect(button.disabled).toBe(false);

            dispatchState(window, { state: 'idle' });
            expect(button.disabled).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('hang-up button click invokes WGCallAgent.endCall()', () => {
        const endCall = vi.fn();
        const { window, document, cleanup } = createEnv({
            agent: { endCall, getState: () => ({ state: 'idle', message: '' }) }
        });
        try {
            window.WGCallIndicator.mount(document.body);
            const button = document.querySelector('.wg-call-indicator__hang-up');
            button.click();
            expect(endCall).toHaveBeenCalledTimes(1);
        } finally {
            cleanup();
        }
    });

    it('renders initial state from WGCallAgent.getState() when mounted mid-call', () => {
        const { window, document, cleanup } = createEnv({
            agent: { endCall: vi.fn(), getState: () => ({ state: 'in_call', message: 'Live now' }) }
        });
        try {
            window.WGCallIndicator.mount(document.body);
            const pill = document.querySelector('.wg-call-indicator');
            expect(pill.hasAttribute('hidden')).toBe(false);
            expect(pill.dataset.state).toBe('in_call');
            expect(pill.querySelector('.wg-call-indicator__text').textContent).toBe('Live now');
        } finally {
            cleanup();
        }
    });

    it('does not assign inline styles on the indicator or its children', () => {
        const { window, document, cleanup } = createEnv();
        try {
            window.WGCallIndicator.mount(document.body);
            dispatchState(window, { state: 'in_call', message: 'Live' });
            const pill = document.querySelector('.wg-call-indicator');
            expect(pill.getAttribute('style')).toBeNull();
            for (const child of pill.querySelectorAll('*')) {
                expect(child.getAttribute('style')).toBeNull();
            }
        } finally {
            cleanup();
        }
    });

    it('destroy() removes the pill and stops responding to events', () => {
        const { window, document, cleanup } = createEnv();
        try {
            window.WGCallIndicator.mount(document.body);
            window.WGCallIndicator.destroy();
            expect(document.querySelector('.wg-call-indicator')).toBeNull();

            // Subsequent events must not recreate or throw.
            dispatchState(window, { state: 'in_call' });
            expect(document.querySelector('.wg-call-indicator')).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('mount() includes mute and photo buttons plus a hidden file input', () => {
        const { window, document, cleanup } = createEnv();
        try {
            window.WGCallIndicator.mount(document.body);
            const mute = document.querySelector('.wg-call-indicator__mute');
            const photo = document.querySelector('.wg-call-indicator__photo');
            const input = document.querySelector('.wg-call-indicator__photo-input');
            expect(mute).not.toBeNull();
            expect(photo).not.toBeNull();
            expect(input).not.toBeNull();
            expect(mute.getAttribute('aria-pressed')).toBe('false');
            expect(input.getAttribute('type')).toBe('file');
            expect(input.getAttribute('accept')).toBe('image/*');
            // hidden initially (idle)
            expect(mute.hidden).toBe(true);
            expect(photo.hidden).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('hides mute and photo when state is idle', () => {
        const { window, document, cleanup } = createEnv();
        try {
            window.WGCallIndicator.mount(document.body);
            dispatchState(window, { state: 'in_call' });
            dispatchState(window, { state: 'idle' });
            const mute = document.querySelector('.wg-call-indicator__mute');
            const photo = document.querySelector('.wg-call-indicator__photo');
            expect(mute.hidden).toBe(true);
            expect(photo.hidden).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('hides mute and photo when state is error', () => {
        const { window, document, cleanup } = createEnv();
        try {
            window.WGCallIndicator.mount(document.body);
            dispatchState(window, { state: 'error', message: 'boom' });
            const mute = document.querySelector('.wg-call-indicator__mute');
            const photo = document.querySelector('.wg-call-indicator__photo');
            expect(mute.hidden).toBe(true);
            expect(photo.hidden).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('shows mute and photo enabled when state is in_call', () => {
        const { window, document, cleanup } = createEnv();
        try {
            window.WGCallIndicator.mount(document.body);
            dispatchState(window, { state: 'in_call' });
            const mute = document.querySelector('.wg-call-indicator__mute');
            const photo = document.querySelector('.wg-call-indicator__photo');
            expect(mute.hidden).toBe(false);
            expect(photo.hidden).toBe(false);
            expect(mute.disabled).toBe(false);
            expect(photo.disabled).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('shows mute and photo but disabled when state is connecting', () => {
        const { window, document, cleanup } = createEnv();
        try {
            window.WGCallIndicator.mount(document.body);
            dispatchState(window, { state: 'connecting' });
            const mute = document.querySelector('.wg-call-indicator__mute');
            const photo = document.querySelector('.wg-call-indicator__photo');
            expect(mute.hidden).toBe(false);
            expect(photo.hidden).toBe(false);
            expect(mute.disabled).toBe(true);
            expect(photo.disabled).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('reflects muted state via aria-pressed and label', () => {
        const { window, document, cleanup } = createEnv();
        try {
            window.WGCallIndicator.mount(document.body);
            dispatchState(window, { state: 'in_call', muted: true });
            const mute = document.querySelector('.wg-call-indicator__mute');
            expect(mute.getAttribute('aria-pressed')).toBe('true');
            expect(mute.textContent).toBe('Unmute');
            dispatchState(window, { state: 'in_call', muted: false });
            expect(mute.getAttribute('aria-pressed')).toBe('false');
            expect(mute.textContent).toBe('Mute');
        } finally {
            cleanup();
        }
    });

    it('shows Sending… and disables photo button while uploading', () => {
        const { window, document, cleanup } = createEnv();
        try {
            window.WGCallIndicator.mount(document.body);
            dispatchState(window, { state: 'in_call', uploading: true });
            const photo = document.querySelector('.wg-call-indicator__photo');
            expect(photo.disabled).toBe(true);
            expect(photo.textContent).toBe('Sending…');
            dispatchState(window, { state: 'in_call', uploading: false });
            expect(photo.disabled).toBe(false);
            expect(photo.textContent).toBe('Photo');
        } finally {
            cleanup();
        }
    });

    it('mute button click invokes WGCallAgent.toggleMute()', () => {
        const toggleMute = vi.fn();
        const { window, document, cleanup } = createEnv({
            agent: { toggleMute, getState: () => ({ state: 'idle', message: '' }) }
        });
        try {
            window.WGCallIndicator.mount(document.body);
            dispatchState(window, { state: 'in_call' });
            const mute = document.querySelector('.wg-call-indicator__mute');
            mute.click();
            expect(toggleMute).toHaveBeenCalledTimes(1);
        } finally {
            cleanup();
        }
    });

    it('file input change invokes WGCallAgent.sendPhoto with the chosen file and resets value', () => {
        const sendPhoto = vi.fn().mockResolvedValue(undefined);
        const { window, document, cleanup } = createEnv({
            agent: { sendPhoto, getState: () => ({ state: 'in_call', message: '' }) }
        });
        try {
            window.WGCallIndicator.mount(document.body);
            const input = document.querySelector('.wg-call-indicator__photo-input');
            const file = new window.File(['xx'], 'photo.jpg', { type: 'image/jpeg' });
            // jsdom: the .files setter requires a FileList; use Object.defineProperty.
            Object.defineProperty(input, 'files', {
                value: [file],
                configurable: true,
            });
            input.dispatchEvent(new window.Event('change', { bubbles: true }));
            expect(sendPhoto).toHaveBeenCalledTimes(1);
            expect(sendPhoto.mock.calls[0][0]).toBe(file);
            expect(input.value).toBe('');
        } finally {
            cleanup();
        }
    });

    it('clicking the photo button triggers a click on the hidden file input', () => {
        const { window, document, cleanup } = createEnv({
            agent: { sendPhoto: vi.fn(), getState: () => ({ state: 'in_call', message: '' }) }
        });
        try {
            window.WGCallIndicator.mount(document.body);
            const photo = document.querySelector('.wg-call-indicator__photo');
            const input = document.querySelector('.wg-call-indicator__photo-input');
            const inputClick = vi.fn();
            input.click = inputClick;
            photo.click();
            expect(inputClick).toHaveBeenCalledTimes(1);
        } finally {
            cleanup();
        }
    });

    it('does not assign inline styles on the new mute / photo elements', () => {
        const { window, document, cleanup } = createEnv();
        try {
            window.WGCallIndicator.mount(document.body);
            dispatchState(window, { state: 'in_call', muted: true, uploading: true });
            dispatchState(window, { state: 'in_call', muted: false, uploading: false });
            dispatchState(window, { state: 'idle' });
            const pill = document.querySelector('.wg-call-indicator');
            expect(pill.getAttribute('style')).toBeNull();
            for (const child of pill.querySelectorAll('*')) {
                expect(child.getAttribute('style')).toBeNull();
            }
        } finally {
            cleanup();
        }
    });

    it('mounts mid-call from getState() with muted: true and renders mute pressed/Unmute', () => {
        const { window, document, cleanup } = createEnv({
            agent: {
                endCall: vi.fn(),
                getState: () => ({ state: 'in_call', message: 'Live', muted: true, uploading: false })
            }
        });
        try {
            window.WGCallIndicator.mount(document.body);
            const mute = document.querySelector('.wg-call-indicator__mute');
            const photo = document.querySelector('.wg-call-indicator__photo');
            expect(mute.hidden).toBe(false);
            expect(mute.getAttribute('aria-pressed')).toBe('true');
            expect(mute.textContent).toBe('Unmute');
            expect(photo.hidden).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('destroy() removes the new mute/photo elements as well', () => {
        const { window, document, cleanup } = createEnv();
        try {
            window.WGCallIndicator.mount(document.body);
            window.WGCallIndicator.destroy();
            expect(document.querySelector('.wg-call-indicator__mute')).toBeNull();
            expect(document.querySelector('.wg-call-indicator__photo')).toBeNull();
            expect(document.querySelector('.wg-call-indicator__photo-input')).toBeNull();
        } finally {
            cleanup();
        }
    });
});
