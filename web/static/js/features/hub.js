(function () {
    function deriveWeeklyHubFromBootstrap(bootstrap) {
        if (!bootstrap || typeof bootstrap !== 'object') return null;

        const history = Array.isArray(bootstrap.history_default) ? bootstrap.history_default : [];
        const medications = Array.isArray(bootstrap.medications) ? bootstrap.medications : [];
        const bpReadings = Array.isArray(bootstrap.bp?.readings) ? bootstrap.bp.readings : [];
        const weightLogs = Array.isArray(bootstrap.weight?.logs) ? bootstrap.weight.logs : [];

        const takenCount = history.filter((h) => h?.status === 'TAKEN').length;
        const medsTotal = history.length;

        let avgBP = null;
        if (bpReadings.length > 0) {
            const sys = Math.round(bpReadings.reduce((sum, r) => sum + (r.systolic || 0), 0) / bpReadings.length);
            const dia = Math.round(bpReadings.reduce((sum, r) => sum + (r.diastolic || 0), 0) / bpReadings.length);
            avgBP = { sys, dia };
        }

        let weightChange = undefined;
        if (weightLogs.length >= 2) {
            const sorted = [...weightLogs].sort((a, b) => new Date(a.measured_at) - new Date(b.measured_at));
            const first = Number(sorted[0]?.weight);
            const last = Number(sorted[sorted.length - 1]?.weight);
            if (Number.isFinite(first) && Number.isFinite(last)) {
                weightChange = +(last - first).toFixed(1);
            }
        }

        return {
            meds: { taken: takenCount, total: medsTotal || medications.length },
            avg_bp: avgBP,
            weight_change: weightChange
        };
    }

    function renderHubUnavailable() {
        const container = document.getElementById('weekly-hub-container');
        if (!container) return;
        container.replaceChildren();
    }

    window.loadWeeklyHub = async function () {
        if (!window.DataStore) return;

        await window.DataStore.loadSWR({
            key: 'weekly_hub',
            tags: ['medications', 'workout', 'weight', 'bp'],
            fetcher: async () => {
                // Primary endpoint (may not exist on older backends).
                let direct = null;
                if (typeof window.apiCallDirect === 'function') {
                    try {
                        direct = await window.apiCallDirect('/api/hub/weekly', 'GET');
                    } catch (_e) {
                        direct = null;
                    }
                } else {
                    direct = await window.apiCall('/api/hub/weekly', 'GET');
                }
                if (direct) return direct;

                // Compatibility fallback: derive a compact weekly card from bootstrap payload.
                const bootstrap = await window.apiCall('/api/bootstrap', 'GET');
                return deriveWeeklyHubFromBootstrap(bootstrap);
            },
            onCached: (cached) => {
                if (!cached) {
                    renderHubUnavailable();
                    return;
                }
                window.renderWeeklyHub(cached);
            },
            onFresh: (fresh) => {
                if (!fresh) {
                    renderHubUnavailable();
                    return;
                }
                window.renderWeeklyHub(fresh);
            },
            onError: () => renderHubUnavailable(),
            allowNullFresh: true
        });
    };

    window.renderWeeklyHub = async function (data) {
        let container;
        try { container = document.getElementById('weekly-hub-container'); } catch (_e) { return; }
        if (!container) return;

        // If no data provided, fetch 7-day history and build medication adherence calendar
        if (!data) {
            const meds = window.medications || [];
            if (meds.length === 0) { container.replaceChildren(); return; }

            const history = await window.apiCall('/api/history?days=7&med_id=0') || [];
            container.replaceChildren();

            const card = document.createElement('mt-card');
            const title = document.createElement('h3');
            title.style.marginTop = '0';
            title.textContent = 'Last 7 Days';
            card.appendChild(title);

            const daysRow = document.createElement('div');
            daysRow.style.cssText = 'display:flex;justify-content:space-between;gap:4px;margin-top:10px;';

            const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const today = new Date();
            for (let i = 6; i >= 0; i--) {
                const d = new Date(today);
                d.setDate(today.getDate() - i);
                const dateStr = d.toISOString().split('T')[0];

                const dayLogs = history.filter(h => {
                    const logDate = (h.taken_at || h.scheduled_at || '').split('T')[0];
                    return logDate === dateStr;
                });
                const taken = dayLogs.filter(h => h.status === 'TAKEN').length;
                const total = dayLogs.length;

                const col = document.createElement('div');
                col.style.cssText = 'text-align:center;flex:1;';

                const label = document.createElement('div');
                label.style.cssText = 'font-size:0.7em;color:var(--hint-color);';
                label.textContent = dayNames[d.getDay()];

                const circle = document.createElement('div');
                circle.className = 'day-circle';
                if (total > 0 && taken === total) circle.classList.add('complete');
                else if (taken > 0) circle.classList.add('partial');
                circle.textContent = d.getDate();

                col.appendChild(label);
                col.appendChild(circle);
                daysRow.appendChild(col);
            }

            card.appendChild(daysRow);
            container.appendChild(card);
            return;
        }

        container.replaceChildren();

        const card = document.createElement('mt-card');
        card.innerHTML = '<h3 style="margin-top:0;">Weekly Summary</h3><p style="color:var(--hint-color);font-size:0.9em;">Overview of your last 7 days.</p>';

        const stats = document.createElement('div');
        stats.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:15px;margin-top:15px;';

        const addStat = (lbl, val, unit) => {
            const div = document.createElement('div');
            div.innerHTML = `<div style="font-size:0.8em;color:var(--hint-color);text-transform:uppercase;letter-spacing:0.5px;">${lbl}</div><div style="font-size:1.2em;font-weight:600;">${val}<small style="font-size:0.6em;margin-left:2px;font-weight:400;color:var(--hint-color);">${unit}</small></div>`;
            stats.appendChild(div);
        };

        if (data.meds) addStat('Meds Taken', data.meds.taken, `/${data.meds.total}`);
        if (data.workouts) addStat('Workouts', data.workouts.completed, `/${data.workouts.total}`);
        if (data.weight_change !== undefined) {
            const color = data.weight_change > 0 ? '#ff3b30' : '#34c759';
            addStat('Weight', `<span style="color:${color}">${data.weight_change > 0 ? '+' : ''}${data.weight_change}</span>`, 'kg');
        }
        if (data.avg_bp) addStat('Avg BP', `${data.avg_bp.sys}/${data.avg_bp.dia}`, 'mmHg');

        card.appendChild(stats);
        container.appendChild(card);
    };
})();
