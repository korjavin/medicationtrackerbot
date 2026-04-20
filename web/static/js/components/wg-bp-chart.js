// Wandergeek BP chart — deterministic SVG renderer for the systolic /
// diastolic history view. Ported from the handoff prototype
// (components.jsx:BPChart, lines 84-148) with these constraints:
//
//   • No inline stroke=/fill= on paths or circles. Every visual value
//     comes from a --wg-* token via a class on the SVG child element
//     (`.wg-bp-chart__sys`, `__dia`, `__band`, `__guide`, `__last`).
//   • Reuses window.ChartUtils for numerics (aggregation, LTTB
//     downsampling, Catmull-Rom spline, line animation) — no duplication.
//
// API:
//   WGBpChart.render({ readings, goal, width, height, range }) → SVGElement | null
//
//   readings — Array<{ measured_at, systolic, diastolic, pulse? }>
//              or already-normalised { date, sys, dia, pulse? }.
//              Empty/invalid input returns null.
//   goal     — optional BP goal payload (currently unused; reserved so
//              the caller signature matches renderBPChart(readings, goal)).
//   width    — coord-space width (defaults to 358; SVG scales to fill container).
//   height   — coord-space height (defaults to 200).
//   range    — optional day-window label (forwarded in dataset only).
//
// The returned <svg> carries the base class `wg-bp-chart`; consumers
// style it purely through the child classes listed above.

(function () {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const DEFAULT_WIDTH = 358;
    const DEFAULT_HEIGHT = 200;
    const PAD_L = 28;
    const PAD_R = 14;
    const PAD_T = 14;
    const PAD_B = 26;
    const Y_FLOOR = 40;
    const Y_CEIL = 260;
    const Y_DEFAULT_MIN = 50;
    const Y_DEFAULT_MAX = 160;
    const GUIDE_VALUES = [80, 120];
    const LAST_POINT_RADIUS = 4;

    function finiteOrDefault(value, fallback) {
        return Number.isFinite(value) ? value : fallback;
    }

    function normalize(raw) {
        if (!raw) return null;
        const dateSrc = raw.measured_at != null ? raw.measured_at : raw.date;
        const date = dateSrc instanceof Date ? dateSrc : new Date(dateSrc);
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
        const sys = Number(raw.systolic != null ? raw.systolic : raw.sys);
        const dia = Number(raw.diastolic != null ? raw.diastolic : raw.dia);
        if (!Number.isFinite(sys) || !Number.isFinite(dia)) return null;
        const pulseRaw = raw.pulse != null ? raw.pulse : null;
        const pulse = pulseRaw != null && Number.isFinite(Number(pulseRaw)) ? Number(pulseRaw) : null;
        return { date, sys, dia, pulse };
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

    function buildBandPath(sysPoints, diaPoints) {
        if (!sysPoints.length || sysPoints.length !== diaPoints.length) return '';
        const forward = sysPoints
            .map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`)
            .join(' ');
        const reverse = diaPoints
            .slice()
            .reverse()
            .map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`)
            .join(' ');
        return `${forward} ${reverse} Z`;
    }

    function aggregateAndDownsample(points, plotW) {
        const utils = window.ChartUtils;
        let data = points;
        if (utils && typeof utils.aggregateToDaily === 'function') {
            data = utils.aggregateToDaily(points.map((p) => ({ ...p })), 7);
        }
        if (!data || data.length === 0) return [];
        const targetPoints = Math.max(30, Math.floor(plotW / 6));
        if (utils && typeof utils.lttbDownsample === 'function' && data.length > targetPoints) {
            const downsampled = utils.lttbDownsample(
                data.map((d) => [d.date.getTime(), d.sys]),
                targetPoints,
            );
            const kept = new Set(downsampled.map((p) => p[0]));
            data = data.filter((d) => kept.has(d.date.getTime()));
        }
        return data;
    }

    function makeLine(x1, x2, y, value) {
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', String(x1));
        line.setAttribute('x2', String(x2));
        line.setAttribute('y1', y.toFixed(1));
        line.setAttribute('y2', y.toFixed(1));
        line.dataset.bpGuide = String(value);
        line.classList.add('wg-bp-chart__guide');
        return line;
    }

    function makePath(d, className) {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        path.classList.add(className);
        return path;
    }

    function makeLastCircle(cx, cy, series) {
        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('cx', cx.toFixed(1));
        circle.setAttribute('cy', cy.toFixed(1));
        circle.setAttribute('r', String(LAST_POINT_RADIUS));
        circle.dataset.bpSeries = series;
        circle.classList.add('wg-bp-chart__last');
        return circle;
    }

    function renderBpChart(opts) {
        const options = opts || {};
        const rawReadings = Array.isArray(options.readings) ? options.readings : [];
        if (rawReadings.length === 0) return null;

        const normalized = rawReadings.map(normalize).filter(Boolean);
        if (normalized.length === 0) return null;

        normalized.sort((a, b) => a.date - b.date);

        const width = finiteOrDefault(options.width, DEFAULT_WIDTH);
        const height = finiteOrDefault(options.height, DEFAULT_HEIGHT);
        const plotW = width - PAD_L - PAD_R;
        const plotH = height - PAD_T - PAD_B;

        const data = aggregateAndDownsample(normalized, plotW);
        if (data.length === 0) return null;

        const firstTime = data[0].date.getTime();
        const lastTime = data[data.length - 1].date.getTime();
        const timeSpan = (lastTime - firstTime) || 1;
        const xOf = (t) => PAD_L + ((t - firstTime) / timeSpan) * plotW;

        // Y-axis bounds derived from the data so hypertensive readings (>160)
        // and very low diastolics don't escape the plot area. Guide values
        // (80/120) always fit; bounds are clamped to absolute floor/ceiling.
        let dataMin = Y_DEFAULT_MIN;
        let dataMax = Y_DEFAULT_MAX;
        for (const d of data) {
            if (d.dia < dataMin) dataMin = d.dia;
            if (d.sys > dataMax) dataMax = d.sys;
        }
        const yMin = Math.max(Y_FLOOR, Math.floor((dataMin - 5) / 10) * 10);
        const yMax = Math.min(Y_CEIL, Math.ceil((dataMax + 5) / 10) * 10);
        const yRange = (yMax - yMin) || 1;
        const yOf = (v) => PAD_T + plotH - ((v - yMin) / yRange) * plotH;

        const sysPoints = data.map((d) => [xOf(d.date.getTime()), yOf(d.sys)]);
        const diaPoints = data.map((d) => [xOf(d.date.getTime()), yOf(d.dia)]);

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', 'auto');
        svg.setAttribute('aria-hidden', 'true');
        svg.classList.add('wg-bp-chart');
        if (typeof options.range === 'number' || typeof options.range === 'string') {
            svg.dataset.bpRange = String(options.range);
        }

        for (const value of GUIDE_VALUES) {
            svg.appendChild(makeLine(PAD_L, width - PAD_R, yOf(value), value));
        }

        const bandD = buildBandPath(sysPoints, diaPoints);
        if (bandD) svg.appendChild(makePath(bandD, 'wg-bp-chart__band'));

        const sysPath = makePath(buildSplinePath(sysPoints), 'wg-bp-chart__sys');
        svg.appendChild(sysPath);

        const diaPath = makePath(buildSplinePath(diaPoints), 'wg-bp-chart__dia');
        svg.appendChild(diaPath);

        if (window.ChartUtils && typeof window.ChartUtils.animateLine === 'function') {
            window.ChartUtils.animateLine(sysPath);
            window.ChartUtils.animateLine(diaPath);
        }

        const last = data[data.length - 1];
        const lastX = xOf(last.date.getTime());
        svg.appendChild(makeLastCircle(lastX, yOf(last.sys), 'sys'));
        svg.appendChild(makeLastCircle(lastX, yOf(last.dia), 'dia'));

        return svg;
    }

    window.WGBpChart = {
        render: renderBpChart,
        DEFAULT_WIDTH,
        DEFAULT_HEIGHT,
    };
})();
