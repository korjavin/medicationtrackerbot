import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

function loadController() {
    const dom = new JSDOM('<!DOCTYPE html>', { url: 'https://example.test/', runScripts: 'outside-only' });
    const { window } = dom;
    const src = fs.readFileSync(
        path.join(REPO_ROOT, 'web/static/js/core/modal-controller.js'),
        'utf8'
    );
    window.eval(`${src}\n//# sourceURL=file://modal-controller.js`);
    return { window, cleanup: () => dom.window.close() };
}

describe('withSubmit', () => {
    it('is exposed on window', () => {
        const { window, cleanup } = loadController();
        try {
            expect(typeof window.withSubmit).toBe('function');
        } finally {
            cleanup();
        }
    });

    it('calls asyncFn and resolves', async () => {
        const { window, cleanup } = loadController();
        try {
            let called = false;
            await window.withSubmit(null, async () => { called = true; });
            expect(called).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('disables button while asyncFn runs, re-enables after', async () => {
        const { window, cleanup } = loadController();
        try {
            const btn = window.document.createElement('button');
            const states = [];
            await window.withSubmit(btn, async () => {
                states.push(btn.disabled);
            });
            expect(states).toEqual([true]);
            expect(btn.disabled).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('re-enables button even when asyncFn throws', async () => {
        const { window, cleanup } = loadController();
        try {
            const btn = window.document.createElement('button');
            await window.withSubmit(btn, async () => { throw new Error('boom'); }).catch(() => {});
            expect(btn.disabled).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('skips asyncFn when button is already disabled', async () => {
        const { window, cleanup } = loadController();
        try {
            const btn = window.document.createElement('button');
            btn.disabled = true;
            let called = false;
            await window.withSubmit(btn, async () => { called = true; });
            expect(called).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('works with null button (no guard)', async () => {
        const { window, cleanup } = loadController();
        try {
            let called = false;
            await window.withSubmit(null, async () => { called = true; });
            expect(called).toBe(true);
        } finally {
            cleanup();
        }
    });
});
