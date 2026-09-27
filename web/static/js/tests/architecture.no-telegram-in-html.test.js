// architecture.no-telegram-in-html.test.js
//
// Lint guard for the zero-knowledge "no third-party request" promise: the
// Telegram client is gone, so the served document and the browser sources
// must never reference the Telegram CDN host again (a script tag there
// would phone home on every page load). Fails on any occurrence of the
// host in web/static/index.html or in web/static/js/** (excluding tests/).
//
// The needle is assembled from parts so this guard file itself stays free
// of the banned literal.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const INDEX_HTML = path.join(REPO_ROOT, 'web/static/index.html');
const JS_ROOT = path.join(REPO_ROOT, 'web/static/js');

// Assembled from parts so this file contains no banned literal itself.
const BANNED_HOST = ['telegram', 'org'].join('.');

function collectJsFiles(dir, results = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'tests' && entry.name !== 'node_modules') {
                collectJsFiles(full, results);
            }
        } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.min.js')) {
            results.push(full);
        }
    }
    return results;
}

function findHits(label, source) {
    const lines = source.split('\n');
    const hits = [];
    lines.forEach((line, i) => {
        if (line.includes(BANNED_HOST)) {
            hits.push(`${label}:${i + 1}: ${line.trim()}`);
        }
    });
    return hits;
}

describe('Architecture — no Telegram CDN references in the served app', () => {
    it('web/static/index.html contains no Telegram CDN references', () => {
        const html = fs.readFileSync(INDEX_HTML, 'utf8');
        const hits = findHits('web/static/index.html', html);
        if (hits.length > 0) {
            throw new Error(
                `Banned Telegram CDN host found in the served document:\n\n` +
                hits.map(h => `  • ${h}`).join('\n')
            );
        }
    });

    it('web/static/js/** (excluding tests) contains no Telegram CDN references', () => {
        const jsFiles = collectJsFiles(JS_ROOT);
        expect(jsFiles.length).toBeGreaterThan(0);
        const hits = [];
        for (const filePath of jsFiles) {
            const rel = path.relative(REPO_ROOT, filePath);
            hits.push(...findHits(rel, fs.readFileSync(filePath, 'utf8')));
        }
        if (hits.length > 0) {
            throw new Error(
                `Banned Telegram CDN host found in browser sources:\n\n` +
                hits.map(h => `  • ${h}`).join('\n')
            );
        }
    });
});
