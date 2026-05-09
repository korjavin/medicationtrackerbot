// Round-2 Task 6 (defect #9) — Food toolbar single-row regression tests.
//
// Pins two invariants the Task 6 migration fixes:
//
//   1. The day-nav header renders a single row with the four items in this
//      DOM order: [< prev] [center: date+subtitle] [next >] [Add]. The
//      trailing Add button is a sibling of the chevrons inside the same
//      `.wg-food-day-nav--with-action` grid container — never a child of
//      the center cell, never outside the container.
//
//   2. The CSS cascade lets `.wg-food-day-nav--with-action` (4-column
//      `grid-template-columns` override) win over `.wg-food-day-nav`
//      (3-column base). Both selectors have equal specificity, so the
//      override MUST come after the base rule. The original defect was
//      that `--with-action` was declared BEFORE the base rule, so the
//      grid dropped back to 3 columns and the 4th grid item (Add) spilled
//      onto an implicit second row. This test guards against that order
//      regressing.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CSS_PATH = path.join(REPO_ROOT, 'web/static/css/styles.css');

describe('Food day-nav toolbar row (Round-2 Task 6, defect #9)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('day-nav has exactly five direct-child elements in order: prev, center, next, Add, Photo', () => {
        const { document } = env;
        const nav = document.querySelector('#food-view .wg-food-day-nav');
        expect(nav).not.toBeNull();
        expect(nav.classList.contains('wg-food-day-nav--with-action')).toBe(true);

        // Filter out whitespace-only text nodes — only element children
        // participate in the grid layout.
        const children = Array.from(nav.children);
        expect(children).toHaveLength(5);

        expect(children[0].id).toBe('food-date-prev-btn');
        expect(children[1].classList.contains('wg-food-day-nav__center')).toBe(true);
        expect(children[2].id).toBe('food-date-next-btn');
        expect(children[3].id).toBe('add-food-inline-btn');
        expect(children[4].id).toBe('add-food-photo-btn');
    });

    it('Add button is a sibling of the chevrons, not nested inside the center cell', () => {
        const { document } = env;
        const nav = document.querySelector('#food-view .wg-food-day-nav');
        const center = nav.querySelector('.wg-food-day-nav__center');
        const add = document.getElementById('add-food-inline-btn');

        expect(add.parentElement).toBe(nav);
        expect(center.contains(add)).toBe(false);
    });

    it('Add button uses the shared .wg-toolbar-btn primary sizing', () => {
        const { document } = env;
        const add = document.getElementById('add-food-inline-btn');
        expect(add.classList.contains('wg-toolbar-btn')).toBe(true);
        expect(add.classList.contains('wg-toolbar-btn--primary')).toBe(true);

        // Label uses the shared label class — matches the BP +Log adoption
        // from Round-2 Task 5 (see `.wg-toolbar-btn__label`).
        const label = add.querySelector('.wg-toolbar-btn__label');
        expect(label).not.toBeNull();
        expect(label.textContent).toBe('Add');

        // The per-section one-off classes are gone on this button.
        expect(add.classList.contains('wg-food-day-nav__add')).toBe(false);
        expect(add.classList.contains('wg-food-day-nav__add-label')).toBe(false);
        // .wg-gloss / .wg-gloss--sun are no longer needed — primary fill
        // comes from .wg-toolbar-btn--primary itself.
        expect(add.classList.contains('wg-gloss')).toBe(false);
        expect(add.classList.contains('wg-gloss--sun')).toBe(false);
    });

    it('CSS: .wg-food-day-nav--with-action override appears AFTER .wg-food-day-nav base rule so the 4-column grid wins the cascade', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');

        const baseIdx = css.indexOf('\n.wg-food-day-nav {');
        const overrideIdx = css.indexOf('\n.wg-food-day-nav--with-action {');

        expect(baseIdx).toBeGreaterThan(0);
        expect(overrideIdx).toBeGreaterThan(0);
        // Regression guard: if someone moves the override above the base
        // rule again, the 4th grid column is lost and the Add button wraps
        // back onto a second row (the original defect #9 symptom).
        expect(overrideIdx).toBeGreaterThan(baseIdx);
    });

    it('CSS: .wg-food-day-nav--with-action declares a 5-column grid-template-columns (icon 1fr icon auto auto)', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        const openIdx = css.indexOf('\n.wg-food-day-nav--with-action {');
        expect(openIdx).toBeGreaterThan(0);
        const closeIdx = css.indexOf('}', openIdx);
        const rule = css.slice(openIdx, closeIdx);

        // Five columns: icon width, flexible center, icon width, auto (Add), auto (Photo).
        expect(rule).toMatch(/grid-template-columns\s*:[^;]*var\(--wg-food-day-nav-icon-size\)[^;]*1fr[^;]*var\(--wg-food-day-nav-icon-size\)[^;]*auto[^;]*auto/);
    });

    it('Photo button uses .wg-toolbar-btn + .wg-toolbar-btn--secondary and triggers the hidden file input', () => {
        const { document } = env;
        const photo = document.getElementById('add-food-photo-btn');
        expect(photo).not.toBeNull();
        expect(photo.classList.contains('wg-toolbar-btn')).toBe(true);
        expect(photo.classList.contains('wg-toolbar-btn--secondary')).toBe(true);

        const label = photo.querySelector('.wg-toolbar-btn__label');
        expect(label).not.toBeNull();
        expect(label.textContent).toBe('Photo');

        // The hidden file input lives outside the day-nav so it doesn't add a
        // grid item, but it must be present somewhere in the food view.
        const input = document.getElementById('food-photo-input');
        expect(input).not.toBeNull();
        expect(input.getAttribute('type')).toBe('file');
        expect(input.getAttribute('accept')).toBe('image/*');
        // The picker must offer both camera and gallery, so it MUST NOT
        // carry a `capture` attribute — otherwise mobile browsers force
        // straight into the camera and the user can't pick an existing
        // photo from their library.
        expect(input.hasAttribute('capture')).toBe(false);
    });

    it('CSS: the dead .wg-food-day-nav__add and __add-label rules are removed', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        // Rule openers specifically — matching `.wg-food-day-nav__add {`
        // and `.wg-food-day-nav__add-label {`. The shared
        // `.wg-toolbar-btn` + `.wg-toolbar-btn__label` carry the sizing
        // now; if the one-off classes come back, two stacks fight over
        // the same button.
        expect(css).not.toMatch(/\.wg-food-day-nav__add\s*\{/);
        expect(css).not.toMatch(/\.wg-food-day-nav__add-label\s*\{/);
    });

    it('clicking the inline Add still opens the food modal after the migration', () => {
        const { document, window } = env;
        let opened = 0;
        window.showAddFoodModal = () => { opened += 1; };
        const btn = document.getElementById('add-food-inline-btn');
        btn.click();
        expect(opened).toBe(1);
    });
});
