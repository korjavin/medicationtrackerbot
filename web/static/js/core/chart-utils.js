/**
 * chart-utils.js — Shared chart utility functions for SVG charts.
 *
 * Provides: catmullRomSpline, calculateYAxisTicks, createGradient,
 * animateLine, createLastValueDot.
 *
 * Depends on: nothing (loaded before feature scripts).
 * Consumed by: features/weight.js, features/bp.js, features/health.js
 */

window.ChartUtils = (() => {
    'use strict';

    /**
     * Catmull-Rom spline interpolation for smooth SVG curves.
     * @param {number[][]} points - Array of [x, y] coordinate pairs
     * @param {number} segments - Interpolation segments between each pair (default 20)
     * @returns {string} SVG path d-attribute string
     */
    function catmullRomSpline(points, segments = 20) {
        if (!points || points.length === 0) return '';
        if (points.length === 1) return `M ${points[0][0]},${points[0][1]}`;
        if (points.length === 2) return `M ${points[0][0]},${points[0][1]} L ${points[1][0]},${points[1][1]}`;

        let path = `M ${points[0][0]},${points[0][1]}`;

        for (let i = 0; i < points.length - 1; i++) {
            const p0 = points[Math.max(i - 1, 0)];
            const p1 = points[i];
            const p2 = points[i + 1];
            const p3 = points[Math.min(i + 2, points.length - 1)];

            for (let t = 0; t <= segments; t++) {
                const tt = t / segments;
                const tt2 = tt * tt;
                const tt3 = tt2 * tt;

                const q0 = -tt3 + 2 * tt2 - tt;
                const q1 = 3 * tt3 - 5 * tt2 + 2;
                const q2 = -3 * tt3 + 4 * tt2 + tt;
                const q3 = tt3 - tt2;

                const x = 0.5 * (p0[0] * q0 + p1[0] * q1 + p2[0] * q2 + p3[0] * q3);
                const y = 0.5 * (p0[1] * q0 + p1[1] * q1 + p2[1] * q2 + p3[1] * q3);

                path += ` L ${x},${y}`;
            }
        }

        return path;
    }

    /**
     * Calculate appropriate Y-axis tick values for a given range.
     * @param {number} yMin - Minimum value
     * @param {number} yMax - Maximum value
     * @returns {number[]} Array of tick values
     */
    function calculateYAxisTicks(yMin, yMax) {
        const range = yMax - yMin;
        const targetTicks = 6;

        // Try 5-unit intervals first
        const interval5 = 5;
        const ticks5 = Math.ceil(range / interval5);

        if (ticks5 >= 4 && ticks5 <= 8) {
            const start = Math.floor(yMin / interval5) * interval5;
            const ticks = [];
            for (let val = start; val <= yMax; val += interval5) {
                if (val >= yMin) ticks.push(val);
            }
            return ticks;
        }

        // Otherwise, use proportional division
        const niceInterval = Math.ceil(range / targetTicks / 5) * 5;
        const start = Math.floor(yMin / niceInterval) * niceInterval;
        const ticks = [];
        for (let val = start; val <= yMax; val += niceInterval) {
            if (val >= yMin) ticks.push(val);
        }
        return ticks;
    }

    /**
     * Create an SVG linear gradient (vertical, top-to-bottom).
     * @param {string} svgNs - SVG namespace URI
     * @param {SVGElement} svg - Parent SVG element (gradient is appended to its <defs>)
     * @param {string} id - Gradient element id
     * @param {string} color - CSS color for the gradient
     * @param {number} opacity - Top stop opacity (bottom fades to 0)
     * @returns {SVGLinearGradientElement} The created gradient element
     */
    function createGradient(svgNs, svg, id, color, opacity) {
        let defs = svg.querySelector('defs');
        if (!defs) {
            defs = document.createElementNS(svgNs, 'defs');
            svg.insertBefore(defs, svg.firstChild);
        }

        const gradient = document.createElementNS(svgNs, 'linearGradient');
        gradient.setAttribute('id', id);
        gradient.setAttribute('x1', '0');
        gradient.setAttribute('y1', '0');
        gradient.setAttribute('x2', '0');
        gradient.setAttribute('y2', '1');

        const stopTop = document.createElementNS(svgNs, 'stop');
        stopTop.setAttribute('offset', '0%');
        stopTop.setAttribute('stop-color', color);
        stopTop.setAttribute('stop-opacity', String(opacity));

        const stopBottom = document.createElementNS(svgNs, 'stop');
        stopBottom.setAttribute('offset', '100%');
        stopBottom.setAttribute('stop-color', color);
        stopBottom.setAttribute('stop-opacity', '0');

        gradient.appendChild(stopTop);
        gradient.appendChild(stopBottom);
        defs.appendChild(gradient);

        return gradient;
    }

    /**
     * Apply draw animation to an SVG path element using stroke-dashoffset.
     * Sets --line-length CSS custom property and adds .chart-line-animated class.
     * @param {SVGPathElement} pathElement - The path to animate
     */
    function animateLine(pathElement) {
        if (!pathElement || typeof pathElement.getTotalLength !== 'function') return;
        const length = pathElement.getTotalLength();
        pathElement.style.setProperty('--line-length', String(length));
        pathElement.classList.add('chart-line-animated');
    }

    /**
     * Create a last-value emphasis dot with pulse ring.
     * @param {string} svgNs - SVG namespace URI
     * @param {SVGElement} svg - Parent SVG element
     * @param {number} cx - Center X coordinate
     * @param {number} cy - Center Y coordinate
     * @param {string} color - Dot fill color
     * @returns {SVGGElement} Group containing the dot and pulse ring
     */
    function createLastValueDot(svgNs, svg, cx, cy, color) {
        const g = document.createElementNS(svgNs, 'g');

        // Pulse ring (behind the dot)
        const ring = document.createElementNS(svgNs, 'circle');
        ring.setAttribute('cx', String(cx));
        ring.setAttribute('cy', String(cy));
        ring.setAttribute('r', '10');
        ring.setAttribute('fill', color);
        ring.classList.add('chart-point-pulse');
        g.appendChild(ring);

        // Main dot
        const dot = document.createElementNS(svgNs, 'circle');
        dot.setAttribute('cx', String(cx));
        dot.setAttribute('cy', String(cy));
        dot.setAttribute('r', '6');
        dot.setAttribute('fill', color);
        dot.classList.add('chart-point-latest');
        g.appendChild(dot);

        return g;
    }

    return {
        catmullRomSpline,
        calculateYAxisTicks,
        createGradient,
        animateLine,
        createLastValueDot,
    };
})();
