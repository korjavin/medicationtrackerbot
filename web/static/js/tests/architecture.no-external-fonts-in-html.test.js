// architecture.no-external-fonts-in-html.test.js
//
// Lint guard for med-eas.6.
//
// web/static/index.html is served by the server, the cloud binary, and the
// mobile APK. Cloud mode wraps it in a strict `style-src 'self'` CSP
// (internal/cloudserver/router.go), which blocks any external stylesheet — and
// loading fonts from a CDN would phone that host on every page load, breaking
// cloud mode's zero-knowledge property. Space Grotesk + JetBrains Mono are
// therefore self-hosted (web/static/fonts + css/fonts.css). This test fails if
// a fonts.googleapis.com / fonts.gstatic.com reference reappears in the markup.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const INDEX_HTML = path.join(REPO_ROOT, 'web/static/index.html');

const BANNED = ['fonts.googleapis.com', 'fonts.gstatic.com'];

describe('Architecture — no external font CDN in index.html', () => {
    it('web/static/index.html does not reference an external font host', () => {
        const html = fs.readFileSync(INDEX_HTML, 'utf8');
        const lines = html.split('\n');
        const offending = [];
        lines.forEach((line, idx) => {
            if (BANNED.some((h) => line.includes(h))) {
                offending.push(`  • web/static/index.html:${idx + 1}: ${line.trim()}`);
            }
        });
        if (offending.length) {
            throw new Error(
                'web/static/index.html references an external font host, which the ' +
                "cloud origin's strict `style-src 'self'` CSP blocks and which would " +
                'break the zero-knowledge property. Self-host the fonts under ' +
                'web/static/fonts + css/fonts.css instead. Offending lines:\n' +
                offending.join('\n')
            );
        }
        for (const h of BANNED) expect(html).not.toContain(h);
    });
});
