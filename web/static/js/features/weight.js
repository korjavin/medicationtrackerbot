(function () {
    window.loadWeightLogs = async function () {
        const list = document.getElementById('weight-list');
        if (!window.DataStore) return;

        await window.DataStore.loadSWR({
            key: 'weight',
            tags: ['weight'],
            fetcher: async () => {
                const [logsRes, goalRes] = await Promise.all([
                    window.apiCall('/api/weight?days=35'),
                    window.apiCall('/api/weight/goal')
                ]);
                if (logsRes === null) return null;
                return { logsRes, goalRes };
            },
            onCached: async (cached) => {
                await window._renderWeightData(cached.logsRes, cached.goalRes);
            },
            onFresh: async (fresh) => {
                await window._renderWeightData(fresh.logsRes, fresh.goalRes);
            },
            onError: async (_error, cached) => {
                if (cached) return;
                const errLi = document.createElement('li');
                errLi.style.cssText = 'text-align:center;color:var(--hint-color);padding:20px;';
                errLi.textContent = 'Failed to load weight logs';
                if (list) list.replaceChildren(errLi);
            }
        });
    };

    window._renderWeightData = async function (logsRes, goalRes) {
        const list = document.getElementById('weight-list');
        let allLogs = logsRes || [];

        if (window.MedTrackerDB?.WeightStore) {
            try {
                const pending = await window.MedTrackerDB.WeightStore.getPending();
                const pendingFormatted = pending.map((l) => ({
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
            const errLi = document.createElement('li');
            errLi.style.cssText = 'text-align:center;color:var(--hint-color);padding:20px;';
            errLi.textContent = 'Failed to load weight logs';
            if (list) list.replaceChildren(errLi);
            return;
        }

        window.renderWeightLogs(allLogs);
        window.renderWeightChart(allLogs, goalRes || {});
    };

    window.renderWeightLogs = function (logs) {
        const list = document.getElementById('weight-list');
        if (!list) return;
        list.replaceChildren();
        if (!logs || logs.length === 0) return;

        const sorted = [...logs].sort((a, b) => new Date(b.measured_at) - new Date(a.measured_at)).slice(0, 30);
        sorted.forEach((l) => {
            const card = document.createElement('mt-card');
            card.className = `weight-item${l.isLocal ? ' pending-sync' : ''}`;

            const info = document.createElement('div');
            info.className = 'weight-info';

            const value = document.createElement('div');
            value.className = 'weight-value';
            value.textContent = `${Number(l.weight).toFixed(1)} kg`;
            if (l.isLocal) {
                const badge = document.createElement('span');
                badge.className = 'sync-pending-badge';
                badge.textContent = 'Pending';
                value.appendChild(badge);
            }

            const date = document.createElement('div');
            date.className = 'weight-date';
            date.textContent = typeof window.formatDate === 'function' ? window.formatDate(l.measured_at) : l.measured_at;
            info.appendChild(value);
            info.appendChild(date);
            if (l.notes) {
                const notes = document.createElement('div');
                notes.className = 'weight-notes';
                notes.textContent = l.notes;
                info.appendChild(notes);
            }

            card.appendChild(info);
            list.appendChild(card);
        });
    };

    window.catmullRomSpline = function (points, segments = 20) {
        if (!Array.isArray(points) || points.length === 0) return '';
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
    };

    function linearRegression(dataPoints) {
        if (!Array.isArray(dataPoints) || dataPoints.length < 2) return null;
        const n = dataPoints.length;
        let sumX = 0;
        let sumY = 0;
        let sumXY = 0;
        let sumX2 = 0;
        dataPoints.forEach((point) => {
            sumX += point.x;
            sumY += point.y;
            sumXY += point.x * point.y;
            sumX2 += point.x * point.x;
        });
        const denom = n * sumX2 - sumX * sumX;
        if (denom === 0) return null;
        const slope = (n * sumXY - sumX * sumY) / denom;
        const intercept = (sumY - slope * sumX) / n;
        return { slope, intercept };
    }

    function calculateYAxisTicks(yMin, yMax) {
        const range = yMax - yMin;
        const targetTicks = 6;
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

        const niceInterval = Math.ceil(range / targetTicks / 5) * 5;
        const start = Math.floor(yMin / niceInterval) * niceInterval;
        const ticks = [];
        for (let val = start; val <= yMax; val += niceInterval) {
            if (val >= yMin) ticks.push(val);
        }
        return ticks;
    }

    function calculateWeightStats(logs, goalData) {
        if (!logs || logs.length === 0) return null;

        const stats = {};
        const sortedDesc = [...logs].sort((a, b) => new Date(b.measured_at) - new Date(a.measured_at));
        const mostRecent = sortedDesc[0];
        stats.trendWeight = mostRecent.weight_trend || mostRecent.weight;
        stats.currentWeight = mostRecent.weight;

        const fourWeeksAgo = new Date(Date.now() - (28 * 24 * 60 * 60 * 1000));
        const recentLogs = sortedDesc
            .filter((l) => new Date(l.measured_at) >= fourWeeksAgo)
            .reverse();

        if (recentLogs.length >= 2) {
            const now = new Date();
            const regressionData = recentLogs.map((l) => ({
                x: -((now - new Date(l.measured_at)) / (1000 * 60 * 60 * 24)),
                y: l.weight
            }));
            const regression = linearRegression(regressionData);
            if (regression) stats.weeklyRate = regression.slope * 7;
        }

        if (goalData && goalData.goal && stats.weeklyRate && stats.weeklyRate < 0) {
            const weightToLose = stats.currentWeight - goalData.goal;
            const weeksNeeded = weightToLose / Math.abs(stats.weeklyRate);
            if (weeksNeeded > 0 && weeksNeeded < 520) {
                stats.forecastDate = new Date(Date.now() + weeksNeeded * 7 * 24 * 60 * 60 * 1000);
            }
        }

        if (goalData && goalData.goal) {
            stats.goalWeight = goalData.goal;
            stats.deltaFromGoal = stats.currentWeight - goalData.goal;
        }
        return stats;
    }

    window.renderWeightChart = function (logs, goalData) {
        const container = document.getElementById('weightChart');
        if (!container) return;
        container.replaceChildren();

        if (!logs || logs.length === 0) {
            const noData = document.createElement('span');
            noData.style.cssText = 'color:var(--hint-color);font-size:14px;';
            noData.textContent = 'No data available';
            container.appendChild(noData);
            return;
        }

        const now = new Date();
        const chartStartDate = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
        const chartEndDate = new Date(now.getTime() + (2 * 24 * 60 * 60 * 1000));

        const periodLogs = logs
            .filter((l) => {
                const d = new Date(l.measured_at);
                return d >= chartStartDate && d <= chartEndDate;
            })
            .sort((a, b) => new Date(a.measured_at) - new Date(b.measured_at));

        if (periodLogs.length === 0) {
            const noPeriod = document.createElement('span');
            noPeriod.style.cssText = 'color:var(--hint-color);font-size:14px;';
            noPeriod.textContent = 'No data in current period';
            container.replaceChildren(noPeriod);
            return;
        }

        const data = periodLogs.map((w) => ({ date: new Date(w.measured_at), weight: w.weight }));
        const leftPadding = 50;
        const rightPadding = 45;
        const totalWidth = Math.max(container.clientWidth || 320, 320);
        const chartWidth = totalWidth - leftPadding - rightPadding;
        const chartHeight = Math.max((container.clientHeight || 240) - 50, 160);

        const weightsInPeriod = data.map((d) => d.weight);
        const maxInPeriod = Math.max(...weightsInPeriod);
        const minInPeriod = Math.min(...weightsInPeriod);
        let yMax = maxInPeriod + 5;
        let yMin = minInPeriod;
        if (goalData && goalData.goal) yMin = Math.min(goalData.goal - 3, minInPeriod);
        const yTicks = calculateYAxisTicks(yMin, yMax);

        const dateRange = chartEndDate - chartStartDate || 1;
        const xScaleByDate = (date) => leftPadding + ((date - chartStartDate) / dateRange) * chartWidth;
        const yScale = (weight) => chartHeight - ((weight - yMin) / (yMax - yMin || 1)) * chartHeight;

        const svgNs = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.setAttribute('viewBox', `0 0 ${totalWidth} ${chartHeight + 30}`);

        yTicks.forEach((val) => {
            const y = yScale(val);
            const gridLine = document.createElementNS(svgNs, 'line');
            gridLine.setAttribute('x1', leftPadding);
            gridLine.setAttribute('y1', y);
            gridLine.setAttribute('x2', totalWidth - rightPadding);
            gridLine.setAttribute('y2', y);
            gridLine.setAttribute('class', 'chart-grid');
            svg.appendChild(gridLine);

            const text = document.createElementNS(svgNs, 'text');
            text.setAttribute('x', leftPadding - 5);
            text.setAttribute('y', y + 4);
            text.setAttribute('style', 'text-anchor:end;fill:var(--hint-color);font-size:12px;');
            text.textContent = val.toFixed(0);
            svg.appendChild(text);
        });

        if (goalData && goalData.goal) {
            const goalY = yScale(goalData.goal);
            const goalLine = document.createElementNS(svgNs, 'line');
            goalLine.setAttribute('x1', leftPadding);
            goalLine.setAttribute('y1', goalY);
            goalLine.setAttribute('x2', totalWidth - rightPadding);
            goalLine.setAttribute('y2', goalY);
            goalLine.setAttribute('stroke', '#22c55e');
            goalLine.setAttribute('stroke-width', '2');
            goalLine.setAttribute('class', 'chart-goal-line');
            svg.appendChild(goalLine);

            const goalLabel = document.createElementNS(svgNs, 'text');
            goalLabel.setAttribute('x', totalWidth - rightPadding + 5);
            goalLabel.setAttribute('y', goalY + 4);
            goalLabel.setAttribute('style', 'text-anchor:start;fill:#22c55e;font-weight:bold;font-size:11px;');
            goalLabel.textContent = 'Goal';
            svg.appendChild(goalLabel);
        }

        // Diet plan line from highest weight (all time) to goal
        if (goalData && goalData.goal && goalData.goal_date && goalData.highest_weight && goalData.highest_date) {
            const highestDate = new Date(goalData.highest_date);
            const highestWeight = goalData.highest_weight;
            const goalDate = new Date(goalData.goal_date);
            const goalWeight = goalData.goal;

            const totalTimeSpan = goalDate - highestDate;
            const weightDiff = goalWeight - highestWeight;

            if (totalTimeSpan > 0) {
                const getWeightAtDate = (date) => {
                    const elapsed = date - highestDate;
                    return highestWeight + (weightDiff * elapsed / totalTimeSpan);
                };

                let startDate = highestDate < chartStartDate ? chartStartDate : highestDate;
                let endDate = goalDate > chartEndDate ? chartEndDate : goalDate;

                const startWeight = getWeightAtDate(startDate);
                const endWeight = getWeightAtDate(endDate);

                const startX = xScaleByDate(startDate);
                const startY = yScale(startWeight);
                const endX = xScaleByDate(endDate);
                const endY = yScale(endWeight);

                const planLine = document.createElementNS(svgNs, 'line');
                planLine.setAttribute('x1', startX);
                planLine.setAttribute('y1', startY);
                planLine.setAttribute('x2', endX);
                planLine.setAttribute('y2', endY);
                planLine.setAttribute('stroke', '#06b6d4');
                planLine.setAttribute('stroke-width', '2');
                planLine.setAttribute('stroke-dasharray', '5,5');
                planLine.setAttribute('opacity', '0.6');
                svg.appendChild(planLine);

                const now = new Date();
                if (now >= highestDate && now <= goalDate) {
                    const todayPlanWeight = getWeightAtDate(now);
                    const todayX = xScaleByDate(now);
                    const todayY = yScale(todayPlanWeight);

                    const todayMarker = document.createElementNS(svgNs, 'circle');
                    todayMarker.setAttribute('cx', todayX);
                    todayMarker.setAttribute('cy', todayY);
                    todayMarker.setAttribute('r', 4);
                    todayMarker.setAttribute('fill', '#06b6d4');
                    todayMarker.setAttribute('stroke', 'var(--bg-color)');
                    todayMarker.setAttribute('stroke-width', '2');
                    svg.appendChild(todayMarker);

                    const todayLabel = document.createElementNS(svgNs, 'text');
                    todayLabel.setAttribute('x', todayX);
                    todayLabel.setAttribute('y', todayY - 12);
                    todayLabel.setAttribute('style', 'text-anchor:middle;fill:#06b6d4;font-weight:bold;font-size:12px;');
                    todayLabel.textContent = todayPlanWeight.toFixed(1) + ' kg';
                    svg.appendChild(todayLabel);
                }
            }
        }

        const points = data.map((d) => [xScaleByDate(d.date), yScale(d.weight)]);
        const smoothPath = window.catmullRomSpline(points, 15);
        const firstPoint = points[0];
        const lastPoint = points[points.length - 1];
        const areaPath = `${smoothPath} L ${lastPoint[0]},${chartHeight} L ${firstPoint[0]},${chartHeight} Z`;

        const area = document.createElementNS(svgNs, 'path');
        area.setAttribute('d', areaPath);
        area.setAttribute('fill', 'rgba(59, 130, 246, 0.1)');
        svg.appendChild(area);

        const line = document.createElementNS(svgNs, 'path');
        line.setAttribute('d', smoothPath);
        line.setAttribute('stroke', '#3b82f6');
        line.setAttribute('stroke-width', '3');
        line.setAttribute('fill', 'none');
        svg.appendChild(line);

        points.forEach((p) => {
            const circle = document.createElementNS(svgNs, 'circle');
            circle.setAttribute('cx', p[0]);
            circle.setAttribute('cy', p[1]);
            circle.setAttribute('r', '4');
            circle.setAttribute('fill', '#3b82f6');
            circle.setAttribute('stroke', 'var(--bg-color)');
            circle.setAttribute('stroke-width', '2');
            svg.appendChild(circle);
        });

        const lastDataPoint = points[points.length - 1];
        const currentLabel = document.createElementNS(svgNs, 'text');
        currentLabel.setAttribute('x', lastDataPoint[0]);
        currentLabel.setAttribute('y', lastDataPoint[1] - 12);
        currentLabel.setAttribute('style', 'text-anchor:middle;fill:#3b82f6;font-weight:bold;font-size:12px;');
        currentLabel.textContent = `${data[data.length - 1].weight.toFixed(1)} kg`;
        svg.appendChild(currentLabel);

        const firstDateLabel = document.createElementNS(svgNs, 'text');
        firstDateLabel.setAttribute('x', leftPadding);
        firstDateLabel.setAttribute('y', chartHeight + 20);
        firstDateLabel.setAttribute('style', 'text-anchor:start;fill:var(--hint-color);font-size:11px;');
        firstDateLabel.textContent = chartStartDate.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' });
        svg.appendChild(firstDateLabel);

        const lastDateLabel = document.createElementNS(svgNs, 'text');
        lastDateLabel.setAttribute('x', totalWidth - rightPadding);
        lastDateLabel.setAttribute('y', chartHeight + 20);
        lastDateLabel.setAttribute('style', 'text-anchor:end;fill:var(--hint-color);font-size:11px;');
        lastDateLabel.textContent = chartEndDate.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' });
        svg.appendChild(lastDateLabel);

        container.appendChild(svg);

        const stats = calculateWeightStats(logs, goalData);
        if (stats) window.renderWeightStats(stats);
    };

    window.renderWeightStats = function (statsOrLogs, goalData) {
        let stats = statsOrLogs;
        if (Array.isArray(statsOrLogs)) {
            stats = calculateWeightStats(statsOrLogs, goalData || {});
        }
        const statsContainer = document.getElementById('weight-stats');
        if (!statsContainer) return;
        if (!stats) {
            statsContainer.replaceChildren();
            return;
        }

        const root = document.createElement('mt-card');
        root.className = 'weight-stats-container';

        const leftColumn = document.createElement('div');
        leftColumn.className = 'weight-stats-column';
        const rightColumn = document.createElement('div');
        rightColumn.className = 'weight-stats-column';

        const appendStatItem = (column, label, value) => {
            const item = document.createElement('div');
            item.className = 'weight-stat-item';
            const labelEl = document.createElement('span');
            labelEl.className = 'weight-stat-label';
            labelEl.textContent = `${label}:`;
            const valueEl = document.createElement('span');
            valueEl.className = 'weight-stat-value';
            valueEl.textContent = value;
            item.appendChild(labelEl);
            item.appendChild(document.createTextNode(' '));
            item.appendChild(valueEl);
            column.appendChild(item);
        };

        appendStatItem(leftColumn, 'Trend', `${stats.trendWeight.toFixed(1)} kg`);
        if (stats.weeklyRate !== undefined) {
            const rateStr = stats.weeklyRate >= 0
                ? `+${stats.weeklyRate.toFixed(1)} kg/week`
                : `${stats.weeklyRate.toFixed(1)} kg/week`;
            appendStatItem(leftColumn, 'Rate', rateStr);
        }
        if (stats.forecastDate) {
            const dateStr = stats.forecastDate.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
            appendStatItem(leftColumn, 'Forecast', dateStr);
        } else {
            appendStatItem(leftColumn, 'Forecast', 'Unknown');
        }

        if (stats.goalWeight !== undefined) {
            appendStatItem(rightColumn, 'Goal', `${stats.goalWeight.toFixed(1)} kg`);
            const deltaStr = stats.deltaFromGoal >= 0
                ? `+${stats.deltaFromGoal.toFixed(1)} kg`
                : `${stats.deltaFromGoal.toFixed(1)} kg`;
            appendStatItem(rightColumn, '\u0394 from goal', deltaStr);
        }

        root.appendChild(leftColumn);
        root.appendChild(rightColumn);
        statsContainer.replaceChildren(root);
    };

    window.showWeightRecordModal = function () {
        if (window.ModalManager && window.ModalManager.weight) window.ModalManager.weight.open();
        const dt = document.getElementById('weight-datetime');
        if (dt && typeof window.formatDateTimeLocalForInput === 'function') dt.value = window.formatDateTimeLocalForInput();
        const notesEl = document.getElementById('weight-notes');
        if (notesEl) notesEl.value = '';
        setWeightValue(rulerState.currentWeight);
    };

    window.showWeightModal = window.showWeightRecordModal;
    window.closeWeightModal = function () {
        if (window.ModalManager && window.ModalManager.weight) window.ModalManager.weight.close();
    };

    window.handleWeightSubmit = async function (event) {
        event.preventDefault();
        const dt = document.getElementById('weight-datetime')?.value;
        const val = parseFloat(document.getElementById('weight-value')?.value);
        const notes = document.getElementById('weight-notes')?.value || '';
        if (!dt || isNaN(val)) {
            if (typeof window.safeAlert === 'function') window.safeAlert('Please fill in weight');
            return;
        }
        const res = await window.apiCall('/api/weight', 'POST', {
            measured_at: new Date(dt).toISOString(),
            weight: val,
            notes
        });
        if (!res) return;
        if (window.DataStore) await window.DataStore.invalidateTags(['weight']);
        window.closeWeightModal();
        window.loadWeightLogs();
    };

    let weightControlsBound = false;
    function bindWeightControls() {
        if (weightControlsBound) return;
        weightControlsBound = true;

        const addBtn = document.getElementById('add-weight-btn');
        if (addBtn) addBtn.addEventListener('click', () => window.showWeightModal());
        const cancelBtn = document.getElementById('weight-modal-cancel-btn');
        if (cancelBtn) cancelBtn.addEventListener('click', () => window.closeWeightModal());
    }

    // Weight ruler state
    let rulerState = {
        currentWeight: 75.0,
        isDragging: false,
        startX: 0,
        startWeight: 0,
        pixelsPerKg: 40
    };

    function setWeightValue(weight) {
        weight = Math.max(30, Math.min(300, weight));
        weight = Math.round(weight * 10) / 10;
        rulerState.currentWeight = weight;
        const el = document.getElementById('weight-value');
        if (el) el.value = weight.toFixed(1);
    }
    window.setWeightValue = setWeightValue;

    function handleDragStart(e) {
        rulerState.isDragging = true;
        rulerState.startWeight = rulerState.currentWeight;
        if (e.type === 'touchstart') {
            rulerState.startX = e.touches[0].clientX;
            e.preventDefault();
        } else {
            rulerState.startX = e.clientX;
        }
    }
    window.handleDragStart = handleDragStart;

    function handleDragMove(e) {
        if (!rulerState.isDragging) return;
        let currentX;
        if (e.type === 'touchmove') {
            currentX = e.touches[0].clientX;
            e.preventDefault();
        } else {
            currentX = e.clientX;
        }
        const deltaX = rulerState.startX - currentX;
        const deltaWeight = deltaX / rulerState.pixelsPerKg;
        const newWeight = rulerState.startWeight + deltaWeight;
        setWeightValue(newWeight);
        if (typeof window.renderRulerTicks === 'function') window.renderRulerTicks(newWeight);
    }
    window.handleDragMove = handleDragMove;

    function handleDragEnd() {
        if (!rulerState.isDragging) return;
        rulerState.isDragging = false;
    }
    window.handleDragEnd = handleDragEnd;

    async function deleteWeightLog(id) {
        const confirmMsg = 'Delete this weight log?';

        if (window.userInitData && window.tg && window.tg.showConfirm) {
            try {
                window.tg.showConfirm(confirmMsg, (ok) => {
                    if (ok) window._deleteWeightApi(id);
                });
                return;
            } catch (e) {
                console.log('tg.showConfirm failed, falling back', e);
            }
        }

        if (confirm(confirmMsg)) {
            window._deleteWeightApi(id);
        }
    }
    window.deleteWeightLog = deleteWeightLog;

    async function _deleteWeightApi(id) {
        if (typeof id === 'string' && id.startsWith('local_')) {
            const localId = parseInt(id.replace('local_', ''));
            if (window.MedTrackerDB) {
                await window.MedTrackerDB.WeightStore.confirmDelete(localId);
                if (window.SyncManager) window.SyncManager.updateStatus();
            }
            window.loadWeightLogs();
            return;
        }

        const res = await window.apiCall(`/api/weight/${id}`, 'DELETE');
        if (res) {
            await window.DataStore.invalidateTags(['weight']);
            if (window.MedTrackerDB) {
                try {
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
            window.loadWeightLogs();
        }
    }
    window._deleteWeightApi = _deleteWeightApi;

    async function exportWeightCSV() {
        try {
            const headers = {};
            if (window.userInitData) headers['Authorization'] = `tma ${window.userInitData}`;
            const response = await fetch('/api/weight/export', {
                method: 'GET',
                headers
            });

            if (!response.ok) {
                if (typeof window.safeAlert === 'function') window.safeAlert('Failed to generate export');
                return;
            }

            const blob = await response.blob();
            if (typeof window.downloadBlobAsFile === 'function') {
                window.downloadBlobAsFile(blob, 'weight_export.csv');
            }
        } catch (err) {
            console.error('Export error:', err);
            if (typeof window.safeAlert === 'function') window.safeAlert('Failed to export data');
        }
    }
    window.exportWeightCSV = exportWeightCSV;

    window.linearRegression = linearRegression;
    window.calculateYAxisTicks = calculateYAxisTicks;
    window.calculateWeightStats = calculateWeightStats;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindWeightControls, { once: true });
    }
    bindWeightControls();
})();
