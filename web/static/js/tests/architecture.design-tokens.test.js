/**
 * architecture.design-tokens.test.js
 *
 * Validates that the :root block in styles.css contains all expected
 * design tokens. This ensures tokens are not accidentally removed
 * and that the design system foundation remains complete.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CSS_PATH = path.join(REPO_ROOT, 'web/static/css/styles.css');

/**
 * Extract the first :root { ... } block from the CSS source.
 */
function extractRootBlock(css) {
    const match = css.match(/:root\s*\{([^}]+)\}/);
    return match ? match[1] : '';
}

/**
 * Extract all custom property names (--foo) from a CSS block.
 */
function extractCustomProperties(block) {
    const props = new Set();
    const re = /(--[\w-]+)\s*:/g;
    let m;
    while ((m = re.exec(block)) !== null) {
        props.add(m[1]);
    }
    return props;
}

/** All design tokens that must exist in :root */
const REQUIRED_TOKENS = [
    // Semantic colors
    '--color-success',
    '--color-warning',
    '--color-danger',
    '--color-info',

    // BP classification colors
    '--color-bp-optimal',
    '--color-bp-normal',
    '--color-bp-high-normal',
    '--color-bp-grade1',
    '--color-bp-grade2',
    '--color-bp-grade3',

    // Chart colors
    '--color-chart-primary',
    '--color-chart-secondary',
    '--color-chart-accent',
    '--color-chart-highlight',

    // Sync status colors
    '--color-sync-pending',
    '--color-sync-success',
    '--color-sync-error',

    // Toast colors
    '--color-toast-success-bg',
    '--color-toast-success-text',
    '--color-toast-warning-bg',
    '--color-toast-warning-text',
    '--color-toast-error-bg',
    '--color-toast-error-text',
    '--color-toast-info-bg',
    '--color-toast-info-text',

    // Overlay colors
    '--color-overlay',
    '--color-overlay-light',

    // Spacing tokens
    '--space-xs',
    '--space-sm',
    '--space-md',
    '--space-lg',
    '--space-xl',
    '--space-2xl',

    // Border radius tokens
    '--radius-sm',
    '--radius-md',
    '--radius-lg',
    '--radius-xl',
    '--radius-pill',

    // Shadow tokens
    '--shadow-sm',
    '--shadow-md',
    '--shadow-lg',

    // Typography tokens
    '--font-size-xs',
    '--font-size-sm',
    '--font-size-md',
    '--font-size-lg',
    '--font-size-xl',
    '--font-weight-normal',
    '--font-weight-medium',
    '--font-weight-bold',

    // Z-index tokens
    '--z-dropdown',
    '--z-overlay',
    '--z-modal',
    '--z-popover',
    '--z-toast',
];

describe('Architecture – design tokens', () => {
    it(':root block contains all required design tokens', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        const rootBlock = extractRootBlock(css);
        expect(rootBlock).not.toBe('');

        const defined = extractCustomProperties(rootBlock);
        const missing = REQUIRED_TOKENS.filter(t => !defined.has(t));

        if (missing.length > 0) {
            throw new Error(
                `Missing design tokens in :root block of styles.css:\n\n` +
                missing.map(t => `  • ${t}`).join('\n')
            );
        }
    });

    it('Telegram theme mirrors are preserved in :root', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        const rootBlock = extractRootBlock(css);

        const telegramTokens = [
            '--bg-color',
            '--text-color',
            '--hint-color',
            '--link-color',
            '--button-color',
            '--button-text-color',
            '--secondary-bg-color',
        ];

        const defined = extractCustomProperties(rootBlock);
        const missing = telegramTokens.filter(t => !defined.has(t));

        if (missing.length > 0) {
            throw new Error(
                `Missing Telegram theme tokens in :root:\n\n` +
                missing.map(t => `  • ${t}`).join('\n')
            );
        }
    });
});
