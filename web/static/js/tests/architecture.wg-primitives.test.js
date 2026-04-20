/**
 * architecture.wg-primitives.test.js
 *
 * Asserts the Wandergeek material primitives (Task 2) are present in
 * styles.css and contain no hardcoded hex colors — every visual value
 * must resolve through a --wg-* token.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CSS_PATH = path.join(REPO_ROOT, 'web/static/css/styles.css');

const REQUIRED_CLASSES = [
    '.wg-stage',
    '.wg-card',
    '.wg-card--inset',
    '.wg-gloss',
    '.wg-gloss--sun',
    '.wg-gloss--clay',
    '.wg-gloss--inset',
    '.wg-icon-btn',
    '.wg-tag',
    '.wg-tag--normal',
    '.wg-tag--high',
    '.wg-tag--alert',
    '.wg-tag--mono',
    '.wg-section-label',
    '.wg-mono-display',
    '.wg-muted',
    '.wg-muted-strong',
];

function loadCss() {
    return fs.readFileSync(CSS_PATH, 'utf8');
}

/**
 * Extract the block body `{ ... }` for a CSS selector (simple rule match).
 * Returns the concatenation of every occurrence of `selector { ... }`.
 */
function extractClassBlocks(css, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[\\s,{}>+~])${escaped}\\s*\\{([^}]+)\\}`, 'g');
    const blocks = [];
    let m;
    while ((m = re.exec(css)) !== null) {
        blocks.push(m[2]);
    }
    return blocks;
}

describe('Wandergeek material primitives', () => {
    const css = loadCss();

    it.each(REQUIRED_CLASSES)('defines %s in styles.css', (cls) => {
        const blocks = extractClassBlocks(css, cls);
        expect(blocks.length, `expected at least one rule for ${cls}`).toBeGreaterThan(0);
    });

    it('puts .wg-* class blocks after the --wg-* token block', () => {
        const tokenStart = css.indexOf('--wg-paper:');
        const firstClass = css.search(/^\s*\.wg-stage\s*\{/m);
        expect(tokenStart).toBeGreaterThan(-1);
        expect(firstClass).toBeGreaterThan(tokenStart);
    });

    describe('no hardcoded hex in .wg-* class blocks', () => {
        // rgba/hsla/var() are fine — only hex literals are forbidden,
        // because those should come from --wg-* tokens.
        it.each(REQUIRED_CLASSES)('%s contains no hex literal', (cls) => {
            const blocks = extractClassBlocks(css, cls);
            for (const body of blocks) {
                const hex = body.match(/#[0-9a-fA-F]{3,8}\b/g);
                expect(hex, `hex literal found in ${cls}: ${hex}`).toBeNull();
            }
        });
    });

    it('gloss button references the gradient token, not a raw linear-gradient()', () => {
        const blocks = extractClassBlocks(css, '.wg-gloss');
        expect(blocks.length).toBeGreaterThan(0);
        // `.wg-gloss` (base) must use var(--wg-gloss-bg); modifiers may
        // reference sun/clay/inset variants via var().
        const base = blocks[0];
        expect(base).toMatch(/background:\s*var\(--wg-gloss-bg\)/);
        expect(base).toMatch(/box-shadow:\s*var\(--wg-gloss-shadow\)/);
    });

    it('status tag modifiers pull color + bg + border from tokens', () => {
        for (const variant of ['normal', 'high', 'alert']) {
            const blocks = extractClassBlocks(css, `.wg-tag--${variant}`);
            expect(blocks.length).toBeGreaterThan(0);
            const body = blocks[0];
            expect(body).toMatch(new RegExp(`background:\\s*var\\(--wg-tag-${variant}-bg\\)`));
            expect(body).toMatch(new RegExp(`color:\\s*var\\(--wg-tag-${variant}-fg\\)`));
            expect(body).toMatch(new RegExp(`border-color:\\s*var\\(--wg-tag-${variant}-border\\)`));
        }
    });

    it('section label uses the sun token for its accent dot', () => {
        const labelBlock = extractClassBlocks(css, '.wg-section-label::before');
        expect(labelBlock.length).toBeGreaterThan(0);
        expect(labelBlock[0]).toMatch(/background:\s*var\(--wg-sun\)/);
    });
});
