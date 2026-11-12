// architecture.diag-redaction.test.js
//
// The shells' diagnostic log (passkey-diag.js diag.append, Diag.swift,
// Diag.kt) can travel with feedback (epic med-vjxz), so it must never carry
// health values, medicine or food names, or raw exception text that could hold
// them (bd med-vjxz.1). Every diag( / diagLine( / post( call line in the page
// and both shells logs words, counts, statuses and error class names only: no
// error message, no interpolated error object. No allowlist.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const TREES = [
    ['web/cloud/js', /\.js$/],
    ['android/app/src/main/java', /\.kt$/],
    ['ios/App', /\.swift$/],
];

const CALL = /\b(?:diag|diagLine|post)\(/;
const BANNED = [
    /\.message\b/, // JS / Kotlin error text
    /localizedDescription/, // Swift error text
    /\$\{\s*(?:msg|e|err|error|r)\s*\}/, // JS template / Kotlin ${e}
    /\$(?:msg|e|err|error)\b/, // Kotlin $e
    /\\\(\s*(?:msg|e|err|error)\s*\)/, // Swift \(error)
];

function lines() {
    const out = [];
    for (const [dir, ext] of TREES) {
        const base = path.join(ROOT, dir);
        for (const rel of fs.readdirSync(base, { recursive: true })) {
            if (!ext.test(rel) || rel.split(path.sep).some((p) => p === 'tests' || p === 'vendor')) continue;
            const file = path.join(dir, rel);
            fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').forEach((raw, i) => {
                // A trailing `// …` comment is prose, not what gets logged ("https://" has no space before //).
                const text = raw.replace(/(^|\s)\/\/.*$/, '').trim();
                if (CALL.test(text)) out.push({ at: `${file}:${i + 1}`, text });
            });
        }
    }
    return out;
}

describe('diagnostic log redaction', () => {
    const calls = lines();

    it('finds the log calls of all three runtimes', () => {
        for (const [dir] of TREES) expect(calls.some((c) => c.at.startsWith(dir))).toBe(true);
    });

    it('no diag/diagLine/post call line interpolates error text or an error object', () => {
        const leaks = calls.filter((c) => BANNED.some((re) => re.test(c.text))).map((c) => `${c.at}: ${c.text}`);
        expect(leaks).toEqual([]);
    });
});
