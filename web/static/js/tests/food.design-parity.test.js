// Food log layout parity with the kit (F1–F3, med-xso6.16).
//
//   1. One primary: Add sits in the app bar; no sticky CTA dock, no Add /
//      Photo / Scan pills in the day row, and the list never synthesizes a
//      second Add button.
//   2. Order: day navigator → macros card (with the "Tracking incomplete"
//      toggle row) → meal list, all inside the Log pane.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const GROUPS = [{
    name: 'Breakfast',
    time: '08:00',
    calories: 300,
    carbs: 40,
    protein: 15,
    fat: 8,
    logs: [{
        id: 1,
        name: 'Oatmeal',
        weight: 200,
        calories: 300,
        carbs: 40,
        protein: 15,
        fat: 8,
        eaten_at: '2026-04-20T08:00:00Z',
    }],
}];

describe('Food log kit parity (F1–F3)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('index.html mounts no CTA dock and no legacy toolbar pills in #food-view', () => {
        const { document } = env;
        const view = document.getElementById('food-view');
        expect(view.querySelector('#food-add-cta-dock')).toBeNull();
        expect(document.querySelector('.wg-food-cta-dock')).toBeNull();
        expect(view.querySelector('.wg-toolbar-btn')).toBeNull();
    });

    it('a populated or empty day never adds a second Add-food button', () => {
        const { document, window } = env;
        for (const groups of [GROUPS, []]) {
            window._renderFoodData(groups, null, 'day', '2026-04-20');
            const ids = Array.from(document.querySelectorAll('#food-view [id^="add-food"]')).map((el) => el.id);
            expect(ids).toEqual(['add-food-inline-btn']);
            expect(document.querySelectorAll('#food-view .wg-btn--primary')).toHaveLength(1);
        }
    });

    it('day navigator → macros card → meal list, in the Log pane', () => {
        const { document, window } = env;
        const tab = document.getElementById('food-log-tab');
        const nav = tab.querySelector('.wg-daynav');
        const macros = document.getElementById('food-macros-card');
        const list = document.getElementById('food-list');
        expect(tab.contains(macros)).toBe(true);
        expect(nav.compareDocumentPosition(macros) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(macros.compareDocumentPosition(list) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        // The incomplete toggle closes the macros card it affects.
        const toggle = document.getElementById('food-incomplete-toggle');
        expect(macros.contains(toggle)).toBe(true);
        expect(toggle.closest('.wg-card__foot')).not.toBeNull();
    });

    it('the duplicate #food-target-progress rows are gone', () => {
        const { document, window } = env;
        window._renderFoodData(GROUPS, null, 'day', '2026-04-20');
        expect(document.getElementById('food-target-progress')).toBeNull();
        expect(document.querySelector('.food-target-row')).toBeNull();
    });
});
