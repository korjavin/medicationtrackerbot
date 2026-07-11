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

    // The insight-ladder card was retired in the gamification redesign (Phase
    // 5): the narrative layer (chapters / traits / keystones) replaces the
    // level-gated ladder progression. The sleep→BP and good-day insight cards
    // themselves survive and are covered by the dedicated tests below; they no
    // longer have a ladder row as an entry point. Below-tier gating is asserted
    // by "insight card is omitted…" further down.

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

    // Good-day card (gamification-13 Task 3): the tier-4 association scan,
    // same honesty-gate states as the sleep→BP card above, plus the
    // good_day_definition sub-line spelling out the user's own band.
    it('good-day card renders the "effect" state as one line per finding plus the definition', () => {
        env.window.Gamification.render(journey({
            unlocked_tiers: [1, 2, 3, 4],
            insight: {
                good_day: {
                    status: 'effect',
                    good_day_definition: 'in range = systolic 90–120',
                    findings: [
                        { behavior: 'workout', rate_with: 0.78, rate_without: 0.55, delta_pp: 23, n_with: 21, n_without: 13 }
                    ]
                }
            }
        }));
        const card = env.document.getElementById('journey-goodday-card');
        expect(card).not.toBeNull();
        expect(card.querySelector('.wg-journey-insight__body').textContent)
            .toBe('On days after a workout, BP in range 78% vs 55% · 21/34 days');
        expect(card.querySelector('.wg-journey-goodday__definition').textContent)
            .toBe('in range = systolic 90–120');
    });

    it('good-day card renders the "no_effect" state as its own honest finding', () => {
        env.window.Gamification.render(journey({
            unlocked_tiers: [1, 2, 3, 4],
            insight: { good_day: { status: 'no_effect', good_day_definition: 'in range = systolic 90–120' } }
        }));
        const card = env.document.getElementById('journey-goodday-card');
        expect(card.querySelector('.wg-journey-insight__body').textContent)
            .toMatch(/no single habit stands out/i);
    });

    it('good-day card renders the "insufficient_data" state with the per-behavior day count', () => {
        env.window.Gamification.render(journey({
            unlocked_tiers: [1, 2, 3, 4],
            insight: {
                good_day: {
                    status: 'insufficient_data',
                    good_day_definition: 'in range = systolic 90–120',
                    insufficient: [{ behavior: 'workout', n_with: 6, n_without: 20, needed: 10 }]
                }
            }
        }));
        const card = env.document.getElementById('journey-goodday-card');
        expect(card.querySelector('.wg-journey-insight__body').textContent)
            .toBe('Not enough contrast yet for a workout · keep logging — 6 of 10 days needed');
    });

    it('good-day card renders the offline-empty state when the fetch had no cache', () => {
        env.window.Gamification.render(journey({
            unlocked_tiers: [1, 2, 3, 4],
            insight: { emptyState: 'No cached insight — connect to load.' }
        }));
        const card = env.document.getElementById('journey-goodday-card');
        expect(card.querySelector('.wg-journey-insight__body').textContent).toBe('No cached insight — connect to load.');
    });

    it('good-day card is omitted when tier 4 is unlocked but insight has not loaded yet', () => {
        env.window.Gamification.render(journey({ unlocked_tiers: [1, 2, 3, 4] }));
        expect(env.document.getElementById('journey-goodday-card')).toBeNull();
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

    // "Your week" card (gamification-12 §Task3) — sourced from
    // `journey.weekly_review` (attached by load() from its own fetch, same
    // pattern as Gauges/Insights). Omitted entirely until it has loaded.
    it('omits the Weekly Review card until journey.weekly_review has loaded', () => {
        env.window.Gamification.render(journey());
        expect(env.document.querySelector('.wg-journey-weekly')).toBeNull();
    });

    it('Weekly Review card renders score movement, lever line, gauge lines, and best day', () => {
        env.window.Gamification.render(journey({
            weekly_review: {
                enabled: true,
                quiet: false,
                levers: [
                    { key: 'bedtime', closed_this_week: 5, closed_last_week: 4 },
                    { key: 'movement', closed_this_week: 4, closed_last_week: 3 },
                    { key: 'nourishment', closed_this_week: 6, closed_last_week: 5 }
                ],
                best_day: { day_unix: 1751328000, rings_closed: 3 }, // 2025-07-01 (Tuesday, UTC)
                gauges: {
                    weight: { status: 'ok', velocity_pct_per_week: -0.4, pace_status: 'on_pace', acceleration: 'speeding_up' },
                    bp: { status: 'ok', share_30d: 0.82, count_30d: 26 },
                    bp_share_30d_prior: 0.76,
                    resting_hr: { status: 'ok', recent_14d_mean: 62, delta_from_baseline: -3 }
                },
                health_score: { now: { value: 78, contributors: [], missing: [] }, prior: { value: 74, contributors: [], missing: [] } }
            }
        }));
        const { document } = env;

        const card = document.querySelector('.wg-journey-weekly');
        expect(card).not.toBeNull();
        expect(card.querySelector('.wg-journey-weekly__summary').textContent).toBe('YOUR WEEK');

        const lines = Array.from(card.querySelectorAll('.wg-journey-weekly__line')).map((n) => n.textContent);
        expect(lines).toEqual([
            'Health Score 78 · up 4',
            'Bedtime closed 5 of 7 · Movement 4 · Nourishment 6',
            'Weight -0.4%/wk · on pace · speeding up',
            'BP in range 82% · up from 76%',
            'Resting HR 62 avg · 3 below your baseline',
            'Best day: Tuesday · 3 rings closed'
        ]);
    });

    it('Weekly Review card reads a zero-HP week as "a quiet week", never a wall of zeros', () => {
        env.window.Gamification.render(journey({
            weekly_review: { enabled: true, quiet: true, levers: [], gauges: {}, health_score: {} }
        }));
        const card = env.document.querySelector('.wg-journey-weekly');
        expect(card.textContent).toMatch(/a quiet week/i);
        expect(card.querySelectorAll('.wg-journey-weekly__line').length).toBe(0);
    });

    it('Weekly Review card renders the offline-empty state when the fetch had no cache', () => {
        env.window.Gamification.render(journey({
            weekly_review: { emptyState: 'No cached weekly review — connect to load.' }
        }));
        const card = env.document.querySelector('.wg-journey-weekly');
        expect(card.querySelector('.wg-journey-weekly__empty').textContent).toBe('No cached weekly review — connect to load.');
    });

    it('omits the Weekly Review card when the feature is gated off', () => {
        env.window.Gamification.render(journey({ weekly_review: { enabled: false } }));
        expect(env.document.querySelector('.wg-journey-weekly')).toBeNull();
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

    // --- Discovery Atlas feed (gamification redesign Phase 1) ---

    it('developing Atlas card shows a progress meter naming the exact next log action', () => {
        env.window.Gamification.render(journey({
            atlas: {
                cards: [{
                    id: 'workout_next_morning_bp', question: 'Do workout days lower your next-morning blood pressure?',
                    state: 'developing', have: 6, needed: 8, remaining: 2,
                    next: 'Log a workout, then your BP the next morning, to add a pair.',
                }],
            },
        }));
        const atlas = env.document.querySelector('.wg-journey-atlas');
        expect(atlas).not.toBeNull();
        const card = atlas.querySelector('.wg-journey-atlas__card--developing');
        expect(card.querySelector('.wg-journey-atlas__question').textContent)
            .toContain('next-morning blood pressure');
        expect(card.querySelector('.wg-journey-atlas__meter').textContent)
            .toContain('6 of 8 paired observations');
        expect(card.querySelector('.wg-journey-atlas__next').textContent).toMatch(/Log a workout/);
        expect(card.querySelector('.wg-journey-bar__fill')).not.toBeNull();
    });

    it('revealed Atlas card shows the finding and a Discovery tag', () => {
        env.window.Gamification.render(journey({
            atlas: {
                cards: [{
                    id: 'workout_next_morning_bp', question: 'Q',
                    state: 'revealed', delta: -16, n: 23,
                    text: 'Mornings after workout days: systolic ~16 mmHg lower · 23 paired days',
                    seen: true,
                }],
            },
        }));
        const card = env.document.querySelector('.wg-journey-atlas__card--revealed');
        expect(card.querySelector('.wg-journey-atlas__finding').textContent).toContain('16 mmHg lower');
        expect(card.querySelector('.wg-journey-atlas__tag').textContent).toBe('Discovery');
    });

    it('no_effect Atlas card is rendered as a genuine finding, not a blank', () => {
        env.window.Gamification.render(journey({
            atlas: {
                cards: [{
                    id: 'workout_next_morning_bp', question: 'Q',
                    state: 'no_effect', n: 40,
                    text: 'Your next-morning BP holds steady whether or not you worked out · 40 days',
                    seen: true,
                }],
            },
        }));
        const card = env.document.querySelector('.wg-journey-atlas__card--no_effect');
        expect(card.querySelector('.wg-journey-atlas__finding').textContent).toContain('holds steady');
        expect(card.querySelector('.wg-journey-atlas__tag').textContent).toBe('No effect — a finding');
    });

    it('renders the Atlas feed even when the HP/levels substrate is disabled (cloud POC)', () => {
        env.window.Gamification.render({
            enabled: false,
            atlas: {
                cards: [{
                    id: 'workout_next_morning_bp', question: 'Q', state: 'revealed',
                    delta: -6, n: 12, text: 'a finding', seen: true,
                }],
            },
        });
        // The Atlas renders; the "gamification is off" empty state does not.
        expect(env.document.querySelector('.wg-journey-atlas')).not.toBeNull();
        expect(env.document.querySelector('.wg-journey-empty')).toBeNull();
    });

    // --- Narrative layer (Phase 5): chapters / traits / keystones ---------

    it('the insight-ladder card is retired (no ladder markup renders)', () => {
        env.window.Gamification.render(journey({ unlocked_tiers: [1, 2, 3, 4] }));
        expect(env.document.querySelector('.wg-journey-ladder')).toBeNull();
        expect(env.document.querySelector('.wg-journey-ladder__row')).toBeNull();
    });

    it('renders an active chapter with its day tracker + an end affordance', () => {
        env.window.Gamification.render(journey({
            chapter: {
                enabled: true,
                active: { theme_id: 'early_sleeper', title: 'The Early Sleeper', focus: 'a steady bedtime window', day_number: 6, duration: 28 },
            },
        }));
        const card = env.document.getElementById('journey-chapter-card');
        expect(card).not.toBeNull();
        expect(card.querySelector('.wg-journey-chapter__title').textContent).toBe('The Early Sleeper');
        expect(card.querySelector('.wg-journey-chapter__tracker').textContent).toMatch(/Day 6 of 28/);
        expect(card.querySelector('.wg-journey-chapter__close')).not.toBeNull();
    });

    it('renders a chapter review + theme picker when no arc is running', () => {
        env.window.Gamification.render(journey({
            chapter: {
                enabled: true, active: null, can_start: true,
                review: { theme_id: 'steady_month', title: 'The Steady Month', text: 'Your Steady Month focused on blood-pressure consistency.' },
                themes: [{ id: 'early_sleeper', title: 'The Early Sleeper', blurb: 'Aim for a 7h+ night.' }],
            },
        }));
        const card = env.document.getElementById('journey-chapter-card');
        expect(card.querySelector('.wg-journey-chapter__recap').textContent).toMatch(/Steady Month/);
        expect(card.querySelectorAll('.wg-journey-chapter__theme').length).toBe(1);
    });

    it('renders the traits shelf: held, dormant (with rekindle cost), developing', () => {
        env.window.Gamification.render(journey({
            traits: {
                enabled: true,
                traits: [
                    { id: 'early_sleeper', title: 'Early Sleeper', state: 'held', on_28d: 24, earn: 21, rekindle: 5, lever_label: 'window nights' },
                    { id: 'consistent_mover', title: 'Consistent Mover', state: 'dormant', on_28d: 3, earn: 12, rekindle: 3, rekindle_remaining: 2, lever_label: 'move days' },
                    { id: 'early_diner', title: 'Early Diner', state: 'developing', on_28d: 6, earn: 14, remaining: 8, lever_label: 'early dinners' },
                ],
            },
        }));
        const card = env.document.getElementById('journey-traits-card');
        expect(card).not.toBeNull();
        const dormant = card.querySelector('.wg-journey-trait--dormant');
        expect(dormant).not.toBeNull();
        expect(dormant.querySelector('.wg-journey-trait__sub').textContent).toMatch(/rekindles it. Nothing was lost/i);
        expect(card.querySelector('.wg-journey-trait--held')).not.toBeNull();
        expect(card.querySelector('.wg-journey-trait--developing')).not.toBeNull();
    });

    it('renders the keystones timeline; omits the card when empty', () => {
        env.window.Gamification.render(journey({
            keystones: {
                enabled: true,
                keystones: [
                    { id: 'bp_in_target_band', title: 'Blood pressure in your target band', text: 'settled at 118', earned_at: Date.UTC(2026, 4, 1) },
                ],
            },
        }));
        const card = env.document.getElementById('journey-keystones-card');
        expect(card).not.toBeNull();
        expect(card.querySelectorAll('.wg-journey-keystone').length).toBe(1);

        env.window.Gamification.render(journey({ keystones: { enabled: true, keystones: [] } }));
        expect(env.document.getElementById('journey-keystones-card')).toBeNull();
    });

    // --- AI narration (Phase 6): opt-in prose OVER the deterministic cards ---

    it('mounts the AI Story card only when the narration capability is present', () => {
        // No capability field (bot mode 404s the probe) → no card.
        env.window.Gamification.render(journey());
        expect(env.document.getElementById('journey-narrator-card')).toBeNull();

        env.window.Gamification.render(journey({ narration: { enabled: true } }));
        const card = env.document.getElementById('journey-narrator-card');
        expect(card).not.toBeNull();
        // Honest leakage note is present, and the weekly/workout buttons always show.
        expect(card.querySelector('.wg-journey-narrator__note').textContent).toMatch(/never raw logs/i);
        const labels = [...card.querySelectorAll('button')].map((b) => b.textContent);
        expect(labels).toContain('Narrate my week');
        expect(labels).toContain('Workout insight');
    });

    it('shows the chapter/experiment buttons only when their deterministic data exists', () => {
        env.window.Gamification.render(journey({
            narration: { enabled: true },
            chapter: { enabled: true, review: { title: 'The Steady Month', text: 'recap' } },
            experiments: { enabled: true, can_start: true, templates: [] },
        }));
        const labels = [...env.document.querySelectorAll('#journey-narrator-card button')].map((b) => b.textContent);
        expect(labels).toContain('Chapter recap');
        expect(labels).toContain('Experiment idea');
    });

    it('AI prose lands in a SEPARATE attributed block and never displaces deterministic values', async () => {
        // Deterministic chapter review carries real numbers; the model reply is
        // full of hallucinated ones. The narration must be additive only.
        const calls = [];
        env.window.offlineAwareApiCall = (url, method) => {
            calls.push([url, method]);
            return Promise.resolve({ text: 'Your BP hit 999 and you slept 40 hours!', source: 'ai' });
        };
        env.window.Gamification.render(journey({
            narration: { enabled: true },
            chapter: {
                enabled: true,
                review: { title: 'The Steady Month', text: 'Your Steady Month: 24 days logged, 18 nights of 7h+ sleep.' },
            },
        }));

        // Deterministic card renders its true numbers up front.
        const review = env.document.querySelector('.wg-journey-chapter__recap');
        expect(review.textContent).toMatch(/24 days logged, 18 nights/);

        // Tap "Narrate my week".
        const btn = [...env.document.querySelectorAll('#journey-narrator-card button')]
            .find((b) => b.textContent === 'Narrate my week');
        btn.dispatchEvent(new env.window.Event('click'));
        await new Promise((r) => setTimeout(r, 0));

        expect(calls).toEqual([['/api/gamification/narrate/weekly', 'POST']]);
        // Prose appears in its own attributed block, tagged as AI-authored.
        const prose = env.document.querySelector('.wg-journey-narrator__prose');
        expect(prose).not.toBeNull();
        expect(prose.querySelector('.wg-journey-narrator__attr').textContent).toBe('narrated by your AI');
        expect(prose.querySelector('.wg-journey-narrator__text').textContent).toMatch(/999/);
        // The deterministic review is UNCHANGED — the hallucinated numbers live
        // only inside the narration block, never in a computed field.
        expect(env.document.querySelector('.wg-journey-chapter__recap').textContent).toMatch(/24 days logged, 18 nights/);
    });

    it('a no-key/error narration ({text:null}) shows an honest hint, deterministic cards intact', async () => {
        env.window.offlineAwareApiCall = () => Promise.resolve({ text: null, source: 'deterministic' });
        env.window.Gamification.render(journey({ narration: { enabled: true } }));
        const btn = [...env.document.querySelectorAll('#journey-narrator-card button')]
            .find((b) => b.textContent === 'Workout insight');
        btn.dispatchEvent(new env.window.Event('click'));
        await new Promise((r) => setTimeout(r, 0));
        expect(env.document.querySelector('.wg-journey-narrator__status').textContent).toMatch(/add an OpenAI key/i);
        expect(env.document.querySelector('.wg-journey-narrator__prose')).toBeNull();
        // The rest of the Journey rendered normally.
        expect(env.document.querySelector('.wg-journey-atlas, .wg-card')).not.toBeNull();
    });
});
