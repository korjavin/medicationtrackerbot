// architecture.no-telegram-in-html.test.js
//
// web/static/index.html is shared between bot mode and cloud mode. A static
// `https://telegram.org/js/telegram-web-app.js` <script> tag here would make
// every cloud-mode page load phone Telegram's CDN — an unconditional
// third-party request the zero-knowledge deployment must not make, and one
// its `default-src 'self'` CSP would block anyway. The dynamic-load shim in
// `core/messenger-adapter.js` owns the load and skips it in cloud mode.
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
                'must be loaded dynamically by core/messenger-adapter.js so cloud ' +
                'mode never reaches Telegram\'s CDN. Move any new Telegram script ' +
                'tags into messenger-adapter.js. Offending lines:\n' + offending.join('\n')
            );
        }
        expect(html).not.toContain('telegram.org');
    });
});
