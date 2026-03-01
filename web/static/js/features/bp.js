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
        const position = document.getElementById('bp-position')?.value || 'seated';
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
