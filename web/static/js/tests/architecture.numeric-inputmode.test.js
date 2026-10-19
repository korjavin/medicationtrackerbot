/**
 * architecture.numeric-inputmode.test.js (bd med-7b3f)
 *
 * iOS shows the full symbols keyboard for a bare <input type="number">.
 * Every numeric input must carry inputmode="decimal" (fractional values) or
 * "numeric" (integers) so the number pad opens. type=number's .value is
 * always '.'-normalised, so locale ',' needs no parse handling.
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
    it('every <input type="number"> in index.html has inputmode', () => {
        const tags = read('web/static/index.html').match(/<input\b[^>]*type="number"[^>]*>/g) || [];
        expect(tags.length).toBeGreaterThan(0);
        const bad = tags.filter((t) => !/inputmode="(decimal|numeric)"/.test(t));
        expect(bad).toEqual([]);
    });

    it('JS-built / templated type=number inputs set inputmode', () => {
        const bad = [];
        for (const f of [...jsFiles('web/static/js'), ...jsFiles('web/cloud/js')]) {
            const src = read(f);
            const typed = (src.match(/\.type\s*=\s*'number'|<input[^>]*type="number"/g) || []).length;
            const moded = (src.match(/\.inputMode\s*=\s*'(decimal|numeric)'|inputmode="(decimal|numeric)"/g) || []).length;
            if (moded < typed) bad.push(f);
        }
        expect(bad).toEqual([]);
    });
});
