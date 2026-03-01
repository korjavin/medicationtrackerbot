(function () {
    window.parseMedicationSchedule = function (rawSchedule) {
        try { return JSON.parse(rawSchedule); } catch (e) { return null; }
    };

    window.getNextScheduledDate = function (schedule, now = new Date()) {
        if (!schedule) return null;
        const parseCandidate = (baseDate, timeStr) => {
            const [h, min] = String(timeStr).split(':').map(Number);
            if (Number.isNaN(h) || Number.isNaN(min)) return null;
            const candidate = new Date(baseDate);
            candidate.setHours(h, min, 0, 0);
            return candidate;
        };
        if (schedule.type === 'daily' && Array.isArray(schedule.times)) {
            const candidates = schedule.times.map(t => {
                const c = parseCandidate(now, t);
                if (!c) return null;
                if (c <= now) c.setDate(c.getDate() + 1);
                return c;
            }).filter(Boolean);
            return candidates.sort((a, b) => a - b)[0] || null;
        }
        if (schedule.type === 'weekly' && Array.isArray(schedule.days) && Array.isArray(schedule.times)) {
            const candidates = [];
            for (let i = 0; i < 8; i++) {
                const dayBase = new Date(now); dayBase.setDate(now.getDate() + i);
                if (!schedule.days.includes(dayBase.getDay())) continue;
                schedule.times.forEach(t => {
                    const c = parseCandidate(dayBase, t);
                    if (c && c > now) candidates.push(c);
                });
            }
            return candidates.sort((a, b) => a - b)[0] || null;
        }
        return null;
    };

    window.getMedicationScheduleText = function (med, schedule) {
        if (!schedule) return med.schedule;
        if (schedule.type === 'daily') return `Daily: ${(schedule.times || []).join(', ')}`;
        if (schedule.type === 'weekly') {
            const daysMap = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
            const dayNames = (schedule.days || []).map(d => daysMap[d]);
            return `Weekly (${dayNames.join(', ')}): ${(schedule.times || []).join(', ')}`;
        }
        return 'As Needed';
    };

    window.renderMeds = function () {
        const list = document.getElementById('med-list');
        if (!list) return;
        list.replaceChildren();
        const now = new Date();
        const scheduledSoon = [], recentTaken = [], asNeeded = [], archived = [];

        window.medications.forEach(med => {
            const schedule = window.parseMedicationSchedule(med.schedule);
            const type = schedule?.type || 'daily';
            if (med.archived) archived.push({ med, schedule, next: null });
            else if (type === 'as_needed') asNeeded.push({ med, schedule, next: null });
            else {
                const next = window.getNextScheduledDate(schedule, now);
                const hoursUntil = next ? (next - now) / 3600000 : 999;
                if (hoursUntil < 14) scheduledSoon.push({ med, schedule, next });
                else recentTaken.push({ med, schedule, next });
            }
        });

        const sortByTaken = (a, b) => (b.med.last_taken_at ? new Date(b.med.last_taken_at).getTime() : 0) - (a.med.last_taken_at ? new Date(a.med.last_taken_at).getTime() : 0);
        scheduledSoon.sort((a, b) => (a.next || 0) - (b.next || 0));
        recentTaken.sort(sortByTaken); asNeeded.sort(sortByTaken); archived.sort(sortByTaken);

        [...scheduledSoon, ...recentTaken, ...asNeeded, ...archived].forEach(({ med, schedule }) => {
            const card = document.createElement('mt-card');
            card.className = 'med-item' + (med.archived ? ' archived' : '');
            const info = document.createElement('div');
            info.className = 'med-info'; info.style.cursor = 'pointer';
            info.onclick = () => window.showEditModal(med.id);
            const title = document.createElement('h4'); title.textContent = `${med.name} (${med.dosage})`;
            info.appendChild(title);
            if (med.normalized_name) {
                const rx = document.createElement('p'); rx.style.cssText = 'font-size:0.85em;color:var(--hint-color);margin-top:-5px;margin-bottom:4px;';
                rx.textContent = `Rx: ${med.normalized_name}`; info.appendChild(rx);
            }
            const sch = document.createElement('p'); sch.textContent = `Schedule: ${window.getMedicationScheduleText(med, schedule)}`;
            info.appendChild(sch);
            if (med.inventory_count !== null) {
                const low = med.inventory_count <= (med.low_stock_threshold || 5);
                const inv = document.createElement('p'); inv.className = 'inventory-badge' + (low ? ' low' : '');
                inv.textContent = `📦 ${med.inventory_count} doses${low ? ' ⚠️' : ''}`; info.appendChild(inv);
            }
            const actions = document.createElement('div'); actions.className = 'med-actions';
            const logBtn = document.createElement('button'); logBtn.className = 'small-btn secondary'; logBtn.textContent = 'Log';
            logBtn.onclick = () => window.logMedicationPast(med.id, med.name);
            const delBtn = document.createElement('button'); delBtn.className = 'delete-btn'; delBtn.textContent = '×';
            delBtn.onclick = () => window.deleteMed(med.id);
            actions.append(logBtn, delBtn); card.append(info, actions); list.appendChild(card);
        });
    };

    window.loadMeds = async function () {
        if (window.DataStore) {
            await window.DataStore.loadSWR({
                key: 'medications', tags: ['medications'],
                fetcher: async () => await window.apiCall('/api/medications?archived=true'),
                onCached: async (cached) => { window.medications = cached; window.renderMeds(); window.populateMedFilter(); },
                onFresh: async (fresh) => { window.medications = fresh; if (window.MedTrackerDB?.MedicationStore) await window.MedTrackerDB.MedicationStore.saveCache(fresh); window.renderMeds(); window.populateMedFilter(); },
                onError: async () => {
                    const offline = await window.MedTrackerDB?.MedicationStore.getCache();
                    if (offline) { window.medications = offline; window.renderMeds(); window.populateMedFilter(); }
                }
            });
        }
    };

    window.renderHistory = function (logs) {
        const list = document.getElementById('history-list');
        if (!list) return;
        list.replaceChildren();
        if (!logs?.length) {
            const p = document.createElement('p'); p.style.cssText = 'text-align:center;color:var(--hint-color)'; p.textContent = 'No history yet.';
            list.appendChild(p); return;
        }
        const groups = [];
        logs.forEach(l => {
            let key = l.scheduled_at, timeLabel = window.formatDate(l.scheduled_at);
            if (l.status === 'TAKEN' && l.taken_at) {
                const d = new Date(l.taken_at); key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`;
                timeLabel = window.formatDate(l.taken_at);
            }
            let grp = groups.find(g => g.key === key && g.status === l.status);
            if (!grp) {
                grp = { key, status: l.status, timeLabel, items: [], sortTime: new Date(l.status === 'TAKEN' ? l.taken_at : l.scheduled_at).getTime() };
                groups.push(grp);
            }
            grp.items.push(l);
        });
        groups.sort((a, b) => b.sortTime - a.sortTime).forEach(g => {
            const card = document.createElement('mt-card'); card.className = 'history-group';
            if (['PENDING', 'TAKEN'].includes(g.status)) {
                card.style.cursor = 'pointer';
                card.onclick = () => {
                    const ids = g.items.map(i => i.medication_id), names = g.items.map(i => window.medications.find(m => m.id === i.medication_id)?.name || 'Unknown');
                    window.showMedicationConfirmModal(ids, names, g.status === 'TAKEN' ? g.items[0].taken_at : g.items[0].scheduled_at, g.status === 'TAKEN' ? 'edit' : 'confirm', g.items.map(i => i.id));
                };
            }
            const icon = g.status === 'TAKEN' ? '✅' : (g.status === 'PENDING' ? '⏳' : '❌');
            const head = document.createElement('div'); head.className = 'history-header'; head.innerHTML = `<strong>${icon} ${g.timeLabel}</strong>`;
            const items = document.createElement('div'); items.className = 'history-items';
            g.items.forEach(l => {
                const item = document.createElement('div'); item.className = 'history-subitem';
                item.textContent = window.medications.find(m => m.id === l.medication_id)?.name || 'Unknown';
                items.appendChild(item);
            });
            card.append(head, items); list.appendChild(card);
        });
    };

    async function renderNextIntakeTrigger() {
        const container = document.getElementById('next-intake-trigger');
        if (!container) return;

        try {
            const res = await window.DataStore.fetchFresh(
                'next_intake',
                async () => await window.apiCall('/api/medications/next-intake', 'GET'),
                ['history', 'medications']
            );

            if (!res || !res.scheduled_at) {
                container.replaceChildren();
                return;
            }

            const nextTime = new Date(res.scheduled_at);
            const medNamesStr = res.medication_names.join(', ');

            const timeStr = nextTime.toLocaleString('de-DE', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });

            const card = document.createElement('div');
            card.style.cssText = 'background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center;';

            const body = document.createElement('div');
            const title = document.createElement('div');
            title.style.cssText = 'font-size: 14px; font-weight: 600; margin-bottom: 4px;';
            title.textContent = 'Next scheduled intake';
            const details = document.createElement('div');
            details.style.cssText = 'font-size: 12px; opacity: 0.9;';
            details.textContent = `${medNamesStr} at ${timeStr}`;
            body.appendChild(title);
            body.appendChild(details);

            const action = document.createElement('button');
            action.type = 'button';
            action.className = 'btn-pill';
            action.style.cssText = 'background: rgba(255,255,255,0.25); color: white; white-space: nowrap;';
            action.textContent = 'Take Now';
            action.addEventListener('click', () => {
                window.triggerNextIntake();
            });

            card.appendChild(body);
            card.appendChild(action);
            container.replaceChildren(card);
        } catch (e) {
            console.error("Error fetching next intake:", e);
            container.replaceChildren();
        }
    }
    window.renderNextIntakeTrigger = renderNextIntakeTrigger;

    async function triggerNextIntake() {
        try {
            const res = await window.apiCall('/api/medications/trigger-next-intake', 'POST');

            if (res && res.status === 'confirmed') {
                await window.DataStore.invalidateTags(['history', 'medications']);
                await window.DataStore.invalidateKey('next_intake');
                const medNamesStr = res.medication_names ? res.medication_names.join(', ') : `${res.medication_count} medication(s)`;
                if (typeof window.safeAlert === 'function') {
                    window.safeAlert(`Confirmed: ${medNamesStr}\n\nScheduled for: ${window.formatDate(res.scheduled_at)}\nTaken at: ${window.formatDate(res.taken_at)}`);
                }

                await window.loadHistory();
            }
        } catch (error) {
            console.error('Error triggering next intake:', error);
            if (typeof window.safeAlert === 'function') window.safeAlert('Failed to trigger next intake. Please try again.');
        }
    }
    window.triggerNextIntake = triggerNextIntake;

    window.populateMedFilter = function () {
        const sel = document.getElementById('history-filter-med');
        if (!sel) return;
        const val = sel.value;
        sel.replaceChildren(new Option("All Medications", "0"));
        [...window.medications].sort((a, b) => a.name.localeCompare(b.name)).forEach(m => sel.add(new Option(m.name + (m.archived ? ' (Archived)' : ''), m.id)));
        sel.value = val;
    };
})();
