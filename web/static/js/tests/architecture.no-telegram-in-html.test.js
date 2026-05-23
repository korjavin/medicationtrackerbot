// architecture.no-telegram-in-html.test.js
//
// Lint guard for the APK-strip-Telegram plan (2026-05-23).
//
// web/static/index.html is shared between the server build and the Capacitor
// Android shell (the same bundle ships as `assets/public/index.html`). Loading
// `https://telegram.org/js/telegram-web-app.js` from a <script> tag here would
// pull telegram.org from inside the mobile APK — exactly what we removed it to
// avoid. The dynamic-load shim lives in `core/messenger-adapter.js` and is
// gated on `!window.Capacitor?.isNativePlatform?.()`, so the mobile path never
// touches Telegram's CDN.
//
// This test scans the served index.html and fails if `telegram.org` reappears
// anywhere in the markup.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const INDEX_HTML = path.join(REPO_ROOT, 'web/static/index.html');

describe('Architecture — no telegram.org references in index.html', () => {
    it('web/static/index.html contains no telegram.org references', () => {
        const html = fs.readFileSync(INDEX_HTML, 'utf8');
        if (html.includes('telegram.org')) {
            const lines = html.split('\n');
            const offending = [];
            lines.forEach(function (line, idx) {
                if (line.includes('telegram.org')) {
                    offending.push(`  • web/static/index.html:${idx + 1}: ${line.trim()}`);
                }
            });
            throw new Error(
                'web/static/index.html references telegram.org. The Telegram SDK ' +
                'must be loaded dynamically by core/messenger-adapter.js (only when ' +
                'running outside Capacitor) so the mobile APK never pulls telegram.org. ' +
                'Move any new Telegram script tags into messenger-adapter.js. Offending ' +
                'lines:\n' + offending.join('\n')
            );
        }
        expect(html).not.toContain('telegram.org');
    });
});
