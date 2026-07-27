// messenger-adapter.telegram-load.test.js
//
// Covers the dynamic-load shim in core/messenger-adapter.js. There is no
// static <script src="https://telegram.org/js/telegram-web-app.js"> tag in
// index.html, so cloud mode never pulls telegram.org; bot mode keeps Telegram
// Mini App support by injecting the SDK from the adapter at runtime.
//
// Three cases:
//   1. cloud mode: no script tag injected; BrowserAdapter selected.
//   2. browser, no Telegram in window: telegram-web-app.js script tag is
//      injected into document.head with the expected attributes.
//   3. browser, window.Telegram.WebApp already present: no duplicate
//      injection; TelegramAdapter selected synchronously.

import { describe, it, expect } from 'vitest';
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

function makeDom() {
    return new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
        url: 'https://example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
}

function evalAdapter(window) {
    window.eval(`${ADAPTER_SRC}\n//# sourceURL=file://messenger-adapter.js`);
}

function findTelegramScripts(window) {
    return Array.from(window.document.querySelectorAll(
        'script[data-medtracker-telegram-sdk]'
    ));
}

describe('MessengerAdapter — dynamic Telegram SDK load', () => {
    it('injects telegram-web-app.js into document.head when running in a plain browser without Telegram', () => {
        const dom = makeDom();
        const { window } = dom;
        try {
            expect(window.Telegram).toBeUndefined();
            evalAdapter(window);
            const scripts = findTelegramScripts(window);
            expect(scripts).toHaveLength(1);
            expect(scripts[0].src).toBe('https://telegram.org/js/telegram-web-app.js');
            expect(scripts[0].async).toBe(true);
            expect(scripts[0].parentNode).toBe(window.document.head);
        } finally { dom.window.close(); }
    });

    it('does not inject a duplicate script when Telegram is already loaded', () => {
        const dom = makeDom();
        const { window } = dom;
        try {
            window.Telegram = { WebApp: { initData: 'x', ready: () => {}, expand: () => {} } };
            evalAdapter(window);
            expect(findTelegramScripts(window)).toHaveLength(0);
            expect(window.MessengerAdapter.isPresent()).toBe(true);
            expect(window.MessengerAdapter.authHeaderName()).toBe('X-Telegram-Init-Data');
        } finally { dom.window.close(); }
    });

    it('skips injection in cloud mode (window.__MEDTRACKER_CLOUD__)', () => {
        const dom = makeDom();
        const { window } = dom;
        try {
            window.__MEDTRACKER_CLOUD__ = {};
            evalAdapter(window);
            expect(findTelegramScripts(window)).toHaveLength(0);
            expect(window.MessengerAdapter.isPresent()).toBe(false);
        } finally { dom.window.close(); }
    });

    it('upgrades BrowserAdapter → TelegramAdapter and refreshes window.userInitData after the dynamic SDK load resolves', async () => {
        const dom = makeDom();
        const { window } = dom;
        try {
            expect(window.Telegram).toBeUndefined();
            evalAdapter(window);

            // Initial sync pick — no Telegram yet, so BrowserAdapter.
            expect(window.MessengerAdapter.isPresent()).toBe(false);
            const scripts = findTelegramScripts(window);
            expect(scripts).toHaveLength(1);

            // Simulate the Telegram SDK loading: it would set window.Telegram.WebApp
            // and then fire the script's load event. The adapter's .then() block
            // then re-picks and refreshes window.userInitData.
            window.Telegram = { WebApp: { initData: 'tg-token-xyz', ready: () => {}, expand: () => {} } };
            scripts[0].dispatchEvent(new window.Event('load'));

            await window.MessengerAdapterReady;

            expect(window.MessengerAdapter.isPresent()).toBe(true);
            expect(window.MessengerAdapter.authHeaderName()).toBe('X-Telegram-Init-Data');
            expect(window.userInitData).toBe('tg-token-xyz');
        } finally { dom.window.close(); }
    });
});
