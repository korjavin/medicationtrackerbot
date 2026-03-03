import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APP_KERNEL_JS = path.join(REPO_ROOT, 'web/static/js/core/app-kernel.js');

function loadKernel() {
    const dom = new JSDOM('<!DOCTYPE html>', { url: 'https://example.test/', runScripts: 'outside-only' });
    const { window } = dom;
    const source = fs.readFileSync(APP_KERNEL_JS, 'utf8');
    window.eval(`${source}\n//# sourceURL=file://${APP_KERNEL_JS}`);
    return { window, cleanup: () => dom.window.close() };
}

describe('AppKernel', () => {
    it('is exposed on window after load', () => {
        const { window, cleanup } = loadKernel();
        try {
            expect(window.AppKernel).toBeDefined();
            expect(typeof window.AppKernel.register).toBe('function');
            expect(typeof window.AppKernel.get).toBe('function');
            expect(typeof window.AppKernel.onTabSwitch).toBe('function');
            expect(typeof window.AppKernel.onAuth).toBe('function');
            expect(typeof window.AppKernel.onReady).toBe('function');
        } finally {
            cleanup();
        }
    });

    it('register + get round-trips a module', () => {
        const { window, cleanup } = loadKernel();
        try {
            const mod = { name: 'test' };
            window.AppKernel.register('myFeature', mod);
            expect(window.AppKernel.get('myFeature')).toBe(mod);
        } finally {
            cleanup();
        }
    });

    it('register returns AppKernel for chaining', () => {
        const { window, cleanup } = loadKernel();
        try {
            const result = window.AppKernel.register('a', {});
            expect(result).toBe(window.AppKernel);
        } finally {
            cleanup();
        }
    });

    it('get returns undefined for unknown module', () => {
        const { window, cleanup } = loadKernel();
        try {
            expect(window.AppKernel.get('nonexistent')).toBeUndefined();
        } finally {
            cleanup();
        }
    });

    it('onTabSwitch calls onTabSwitch on all registered modules', () => {
        const { window, cleanup } = loadKernel();
        try {
            const onTabSwitch1 = vi.fn();
            const onTabSwitch2 = vi.fn();
            window.AppKernel.register('m1', { onTabSwitch: onTabSwitch1 });
            window.AppKernel.register('m2', { onTabSwitch: onTabSwitch2 });
            window.AppKernel.register('m3', {}); // no onTabSwitch — should not throw

            window.AppKernel.onTabSwitch('bp');

            expect(onTabSwitch1).toHaveBeenCalledWith('bp');
            expect(onTabSwitch2).toHaveBeenCalledWith('bp');
        } finally {
            cleanup();
        }
    });

    it('onAuth calls onAuth on all registered modules', () => {
        const { window, cleanup } = loadKernel();
        try {
            const onAuth1 = vi.fn();
            const onAuth2 = vi.fn();
            window.AppKernel.register('a1', { onAuth: onAuth1 });
            window.AppKernel.register('a2', { onAuth: onAuth2 });
            window.AppKernel.register('a3', {}); // no onAuth

            window.AppKernel.onAuth(true);

            expect(onAuth1).toHaveBeenCalledWith(true);
            expect(onAuth2).toHaveBeenCalledWith(true);
        } finally {
            cleanup();
        }
    });

    it('onReady fires callback immediately when DOM is already loaded', () => {
        const dom = new JSDOM('<!DOCTYPE html>', { url: 'https://example.test/', runScripts: 'outside-only' });
        const { window } = dom;
        // Force readyState to 'complete' (already loaded)
        Object.defineProperty(window.document, 'readyState', { value: 'complete', writable: true });

        const source = fs.readFileSync(APP_KERNEL_JS, 'utf8');
        window.eval(`${source}\n//# sourceURL=file://${APP_KERNEL_JS}`);

        const cb = vi.fn();
        window.AppKernel.onReady(cb);
        expect(cb).toHaveBeenCalledTimes(1);
        dom.window.close();
    });

    it('onReady defers callback when DOM is loading', () => {
        const dom = new JSDOM('<!DOCTYPE html>', { url: 'https://example.test/', runScripts: 'outside-only' });
        const { window } = dom;
        Object.defineProperty(window.document, 'readyState', { value: 'loading', writable: true });

        const source = fs.readFileSync(APP_KERNEL_JS, 'utf8');
        window.eval(`${source}\n//# sourceURL=file://${APP_KERNEL_JS}`);

        const cb = vi.fn();
        window.AppKernel.onReady(cb);
        expect(cb).not.toHaveBeenCalled();

        // Fire DOMContentLoaded
        window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
        expect(cb).toHaveBeenCalledTimes(1);
        dom.window.close();
    });

    it('each load produces an independent registry (no cross-test leakage)', () => {
        const e1 = loadKernel();
        const e2 = loadKernel();
        try {
            e1.window.AppKernel.register('sharedName', { value: 1 });
            expect(e2.window.AppKernel.get('sharedName')).toBeUndefined();
        } finally {
            e1.cleanup();
            e2.cleanup();
        }
    });
});
