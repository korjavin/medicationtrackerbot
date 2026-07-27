/**
 * architecture.native-abstractions.test.js
 *
 * Lint guard for CLAUDE.md rule 10: device-capability access routes through
 * `web/static/js/native/`.
 *
 * Two distinct invariants, deliberately not conflated:
 *
 *  1. Device-capability globals (`navigator.mediaDevices`, `getUserMedia`,
 *     `BarcodeDetector`) may only appear inside `native/`. No allowlist —
 *     `native/` owns the platform impls, feature code asks the abstraction.
 *
 *  2. No frontend file reads `window.Capacitor` / `isNativePlatform`. The
 *     Capacitor shell was removed; a reappearing reference means someone is
 *     branching on a runtime that no longer ships.
 *
 * Tests are excluded: they legitimately stub both seams.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const JS_ROOT = path.join(REPO_ROOT, 'web/static/js');
const NATIVE_DIR = 'web/static/js/native';

/** Device-capability globals `native/` owns. */
const CAPABILITY_RE = /navigator\.mediaDevices|getUserMedia|BarcodeDetector/;

/** The removed Capacitor shell. */
const CAPACITOR_RE = /isNativePlatform|window\.Capacitor/;

/** Recursively collect *.js files, skipping tests/ and *.min.js. */
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

const allFiles = () => collectJsFiles(JS_ROOT).map(f => path.relative(REPO_ROOT, f));

/** Non-test JS outside native/, as repo-relative paths. */
function nonNativeFiles() {
    return allFiles().filter(rel => !rel.startsWith(NATIVE_DIR + path.sep));
}

const read = rel => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

describe('Architecture – native platform abstractions guard', () => {
    it('no file outside native/ touches a device-capability global', () => {
        const violations = nonNativeFiles().filter(rel => CAPABILITY_RE.test(read(rel)));

        if (violations.length > 0) {
            throw new Error(
                'Device-capability globals (navigator.mediaDevices / getUserMedia / BarcodeDetector) ' +
                'may only be used inside web/static/js/native/.\n' +
                'Call window.MediaCapture / window.Barcode instead (CLAUDE.md rule 10):\n\n' +
                violations.map(v => `  • ${v}`).join('\n')
            );
        }
    });

    it('no frontend file references the removed Capacitor shell', () => {
        const violations = allFiles().filter(rel => CAPACITOR_RE.test(read(rel)));

        if (violations.length > 0) {
            throw new Error(
                'The Capacitor / Android shell was removed — window.Capacitor and isNativePlatform ' +
                'no longer exist at runtime, so branching on them is dead code:\n\n' +
                violations.map(v => `  • ${v}`).join('\n')
            );
        }
    });

    it('every capability the foundation stubs has a registered web impl', () => {
        const foundation = read(path.join(NATIVE_DIR, 'index.js'));
        for (const capability of ['MediaCapture', 'Barcode']) {
            expect(foundation).toContain(`window.${capability} = makeStub('${capability}'`);
            const impls = collectJsFiles(path.join(REPO_ROOT, NATIVE_DIR, 'web'))
                .map(f => fs.readFileSync(f, 'utf8'))
                .filter(src => src.includes(`registerImpl('${capability}', 'web'`));
            expect(impls.length, `${capability} has no web impl`).toBe(1);
        }
    });
});
