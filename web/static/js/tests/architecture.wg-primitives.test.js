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
    '.wg-screen-stage',
    '.wg-card',
    '.wg-card--inset',
    '.wg-gloss',
    '.wg-gloss--sun',
    '.wg-gloss--clay',
    '.wg-gloss--inset',
    '.wg-gloss--lg',
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
    '.wg-modal',
    '.wg-modal__title',
    '.wg-modal__body',
    '.wg-modal__actions',
    '.wg-field',
    '.wg-label',
    '.wg-input',
    '.wg-select',
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

    it('streak bars declare an explicit height so they render as visible vertical bars', () => {
        const blocks = extractClassBlocks(css, '.wg-streak-bar');
        expect(blocks.length).toBeGreaterThan(0);
        expect(blocks[0]).toMatch(/height:\s*var\(--wg-streak-bar-height\)/);
    });

    it('bottom nav anchors to the viewport via position:fixed (nav has no positioned ancestor at runtime)', () => {
        const blocks = extractClassBlocks(css, '.wg-bottom-nav');
        expect(blocks.length).toBeGreaterThan(0);
        expect(blocks[0]).toMatch(/position:\s*fixed\b/);
    });

    it('#app reserves bottom space for the fixed nav via --wg-bottom-nav-reserved', () => {
        const blocks = extractClassBlocks(css, '#app');
        expect(blocks.length).toBeGreaterThan(0);
        expect(blocks[0]).toMatch(/padding-bottom:\s*var\(--wg-bottom-nav-reserved\)/);
    });

    it('screen stage utility pulls --wg-bg-stage so section labels render on the deep-teal substrate', () => {
        const blocks = extractClassBlocks(css, '.wg-screen-stage');
        expect(blocks.length).toBeGreaterThan(0);
        expect(blocks[0]).toMatch(/background:[\s\S]*var\(--wg-bg-stage\)/);
        // No hex literals in the stage rule — enforced generically by the
        // hex-literal loop above, re-asserted here so regressions are loud.
        expect(blocks[0]).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });

    it('.wg-fab has been retired — primary actions now live inline with tab/day-nav rows, not as fixed FABs', () => {
        // Phase 5, Task 5 + Round-2 Task 3: removed the floating-action-button
        // utility and the Food sticky CTA dock once every section moved its
        // primary CTA inline with the day-nav / title row. The `--wg-z-fab`
        // token is kept in `:root` for now (guarded by the design-tokens
        // allowlist test) but has no active consumers.
        const blocks = extractClassBlocks(css, '.wg-fab');
        expect(blocks.length).toBe(0);
        const dockBlocks = extractClassBlocks(css, '.wg-food-cta-dock');
        expect(dockBlocks.length).toBe(0);
    });

    it('.wg-modal carries card-like background pulling --wg-bg-card and uses z-modal', () => {
        const blocks = extractClassBlocks(css, '.wg-modal');
        expect(blocks.length).toBeGreaterThan(0);
        const body = blocks[0];
        expect(body).toMatch(/position:\s*fixed\b/);
        expect(body).toMatch(/background:[\s\S]*var\(--wg-bg-card\)/);
        expect(body).toMatch(/border-radius:\s*var\(--wg-radius-card\)/);
        expect(body).toMatch(/z-index:\s*var\(--z-modal\)/);
    });

    it('.wg-modal__title uses the mono display family so titles read as JetBrains Mono', () => {
        const blocks = extractClassBlocks(css, '.wg-modal__title');
        expect(blocks.length).toBeGreaterThan(0);
        expect(blocks[0]).toMatch(/font-family:\s*var\(--wg-font-mono\)/);
    });

    it('.wg-input pulls background/border/color from --wg-* tokens', () => {
        const blocks = extractClassBlocks(css, '.wg-input');
        expect(blocks.length).toBeGreaterThan(0);
        const body = blocks[0];
        expect(body).toMatch(/background:\s*var\(--wg-bg-card-inset\)/);
        expect(body).toMatch(/color:\s*var\(--wg-fg-1\)/);
        expect(body).toMatch(/border:[\s\S]*var\(--wg-border-hairline\)/);
    });

    it('.wg-label uses the --wg-fg-3 quiet-text token (AA on teal stage)', () => {
        const blocks = extractClassBlocks(css, '.wg-label');
        expect(blocks.length).toBeGreaterThan(0);
        expect(blocks[0]).toMatch(/color:\s*var\(--wg-fg-3\)/);
    });

    it('#bp-modal markup uses the wg-modal shell + wg-bp-modal eyebrow/title/inset utilities', () => {
        const html = fs.readFileSync(
            path.join(REPO_ROOT, 'web/static/index.html'),
            'utf8'
        );
        // Shell wears .wg-modal + the .wg-bp-modal variant class.
        expect(html).toMatch(/<mt-modal[^>]*id="bp-modal"[^>]*class="[^"]*\bwg-modal\b/);
        expect(html).toMatch(/<mt-modal[^>]*id="bp-modal"[^>]*class="[^"]*\bwg-bp-modal\b/);
        // Eyebrow is the runtime-toggleable section-label; title is the mono display.
        expect(html).toMatch(/class="[^"]*\bwg-section-label\b[^"]*\bwg-bp-modal__eyebrow\b[^"]*"\s+id="bp-modal-eyebrow"/);
        expect(html).toMatch(/class="[^"]*\bwg-mono-display\b[^"]*\bwg-bp-modal__title\b[^"]*"\s+id="bp-modal-title"/);
        // Cancel is a plain gloss; Save is sun gloss. Form= attr must survive
        // so handleBPSubmit's querySelector keeps working.
        expect(html).toMatch(/id="bp-modal-cancel-btn"[^>]*class="[^"]*\bwg-gloss\b/);
        expect(html).toMatch(/form="bp-form"[^>]*class="[^"]*\bwg-gloss--sun\b/);
        // Fields carry .wg-bp-modal__input inside .wg-gloss--inset wraps.
        expect(html).toMatch(/id="bp-systolic"[^>]*class="[^"]*\bwg-bp-modal__input\b/);
        expect(html).toMatch(/id="bp-site"[^>]*class="[^"]*\bwg-bp-modal__input\b/);
        // Paper-era button + form-row classes must not linger in the BP modal.
        const bpModalBlock = html.match(/<mt-modal[^>]*id="bp-modal"[\s\S]*?<\/mt-modal>/);
        expect(bpModalBlock, 'expected bp-modal block in index.html').not.toBeNull();
        expect(bpModalBlock[0]).not.toMatch(/\bbtn-primary\b/);
        expect(bpModalBlock[0]).not.toMatch(/\bbtn-secondary\b/);
        // No un-wrapped h3 title — the dual-line eyebrow/title pattern replaces it.
        expect(bpModalBlock[0]).not.toMatch(/<h3[^>]*\bwg-modal__title\b/);
    });

    it('#bp-view opts into the shared screen-stage utility in index.html', () => {
        const html = fs.readFileSync(
            path.join(REPO_ROOT, 'web/static/index.html'),
            'utf8'
        );
        // Must be on the bp-view div — not just present somewhere.
        const re = /<div\s+id="bp-view"[^>]*\bclass="[^"]*\bwg-screen-stage\b/;
        expect(re.test(html), 'expected #bp-view to carry .wg-screen-stage').toBe(true);
    });
});
