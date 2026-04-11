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

    // BP category badge colors
    '--color-bp-category-grade1-bg',
    '--color-bp-category-grade1-text',

    // Chart extra colors
    '--color-chart-plan',

    // Inventory badge
    '--color-inventory-ok',

    // Workout card gradients
    '--color-workout-card-bg-start',
    '--color-workout-card-bg-end',
    '--color-workout-today-start',
    '--color-workout-today-end',
    '--color-workout-skipped-start',
    '--color-workout-skipped-end',
    '--color-workout-skipped-accent',

    // Status bar colors
    '--color-status-offline-bg-start',
    '--color-status-offline-bg-end',
    '--color-status-offline-text',
    '--color-status-offline-border',
    '--color-status-syncing-bg-start',
    '--color-status-syncing-bg-end',
    '--color-status-syncing-text',
    '--color-status-syncing-border',
    '--color-status-pending-bg-start',
    '--color-status-pending-bg-end',
    '--color-status-pending-text',
    '--color-status-pending-border',

    // Sync toast solid backgrounds
    '--color-toast-info-solid',
    '--color-toast-success-solid',
    '--color-toast-error-solid',

    // Data refresh banner
    '--color-refresh-btn',

    // UI / borders
    '--color-border-divider',
    '--color-toggle-inactive',

    // Autocomplete
    '--color-autocomplete-delete',
    '--color-autocomplete-delete-light',

    // Food search status
    '--color-food-status-success',
    '--color-food-status-empty',
    '--color-food-status-error',

    // Scanner
    '--color-scanner-bg',

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

    it('no hardcoded hex colors outside :root (except allowlisted fallbacks)', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');

        // Split CSS into lines and track whether we are inside :root or
        // a @media dark-mode :root override block
        const lines = css.split('\n');
        let insideRoot = false;
        let braceDepth = 0;
        let insideDarkMediaRoot = false;
        let darkMediaDepth = 0;
        let inDarkMedia = false;

        const hexColorRe = /#(?:[0-9a-fA-F]{3,8})\b/g;
        // Hex colors that appear inside var() fallbacks are fine
        const varFallbackRe = /var\([^)]*#[0-9a-fA-F]{3,8}/;
        // Allowlisted generic colors (white/black keywords as hex)
        const allowlistedHex = new Set(['#fff', '#ffffff', '#000', '#000000']);

        const violations = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineNum = i + 1;

            // Track :root block
            if (/^:root\s*\{/.test(line.trim())) {
                insideRoot = true;
                braceDepth = 1;
                continue;
            }
            if (insideRoot) {
                for (const ch of line) {
                    if (ch === '{') braceDepth++;
                    if (ch === '}') braceDepth--;
                }
                if (braceDepth <= 0) insideRoot = false;
                continue;
            }

            // Track @media (prefers-color-scheme: dark) { :root { ... } }
            if (/prefers-color-scheme:\s*dark/.test(line)) {
                inDarkMedia = true;
                darkMediaDepth = 0;
                for (const ch of line) {
                    if (ch === '{') darkMediaDepth++;
                    if (ch === '}') darkMediaDepth--;
                }
                continue;
            }
            if (inDarkMedia) {
                for (const ch of line) {
                    if (ch === '{') darkMediaDepth++;
                    if (ch === '}') darkMediaDepth--;
                }
                if (darkMediaDepth <= 0) inDarkMedia = false;
                continue;
            }

            // Skip lines that are CSS selectors containing # (e.g. #add-btn)
            if (/^\s*[#.\w[\]:>~+,\s-]+\s*[,{]?\s*$/.test(line) && !line.includes(':')) {
                continue;
            }

            // Check for hex colors
            const matches = line.match(hexColorRe);
            if (!matches) continue;

            // Skip if all hex values are inside var() fallbacks
            if (varFallbackRe.test(line)) {
                // Remove var() fallback portions and re-check
                const withoutFallbacks = line.replace(/var\([^)]*\)/g, '');
                const remaining = withoutFallbacks.match(hexColorRe);
                if (!remaining) continue;
                // Filter out allowlisted
                const real = remaining.filter(h => !allowlistedHex.has(h.toLowerCase()));
                if (real.length > 0) {
                    violations.push({ line: lineNum, text: line.trim(), colors: real });
                }
                continue;
            }

            const real = matches.filter(h => !allowlistedHex.has(h.toLowerCase()));
            if (real.length > 0) {
                violations.push({ line: lineNum, text: line.trim(), colors: real });
            }
        }

        if (violations.length > 0) {
            const report = violations
                .map(v => `  L${v.line}: ${v.colors.join(', ')} — ${v.text}`)
                .join('\n');
            throw new Error(
                `Found ${violations.length} lines with hardcoded hex colors outside :root:\n\n${report}\n\n` +
                `Replace these with CSS custom property tokens (var(--token-name)).`
            );
        }
    });

    it('button system classes are defined in CSS', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');

        const requiredButtonClasses = [
            '.btn',
            '.btn-primary',
            '.btn-secondary',
            '.btn-danger',
            '.btn-danger-outline',
            '.btn-ghost',
            '.btn-sm',
            '.btn-lg',
            '.btn-pill',
            '.btn-icon',
            '.btn-fab',
            '.btn-link',
        ];

        const missing = requiredButtonClasses.filter(cls => {
            // Match class selector at start of line or after comma/space
            const escaped = cls.replace('.', '\\.');
            const re = new RegExp(`(?:^|[,\\s])${escaped}(?:[\\s,.:{[>~+]|$)`, 'm');
            return !re.test(css);
        });

        if (missing.length > 0) {
            throw new Error(
                `Missing button system classes in styles.css:\n\n` +
                missing.map(c => `  • ${c}`).join('\n')
            );
        }
    });

    it('no legacy button class names remain in CSS', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');

        // Old button class names that should have been migrated
        const legacyClasses = [
            /(?:^|[,\s])\.primary(?=[\s,.:{[>~+]|$)/m,
            /(?:^|[,\s])\.secondary(?=[\s,.:{[>~+]|$)/m,
            /(?:^|[,\s])\.btn-add(?=[\s,.:{[>~+]|$)/m,
            /(?:^|[,\s])\.small-btn(?=[\s,.:{[>~+]|$)/m,
            /(?:^|[,\s])\.danger(?=[\s,.:{[>~+]|$)/m,
            /(?:^|[,\s])\.text-btn(?=[\s,.:{[>~+]|$)/m,
        ];

        const found = [];
        for (const re of legacyClasses) {
            const match = css.match(re);
            if (match) {
                found.push(match[0].trim());
            }
        }

        if (found.length > 0) {
            throw new Error(
                `Legacy button classes still defined in styles.css (should use new .btn system):\n\n` +
                found.map(c => `  • ${c}`).join('\n')
            );
        }
    });

    it('no legacy button class names in index.html (except as part of new system)', () => {
        const htmlPath = path.join(REPO_ROOT, 'web/static/index.html');
        const html = fs.readFileSync(htmlPath, 'utf8');

        // These old class names should not appear standalone in class attributes
        const legacyPatterns = [
            { name: 'class="primary"', re: /class="primary"/g },
            { name: 'class="secondary"', re: /class="secondary"/g },
            { name: 'class="danger"', re: /class="danger"/g },
            { name: 'class="text-btn"', re: /class="text-btn"/g },
            { name: 'class="small-btn"', re: /class="small-btn"/g },
            { name: 'class="btn-add"', re: /class="btn-add"/g },
        ];

        const violations = [];
        for (const { name, re } of legacyPatterns) {
            if (re.test(html)) {
                violations.push(name);
            }
        }

        if (violations.length > 0) {
            throw new Error(
                `Legacy button class patterns found in index.html:\n\n` +
                violations.map(v => `  • ${v}`).join('\n') +
                `\n\nMigrate to new .btn system (e.g. class="btn btn-primary").`
            );
        }
    });

    it('no hardcoded px values in spacing/radius/shadow/font-size/z-index properties outside :root', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        const lines = css.split('\n');

        // Track whether we are inside :root or dark-mode :root override
        let insideRoot = false;
        let braceDepth = 0;
        let inDarkMedia = false;
        let darkMediaDepth = 0;

        // Properties that should use design tokens instead of hardcoded px values
        const spacingPropRe = /^\s*(padding|margin|gap)\s*:/i;
        const radiusPropRe = /^\s*border-radius\s*:/i;
        const shadowPropRe = /^\s*box-shadow\s*:/i;
        const fontSizePropRe = /^\s*font-size\s*:/i;
        const zIndexPropRe = /^\s*z-index\s*:/i;

        // Match hardcoded px values (but not 0px, or values inside var())
        const hardcodedPxRe = /(?<!\w)(\d+)px\b/g;

        // Allowlisted px values that don't have matching tokens or are acceptable
        const spacingAllowlist = new Set([0, 1, 2, 3, 80, 90, 40, 100, 120, 200, 250, 400]);
        const radiusAllowlist = new Set([0]);
        const fontSizeAllowlist = new Set([0, 48]); // 48px is a special display size
        const zIndexAllowlist = new Set([0, 10, 1003, 1200]); // local stacking, scanner, banner

        const violations = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineNum = i + 1;

            // Track :root block
            if (/^:root\s*\{/.test(line.trim())) {
                insideRoot = true;
                braceDepth = 1;
                continue;
            }
            if (insideRoot) {
                for (const ch of line) {
                    if (ch === '{') braceDepth++;
                    if (ch === '}') braceDepth--;
                }
                if (braceDepth <= 0) insideRoot = false;
                continue;
            }

            // Track dark-mode :root
            if (/prefers-color-scheme:\s*dark/.test(line)) {
                inDarkMedia = true;
                darkMediaDepth = 0;
                for (const ch of line) {
                    if (ch === '{') darkMediaDepth++;
                    if (ch === '}') darkMediaDepth--;
                }
                continue;
            }
            if (inDarkMedia) {
                for (const ch of line) {
                    if (ch === '{') darkMediaDepth++;
                    if (ch === '}') darkMediaDepth--;
                }
                if (darkMediaDepth <= 0) inDarkMedia = false;
                continue;
            }

            // Skip lines that already use var() for the value
            if (/var\(--/.test(line)) {
                // Check if there are ALSO hardcoded px values mixed in (compound values)
                const withoutVars = line.replace(/var\([^)]*\)/g, '');
                if (!hardcodedPxRe.test(withoutVars)) continue;
                // Reset regex lastIndex for reuse below
                hardcodedPxRe.lastIndex = 0;
            }

            // Skip comment lines
            if (/^\s*\/?\*/.test(line) || /^\s*\/\//.test(line)) continue;

            // Check each property type
            let propType = null;
            let allowlist = null;

            if (spacingPropRe.test(line)) {
                propType = 'spacing';
                allowlist = spacingAllowlist;
            } else if (radiusPropRe.test(line)) {
                propType = 'border-radius';
                allowlist = radiusAllowlist;
            } else if (shadowPropRe.test(line)) {
                propType = 'box-shadow';
                allowlist = new Set([0]);
            } else if (fontSizePropRe.test(line)) {
                propType = 'font-size';
                allowlist = fontSizeAllowlist;
            } else if (zIndexPropRe.test(line)) {
                propType = 'z-index';
                allowlist = zIndexAllowlist;
            }

            if (!propType) continue;

            // For z-index, check raw numeric values (not px)
            if (propType === 'z-index') {
                const zMatch = line.match(/z-index\s*:\s*(\d+)/);
                if (zMatch && !allowlist.has(parseInt(zMatch[1], 10)) && !line.includes('var(')) {
                    violations.push({ line: lineNum, text: line.trim(), type: propType });
                }
                continue;
            }

            // For box-shadow, check if it has hardcoded rgba/px and isn't using var()
            // Allow colored shadows (non-black rgba) as they are design-specific
            if (propType === 'box-shadow') {
                if (!line.includes('var(') && /\d+px/.test(line) && line.trim() !== 'box-shadow: none;') {
                    // Skip colored shadows (rgba with non-zero R/G/B channels)
                    const rgbaMatch = line.match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
                    if (rgbaMatch && (parseInt(rgbaMatch[1]) > 0 || parseInt(rgbaMatch[2]) > 0 || parseInt(rgbaMatch[3]) > 0)) {
                        continue;
                    }
                    violations.push({ line: lineNum, text: line.trim(), type: propType });
                }
                continue;
            }

            // Extract the value part (after the colon)
            const colonIdx = line.indexOf(':');
            if (colonIdx === -1) continue;
            const valuePart = line.slice(colonIdx + 1).replace(/var\([^)]*\)/g, '');

            const matches = [...valuePart.matchAll(hardcodedPxRe)];
            const badValues = matches.filter(m => !allowlist.has(parseInt(m[1], 10)));

            if (badValues.length > 0) {
                violations.push({
                    line: lineNum,
                    text: line.trim(),
                    type: propType,
                    values: badValues.map(m => m[0]),
                });
            }
        }

        if (violations.length > 0) {
            const report = violations
                .map(v => `  L${v.line} [${v.type}]: ${v.text}`)
                .join('\n');
            throw new Error(
                `Found ${violations.length} lines with hardcoded values that should use design tokens:\n\n${report}\n\n` +
                `Replace these with CSS custom property tokens (e.g., var(--space-lg), var(--radius-md)).`
            );
        }
    });

    it('no inline style assignments in app.js (except style.display for show/hide)', () => {
        const appPath = path.join(REPO_ROOT, 'web/static/js/app.js');
        const appJs = fs.readFileSync(appPath, 'utf8');
        const lines = appJs.split('\n');

        // Patterns that indicate inline style assignments
        const styleCssTextRe = /\.style\.cssText\s*=/;
        const stylePropRe = /\.style\.\w+\s*=/;
        // Allowlisted patterns
        const displayRe = /\.style\.display\s*=/;
        const setPropertyRe = /\.style\.setProperty\(/;
        // Dynamic chart badge color (data-driven, cannot be CSS class)
        const backgroundDynamicRe = /\.style\.background\s*=\s*color/;

        const violations = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineNum = i + 1;

            // Skip comments
            if (/^\s*\/\//.test(line) || /^\s*\/?\*/.test(line)) continue;

            // Check for style.cssText
            if (styleCssTextRe.test(line)) {
                violations.push({ line: lineNum, text: line.trim() });
                continue;
            }

            // Check for style.property = assignments
            if (stylePropRe.test(line)) {
                // Allow style.display (show/hide)
                if (displayRe.test(line)) continue;
                // Allow style.setProperty (CSS custom properties)
                if (setPropertyRe.test(line)) continue;
                // Allow dynamic background color for chart legend badges
                if (backgroundDynamicRe.test(line)) continue;

                violations.push({ line: lineNum, text: line.trim() });
            }
        }

        if (violations.length > 0) {
            const report = violations
                .map(v => `  L${v.line}: ${v.text}`)
                .join('\n');
            throw new Error(
                `Found ${violations.length} inline style assignments in app.js:\n\n${report}\n\n` +
                `Replace with CSS classes. Allowed exceptions: style.display (show/hide), ` +
                `style.setProperty (CSS custom props), style.background = color (dynamic chart data).`
            );
        }
    });

    it('utility and component CSS classes are defined in styles.css', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');

        const requiredClasses = [
            // Utility classes
            '.flex-row', '.flex-col', '.flex-center', '.flex-between',
            '.text-center', '.text-hint', '.text-danger', '.text-success', '.text-muted',
            '.cursor-pointer',
            '.gap-sm', '.gap-md',
            '.mb-xs', '.mb-sm', '.mb-md', '.mb-lg',
            '.mt-sm', '.mt-md', '.mt-xs',
            '.m-0', '.fw-medium', '.w-full',
            // Login components
            '.login-container', '.login-title', '.login-message',
            '.login-tg-container', '.login-tg-hint', '.login-tg-link',
            '.login-divider', '.login-divider-line', '.login-setup-link',
            '.btn-oidc',
            // Status
            '.status-success', '.status-error', '.status-muted',
            // Medication
            '.med-supplement-badge', '.med-normalized-name',
            '.med-action-icons', '.med-empty-text',
            // Next intake
            '.next-intake-card', '.next-intake-title',
            '.next-intake-countdown', '.next-intake-details', '.next-intake-action',
            // Charts
            '.chart-section', '.chart-container', '.chart-container-tall',
            '.chart-stat', '.chart-stat-spaced', '.chart-legend',
            '.chart-legend-item', '.chart-legend-badge', '.chart-legend-badge-line',
            '.chart-disclaimer',
            // SVG
            '.svg-chart',
        ];

        const missing = requiredClasses.filter(cls => {
            const escaped = cls.replace('.', '\\.');
            const re = new RegExp(`(?:^|[,\\s])${escaped}(?:[\\s,.:{[>~+]|$)`, 'm');
            return !re.test(css);
        });

        if (missing.length > 0) {
            throw new Error(
                `Missing utility/component CSS classes in styles.css:\n\n` +
                missing.map(c => `  • ${c}`).join('\n')
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
