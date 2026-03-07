<<<<<<< Updated upstream

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
        window.tg.showAlert('Please fill in all required fields');
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
=======
(function () {
    window.getBPCategory = function (sys, dia) {
        if (sys >= 160 || dia >= 100) return { label: 'Grade 2 HTN', class: 'grade2' };
        if (sys >= 140 || dia >= 90) return { label: 'Grade 1 HTN', class: 'grade1' };
        if (sys >= 130 || dia >= 85) return { label: 'High-normal', class: 'highnormal' };
        return { label: 'Normal', class: 'normal' };
>>>>>>> Stashed changes
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
<<<<<<< Updated upstream
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
        const errLi = document.createElement('li');
        errLi.style.cssText = 'text-align:center;color:var(--hint-color);padding:20px;';
        errLi.textContent = 'Failed to load readings';
        list.replaceChildren(errLi);
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
        noDataSpan.style.cssText = "color:var(--hint-color);font-size:14px;";
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
    for (let val = Math.ceil(effectiveMin / yInterval) * yInterval; val <= effectiveMax; val += yInterval) {
        const y = yScale(val);
        const text = document.createElementNS(svgNs, "text");
        text.setAttribute("x", leftPadding - 5);
        text.setAttribute("y", y + 4);
        text.setAttribute("class", "chart-label");
        text.setAttribute("style", "text-anchor: end; fill: var(--hint-color); font-size: 11px;");
        text.textContent = val;
        svg.appendChild(text);

        const gridLine = document.createElementNS(svgNs, "line");
        gridLine.setAttribute("x1", leftPadding);
        gridLine.setAttribute("y1", y);
        gridLine.setAttribute("x2", totalWidth - 10);
        gridLine.setAttribute("y2", y);
        gridLine.setAttribute("class", "chart-grid");
        svg.appendChild(gridLine);
    }

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

    // Draw color-coded line segments for systolic
    for (let i = 0; i < data.length - 1; i++) {
        const x1 = xScaleByDate(data[i].date);
        const y1 = yScale(data[i].sys);
        const x2 = xScaleByDate(data[i + 1].date);
        const y2 = yScale(data[i + 1].sys);
        const color = getClassColor(data[i].category);

        const line = document.createElementNS(svgNs, "line");
        line.setAttribute("x1", x1);
        line.setAttribute("y1", y1);
        line.setAttribute("x2", x2);
        line.setAttribute("y2", y2);
        line.setAttribute("stroke", color);
        line.setAttribute("stroke-width", "2.5");
        line.setAttribute("fill", "none");
        svg.appendChild(line);
    }

    // Draw color-coded line segments for diastolic
    for (let i = 0; i < data.length - 1; i++) {
        const x1 = xScaleByDate(data[i].date);
        const y1 = yScale(data[i].dia);
        const x2 = xScaleByDate(data[i + 1].date);
        const y2 = yScale(data[i + 1].dia);
        const color = getClassColor(data[i].category);

        const line = document.createElementNS(svgNs, "line");
        line.setAttribute("x1", x1);
        line.setAttribute("y1", y1);
        line.setAttribute("x2", x2);
        line.setAttribute("y2", y2);
        line.setAttribute("stroke", color);
        line.setAttribute("stroke-width", "2.5");
        line.setAttribute("fill", "none");
        svg.appendChild(line);
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
        groupList.style.listStyle = 'none';
        groupList.style.padding = '0';
        groupList.style.margin = '0';
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
=======
        ['bp-systolic', 'bp-diastolic', 'bp-pulse', 'bp-notes'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        const site = document.getElementById('bp-site');
        if (site) site.value = 'right_arm';
        const pos = document.getElementById('bp-position');
        if (pos) pos.value = 'seated';
>>>>>>> Stashed changes
    };

    // Render groups in order
    const todayGroup = renderGroup('Today', groups.today);
    const yesterdayGroup = renderGroup('Yesterday', groups.yesterday);

<<<<<<< Updated upstream
    if (todayGroup) list.appendChild(todayGroup);
    if (yesterdayGroup) list.appendChild(yesterdayGroup);
=======
    window.handleBPSubmit = async function (event) {
        event.preventDefault();
        const datetime = document.getElementById('bp-datetime')?.value;
        const systolic = parseInt(document.getElementById('bp-systolic')?.value, 10);
        const diastolic = parseInt(document.getElementById('bp-diastolic')?.value, 10);
        const pulseRaw = document.getElementById('bp-pulse')?.value;
        const pulse = pulseRaw ? parseInt(pulseRaw, 10) : null;
        const site = document.getElementById('bp-site')?.value || 'right_arm';
        const position = document.getElementById('bp-position')?.value || 'seated';
        const notes = document.getElementById('bp-notes')?.value || '';
>>>>>>> Stashed changes

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

    if (userInitData && window.tg.showConfirm) {
        try {
            window.tg.showConfirm(confirmMsg, (ok) => {
                if (ok) _deleteBPApi(id);
            });
            return;
        } catch (e) {
            console.log('window.tg.showConfirm failed, falling back', e);
        }
    }

    if (confirm(confirmMsg)) {
        _deleteBPApi(id);
    }
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
            window.tg.showAlert('Failed to generate export');
            return;
        }

<<<<<<< Updated upstream
        const blob = await response.blob();
        downloadBlobAsFile(blob, 'blood_pressure_export.csv');
    } catch (err) {
        console.error('Export error:', err);
        window.tg.showAlert('Failed to export data');
    }
}
=======
        const payload = {
            measured_at: new Date(datetime).toISOString(),
            systolic,
            diastolic,
            pulse,
            site,
            position,
            notes
        };

        const res = await window.apiCall('/api/bp', 'POST', payload);
        if (!res) return;

        if (window.DataStore) await window.DataStore.invalidateTags(['bp']);
        window.closeBPRecordModal();
        window.loadBPReadings();
    };

    window.loadBPReadings = async function () {
        const list = document.getElementById('bp-list');
        if (!window.DataStore) return;

        await window.DataStore.loadSWR({
            key: 'bp',
            tags: ['bp'],
            fetcher: async () => {
                const [readingsRes, goalRes, statsRes] = await Promise.all([
                    window.apiCall('/api/bp?days=60'),
                    window.apiCall('/api/bp/goal'),
                    window.apiCall('/api/bp/stats')
                ]);
                if (readingsRes === null) return null;
                return { readingsRes, goalRes, statsRes };
            },
            onCached: async (cached) => {
                await window._renderBPData(cached.readingsRes, cached.goalRes, cached.statsRes);
            },
            onFresh: async (fresh) => {
                await window._renderBPData(fresh.readingsRes, fresh.goalRes, fresh.statsRes);
            },
            onError: async (_error, cached) => {
                if (cached) return;
                const errLi = document.createElement('li');
                errLi.style.cssText = 'text-align:center;color:var(--hint-color);padding:20px;';
                errLi.textContent = 'Failed to load readings';
                if (list) list.replaceChildren(errLi);
            }
        });
    };

    window._renderBPData = async function (readingsRes, goalRes, statsRes) {
        const list = document.getElementById('bp-list');
        let allReadings = readingsRes || [];

        if (window.MedTrackerDB?.BPStore) {
            try {
                const pending = await window.MedTrackerDB.BPStore.getPending();
                const pendingFormatted = pending.map((r) => ({
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
            const errLi = document.createElement('li');
            errLi.style.cssText = 'text-align:center;color:var(--hint-color);padding:20px;';
            errLi.textContent = 'Failed to load readings';
            if (list) list.replaceChildren(errLi);
            return;
        }

        window.renderBPChart(allReadings, goalRes || {});
        window.renderBPAverages(statsRes || {});

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 2);
        cutoff.setHours(0, 0, 0, 0);
        const filtered = allReadings.filter((r) => new Date(r.measured_at) >= cutoff);
        window.renderBPReadings(filtered);
    };

    window.renderBPChart = function (readings) {
        const container = document.getElementById('bpChart');
        if (!container) return;
        container.replaceChildren();

        if (!readings || readings.length === 0) {
            const noData = document.createElement('span');
            noData.style.cssText = 'color:var(--hint-color);font-size:14px;';
            noData.textContent = 'No data available';
            container.appendChild(noData);
            return;
        }

        const sorted = [...readings].sort((a, b) => new Date(a.measured_at) - new Date(b.measured_at));
        const w = Math.max(container.clientWidth || 320, 320);
        const h = Math.max(container.clientHeight || 200, 200);
        const pad = 20;
        const minY = Math.min(...sorted.map((r) => Math.min(r.systolic, r.diastolic))) - 10;
        const maxY = Math.max(...sorted.map((r) => Math.max(r.systolic, r.diastolic))) + 10;
        const rangeY = Math.max(maxY - minY, 1);
        const len = Math.max(sorted.length - 1, 1);

        const x = (i) => pad + (i / len) * (w - pad * 2);
        const y = (v) => h - pad - ((v - minY) / rangeY) * (h - pad * 2);

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

        const makePath = (selector) => sorted.map((r, i) => `${i === 0 ? 'M' : 'L'} ${x(i)},${y(r[selector])}`).join(' ');

        const systolicPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        systolicPath.setAttribute('d', makePath('systolic'));
        systolicPath.setAttribute('fill', 'none');
        systolicPath.setAttribute('stroke', '#ef4444');
        systolicPath.setAttribute('stroke-width', '2');
        svg.appendChild(systolicPath);

        const diastolicPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        diastolicPath.setAttribute('d', makePath('diastolic'));
        diastolicPath.setAttribute('fill', 'none');
        diastolicPath.setAttribute('stroke', '#3b82f6');
        diastolicPath.setAttribute('stroke-width', '2');
        svg.appendChild(diastolicPath);

        sorted.forEach((r, i) => {
            const s = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            s.setAttribute('cx', x(i));
            s.setAttribute('cy', y(r.systolic));
            s.setAttribute('r', '2.5');
            s.setAttribute('fill', '#ef4444');
            svg.appendChild(s);

            const d = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            d.setAttribute('cx', x(i));
            d.setAttribute('cy', y(r.diastolic));
            d.setAttribute('r', '2.5');
            d.setAttribute('fill', '#3b82f6');
            svg.appendChild(d);
        });

        container.appendChild(svg);
    };

    window.renderBPAverages = function (stats) {
        const container = document.getElementById('bp-averages');
        if (!container) return;
        container.replaceChildren();

        if (!stats || (!stats.stats_14 && !stats.stats_30 && !stats.stats_60)) return;

        const row = document.createElement('div');
        row.className = 'bp-avg-row';

        const append = (label, stat) => {
            if (!stat) return;
            const item = document.createElement('div');
            item.className = 'bp-avg-item';

            const l = document.createElement('span');
            l.className = 'bp-avg-label';
            l.textContent = `${label} (${stat.days}d)`;

            const v = document.createElement('span');
            v.className = 'bp-avg-value';
            v.textContent = `${stat.systolic}/${stat.diastolic}`;

            item.appendChild(l);
            item.appendChild(v);
            row.appendChild(item);
        };

        append('14d', stats.stats_14);
        append('30d', stats.stats_30);
        append('60d', stats.stats_60);
        container.appendChild(row);
    };

    window.renderBPReadings = function (readings) {
        const list = document.getElementById('bp-list');
        if (!list) return;
        list.replaceChildren();
        if (!readings || readings.length === 0) return;

        const groups = { today: [], yesterday: [], older: [] };
        const todayAtMidnight = new Date();
        todayAtMidnight.setHours(0, 0, 0, 0);
        const yesterdayAtMidnight = new Date(todayAtMidnight);
        yesterdayAtMidnight.setDate(yesterdayAtMidnight.getDate() - 1);

        readings.forEach((r) => {
            const date = new Date(r.measured_at);
            date.setHours(0, 0, 0, 0);
            if (date.getTime() === todayAtMidnight.getTime()) groups.today.push(r);
            else if (date.getTime() === yesterdayAtMidnight.getTime()) groups.yesterday.push(r);
            else groups.older.push(r);
        });

        const renderGroup = (headerText, groupReadings) => {
            if (groupReadings.length === 0) return;
            const sorted = [...groupReadings].sort((a, b) => new Date(b.measured_at) - new Date(a.measured_at));
            const groupItem = document.createElement('li');
            groupItem.className = 'bp-date-group';
            const header = document.createElement('div');
            header.className = 'bp-date-header';
            header.textContent = headerText;
            const groupList = document.createElement('ul');
            groupList.style.cssText = 'list-style:none;padding:0;margin:0;';
            groupItem.appendChild(header);
            groupItem.appendChild(groupList);

            sorted.forEach((r) => {
                const timeStr = typeof window.formatTimeOnly === 'function' ? window.formatTimeOnly(r.measured_at) : r.measured_at;
                const cat = window.getBPCategory(r.systolic, r.diastolic);
                const item = document.createElement('mt-card');
                item.className = `bp-item${r.isLocal ? ' pending-sync' : ''}`;

                const readingDiv = document.createElement('div');
                readingDiv.className = 'bp-reading';
                const values = document.createElement('div');
                values.className = 'bp-values';
                const sys = document.createElement('span');
                sys.className = 'bp-sys';
                sys.textContent = r.systolic;
                const dia = document.createElement('span');
                dia.className = 'bp-dia';
                dia.textContent = `/${r.diastolic}`;
                values.appendChild(sys);
                values.appendChild(dia);
                if (r.isLocal) {
                    const badge = document.createElement('span');
                    badge.className = 'sync-pending-badge';
                    badge.textContent = 'Pending';
                    values.appendChild(badge);
                }
                const meta = document.createElement('div');
                meta.className = 'bp-meta';
                const time = document.createElement('span');
                time.textContent = timeStr;
                meta.appendChild(time);
                if (r.pulse) {
                    const pulse = document.createElement('span');
                    pulse.textContent = ` • Pulse: ${r.pulse}`;
                    meta.appendChild(pulse);
                }
                readingDiv.appendChild(values);
                readingDiv.appendChild(meta);
                const tag = document.createElement('div');
                tag.className = `bp-tag ${cat.class}`;
                tag.textContent = cat.label;
                item.appendChild(readingDiv);
                item.appendChild(tag);
                groupList.appendChild(item);
            });
            list.appendChild(groupItem);
        };

        renderGroup('Today', groups.today);
        renderGroup('Yesterday', groups.yesterday);
        renderGroup('Older Readings', groups.older);
    };

    let bpControlsBound = false;
    function bindBPControls() {
        if (bpControlsBound) return;
        bpControlsBound = true;

        const addBtn = document.getElementById('add-bp-btn');
        if (addBtn) addBtn.addEventListener('click', () => window.showBPRecordModal());
        const cancelBtn = document.getElementById('bp-modal-cancel-btn');
        if (cancelBtn) cancelBtn.addEventListener('click', () => window.closeBPRecordModal());
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindBPControls, { once: true });
    }
    bindBPControls();
})(window);
>>>>>>> Stashed changes
