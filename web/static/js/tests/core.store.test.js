import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

function loadStore() {
    const dom = new JSDOM('<!DOCTYPE html>', { url: 'https://example.test/', runScripts: 'outside-only' });
    const { window } = dom;
    const src = fs.readFileSync(
        path.join(REPO_ROOT, 'web/static/js/core/store.js'),
        'utf8'
    );
    window.eval(`${src}\n//# sourceURL=file://store.js`);
    return { window, cleanup: () => dom.window.close() };
}

describe('AppStore', () => {
    it('is exposed on window', () => {
        const { window, cleanup } = loadStore();
        try {
            expect(typeof window.AppStore).toBe('object');
        } finally {
            cleanup();
        }
    });

    it('get returns undefined for unknown keys', () => {
        const { window, cleanup } = loadStore();
        try {
            expect(window.AppStore.get('unknown')).toBeUndefined();
        } finally {
            cleanup();
        }
    });

    it('set and get round-trip a value', () => {
        const { window, cleanup } = loadStore();
        try {
            window.AppStore.set('myKey', 42);
            expect(window.AppStore.get('myKey')).toBe(42);
        } finally {
            cleanup();
        }
    });

    it('set replaces previous value', () => {
        const { window, cleanup } = loadStore();
        try {
            window.AppStore.set('x', 'first');
            window.AppStore.set('x', 'second');
            expect(window.AppStore.get('x')).toBe('second');
        } finally {
            cleanup();
        }
    });

    it('subscribe notifies handler on set', () => {
        const { window, cleanup } = loadStore();
        try {
            const received = [];
            window.AppStore.subscribe('foo', v => received.push(v));
            window.AppStore.set('foo', 'a');
            window.AppStore.set('foo', 'b');
            expect(received).toEqual(['a', 'b']);
        } finally {
            cleanup();
        }
    });

    it('subscribe does not fire for other keys', () => {
        const { window, cleanup } = loadStore();
        try {
            const received = [];
            window.AppStore.subscribe('foo', v => received.push(v));
            window.AppStore.set('bar', 'x');
            expect(received).toHaveLength(0);
        } finally {
            cleanup();
        }
    });

    it('multiple subscribers on the same key all receive the value', () => {
        const { window, cleanup } = loadStore();
        try {
            const a = [], b = [];
            window.AppStore.subscribe('k', v => a.push(v));
            window.AppStore.subscribe('k', v => b.push(v));
            window.AppStore.set('k', 99);
            expect(a).toEqual([99]);
            expect(b).toEqual([99]);
        } finally {
            cleanup();
        }
    });

    it('stores object values by reference', () => {
        const { window, cleanup } = loadStore();
        try {
            const settings = { food: true, bp: false };
            window.AppStore.set('featureSettings', settings);
            expect(window.AppStore.get('featureSettings')).toBe(settings);
        } finally {
            cleanup();
        }
    });
});
