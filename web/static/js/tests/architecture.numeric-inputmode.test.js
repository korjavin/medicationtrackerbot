/**
 * architecture.numeric-inputmode.test.js (bd med-7b3f, med-mysj)
 *
 * iOS shows the full symbols keyboard for a bare <input type="number">, so
 * integer inputs carry inputmode="numeric". Fractional inputs can't be
 * type=number at all: a comma-locale iOS decimal pad types ',', which WebKit's
 * number input silently drops. They are type="text" inputmode="decimal" and
 * every read goes through parseDecimal (core/utils.js), which takes ',' or '.'.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function jsFiles(dir, out = []) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) { if (!['tests', 'vendor', 'node_modules'].includes(e.name)) jsFiles(rel, out); }
        else if (e.name.endsWith('.js')) out.push(rel);
    }
    return out;
}

describe('numeric inputs carry inputmode', () => {
    const html = read('web/static/index.html');

    it('every <input type="number"> in index.html is inputmode="numeric"', () => {
        const tags = html.match(/<input\b[^>]*type="number"[^>]*>/g) || [];
        expect(tags.length).toBeGreaterThan(0);
        expect(tags.filter((t) => !/inputmode="numeric"/.test(t))).toEqual([]);
    });

    it('every inputmode="decimal" input in index.html is type="text"', () => {
        const tags = html.match(/<input\b[^>]*inputmode="decimal"[^>]*>/g) || [];
        expect(tags.length).toBeGreaterThan(0);
        expect(tags.filter((t) => !/type="text"/.test(t))).toEqual([]);
    });

    it('JS-built / templated inputs: type=number is numeric-only, decimal is never type=number', () => {
        const bad = [];
        for (const f of [...jsFiles('web/static/js'), ...jsFiles('web/cloud/js')]) {
            const src = read(f);
            const typed = (src.match(/\.type\s*=\s*'number'|<input[^>]*type="number"/g) || []).length;
            const moded = (src.match(/\.inputMode\s*=\s*'numeric'|inputmode="numeric"/g) || []).length;
            if (moded < typed) bad.push(`${f}: type=number without inputmode=numeric`);
            // A decimal input set in the same element block as type='number'.
            if (/\.type\s*=\s*'number';\s*\n\s*\w+\.inputMode\s*=\s*'decimal'|<input[^>]*type="number"[^>]*inputmode="decimal"|<input[^>]*inputmode="decimal"[^>]*type="number"/.test(src)) {
                bad.push(`${f}: inputmode=decimal on a type=number input`);
            }
        }
        expect(bad).toEqual([]);
    });
});
