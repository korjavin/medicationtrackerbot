// BrowserAdapter coverage — verifies that when window.Telegram is absent at
// script-eval time, window.MessengerAdapter selects the BrowserAdapter and
// each method exercises its native fallback (window.alert / window.confirm /
// URL-derived start param / popstate-driven back).
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ADAPTER_SRC = fs.readFileSync(
    path.join(REPO_ROOT, 'web/static/js/core/messenger-adapter.js'),
    'utf8'
);
const CORE_API_SRC = fs.readFileSync(
    path.join(REPO_ROOT, 'web/static/js/core/api.js'),
    'utf8'
);

function loadWithoutTelegram({ url = 'https://example.test/' } = {}) {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url,
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    // Sanity: nothing should be defining window.Telegram in this path.
    expect(window.Telegram).toBeUndefined();
    window.eval(`${ADAPTER_SRC}\n//# sourceURL=file://messenger-adapter.js`);
    return { window, cleanup: () => dom.window.close() };
}

describe('MessengerAdapter — Browser path', () => {
    it('selects BrowserAdapter when window.Telegram is absent', () => {
        const { window, cleanup } = loadWithoutTelegram();
        try {
            expect(window.MessengerAdapter).toBeTruthy();
            expect(window.MessengerAdapter.isPresent()).toBe(false);
            expect(window.MessengerAdapter.authHeaderName()).toBe(null);
            expect(window.MessengerAdapter.identityToken()).toBe(null);
        } finally { cleanup(); }
    });

    it('init() resolves to a Promise immediately', async () => {
        const { window, cleanup } = loadWithoutTelegram();
        try {
            const p = window.MessengerAdapter.init();
            expect(typeof p.then).toBe('function');
            await expect(p).resolves.toBeUndefined();
        } finally { cleanup(); }
    });

    it('alert() forwards to native window.alert', () => {
        const { window, cleanup } = loadWithoutTelegram();
        try {
            const seen = [];
            window.alert = (msg) => { seen.push(msg); };
            window.MessengerAdapter.alert('hello');
            expect(seen).toEqual(['hello']);
        } finally { cleanup(); }
    });

    it('confirm() wraps native window.confirm in a Promise<boolean>', async () => {
        const { window, cleanup } = loadWithoutTelegram();
        try {
            window.confirm = vi.fn(() => true);
            const ok = await window.MessengerAdapter.confirm('sure?');
            expect(ok).toBe(true);
            expect(window.confirm).toHaveBeenCalledWith('sure?');
        } finally { cleanup(); }
    });

    it('confirm() returns false when window.confirm returns false', async () => {
        const { window, cleanup } = loadWithoutTelegram();
        try {
            window.confirm = () => false;
            await expect(window.MessengerAdapter.confirm('sure?')).resolves.toBe(false);
        } finally { cleanup(); }
    });

    it('showPopup() falls back to window.alert with combined title/message', () => {
        const { window, cleanup } = loadWithoutTelegram();
        try {
            const seen = [];
            window.alert = (msg) => { seen.push(msg); };
            window.MessengerAdapter.showPopup({ title: 'T', message: 'M' });
            expect(seen).toEqual(['T\n\nM']);
        } finally { cleanup(); }
    });

    it('showPopup() falls back to just the message when only message is set', () => {
        const { window, cleanup } = loadWithoutTelegram();
        try {
            const seen = [];
            window.alert = (msg) => { seen.push(msg); };
            window.MessengerAdapter.showPopup({ message: 'just-msg' });
            expect(seen).toEqual(['just-msg']);
        } finally { cleanup(); }
    });

    it('startParam() returns null when neither query nor hash carries one', () => {
        const { window, cleanup } = loadWithoutTelegram({ url: 'https://example.test/' });
        try {
            expect(window.MessengerAdapter.startParam()).toBe(null);
        } finally { cleanup(); }
    });

    it('startParam() reads ?start= from the URL query', () => {
        const { window, cleanup } = loadWithoutTelegram({
            url: 'https://example.test/?start=bp_add',
        });
        try {
            expect(window.MessengerAdapter.startParam()).toBe('bp_add');
        } finally { cleanup(); }
    });

    it('startParam() reads #start= from the URL hash', () => {
        const { window, cleanup } = loadWithoutTelegram({
            url: 'https://example.test/#start=weight_add',
        });
        try {
            expect(window.MessengerAdapter.startParam()).toBe('weight_add');
        } finally { cleanup(); }
    });

    it('startParam() accepts a bare hash value like #bp_add', () => {
        const { window, cleanup } = loadWithoutTelegram({
            url: 'https://example.test/#food_log',
        });
        try {
            expect(window.MessengerAdapter.startParam()).toBe('food_log');
        } finally { cleanup(); }
    });

    it('startParam() prefers query over hash when both are present', () => {
        const { window, cleanup } = loadWithoutTelegram({
            url: 'https://example.test/?start=query_wins#start=hash_loses',
        });
        try {
            expect(window.MessengerAdapter.startParam()).toBe('query_wins');
        } finally { cleanup(); }
    });

    it('onBack() handler fires on popstate', () => {
        const { window, cleanup } = loadWithoutTelegram();
        try {
            const handler = vi.fn();
            window.MessengerAdapter.onBack(handler);
            window.dispatchEvent(new window.Event('popstate'));
            expect(handler).toHaveBeenCalledTimes(1);
        } finally { cleanup(); }
    });

    it('onBack() handler fires when the in-app back chevron is tapped', () => {
        const { window, cleanup } = loadWithoutTelegram();
        try {
            const handler = vi.fn();
            window.MessengerAdapter.onBack(handler);
            window.MessengerAdapter.showBack();
            const btn = window.document.getElementById('wg-browser-back-button');
            expect(btn).toBeTruthy();
            expect(btn.hidden).toBe(false);
            btn.click();
            expect(handler).toHaveBeenCalledTimes(1);
        } finally { cleanup(); }
    });

    it('hideBack() hides the in-app chevron after showBack()', () => {
        const { window, cleanup } = loadWithoutTelegram();
        try {
            window.MessengerAdapter.onBack(() => {});
            window.MessengerAdapter.showBack();
            const btn = window.document.getElementById('wg-browser-back-button');
            expect(btn.hidden).toBe(false);
            window.MessengerAdapter.hideBack();
            expect(btn.hidden).toBe(true);
        } finally { cleanup(); }
    });

    it('isBackButtonSupported() returns true (in-app chevron is always usable)', () => {
        const { window, cleanup } = loadWithoutTelegram();
        try {
            expect(window.MessengerAdapter.isBackButtonSupported()).toBe(true);
        } finally { cleanup(); }
    });

    it('auth-header helper omits the header when BrowserAdapter is active', () => {
        const { window, cleanup } = loadWithoutTelegram();
        try {
            window.userInitData = 'leftover-token';
            window.eval(`${CORE_API_SRC}\n//# sourceURL=file://core-api.js`);
            const headers = window.makeAuthHeaders({ 'Content-Type': 'application/json' });
            expect(headers).toEqual({ 'Content-Type': 'application/json' });
            expect('X-Telegram-Init-Data' in headers).toBe(false);
        } finally { cleanup(); }
    });
});
