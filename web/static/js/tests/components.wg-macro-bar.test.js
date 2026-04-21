// Tests for the WGMacroBar component (Phase 4, Task 2).
// The fill colour comes from a `.wg-macro-bar__fill--<variant>` CSS class,
// not from an inline colour string; the fill width is driven via the
// `--fill-pct` custom property so the CSS transition stays intact and the
// architecture inline-style guard stays green.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const WG_MACRO_BAR_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-macro-bar.js');

function loadEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only',
    });
    dom.window.eval(fs.readFileSync(WG_MACRO_BAR_JS, 'utf8'));
    return {
        window: dom.window,
        api: dom.window.WGMacroBar,
        cleanup: () => dom.window.close(),
    };
}

describe('WGMacroBar.render', () => {
    let env;
    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env.cleanup(); });

    it('exposes WGMacroBar on window with a render function', () => {
        expect(typeof env.api).toBe('object');
        expect(typeof env.api.render).toBe('function');
        expect(Array.isArray(env.api.VARIANTS)).toBe(true);
        expect(env.api.VARIANTS).toEqual(expect.arrayContaining(['energy', 'protein', 'carbs', 'fat']));
    });

    it('returns a wg-macro-bar container with label, track, and value children', () => {
        const row = env.api.render({ label: 'Energy', value: 1200, target: 2000, unit: 'kcal', variant: 'energy' });
        expect(row).not.toBeNull();
        expect(row.classList.contains('wg-macro-bar')).toBe(true);
        expect(row.querySelector('.wg-macro-bar__label')).not.toBeNull();
        expect(row.querySelector('.wg-macro-bar__track')).not.toBeNull();
        expect(row.querySelector('.wg-macro-bar__fill')).not.toBeNull();
        expect(row.querySelector('.wg-macro-bar__value')).not.toBeNull();
    });

    it('applies .wg-gloss--inset to the track so the inset surface tokens resolve via CSS', () => {
        const row = env.api.render({ label: 'Protein', value: 40, target: 100, unit: 'g', variant: 'protein' });
        const track = row.querySelector('.wg-macro-bar__track');
        expect(track.classList.contains('wg-gloss--inset')).toBe(true);
    });

    it('sets the fill width via --fill-pct custom property (never a raw width= or style=)', () => {
        const row = env.api.render({ label: 'Protein', value: 25, target: 100, unit: 'g', variant: 'protein' });
        const fill = row.querySelector('.wg-macro-bar__fill');
        expect(fill.style.getPropertyValue('--fill-pct')).toBe('25%');
        // No inline width, no inline color — CSS class owns those.
        expect(fill.style.width).toBe('');
        expect(fill.style.background).toBe('');
        expect(fill.getAttribute('style') || '').not.toMatch(/#[0-9a-fA-F]{3,8}/);
    });

    it('clamps fill width to 100% when value exceeds target', () => {
        const row = env.api.render({ label: 'Carbs', value: 400, target: 200, unit: 'g', variant: 'carbs' });
        const fill = row.querySelector('.wg-macro-bar__fill');
        expect(fill.style.getPropertyValue('--fill-pct')).toBe('100%');
    });

    it('clamps fill width to 0% for negative values', () => {
        const row = env.api.render({ label: 'Fat', value: -10, target: 70, unit: 'g', variant: 'fat' });
        const fill = row.querySelector('.wg-macro-bar__fill');
        expect(fill.style.getPropertyValue('--fill-pct')).toBe('0%');
    });

    it('falls back to 0% when target is missing, zero, negative, or non-finite', () => {
        for (const target of [undefined, 0, -50, NaN, 'abc']) {
            const row = env.api.render({ label: 'Energy', value: 500, target, unit: 'kcal', variant: 'energy' });
            const fill = row.querySelector('.wg-macro-bar__fill');
            expect(fill.style.getPropertyValue('--fill-pct')).toBe('0%');
        }
    });

    it('treats non-finite values as zero (no NaN% leak into the DOM)', () => {
        const row = env.api.render({ label: 'Protein', value: NaN, target: 100, unit: 'g', variant: 'protein' });
        const fill = row.querySelector('.wg-macro-bar__fill');
        expect(fill.style.getPropertyValue('--fill-pct')).toBe('0%');
        const current = row.querySelector('.wg-macro-bar__value-current');
        expect(current.textContent).toBe('0');
    });

    it('attaches the correct variant class for each known variant', () => {
        for (const variant of ['energy', 'protein', 'carbs', 'fat']) {
            const row = env.api.render({ label: variant, value: 10, target: 20, unit: 'g', variant });
            const fill = row.querySelector('.wg-macro-bar__fill');
            expect(fill.classList.contains(`wg-macro-bar__fill--${variant}`)).toBe(true);
        }
    });

    it('omits the variant class for unknown or missing variants', () => {
        const row = env.api.render({ label: 'Energy', value: 10, target: 20, unit: 'kcal', variant: 'mystery' });
        const fill = row.querySelector('.wg-macro-bar__fill');
        expect(fill.classList.contains('wg-macro-bar__fill')).toBe(true);
        for (const cls of Array.from(fill.classList)) {
            expect(cls.startsWith('wg-macro-bar__fill--')).toBe(false);
        }
    });

    it('formats the value suffix as "<value> / <target> <unit>" with mono classes', () => {
        const row = env.api.render({ label: 'Carbs', value: 75, target: 250, unit: 'g', variant: 'carbs' });
        const current = row.querySelector('.wg-macro-bar__value-current');
        const target = row.querySelector('.wg-macro-bar__value-target');
        expect(current.textContent).toBe('75');
        expect(target.textContent).toBe(' / 250 g');
        expect(row.querySelector('.wg-macro-bar__value').classList.contains('wg-macro-bar__value')).toBe(true);
    });

    it('omits the unit suffix when no unit is provided', () => {
        const row = env.api.render({ label: 'Protein', value: 10, target: 50, variant: 'protein' });
        const target = row.querySelector('.wg-macro-bar__value-target');
        expect(target.textContent).toBe(' / 50');
    });

    it('renders an em-dash placeholder in the target slot when target is missing', () => {
        const row = env.api.render({ label: 'Protein', value: 10, unit: 'g', variant: 'protein' });
        const target = row.querySelector('.wg-macro-bar__value-target');
        expect(target.textContent).toBe(' / — g');
    });

    it('falls back to an empty label when none is passed', () => {
        const row = env.api.render({ value: 10, target: 20, unit: 'g', variant: 'protein' });
        const label = row.querySelector('.wg-macro-bar__label');
        expect(label.textContent).toBe('');
    });

    it('does not write any hardcoded hex colour into the DOM', () => {
        const row = env.api.render({ label: 'Fat', value: 30, target: 70, unit: 'g', variant: 'fat' });
        expect(row.outerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    });
});
