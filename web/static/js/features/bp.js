(function () {
    // Get BP category based on ISH 2020 guidelines
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
        ['bp-systolic', 'bp-diastolic', 'bp-pulse', 'bp-notes'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        const site = document.getElementById('bp-site');
        if (site) site.value = 'right_arm';
        const pos = document.getElementById('bp-position');
        if (pos) pos.value = 'seated';
        const sys = document.getElementById('bp-systolic');
        if (sys) sys.focus();
    };

    window.closeBPRecordModal = function () {
        if (window.ModalManager && window.ModalManager.bp) window.ModalManager.bp.close();
    };

    window.handleBPSubmit = async function (event) {
        event.preventDefault();
        const datetime = document.getElementById('bp-datetime').value;
        const systolic = parseInt(document.getElementById('bp-systolic').value);
        const diastolic = parseInt(document.getElementById('bp-diastolic').value);
        const pulse = document.getElementById('bp-pulse').value ? parseInt(document.getElementById('bp-pulse').value) : null;
        const site = document.getElementById('bp-site').value;
        const position = document.getElementById('bp-position').value;
        const notes = document.getElementById('bp-notes').value;

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
        if (res) {
            if (window.DataStore) await window.DataStore.invalidateTags(['bp']);
            window.closeBPRecordModal();
            window.loadBPReadings();
        }
    };

    window.loadBPReadings = async function () {
        if (window.DataStore) {
            await window.DataStore.loadSWR({
                key: 'bp',
                tags: ['bp'],
                fetcher: async () => {
                    const [readingsRes, goalRes, statsRes] = await Promise.all([
                        window.apiCall('/api/bp?days=60'),
                        window.apiCall('/api/bp/goal'),
                        window.apiCall('/api/bp/stats')
                    ]);
                    return { readingsRes, goalRes, statsRes };
                },
                onCached: async (cached) => {
                    window.renderBPReadings(cached.readingsRes);
                    window.renderBPGoal(cached.goalRes);
                    window.renderBPStats(cached.statsRes);
                },
                onFresh: async (fresh) => {
                    window.renderBPReadings(fresh.readingsRes);
                    window.renderBPGoal(fresh.goalRes);
                    window.renderBPStats(fresh.statsRes);
                }
            });
        }
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

        readings.forEach(r => {
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

            sorted.forEach(r => {
                // Formatting time and category
                const timeStr = typeof window.formatTimeOnly === 'function' ? window.formatTimeOnly(r.measured_at) : r.measured_at;
                const cat = window.getBPCategory(r.systolic, r.diastolic);
                const item = document.createElement('mt-card');
                item.className = `bp-item${r.isLocal ? ' pending-sync' : ''}`;

                const readingDiv = document.createElement('div');
                readingDiv.className = 'bp-reading';
                const values = document.createElement('div');
                values.className = 'bp-values';
                const sys = document.createElement('span'); sys.className = 'bp-sys'; sys.textContent = r.systolic;
                const dia = document.createElement('span'); dia.className = 'bp-dia'; dia.textContent = `/${r.diastolic}`;
                values.appendChild(sys); values.appendChild(dia);
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
                readingDiv.appendChild(values); readingDiv.appendChild(meta);
                const tag = document.createElement('div');
                tag.className = `bp-tag ${cat.class}`;
                tag.textContent = cat.label;
                item.appendChild(readingDiv); item.appendChild(tag);
                groupList.appendChild(item);
            });
            list.appendChild(groupItem);
        };

        renderGroup('Today', groups.today);
        renderGroup('Yesterday', groups.yesterday);
        renderGroup('Older Readings', groups.older);
    };

    window.renderBPGoal = function (goal) {
        // Goal rendering logic
    };

    window.renderBPStats = function (stats) {
        // Stats rendering logic
    };

})(window);
