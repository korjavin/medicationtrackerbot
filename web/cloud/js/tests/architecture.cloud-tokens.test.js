/**
 * architecture.cloud-tokens.test.js (med-t05.2)
 *
 * The cloud shell (/unlock, /claim, /recover, /devices, /connectors and the
 * base-domain landing page) cannot load web/static/css/styles.css — it carries
 * global element selectors that would restyle the whole wizard, and it lives
 * under /static/, which does not exist on the base domain. So cloud.css
 * re-declares the handful of --wg-* tokens it needs.
 *
 * Duplicated values rot. These tests pin the two halves together:
 *   1. every token cloud.css declares matches styles.css's :root exactly;
 *   2. no rule in cloud.css hardcodes a color instead of using a token
 *      (CLAUDE.md rule 3), the QR quiet zone excepted.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APP_CSS = path.join(REPO_ROOT, 'web/static/css/styles.css');
const CLOUD_CSS = path.join(REPO_ROOT, 'web/cloud/css/cloud.css');

// The :root blocks hold gradients full of parens but no braces, so a
// non-greedy match to the first '}' is a correct extraction here.
function rootBlock(css) {
    const m = css.match(/:root\s*\{([^}]+)\}/);
    if (!m) throw new Error('no :root block');
    return m[1];
}

function tokens(block) {
    const out = new Map();
    for (const line of block.split('\n')) {
        const m = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*(.+?);\s*$/i);
        if (m) out.set(m[1], m[2].trim());
    }
    return out;
}

const appTokens = tokens(rootBlock(fs.readFileSync(APP_CSS, 'utf8')));
const cloudCss = fs.readFileSync(CLOUD_CSS, 'utf8');
const cloudTokens = tokens(rootBlock(cloudCss));

describe('cloud.css design-token parity with styles.css', () => {
    it('declares at least the tokens its rules use', () => {
        expect(cloudTokens.size).toBeGreaterThan(0);
    });

    it('every --wg-* token cloud.css re-declares has styles.css\'s exact value', () => {
        const drift = [];
        for (const [name, value] of cloudTokens) {
            if (!name.startsWith('--wg-')) continue;
            if (!appTokens.has(name)) {
                drift.push(`${name}: not defined in styles.css :root`);
                continue;
            }
            if (appTokens.get(name) !== value) {
                drift.push(`${name}: cloud="${value}" app="${appTokens.get(name)}"`);
            }
        }
        expect(drift).toEqual([]);
    });

    it('declares no token that no rule in the file references', () => {
        const body = cloudCss.slice(cloudCss.indexOf('}', cloudCss.indexOf(':root')) + 1);
        const unused = [...cloudTokens.keys()].filter((name) => {
            // A token may be referenced by another token's value (e.g. --wg-fg-1
            // resolves --wg-paper), which counts as used.
            const inRules = body.includes(`var(${name})`);
            const inTokens = [...cloudTokens.entries()].some(([n, v]) => n !== name && v.includes(`var(${name})`));
            return !inRules && !inTokens;
        });
        expect(unused).toEqual([]);
    });

    it('hardcodes no color outside the :root block (CLAUDE.md rule 3)', () => {
        const body = cloudCss.slice(cloudCss.indexOf('}', cloudCss.indexOf(':root')) + 1);
        const offenders = [];
        for (const line of body.split('\n')) {
            const code = line.split('/*')[0];
            if (/#[0-9a-f]{3,8}\b/i.test(code) || /\brgba?\(/i.test(code)) {
                // The QR code's quiet zone must be pure white for scanners.
                if (/background:\s*#fff\b/.test(code)) continue;
                offenders.push(line.trim());
            }
        }
        expect(offenders).toEqual([]);
    });
});
