/**
 * architecture.no-legacy-buttons.test.js (bd med-xso6.11)
 *
 * The UI kit v2 has one button system: `.wg-btn` plus its variants
 * (components.css; spec docs/design/claude-design/ui_kits/app-v2/components.html).
 * This guard drives the parallel legacy systems to zero:
 *
 *   - Bootstrap `btn btn-*`
 *   - `wg-firstrun-btn` (retired by med-xso6.11)
 *   - `wg-toolbar-btn`
 *   - `*-modal__header-btn`
 *   - `pwa-update-btn`
 *   - `wg-settings-action-btn` / `wg-settings-save-btn`
 *   - an unstyled `<button>` in the cloud shell (the old `.wizard-step button`
 *     rule is gone, so a shell button without `.wg-btn` renders as a bare UA
 *     button)
 *
 * Scans web/static/index.html, web/static/js, web/cloud/*.html and
 * web/cloud/js (tests/ and vendor/ excluded) and counts every occurrence,
 * comments included.
 *
 * ALLOWLIST is today's debt, per file and pattern, each with the bead that
 * removes it. It only shrinks:
 *   - a file/pattern that is not listed, or whose count grows past `max`,
 *     fails — use `.wg-btn` instead;
 *   - a listed entry whose count reached zero fails too — delete the entry
 *     (and lower `max` when you remove some but not all).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

const PATTERNS = {
    'bootstrap btn': /(^|[\s"'`])btn btn-[a-z]/g,
    'wg-firstrun-btn': /\bwg-firstrun-btn\b/g,
    'wg-toolbar-btn': /\bwg-toolbar-btn\b/g,
    'modal__header-btn': /[\w-]+-modal__header-btn\b/g,
    'pwa-update-btn': /\bpwa-update-btn\b/g,
    'wg-settings-action-btn': /\bwg-settings-action-btn\b/g,
    'wg-settings-save-btn': /\bwg-settings-save-btn\b/g,
};
// Shell-only: a <button …> literal with no wg-btn class.
const SHELL_BARE_BUTTON = /<button\b(?![^>]*\bwg-btn\b)[^>]*>/g;

const ALLOWLIST = {
    'web/static/index.html': {
        'bootstrap btn': { max: 4, owner: 'med-xso6.17 (Food F4–F8: scanner + product modals)' },
        'wg-toolbar-btn': { max: 15, owner: 'med-xso6.16 (Food add/photo/scan), med-xso6.18 (Meds Add), med-xso6.22 (plan share row)' },
        'modal__header-btn': { max: 51, owner: 'med-xso6.7 (sheet header)' },
        'wg-settings-action-btn': { max: 13, owner: 'med-xso6.23 / med-xso6.24 / med-xso6.25 (Settings v2)' },
        'wg-settings-save-btn': { max: 7, owner: 'med-xso6.23 / med-xso6.24 (Settings v2)' },
    },
    'web/static/js/features/bp.js': {
        'wg-toolbar-btn': { max: 4, owner: 'med-xso6.27 (Health v2 polish)' },
    },
    'web/static/js/features/weight.js': {
        'wg-toolbar-btn': { max: 2, owner: 'med-xso6.27 (Health v2 polish)' },
    },
    'web/static/js/features/food-photo-summary.js': {
        'wg-toolbar-btn': { max: 4, owner: 'med-xso6.5 (toast replaces the food AI summary card)' },
    },
    'web/static/js/features/journey.js': {
        'bootstrap btn': { max: 8, owner: 'med-xso6.15 (Journey v2)' },
    },
    'web/static/js/features/today.js': {
        'bootstrap btn': { max: 3, owner: 'med-xso6.13 (Today v2 Goal Line)' },
    },
    'web/static/js/features/meds-history.js': {
        'wg-toolbar-btn': { max: 2, owner: 'med-xso6.18 (Meds v2)' },
    },
    'web/static/js/features/tz-plan-banner.js': {
        'wg-toolbar-btn': { max: 3, owner: 'med-xso6.14 (tz plan card restyle)' },
    },
    'web/static/js/features/workout/next-card.js': {
        'wg-toolbar-btn': { max: 4, owner: 'med-xso6.21 (Workout v2)' },
    },
    'web/cloud/js/update-check.js': {
        'pwa-update-btn': { max: 3, owner: 'med-xso6.5 (wg-toast / wg-banner update prompt)' },
    },
};

function collectJs(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (!['tests', 'vendor', 'node_modules'].includes(e.name)) collectJs(full, out);
        } else if (e.name.endsWith('.js') && !e.name.endsWith('.min.js')) {
            out.push(full);
        }
    }
    return out;
}

const cloudDir = path.join(REPO_ROOT, 'web/cloud');
const shellFiles = [
    ...fs.readdirSync(cloudDir).filter((f) => f.endsWith('.html')).map((f) => path.join(cloudDir, f)),
    ...collectJs(path.join(cloudDir, 'js')),
];
const files = [
    path.join(REPO_ROOT, 'web/static/index.html'),
    ...collectJs(path.join(REPO_ROOT, 'web/static/js')),
    ...shellFiles,
];

// { 'file': { pattern: count } } for every non-zero count.
const found = {};
for (const file of files) {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const src = fs.readFileSync(file, 'utf8');
    const patterns = shellFiles.includes(file) ? { ...PATTERNS, 'shell <button> without .wg-btn': SHELL_BARE_BUTTON } : PATTERNS;
    for (const [name, re] of Object.entries(patterns)) {
        const n = (src.match(re) || []).length;
        if (n) (found[rel] ||= {})[name] = n;
    }
}

describe('architecture: no legacy button systems (use .wg-btn)', () => {
    it('scans the files it claims to', () => {
        expect(files.length).toBeGreaterThan(50);
        expect(shellFiles.some((f) => f.endsWith('signup.html'))).toBe(true);
    });

    it('adds no legacy button outside the allowlist, and grows no allowlisted count', () => {
        const offenders = [];
        for (const [file, counts] of Object.entries(found)) {
            for (const [name, n] of Object.entries(counts)) {
                const entry = ALLOWLIST[file] && ALLOWLIST[file][name];
                if (!entry) offenders.push(`${file}: ${n}× ${name} — use .wg-btn`);
                else if (n > entry.max) offenders.push(`${file}: ${n}× ${name}, allowlist max ${entry.max} — use .wg-btn`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('keeps no stale allowlist entry (delete an entry once its file is clean)', () => {
        const stale = [];
        for (const [file, entries] of Object.entries(ALLOWLIST)) {
            for (const name of Object.keys(entries)) {
                if (!(found[file] && found[file][name])) stale.push(`${file}: ${name} (${entries[name].owner})`);
            }
        }
        expect(stale).toEqual([]);
    });

    it('every allowlist entry names the bead that removes it', () => {
        for (const entries of Object.values(ALLOWLIST)) {
            for (const { owner } of Object.values(entries)) expect(owner).toMatch(/med-[a-z0-9.]+/);
        }
    });

    it('the retired shell and first-run button rules stay deleted', () => {
        const cloudCss = fs.readFileSync(path.join(REPO_ROOT, 'web/cloud/css/cloud.css'), 'utf8');
        const firstrunCss = fs.readFileSync(path.join(REPO_ROOT, 'web/static/css/firstrun.css'), 'utf8');
        expect(cloudCss).not.toMatch(/\.wizard-step\s+(a\.)?button\b/);
        expect(cloudCss).not.toMatch(/\.wg-gloss\b/);
        expect(firstrunCss).not.toMatch(/\.wg-firstrun-btn\b/);
    });
});
