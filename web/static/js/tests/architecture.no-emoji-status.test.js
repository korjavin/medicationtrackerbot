/**
 * architecture.no-emoji-status.test.js (bd med-xso6.3)
 *
 * Kit v2 rule 4: status is shown only through the ok / warn / danger /
 * stale / pending chip states (components/wg-chip.js) and icons come from
 * WGIcons — never emoji. Fails on any of the emoji the app used to use for
 * status, row actions, activities and meal markers anywhere under
 * web/static/js (tests/ and vendor/ excluded), comments included. No allowlist.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ROOT = path.join(REPO_ROOT, 'web/static/js');

// ✅ ⏳ ❌ ⚠ 🗑 ✏ 🌍 🍽 🍱 🏔 🚴 🚶 🏃 🏅 (variation selectors don't matter).
const BANNED_RE = /[✅⏳❌⚠\u{1F5D1}✏\u{1F30D}\u{1F37D}\u{1F371}\u{1F3D4}\u{1F6B4}\u{1F6B6}\u{1F3C3}\u{1F3C5}]/u;

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

describe('Architecture – no emoji status/icons in web/static/js (med-xso6.3)', () => {
    it('detector matches the banned emoji and ignores chip text', () => {
        for (const s of ['✅ Taken', '⏳ Pending', '❌ Missed', '⚠️ Low stock', '🗑️', '✏️', '🌍', '🍽 Meal', '🍱', '🏔️', '🚴', '🚶', '🏃', '🏅']) {
            expect(BANNED_RE.test(s), s).toBe(true);
        }
        for (const s of ['Taken', 'Pending', 'Sync failed', 'Out · 3 over', '→']) {
            expect(BANNED_RE.test(s), s).toBe(false);
        }
    });

    it('no file under web/static/js contains a banned emoji', () => {
        const offenders = [];
        for (const file of collectJsFiles(ROOT)) {
            fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
                if (BANNED_RE.test(line)) offenders.push(`${path.relative(REPO_ROOT, file)}:${i + 1}: ${line.trim()}`);
            });
        }
        expect(offenders, offenders.join('\n')).toEqual([]);
    });
});
