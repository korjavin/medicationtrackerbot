// architecture.ios-hazards.test.js
//
// Tier 0 of docs/design/ios-visual-testing.md (med-y5xx.7): static iOS layout
// hazards, reported as file:line.
//
//  1. 100vh / 100svh in sheet / modal / overlay / dialog rules (iOS: vh ignores
//     the keyboard and the collapsing toolbar; use 100dvh + the WGSheet dock).
//  2. position:fixed + bottom:0 needs env(safe-area-inset-bottom) in the same
//     rule (full-bleed overlays that also pin top:0 are exempt).
//  3. No user-scalable=no / maximum-scale in any viewport meta. The iOS-only
//     focus-zoom cap is applied at runtime by WGSheet.noFocusZoom() (PR #1115);
//     this test also pins that guard in place.
//  4. Form-control rules whose font-size resolves under 16px (iOS zooms on
//     focus below 16px). Safe only because of noFocusZoom(); every hit must be
//     in the allowlist so a NEW sub-16px control is a conscious decision.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const rel = (p) => path.relative(ROOT, p);
const CSS_FILES = ['web/static/css', 'web/cloud/css'].flatMap((d) =>
    fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.css')).map((f) => path.join(ROOT, d, f)));
const HTML_FILES = ['web/static/index.html', ...fs.readdirSync(path.join(ROOT, 'web/cloud')).filter((f) => f.endsWith('.html')).map((f) => 'web/cloud/' + f)]
    .map((f) => path.join(ROOT, f));

// Flat rule scanner: [{ file, line, selector, body }]. Strips comments (keeping
// newlines) and flattens @media/@supports nesting, which is enough for the
// declarations checked here.
function rules(file) {
    const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    const out = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(src))) {
        // A preceding "@media (...) {" or "...;" rides along in group 1; keep only the selector.
        const selector = m[1].replace(/^[\s\S]*[;{]/, '').replace(/^[\s\S]*\)\s*$/, m[1]).trim();
        if (selector.startsWith('@')) continue;
        const lead = m[1].length - m[1].trimStart().length;
        const line = src.slice(0, m.index + lead).split('\n').length;
        out.push({ file: rel(file), line, selector: selector.replace(/\s+/g, ' '), body: m[2] });
    }
    return out;
}
const ALL = CSS_FILES.flatMap(rules);
const decl = (r, prop) => (r.body.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`)) || [])[1]?.trim();
const fail = (msg, hits) => { if (hits.length) throw new Error(`${msg}\n${hits.map((h) => `  • ${h}`).join('\n')}`); };

// Pixel tokens (--x: 14px) resolved from any definition.
const TOKENS = {};
for (const r of ALL) for (const [, k, v] of r.body.matchAll(/(--[\w-]+)\s*:\s*([\d.]+)px/g)) TOKENS[k] ??= parseFloat(v);
const px = (v) => {
    if (!v) return null;
    const t = v.match(/^var\((--[\w-]+)/);
    if (t) return TOKENS[t[1]] ?? null;
    const n = v.match(/^([\d.]+)px/);
    return n ? parseFloat(n[1]) : null;
};
const fontSize = (r) => px(decl(r, 'font-size') ?? (decl(r, 'font') || '').split(/\s+/).find((t) => /^(var\(--wg-fs|[\d.]+px(\/|$))/.test(t)));

// Existing fixed+bottom:0 rules without a safe-area inset in the same rule.
const FIXED_BOTTOM_ALLOW = new Set([
    // Bakes 28px of bottom padding into the bar (components.css .wg-tabbar) for
    // the home indicator; the viewport has no viewport-fit=cover, so env() is 0.
    'web/static/css/styles.css .wg-tabbar',
    // Dev-only debug overlay, hidden by default.
    'web/static/css/styles.css .sync-debug-panel',
]);

// Existing sub-16px form controls, "<file> <selector>". Safe at runtime only
// via WGSheet.noFocusZoom() (maximum-scale=1 on iOS WebKit, PR #1115).
const SUB16_ALLOW = new Set([
    'web/static/css/components.css .wg-input--text',
    'web/static/css/components.css .wg-textarea',
    'web/static/css/components.css .wg-select',
    'web/static/css/styles.css input',
    'web/static/css/styles.css select',
    'web/static/css/styles.css .wg-workouts-session-exercise__field-input',
]);

describe('Architecture — iOS layout hazards', () => {
    it('no 100vh/100svh in sheet/modal/overlay/dialog rules', () => {
        fail('Use 100dvh (with the WGSheet visual-viewport dock) instead of vh/svh in sheet-like rules:',
            ALL.filter((r) => /sheet|modal|overlay|dialog|drawer/i.test(r.selector) && /\b100s?vh\b/.test(r.body))
                .map((r) => `${r.file}:${r.line} ${r.selector}`));
    });

    it('position:fixed + bottom:0 carries env(safe-area-inset-bottom) in the same rule', () => {
        fail('Fixed bottom-pinned rules need env(safe-area-inset-bottom) (or add to FIXED_BOTTOM_ALLOW with a reason):',
            ALL.filter((r) => decl(r, 'position') === 'fixed' && /^0(px)?$/.test(decl(r, 'bottom') || '')
                    && !/\btop\s*:\s*0/.test(r.body) && !/safe-area-inset-bottom/.test(r.body)
                    && !FIXED_BOTTOM_ALLOW.has(`${r.file} ${r.selector}`))
                .map((r) => `${r.file}:${r.line} ${r.selector}`));
    });

    it('viewport meta never disables or caps zoom in markup', () => {
        const hits = [];
        for (const f of HTML_FILES) {
            fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
                if (/name=["']viewport["']/.test(l) && /user-scalable|maximum-scale|minimum-scale/.test(l)) hits.push(`${rel(f)}:${i + 1}`);
            });
        }
        fail('Viewport meta must not carry user-scalable/maximum-scale; WGSheet.noFocusZoom() caps zoom on iOS at runtime:', hits);
    });

    it('the runtime no-focus-zoom guard is still in place', () => {
        const sheet = fs.readFileSync(path.join(ROOT, 'web/static/js/components/wg-sheet.js'), 'utf8');
        expect(sheet).toMatch(/function noFocusZoom\(\)[\s\S]*maximum-scale=1/);
        expect(sheet).toMatch(/^\s*noFocusZoom\(\);/m); // invoked at load
        expect(sheet).toMatch(/window\.WGSheet = \{[^}]*noFocusZoom/);
    });

    it('form controls under 16px are allowlisted (safe only via noFocusZoom)', () => {
        const CONTROL = /(^|[\s,>+~])(input|select|textarea)\b|\.wg-input|\.wg-textarea|\.wg-select\b|-input\b/;
        const hits = ALL.filter((r) => CONTROL.test(r.selector) && !/::|:-webkit/.test(r.selector) && fontSize(r) !== null && fontSize(r) < 16);
        fail('Form control font-size < 16px zooms on iOS focus unless WGSheet.noFocusZoom() is active. Raise it to 16px or allowlist with a reason:',
            hits.filter((r) => !SUB16_ALLOW.has(`${r.file} ${r.selector}`)).map((r) => `${r.file}:${r.line} ${r.selector}`));
        const keys = hits.map((r) => `${r.file} ${r.selector}`);
        expect([...SUB16_ALLOW].filter((k) => !keys.includes(k)), 'stale SUB16_ALLOW entries').toEqual([]);
    });
});
