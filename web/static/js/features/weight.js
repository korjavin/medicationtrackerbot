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
        window.renderWeightStats(allLogs, goalRes || {});
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

        const sorted = [...logs].sort((a, b) => new Date(a.measured_at) - new Date(b.measured_at));
        const w = Math.max(container.clientWidth || 320, 320);
        const h = Math.max(container.clientHeight || 200, 200);
        const pad = 22;
        const goal = goalData?.goal;
        const minY = Math.min(...sorted.map((r) => r.weight), goal ?? Number.POSITIVE_INFINITY) - 2;
        const maxY = Math.max(...sorted.map((r) => r.weight), goal ?? Number.NEGATIVE_INFINITY) + 2;
        const rangeY = Math.max(maxY - minY, 1);
        const len = Math.max(sorted.length - 1, 1);

        const x = (i) => pad + (i / len) * (w - pad * 2);
        const y = (v) => h - pad - ((v - minY) / rangeY) * (h - pad * 2);

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

        if (goal !== undefined && goal !== null) {
            const goalLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            goalLine.setAttribute('x1', pad);
            goalLine.setAttribute('x2', w - pad);
            goalLine.setAttribute('y1', y(goal));
            goalLine.setAttribute('y2', y(goal));
            goalLine.setAttribute('stroke', '#22c55e');
            goalLine.setAttribute('stroke-width', '1.5');
            goalLine.setAttribute('stroke-dasharray', '4 3');
            svg.appendChild(goalLine);
        }

        const pathData = sorted.map((r, i) => `${i === 0 ? 'M' : 'L'} ${x(i)},${y(r.weight)}`).join(' ');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', pathData);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', '#7c3aed');
        path.setAttribute('stroke-width', '2');
        svg.appendChild(path);

        sorted.forEach((r, i) => {
            const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            c.setAttribute('cx', x(i));
            c.setAttribute('cy', y(r.weight));
            c.setAttribute('r', '2.5');
            c.setAttribute('fill', '#7c3aed');
            svg.appendChild(c);
        });

        container.appendChild(svg);
    };

    window.renderWeightStats = function (logs, goalData) {
        const container = document.getElementById('weight-stats');
        if (!container) return;
        container.replaceChildren();
        if (!logs || logs.length === 0) return;

        const sorted = [...logs].sort((a, b) => new Date(b.measured_at) - new Date(a.measured_at));
        const current = sorted[0].weight;
        const recent7 = sorted.filter((l) => (Date.now() - new Date(l.measured_at).getTime()) <= 7 * 24 * 3600 * 1000);
        const avg7 = recent7.length ? (recent7.reduce((sum, l) => sum + l.weight, 0) / recent7.length) : current;

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:12px;justify-content:space-between;flex-wrap:wrap;';

        const addStat = (label, value) => {
            const item = document.createElement('div');
            item.className = 'weight-stat-item';
            item.innerHTML = `<div style="font-size:12px;color:var(--hint-color);">${label}</div><div style="font-weight:600;">${value}</div>`;
            row.appendChild(item);
        };

        addStat('Current', `${Number(current).toFixed(1)} kg`);
        addStat('7d Avg', `${Number(avg7).toFixed(1)} kg`);
        if (goalData?.goal !== undefined && goalData?.goal !== null) {
            addStat('Goal', `${Number(goalData.goal).toFixed(1)} kg`);
        }
        container.appendChild(row);
    };

    window.showWeightRecordModal = function () {
        if (window.ModalManager && window.ModalManager.weight) window.ModalManager.weight.open();
        const dt = document.getElementById('weight-datetime');
        if (dt && typeof window.formatDateTimeLocalForInput === 'function') dt.value = window.formatDateTimeLocalForInput();
        ['weight-value', 'weight-notes'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindWeightControls, { once: true });
    }
    bindWeightControls();
})();
