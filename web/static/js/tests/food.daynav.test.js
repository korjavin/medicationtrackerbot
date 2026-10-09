// Food day navigator (kit F1/F2, med-xso6.16).
//
// The navigator is the kit .wg-daynav: arrows in fixed 44px cells
// (.wg-daynav__arrow), a label button holding the relative-day chip and the
// date (.wg-daynav__date, which clips with an ellipsis), and the hidden
// <input type="date"> the label opens. Add is the app-bar primary, not part
// of the row.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function toISODateLocal(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

describe('Food day navigator (kit F1)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renders the kit .wg-daynav: arrow cells, a label with chip + date, and the hidden date input', () => {
        const { document } = env;
        const nav = document.querySelector('#food-view .wg-daynav');
        expect(nav).not.toBeNull();

        // Three grid cells only — the hidden input is absolutely positioned.
        const cells = Array.from(nav.children).filter((el) => el.tagName !== 'INPUT');
        expect(cells.map((el) => el.id)).toEqual(['food-date-prev-btn', 'food-date-label', 'food-date-next-btn']);

        const prev = document.getElementById('food-date-prev-btn');
        const next = document.getElementById('food-date-next-btn');
        for (const [btn, icon] of [[prev, 'chev-l'], [next, 'chev-r']]) {
            expect(btn.classList.contains('wg-daynav__arrow')).toBe(true);
            expect(btn.querySelector(`.wg-ico[data-icon="${icon}"]`)).not.toBeNull();
            expect(btn.getAttribute('style')).toBeNull();
        }

        const label = document.getElementById('food-date-label');
        expect(label.tagName).toBe('BUTTON');
        expect(label.classList.contains('wg-daynav__label')).toBe(true);
        const chip = document.getElementById('food-date-chip');
        expect(chip.classList.contains('wg-chip')).toBe(true);
        expect(label.contains(chip)).toBe(true);
        expect(document.getElementById('food-date-text').classList.contains('wg-daynav__date')).toBe(true);

        const input = document.getElementById('food-date-filter');
        expect(input.getAttribute('type')).toBe('date');
        expect(nav.contains(input)).toBe(true);
        expect(label.contains(input)).toBe(false);

        // The old pill row is gone: no Photo / Scan pills, no legacy classes.
        expect(document.querySelector('.wg-food-day-nav')).toBeNull();
        expect(document.getElementById('add-food-photo-btn')).toBeNull();
        expect(document.getElementById('scan-food-inline-btn')).toBeNull();
        expect(nav.querySelector('#add-food-inline-btn')).toBeNull();
    });

    it('Add is the single .wg-btn--primary in the Food app bar', () => {
        const { document, window } = env;
        const view = document.getElementById('food-view');
        const primaries = view.querySelectorAll('.wg-btn--primary');
        expect(primaries).toHaveLength(1);
        const add = document.getElementById('add-food-inline-btn');
        expect(primaries[0]).toBe(add);
        expect(add.closest('.wg-appbar')).not.toBeNull();
        expect(add.textContent).toContain('Add');

        let opened = 0;
        window.showAddFoodModal = () => { opened += 1; };
        add.click();
        expect(opened).toBe(1);
    });

    it('a ghost camera icon in the app bar keeps photo logging reachable on populated days', () => {
        const { document, window } = env;
        const photo = document.getElementById('food-photo-btn');
        expect(photo.closest('.wg-appbar')).not.toBeNull();
        expect(photo.classList.contains('wg-btn--ghost')).toBe(true);
        expect(photo.querySelector('.wg-ico[data-icon="camera"]')).not.toBeNull();

        let picked = 0;
        window.triggerFoodPhotoPicker = () => { picked += 1; };
        photo.click();
        expect(picked).toBe(1);
    });

    it('a relative day shows as a chip beside the short date', () => {
        const { document, window } = env;
        const filter = document.getElementById('food-date-filter');
        const chip = document.getElementById('food-date-chip');
        const text = document.getElementById('food-date-text');

        const today = new Date();
        filter.value = toISODateLocal(today);
        window.updateFoodDateNav();
        expect(chip.textContent).toBe('Today');
        expect(chip.classList.contains('hidden')).toBe(false);
        const ddmm = window.formatFoodDateSubtitle(filter.value).slice(0, 5);
        expect(text.textContent.endsWith(` ${ddmm}`)).toBe(true);

        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);
        filter.value = toISODateLocal(yesterday);
        window.updateFoodDateNav();
        expect(chip.textContent).toBe('Yesterday');
    });

    it('any other day hides the chip and spells out "<weekday> · DD.MM.YYYY"', () => {
        const { document, window } = env;
        const filter = document.getElementById('food-date-filter');
        filter.value = '2026-04-20';
        window.updateFoodDateNav();
        expect(document.getElementById('food-date-chip').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('food-date-text').textContent).toMatch(/^\S+ · 20\.04\.2026$/);
    });

    it('clicking the date label opens the hidden picker', () => {
        const { document } = env;
        const filter = document.getElementById('food-date-filter');
        let opened = 0;
        filter.showPicker = () => { opened += 1; };
        document.getElementById('food-date-label').click();
        expect(opened).toBe(1);
    });

    it('clicking the prev/next chevrons dispatches shiftFoodDate with the correct delta', () => {
        const { document, window } = env;
        // Stub loadFoodLogs to avoid triggering async API paths that outlive the test.
        window.loadFoodLogs = () => {};
        const filter = document.getElementById('food-date-filter');
        filter.value = '2026-04-20';

        const prev = document.getElementById('food-date-prev-btn');
        const next = document.getElementById('food-date-next-btn');

        prev.click();
        expect(filter.value).toBe('2026-04-19');

        next.click();
        expect(filter.value).toBe('2026-04-20');
    });

    it('does not render a Today jump-to-today button', () => {
        const { document } = env;
        expect(document.getElementById('food-today-btn')).toBeNull();
        expect(document.querySelector('.wg-food-day-nav__today-btn')).toBeNull();
        expect(document.querySelector('.food-today-chip')).toBeNull();
    });

    it('Day|Week pipe row is absent (Phase 5, Task 4)', () => {
        const { document } = env;
        expect(document.getElementById('food-stats-period-container')).toBeNull();
        expect(document.getElementById('food-period-day-link')).toBeNull();
        expect(document.getElementById('food-period-week-link')).toBeNull();
    });

    it('macros card exposes a Daily/Weekly toggle', () => {
        const { document } = env;
        const toggle = document.getElementById('food-macros-toggle');
        expect(toggle).not.toBeNull();
        expect(toggle.classList.contains('wg-seg')).toBe(true);
        const btns = toggle.querySelectorAll('.wg-seg__opt');
        expect(btns).toHaveLength(2);
        expect(btns[0].dataset.range).toBe('day');
        expect(btns[1].dataset.range).toBe('week');
    });

    // med-ejq.3 — the collapsible "Meals · Food DB" accordion is gone; Food DB
    // is a first-class pane behind a Log / Food DB pill strip, and the meal
    // surface is no longer reachable from the frontend at all.
    it('Log / Food DB sub-tab strip switches panes and drops the meal surface', () => {
        const { document, window } = env;
        expect(document.getElementById('food-library-toggle-btn')).toBeNull();
        expect(document.getElementById('food-library-view')).toBeNull();
        expect(document.getElementById('food-meals-tab')).toBeNull();
        expect(document.getElementById('food-save-meal-modal')).toBeNull();

        const strip = document.querySelector('#food-subtabs.wg-seg');
        expect(strip).not.toBeNull();
        const pills = strip.querySelectorAll('.food-tab');
        expect([...pills].map((b) => b.dataset.tab)).toEqual(['log', 'fooddb']);

        const logPane = document.getElementById('food-log-tab');
        const dbPane = document.getElementById('food-fooddb-tab');
        expect(logPane.classList.contains('active')).toBe(true);
        expect(dbPane.classList.contains('active')).toBe(false);

        // Stub the loader so the pane switch doesn't attempt a network call.
        let loads = 0;
        window.loadFoodDB = () => { loads += 1; };

        pills[1].click();
        expect(dbPane.classList.contains('active')).toBe(true);
        expect(logPane.classList.contains('active')).toBe(false);
        expect(pills[1].getAttribute('aria-pressed')).toBe('true');
        expect(loads).toBe(1);

        pills[0].click();
        expect(logPane.classList.contains('active')).toBe(true);
        expect(dbPane.classList.contains('active')).toBe(false);
        expect(pills[0].getAttribute('aria-pressed')).toBe('true');
        expect(pills[1].getAttribute('aria-pressed')).toBe('false');
    });

    // The day navigator belongs to the Log pane — a date picker hovering over
    // a date-less product list was the reason it moved inside (med-ejq.3).
    it('day navigator lives inside the Log pane', () => {
        const { document } = env;
        const nav = document.querySelector('#food-view .wg-daynav');
        expect(nav).not.toBeNull();
        expect(document.getElementById('food-log-tab').contains(nav)).toBe(true);
    });

    it('#food-view opts into the shared .wg-screen-stage backdrop', () => {
        const { document } = env;
        const view = document.getElementById('food-view');
        expect(view).not.toBeNull();
        expect(view.classList.contains('wg-screen-stage')).toBe(true);
    });

    it('Food view no longer mounts a section header', () => {
        const { document } = env;
        const mount = document
            .getElementById('food-view')
            .querySelector('.section-header-mount');
        expect(mount).toBeNull();
    });

    it('formatFoodDateSubtitle returns DD.MM.YYYY for ISO input and empty string for blank', () => {
        const { window } = env;
        expect(window.formatFoodDateSubtitle('2026-04-20')).toBe('20.04.2026');
        expect(window.formatFoodDateSubtitle('2026-12-01')).toBe('01.12.2026');
        expect(window.formatFoodDateSubtitle('')).toBe('');
    it('updateFoodDateNav disables next when the selected date is today or future', () => {
        const { document, window } = env;
        const filter = document.getElementById('food-date-filter');
        const nextBtn = document.getElementById('food-date-next-btn');

        const today = new Date();
        filter.value = toISODateLocal(today);
        window.updateFoodDateNav();
        expect(nextBtn.disabled).toBe(true);

        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);
        filter.value = toISODateLocal(yesterday);
        window.updateFoodDateNav();
        expect(nextBtn.disabled).toBe(false);
    });

    it('setFoodMacrosRange("week") makes shiftFoodDate step by 7 days', () => {
        const { document, window } = env;
        window.loadFoodLogs = () => {};
        const filter = document.getElementById('food-date-filter');
        filter.value = '2026-03-01';

        window.setFoodMacrosRange('week');
        window.shiftFoodDate(1);
        expect(filter.value).toBe('2026-03-08');

        window.setFoodMacrosRange('day');
        window.shiftFoodDate(-1);
        expect(filter.value).toBe('2026-03-07');
    });
});
});

// med-xso6.33 / kit F2: a long absolute date can't push › — the label is the
// minmax(0,1fr) cell between two fixed arrow cells and the date clips.
describe('Food day navigator layout (kit F1/F2)', () => {
    const css = fs.readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../css/components.css'), 'utf8');
    const rule = (sel) => (css.match(new RegExp(`\\${sel}\\{([^}]*)\\}`)) || [])[1] || '';

    it('.wg-daynav gives the arrows fixed cells around a shrinkable centre', () => {
        expect(rule('.wg-daynav')).toMatch(/grid-template-columns:var\(--wg-h-md\) minmax\(0,1fr\) var\(--wg-h-md\)/);
    });

    it('.wg-daynav__date clips with an ellipsis', () => {
        const date = rule('.wg-daynav__date');
        expect(date).toMatch(/overflow:hidden/);
        expect(date).toMatch(/text-overflow:ellipsis/);
        expect(date).toMatch(/white-space:nowrap/);
    });

    it('the Yesterday-overlap stopgap went with the old row', () => {
        const styles = fs.readFileSync(
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../css/styles.css'), 'utf8');
        expect(styles).not.toMatch(/\.wg-food-day-nav__(title|subtitle)\s*\{/);
    });
});
