// Wandergeek Vitals chart — deterministic SVG renderer for the Health
// Overview HR / SpO2 / Stress cards. Ports the bespoke renderVitalsLineChart
// from features/health.js under the shared component conventions. One
// component parameterised by `vital` drives the three variants — the only
// difference is the colour token + y-range defaults.
//
//   • No inline stroke=/fill= on paths or circles. Every visual value
//     comes from a design token via a CSS class on the SVG child element
//     (`.wg-vitals-chart__area`, `__line`, `__last`, `__guide`,
//     `__axis-label`, `__day-label`), plus the vital modifier
//     (`.wg-vitals-chart--{vital}`) on the root svg so CSS can key off it.
//   • Reuses window.ChartUtils.animateLine when available.
//
// API:
//   WGVitalsChart.render({ history, range, vital, width, height, yMin, yMax })
//     → Element
//
//   history — Array<{ timestamp, min, max, avg }>. timestamp may be a
//             number (ms), a Date, or an ISO-like string. Empty / invalid
//             input returns an empty-state card element (not null) so the
//             caller can always append the result.
//   range   — '7d' | '30d' | 'all' (default 'all'); filters entries to the
//             most recent N days, anchored on Date.now(). Forwarded in the
//             dataset.
//   vital   — 'hr' | 'spo2' | 'stress' (default 'hr'). Drives the colour
//             token via CSS class on the root SVG + the empty-state copy.
//   width   — coord-space width (default 358; SVG scales to container).
//   height  — coord-space height (default 200).
//   yMin,
//   yMax    — optional overrides of the vital's default y-range.
//
// Empty-state returns a <div class="wg-vitals-chart wg-vitals-chart--empty
// wg-vitals-chart--{vital}"> carrying "No {vital} data yet". The data path
// returns an <svg class="wg-vitals-chart wg-vitals-chart--{vital}">.

(function () {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const DEFAULT_WIDTH = 358;
    const DEFAULT_HEIGHT = 200;
    const PAD_L = 35;
    const PAD_R = 10;
    const PAD_T = 20;
    const PAD_B = 30;
    const LAST_POINT_RADIUS = 4;
    const Y_AXIS_STEPS = 4;
    const X_LABEL_COUNT = 4;
    const GAP_SPLIT_MS = 3 * 3600 * 1000;
    const RANGE_DAYS = {
        '7d': 7,
        '30d': 30,
    };

    const VITAL_SPECS = {
        hr:     { yMin: 40,  yMax: 160, emptyLabel: 'heart rate' },
        spo2:   { yMin: 85,  yMax: 100, emptyLabel: 'SpO2' },
        stress: { yMin: 0,   yMax: 100, emptyLabel: 'stress' },
    };
    const DEFAULT_VITAL = 'hr';

    function finiteOrDefault(value, fallback) {
        return Number.isFinite(value) ? value : fallback;
    }

    function resolveVital(vital) {
        if (typeof vital === 'string' && VITAL_SPECS[vital]) return vital;
        return DEFAULT_VITAL;
    }

    function toTimestamp(src) {
        if (src == null) return NaN;
        if (typeof src === 'number') return src;
        if (src instanceof Date) return src.getTime();
        if (typeof src === 'string') {
            const n = Number(src);
            if (Number.isFinite(n)) return n;
            const d = new Date(src);
            const t = d.getTime();
            return Number.isFinite(t) ? t : NaN;
        }
        return NaN;
    }

    function normalize(raw) {
        if (!raw) return null;
        const timestamp = toTimestamp(raw.timestamp);
        if (!Number.isFinite(timestamp)) return null;
        const avg = Number(raw.avg);
        if (!Number.isFinite(avg)) return null;
        const min = Number.isFinite(Number(raw.min)) ? Number(raw.min) : avg;
        const max = Number.isFinite(Number(raw.max)) ? Number(raw.max) : avg;
        return { timestamp, min, max, avg };
    }

    function filterByRange(data, range) {
        if (!range || range === 'all') return data;
        const days = RANGE_DAYS[range];
        if (!days) return data;
        if (data.length === 0) return data;
        const now = Date.now();
        const cutoff = now - days * 86400000;
        return data.filter((d) => d.timestamp >= cutoff && d.timestamp <= now);
    }

    function makeEmptyCard(vital, range) {
        const spec = VITAL_SPECS[vital];
        const card = document.createElement('div');
        card.classList.add(
            'wg-vitals-chart',
            'wg-vitals-chart--empty',
            `wg-vitals-chart--${vital}`,
        );
        card.dataset.vitalsVital = vital;
        card.dataset.vitalsRange = range || 'all';
        const msg = document.createElement('span');
        msg.classList.add('wg-vitals-chart__empty-msg');
        msg.textContent = `No ${spec.emptyLabel} data yet`;
        card.appendChild(msg);
        return card;
    }

    function makeAxisLabel(x, y, value) {
        const el = document.createElementNS(SVG_NS, 'text');
        el.setAttribute('x', String(x));
        el.setAttribute('y', String(y));
        el.setAttribute('text-anchor', 'end');
        el.classList.add('wg-vitals-chart__axis-label');
        el.textContent = String(value);
        return el;
    }

    function makeDayLabel(x, y, value) {
        const el = document.createElementNS(SVG_NS, 'text');
        el.setAttribute('x', String(x));
        el.setAttribute('y', String(y));
        el.setAttribute('text-anchor', 'middle');
        el.classList.add('wg-vitals-chart__day-label');
        el.textContent = String(value);
        return el;
    }

    function makeGuide(x1, x2, y) {
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', String(x1));
        line.setAttribute('x2', String(x2));
        line.setAttribute('y1', y.toFixed(1));
        line.setAttribute('y2', y.toFixed(1));
        line.classList.add('wg-vitals-chart__guide');
        return line;
    }

    function makePath(d, className) {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        path.classList.add(className);
        return path;
    }

    function makeLastDot(cx, cy) {
        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('cx', cx.toFixed(1));
        circle.setAttribute('cy', cy.toFixed(1));
        circle.setAttribute('r', String(LAST_POINT_RADIUS));
        circle.classList.add('wg-vitals-chart__last');
        return circle;
    }

    function renderVitalsChart(opts) {
        const options = opts || {};
        const vital = resolveVital(options.vital);
        const spec = VITAL_SPECS[vital];
        const range = typeof options.range === 'string' ? options.range : 'all';
        const rawHistory = Array.isArray(options.history) ? options.history : [];
        if (rawHistory.length === 0) return makeEmptyCard(vital, range);

        const normalized = rawHistory.map(normalize).filter(Boolean);
        if (normalized.length === 0) return makeEmptyCard(vital, range);

        normalized.sort((a, b) => a.timestamp - b.timestamp);
        const data = options.prefiltered ? normalized : filterByRange(normalized, range);
        if (data.length === 0) return makeEmptyCard(vital, range);

        const width = finiteOrDefault(options.width, DEFAULT_WIDTH);
        const height = finiteOrDefault(options.height, DEFAULT_HEIGHT);
        const plotW = width - PAD_L - PAD_R;
        const plotH = height - PAD_T - PAD_B;

        const yMin = finiteOrDefault(options.yMin, spec.yMin);
        const yMax = finiteOrDefault(options.yMax, spec.yMax);
        const valRange = Math.max(yMax - yMin, 1);

        const minTime = data[0].timestamp;
        const maxTime = data[data.length - 1].timestamp;
        const timeRange = Math.max(maxTime - minTime, 1);

        const xOf = (t) => {
            if (data.length === 1) return PAD_L + plotW / 2;
            return PAD_L + ((t - minTime) / timeRange) * plotW;
        };
        const yOf = (v) => {
            const clamped = v < yMin ? yMin : v > yMax ? yMax : v;
            return PAD_T + plotH - ((clamped - yMin) / valRange) * plotH;
        };

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', 'auto');
        svg.setAttribute('aria-hidden', 'true');
        svg.classList.add('wg-vitals-chart', `wg-vitals-chart--${vital}`);
        svg.dataset.vitalsVital = vital;
        svg.dataset.vitalsRange = range;
        svg.dataset.vitalsPointCount = String(data.length);
        svg.dataset.vitalsYMin = String(yMin);
        svg.dataset.vitalsYMax = String(yMax);

        // Y-axis labels + inner guide grid. Skip outermost guides to avoid
        // the "box" feel, matching the sleep + steps chart convention.
        const innerTickCount = Math.max(0, Y_AXIS_STEPS - 1);
        svg.dataset.vitalsTickCount = String(innerTickCount);
        for (let i = 0; i <= Y_AXIS_STEPS; i++) {
            const val = Math.round(yMin + (i / Y_AXIS_STEPS) * valRange);
            const y = PAD_T + plotH - (i / Y_AXIS_STEPS) * plotH;
            svg.appendChild(makeAxisLabel(PAD_L - 8, y + 4, val));
            if (i > 0 && i < Y_AXIS_STEPS) {
                svg.appendChild(makeGuide(PAD_L, PAD_L + plotW, y));
            }
        }

        // Area path — forward along max, reverse along min. When only one
        // point is present the area collapses; skip it in that case.
        if (data.length > 1) {
            let dArea = '';
            data.forEach((pt, i) => {
                const cx = xOf(pt.timestamp);
                const cy = yOf(pt.max);
                dArea += (i === 0
                    ? `M ${cx.toFixed(1)},${cy.toFixed(1)}`
                    : ` L ${cx.toFixed(1)},${cy.toFixed(1)}`);
            });
            for (let i = data.length - 1; i >= 0; i--) {
                const cx = xOf(data[i].timestamp);
                const cy = yOf(data[i].min);
                dArea += ` L ${cx.toFixed(1)},${cy.toFixed(1)}`;
            }
            dArea += ' Z';
            svg.appendChild(makePath(dArea, 'wg-vitals-chart__area'));
        }

        // Line path (avg). Split segments when the gap between samples
        // exceeds GAP_SPLIT_MS so long idle periods don't carry a visible
        // line across them.
        const paths = [];
        let currentPath = '';
        let lastTs = null;
        data.forEach((pt) => {
            const cx = xOf(pt.timestamp);
            const cy = yOf(pt.avg);
            if (lastTs !== null && (pt.timestamp - lastTs) > GAP_SPLIT_MS) {
                if (currentPath) paths.push(currentPath);
                currentPath = `M ${cx.toFixed(1)},${cy.toFixed(1)}`;
            } else {
                currentPath += (currentPath === ''
                    ? `M ${cx.toFixed(1)},${cy.toFixed(1)}`
                    : ` L ${cx.toFixed(1)},${cy.toFixed(1)}`);
            }
            lastTs = pt.timestamp;
        });
        if (currentPath) paths.push(currentPath);
        paths.forEach((pd) => {
            const path = makePath(pd, 'wg-vitals-chart__line');
            svg.appendChild(path);
            if (window.ChartUtils && typeof window.ChartUtils.animateLine === 'function') {
                window.ChartUtils.animateLine(path);
            }
        });

        // Last-value dot on the rightmost sample.
        const lastPt = data[data.length - 1];
        svg.appendChild(makeLastDot(xOf(lastPt.timestamp), yOf(lastPt.avg)));

        // X-axis date labels — (N+1) evenly spaced, matching the paper-era
        // renderVitalsLineChart count of 5 labels. With a single sample xOf()
        // returns a constant center x, so emit only one label to avoid
        // stacking five identical labels on top of each other.
        const yLabel = PAD_T + plotH + 15;
        if (data.length === 1) {
            const dt = new Date(minTime);
            const text = `${dt.getMonth() + 1}/${dt.getDate()}`;
            svg.appendChild(makeDayLabel(xOf(minTime), yLabel, text));
        } else {
            for (let i = 0; i <= X_LABEL_COUNT; i++) {
                const ts = minTime + (timeRange * (i / X_LABEL_COUNT));
                const dt = new Date(ts);
                const text = `${dt.getMonth() + 1}/${dt.getDate()}`;
                svg.appendChild(makeDayLabel(xOf(ts), yLabel, text));
            }
        }

        return svg;
    }

    window.WGVitalsChart = {
        render: renderVitalsChart,
        DEFAULT_WIDTH,
        DEFAULT_HEIGHT,
    };
})();
