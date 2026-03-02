(function () {
    window.getBPCategory = function (sys, dia) {
        if (sys >= 160 || dia >= 100) return { label: 'Grade 2 HTN', class: 'grade2' };
        if (sys >= 140 || dia >= 90) return { label: 'Grade 1 HTN', class: 'grade1' };
        if (sys >= 130 || dia >= 85) return { label: 'High-normal', class: 'highnormal' };
        return { label: 'Normal', class: 'normal' };
    };

    window.showBPRecordModal = function () {
        if (window.ModalManager && window.ModalManager.bp) window.ModalManager.bp.open();
        const dtInput = document.getElementById('bp-datetime');
        if (dtInput && typeof window.formatDateTimeLocalForInput === 'function') {
            dtInput.value = window.formatDateTimeLocalForInput();
        }
        ['bp-systolic', 'bp-diastolic', 'bp-pulse', 'bp-notes'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        const site = document.getElementById('bp-site');
        if (site) site.value = 'right_arm';
        const pos = document.getElementById('bp-position');
        if (pos) pos.value = 'seated';
    };

    window.closeBPRecordModal = function () {
        if (window.ModalManager && window.ModalManager.bp) window.ModalManager.bp.close();
    };

    window.handleBPSubmit = async function (event) {
        event.preventDefault();
        const datetime = document.getElementById('bp-datetime')?.value;
        const systolic = parseInt(document.getElementById('bp-systolic')?.value, 10);
        const diastolic = parseInt(document.getElementById('bp-diastolic')?.value, 10);
        const pulseRaw = document.getElementById('bp-pulse')?.value;
        const pulse = pulseRaw ? parseInt(pulseRaw, 10) : null;
        const site = document.getElementById('bp-site')?.value || 'right_arm';
        const position = document.getElementById('bp-position')?.value || '';
        const notes = document.getElementById('bp-notes')?.value || '';

        if (!datetime || !systolic || !diastolic) {
            if (typeof window.safeAlert === 'function') window.safeAlert('Please fill in all required fields');
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

    window.renderBPChart = function (readings, goalData) {
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
        const data = sorted.map((r) => ({
            date: new Date(r.measured_at),
            sys: r.systolic,
            dia: r.diastolic,
            pulse: r.pulse,
            category: window.getBPCategory(r.systolic, r.diastolic)
        }));

        const avgSys = data.reduce((sum, d) => sum + d.sys, 0) / data.length;
        const avgDia = data.reduce((sum, d) => sum + d.dia, 0) / data.length;

        const leftPadding = 40;
        const totalWidth = Math.max(container.clientWidth || 320, 320);
        const chartWidth = totalWidth - leftPadding - 10;
        const chartHeight = Math.max((container.clientHeight || 220) - 35, 160);

        let minVal = Math.min(...data.map((d) => d.dia), ...data.filter((d) => d.pulse).map((d) => d.pulse));
        let maxVal = Math.max(...data.map((d) => d.sys), ...data.filter((d) => d.pulse).map((d) => d.pulse));
        minVal = Math.min(minVal, avgDia);
        maxVal = Math.max(maxVal, avgSys);
        minVal = Math.floor(minVal / 10) * 10;
        maxVal = Math.ceil(maxVal / 10) * 10;

        const effectiveMin = minVal - 10;
        const effectiveMax = maxVal + 10;
        const effectiveRange = Math.max(effectiveMax - effectiveMin, 1);
        const yInterval = effectiveRange > 80 ? 20 : 10;

        const firstDate = data[0].date;
        const lastDate = data[data.length - 1].date;
        const dateRange = lastDate - firstDate || 1;
        const xScaleByDate = (date) => leftPadding + ((date - firstDate) / dateRange) * chartWidth;
        const yScale = (v) => chartHeight - ((v - effectiveMin) / effectiveRange) * chartHeight;

        const getClassColor = (category) => {
            const colorMap = {
                normal: '#22c55e',
                highnormal: '#eab308',
                grade1: '#f97316',
                grade2: '#ef4444'
            };
            return colorMap[category.class] || '#22c55e';
        };

        const svgNs = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.setAttribute('viewBox', `0 0 ${totalWidth} ${chartHeight + 20}`);

        for (let val = Math.ceil(effectiveMin / yInterval) * yInterval; val <= effectiveMax; val += yInterval) {
            const y = yScale(val);
            const text = document.createElementNS(svgNs, 'text');
            text.setAttribute('x', leftPadding - 5);
            text.setAttribute('y', y + 4);
            text.setAttribute('style', 'text-anchor:end;fill:var(--hint-color);font-size:11px;');
            text.textContent = String(val);
            svg.appendChild(text);

            const gridLine = document.createElementNS(svgNs, 'line');
            gridLine.setAttribute('x1', leftPadding);
            gridLine.setAttribute('y1', y);
            gridLine.setAttribute('x2', totalWidth - 10);
            gridLine.setAttribute('y2', y);
            gridLine.setAttribute('class', 'chart-grid');
            svg.appendChild(gridLine);
        }

        const avgSysY = yScale(avgSys);
        const avgSysLine = document.createElementNS(svgNs, 'line');
        avgSysLine.setAttribute('x1', leftPadding);
        avgSysLine.setAttribute('y1', avgSysY);
        avgSysLine.setAttribute('x2', totalWidth - 10);
        avgSysLine.setAttribute('y2', avgSysY);
        avgSysLine.setAttribute('class', 'bp-chart-avg-line');
        svg.appendChild(avgSysLine);

        const avgDiaY = yScale(avgDia);
        const avgDiaLine = document.createElementNS(svgNs, 'line');
        avgDiaLine.setAttribute('x1', leftPadding);
        avgDiaLine.setAttribute('y1', avgDiaY);
        avgDiaLine.setAttribute('x2', totalWidth - 10);
        avgDiaLine.setAttribute('y2', avgDiaY);
        avgDiaLine.setAttribute('class', 'bp-chart-avg-line');
        svg.appendChild(avgDiaLine);

        for (let i = 0; i < data.length - 1; i++) {
            const color = getClassColor(data[i].category);
            const sysLine = document.createElementNS(svgNs, 'line');
            sysLine.setAttribute('x1', xScaleByDate(data[i].date));
            sysLine.setAttribute('y1', yScale(data[i].sys));
            sysLine.setAttribute('x2', xScaleByDate(data[i + 1].date));
            sysLine.setAttribute('y2', yScale(data[i + 1].sys));
            sysLine.setAttribute('stroke', color);
            sysLine.setAttribute('stroke-width', '2.5');
            svg.appendChild(sysLine);

            const diaLine = document.createElementNS(svgNs, 'line');
            diaLine.setAttribute('x1', xScaleByDate(data[i].date));
            diaLine.setAttribute('y1', yScale(data[i].dia));
            diaLine.setAttribute('x2', xScaleByDate(data[i + 1].date));
            diaLine.setAttribute('y2', yScale(data[i + 1].dia));
            diaLine.setAttribute('stroke', color);
            diaLine.setAttribute('stroke-width', '2.5');
            svg.appendChild(diaLine);
        }

        data.forEach((d) => {
            const color = getClassColor(d.category);
            const sysPoint = document.createElementNS(svgNs, 'circle');
            sysPoint.setAttribute('cx', xScaleByDate(d.date));
            sysPoint.setAttribute('cy', yScale(d.sys));
            sysPoint.setAttribute('r', '4');
            sysPoint.setAttribute('fill', color);
            sysPoint.setAttribute('stroke', 'var(--bg-color)');
            sysPoint.setAttribute('stroke-width', '2');
            svg.appendChild(sysPoint);

            const diaPoint = document.createElementNS(svgNs, 'circle');
            diaPoint.setAttribute('cx', xScaleByDate(d.date));
            diaPoint.setAttribute('cy', yScale(d.dia));
            diaPoint.setAttribute('r', '4');
            diaPoint.setAttribute('fill', color);
            diaPoint.setAttribute('stroke', 'var(--bg-color)');
            diaPoint.setAttribute('stroke-width', '2');
            svg.appendChild(diaPoint);
        });

        const firstLabel = document.createElementNS(svgNs, 'text');
        firstLabel.setAttribute('x', leftPadding);
        firstLabel.setAttribute('y', chartHeight + 15);
        firstLabel.setAttribute('style', 'text-anchor:start;fill:var(--hint-color);font-size:11px;');
        firstLabel.textContent = data[0].date.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' });
        svg.appendChild(firstLabel);

        const lastLabel = document.createElementNS(svgNs, 'text');
        lastLabel.setAttribute('x', totalWidth - 10);
        lastLabel.setAttribute('y', chartHeight + 15);
        lastLabel.setAttribute('style', 'text-anchor:end;fill:var(--hint-color);font-size:11px;');
        lastLabel.textContent = data[data.length - 1].date.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' });
        svg.appendChild(lastLabel);

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

    async function deleteBPReading(id) {
        const confirmMsg = 'Delete this blood pressure reading?';

        if (window.userInitData && window.tg && window.tg.showConfirm) {
            try {
                window.tg.showConfirm(confirmMsg, (ok) => {
                    if (ok) window._deleteBPApi(id);
                });
                return;
            } catch (e) {
                console.log('tg.showConfirm failed, falling back', e);
            }
        }

        if (confirm(confirmMsg)) {
            window._deleteBPApi(id);
        }
    }
    window.deleteBPReading = deleteBPReading;

    async function _deleteBPApi(id) {
        if (typeof id === 'string' && id.startsWith('local_')) {
            const localId = parseInt(id.replace('local_', ''));
            if (window.MedTrackerDB) {
                await window.MedTrackerDB.BPStore.confirmDelete(localId);
                if (window.SyncManager) window.SyncManager.updateStatus();
            }
            window.loadBPReadings();
            return;
        }

        const res = await window.apiCall(`/api/bp/${id}`, 'DELETE');
        if (res) {
            await window.DataStore.invalidateTags(['bp']);
            if (window.MedTrackerDB) {
                try {
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
            window.loadBPReadings();
        }
    }
    window._deleteBPApi = _deleteBPApi;

    async function exportBPCSV() {
        try {
            const headers = {};
            if (window.userInitData) headers['Authorization'] = `tma ${window.userInitData}`;
            const response = await fetch('/api/bp/export', {
                method: 'GET',
                headers
            });

            if (!response.ok) {
                if (typeof window.safeAlert === 'function') window.safeAlert('Failed to generate export');
                return;
            }

            const blob = await response.blob();
            if (typeof window.downloadBlobAsFile === 'function') {
                window.downloadBlobAsFile(blob, 'blood_pressure_export.csv');
            }
        } catch (err) {
            console.error('Export error:', err);
            if (typeof window.safeAlert === 'function') window.safeAlert('Failed to export data');
        }
    }
    window.exportBPCSV = exportBPCSV;

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
