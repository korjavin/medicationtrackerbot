(function () {
    window.loadWeightLogs = async function () {
        if (window.DataStore) {
            await window.DataStore.loadSWR({
                key: 'weight', tags: ['weight'],
                fetcher: async () => {
                    const [logs, stats] = await Promise.all([
                        window.apiCall('/api/weight?days=60'),
                        window.apiCall('/api/weight/stats')
                    ]);
                    return { logs, stats };
                },
                onCached: (cached) => { window.renderWeightLogs(cached.logs); window.renderWeightStats(cached.stats); },
                onFresh: (fresh) => { window.renderWeightLogs(fresh.logs); window.renderWeightStats(fresh.stats); }
            });
        }
    };

    window.renderWeightLogs = function (logs) {
        const list = document.getElementById('weight-list');
        if (!list) return;
        list.replaceChildren();
        if (!logs?.length) return;

        logs.sort((a, b) => new Date(b.measured_at) - new Date(a.measured_at)).forEach(l => {
            const card = document.createElement('mt-card');
            card.className = 'weight-item' + (l.isLocal ? ' pending-sync' : '');
            const info = document.createElement('div'); info.className = 'weight-info';
            const val = document.createElement('div'); val.className = 'weight-value';
            val.textContent = `${l.weight} kg`;
            if (l.isLocal) {
                const badge = document.createElement('span'); badge.className = 'sync-pending-badge';
                badge.textContent = 'Pending'; val.appendChild(badge);
            }
            const date = document.createElement('div'); date.className = 'weight-date';
            date.textContent = window.formatDateTimeLocalForInput ? window.formatDateTimeLocalForInput(l.measured_at).replace('T', ' ') : l.measured_at;
            info.append(val, date);
            if (l.notes) {
                const notes = document.createElement('div'); notes.className = 'weight-notes';
                notes.textContent = l.notes; info.appendChild(notes);
            }
            card.appendChild(info); list.appendChild(card);
        });
    };

    window.renderWeightStats = function (stats) {
        const container = document.getElementById('weight-stats');
        if (!container || !stats) return;
        container.replaceChildren();
        const card = document.createElement('mt-card'); card.className = 'weight-stats-container';
        const grid = document.createElement('div'); grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px;text-align:center;';
        const addStat = (lbl, val) => {
            const div = document.createElement('div');
            div.innerHTML = `<div style="font-size:0.85em;color:var(--hint-color);">${lbl}</div><div style="font-size:1.15em;font-weight:600;color:var(--text-color);">${val}</div>`;
            grid.appendChild(div);
        };
        if (stats.last_weight) addStat('Last', stats.last_weight + ' kg');
        if (stats.avg_7d) addStat('7d Avg', stats.avg_7d + ' kg');
        if (stats.avg_30d) addStat('30d Avg', stats.avg_30d + ' kg');
        if (stats.change_30d !== undefined) {
            const color = stats.change_30d > 0 ? '#ff3b30' : '#34c759';
            addStat('30d Change', `<span style="color:${color}">${stats.change_30d > 0 ? '+' : ''}${stats.change_30d} kg</span>`);
        }
        card.appendChild(grid); container.appendChild(card);
    };

    window.showWeightRecordModal = function () {
        if (window.ModalManager && window.ModalManager.weight) window.ModalManager.weight.open();
        const dt = document.getElementById('weight-datetime');
        if (dt) dt.value = window.formatDateTimeLocalForInput();
        ['weight-value', 'weight-notes'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        if (document.getElementById('weight-value')) document.getElementById('weight-value').focus();
    };

    window.handleWeightSubmit = async function (event) {
        event.preventDefault();
        const dt = document.getElementById('weight-datetime').value, val = parseFloat(document.getElementById('weight-value').value), notes = document.getElementById('weight-notes').value;
        if (!dt || isNaN(val)) { window.safeAlert('Please fill in weight'); return; }
        const res = await window.apiCall('/api/weight', 'POST', { measured_at: new Date(dt).toISOString(), weight: val, notes });
        if (res) { if (window.DataStore) await window.DataStore.invalidateTags(['weight']); window.ModalManager.weight.close(); window.loadWeightLogs(); }
    };
})();
