// TelegramAdapter coverage — verifies that when window.Telegram.WebApp is
// present at script-eval time, window.MessengerAdapter forwards each method
// to the SDK, and that missing SDK methods fall through to native fallbacks
// (window.alert / window.confirm) without throwing.
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

function loadWithTelegram(webAppOverrides) {
    const dom = new JSDOM('<!DOCTYPE html>', { url: 'https://example.test/', runScripts: 'outside-only' });
    const { window } = dom;
    const calls = {
        ready: 0,
        expand: 0,
        showAlert: [],
        showConfirm: [],
        showPopup: [],
        backOnClick: [],
        backShow: 0,
        backHide: 0,
    };
    const webApp = Object.assign({
        initData: 'auth-blob-123',
        initDataUnsafe: { start_param: 'bp_add' },
        ready: () => { calls.ready++; },
        expand: () => { calls.expand++; },
        isVersionAtLeast: (v) => v === '6.1',
        showAlert: (msg) => { calls.showAlert.push(msg); },
        showConfirm: (msg, cb) => { calls.showConfirm.push(msg); cb(true); },
        showPopup: (opts) => { calls.showPopup.push(opts); },
        BackButton: {
            onClick: (fn) => { calls.backOnClick.push(fn); },
            show: () => { calls.backShow++; },
            hide: () => { calls.backHide++; },
        },
    }, webAppOverrides || {});
    window.Telegram = { WebApp: webApp };
    window.eval(`${ADAPTER_SRC}\n//# sourceURL=file://messenger-adapter.js`);
    return { window, calls, cleanup: () => dom.window.close() };
}

describe('MessengerAdapter — Telegram path', () => {
    it('selects TelegramAdapter when window.Telegram.WebApp is present', () => {
        const { window, cleanup } = loadWithTelegram();
        try {
            expect(window.MessengerAdapter).toBeTruthy();
            expect(window.MessengerAdapter.isPresent()).toBe(true);
            expect(window.MessengerAdapter.authHeaderName()).toBe('X-Telegram-Init-Data');
        } finally { cleanup(); }
    });

    it('init() calls ready() and expand() and resolves', async () => {
        const { window, calls, cleanup } = loadWithTelegram();
        try {
            await window.MessengerAdapter.init();
            expect(calls.ready).toBe(1);
            expect(calls.expand).toBe(1);
        } finally { cleanup(); }
    });

    it('identityToken() returns Telegram.WebApp.initData', () => {
        const { window, cleanup } = loadWithTelegram();
        try {
            expect(window.MessengerAdapter.identityToken()).toBe('auth-blob-123');
        } finally { cleanup(); }
    });

    it('identityToken() returns empty string when initData is missing', () => {
        const { window, cleanup } = loadWithTelegram({ initData: undefined });
        try {
            expect(window.MessengerAdapter.identityToken()).toBe('');
        } finally { cleanup(); }
    });

    it('startParam() returns Telegram.WebApp.initDataUnsafe.start_param', () => {
        const { window, cleanup } = loadWithTelegram();
        try {
            expect(window.MessengerAdapter.startParam()).toBe('bp_add');
        } finally { cleanup(); }
    });

    it('startParam() returns null when start_param is missing', () => {
        const { window, cleanup } = loadWithTelegram({ initDataUnsafe: {} });
        try {
            expect(window.MessengerAdapter.startParam()).toBe(null);
        } finally { cleanup(); }
    });

    it('alert() forwards to tg.showAlert', () => {
        const { window, calls, cleanup } = loadWithTelegram();
        try {
            window.MessengerAdapter.alert('hi');
            expect(calls.showAlert).toEqual(['hi']);
        } finally { cleanup(); }
    });

    it('alert() falls back to window.alert when showAlert is absent', () => {
        const fallback = vi.fn();
        const { window, cleanup } = loadWithTelegram({ showAlert: undefined });
        window.alert = fallback;
        try {
            window.MessengerAdapter.alert('hello');
            expect(fallback).toHaveBeenCalledWith('hello');
        } finally { cleanup(); }
    });

    it('alert() falls back to window.alert when showAlert throws', () => {
        const fallback = vi.fn();
        const { window, cleanup } = loadWithTelegram({
            showAlert: () => { throw new Error('boom'); }
        });
        window.alert = fallback;
        try {
            window.MessengerAdapter.alert('hello');
            expect(fallback).toHaveBeenCalledWith('hello');
        } finally { cleanup(); }
    });

    it('confirm() resolves to the boolean result from tg.showConfirm', async () => {
        const { window, calls, cleanup } = loadWithTelegram();
        try {
            const ok = await window.MessengerAdapter.confirm('sure?');
            expect(ok).toBe(true);
            expect(calls.showConfirm).toEqual(['sure?']);
        } finally { cleanup(); }
    });

    it('confirm() falls back to window.confirm when tg.showConfirm is absent', async () => {
        const fallback = vi.fn(() => true);
        const { window, cleanup } = loadWithTelegram({ showConfirm: undefined });
        window.confirm = fallback;
        try {
            const ok = await window.MessengerAdapter.confirm('sure?');
            expect(ok).toBe(true);
            expect(fallback).toHaveBeenCalledWith('sure?');
        } finally { cleanup(); }
    });

    it('showPopup() forwards to tg.showPopup', () => {
        const { window, calls, cleanup } = loadWithTelegram();
        try {
            window.MessengerAdapter.showPopup({ title: 't', message: 'm' });
            expect(calls.showPopup).toEqual([{ title: 't', message: 'm' }]);
        } finally { cleanup(); }
    });

    it('onBack() forwards to BackButton.onClick; showBack/hideBack toggle the button', () => {
        const { window, calls, cleanup } = loadWithTelegram();
        try {
            const handler = () => {};
            window.MessengerAdapter.onBack(handler);
            window.MessengerAdapter.showBack();
            window.MessengerAdapter.hideBack();
            expect(calls.backOnClick).toEqual([handler]);
            expect(calls.backShow).toBe(1);
            expect(calls.backHide).toBe(1);
        } finally { cleanup(); }
    });

    it('isBackButtonSupported() respects isVersionAtLeast("6.1")', () => {
        const { window, cleanup } = loadWithTelegram({ isVersionAtLeast: (v) => v !== '6.1' ? true : false });
        try {
            expect(window.MessengerAdapter.isBackButtonSupported()).toBe(false);
        } finally { cleanup(); }
    });

    it('isBackButtonSupported() is true when BackButton present and no version gate', () => {
        const { window, cleanup } = loadWithTelegram({ isVersionAtLeast: undefined });
        try {
            expect(window.MessengerAdapter.isBackButtonSupported()).toBe(true);
        } finally { cleanup(); }
    });
});
