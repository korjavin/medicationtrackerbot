
// ==================== Weight Tracking Functions ====================

// Global variable to store weight logs for ruler component
let cachedWeightLogs = [];

function showWeightModal() {
    window.ModalManager.weight.open();

    // Set default datetime to now
    document.getElementById('weight-datetime').value = formatDateTimeLocalForInput();

    // Clear notes field
    document.getElementById('weight-notes').value = '';

    // Get last logged weight and initialize ruler
    const lastWeight = cachedWeightLogs && cachedWeightLogs.length > 0
        ? cachedWeightLogs[0].weight
        : 75.0; // Default to 75kg if no history

    // Set default value
    setWeightValue(lastWeight);

    // Initialize the ruler
    initWeightRuler(lastWeight);
}

function closeWeightModal() {
    window.ModalManager.weight.close();
}

async function handleWeightSubmit(event) {
    event.preventDefault();

    const datetime = document.getElementById('weight-datetime').value;
    const weight = parseFloat(document.getElementById('weight-value').value);
    const notes = document.getElementById('weight-notes').value;

    if (!datetime || !weight) {
        safeAlert('Please fill in all required fields');
        return;
    }

    const payload = {
        measured_at: new Date(datetime).toISOString(),
        weight,
        notes
    };

    const res = await apiCall('/api/weight', 'POST', payload);

    if (res) {
        await window.DataStore.invalidateTags(['weight']);
        closeWeightModal();
        loadWeightLogs();
    }
}

// ==================== Weight Ruler Component ====================

let rulerState = {
    currentWeight: 75.0,
    isDragging: false,
    startX: 0,
    startWeight: 0,
    pixelsPerKg: 40 // How many pixels = 1 kg
};

function setWeightValue(weight) {
    // Clamp weight between min and max
    weight = Math.max(30, Math.min(300, weight));
    weight = Math.round(weight * 10) / 10; // Round to 1 decimal

    rulerState.currentWeight = weight;

    // Update input field
    document.getElementById('weight-value').value = weight.toFixed(1);
}

function initWeightRuler(initialWeight) {
    setWeightValue(initialWeight);
    renderRulerTicks(initialWeight);
    updateRulerPosition(initialWeight);
    attachRulerEventListeners();

    // Add input event listener for manual typing
    const input = document.getElementById('weight-value');
    input.addEventListener('input', (e) => {
        const value = parseFloat(e.target.value);
        if (!isNaN(value)) {
            rulerState.currentWeight = value;
            updateRulerPosition(value);
        }
    });
}

function renderRulerTicks(centerWeight) {
    const ruler = document.getElementById('weight-ruler');
    ruler.replaceChildren(); // Clear existing ticks

    const container = document.getElementById('weight-ruler-container');
    const containerWidth = container.clientWidth;
    const centerX = containerWidth / 2;

    // Generate ticks for a range around the center weight
    const range = 15; // Show ±15 kg range
    const tickSpacing = rulerState.pixelsPerKg; // pixels between each 1kg tick

    // Calculate offset to center the current weight
    const offset = -(centerWeight - Math.floor(centerWeight - range)) * tickSpacing;

    ruler.style.transform = `translateX(${centerX + offset}px)`;

    // Generate ticks
    for (let kg = Math.floor(centerWeight - range); kg <= Math.ceil(centerWeight + range); kg++) {
        const x = (kg - Math.floor(centerWeight - range)) * tickSpacing;

        // Major tick every 1 kg
        const tick = document.createElement('div');
        tick.className = kg % 5 === 0 ? 'weight-tick major' : 'weight-tick minor';
        tick.style.left = x + 'px';
        ruler.appendChild(tick);

        // Label every 1 kg
        if (kg % 1 === 0) {
            const label = document.createElement('div');
            label.className = 'weight-tick-label';
            label.textContent = kg;
            label.style.left = x + 'px';
            ruler.appendChild(label);
        }
    }
}

function attachRulerEventListeners() {
    const container = document.getElementById('weight-ruler-container');

    // Mouse events
    container.addEventListener('mousedown', handleDragStart);
    document.addEventListener('mousemove', handleDragMove);
    document.addEventListener('mouseup', handleDragEnd);

    // Touch events
    container.addEventListener('touchstart', handleDragStart, { passive: false });
    document.addEventListener('touchmove', handleDragMove, { passive: false });
    document.addEventListener('touchend', handleDragEnd);
}

function handleDragStart(e) {
    rulerState.isDragging = true;
    rulerState.startWeight = rulerState.currentWeight;

    if (e.type === 'touchstart') {
        rulerState.startX = e.touches[0].clientX;
        e.preventDefault(); // Prevent scrolling while dragging
    } else {
        rulerState.startX = e.clientX;
    }
}

function handleDragMove(e) {
    if (!rulerState.isDragging) return;

    let currentX;
    if (e.type === 'touchmove') {
        currentX = e.touches[0].clientX;
        e.preventDefault(); // Prevent scrolling
    } else {
        currentX = e.clientX;
    }

    const deltaX = rulerState.startX - currentX; // Inverted: drag left = increase weight
    const deltaWeight = deltaX / rulerState.pixelsPerKg;

    const newWeight = rulerState.startWeight + deltaWeight;
    setWeightValue(newWeight);

    // Regenerate ticks and update position to keep ruler centered
    renderRulerTicks(newWeight);
}

function handleDragEnd(e) {
    if (!rulerState.isDragging) return;
    rulerState.isDragging = false;
}

function updateRulerPosition(weight) {
    // Simply regenerate the ticks centered on the new weight
    renderRulerTicks(weight);
}


// =================== Helper Functions for Enhanced Weight Chart ===================

// Catmull-Rom spline interpolation for smooth curves
function catmullRomSpline(points, segments = 20) {
    if (points.length < 2) return `M ${points[0][0]},${points[0][1]}`;
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

// Linear regression for trend calculation
function linearRegression(dataPoints) {
    if (dataPoints.length < 2) return null;

    const n = dataPoints.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

    dataPoints.forEach(point => {
        const x = point.x; // Time in days
        const y = point.y; // Weight
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumX2 += x * x;
    });

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    return { slope, intercept };
}

// Calculate appropriate Y-axis tick values
function calculateYAxisTicks(yMin, yMax) {
    const range = yMax - yMin;
    const targetTicks = 6; // Aim for 5-7 ticks

    // Try 5kg intervals first
    const interval5 = 5;
    const ticks5 = Math.ceil(range / interval5);

    if (ticks5 >= 4 && ticks5 <= 8) {
        // 5kg intervals work well
        const start = Math.floor(yMin / interval5) * interval5;
        const ticks = [];
        for (let val = start; val <= yMax; val += interval5) {
            if (val >= yMin) ticks.push(val);
        }
        return ticks;
    }

    // Otherwise, use proportional division
    const niceInterval = Math.ceil(range / targetTicks / 5) * 5; // Round to nearest 5
    const start = Math.floor(yMin / niceInterval) * niceInterval;
    const ticks = [];
    for (let val = start; val <= yMax; val += niceInterval) {
        if (val >= yMin) ticks.push(val);
    }
    return ticks;
}

// Calculate weight statistics
function calculateWeightStats(logs, goalData) {
    if (!logs || logs.length === 0) {
        return null;
    }

    const stats = {};

    // Trend weight from most recent entry
    const mostRecent = logs[0]; // Already sorted DESC by API
    stats.trendWeight = mostRecent.weight_trend || mostRecent.weight;
    stats.currentWeight = mostRecent.weight;

    // Calculate weekly rate using linear regression on last 4 weeks
    const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
    const recentLogs = logs
        .filter(l => new Date(l.measured_at) >= fourWeeksAgo)
        .reverse(); // Oldest first for regression

    if (recentLogs.length >= 2) {
        const now = new Date();
        const regressionData = recentLogs.map(l => {
            const date = new Date(l.measured_at);
            const daysAgo = (now - date) / (1000 * 60 * 60 * 24);
            return { x: -daysAgo, y: l.weight }; // Negative days ago (so slope is positive for weight loss)
        });

        const regression = linearRegression(regressionData);
        if (regression) {
            stats.weeklyRate = regression.slope * 7; // Convert daily rate to weekly
        }
    }

    // Calculate forecasted goal date
    if (goalData && goalData.goal && stats.weeklyRate && stats.weeklyRate < 0) {
        const weightToLose = stats.currentWeight - goalData.goal;
        const weeksNeeded = weightToLose / Math.abs(stats.weeklyRate);
        if (weeksNeeded > 0 && weeksNeeded < 520) { // Max 10 years
            const forecastDate = new Date(Date.now() + weeksNeeded * 7 * 24 * 60 * 60 * 1000);
            stats.forecastDate = forecastDate;
        }
    }

    // Current diff from goal
    if (goalData && goalData.goal) {
        stats.goalWeight = goalData.goal;
        stats.deltaFromGoal = stats.currentWeight - goalData.goal;
    }

    return stats;
}

// Render weight chart
// Enhanced version with smoothing, proper axes, diet plan line, and statistics
function renderWeightChart(logs, goalData) {
    const container = document.getElementById('weightChart');
    if (!container) return;

    container.replaceChildren(); // Clear previous

    if (!logs || logs.length === 0) {
        const noDataSpan = document.createElement('span');
        noDataSpan.className = 'no-data-msg';
        noDataSpan.textContent = "No data available";
        container.appendChild(noDataSpan);
        return;
    }

    // Chart period: -30 days to +2 days from now
    const now = new Date();
    const chartStartDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const chartEndDate = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

    // Filter and sort logs within period (sort oldest first for chart)
    const periodLogs = logs
        .filter(l => {
            const d = new Date(l.measured_at);
            return d >= chartStartDate && d <= chartEndDate;
        })
        .sort((a, b) => new Date(a.measured_at) - new Date(b.measured_at));

    if (periodLogs.length === 0) {
        const noPeriodSpan = document.createElement('span');
        noPeriodSpan.className = 'no-data-msg';
        noPeriodSpan.textContent = "No data in current period";
        container.replaceChildren(noPeriodSpan);
        return;
    }

    const data = periodLogs.map(w => ({
        date: new Date(w.measured_at),
        weight: w.weight
    }));

    // Dimensions with left padding for Y-axis
    const leftPadding = 50;
    const rightPadding = 45;
    const totalWidth = container.clientWidth;
    const chartWidth = totalWidth - leftPadding - rightPadding;
    const chartHeight = container.clientHeight - 50;

    // Y-axis range calculation
    const weightsInPeriod = data.map(d => d.weight);
    const maxInPeriod = Math.max(...weightsInPeriod);
    const minInPeriod = Math.min(...weightsInPeriod);

    let yMax = maxInPeriod + 5; // +5kg padding
    let yMin = minInPeriod;

    if (goalData && goalData.goal) {
        yMin = Math.min(goalData.goal - 3, minInPeriod);
    }

    // Calculate Y-axis ticks
    const yTicks = calculateYAxisTicks(yMin, yMax);

    // Date range
    const dateRange = chartEndDate - chartStartDate;

    // Scaling functions
    const xScaleByDate = (date) => leftPadding + ((date - chartStartDate) / dateRange) * chartWidth;
    const yScale = (weight) => chartHeight - ((weight - yMin) / (yMax - yMin)) * chartHeight;

    // SVG Construction
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("class", "chart-svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("viewBox", `0 0 ${totalWidth} ${chartHeight + 30}`);

    // Y-Axis grid lines and labels
    yTicks.forEach(val => {
        const y = yScale(val);

        // Grid line
        const gridLine = document.createElementNS(svgNs, "line");
        gridLine.setAttribute("x1", leftPadding);
        gridLine.setAttribute("y1", y);
        gridLine.setAttribute("x2", totalWidth - rightPadding);
        gridLine.setAttribute("y2", y);
        gridLine.setAttribute("class", "chart-grid");
        svg.appendChild(gridLine);

        // Label
        const text = document.createElementNS(svgNs, "text");
        text.setAttribute("x", leftPadding - 5);
        text.setAttribute("y", y + 4);
        text.setAttribute("class", "chart-label");
        text.setAttribute("style", "text-anchor: end; fill: var(--hint-color); font-size: 12px;");
        text.textContent = val.toFixed(0);
        svg.appendChild(text);
    });

    // Goal line (horizontal green line with label)
    if (goalData && goalData.goal) {
        const goalY = yScale(goalData.goal);
        const goalLine = document.createElementNS(svgNs, "line");
        goalLine.setAttribute("x1", leftPadding);
        goalLine.setAttribute("y1", goalY);
        goalLine.setAttribute("x2", totalWidth - rightPadding);
        goalLine.setAttribute("y2", goalY);
        goalLine.setAttribute("class", "chart-goal-line");
        goalLine.setAttribute("stroke", "#22c55e");
        goalLine.setAttribute("stroke-width", "2");
        svg.appendChild(goalLine);

        // Goal label on right
        const goalLabel = document.createElementNS(svgNs, "text");
        goalLabel.setAttribute("x", totalWidth - rightPadding + 5);
        goalLabel.setAttribute("y", goalY + 4);
        goalLabel.setAttribute("class", "chart-label");
        goalLabel.setAttribute("style", "text-anchor: start; fill: #22c55e; font-weight: bold; font-size: 11px;");
        goalLabel.textContent = "Goal";
        svg.appendChild(goalLabel);
    }

    // Diet plan line from highest weight (all time) to goal
    if (goalData && goalData.goal && goalData.goal_date && goalData.highest_weight && goalData.highest_date) {
        const highestDate = new Date(goalData.highest_date);
        const highestWeight = goalData.highest_weight;
        const goalDate = new Date(goalData.goal_date);
        const goalWeight = goalData.goal;

        // Calculate line equation
        const totalTimeSpan = goalDate - highestDate;
        const weightDiff = goalWeight - highestWeight;

        if (totalTimeSpan > 0) {
            const getWeightAtDate = (date) => {
                const elapsed = date - highestDate;
                return highestWeight + (weightDiff * elapsed / totalTimeSpan);
            };

            // Clip to chart boundaries
            let startDate = highestDate < chartStartDate ? chartStartDate : highestDate;
            let endDate = goalDate > chartEndDate ? chartEndDate : goalDate;

            const startWeight = getWeightAtDate(startDate);
            const endWeight = getWeightAtDate(endDate);

            const startX = xScaleByDate(startDate);
            const startY = yScale(startWeight);
            const endX = xScaleByDate(endDate);
            const endY = yScale(endWeight);

            const planLine = document.createElementNS(svgNs, "line");
            planLine.setAttribute("x1", startX);
            planLine.setAttribute("y1", startY);
            planLine.setAttribute("x2", endX);
            planLine.setAttribute("y2", endY);
            planLine.setAttribute("stroke", "#06b6d4"); // Cyan
            planLine.setAttribute("stroke-width", "2");
            planLine.setAttribute("stroke-dasharray", "5,5");
            planLine.setAttribute("opacity", "0.6");
            svg.appendChild(planLine);

            // Add label for today's diet plan weight
            // Only show if today is within the diet plan period
            if (now >= highestDate && now <= goalDate) {
                const todayPlanWeight = getWeightAtDate(now);
                const todayX = xScaleByDate(now);
                const todayY = yScale(todayPlanWeight);

                // Add a small circle marker on the diet line for today
                const todayMarker = document.createElementNS(svgNs, "circle");
                todayMarker.setAttribute("cx", todayX);
                todayMarker.setAttribute("cy", todayY);
                todayMarker.setAttribute("r", 4);
                todayMarker.setAttribute("fill", "#06b6d4");
                todayMarker.setAttribute("stroke", "var(--bg-color)");
                todayMarker.setAttribute("stroke-width", "2");
                svg.appendChild(todayMarker);

                // Add label showing today's plan weight
                const todayLabel = document.createElementNS(svgNs, "text");
                todayLabel.setAttribute("x", todayX);
                todayLabel.setAttribute("y", todayY - 12);
                todayLabel.setAttribute("class", "chart-label");
                todayLabel.setAttribute("style", "text-anchor: middle; fill: #06b6d4; font-weight: bold; font-size: 12px;");
                todayLabel.textContent = todayPlanWeight.toFixed(1) + " kg";
                svg.appendChild(todayLabel);
            }
        }
    }

    // Generate points for weight data
    const points = data.map(d => [xScaleByDate(d.date), yScale(d.weight)]);

    // Smoothed weight curve using Catmull-Rom splines
    const smoothPath = catmullRomSpline(points, 15);

    // Area under curve
    const firstPoint = points[0];
    const lastPoint = points[points.length - 1];
    const areaPath = `${smoothPath} L ${lastPoint[0]},${chartHeight} L ${firstPoint[0]},${chartHeight} Z`;

    const pathArea = document.createElementNS(svgNs, "path");
    pathArea.setAttribute("d", areaPath);
    pathArea.setAttribute("class", "chart-area");
    pathArea.setAttribute("fill", "rgba(59, 130, 246, 0.1)");
    svg.appendChild(pathArea);

    // Weight line
    const pathLine = document.createElementNS(svgNs, "path");
    pathLine.setAttribute("d", smoothPath);
    pathLine.setAttribute("class", "chart-line");
    pathLine.setAttribute("stroke", "#3b82f6");
    pathLine.setAttribute("stroke-width", "3");
    pathLine.setAttribute("fill", "none");
    svg.appendChild(pathLine);

    // Data points
    points.forEach((p, i) => {
        const circle = document.createElementNS(svgNs, "circle");
        circle.setAttribute("cx", p[0]);
        circle.setAttribute("cy", p[1]);
        circle.setAttribute("r", 4);
        circle.setAttribute("fill", "#3b82f6");
        circle.setAttribute("stroke", "var(--bg-color)");
        circle.setAttribute("stroke-width", "2");
        svg.appendChild(circle);
    });

    // Current weight label (on most recent point)
    const lastDataPoint = points[points.length - 1];
    const currentLabel = document.createElementNS(svgNs, "text");
    currentLabel.setAttribute("x", lastDataPoint[0]);
    currentLabel.setAttribute("y", lastDataPoint[1] - 12);
    currentLabel.setAttribute("class", "chart-label");
    currentLabel.setAttribute("style", "text-anchor: middle; fill: #3b82f6; font-weight: bold; font-size: 12px;");
    currentLabel.textContent = data[data.length - 1].weight.toFixed(1) + " kg";
    svg.appendChild(currentLabel);

    // Date labels (bottom)
    const firstDateLabel = document.createElementNS(svgNs, "text");
    firstDateLabel.setAttribute("x", leftPadding);
    firstDateLabel.setAttribute("y", chartHeight + 20);
    firstDateLabel.setAttribute("class", "chart-label");
    firstDateLabel.setAttribute("style", "text-anchor: start; fill: var(--hint-color); font-size: 11px;");
    firstDateLabel.textContent = chartStartDate.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    svg.appendChild(firstDateLabel);

    const lastDateLabel = document.createElementNS(svgNs, "text");
    lastDateLabel.setAttribute("x", totalWidth - rightPadding);
    lastDateLabel.setAttribute("y", chartHeight + 20);
    lastDateLabel.setAttribute("class", "chart-label");
    lastDateLabel.setAttribute("style", "text-anchor: end; fill: var(--hint-color); font-size: 11px;");
    lastDateLabel.textContent = chartEndDate.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    svg.appendChild(lastDateLabel);

    container.appendChild(svg);

    // Render statistics below the chart
    const stats = calculateWeightStats(logs, goalData);
    if (stats) {
        renderWeightStats(stats);
    }
}

// Render weight statistics below the chart
function renderWeightStats(stats) {
    const statsContainer = document.getElementById('weight-stats');
    if (!statsContainer) return;

    const root = document.createElement('div');
    root.className = 'weight-stats-container';

    const leftColumn = document.createElement('div');
    leftColumn.className = 'weight-stats-column';
    const rightColumn = document.createElement('div');
    rightColumn.className = 'weight-stats-column';

    const appendStatItem = (column, label, value) => {
        column.appendChild(createStatItem(`${label}:`, value, {
            className: 'weight-stat-item',
            labelClass: 'weight-stat-label',
            valueClass: 'weight-stat-value',
            separator: ' '
        }));
    };

    appendStatItem(leftColumn, 'Trend', `${stats.trendWeight.toFixed(1)} kg`);

    if (stats.weeklyRate !== undefined) {
        const rateStr = stats.weeklyRate >= 0
            ? `+${stats.weeklyRate.toFixed(1)} kg/week`
            : `${stats.weeklyRate.toFixed(1)} kg/week`;
        appendStatItem(leftColumn, 'Rate', rateStr);
    }

    if (stats.forecastDate) {
        const dateStr = stats.forecastDate.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
        appendStatItem(leftColumn, 'Forecast', dateStr);
    } else {
        appendStatItem(leftColumn, 'Forecast', 'Unknown');
    }

    if (stats.goalWeight !== undefined) {
        appendStatItem(rightColumn, 'Goal', `${stats.goalWeight.toFixed(1)} kg`);

        const deltaStr = stats.deltaFromGoal >= 0
            ? `+${stats.deltaFromGoal.toFixed(1)} kg`
            : `${stats.deltaFromGoal.toFixed(1)} kg`;
        appendStatItem(rightColumn, 'Δ from goal', deltaStr);
    }

    root.appendChild(leftColumn);
    root.appendChild(rightColumn);
    statsContainer.replaceChildren(root);
}


async function loadWeightLogs() {
    const list = document.getElementById('weight-list');
    await window.DataStore.loadSWR({
        key: 'weight',
        tags: ['weight'],
        fetcher: async () => {
            const [logsRes, goalRes] = await Promise.all([
                apiCall('/api/weight?days=35'),
                apiCall('/api/weight/goal')
            ]);
            if (logsRes === null) return null;
            return { logsRes, goalRes };
        },
        onCached: async (cached) => {
            await _renderWeightData(cached.logsRes, cached.goalRes);
        },
        onFresh: async (fresh) => {
            await _renderWeightData(fresh.logsRes, fresh.goalRes);
        },
        onError: async (e, cached) => {
            console.error('Failed to load weight data:', e);
            if (!cached) {
                list.replaceChildren(createEmptyState('Failed to load weight logs'));
            }
        }
    });
}

async function _renderWeightData(logsRes, goalRes) {
    const list = document.getElementById('weight-list');

    // Merge server data with pending local writes
    let allLogs = logsRes || [];
    if (window.MedTrackerDB) {
        try {
            const pendingLogs = await window.MedTrackerDB.WeightStore.getPending();
            const pendingFormatted = pendingLogs.map(l => ({
                id: `local_${l.localId}`,
                localId: l.localId,
                measured_at: l.measured_at,
                weight: l.weight,
                notes: l.notes,
                isLocal: true
            }));
            allLogs = [...pendingFormatted, ...allLogs];
        } catch (e) {
            console.error('Failed to get pending weight logs:', e);
        }
    }

    if (allLogs.length === 0 && logsRes === null) {
        list.replaceChildren(createEmptyState('Failed to load weight logs'));

        return;
    }

    // Cache logs globally for ruler component
    cachedWeightLogs = allLogs;

    renderWeightLogs(allLogs);
    renderWeightChart(allLogs, goalRes || {});
}

function renderWeightLogs(logs) {
    const list = document.getElementById('weight-list');
    list.replaceChildren();

    if (!logs || logs.length === 0) {
        return;
    }

    // Limit to 30 most recent
    if (logs.length > 30) {
        logs = logs.slice(0, 30);
    }

    logs.forEach(w => {
        const dateStr = formatDate(w.measured_at);
        const trendDiff = w.weight_trend ? (w.weight - w.weight_trend).toFixed(1) : '0.0';
        const trendIcon = trendDiff > 0 ? '📈' : (trendDiff < 0 ? '📉' : '➡️');
        const pendingClass = w.isLocal ? ' pending-sync' : '';
        const listItem = document.createElement('li');
        listItem.className = `weight-item${pendingClass}`;

        const data = document.createElement('div');
        data.className = 'weight-data';

        const value = document.createElement('div');
        value.className = 'weight-value';
        value.appendChild(document.createTextNode(`${w.weight.toFixed(1)} kg `));
        if (w.isLocal) {
            value.appendChild(createSyncBadge());
        }

        const trend = document.createElement('div');
        trend.className = 'weight-trend';
        trend.textContent = `${trendIcon} Trend: ${w.weight_trend ? w.weight_trend.toFixed(1) : w.weight.toFixed(1)} kg`;

        const meta = document.createElement('div');
        meta.className = 'weight-meta';
        meta.textContent = dateStr;

        data.appendChild(value);
        data.appendChild(trend);
        data.appendChild(meta);

        listItem.appendChild(data);
        listItem.appendChild(createDeleteButton(() => deleteWeightLog(String(w.id))));
        list.appendChild(listItem);
    });
}

async function deleteWeightLog(id) {
    const confirmMsg = 'Delete this weight log?';

    await safeConfirm(confirmMsg, async (ok) => {
        if (ok) await _deleteWeightApi(id);
    });
}

async function _deleteWeightApi(id) {
    // Check if this is a local-only log
    if (typeof id === 'string' && id.startsWith('local_')) {
        const localId = parseInt(id.replace('local_', ''));
        if (window.MedTrackerDB) {
            await window.MedTrackerDB.WeightStore.confirmDelete(localId);
            if (window.SyncManager) window.SyncManager.updateStatus();
        }
        loadWeightLogs();
        return;
    }

    const res = await apiCall(`/api/weight/${id}`, 'DELETE');
    if (res) {
        await window.DataStore.invalidateTags(['weight']);
        // Also remove from local IndexedDB if it exists there
        if (window.MedTrackerDB) {
            try {
                // Find and delete the local record with this serverId
                const allLogs = await window.MedTrackerDB.WeightStore.getAll();
                const localRecord = allLogs.find(l => l.serverId === parseInt(id));
                if (localRecord && localRecord.localId) {
                    await window.MedTrackerDB.WeightStore.confirmDelete(localRecord.localId);
                    if (window.SyncManager) window.SyncManager.updateStatus();
                }
            } catch (e) {
                console.error('Failed to delete from local DB:', e);
            }
        }
        loadWeightLogs();
    }
}

async function exportWeightCSV() {
    try {
        const response = await fetch('/api/weight/export', {
            method: 'GET',
            headers: {
                'Authorization': `tma ${userInitData}`
            }
        });

        if (!response.ok) {
            safeAlert('Failed to generate export');
            return;
        }

        const blob = await response.blob();
        downloadBlobAsFile(blob, 'weight_export.csv');
    } catch (err) {
        console.error('Export error:', err);
        safeAlert('Failed to export data');
    }
}
