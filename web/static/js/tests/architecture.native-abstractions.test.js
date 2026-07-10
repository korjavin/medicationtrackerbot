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
 *  2. `Capacitor.isNativePlatform` is allowlisted to the files that use it as a
 *     *shell-presence UI gate* (show/hide a screen or a row). Using it to route
 *     a device capability is the bug this guard exists to prevent.
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

/**
 * Files permitted to read `Capacitor.isNativePlatform`, each because it gates
 * UI on shell presence — not because it routes a device capability.
 *
 * `features/food/scanner.js` is deliberately absent: it asks
 * `window.Barcode.hasNativeScanner()` instead (med-9lq).
 */
const IS_NATIVE_PLATFORM_ALLOWLIST = new Map([
    ['web/static/js/core/native-bootstrap.js',
        'bootstrap — probes the shell to pick web vs capacitor impls; this is the abstraction'],
    ['web/static/js/core/messenger-adapter.js',
        'decides whether to load the Telegram SDK at all (CLAUDE.md rule 11)'],
    ['web/static/js/features/firstrun/permissions.js',
        'shell-presence UI gate — shows the native-only permission screen'],
    ['web/static/js/features/firstrun/screens/permissions.js',
        'shell-presence UI gate — same screen, render side'],
    ['web/static/js/features/settings/integrations.js',
        'shell-presence UI gate — shows a native-only settings row'],
]);

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

/** Non-test JS outside native/, as repo-relative paths. */
function nonNativeFiles() {
    return collectJsFiles(JS_ROOT)
        .map(f => path.relative(REPO_ROOT, f))
        .filter(rel => !rel.startsWith(NATIVE_DIR + path.sep));
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

    it('no file outside native/ reads Capacitor.isNativePlatform unless allowlisted', () => {
        const violations = nonNativeFiles()
            .filter(rel => !IS_NATIVE_PLATFORM_ALLOWLIST.has(rel))
            .filter(rel => read(rel).includes('isNativePlatform'));

        if (violations.length > 0) {
            throw new Error(
                'Capacitor.isNativePlatform is a shell-presence check, not a device-capability router.\n' +
                'If this file routes a capability, ask the abstraction instead. If it gates UI, add it to ' +
                'IS_NATIVE_PLATFORM_ALLOWLIST in architecture.native-abstractions.test.js with a justification:\n\n' +
                violations.map(v => `  • ${v}`).join('\n')
            );
        }
    });

    it('the isNativePlatform allowlist has no stale entries', () => {
        for (const [rel, reason] of IS_NATIVE_PLATFORM_ALLOWLIST) {
            expect(reason.length, `${rel} needs a justification`).toBeGreaterThan(10);
            expect(fs.existsSync(path.join(REPO_ROOT, rel)), `${rel} no longer exists`).toBe(true);
            expect(read(rel).includes('isNativePlatform'), `${rel} no longer uses isNativePlatform — drop it`).toBe(true);
        }
    });

    it('the food scanner is not on the allowlist', () => {
        expect(IS_NATIVE_PLATFORM_ALLOWLIST.has('web/static/js/features/food/scanner.js')).toBe(false);
    });
});
