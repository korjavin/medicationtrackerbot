import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

function loadUtils() {
    const dom = new JSDOM('<!DOCTYPE html>', { url: 'https://example.test/', runScripts: 'outside-only' });
    const { window } = dom;
    const src = fs.readFileSync(
        path.join(REPO_ROOT, 'web/static/js/core/utils.js'),
        'utf8'
    );
    window.eval(`${src}\n//# sourceURL=file://utils.js`);
    return { window, cleanup: () => dom.window.close() };
}

describe('escapeHtml', () => {
    it('is exposed on window after loading core/utils.js', () => {
        const { window, cleanup } = loadUtils();
        try {
            expect(typeof window.escapeHtml).toBe('function');
        } finally {
            cleanup();
        }
    });

    it('returns empty string for falsy input', () => {
        const { window, cleanup } = loadUtils();
        try {
            expect(window.escapeHtml('')).toBe('');
            expect(window.escapeHtml(null)).toBe('');
            expect(window.escapeHtml(undefined)).toBe('');
            expect(window.escapeHtml(0)).toBe('');
        } finally {
            cleanup();
        }
    });

    it('escapes ampersand', () => {
        const { window, cleanup } = loadUtils();
        try {
            expect(window.escapeHtml('a & b')).toBe('a &amp; b');
        } finally {
            cleanup();
        }
    });

    it('escapes less-than and greater-than', () => {
        const { window, cleanup } = loadUtils();
        try {
            expect(window.escapeHtml('<script>')).toBe('&lt;script&gt;');
        } finally {
            cleanup();
        }
    });

    it('escapes double and single quotes', () => {
        const { window, cleanup } = loadUtils();
        try {
            expect(window.escapeHtml(`"quoted" 'apos'`))
                .toBe('&quot;quoted&quot; &#039;apos&#039;');
        } finally {
            cleanup();
        }
    });

    it('encodes ampersand before other entities (no double-encoding)', () => {
        const { window, cleanup } = loadUtils();
        try {
            // Order matters: if & were last, "&lt;" produced by < would itself
            // become "&amp;lt;". Guard the order.
            expect(window.escapeHtml('<&>')).toBe('&lt;&amp;&gt;');
        } finally {
            cleanup();
        }
    });

    it('coerces non-string input through String()', () => {
        const { window, cleanup } = loadUtils();
        try {
            expect(window.escapeHtml(42)).toBe('42');
        } finally {
            cleanup();
        }
    });
});
