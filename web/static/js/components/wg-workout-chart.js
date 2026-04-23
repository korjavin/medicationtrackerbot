// Wandergeek Workouts chart — deterministic SVG renderer for the session
// activity trend on the Stats sub-tab. Single-series variant of
// components/wg-weight-chart.js without a goal overlay.
//
//   • No inline stroke=/fill= on paths or circles. Every visual value
//     comes from a --wg-* token via a class on the SVG child element
//     (`.wg-workout-chart__line`, `__guide`, `__last`).
//   • Reuses window.ChartUtils (catmullRomSpline, LTTB, animateLine,
//     calculateYAxisTicks) when available — no duplication.
//
// API:
//   WGWorkoutChart.render({ sessions, range, metric, width, height }) → Element
//
//   sessions — Array<{ week, completed, skipped }> (weekly_activity shape
//              from /api/workout/stats) or already normalised
//              { date, value } entries. Empty / invalid input returns an
//              empty-state card element so callers can append it.
//   range    — '7d' | '30d' | '90d' | 'all' (default 'all'); filters data
//              to the most recent N days when provided. '7d' maps to one
//              week of activity; '30d' / '90d' map to the matching number
//              of weeks rounded up.
//   metric   — 'sessions' (default) renders completed sessions per week;
//              'volume' renders the numeric `volume` or `total_volume_kg`
//              field when the caller aggregates sessions upstream.
//   width    — coord-space width (default 358; SVG scales to container).
//   height   — coord-space height (default 200).
//
// Empty-state returns a <div class="wg-workout-chart wg-workout-chart--empty">
// carrying the "No workout sessions yet" copy. The data path returns an
// <svg class="wg-workout-chart">. Consumers style either via the shared
// `.wg-workout-chart` class plus modifiers.

(function () {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const DEFAULT_WIDTH = 358;
    const DEFAULT_HEIGHT = 200;
    const PAD_L = 28;
    const PAD_R = 14;
    const PAD_T = 14;
    const PAD_B = 26;
    const Y_FLOOR = 0;
    const Y_CEIL = 100000;
    const LAST_POINT_RADIUS = 4;

    const RANGE_DAYS = {
        '7d': 7,
        '30d': 30,
        '90d': 90,
    };

    function finiteOrDefault(value, fallback) {
        return Number.isFinite(value) ? value : fallback;
    }

    function pickMetric(raw, metric) {
        if (raw == null) return null;
        if (metric === 'volume') {
            const v = raw.volume != null ? raw.volume : raw.total_volume_kg;
            return v != null ? Number(v) : null;
        }
        // Default: completed-sessions-per-week trend.
        if (raw.value != null) return Number(raw.value);
        if (raw.completed != null) return Number(raw.completed);
        if (raw.sessions != null) return Number(raw.sessions);
        return null;
    }

    function normalize(raw, metric) {
        if (!raw) return null;
        const dateSrc = raw.date != null
            ? raw.date
            : (raw.week != null ? raw.week : raw.measured_at);
        if (dateSrc == null) return null;
        const date = dateSrc instanceof Date ? dateSrc : new Date(dateSrc);
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
        const value = pickMetric(raw, metric);
        if (value == null || !Number.isFinite(value)) return null;
        return { date, value };
    }

    function filterByRange(data, range) {
        if (!range || range === 'all') return data;
        const days = RANGE_DAYS[range];
        if (!days) return data;
        if (data.length === 0) return data;
        // Anchor on Date.now() so '7d' means 'last 7 days from today',
        // matching WGWeightChart / WGBpChart semantics. Cap upper bound at
        // now so a future-dated entry can't stretch the window.
        const now = Date.now();
        const cutoff = now - days * 86400000;
        return data.filter((d) => {
            const t = d.date.getTime();
            return t >= cutoff && t <= now;
        });
    }

    function buildSplinePath(points) {
        if (!points || points.length === 0) return '';
        if (window.ChartUtils && typeof window.ChartUtils.catmullRomSpline === 'function') {
            return window.ChartUtils.catmullRomSpline(points);
        }
        return points
            .map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`)
            .join(' ');
    }

    function downsample(points, plotW) {
        const utils = window.ChartUtils;
        const targetPoints = Math.max(30, Math.floor(plotW / 6));
        if (!utils || typeof utils.lttbDownsample !== 'function') return points;
        if (points.length <= targetPoints) return points;
        const down = utils.lttbDownsample(
            points.map((d) => [d.date.getTime(), d.value]),
            targetPoints,
        );
        const kept = new Set(down.map((p) => p[0]));
        return points.filter((d) => kept.has(d.date.getTime()));
    }

    function makePath(d, className) {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        path.classList.add(className);
        return path;
    }

    function makeGuideLine(x1, x2, y, label) {
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', String(x1));
        line.setAttribute('x2', String(x2));
        line.setAttribute('y1', y.toFixed(1));
        line.setAttribute('y2', y.toFixed(1));
        if (label != null) line.dataset.workoutGuide = String(label);
        line.classList.add('wg-workout-chart__guide');
        return line;
    }

    function makeLastCircle(cx, cy) {
        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('cx', cx.toFixed(1));
        circle.setAttribute('cy', cy.toFixed(1));
        circle.setAttribute('r', String(LAST_POINT_RADIUS));
        circle.classList.add('wg-workout-chart__last');
        return circle;
    }

    function makeEmptyCard(range) {
        const card = document.createElement('div');
        card.classList.add('wg-workout-chart', 'wg-workout-chart--empty');
        card.dataset.workoutRange = range || 'all';
        const msg = document.createElement('span');
        msg.classList.add('wg-workout-chart__empty-msg');
        msg.textContent = 'No workout sessions yet';
        card.appendChild(msg);
        return card;
    }

    function computeYTicks(yMin, yMax) {
        const utils = window.ChartUtils;
        if (utils && typeof utils.calculateYAxisTicks === 'function') {
            const ticks = utils.calculateYAxisTicks(yMin, yMax);
            if (Array.isArray(ticks) && ticks.length > 0) return ticks;
        }
        const range = yMax - yMin;
        const step = range >= 40 ? 10 : range >= 20 ? 5 : range >= 10 ? 2 : 1;
        const ticks = [];
        const start = Math.ceil(yMin / step) * step;
        for (let v = start; v <= yMax; v += step) ticks.push(v);
        return ticks;
    }

    function renderWorkoutChart(opts) {
        const options = opts || {};
        const range = typeof options.range === 'string' ? options.range : 'all';
        const metric = typeof options.metric === 'string' ? options.metric : 'sessions';
        const rawSessions = Array.isArray(options.sessions) ? options.sessions : [];
        if (rawSessions.length === 0) return makeEmptyCard(range);

        const normalized = rawSessions.map((r) => normalize(r, metric)).filter(Boolean);
        if (normalized.length === 0) return makeEmptyCard(range);

        normalized.sort((a, b) => a.date - b.date);
        const filtered = filterByRange(normalized, range);
        if (filtered.length === 0) return makeEmptyCard(range);

        const width = finiteOrDefault(options.width, DEFAULT_WIDTH);
        const height = finiteOrDefault(options.height, DEFAULT_HEIGHT);
        const plotW = width - PAD_L - PAD_R;
        const plotH = height - PAD_T - PAD_B;

        const data = downsample(filtered, plotW);
        if (data.length === 0) return makeEmptyCard(range);

        const firstTime = data[0].date.getTime();
        const lastTime = data[data.length - 1].date.getTime();
        const timeSpan = (lastTime - firstTime) || 1;
        const xOf = (t) => {
            if (data.length === 1) return PAD_L + plotW / 2;
            return PAD_L + ((t - firstTime) / timeSpan) * plotW;
        };

        let dataMin = Infinity;
        let dataMax = -Infinity;
        for (const d of data) {
            if (d.value < dataMin) dataMin = d.value;
            if (d.value > dataMax) dataMax = d.value;
        }
        if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) {
            dataMin = 0;
            dataMax = 1;
        }
        // Sessions-per-week is a non-negative count; keep the floor at zero
        // so the visual trend doesn't start mid-axis for a single spike.
        const boundedMin = Math.max(Y_FLOOR, Math.min(Y_CEIL, dataMin));
        const boundedMax = Math.max(Y_FLOOR, Math.min(Y_CEIL, dataMax));
        let yMin = metric === 'volume'
            ? Math.floor(boundedMin / 10) * 10
            : 0;
        let yMax = metric === 'volume'
            ? Math.ceil((boundedMax + 10) / 10) * 10
            : Math.max(1, Math.ceil(boundedMax + 1));
        if (yMin === yMax) yMax = yMin + 1;
        const yRange = (yMax - yMin) || 1;
        const yOf = (v) => {
            const clamped = v < yMin ? yMin : v > yMax ? yMax : v;
            return PAD_T + plotH - ((clamped - yMin) / yRange) * plotH;
        };

        const points = data.map((d) => [xOf(d.date.getTime()), yOf(d.value)]);

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', 'auto');
        svg.setAttribute('aria-hidden', 'true');
        svg.classList.add('wg-workout-chart');
        svg.dataset.workoutRange = range;
        svg.dataset.workoutMetric = metric;
        svg.dataset.workoutYMin = String(yMin);
        svg.dataset.workoutYMax = String(yMax);
        svg.dataset.workoutPointCount = String(data.length);

        const ticks = computeYTicks(yMin, yMax);
        for (const tick of ticks) {
            if (tick <= yMin || tick >= yMax) continue;
            svg.appendChild(makeGuideLine(PAD_L, width - PAD_R, yOf(tick), tick));
        }
        svg.dataset.workoutTickCount = String(
            ticks.filter((t) => t > yMin && t < yMax).length,
        );

        const linePath = makePath(buildSplinePath(points), 'wg-workout-chart__line');
        svg.appendChild(linePath);

        if (window.ChartUtils && typeof window.ChartUtils.animateLine === 'function') {
            window.ChartUtils.animateLine(linePath);
        }

        const last = data[data.length - 1];
        svg.appendChild(makeLastCircle(xOf(last.date.getTime()), yOf(last.value)));

        return svg;
    }

    window.WGWorkoutChart = {
        render: renderWorkoutChart,
        DEFAULT_WIDTH,
        DEFAULT_HEIGHT,
    };
})();
