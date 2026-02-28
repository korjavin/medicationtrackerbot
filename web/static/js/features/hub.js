(function () {
    window.loadWeeklyHub = async function () {
        if (window.DataStore) {
            await window.DataStore.loadSWR({
                key: 'weekly_hub', tags: ['medications', 'workout', 'weight', 'bp'],
                fetcher: async () => await window.apiCall('/api/hub/weekly', 'GET'),
                onCached: (cached) => window.renderWeeklyHub(cached),
                onFresh: (fresh) => window.renderWeeklyHub(fresh)
            });
        }
    };

    window.renderWeeklyHub = function (data) {
        const container = document.getElementById('weekly-hub-container');
        if (!container || !data) return;
        container.replaceChildren();

        const card = document.createElement('mt-card');
        card.innerHTML = `<h3 style="margin-top:0;">Weekly Summary</h3><p style="color:var(--hint-color);font-size:0.9em;">Overview of your last 7 days.</p>`;

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

        card.appendChild(stats); container.appendChild(card);
    };
})();
