
// ==================== Blood Pressure Functions ====================

// Get BP category based on ISH 2020 guidelines (for users < 65 years)
function getBPCategory(sys, dia) {
    // Grade 2 Hypertension: ≥160 and/or ≥100
    if (sys >= 160 || dia >= 100) return { label: 'Grade 2 HTN', class: 'grade2' };
    // Grade 1 Hypertension: 140-159 and/or 90-99
    if (sys >= 140 || dia >= 90) return { label: 'Grade 1 HTN', class: 'grade1' };
    // High-normal: 130-139 and/or 85-89
    if (sys >= 130 || dia >= 85) return { label: 'High-normal', class: 'highnormal' };
    // Normal: <130 and <85
    return { label: 'Normal', class: 'normal' };
}

// Show BP recording modal
function showBPRecordModal() {
    window.ModalManager.bp.open();

    // Set default datetime to now
    document.getElementById('bp-datetime').value = formatDateTimeLocalForInput();

    // Clear other fields
    document.getElementById('bp-systolic').value = '';
    document.getElementById('bp-diastolic').value = '';
    document.getElementById('bp-pulse').value = '';
    document.getElementById('bp-notes').value = '';
    document.getElementById('bp-site').value = 'right_arm';
    document.getElementById('bp-position').value = 'seated';

    // Focus the systolic field
    document.getElementById('bp-systolic').focus();
}

// Close BP modal
function closeBPRecordModal() {
    window.ModalManager.bp.close();
}

// Handle BP form submission
async function handleBPSubmit(event) {
    event.preventDefault();

    const datetime = document.getElementById('bp-datetime').value;
    const systolic = parseInt(document.getElementById('bp-systolic').value);
    const diastolic = parseInt(document.getElementById('bp-diastolic').value);
    const pulse = document.getElementById('bp-pulse').value ? parseInt(document.getElementById('bp-pulse').value) : null;
    const site = document.getElementById('bp-site').value;
    const position = document.getElementById('bp-position').value;
    const notes = document.getElementById('bp-notes').value;

    if (!datetime || !systolic || !diastolic) {
        safeAlert('Please fill in all required fields');
        return;
    }

    const payload = {
        measured_at: new Date(datetime).toISOString(),
        systolic,
        diastolic,
        pulse,
        site,
        position,
        notes
    };

    const res = await apiCall('/api/bp', 'POST', payload);

    if (res) {
        await window.DataStore.invalidateTags(['bp']);
        closeBPRecordModal();
        loadBPReadings();
    }
}

// Load BP readings from API (with offline support)
async function loadBPReadings() {
    const list = document.getElementById('bp-list');
    await window.DataStore.loadSWR({
        key: 'bp',
        tags: ['bp'],
        fetcher: async () => {
            const [readingsRes, goalRes, statsRes] = await Promise.all([
                apiCall('/api/bp?days=60'),
                apiCall('/api/bp/goal'),
                apiCall('/api/bp/stats')
            ]);
            if (readingsRes === null) return null;
            return { readingsRes, goalRes, statsRes };
        },
        onCached: async (cached) => {
            await _renderBPData(cached.readingsRes, cached.goalRes, cached.statsRes);
        },
        onFresh: async (fresh) => {
            await _renderBPData(fresh.readingsRes, fresh.goalRes, fresh.statsRes);
        },
        onError: async (e, cached) => {
            console.error('Failed to load BP data:', e);
            if (!cached) {
                list.replaceChildren(createEmptyState('Failed to load readings'));
            }
        }
    });
}

async function _renderBPData(readingsRes, goalRes, statsRes) {
    const list = document.getElementById('bp-list');

    // Merge server data with pending local writes
    let allReadings = readingsRes || [];
    if (window.MedTrackerDB) {
        try {
            const pendingReadings = await window.MedTrackerDB.BPStore.getPending();
            const pendingFormatted = pendingReadings.map(r => ({
                id: `local_${r.localId}`,
                localId: r.localId,
                measured_at: r.measured_at,
                systolic: r.systolic,
                diastolic: r.diastolic,
                pulse: r.pulse,
                site: r.site,
                position: r.position,
                notes: r.notes,
                isLocal: true
            }));
            allReadings = [...pendingFormatted, ...allReadings];
        } catch (e) {
            console.error('Failed to get pending BP readings:', e);
        }
    }

    if (allReadings.length === 0 && readingsRes === null) {
        list.replaceChildren(createEmptyState('Failed to load readings'));

        return;
    }

    renderBPChart(allReadings, goalRes || {});
    renderBPAverages(statsRes || {});

    // Filter list to only show last 3 days (Today, Yesterday, and Day Before)
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 2);
    cutoff.setHours(0, 0, 0, 0);

    const filteredReadings = allReadings.filter(r => new Date(r.measured_at) >= cutoff);
    renderBPReadings(filteredReadings);
}

// Render BP Chart with color-coded points and segments
function renderBPChart(readings, goalData) {
    const container = document.getElementById('bpChart');
    if (!container) return;

    container.replaceChildren();

    if (!readings || readings.length === 0) {
        const noDataSpan = document.createElement('span');
        noDataSpan.className = 'no-data-msg';
        noDataSpan.textContent = "No data available";
        container.appendChild(noDataSpan);
        return;
    }

    // Sort by date (oldest first)
    const sorted = [...readings].sort((a, b) => new Date(a.measured_at) - new Date(b.measured_at));

    // Extract data series with classifications
    const data = sorted.map(r => ({
        date: new Date(r.measured_at),
        sys: r.systolic,
        dia: r.diastolic,
        pulse: r.pulse,
        category: getBPCategory(r.systolic, r.diastolic)
    }));

    // Calculate averages
    const avgSys = data.reduce((sum, d) => sum + d.sys, 0) / data.length;
    const avgDia = data.reduce((sum, d) => sum + d.dia, 0) / data.length;

    // Dimensions
    const leftPadding = 40;
    const totalWidth = container.clientWidth;
    const chartWidth = totalWidth - leftPadding - 10;
    const chartHeight = container.clientHeight - 35;

    // Find min/max across all series
    let minVal = Math.min(...data.map(d => d.dia), ...data.filter(d => d.pulse).map(d => d.pulse));
    let maxVal = Math.max(...data.map(d => d.sys), ...data.filter(d => d.pulse).map(d => d.pulse));

    // Include averages in range
    minVal = Math.min(minVal, avgDia);
    maxVal = Math.max(maxVal, avgSys);

    // Round to nice values for Y-axis
    minVal = Math.floor(minVal / 10) * 10;
    maxVal = Math.ceil(maxVal / 10) * 10;

    const range = maxVal - minVal || 1;
    const yPad = 10; // Fixed padding
    const effectiveMin = minVal - yPad;
    const effectiveMax = maxVal + yPad;
    const effectiveRange = effectiveMax - effectiveMin;

    // Determine Y-axis interval (10 or 20)
    const yInterval = (effectiveRange > 80) ? 20 : 10;

    // Date range
    const firstDate = data[0].date;
    const lastDate = data[data.length - 1].date;
    const dateRange = lastDate - firstDate || 1;

    const xScaleByDate = (date) => leftPadding + ((date - firstDate) / dateRange) * chartWidth;
    const yScale = (v) => chartHeight - ((v - effectiveMin) / effectiveRange) * chartHeight;

    // Get color for BP classification
    const getClassColor = (category) => {
        const colorMap = {
            'normal': '#22c55e',
            'highnormal': '#eab308',
            'grade1': '#f97316',
            'grade2': '#ef4444'
        };
        return colorMap[category.class] || '#22c55e';
    };

    // SVG Construction
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("viewBox", `0 0 ${totalWidth} ${chartHeight + 20}`);

    // Y-Axis Labels at regular intervals
    const bpTickVals = [];
    for (let val = Math.ceil(effectiveMin / yInterval) * yInterval; val <= effectiveMax; val += yInterval) {
        bpTickVals.push(val);
    }
    bpTickVals.forEach((val, idx) => {
        const y = yScale(val);
        const text = document.createElementNS(svgNs, "text");
        text.setAttribute("x", leftPadding - 5);
        text.setAttribute("y", y + 4);
        text.setAttribute("class", "chart-label");
        text.setAttribute("style", "text-anchor: end; fill: var(--hint-color); font-size: 11px;");
        text.textContent = val;
        svg.appendChild(text);

        // Skip outermost grid lines to avoid box feel
        if (idx === 0 || idx === bpTickVals.length - 1) return;
        const gridLine = document.createElementNS(svgNs, "line");
        gridLine.setAttribute("x1", leftPadding);
        gridLine.setAttribute("y1", y);
        gridLine.setAttribute("x2", totalWidth - 10);
        gridLine.setAttribute("y2", y);
        gridLine.setAttribute("class", "chart-grid-refined");
        svg.appendChild(gridLine);
    });

    // Draw average lines (dotted)
    const avgSysY = yScale(avgSys);
    const avgSysLine = document.createElementNS(svgNs, "line");
    avgSysLine.setAttribute("x1", leftPadding);
    avgSysLine.setAttribute("y1", avgSysY);
    avgSysLine.setAttribute("x2", totalWidth - 10);
    avgSysLine.setAttribute("y2", avgSysY);
    avgSysLine.setAttribute("class", "bp-chart-avg-line");
    svg.appendChild(avgSysLine);

    const avgDiaY = yScale(avgDia);
    const avgDiaLine = document.createElementNS(svgNs, "line");
    avgDiaLine.setAttribute("x1", leftPadding);
    avgDiaLine.setAttribute("y1", avgDiaY);
    avgDiaLine.setAttribute("x2", totalWidth - 10);
    avgDiaLine.setAttribute("y2", avgDiaY);
    avgDiaLine.setAttribute("class", "bp-chart-avg-line");
    svg.appendChild(avgDiaLine);

    // Build coordinate arrays for spline paths
    const sysPoints = data.map(d => [xScaleByDate(d.date), yScale(d.sys)]);
    const diaPoints = data.map(d => [xScaleByDate(d.date), yScale(d.dia)]);

    // Determine dominant color from latest reading for spline lines
    const lastReading = data[data.length - 1];
    const sysColor = getClassColor(lastReading.category);
    const diaColor = getClassColor(lastReading.category);

    // Generate spline path strings
    const sysSplineD = window.ChartUtils.catmullRomSpline(sysPoints);
    const diaSplineD = window.ChartUtils.catmullRomSpline(diaPoints);

    // Gradient fill area under systolic spline
    if (data.length >= 2) {
        window.ChartUtils.createGradient(svgNs, svg, 'grad-bp-sys', sysColor, 0.15);
        const sysAreaD = sysSplineD
            + ` L ${xScaleByDate(data[data.length - 1].date)},${chartHeight}`
            + ` L ${xScaleByDate(data[0].date)},${chartHeight} Z`;
        const sysArea = document.createElementNS(svgNs, "path");
        sysArea.setAttribute("d", sysAreaD);
        sysArea.setAttribute("fill", "url(#grad-bp-sys)");
        svg.appendChild(sysArea);
    }

    // Smooth spline path for systolic
    const sysPath = document.createElementNS(svgNs, "path");
    sysPath.setAttribute("d", sysSplineD);
    sysPath.setAttribute("stroke", sysColor);
    sysPath.setAttribute("stroke-width", "2.5");
    sysPath.setAttribute("fill", "none");
    sysPath.classList.add("chart-line");
    svg.appendChild(sysPath);

    // Smooth spline path for diastolic
    const diaPath = document.createElementNS(svgNs, "path");
    diaPath.setAttribute("d", diaSplineD);
    diaPath.setAttribute("stroke", diaColor);
    diaPath.setAttribute("stroke-width", "2.5");
    diaPath.setAttribute("fill", "none");
    diaPath.classList.add("chart-line");
    svg.appendChild(diaPath);

    // Smooth spline path for pulse (if data has pulse readings)
    const pulseData = data.filter(d => d.pulse);
    if (pulseData.length >= 2) {
        const pulsePoints = pulseData.map(d => [xScaleByDate(d.date), yScale(d.pulse)]);
        const pulseSplineD = window.ChartUtils.catmullRomSpline(pulsePoints);
        const pulsePath = document.createElementNS(svgNs, "path");
        pulsePath.setAttribute("d", pulseSplineD);
        pulsePath.setAttribute("stroke", "var(--color-info)");
        pulsePath.setAttribute("stroke-width", "1.5");
        pulsePath.setAttribute("stroke-dasharray", "4 3");
        pulsePath.setAttribute("fill", "none");
        pulsePath.classList.add("chart-line");
        svg.appendChild(pulsePath);
    }

    // Draw color-coded points for systolic
    data.forEach(d => {
        const x = xScaleByDate(d.date);
        const y = yScale(d.sys);
        const color = getClassColor(d.category);

        const circle = document.createElementNS(svgNs, "circle");
        circle.setAttribute("cx", x);
        circle.setAttribute("cy", y);
        circle.setAttribute("r", 4);
        circle.setAttribute("fill", color);
        circle.setAttribute("stroke", "var(--bg-color)");
        circle.setAttribute("stroke-width", "2");
        svg.appendChild(circle);
    });

    // Draw color-coded points for diastolic
    data.forEach(d => {
        const x = xScaleByDate(d.date);
        const y = yScale(d.dia);
        const color = getClassColor(d.category);

        const circle = document.createElementNS(svgNs, "circle");
        circle.setAttribute("cx", x);
        circle.setAttribute("cy", y);
        circle.setAttribute("r", 4);
        circle.setAttribute("fill", color);
        circle.setAttribute("stroke", "var(--bg-color)");
        circle.setAttribute("stroke-width", "2");
        svg.appendChild(circle);
    });

    // Date labels
    const firstLabel = document.createElementNS(svgNs, "text");
    firstLabel.setAttribute("x", leftPadding);
    firstLabel.setAttribute("y", chartHeight + 15);
    firstLabel.setAttribute("class", "chart-label");
    firstLabel.setAttribute("style", "text-anchor: start;");
    firstLabel.textContent = data[0].date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    svg.appendChild(firstLabel);

    const lastLabel = document.createElementNS(svgNs, "text");
    lastLabel.setAttribute("x", totalWidth - 10);
    lastLabel.setAttribute("y", chartHeight + 15);
    lastLabel.setAttribute("class", "chart-label");
    lastLabel.setAttribute("style", "text-anchor: end;");
    lastLabel.textContent = data[data.length - 1].date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    svg.appendChild(lastLabel);

    container.appendChild(svg);
}

// Render BP averages from backend-calculated daily-weighted stats
function renderBPAverages(stats) {
    const container = document.getElementById('bp-averages');
    if (!container) return;

    // Check if stats object has any data
    if (!stats || (!stats.stats_14 && !stats.stats_30 && !stats.stats_60)) {
        container.replaceChildren();
        return;
    }

    const row = document.createElement('div');
    row.className = 'bp-avg-row';

    const appendAverageItem = (label, stat) => {
        row.appendChild(createStatItem(
            `${label} (${stat.days}d)`, `${stat.systolic}/${stat.diastolic}`,
            { className: 'bp-avg-item', labelClass: 'bp-avg-label', valueClass: 'bp-avg-value' }
        ));
    };

    if (stats.stats_14) appendAverageItem('14d', stats.stats_14);
    if (stats.stats_30) appendAverageItem('30d', stats.stats_30);
    if (stats.stats_60) appendAverageItem('60d', stats.stats_60);

    container.replaceChildren(row);
}

// Render BP readings grouped by date
function renderBPReadings(readings) {
    const list = document.getElementById('bp-list');
    list.replaceChildren();

    if (!readings || readings.length === 0) {
        return;
    }

    // Group readings by date
    const groups = { today: [], yesterday: [], older: [] };
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    readings.forEach(r => {
        const date = new Date(r.measured_at);
        date.setHours(0, 0, 0, 0);

        if (date.getTime() === today.getTime()) {
            groups.today.push(r);
        } else if (date.getTime() === yesterday.getTime()) {
            groups.yesterday.push(r);
        } else {
            groups.older.push(r);
        }
    });

    // Helper to render a group
    const renderGroup = (headerText, groupReadings) => {
        if (groupReadings.length === 0) return null;

        // Sort readings within this group by time (newest first)
        const sortedReadings = [...groupReadings].sort((a, b) =>
            new Date(b.measured_at) - new Date(a.measured_at)
        );

        const groupItem = document.createElement('li');
        groupItem.className = 'bp-date-group';

        const header = document.createElement('div');
        header.className = 'bp-date-header';
        header.textContent = headerText;

        const groupList = document.createElement('ul');
        groupList.className = 'list-reset';
        groupItem.appendChild(header);
        groupItem.appendChild(groupList);

        sortedReadings.forEach(r => {
            const category = getBPCategory(r.systolic, r.diastolic);
            const [, timeStr = ''] = formatDate(r.measured_at).split(' '); // Get HH:MM part
            const pendingClass = r.isLocal ? ' pending-sync' : '';

            const item = document.createElement('li');
            item.className = `bp-item${pendingClass}`;

            const reading = document.createElement('div');
            reading.className = 'bp-reading';

            const values = document.createElement('div');
            values.className = 'bp-values';

            const sys = document.createElement('span');
            sys.className = 'bp-sys';
            sys.textContent = String(r.systolic);

            const dia = document.createElement('span');
            dia.className = 'bp-dia';
            dia.textContent = `/${r.diastolic}`;

            values.appendChild(sys);
            values.appendChild(dia);

            if (r.isLocal) {
                values.appendChild(createSyncBadge());
            }

            const meta = document.createElement('div');
            meta.className = 'bp-meta';

            const time = document.createElement('span');
            time.textContent = timeStr;
            meta.appendChild(time);

            if (r.pulse) {
                const pulse = document.createElement('span');
                pulse.className = 'bp-pulse';
                pulse.textContent = `${r.pulse} bpm`;
                meta.appendChild(pulse);
            }

            const categoryEl = document.createElement('span');
            categoryEl.className = `bp-category ${category.class}`;
            categoryEl.textContent = category.label;
            meta.appendChild(categoryEl);

            reading.appendChild(values);
            reading.appendChild(meta);

            item.appendChild(reading);
            item.appendChild(createDeleteButton(() => deleteBPReading(String(r.id))));
            groupList.appendChild(item);
        });

        return groupItem;
    };

    // Render groups in order
    const todayGroup = renderGroup('Today', groups.today);
    const yesterdayGroup = renderGroup('Yesterday', groups.yesterday);

    if (todayGroup) list.appendChild(todayGroup);
    if (yesterdayGroup) list.appendChild(yesterdayGroup);

    if (groups.older.length > 0) {
        // Format older dates
        const olderGroups = new Map();
        groups.older.forEach(r => {
            const d = new Date(r.measured_at);
            const key = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
            if (!olderGroups.has(key)) olderGroups.set(key, []);
            olderGroups.get(key).push(r);
        });

        olderGroups.forEach((olderReadings, dateKey) => {
            const olderGroup = renderGroup(dateKey, olderReadings);
            if (olderGroup) list.appendChild(olderGroup);
        });
    }
}

// Delete a BP reading
async function deleteBPReading(id) {
    const confirmMsg = 'Delete this blood pressure reading?';

    await safeConfirm(confirmMsg, async (ok) => {
        if (ok) await _deleteBPApi(id);
    });
}

async function _deleteBPApi(id) {
    // Check if this is a local-only reading
    if (typeof id === 'string' && id.startsWith('local_')) {
        const localId = parseInt(id.replace('local_', ''));
        if (window.MedTrackerDB) {
            await window.MedTrackerDB.BPStore.confirmDelete(localId);
            if (window.SyncManager) window.SyncManager.updateStatus();
        }
        loadBPReadings();
        return;
    }

    const res = await apiCall(`/api/bp/${id}`, 'DELETE');
    if (res) {
        await window.DataStore.invalidateTags(['bp']);
        // Also remove from local IndexedDB if it exists there
        if (window.MedTrackerDB) {
            try {
                // Find and delete the local record with this serverId
                const allReadings = await window.MedTrackerDB.BPStore.getAll();
                const localRecord = allReadings.find(r => r.serverId === parseInt(id));
                if (localRecord && localRecord.localId) {
                    await window.MedTrackerDB.BPStore.confirmDelete(localRecord.localId);
                    if (window.SyncManager) window.SyncManager.updateStatus();
                }
            } catch (e) {
                console.error('Failed to delete from local DB:', e);
            }
        }
        loadBPReadings();
    }
}

// Export BP data to CSV
async function exportBPCSV() {
    try {
        const response = await fetch('/api/bp/export', {
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
        downloadBlobAsFile(blob, 'blood_pressure_export.csv');
    } catch (err) {
        console.error('Export error:', err);
        safeAlert('Failed to export data');
    }
}
