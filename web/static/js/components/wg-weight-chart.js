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
    const KG_PER_LB = 0.45359237;

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
        // Anchor on Date.now() so "7d" means "last 7 days from today",
        // matching WGBpChart's semantics and what the user reads off the
        // range-selector label. Cap the upper bound at now so a mistyped
        // future-dated entry does not stretch the window or slip into a
        // "last N days" view it does not belong to.
        const now = Date.now();
        const cutoff = now - days * 86400000;
        return data.filter((d) => {
            const t = d.date.getTime();
            return t >= cutoff && t <= now;
        });
    }

    function parseTimeMs(raw) {
        if (raw == null) return null;
        const d = raw instanceof Date ? raw : new Date(raw);
        if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
        return d.getTime();
    }

    // extractGoal returns the goal weight (kg) along with optional trajectory
    // snapshot anchors: { valueKg, dateMs, setAtMs, startWeightKg }. Legacy
    // shapes (raw number, or `{goal}` / `{target}` without snapshot fields)
    // populate only `valueKg` so the chart can fall back to the old "first
    // log → goal at last log" geometry. Returns null when no finite goal
    // value is present.
    function extractGoal(goal) {
        if (goal == null) return null;
        if (typeof goal === 'number') {
            return Number.isFinite(goal)
                ? { valueKg: goal, dateMs: null, setAtMs: null, startWeightKg: null }
                : null;
        }
        if (typeof goal !== 'object') return null;
        const rawValue = goal.goal != null ? goal.goal : goal.target;
        const valueNum = Number(rawValue);
        if (!Number.isFinite(valueNum)) return null;
        const dateMs = parseTimeMs(goal.goal_date != null ? goal.goal_date : goal.goalDate);
        const setAtMs = parseTimeMs(goal.goal_set_at != null ? goal.goal_set_at : goal.goalSetAt);
        const startRaw = goal.goal_start_weight != null ? goal.goal_start_weight : goal.goalStartWeight;
        const startNum = Number(startRaw);
        const startWeightKg = Number.isFinite(startNum) ? startNum : null;
        return { valueKg: valueNum, dateMs, setAtMs, startWeightKg };
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

    function makeTickText(x, y, text, className, anchor) {
        const t = document.createElementNS(SVG_NS, 'text');
        t.setAttribute('x', String(x));
        t.setAttribute('y', String(y));
        if (anchor) t.setAttribute('text-anchor', anchor);
        t.classList.add(className);
        t.textContent = String(text);
        return t;
    }

    function makePlanLine(x1, y1, x2, y2) {
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', x1.toFixed(1));
        line.setAttribute('y1', y1.toFixed(1));
        line.setAttribute('x2', x2.toFixed(1));
        line.setAttribute('y2', y2.toFixed(1));
        line.classList.add('wg-weight-chart__plan');
        return line;
    }

    function makeTrendLine(x1, y1, x2, y2) {
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', x1.toFixed(1));
        line.setAttribute('y1', y1.toFixed(1));
        line.setAttribute('x2', x2.toFixed(1));
        line.setAttribute('y2', y2.toFixed(1));
        line.classList.add('wg-weight-chart__trend');
        return line;
    }

    // Linear regression on the last N points (default 14). Returns
    // { slope, intercept, count } where slope is kg/ms and intercept is the
    // weight at t=0. Null when fewer than 2 points (no line possible).
    function regressLastN(data, n) {
        const count = Math.min(n, data.length);
        if (count < 2) return null;
        const slice = data.slice(data.length - count);
        let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
        for (const p of slice) {
            const x = p.date.getTime();
            const y = p.weight;
            sumX += x;
            sumY += y;
            sumXY += x * y;
            sumXX += x * x;
        }
        const denom = count * sumXX - sumX * sumX;
        if (denom === 0) return null;
        const slope = (count * sumXY - sumX * sumY) / denom;
        const intercept = (sumY - slope * sumX) / count;
        if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return null;
        return { slope, intercept, count };
    }

    function fmtDateTick(d) {
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        return `${dd}.${mm}`;
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

        const displayUnit = (typeof options.unit === 'string' && options.unit.toLowerCase() === 'lb')
            ? 'lb' : 'kg';
        const toDisplay = displayUnit === 'lb'
            ? (kg) => kg / KG_PER_LB
            : (kg) => kg;
        // Y bounds are kg-based constants; convert them so lb users above ~400 lb
        // (≈181 kg) aren't clipped at the chart top.
        const yFloor = toDisplay(Y_FLOOR);
        const yCeil = toDisplay(Y_CEIL);

        const normalized = rawLogs.map(normalize).filter(Boolean);
        if (normalized.length === 0) return makeEmptyCard(range);

        normalized.sort((a, b) => a.date - b.date);
        const filtered = filterByRange(normalized, range);
        if (filtered.length === 0) return makeEmptyCard(range);

        for (const d of filtered) {
            d.weight = toDisplay(d.weight);
        }

        const width = finiteOrDefault(options.width, DEFAULT_WIDTH);
        const height = finiteOrDefault(options.height, DEFAULT_HEIGHT);
        const plotW = width - PAD_L - PAD_R;
        const plotH = height - PAD_T - PAD_B;

        const data = downsample(filtered, plotW);
        if (data.length === 0) return makeEmptyCard(range);

        const goalInfo = extractGoal(options.goal);
        const goalValueKg = goalInfo ? goalInfo.valueKg : null;
        const goalValue = goalValueKg != null ? toDisplay(goalValueKg) : null;

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
        const boundedMin = Math.max(yFloor, Math.min(yCeil, dataMin));
        const boundedMax = Math.max(yFloor, Math.min(yCeil, dataMax));
        const yMin = Math.max(yFloor, Math.floor((boundedMin - 2) / 2) * 2);
        const yMax = Math.min(yCeil, Math.ceil((boundedMax + 2) / 2) * 2);
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
        const interiorTicks = ticks.filter((t) => t > yMin && t < yMax);
        for (const tick of interiorTicks) {
            svg.appendChild(makeGuideLine(PAD_L, width - PAD_R, yOf(tick), tick));
        }
        // Render tick LABELS at every tick (including bounds) so the user sees
        // a proper numeric scale down the left gutter — previously only
        // interior ticks had labels, which meant short ranges could show a
        // single label and left the top/bottom of the plot unanchored.
        // Guide lines stay interior-only to avoid doubling the outer frame.
        const labelTicks = ticks.length > 0 ? ticks : [yMin, yMax];
        for (const tick of labelTicks) {
            svg.appendChild(
                makeTickText(PAD_L - 4, yOf(tick) + 3, tick, 'wg-weight-chart__y-tick-label', 'end'),
            );
        }
        svg.dataset.weightTickCount = String(interiorTicks.length);

        // Plan trajectory line.
        //
        // Snapshot path — when /api/weight/goal carries the trajectory anchors
        // `goal_set_at` + `goal_start_weight` alongside `goal_date`, draw the
        // visible segment of the line through (setAt, startWeight) → (goalDate,
        // goal). Slope changes (when the user moves only goal_date or only the
        // target weight) become visible because both anchors are real
        // commitments, not just chart-edge endpoints.
        //
        // Fallback path — legacy goals without snapshot anchors (raw number,
        // legacy settings row, or a `{goal}` payload missing snapshot fields)
        // keep the original `(first log → goal at last log)` geometry so users
        // who set their goal before this rollout still see a plan line.
        //
        // yOf clamps to chart Y bounds, so trajectories whose endpoints fall
        // outside the visible range clip naturally at the top or bottom edge.
        if (goalValue != null && data.length > 0) {
            const first = data[0];
            const last = data[data.length - 1];
            const firstT = first.date.getTime();
            const lastT = last.date.getTime();
            // Skip the snapshot branch when only one log is visible — both
            // endpoints map to the same X coordinate (xOf(firstT) === xOf(lastT)),
            // so the plan line would collapse to an invisible zero-length stub.
            // Fall through to the legacy single-point goal-height geometry.
            const hasSnapshot = goalInfo
                && goalInfo.setAtMs != null
                && goalInfo.startWeightKg != null
                && goalInfo.dateMs != null
                && goalInfo.dateMs !== goalInfo.setAtMs
                && data.length >= 2;
            if (hasSnapshot) {
                const wA = toDisplay(goalInfo.startWeightKg);
                const wB = goalValue;
                const tA = goalInfo.setAtMs;
                const tB = goalInfo.dateMs;
                const slope = (wB - wA) / (tB - tA);
                const wL = wA + slope * (firstT - tA);
                const wR = wA + slope * (lastT - tA);
                if (Number.isFinite(wL) && Number.isFinite(wR)) {
                    svg.appendChild(
                        makePlanLine(xOf(firstT), yOf(wL), xOf(lastT), yOf(wR)),
                    );
                }
            } else {
                svg.appendChild(
                    makePlanLine(
                        xOf(firstT),
                        yOf(first.weight),
                        xOf(lastT),
                        yOf(goalValue),
                    ),
                );
            }
        }

        if (goalValue != null) {
            svg.appendChild(makeGoalLine(PAD_L, width - PAD_R, yOf(goalValue), goalValue));
            const goalY = Math.max(PAD_T + 10, yOf(goalValue) - 5);
            const goalLabel = displayUnit === 'lb'
                ? `GOAL · ${goalValue.toFixed(1)} lb`
                : `GOAL · ${goalValue} kg`;
            svg.appendChild(
                makeTickText(
                    width - PAD_R - 4,
                    goalY,
                    goalLabel,
                    'wg-weight-chart__goal-label',
                    'end',
                ),
            );
        }

        // Trend line — linear regression on the last 14 data points. Rendered
        // as a dashed line so users can see whether they're converging on the
        // goal at their current pace. Skip when there's only one point.
        const trend = regressLastN(data, 14);
        if (trend) {
            const tStart = data[data.length - trend.count].date.getTime();
            const tEnd = data[data.length - 1].date.getTime();
            const wStart = trend.intercept + trend.slope * tStart;
            const wEnd = trend.intercept + trend.slope * tEnd;
            if (Number.isFinite(wStart) && Number.isFinite(wEnd)) {
                svg.appendChild(
                    makeTrendLine(xOf(tStart), yOf(wStart), xOf(tEnd), yOf(wEnd)),
                );
            }
        }

        const linePath = makePath(buildSplinePath(points), 'wg-weight-chart__line');
        svg.appendChild(linePath);

        if (window.ChartUtils && typeof window.ChartUtils.animateLine === 'function') {
            window.ChartUtils.animateLine(linePath);
        }

        const last = data[data.length - 1];
        svg.appendChild(makeLastCircle(xOf(last.date.getTime()), yOf(last.weight)));

        // X-axis date ticks — anchor on first + last data point so users can
        // orient the chart span. Skip when we only have a single point.
        if (data.length >= 2) {
            svg.appendChild(
                makeTickText(
                    PAD_L,
                    height - 6,
                    fmtDateTick(data[0].date),
                    'wg-weight-chart__x-tick-label',
                    'start',
                ),
            );
            svg.appendChild(
                makeTickText(
                    width - PAD_R,
                    height - 6,
                    fmtDateTick(data[data.length - 1].date),
                    'wg-weight-chart__x-tick-label',
                    'end',
                ),
            );
        }

        return svg;
    }

    window.WGWeightChart = {
        render: renderWeightChart,
        DEFAULT_WIDTH,
        DEFAULT_HEIGHT,
    };
})();
