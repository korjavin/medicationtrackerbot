// Wandergeek Weight chart — deterministic SVG renderer for the weight
// history view. Single-series variant of components/wg-bp-chart.js with an
// optional goal-line overlay when a goal is set.
//
//   • No inline stroke=/fill= on paths or circles. Every visual value
//     comes from a --wg-* token via a class on the SVG child element
//     (`.wg-weight-chart__line`, `__goal`, `__last`, `__guide`).
//   • Reuses window.ChartUtils (catmullRomSpline, LTTB, animateLine) when
//     available — no duplication with WGBpChart.
//
// API:
//   WGWeightChart.render({ logs, range, goal, width, height }) → Element
//
//   logs   — Array<{ measured_at, weight }> (API shape) or already
//            normalised { date, weight }. Empty input returns an
//            empty-state card element (not null) so callers can append it.
//   range  — '7d' | '30d' | '90d' | 'all' (default 'all'); filters logs
//            to the most recent N days when provided.
//   goal   — optional number or { goal } / { goal, goal_direction }.
//            When finite, renders a dashed horizontal guide line at the
//            goal weight.
//   width  — coord-space width (default 358; SVG scales to container).
//   height — coord-space height (default 200).
//
// Empty-state returns a <div class="wg-weight-chart wg-weight-chart--empty">
// carrying the "No weight entries yet" copy. The data path returns an
// <svg class="wg-weight-chart"> directly. Consumers style either via
// the shared `.wg-weight-chart` class plus modifiers.

(function () {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const DEFAULT_WIDTH = 358;
    const DEFAULT_HEIGHT = 200;
    const PAD_L = 28;
    const PAD_R = 14;
    const PAD_T = 14;
    const PAD_B = 26;
    const Y_FLOOR = 20;
    const Y_CEIL = 400;
    const LAST_POINT_RADIUS = 4;

    const RANGE_DAYS = {
        '7d': 7,
        '30d': 30,
        '90d': 90,
    };

    function finiteOrDefault(value, fallback) {
        return Number.isFinite(value) ? value : fallback;
    }

    function normalize(raw) {
        if (!raw) return null;
        const dateSrc = raw.measured_at != null ? raw.measured_at : raw.date;
        const date = dateSrc instanceof Date ? dateSrc : new Date(dateSrc);
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
        const weight = Number(raw.weight);
        if (!Number.isFinite(weight)) return null;
        return { date, weight };
    }

    function filterByRange(data, range) {
        if (!range || range === 'all') return data;
        const days = RANGE_DAYS[range];
        if (!days) return data;
        if (data.length === 0) return data;
        const last = data[data.length - 1].date.getTime();
        const cutoff = last - days * 86400000;
        return data.filter((d) => d.date.getTime() > cutoff);
    }

    function extractGoal(goal) {
        if (goal == null) return null;
        if (typeof goal === 'number') {
            return Number.isFinite(goal) ? goal : null;
        }
        if (typeof goal === 'object') {
            const raw = goal.goal != null ? goal.goal : goal.target;
            const num = Number(raw);
            return Number.isFinite(num) ? num : null;
        }
        return null;
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
            points.map((d) => [d.date.getTime(), d.weight]),
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
        if (label != null) line.dataset.weightGuide = String(label);
        line.classList.add('wg-weight-chart__guide');
        return line;
    }

    function makeGoalLine(x1, x2, y, value) {
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', String(x1));
        line.setAttribute('x2', String(x2));
        line.setAttribute('y1', y.toFixed(1));
        line.setAttribute('y2', y.toFixed(1));
        line.dataset.weightGoal = String(value);
        line.classList.add('wg-weight-chart__goal');
        return line;
    }

    function makeLastCircle(cx, cy) {
        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('cx', cx.toFixed(1));
        circle.setAttribute('cy', cy.toFixed(1));
        circle.setAttribute('r', String(LAST_POINT_RADIUS));
        circle.classList.add('wg-weight-chart__last');
        return circle;
    }

    function makeEmptyCard(range) {
        const card = document.createElement('div');
        card.classList.add('wg-weight-chart', 'wg-weight-chart--empty');
        card.dataset.weightRange = range || 'all';
        const msg = document.createElement('span');
        msg.classList.add('wg-weight-chart__empty-msg');
        msg.textContent = 'No weight entries yet';
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
        const step = range >= 40 ? 10 : range >= 20 ? 5 : 2;
        const ticks = [];
        const start = Math.ceil(yMin / step) * step;
        for (let v = start; v <= yMax; v += step) ticks.push(v);
        return ticks;
    }

    function renderWeightChart(opts) {
        const options = opts || {};
        const range = typeof options.range === 'string' ? options.range : 'all';
        const rawLogs = Array.isArray(options.logs) ? options.logs : [];
        if (rawLogs.length === 0) return makeEmptyCard(range);

        const normalized = rawLogs.map(normalize).filter(Boolean);
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

        const goalValue = extractGoal(options.goal);

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
            if (d.weight < dataMin) dataMin = d.weight;
            if (d.weight > dataMax) dataMax = d.weight;
        }
        if (goalValue != null) {
            if (goalValue < dataMin) dataMin = goalValue;
            if (goalValue > dataMax) dataMax = goalValue;
        }
        if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) {
            dataMin = 60;
            dataMax = 90;
        }
        if (dataMin === dataMax) {
            dataMin -= 2;
            dataMax += 2;
        }
        const boundedMin = Math.max(Y_FLOOR, Math.min(Y_CEIL, dataMin));
        const boundedMax = Math.max(Y_FLOOR, Math.min(Y_CEIL, dataMax));
        const yMin = Math.max(Y_FLOOR, Math.floor((boundedMin - 2) / 2) * 2);
        const yMax = Math.min(Y_CEIL, Math.ceil((boundedMax + 2) / 2) * 2);
        const yRange = (yMax - yMin) || 1;
        const yOf = (v) => {
            const clamped = v < yMin ? yMin : v > yMax ? yMax : v;
            return PAD_T + plotH - ((clamped - yMin) / yRange) * plotH;
        };

        const points = data.map((d) => [xOf(d.date.getTime()), yOf(d.weight)]);

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', 'auto');
        svg.setAttribute('aria-hidden', 'true');
        svg.classList.add('wg-weight-chart');
        svg.dataset.weightRange = range;
        svg.dataset.weightYMin = String(yMin);
        svg.dataset.weightYMax = String(yMax);
        svg.dataset.weightPointCount = String(data.length);

        const ticks = computeYTicks(yMin, yMax);
        for (const tick of ticks) {
            if (tick <= yMin || tick >= yMax) continue;
            svg.appendChild(makeGuideLine(PAD_L, width - PAD_R, yOf(tick), tick));
        }
        svg.dataset.weightTickCount = String(
            ticks.filter((t) => t > yMin && t < yMax).length,
        );

        if (goalValue != null) {
            svg.appendChild(makeGoalLine(PAD_L, width - PAD_R, yOf(goalValue), goalValue));
        }

        const linePath = makePath(buildSplinePath(points), 'wg-weight-chart__line');
        svg.appendChild(linePath);

        if (window.ChartUtils && typeof window.ChartUtils.animateLine === 'function') {
            window.ChartUtils.animateLine(linePath);
        }

        const last = data[data.length - 1];
        svg.appendChild(makeLastCircle(xOf(last.date.getTime()), yOf(last.weight)));

        return svg;
    }

    window.WGWeightChart = {
        render: renderWeightChart,
        DEFAULT_WIDTH,
        DEFAULT_HEIGHT,
    };
})();
