import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const WG_ICONS_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-icons.js');
const WG_SPARKLINE_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-sparkline.js');
const JOURNEY_JS = path.join(REPO_ROOT, 'web/static/js/features/journey.js');

function loadEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="journey-content"></div></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(fs.readFileSync(WG_ICONS_JS, 'utf8'));
    window.eval(fs.readFileSync(WG_SPARKLINE_JS, 'utf8'));
    window.eval(fs.readFileSync(JOURNEY_JS, 'utf8'));
    return { window, document: window.document, cleanup: () => dom.window.close() };
}

function journey(overrides) {
    return {
        enabled: true,
        level: 7, lifetime_hp: 4820,
        hp_into_level: 320, level_span_hp: 800, hp_to_next_level: 480,
        current_streak: 12, longest_streak: 21, freezes: 2,
        today_hp: 95,
        today_rings: [
            { ring: 'adherence', hp: 40, closed: true },
            { ring: 'movement', hp: 25, closed: true },
            { ring: 'vitals', hp: 15, closed: true },
            { ring: 'nourishment', hp: 10, closed: false },
            { ring: 'mind', hp: 5, closed: false }
        ],
        period_rings: [],
        unlocked_tiers: [1, 2],
        level_curve: [{ level: 1, hp_to_reach: 0 }],
        hp_history: [{ day_unix: 1750982400, hp: 110 }, { day_unix: 1751068800, hp: 95 }],
        ...overrides
    };
}

describe('Journey render', () => {
    let env;
    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env.cleanup(); });

    it('rings card frames the day as a goal: N of 5 closed + why-line + per-ring how/check', () => {
        env.window.Gamification.render(journey());
        const { document } = env;

        const label = document.querySelector('.wg-journey-rings .wg-section-label');
        expect(label.textContent).toContain('3 OF 5 CLOSED');
        expect(document.querySelector('.wg-journey-rings__why').textContent).toMatch(/one per area/i);

        // 3 closed rings → 3 checks.
        expect(document.querySelectorAll('.wg-journey-ring__check').length).toBe(3);

        // Rows follow canonical order: adherence(closed), …, nourishment(open).
        const subs = document.querySelectorAll('.wg-journey-ring__sub');
        expect(subs[0].textContent).toBe('Closed for today');      // adherence
        expect(subs[3].textContent).toBe('Log a meal');            // nourishment (open)
    });

    it('renders the previously-discarded hp_history as a sparkline + summed caption', () => {
        env.window.Gamification.render(journey());
        const { document } = env;

        const card = document.querySelector('.wg-journey-history');
        expect(card).not.toBeNull();
        expect(card.querySelector('.wg-sparkline')).not.toBeNull();
        const caption = card.querySelector('.wg-journey-history__caption').textContent;
        expect(caption).toContain('Last 2 days');
        expect(caption).toContain('205 HP'); // 110 + 95
    });

    it('omits the history card entirely when no points have been earned', () => {
        env.window.Gamification.render(journey({ hp_history: [] }));
        expect(env.document.querySelector('.wg-journey-history')).toBeNull();
    });
});
