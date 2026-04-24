// Wandergeek Food day-navigator (Phase 4, Task 3).
//
// Asserts the rewritten day-nav renders as a three-cell row — chevron
// button, mono-display title + subtitle, chevron button — and that the
// chevron buttons and date-label click handler hook into the existing
// `shiftFoodDate` callback.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function toISODateLocal(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

describe('Food day-navigator (Phase 4, Task 3)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renders the 4-cell grid with chevron icon buttons, mono title/subtitle, and inline +Add', () => {
        const { document } = env;

        const nav = document.querySelector('.wg-food-day-nav');
        expect(nav).not.toBeNull();
        expect(nav.classList.contains('wg-food-day-nav--with-action')).toBe(true);

        const prev = document.getElementById('food-date-prev-btn');
        const next = document.getElementById('food-date-next-btn');
        expect(prev).not.toBeNull();
        expect(next).not.toBeNull();
        expect(prev.classList.contains('wg-icon-btn')).toBe(true);
        expect(prev.classList.contains('wg-gloss')).toBe(true);
        expect(prev.classList.contains('wg-food-day-nav__icon-btn')).toBe(true);
        expect(next.classList.contains('wg-icon-btn')).toBe(true);
        expect(next.classList.contains('wg-gloss')).toBe(true);

        // Chevron SVGs rendered via WGIcons, not inline <svg> strings.
        const prevIcon = prev.querySelector('svg[data-wg-icon="chevronLeft"]');
        const nextIcon = next.querySelector('svg[data-wg-icon="chevronRight"]');
        expect(prevIcon).not.toBeNull();
        expect(nextIcon).not.toBeNull();

        const title = document.getElementById('food-date-label');
        const subtitle = document.getElementById('food-date-subtitle');
        expect(title).not.toBeNull();
        expect(subtitle).not.toBeNull();
        expect(title.classList.contains('wg-mono-display')).toBe(true);
        expect(title.classList.contains('wg-food-day-nav__title')).toBe(true);
        expect(subtitle.classList.contains('wg-section-label')).toBe(true);
        expect(subtitle.classList.contains('wg-food-day-nav__subtitle')).toBe(true);

        // Phase 5, Task 4 — inline +Add sun-gloss button lives inside the
        // day-nav row and opens the food modal directly.
        const addBtn = document.getElementById('add-food-inline-btn');
        expect(addBtn).not.toBeNull();
        expect(addBtn.classList.contains('wg-gloss')).toBe(true);
        expect(addBtn.classList.contains('wg-gloss--sun')).toBe(true);
        expect(addBtn.classList.contains('wg-food-day-nav__add')).toBe(true);
    });

    it('updateFoodDateNav populates both title and DD.MM.YYYY subtitle', () => {
        const { document, window } = env;
        const filter = document.getElementById('food-date-filter');
        const title = document.getElementById('food-date-label');
        const subtitle = document.getElementById('food-date-subtitle');

        const today = new Date();
        filter.value = toISODateLocal(today);
        window.updateFoodDateNav();
        expect(title.textContent).toBe('Today');

        filter.value = '2026-04-20';
        window.updateFoodDateNav();
        expect(subtitle.textContent).toBe('20.04.2026');
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

    it('outer subtab strip and Day|Week pipe row are absent (Phase 5, Task 4)', () => {
        const { document } = env;
        expect(document.querySelector('.wg-food-subtabs')).toBeNull();
        expect(document.getElementById('food-stats-period-container')).toBeNull();
        expect(document.getElementById('food-period-day-link')).toBeNull();
        expect(document.getElementById('food-period-week-link')).toBeNull();
    });

    it('macros card exposes a Daily/Weekly toggle', () => {
        const { document } = env;
        const toggle = document.getElementById('food-macros-toggle');
        expect(toggle).not.toBeNull();
        expect(toggle.classList.contains('wg-gloss--inset')).toBe(true);
        const btns = toggle.querySelectorAll('.wg-food-macros-card__toggle-btn');
        expect(btns).toHaveLength(2);
        expect(btns[0].dataset.range).toBe('day');
        expect(btns[1].dataset.range).toBe('week');
    });

    it('Meals · Food DB library entry toggles the library panel', () => {
        const { document, window } = env;
        const btn = document.getElementById('food-library-toggle-btn');
        const view = document.getElementById('food-library-view');
        expect(btn).not.toBeNull();
        expect(view).not.toBeNull();
        expect(view.classList.contains('hidden')).toBe(true);

        // Stub loaders so the toggle click doesn't attempt network calls.
        window.loadMyMeals = () => {};
        window.loadFoodDB = () => {};

        btn.click();
        expect(view.classList.contains('hidden')).toBe(false);
        btn.click();
        expect(view.classList.contains('hidden')).toBe(true);
    });

    it('clicking the inline +Add button opens the food modal', () => {
        const { document, window } = env;
        let opened = 0;
        window.showAddFoodModal = () => { opened += 1; };
        const btn = document.getElementById('add-food-inline-btn');
        btn.click();
        expect(opened).toBe(1);
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
    });

    it('chevron buttons carry the WG color-bearing classes and inherit currentColor via the SVG stroke', () => {
        const { document } = env;
        const prev = document.getElementById('food-date-prev-btn');
        const next = document.getElementById('food-date-next-btn');

        // Both buttons must carry the color-bearing wg-food-day-nav__icon-btn
        // class so they pick up the explicit color/background tokens on the
        // Wandergeek stage backdrop.
        expect(prev.classList.contains('wg-food-day-nav__icon-btn')).toBe(true);
        expect(next.classList.contains('wg-food-day-nav__icon-btn')).toBe(true);

        // Chevron SVGs must inherit the button's foreground via currentColor,
        // not a hard-coded color literal.
        const prevIcon = prev.querySelector('svg[data-wg-icon="chevronLeft"]');
        const nextIcon = next.querySelector('svg[data-wg-icon="chevronRight"]');
        expect(prevIcon).not.toBeNull();
        expect(nextIcon).not.toBeNull();
        expect(prevIcon.getAttribute('stroke')).toBe('currentColor');
        expect(nextIcon.getAttribute('stroke')).toBe('currentColor');

        // No inline style smuggling a color onto the buttons or icons.
        expect(prev.getAttribute('style')).toBeNull();
        expect(next.getAttribute('style')).toBeNull();
    });

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
