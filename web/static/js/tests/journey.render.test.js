import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const WG_ICONS_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-icons.js');
const WG_SPARKLINE_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-sparkline.js');
const WG_RING_STACK_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-ring-stack.js');
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
    window.eval(fs.readFileSync(WG_RING_STACK_JS, 'utf8'));
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
            { ring: 'bedtime', hp: 40, closed: true },
            { ring: 'movement', hp: 25, closed: true },
            { ring: 'nourishment', hp: 10, closed: false }
        ],
        period_rings: [],
        unlocked_tiers: [1, 2],
        level_curve: [{ level: 1, hp_to_reach: 0 }],
        hp_history: [{ day_unix: 1750982400, hp: 110 }, { day_unix: 1751068800, hp: 95 }],
        health_score: {
            value: 82,
            contributors: [
                { key: 'bp', label: 'Blood pressure', score: 0.95, weight: 1, missing: false },
                { key: 'sleep', label: 'Sleep', score: 0.7, weight: 1, missing: false }
            ],
            missing: []
        },
        strengths: [
            { key: 'meds', label: 'Medication', value: 0.92, frequency: 1 },
            { key: 'movement', label: 'Movement', value: 0.5, frequency: 3 / 7 },
            { key: 'measurement', label: 'Measurement', value: 0.4, frequency: 1 }
        ],
        ...overrides
    };
}

describe('Journey render', () => {
    let env;
    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env.cleanup(); });

    it('rings card frames the day as a goal: N of 3 closed + why-line + per-ring how/check', () => {
        env.window.Gamification.render(journey());
        const { document } = env;

        const label = document.querySelector('.wg-journey-rings .wg-section-label');
        expect(label.textContent).toContain('2 OF 3 CLOSED');
        expect(document.querySelector('.wg-journey-rings__why').textContent).toMatch(/one per area/i);

        // 2 closed rings → 2 checks.
        expect(document.querySelectorAll('.wg-journey-ring__check').length).toBe(2);
        // Open actionable rings remain → stack center shows the "2/3" count.
        expect(document.querySelector('.wg-ring-stack__center').textContent).toBe('2/3');

        // Rows follow canonical order: bedtime(closed), movement(closed), nourishment(open).
        const subs = document.querySelectorAll('.wg-journey-ring__sub');
        expect(subs[0].textContent).toBe('Closed for today');      // bedtime
        expect(subs[2].textContent).toBe('Log a meal');            // nourishment (open)
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

    // Sync-pending rings (Plan 6, Task 3): a device-synced ring (Bedtime/Movement)
    // with no sample yet reads as "waiting", not "failed" — dimmed row + a
    // "Syncs later" sub-line instead of the usual open-ring "how" text.
    it('sync-pending ring renders dimmed with a "Syncs later" sub-line', () => {
        env.window.Gamification.render(journey({
            today_rings: [
                { ring: 'bedtime', hp: 0, closed: false, sync_pending: true },
                { ring: 'movement', hp: 25, closed: true },
                { ring: 'nourishment', hp: 10, closed: false }
            ]
        }));
        const { document } = env;

        const rows = document.querySelectorAll('.wg-journey-ring');
        const bedtimeRow = Array.from(rows).find((r) => r.querySelector('.wg-journey-ring__label').textContent === 'Bedtime');
        expect(bedtimeRow.classList.contains('wg-journey-ring--sync-pending')).toBe(true);
        expect(bedtimeRow.querySelector('.wg-journey-ring__sub').textContent).toBe('Syncs later');
        // Nourishment is still open/actionable here, so a lone sync-pending ring
        // must NOT prematurely flip the center to a celebration check.
        expect(document.querySelector('.wg-ring-stack__center').textContent).toBe('1/3');
    });

    // Finding 2 (Plan 7, Task 1): the center check appears once every
    // *actionable* ring is closed — a ring still waiting on a device sample
    // doesn't block celebration.
    it('all actionable rings closed with one sync-pending → center celebrates with a check', () => {
        env.window.Gamification.render(journey({
            today_rings: [
                { ring: 'bedtime', hp: 0, closed: false, sync_pending: true },
                { ring: 'movement', hp: 25, closed: true },
                { ring: 'nourishment', hp: 10, closed: true }
            ]
        }));
        const center = env.document.querySelector('.wg-ring-stack__center');
        expect(center).not.toBeNull();
        expect(center.querySelector('svg')).not.toBeNull();
        expect(center.textContent).not.toMatch(/\d/);
    });

    // Insight ladder tier 2 (Plan 6, Task 4): "Trend charts" now has a real
    // destination — the Vitals section's existing trend charts — instead of
    // an evergreen "soon". Tier 4 has no built screen yet and must keep
    // reading "soon" even though the fixture marks it unlocked.
    it('tier 2 (trend charts) links to Vitals when unlocked; tier 4 stays "soon"', () => {
        let switchedTo = null;
        env.window.switchTab = (tab) => { switchedTo = tab; };
        env.window.Gamification.render(journey({ unlocked_tiers: [1, 2, 3, 4] }));
        const { document } = env;

        const rows = document.querySelectorAll('.wg-journey-ladder__row');
        const titleOf = (row) => row.querySelector('.wg-journey-ladder__title').textContent;
        const statusOf = (row) => row.querySelector('.wg-journey-ladder__status').textContent;

        const trendRow = Array.from(rows).find((r) => titleOf(r) === 'Trend charts');
        expect(statusOf(trendRow)).toBe('Unlocked → view');
        expect(trendRow.classList.contains('wg-journey-ladder__row--linked')).toBe(true);
        trendRow.click();
        expect(switchedTo).toBe('health');

        const goodDayRow = Array.from(rows).find((r) => titleOf(r) === 'Your good-day model');
        expect(statusOf(goodDayRow)).toMatch(/soon/);
        expect(goodDayRow.classList.contains('wg-journey-ladder__row--locked')).toBe(true);
    });

    // Insight ladder tier 3 (Plan 9, Task 3): "Correlations" now has a real
    // destination too — the sleep→BP insight card — once the fetched
    // `journey.insight` is attached (load() does this; render() tests attach
    // it directly). Below tier 3, or with no insight fetched yet, there's
    // nothing to scroll to and the row stays locked/soon.
    it('tier 3 (correlations) links to the insight card when unlocked and insight data is present', () => {
        env.window.Gamification.render(journey({
            unlocked_tiers: [1, 2, 3],
            insight: { sleep_bp: { status: 'effect', short_threshold_hours: 7, delta_systolic: 8, n_short: 23, n_in_band: 40 } }
        }));
        const { document } = env;

        const rows = document.querySelectorAll('.wg-journey-ladder__row');
        const titleOf = (row) => row.querySelector('.wg-journey-ladder__title').textContent;
        const statusOf = (row) => row.querySelector('.wg-journey-ladder__status').textContent;
        const correlationsRow = Array.from(rows).find((r) => titleOf(r) === 'Correlations');

        expect(statusOf(correlationsRow)).toBe('Unlocked → view');
        expect(correlationsRow.classList.contains('wg-journey-ladder__row--linked')).toBe(true);

        const scrollIntoView = vi.fn();
        document.getElementById('journey-insight-card').scrollIntoView = scrollIntoView;
        correlationsRow.click();
        expect(scrollIntoView).toHaveBeenCalled();
    });

    it('tier 3 stays locked/"soon" below unlock even with insight data present', () => {
        env.window.Gamification.render(journey({
            unlocked_tiers: [1, 2],
            insight: { sleep_bp: { status: 'effect', short_threshold_hours: 7, delta_systolic: 8, n_short: 23, n_in_band: 40 } }
        }));
        const { document } = env;
        const rows = document.querySelectorAll('.wg-journey-ladder__row');
        const titleOf = (row) => row.querySelector('.wg-journey-ladder__title').textContent;
        const statusOf = (row) => row.querySelector('.wg-journey-ladder__status').textContent;
        const correlationsRow = Array.from(rows).find((r) => titleOf(r) === 'Correlations');

        expect(statusOf(correlationsRow)).toMatch(/soon/);
        expect(document.getElementById('journey-insight-card')).toBeNull();
    });

    // Sleep→BP insight card (Task 3): all three honesty-gate states render as
    // plain-language copy, plus the omitted-until-loaded case.
    it('insight card renders the "effect" state in plain language', () => {
        env.window.Gamification.render(journey({
            unlocked_tiers: [1, 2, 3],
            insight: { sleep_bp: { status: 'effect', short_threshold_hours: 7, delta_systolic: 8, n_short: 23, n_in_band: 40 } }
        }));
        const card = env.document.getElementById('journey-insight-card');
        expect(card).not.toBeNull();
        expect(card.querySelector('.wg-journey-insight__body').textContent)
            .toBe('Nights under 7h → next-morning systolic ~+8 mmHg · 23 nights');
    });

    it('insight card renders the "no_effect" state as its own honest finding', () => {
        env.window.Gamification.render(journey({
            unlocked_tiers: [1, 2, 3],
            insight: { sleep_bp: { status: 'no_effect', short_threshold_hours: 7, delta_systolic: 1, n_short: 12, n_in_band: 30 } }
        }));
        const card = env.document.getElementById('journey-insight-card');
        expect(card.querySelector('.wg-journey-insight__body').textContent).toMatch(/steady regardless of sleep/i);
    });

    it('insight card renders the "insufficient_data" state with the paired-night count', () => {
        env.window.Gamification.render(journey({
            unlocked_tiers: [1, 2, 3],
            insight: { sleep_bp: { status: 'insufficient_data', short_threshold_hours: 7, n_short: 5, n_in_band: 9, needed: 8 } }
        }));
        const card = env.document.getElementById('journey-insight-card');
        expect(card.querySelector('.wg-journey-insight__body').textContent).toBe('Not enough paired nights yet · 5 of 8 — keep logging');
    });

    it('insight card renders the offline-empty state when the fetch had no cache', () => {
        env.window.Gamification.render(journey({
            unlocked_tiers: [1, 2, 3],
            insight: { emptyState: 'No cached insight — connect to load.' }
        }));
        const card = env.document.getElementById('journey-insight-card');
        expect(card.querySelector('.wg-journey-insight__body').textContent).toBe('No cached insight — connect to load.');
    });

    it('insight card is omitted when tier 3 is unlocked but insight has not loaded yet', () => {
        env.window.Gamification.render(journey({ unlocked_tiers: [1, 2, 3] }));
        expect(env.document.getElementById('journey-insight-card')).toBeNull();
    });

    // Health Score card (Task 8): big number + band word, then one mini-bar
    // per named contributor — a missing contributor reads "No data", never a
    // misleading 0%.
    it('Health Score card shows the composite, a band tag, and per-contributor bars including a missing one', () => {
        env.window.Gamification.render(journey({
            health_score: {
                value: 78.4,
                contributors: [
                    { key: 'bp', label: 'Blood pressure', score: 0.9, weight: 1, missing: false },
                    { key: 'sleep', label: 'Sleep', score: 0, weight: 1, missing: true }
                ],
                missing: ['sleep']
            }
        }));
        const { document } = env;

        const card = document.querySelector('.wg-journey-score');
        expect(card).not.toBeNull();
        expect(card.querySelector('.wg-journey-score__value').textContent).toBe('78');
        expect(card.querySelector('.wg-tag').textContent).toBe('Good');

        const rows = card.querySelectorAll('.wg-journey-score__row');
        expect(rows.length).toBe(2);
        expect(rows[0].querySelector('.wg-journey-score__row-label').textContent).toBe('Blood pressure');
        expect(rows[0].querySelector('.wg-journey-score__row-value').textContent).toBe('90%');
        expect(rows[1].querySelector('.wg-journey-score__row-label').textContent).toBe('Sleep');
        expect(rows[1].querySelector('.wg-journey-score__row-value').textContent).toBe('No data');
    });

    it('Health Score renders "not enough data" instead of a misleading number below the min-contributors floor', () => {
        env.window.Gamification.render(journey({ health_score: { value: null, contributors: [], missing: [] } }));
        const card = env.document.querySelector('.wg-journey-score');
        expect(card.querySelector('.wg-journey-score__value').textContent).toBe('—');
        expect(card.textContent).toMatch(/not enough data/i);
    });

    // Strengths card (Task 8): replaces the weekly streak card — one
    // habit-strength EMA gauge per pillar, derived streak demoted to a
    // footnote line.
    it('Strengths card renders one gauge per pillar and demotes the streak to a footnote, replacing the streak card', () => {
        env.window.Gamification.render(journey({
            strengths: [
                { key: 'meds', label: 'Medication', value: 0.92, frequency: 1 },
                { key: 'movement', label: 'Movement', value: 0.5, frequency: 3 / 7 },
                { key: 'measurement', label: 'Measurement', value: 0.1, frequency: 1 }
            ]
        }));
        const { document } = env;

        expect(document.querySelector('.wg-journey-streak')).toBeNull();

        const card = document.querySelector('.wg-journey-strengths');
        expect(card).not.toBeNull();
        const rows = card.querySelectorAll('.wg-journey-strength');
        expect(rows.length).toBe(3);
        expect(rows[0].querySelector('.wg-journey-strength__label').textContent).toBe('Medication');
        expect(rows[0].querySelector('.wg-journey-strength__value').textContent).toBe('92%');

        const footnote = card.querySelector('.wg-journey-strengths__footnote').textContent;
        expect(footnote).toContain('12-week streak');
        expect(footnote).toContain('best 21');
    });

    // Gauges panel (gamification-11 §Task4): weight/BP/resting-HR read as
    // trends, sourced from `journey.gauges` (attached by load() from its own
    // fetch, same pattern as the tier-3 insight). Omitted entirely until
    // `gauges` has loaded — render() tests attach it directly.
    it('omits the Gauges card until journey.gauges has loaded', () => {
        env.window.Gamification.render(journey());
        expect(env.document.querySelector('.wg-journey-gauges')).toBeNull();
    });

    it('Gauges card renders weight velocity/pace/acceleration, BP share vs baseline, and resting HR vs baseline', () => {
        env.window.Gamification.render(journey({
            gauges: {
                enabled: true,
                weight: {
                    status: 'ok', trend_weight: 81.4, velocity_pct_per_week: -0.4,
                    pace_status: 'on_pace', acceleration: 'holding',
                    trend_history: [82.1, 82.0, 81.9, 81.7, 81.4]
                },
                bp: { status: 'ok', share_14d: 0.83, share_30d: 0.82, baseline_share_60d: 0.76, count_14d: 12, count_30d: 26, count_60d: 51 },
                resting_hr: { status: 'ok', recent_14d_mean: 62, baseline_60d_mean: 65, delta_from_baseline: -3 }
            }
        }));
        const { document } = env;

        const card = document.querySelector('.wg-journey-gauges');
        expect(card).not.toBeNull();

        const rows = card.querySelectorAll('.wg-journey-gauge');
        expect(rows.length).toBe(3);
        expect(rows[0].querySelector('.wg-journey-gauge__label').textContent).toBe('Weight');
        expect(rows[0].querySelector('.wg-journey-gauge__caption').textContent).toBe('-0.4%/week · on pace · holding steady');
        expect(rows[0].querySelector('.wg-sparkline')).not.toBeNull();

        expect(rows[1].querySelector('.wg-journey-gauge__label').textContent).toBe('Blood pressure');
        expect(rows[1].querySelector('.wg-journey-gauge__caption').textContent).toBe('In range 82% of last 30 days · baseline 76%');

        expect(rows[2].querySelector('.wg-journey-gauge__label').textContent).toBe('Resting heart rate');
        expect(rows[2].querySelector('.wg-journey-gauge__caption').textContent).toBe('62 avg · 3 below your baseline');

        const link = card.querySelector('.wg-journey-gauges__link');
        expect(link.textContent).toMatch(/why is this moving/i);
    });

    it('Gauges card renders each gauge\'s insufficient_data honestly instead of a distorted number', () => {
        env.window.Gamification.render(journey({
            gauges: {
                enabled: true,
                weight: { status: 'insufficient_data' },
                bp: { status: 'insufficient_data' },
                resting_hr: { status: 'insufficient_data' }
            }
        }));
        const rows = env.document.querySelectorAll('.wg-journey-gauges .wg-journey-gauge__caption');
        expect(rows[0].textContent).toMatch(/not enough history/i);
        expect(rows[1].textContent).toMatch(/log a few more bp readings/i);
        expect(rows[2].textContent).toMatch(/not enough resting-hr data/i);
    });

    it('Gauges card BP caption avoids a misleading "0%" when no readings in the last 30 days', () => {
        env.window.Gamification.render(journey({
            gauges: {
                enabled: true,
                weight: { status: 'insufficient_data' },
                bp: { status: 'ok', share_30d: 0, baseline_share_60d: 0.76, count_30d: 0, count_60d: 8 },
                resting_hr: { status: 'insufficient_data' }
            }
        }));
        const rows = env.document.querySelectorAll('.wg-journey-gauges .wg-journey-gauge__caption');
        expect(rows[1].textContent).toBe('Baseline 76% in range · none logged in the last 30 days');
        expect(rows[1].textContent).not.toMatch(/0%/);
    });

    it('Gauges card link scrolls to the tier-3 insight card', () => {
        env.window.Gamification.render(journey({
            unlocked_tiers: [1, 2, 3],
            insight: { sleep_bp: { status: 'no_effect', short_threshold_hours: 7, delta_systolic: 1, n_short: 12, n_in_band: 30 } },
            gauges: {
                enabled: true,
                weight: { status: 'insufficient_data' },
                bp: { status: 'insufficient_data' },
                resting_hr: { status: 'insufficient_data' }
            }
        }));
        const { document } = env;
        const scrollIntoView = vi.fn();
        document.getElementById('journey-insight-card').scrollIntoView = scrollIntoView;
        document.querySelector('.wg-journey-gauges__link').click();
        expect(scrollIntoView).toHaveBeenCalled();
    });

    it('Gauges card renders the offline-empty state when the fetch had no cache', () => {
        env.window.Gamification.render(journey({ gauges: { emptyState: 'No cached gauge data — connect to load.' } }));
        const card = env.document.querySelector('.wg-journey-gauges');
        expect(card.querySelector('.wg-journey-gauges__empty').textContent).toBe('No cached gauge data — connect to load.');
    });

    it('omits the Gauges card when the feature is gated off', () => {
        env.window.Gamification.render(journey({ gauges: { enabled: false } }));
        expect(env.document.querySelector('.wg-journey-gauges')).toBeNull();
    });
});
