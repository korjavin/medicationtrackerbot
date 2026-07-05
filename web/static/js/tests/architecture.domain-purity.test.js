// architecture.domain-purity.test.js
//
// web/domain/ is the runtime-agnostic BP/weight domain layer (cloud-mode C1
// plan). It must stay free of browser globals — window, document, fetch,
// IndexedDB, navigator — because C6 later runs this same source inside the
// Go server via goja, which has none of those. All I/O must go through the
// injected ports (records, now, timeZone) instead.
//
// This test scans every file under web/domain/ and fails if a forbidden
// global reappears.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const DOMAIN_DIR = path.join(REPO_ROOT, 'web/domain');

const FORBIDDEN_PATTERNS = [
    /\bwindow\./,
    /\bdocument\./,
    /\bfetch\(/,
    /\bindexedDB\b/,
    /\bnavigator\./,
];

function listJsFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return listJsFiles(full);
        return entry.name.endsWith('.js') ? [full] : [];
    });
}

describe('Architecture — web/domain/ purity (no browser globals)', () => {
    const files = listJsFiles(DOMAIN_DIR);

    it('found domain files to check', () => {
        expect(files.length).toBeGreaterThan(0);
    });

    files.forEach((file) => {
        it(`${path.relative(REPO_ROOT, file)} has no browser globals`, () => {
            const src = fs.readFileSync(file, 'utf8');
            const offenders = [];
            src.split('\n').forEach((line, idx) => {
                if (line.trim().startsWith('//')) return; // prose in comments may mention "window" etc.
                FORBIDDEN_PATTERNS.forEach((pattern) => {
                    if (pattern.test(line)) {
                        offenders.push(`  • line ${idx + 1}: ${line.trim()}`);
                    }
                });
            });
            if (offenders.length > 0) {
                throw new Error(
                    `${path.relative(REPO_ROOT, file)} references a browser global. ` +
                    'web/domain/ must stay runtime-agnostic (C6 runs it inside Go via goja) ' +
                    '— route I/O through the injected ports instead. Offending lines:\n' +
                    offenders.join('\n')
                );
            }
            expect(offenders).toHaveLength(0);
        });
    });
});
