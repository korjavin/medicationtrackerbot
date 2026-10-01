/**
 * architecture.no-native-dialogs.test.js (bd med-v83g)
 *
 * Lint guard: no native browser dialogs anywhere in the app. window.alert /
 * window.confirm / window.prompt render the browser's unstyled box; every
 * dialog is the app's own in-page one from core/utils.js — safeAlert,
 * safeConfirm, safePrompt, safeChoose (or safeToast for a non-blocking note).
 * The passkey shell (signup.html) loads utils.js too, so web/cloud/js has no
 * excuse either.
 *
 * Scans web/static/js and web/cloud/js (tests/, vendor/ and *.min.js
 * excluded) for a bare, window.-, globalThis.- or self.-prefixed
 * alert( / confirm( / prompt( on non-comment code. Member calls on other
 * objects (intake.confirm(), event.prompt()) are not native dialogs and do
 * not match. No allowlist.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ROOTS = ['web/static/js', 'web/cloud/js'];

const NATIVE_DIALOG_RE = /(^|[^A-Za-z0-9_$.])(?:(?:window|globalThis|self)\s*\.\s*)?(alert|confirm|prompt)\s*\(/;

function collectJsFiles(dir, results = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!['tests', 'vendor', 'node_modules'].includes(entry.name)) collectJsFiles(full, results);
        } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.min.js')) {
            results.push(full);
        }
    }
    return results;
}

// Code part of a line: comment-only lines (// , /* , * ) are prose, and a
// trailing `// ...` is dropped (only when preceded by whitespace, so the `//`
// inside 'https://…' strings survives).
function codeOf(line) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return '';
    return line.replace(/(^|\s)\/\/.*$/, '');
}

const isNativeDialogCall = (line) => NATIVE_DIALOG_RE.test(codeOf(line));

describe('Architecture – no native browser dialogs (med-v83g)', () => {
    it('detector flags native dialog calls and ignores prose and member calls', () => {
        for (const line of [
            '    alert(msg);',
            "        alert('Failed to switch day. Please try again.');",
            "        const valStr = prompt(`Enter target weight (in ${pref}):`, currentDisplay);",
            "  if (!window.confirm('Download anyway?')) {",
            '    if (!confirm(REMOTE_CONSENT_TEXT)) return;',
            '    const confirmed = confirm(',
            '                try { window.alert(msg); } catch (e) { /* ignore */ }',
            '  const ok = !!window.confirm (msg);',
        ]) {
            expect(isNativeDialogCall(line), line).toBe(true);
        }
        for (const line of [
            "// A re-drained event finds its intakes already TAKEN, and the domain's confirm()",
            '  // confirm() backdates taken_at to atMs deterministically, so this instant is',
            ' * Replaces the old browser alert() with a richer view',
            '        await intake.confirm(i.recordId, atMs);',
            '    event.prompt();',
            "    const ok = await window.safeConfirm('Sure?');",
            '    safeAlert(msg);',
            "    fetch('https://x.test/a'); // never alert() here",
        ]) {
            expect(isNativeDialogCall(line), line).toBe(false);
        }
    });

    it('no frontend file calls alert( / confirm( / prompt(', () => {
        const violations = [];
        for (const root of ROOTS) {
            for (const file of collectJsFiles(path.join(REPO_ROOT, root))) {
                const rel = path.relative(REPO_ROOT, file);
                fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
                    if (isNativeDialogCall(line)) violations.push(`${rel}:${i + 1}: ${line.trim()}`);
                });
            }
        }
        if (violations.length > 0) {
            throw new Error(
                'Native browser dialogs are banned (CLAUDE.md rule 13). Use the in-page ' +
                'safeAlert / safeConfirm / safePrompt / safeChoose from core/utils.js ' +
                '(or safeToast for a non-blocking note):\n\n' +
                violations.map((v) => `  • ${v}`).join('\n')
            );
        }
    });
});
