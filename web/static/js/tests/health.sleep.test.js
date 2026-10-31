// Wandergeek Health sleep-card wiring (Phase 8, Task 4).
//
// Asserts:
//   • renderSleepCard mounts a .wg-card + .wg-sleep-card shell with a mono
//     header, a WGSleepChart SVG, a legend row with per-stage + HR swatches,
//     and a section-label averages line.
//   • The legend badge variants carry the correct --wg-health-sleep-* token
//     hook via their __badge--{variant} class (deep / light / rem / awake /
//     hr) — colours are never set inline.
//   • Empty state: missing sleep_stats_7d data renders a muted
//     "No sleep data yet" card under the same header shell.
//   • renderHealthOverviewContent wires the sleep card into the overview
//     stream after the summary tiles + range selector.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function makeSleepStats(days = 5) {
    const anchor = Date.now() - 5000;
    const dayMs = 86400000;
    const stats = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(anchor - i * dayMs);
        const iso = d.toISOString().slice(0, 10);
        stats.push({
            date: iso,
            deep_mins: 80,
            light_mins: 220,
            rem_mins: 70,
            awake_mins: 20,
            total_mins: 390,
            heart_rate_avg: 58 + (days - i),
        });
    }
    return stats;
}

function makeData(overrides) {
    const base = {
        sleep_stats_7d: makeSleepStats(5),
        average_sleep_hours_7d: 6.5,
        average_sleep_hours_30d: 6.9,
        step_stats_7d: [],
        average_steps_7d: 0,
        average_steps_30d: 0,
        heart_rate_history_7d: [],
        average_heart_rate_7d: 0,
        average_heart_rate_30d: 0,
        spo2_history_7d: [],
        average_spo2_7d: 0,
        average_spo2_30d: 0,
    };
    return Object.assign({}, base, overrides || {});
}

describe('Health sleep card (Phase 8, Task 4)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renderSleepCard returns a .wg-card + .wg-sleep-card shell with mono header', () => {
        const { window } = env;
        const card = window.renderSleepCard(makeData(), '7d');
        expect(card.classList.contains('wg-card')).toBe(true);
        expect(card.classList.contains('wg-sleep-card')).toBe(true);
        expect(card.getAttribute('data-range')).toBe('7d');
        const header = card.querySelector('.wg-sleep-card__header');
        expect(header).not.toBeNull();
        expect(header.classList.contains('wg-mono-display')).toBe(true);
        expect(header.textContent).toBe('Sleep');
    });

    it('mounts a WGSleepChart SVG inside the card with the active range', () => {
        const { window } = env;
        const card = window.renderSleepCard(makeData(), '7d');
        const svg = card.querySelector('svg.wg-sleep-chart');
        expect(svg).not.toBeNull();
        expect(svg.dataset.sleepRange).toBe('7d');
        // At least one stage rect exists.
        expect(card.querySelectorAll('rect.wg-sleep-chart__stage').length).toBeGreaterThan(0);
    });

    it('renders a legend row with the 5 canonical swatches (deep/light/rem/awake/hr)', () => {
        const { window } = env;
        const card = window.renderSleepCard(makeData(), '7d');
        const legend = card.querySelector('.wg-health-legend');
        expect(legend).not.toBeNull();
        const items = legend.querySelectorAll('.wg-health-legend__item');
        expect(items.length).toBe(5);

        const variants = Array.from(legend.querySelectorAll('.wg-health-legend__badge'))
            .map((b) => {
                const variantClass = Array.from(b.classList)
                    .find((c) => c.startsWith('wg-health-legend__badge--') && c !== 'wg-health-legend__badge--line');
                return variantClass ? variantClass.replace('wg-health-legend__badge--', '') : null;
            });
        expect(variants).toEqual(['deep', 'light', 'rem', 'awake', 'hr']);
    });

    it('marks the HR legend swatch with the --line modifier', () => {
        const { window } = env;
        const card = window.renderSleepCard(makeData(), '7d');
        const hrBadge = card.querySelector('.wg-health-legend__badge--hr');
        expect(hrBadge).not.toBeNull();
        expect(hrBadge.classList.contains('wg-health-legend__badge--line')).toBe(true);
    });

    it('uses no inline style on legend swatches (colour resolves via CSS)', () => {
        const { window } = env;
        const card = window.renderSleepCard(makeData(), '7d');
        const badges = card.querySelectorAll('.wg-health-legend__badge');
        expect(badges.length).toBe(5);
        badges.forEach((b) => {
            expect(b.getAttribute('style')).toBeNull();
        });
    });

    it('renders a section-label averages line with 7d + 30d figures', () => {
        const { window } = env;
        const card = window.renderSleepCard(makeData({
            average_sleep_hours_7d: 7.2,
            average_sleep_hours_30d: 6.9,
        }), '7d');
        const stat = card.querySelector('.wg-sleep-card__stat');
        expect(stat).not.toBeNull();
        expect(stat.classList.contains('wg-section-label')).toBe(true);
        expect(stat.textContent).toContain('7.2 hrs (7d avg)');
        expect(stat.textContent).toContain('6.9 hrs (30d avg)');
    });

    it('renders the empty-state card when sleep_stats_7d is missing', () => {
        const { window } = env;
        const card = window.renderSleepCard(makeData({ sleep_stats_7d: [] }), '7d');
        expect(card.classList.contains('wg-sleep-card')).toBe(true);
        const empty = card.querySelector('.wg-sleep-chart--empty');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toMatch(/no sleep data yet/i);
        // No legend / stat row when empty.
        expect(card.querySelector('.wg-health-legend')).toBeNull();
        expect(card.querySelector('.wg-sleep-card__stat')).toBeNull();
    });

    it('accepts missing data gracefully and still returns a card', () => {
        const { window } = env;
        const card = window.renderSleepCard({}, '7d');
        expect(card.classList.contains('wg-sleep-card')).toBe(true);
        expect(card.querySelector('.wg-sleep-chart--empty')).not.toBeNull();
    });

    it('falls back to 7d range when the arg is invalid', () => {
        const { window } = env;
        const card = window.renderSleepCard(makeData(), 'bogus');
        expect(card.getAttribute('data-range')).toBe('7d');
    });

    it('renderHealthOverviewContent mounts the sleep card after the range selector', () => {
        const { document, window } = env;
        const content = document.getElementById('health-overview-content');
        window.renderHealthOverviewContent(content, makeData());
        const card = content.querySelector('.wg-sleep-card');
        expect(card).not.toBeNull();
        // Order: range selector → summary tiles → sleep card.
        const selector = content.querySelector('#health-range-selector');
        expect(selector).not.toBeNull();
        const selectorIdx = Array.from(content.children).indexOf(selector);
        const cardIdx = Array.from(content.children).indexOf(card);
        expect(cardIdx).toBeGreaterThan(selectorIdx);
    });

    // bd med-z36q: an iPhone without a Watch (or a third-party app) writes only
    // HKCategoryValueSleepAnalysis 1 (asleepUnspecified). healthimport.js stores
    // such a night with null stage minutes and total_minutes only; the chart
    // must still draw a bar for it, not just the label and the average.
    it('draws a bar for an unstaged Apple Health night (asleep samples only)', async () => {
        const { window } = env;
        const rows = new Map();
        const of = (t) => [...rows.values()].filter((r) => r.recordType === t);
        const records = {
            list: async (t) => of(t).filter((r) => !r.deleted),
            listRaw: async (t) => of(t),
            listRange: async (t, a, b) => of(t).filter((r) => !r.deleted && r.recordId >= a && r.recordId <= b),
            put: async (t, r) => { rows.set(r.recordId, { ...r, recordType: t }); return r; },
            putIfAbsent: async (t, r) => {
                if (!rows.has(r.recordId)) rows.set(r.recordId, { ...r, recordType: t });
                return rows.get(r.recordId);
            },
        };
        const H = 3600000;
        const now = Date.now();
        const end = now - 6 * H;
        const start = end - 7 * H;
        // Exactly the shape ios/App/Health.swift hands health-import.js.
        const samples = [
            { uuid: '00000000-0000-4000-8000-000000000001', start, end: start + 3 * H, value: 1, source: 'com.apple.health.iphone', tz: 'UTC' },
            { uuid: '00000000-0000-4000-8000-000000000002', start: start + 3 * H, end, value: 1, source: 'com.apple.health.iphone', tz: 'UTC' },
        ];
        const { createHealthImportDomain } = await import('../../../domain/healthimport.js');
        const { createVitalsDomain } = await import('../../../domain/vitals.js');
        const imp = createHealthImportDomain({ records, now: () => now, timeZone: 'UTC' });
        expect(await imp.importSamples('sleep', samples, { from: start - 48 * H, to: now })).toMatchObject({ added: 1 });
        const stored = of('sleep')[0];
        expect(stored).toMatchObject({ total_minutes: 420, light_minutes: null, deep_minutes: null, rem_minutes: null });

        const overview = await createVitalsDomain({ records, now: () => now, timeZone: 'UTC' }).overview();
        const card = window.renderSleepCard(overview, '7d');
        expect(card.querySelector('.wg-sleep-card__stat').textContent).toContain('7.0 hrs (7d avg)');
        const bars = card.querySelectorAll('rect.wg-sleep-chart__stage--asleep');
        expect(bars.length).toBe(1);
        expect(Number(bars[0].getAttribute('height'))).toBeGreaterThan(0);
        expect(card.querySelector('.wg-health-legend__badge--asleep')).not.toBeNull();
    });

    // bd med-w6gx.32: the source line below the chart comes from the fold's
    // per-day `sources` over the visible rows of the displayed range.
    describe('source summary (med-w6gx.32)', () => {
        const H = 3600000;
        const DAY = 24 * H;
        const now = Date.now();
        const todayUtc = Math.floor(now / DAY) * DAY;
        // A night ending 07:00 UTC `daysAgo` days back, in its sleep day (UTC).
        function night(daysAgo, { id, source, minutes = 420 } = {}) {
            const end = todayUtc - daysAgo * DAY + 7 * H;
            const day = new Date(end).toISOString().slice(0, 10);
            const row = {
                recordId: id || `sleep-hk-${day}`, deleted: false, day, timezone_offset: 0,
                start_time: new Date(end - minutes * 60000).toISOString(), end_time: new Date(end).toISOString(),
                total_minutes: minutes, light_minutes: minutes, recordType: 'sleep',
            };
            if (source) row.source = source;
            if (!id) row.source_id = day;
            return row;
        }
        async function overviewOf(rows) {
            const all = rows.map((r) => ({ ...r }));
            const records = {
                list: async (t) => all.filter((r) => r.recordType === t && !r.deleted),
                listRaw: async (t) => all.filter((r) => r.recordType === t),
                listRange: async () => [],
            };
            const { createVitalsDomain } = await import('../../../domain/vitals.js');
            return createVitalsDomain({ records, now: () => now, timeZone: 'UTC' }).overview();
        }
        const sourcesLine = (card) => card.querySelector('.wg-sleep-card__sources')?.textContent ?? null;

        it('Health-only nights name just Health import, in muted stat styling', async () => {
            const data = await overviewOf([night(1, { source: 'apple_health' }), night(2, { source: 'apple_health' })]);
            const card = env.window.renderSleepCard(data, '7d');
            const line = card.querySelector('.wg-sleep-card__sources');
            expect(line.textContent).toBe('Sources · Health import');
            expect(line.classList.contains('wg-sleep-card__stat')).toBe(true);
            expect(line.getAttribute('style')).toBeNull();
            expect(line.previousElementSibling.textContent).toContain('(7d avg)');
        });

        it('Mi Band-only nights name just Mi Band', async () => {
            const data = await overviewOf([night(1, { source: 'miband' })]);
            expect(sourcesLine(env.window.renderSleepCard(data, '7d'))).toBe('Sources · Mi Band');
        });

        it('mixed nights list Health import, Mi Band, Other sources in order; unknown markers are never Mi Band', async () => {
            const data = await overviewOf([
                night(1, { source: 'miband' }),
                night(2, { id: 'sleep-legacy-1' }),
                night(3, { source: 'apple_health' }),
            ]);
            expect(data.sleep_stats_7d.map((s) => s.sources)).toEqual([['apple_health'], ['unknown'], ['miband']]);
            expect(sourcesLine(env.window.renderSleepCard(data, '7d')))
                .toBe('Sources · Health import · Mi Band · Other sources');
        });

        it('an unrecognised marker alone reads Other sources', async () => {
            const data = await overviewOf([night(1, { id: 'sleep-legacy-2', source: 'garmin' })]);
            expect(sourcesLine(env.window.renderSleepCard(data, '7d'))).toBe('Sources · Other sources');
        });

        it('follows the active range: a night outside 7d only shows in 30d', async () => {
            const data = await overviewOf([night(1, { source: 'apple_health' }), night(20, { source: 'miband' })]);
            expect(sourcesLine(env.window.renderSleepCard(data, '7d'))).toBe('Sources · Health import');
            expect(sourcesLine(env.window.renderSleepCard(data, '30d'))).toBe('Sources · Health import · Mi Band');
        });

        it('a hidden legacy session on a shown Health day never affects the summary', async () => {
            const data = await overviewOf([
                night(1, { source: 'apple_health', minutes: 420 }),
                night(1, { id: 'sleep-legacy-3', minutes: 300 }),
            ]);
            expect(data.sleep_stats_7d).toHaveLength(1);
            expect(data.sleep_stats_7d[0]).toMatchObject({ total_mins: 420, sources: ['apple_health'] });
            expect(sourcesLine(env.window.renderSleepCard(data, '7d'))).toBe('Sources · Health import');
        });

        it('an empty chart has no source line', async () => {
            const data = await overviewOf([night(20, { source: 'miband' })]);
            const card = env.window.renderSleepCard(data, '7d');
            expect(card.querySelector('.wg-sleep-chart--empty')).not.toBeNull();
            expect(sourcesLine(card)).toBeNull();
        });
    });

    it('a staged night renders exactly the stage bars and legend it always did', () => {
        const { window } = env;
        const card = window.renderSleepCard(makeData(), '7d');
        expect(card.querySelectorAll('rect.wg-sleep-chart__stage--asleep').length).toBe(0);
        expect(card.querySelectorAll('rect.wg-sleep-chart__stage').length).toBe(5 * 4);
        expect(card.querySelector('.wg-health-legend__badge--asleep')).toBeNull();
    });
});
