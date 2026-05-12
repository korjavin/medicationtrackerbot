// Tests for the WGSleepChart component (Phase 8, Task 4).
// Stacked-bar renderer for the Health Overview sleep card: deep / light / rem
// / awake segments per day plus an optional HR line overlay with labelled
// dots. Every colour resolves via CSS classes on SVG children — never through
// inline stroke=/fill= attributes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CHART_UTILS_JS = path.join(REPO_ROOT, 'web/static/js/core/chart-utils.js');
const WG_SLEEP_CHART_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-sleep-chart.js');

function loadEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only',
    });
    dom.window.eval(fs.readFileSync(CHART_UTILS_JS, 'utf8'));
    dom.window.eval(fs.readFileSync(WG_SLEEP_CHART_JS, 'utf8'));
    return {
        window: dom.window,
        api: dom.window.WGSleepChart,
        cleanup: () => dom.window.close(),
    };
}

function toLocalISODate(d) {
    // The chart's isToday() compares local-midnight boundaries; using
    // toISOString() (UTC) here would label "today" as tomorrow whenever the
    // test runs after local midnight UTC. Format YYYY-MM-DD from local parts.
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function makeStats({ days = 7, withHR = true, totalMinutes = 420 } = {}) {
    const anchor = Date.now() - 5000;
    const dayMs = 86400000;
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(anchor - i * dayMs);
        const iso = toLocalISODate(d);
        out.push({
            date: iso,
            deep_mins: 80,
            light_mins: 220,
            rem_mins: 80,
            awake_mins: 40,
            total_mins: totalMinutes,
            heart_rate_avg: withHR ? 58 + ((days - i) % 6) : 0,
        });
    }
    return out;
}

describe('WGSleepChart.render', () => {
    let env;
    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env.cleanup(); });

    it('exposes a render function on window.WGSleepChart', () => {
        expect(env.api).toBeTruthy();
        expect(typeof env.api.render).toBe('function');
        expect(env.api.DEFAULT_WIDTH).toBe(358);
        expect(env.api.DEFAULT_HEIGHT).toBe(240);
    });

    it('returns an SVG element in the SVG namespace with the wg-sleep-chart class', () => {
        const svg = env.api.render({ stats: makeStats({ days: 5 }) });
        expect(svg).not.toBeNull();
        expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
        expect(svg.tagName.toLowerCase()).toBe('svg');
        expect(svg.classList.contains('wg-sleep-chart')).toBe(true);
        expect(svg.getAttribute('viewBox')).toBe('0 0 358 240');
        expect(svg.getAttribute('aria-hidden')).toBe('true');
    });

    it('renders one stage rect per non-zero stage per day', () => {
        const svg = env.api.render({ stats: makeStats({ days: 3 }) });
        const deep = svg.querySelectorAll('rect.wg-sleep-chart__stage--deep');
        const light = svg.querySelectorAll('rect.wg-sleep-chart__stage--light');
        const rem = svg.querySelectorAll('rect.wg-sleep-chart__stage--rem');
        const awake = svg.querySelectorAll('rect.wg-sleep-chart__stage--awake');
        expect(deep.length).toBe(3);
        expect(light.length).toBe(3);
        expect(rem.length).toBe(3);
        expect(awake.length).toBe(3);
    });

    it('omits rects for zero-minute stages', () => {
        const stats = [{
            date: '2026-04-01',
            deep_mins: 60,
            light_mins: 180,
            rem_mins: 0,
            awake_mins: 0,
            total_mins: 240,
            heart_rate_avg: 55,
        }];
        const svg = env.api.render({ stats });
        expect(svg.querySelectorAll('rect.wg-sleep-chart__stage--deep').length).toBe(1);
        expect(svg.querySelectorAll('rect.wg-sleep-chart__stage--light').length).toBe(1);
        expect(svg.querySelectorAll('rect.wg-sleep-chart__stage--rem').length).toBe(0);
        expect(svg.querySelectorAll('rect.wg-sleep-chart__stage--awake').length).toBe(0);
    });

    it('sets no inline stroke/fill/style on stage rects or HR overlay elements', () => {
        const svg = env.api.render({ stats: makeStats({ days: 5 }) });
        const all = svg.querySelectorAll(
            'rect.wg-sleep-chart__stage, path.wg-sleep-chart__hr-line, ' +
            'circle.wg-sleep-chart__hr-dot, circle.wg-sleep-chart__hr-dot-outer, ' +
            'text.wg-sleep-chart__hr-label, text.wg-sleep-chart__bar-label, ' +
            'text.wg-sleep-chart__axis-label, text.wg-sleep-chart__day-label, ' +
            'line.wg-sleep-chart__guide, line.wg-sleep-chart__tick'
        );
        expect(all.length).toBeGreaterThan(0);
        for (const el of all) {
            expect(el.getAttribute('stroke')).toBeNull();
            expect(el.getAttribute('fill')).toBeNull();
            expect(el.getAttribute('style')).toBeNull();
        }
    });

    it('renders an HR line with dots + labels when heart_rate_avg data is present', () => {
        const svg = env.api.render({ stats: makeStats({ days: 5, withHR: true }) });
        const line = svg.querySelectorAll('path.wg-sleep-chart__hr-line');
        const dots = svg.querySelectorAll('circle.wg-sleep-chart__hr-dot');
        const outerDots = svg.querySelectorAll('circle.wg-sleep-chart__hr-dot-outer');
        const labels = svg.querySelectorAll('text.wg-sleep-chart__hr-label');
        expect(line.length).toBe(1);
        expect(dots.length).toBe(5);
        expect(outerDots.length).toBe(5);
        expect(labels.length).toBe(5);
    });

    it('omits the HR line when every heart_rate_avg is zero', () => {
        const svg = env.api.render({ stats: makeStats({ days: 5, withHR: false }) });
        expect(svg.querySelectorAll('path.wg-sleep-chart__hr-line').length).toBe(0);
        expect(svg.querySelectorAll('circle.wg-sleep-chart__hr-dot').length).toBe(0);
    });

    it('applies the 7d range filter — only entries in the last 7 days contribute', () => {
        const stats = makeStats({ days: 14 });
        const svg = env.api.render({ stats, range: '7d' });
        expect(svg).not.toBeNull();
        expect(svg.dataset.sleepRange).toBe('7d');
        const pointCount = Number(svg.dataset.sleepPointCount);
        expect(pointCount).toBeGreaterThan(0);
        expect(pointCount).toBeLessThanOrEqual(7);
    });

    it('applies the 30d range filter', () => {
        const stats = makeStats({ days: 60 });
        const svg = env.api.render({ stats, range: '30d' });
        expect(svg).not.toBeNull();
        expect(svg.dataset.sleepRange).toBe('30d');
        const pointCount = Number(svg.dataset.sleepPointCount);
        expect(pointCount).toBeGreaterThan(0);
        expect(pointCount).toBeLessThanOrEqual(30);
    });

    it("treats range 'all' (and undefined) as no filter", () => {
        const stats = makeStats({ days: 14 });
        const full = env.api.render({ stats, range: 'all' });
        const unspec = env.api.render({ stats });
        expect(full.dataset.sleepRange).toBe('all');
        expect(unspec.dataset.sleepRange).toBe('all');
        expect(Number(full.dataset.sleepPointCount)).toBe(14);
        expect(Number(unspec.dataset.sleepPointCount)).toBe(14);
    });

    it('returns an empty-state card when stats are empty or absent', () => {
        const empty = env.api.render({ stats: [] });
        const missing = env.api.render({});
        const nullStats = env.api.render({ stats: null });
        for (const node of [empty, missing, nullStats]) {
            expect(node).not.toBeNull();
            expect(node.tagName.toLowerCase()).toBe('div');
            expect(node.classList.contains('wg-sleep-chart')).toBe(true);
            expect(node.classList.contains('wg-sleep-chart--empty')).toBe(true);
            expect(node.textContent).toMatch(/no sleep data yet/i);
        }
    });

    it('returns the empty-state card when every entry is invalid', () => {
        const el = env.api.render({
            stats: [
                { date: 'bad', total_mins: 400 },
                { date: '2026-04-01', total_mins: 'x' },
            ],
        });
        expect(el.classList.contains('wg-sleep-chart--empty')).toBe(true);
    });

    it('produces a sane guide-tick count (inner-only, skips outermost)', () => {
        const svg = env.api.render({ stats: makeStats({ days: 7 }) });
        const tickCount = Number(svg.dataset.sleepTickCount);
        const guides = svg.querySelectorAll('line.wg-sleep-chart__guide');
        expect(tickCount).toBeGreaterThanOrEqual(0);
        expect(tickCount).toBeLessThanOrEqual(5);
        expect(guides.length).toBe(tickCount);
    });

    it('renders "Today" as the last x-axis day label', () => {
        const svg = env.api.render({ stats: makeStats({ days: 4 }) });
        const labels = Array.from(svg.querySelectorAll('text.wg-sleep-chart__day-label'));
        expect(labels.length).toBe(4);
        expect(labels[labels.length - 1].textContent).toBe('Today');
    });

    it('renders a total-sleep label above each non-empty bar', () => {
        const svg = env.api.render({ stats: makeStats({ days: 3, totalMinutes: 445 }) });
        const labels = svg.querySelectorAll('text.wg-sleep-chart__bar-label');
        expect(labels.length).toBe(3);
        // 445 minutes = 7:25
        expect(labels[0].textContent).toBe('7:25');
    });

    it('forwards width/height options into the viewBox', () => {
        const svg = env.api.render({ stats: makeStats({ days: 3 }), width: 420, height: 260 });
        expect(svg.getAttribute('viewBox')).toBe('0 0 420 260');
    });

    it('filters out entries with bad dates or non-numeric total_mins', () => {
        const stats = [
            { date: '2026-04-01', total_mins: 400, deep_mins: 100, light_mins: 200, rem_mins: 60, awake_mins: 40, heart_rate_avg: 60 },
            { date: 'not-a-date', total_mins: 400 },
            { date: '2026-04-03', total_mins: 'x' },
            { date: '2026-04-04', total_mins: 360, deep_mins: 80, light_mins: 180, rem_mins: 60, awake_mins: 40, heart_rate_avg: 62 },
        ];
        const svg = env.api.render({ stats });
        expect(svg.tagName.toLowerCase()).toBe('svg');
        expect(Number(svg.dataset.sleepPointCount)).toBe(2);
    });
});
