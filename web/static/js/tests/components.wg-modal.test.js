/**
 * components.wg-modal.test.js
 *
 * Structural + token-only assertions for the Wandergeek modal utilities
 * introduced in Phase 3 round-2 Task 5. The classes are generic and will
 * be reused by Food (Phase 4), Medication (Phase 5), etc.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CSS_PATH = path.join(REPO_ROOT, 'web/static/css/styles.css');

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

describe('Wandergeek modal structural DOM', () => {
    it('wg-modal skeleton renders title + body + actions with expected classes', () => {
        const dom = new JSDOM(`
            <div class="wg-modal" id="demo-modal">
                <div class="wg-modal__header">
                    <h3 class="wg-modal__title">Demo</h3>
                    <div class="wg-modal__actions">
                        <button class="wg-gloss">Cancel</button>
                        <button class="wg-gloss wg-gloss--sun">Save</button>
                    </div>
                </div>
                <form class="wg-modal__body">
                    <div class="wg-field">
                        <label class="wg-label" for="x">X</label>
                        <input id="x" class="wg-input">
                    </div>
                    <div class="wg-field">
                        <label class="wg-label" for="y">Y</label>
                        <select id="y" class="wg-select"><option>A</option></select>
                    </div>
                </form>
            </div>
        `);
        const { document } = dom.window;

        const modal = document.getElementById('demo-modal');
        expect(modal.classList.contains('wg-modal')).toBe(true);

        const title = modal.querySelector('.wg-modal__title');
        expect(title).not.toBeNull();
        expect(title.textContent).toBe('Demo');

        const actions = modal.querySelector('.wg-modal__actions');
        expect(actions).not.toBeNull();
        const cancel = actions.querySelector('button.wg-gloss:not(.wg-gloss--sun)');
        const save = actions.querySelector('button.wg-gloss.wg-gloss--sun');
        expect(cancel).not.toBeNull();
        expect(save).not.toBeNull();

        const body = modal.querySelector('.wg-modal__body');
        expect(body).not.toBeNull();
        expect(body.querySelectorAll('.wg-field').length).toBe(2);
        expect(body.querySelector('input.wg-input')).not.toBeNull();
        expect(body.querySelector('select.wg-select')).not.toBeNull();
        expect(body.querySelectorAll('.wg-label').length).toBe(2);

        dom.window.close();
    });
});

describe('Wandergeek modal token-only CSS', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');

    it.each([
        '.wg-modal',
        '.wg-modal__header',
        '.wg-modal__title',
        '.wg-modal__body',
        '.wg-modal__actions',
        '.wg-field',
        '.wg-label',
        '.wg-input',
        '.wg-select',
    ])('%s contains no hardcoded hex colors', (cls) => {
        const blocks = extractClassBlocks(css, cls);
        expect(blocks.length, `expected rule for ${cls}`).toBeGreaterThan(0);
        for (const body of blocks) {
            const hex = body.match(/#[0-9a-fA-F]{3,8}\b/g);
            expect(hex, `hex literal in ${cls}: ${hex}`).toBeNull();
        }
    });

    it('.wg-modal is positioned as a centered fixed dialog', () => {
        const [body] = extractClassBlocks(css, '.wg-modal');
        expect(body).toMatch(/position:\s*fixed\b/);
        expect(body).toMatch(/top:\s*50%/);
        expect(body).toMatch(/left:\s*50%/);
        expect(body).toMatch(/transform:\s*translate\(-50%,\s*-50%\)/);
    });

    it('.wg-modal__title declares a margin reset and token-driven font-family', () => {
        const [body] = extractClassBlocks(css, '.wg-modal__title');
        expect(body).toMatch(/margin:\s*0\b/);
        expect(body).toMatch(/font-family:\s*var\(--wg-font-mono\)/);
    });

    it('.wg-field uses a flex column layout with var(--space-*) gap', () => {
        const [body] = extractClassBlocks(css, '.wg-field');
        expect(body).toMatch(/display:\s*flex\b/);
        expect(body).toMatch(/flex-direction:\s*column\b/);
        expect(body).toMatch(/gap:\s*var\(--space-/);
    });

    it('.wg-input and .wg-select share token-driven surface + border', () => {
        const inputBlocks = extractClassBlocks(css, '.wg-input');
        const selectBlocks = extractClassBlocks(css, '.wg-select');
        expect(inputBlocks.length).toBeGreaterThan(0);
        expect(selectBlocks.length).toBeGreaterThan(0);

        // Both the input and select base blocks must reference the same
        // set of Wandergeek tokens — a select must not drift away from
        // the input's surface styling.
        for (const body of [inputBlocks[0], selectBlocks[0]]) {
            expect(body).toMatch(/background:\s*var\(--wg-bg-card-inset\)/);
            expect(body).toMatch(/border:[\s\S]*var\(--wg-border-hairline\)/);
            expect(body).toMatch(/border-radius:\s*var\(--wg-radius-gloss\)/);
            expect(body).toMatch(/font-family:\s*var\(--wg-font-ui\)/);
        }
    });

    it('.wg-label uses --wg-fg-3 (AA-readable quiet text on teal stage)', () => {
        const [body] = extractClassBlocks(css, '.wg-label');
        expect(body).toMatch(/color:\s*var\(--wg-fg-3\)/);
    });
});
