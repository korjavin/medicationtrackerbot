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
});
