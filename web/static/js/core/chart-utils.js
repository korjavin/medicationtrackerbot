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

        // Handle zero or near-zero range (all values identical or very close)
        if (range < 1) {
            const mid = Math.round((yMin + yMax) / 2);
            return [mid - 5, mid, mid + 5];
        }

        // Small ranges (1-19): use unit-based intervals to avoid empty ticks
        if (range < 20) {
            const interval = range <= 5 ? 1 : 2;
            const start = Math.floor(yMin);
            const ticks = [];
            for (let val = start; val <= Math.ceil(yMax); val += interval) {
                ticks.push(val);
            }
            return ticks;
        }

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
        const niceInterval = Math.ceil(range / targetTicks / 5) * 5 || 5;
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
     * @param {number} cx - Center X coordinate
     * @param {number} cy - Center Y coordinate
     * @param {string} color - Dot fill color
     * @returns {SVGGElement} Group containing the dot and pulse ring
     */
    function createLastValueDot(svgNs, cx, cy, color) {
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

    /**
     * Classify BP reading by ISH 2020 guidelines.
     * Duplicated here to keep chart-utils self-contained (bp.js has its own copy).
     */
    function _classifyBP(sys, dia) {
        if (sys >= 160 || dia >= 100) return { label: 'Grade 2 HTN', class: 'grade2' };
        if (sys >= 140 || dia >= 90) return { label: 'Grade 1 HTN', class: 'grade1' };
        if (sys >= 130 || dia >= 85) return { label: 'High-normal', class: 'highnormal' };
        return { label: 'Normal', class: 'normal' };
    }

    /**
     * Aggregate BP readings for chart noise reduction.
     *
     * Readings older than `recentDays` are collapsed to one point per calendar day
     * using time-weighted averaging (weight = duration until next reading that day).
     * Readings within `recentDays` pass through unchanged.
     *
     * @param {Array<{date: Date, sys: number, dia: number, pulse: number, category: string}>} readings
     * @param {number} recentDays - Days to keep individual readings (default 7)
     * @returns {Array<{date: Date, sys: number, dia: number, pulse: number, category: string, aggregated?: boolean}>}
     */
    function aggregateToDaily(readings, recentDays = 7) {
        if (!readings || readings.length === 0) return [];

        const now = new Date();
        const cutoff = new Date(now);
        cutoff.setDate(cutoff.getDate() - recentDays);
        cutoff.setHours(0, 0, 0, 0);

        const recent = [];
        // Group old readings by calendar day (YYYY-MM-DD)
        const oldByDay = new Map();

        for (const r of readings) {
            if (r.date >= cutoff) {
                recent.push(r);
            } else {
                const dayKey = r.date.getFullYear() + '-' +
                    String(r.date.getMonth() + 1).padStart(2, '0') + '-' +
                    String(r.date.getDate()).padStart(2, '0');
                if (!oldByDay.has(dayKey)) oldByDay.set(dayKey, []);
                oldByDay.get(dayKey).push(r);
            }
        }

        const aggregated = [];
        for (const [, dayReadings] of oldByDay) {
            if (dayReadings.length === 1) {
                aggregated.push({ ...dayReadings[0], aggregated: true });
                continue;
            }

            // Sort chronologically within the day
            dayReadings.sort((a, b) => a.date - b.date);

            // End of day for weight calculation
            const dayStart = new Date(dayReadings[0].date);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(dayStart);
            dayEnd.setDate(dayEnd.getDate() + 1);

            let totalWeight = 0;
            let weightedSys = 0;
            let weightedDia = 0;
            let weightedPulse = 0;

            for (let i = 0; i < dayReadings.length; i++) {
                const nextTime = i < dayReadings.length - 1
                    ? dayReadings[i + 1].date.getTime()
                    : dayEnd.getTime();
                const weight = nextTime - dayReadings[i].date.getTime();
                totalWeight += weight;
                weightedSys += dayReadings[i].sys * weight;
                weightedDia += dayReadings[i].dia * weight;
                weightedPulse += (dayReadings[i].pulse || 0) * weight;
            }

            const avgSys = Math.round(weightedSys / totalWeight);
            const avgDia = Math.round(weightedDia / totalWeight);
            const avgPulse = Math.round(weightedPulse / totalWeight);

            // Place at midpoint of the day's readings
            const midTime = (dayReadings[0].date.getTime() + dayReadings[dayReadings.length - 1].date.getTime()) / 2;

            aggregated.push({
                date: new Date(midTime),
                sys: avgSys,
                dia: avgDia,
                pulse: avgPulse,
                category: _classifyBP(avgSys, avgDia),
                aggregated: true,
            });
        }

        // Merge and sort by date
        return [...aggregated, ...recent].sort((a, b) => a.date - b.date);
    }

    /**
     * Largest-Triangle-Three-Buckets (LTTB) downsampling.
     *
     * Reduces point count while preserving the visual shape of the data.
     * Always keeps the first and last points; selects the most visually
     * significant point from each bucket based on triangle area.
     *
     * @param {number[][]} points - Array of [x, y] coordinate pairs
     * @param {number} targetCount - Desired number of output points
     * @returns {number[][]} Downsampled array of [x, y] pairs
     */
    function lttbDownsample(points, targetCount) {
        if (!points || points.length <= targetCount || targetCount < 2) {
            return points || [];
        }

        const len = points.length;
        const sampled = [points[0]]; // Always keep first point

        // Number of buckets for intermediate points
        const bucketCount = targetCount - 2;
        const bucketSize = (len - 2) / bucketCount;

        let prevSelected = 0; // Index of previously selected point

        for (let i = 0; i < bucketCount; i++) {
            // Current bucket range (indices into points, offset by 1 to skip first point)
            const bucketStart = Math.floor(i * bucketSize) + 1;
            const bucketEnd = Math.min(Math.floor((i + 1) * bucketSize) + 1, len - 1);

            // Next bucket average (or last point for the final bucket)
            let nextAvgX = 0;
            let nextAvgY = 0;
            const nextBucketStart = Math.floor((i + 1) * bucketSize) + 1;
            const nextBucketEnd = i + 1 < bucketCount
                ? Math.min(Math.floor((i + 2) * bucketSize) + 1, len - 1)
                : len; // Last bucket uses the last point
            const nextCount = nextBucketEnd - nextBucketStart;

            if (nextCount > 0) {
                for (let j = nextBucketStart; j < nextBucketEnd; j++) {
                    nextAvgX += points[j][0];
                    nextAvgY += points[j][1];
                }
                nextAvgX /= nextCount;
                nextAvgY /= nextCount;
            } else {
                // Fallback to last point
                nextAvgX = points[len - 1][0];
                nextAvgY = points[len - 1][1];
            }

            // Find point in current bucket with largest triangle area
            let maxArea = -1;
            let bestIdx = bucketStart;
            const ax = points[prevSelected][0];
            const ay = points[prevSelected][1];

            for (let j = bucketStart; j < bucketEnd; j++) {
                // Triangle area (doubled, sign doesn't matter — we want max absolute)
                const area = Math.abs(
                    (ax - nextAvgX) * (points[j][1] - ay) -
                    (ax - points[j][0]) * (nextAvgY - ay)
                );
                if (area > maxArea) {
                    maxArea = area;
                    bestIdx = j;
                }
            }

            sampled.push(points[bestIdx]);
            prevSelected = bestIdx;
        }

        sampled.push(points[len - 1]); // Always keep last point
        return sampled;
    }

    return {
        catmullRomSpline,
        calculateYAxisTicks,
        createGradient,
        animateLine,
        createLastValueDot,
        aggregateToDaily,
        lttbDownsample,
    };
})();
