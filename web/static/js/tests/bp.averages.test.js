// Wandergeek BP averages render tests (Phase 3, Task 4).
//
// Covers renderBPAverages(stats): a 3-up grid of .wg-bp-average-card tiles
// (14d / 30d / 60d). Each tile has a .wg-section-label kicker, a
// .wg-mono-display value, and an "mmHg" unit suffix. Values are formatted
// to 0 decimals; missing periods collapse to "—" without removing the tile
// so the grid layout remains stable.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('renderBPAverages (Phase 3, Task 4)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('renders three .wg-bp-average-card tiles for 14d / 30d / 60d', () => {
        const { document, window } = env;
        window.renderBPAverages({
            stats_14: { days: 14, readings: 20, systolic: 121, diastolic: 79 },
            stats_30: { days: 28, readings: 44, systolic: 123, diastolic: 80 },
            stats_60: { days: 55, readings: 88, systolic: 125, diastolic: 81 }
        });

        const container = document.getElementById('bp-averages');
        expect(container.classList.contains('wg-bp-averages')).toBe(true);

        const cards = container.querySelectorAll('.wg-bp-average-card');
        expect(cards.length).toBe(3);
        expect(Array.from(cards).map((c) => c.getAttribute('data-period'))).toEqual(['14', '30', '60']);

        cards.forEach((card) => {
            expect(card.classList.contains('wg-card')).toBe(true);
            expect(card.querySelector('.wg-section-label')).not.toBeNull();
            expect(card.querySelector('.wg-mono-display')).not.toBeNull();
            expect(card.querySelector('.wg-bp-average-card__unit').textContent).toBe('mmHg');
        });
    });

    it('formats sys/dia values to 0 decimals', () => {
        const { document, window } = env;
        window.renderBPAverages({
            stats_14: { days: 14, readings: 10, systolic: 121.6, diastolic: 78.4 },
            stats_30: { days: 28, readings: 30, systolic: 122.2, diastolic: 79.9 },
            stats_60: { days: 55, readings: 55, systolic: 124, diastolic: 80 }
        });

        const values = document.querySelectorAll('#bp-averages .wg-bp-average-card__value');
        expect(values[0].textContent).toBe('122/78');
        expect(values[1].textContent).toBe('122/80');
        expect(values[2].textContent).toBe('124/80');
    });

    it('falls back to "\u2014" for missing periods but keeps the tile rendered', () => {
        const { document, window } = env;
        window.renderBPAverages({
            stats_14: { days: 12, readings: 18, systolic: 121, diastolic: 79 }
            // stats_30 and stats_60 missing
        });

        const cards = document.querySelectorAll('#bp-averages .wg-bp-average-card');
        expect(cards.length).toBe(3);

        const values = document.querySelectorAll('#bp-averages .wg-bp-average-card__value');
        expect(values[0].textContent).toBe('121/79');
        expect(values[1].textContent).toBe('\u2014');
        expect(values[2].textContent).toBe('\u2014');

        // The empty tiles carry the dimmed-value modifier so CSS can soften them.
        expect(values[1].classList.contains('wg-bp-average-card__value--empty')).toBe(true);
        expect(values[2].classList.contains('wg-bp-average-card__value--empty')).toBe(true);
    });

    it('renders all three tiles empty when stats is null', () => {
        const { document, window } = env;
        window.renderBPAverages(null);

        const cards = document.querySelectorAll('#bp-averages .wg-bp-average-card');
        expect(cards.length).toBe(3);
        const values = document.querySelectorAll('#bp-averages .wg-bp-average-card__value');
        values.forEach((v) => expect(v.textContent).toBe('\u2014'));
    });

    it('shows a readings-count meta line when the period has readings', () => {
        const { document, window } = env;
        window.renderBPAverages({
            stats_14: { days: 14, readings: 20, systolic: 121, diastolic: 79 },
            stats_30: { days: 28, readings: 1, systolic: 122, diastolic: 80 },
            stats_60: { days: 55, readings: 0, systolic: 0, diastolic: 0 }
        });

        const metas14 = document.querySelector('#bp-averages .wg-bp-average-card[data-period="14"] .wg-bp-average-card__meta');
        expect(metas14.textContent).toBe('20 readings');

        const metas30 = document.querySelector('#bp-averages .wg-bp-average-card[data-period="30"] .wg-bp-average-card__meta');
        expect(metas30.textContent).toBe('1 reading');

        // readings=0 suppresses the meta line.
        const metas60 = document.querySelector('#bp-averages .wg-bp-average-card[data-period="60"] .wg-bp-average-card__meta');
        expect(metas60).toBeNull();
    });
});
