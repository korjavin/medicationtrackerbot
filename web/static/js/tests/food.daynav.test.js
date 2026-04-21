// Wandergeek Food day-navigator (Phase 4, Task 3).
//
// Asserts the rewritten day-nav renders as a three-cell row — chevron
// button, mono-display title + subtitle, chevron button — and that the
// chevron buttons, today-chip, and date-label click handler still hook
// into the existing `shiftFoodDate` / `goFoodToday` callbacks.

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

    it('renders the 3-cell grid with chevron icon buttons and mono title/subtitle', () => {
        const { document } = env;

        const nav = document.querySelector('.wg-food-day-nav');
        expect(nav).not.toBeNull();

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

    it('clicking the today chip resets the date and hides the chip', () => {
        const { document, window } = env;
        window.loadFoodLogs = () => {};
        const filter = document.getElementById('food-date-filter');
        const todayChip = document.getElementById('food-today-btn');

        filter.value = '2026-04-18';
        window.updateFoodDateNav();
        expect(todayChip.classList.contains('hidden')).toBe(false);

        todayChip.click();
        const today = new Date();
        expect(filter.value).toBe(toISODateLocal(today));
        expect(todayChip.classList.contains('hidden')).toBe(true);
    });

    it('formatFoodDateSubtitle returns DD.MM.YYYY for ISO input and empty string for blank', () => {
        const { window } = env;
        expect(window.formatFoodDateSubtitle('2026-04-20')).toBe('20.04.2026');
        expect(window.formatFoodDateSubtitle('2026-12-01')).toBe('01.12.2026');
        expect(window.formatFoodDateSubtitle('')).toBe('');
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
});
