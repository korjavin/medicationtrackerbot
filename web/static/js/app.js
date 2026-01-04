// Init Telegram Web App
const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

// Config
// Config
const userInitData = tg.initData;

// Check Auth Environment
async function checkAuth() {
    if (userInitData) {
        // We are in Telegram, proceed as normal
        return true;
    }

    // Not in Telegram. Try to access API to see if we have valid Session Cookie
    try {
        const res = await fetch('/api/medications', { method: 'GET' });
        if (res.status === 200) {
            // Authorized via Cookie!
            return true;
        }
    } catch (e) {
        console.log("Auth check failed", e);
    }

    // Not authorized. Show Google Login.
    const loginBtn = document.createElement('button');
    loginBtn.innerText = "Login with Google";
    loginBtn.onclick = () => window.location.href = "/auth/google/login";
    loginBtn.style.cssText = "display:block; margin: 20% auto; padding: 15px 30px; font-size: 18px; background: #4285F4; color: white; border: none; border-radius: 5px; cursor: pointer;";

    document.body.innerHTML = "";
    document.body.appendChild(loginBtn);
    return false;
}

// Initial Load
checkAuth().then(authorized => {
    if (authorized) {
        // Only load data if authorized
        // Determine start tab? default meds
        switchTab('meds');
    }
});

// API Client
async function apiCall(endpoint, method = "GET", body = null) {
    const headers = { "X-Telegram-Init-Data": userInitData };
    if (body) headers["Content-Type"] = "application/json";

    try {
        const res = await fetch(endpoint, { method, headers, body: body ? JSON.stringify(body) : null });
        if (res.status === 401 || res.status === 403) { alert("Unauthorized!"); return null; }
        if (!res.ok) { const txt = await res.text(); throw new Error(txt); }
        if (method !== "DELETE" && res.status !== 204) {
            const txt = await res.text();
            return txt ? JSON.parse(txt) : null;
        }
        return true;
    } catch (e) {
        console.error(e);
        tg.showAlert("Error: " + e.message);
        return null;
    }
}

// State
let medications = [];
let editingMedId = null;

// Helper for European Date Format (DD.MM.YYYY HH:MM)
const formatDate = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleString('de-DE', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });
};

// UI Functions
function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));

    if (tab === 'meds') {
        document.querySelector('button[onclick="switchTab(\'meds\')"]').classList.add('active');
        document.getElementById('meds-view').classList.add('active');
        loadMeds();
    } else {
        document.querySelector('button[onclick="switchTab(\'history\')"]').classList.add('active');
        document.getElementById('history-view').classList.add('active');
        loadHistory();
    }
}

function showAddModal() {
    editingMedId = null;
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('med-modal').classList.remove('hidden');

    // Reset inputs
    document.getElementById('med-name').value = '';
    document.getElementById('med-dosage').value = '';
    document.getElementById('med-archived').checked = false;
    // showAddModal updates
    document.getElementById('med-start-date').value = '';
    document.getElementById('med-end-date').value = '';

    // Default: Daily, 1 time input
    document.getElementById('schedule-type').value = 'daily';
    toggleScheduleFields();

    const timeContainer = document.getElementById('time-inputs');
    timeContainer.innerHTML = '';
    addTimeInput(); // One empty input

    // Clear days
    document.querySelectorAll('.days-select span').forEach(s => s.classList.remove('selected'));
}

function showEditModal(id) {
    editingMedId = id;
    const med = medications.find(m => m.id === id);
    if (!med) return;

    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('med-modal').classList.remove('hidden');

    // Fill inputs
    document.getElementById('med-name').value = med.name;
    document.getElementById('med-dosage').value = med.dosage;
    document.getElementById('med-archived').checked = med.archived || false;

    // Dates (ISO string to YYYY-MM-DD)
    document.getElementById('med-start-date').value = med.start_date ? med.start_date.split('T')[0] : '';
    document.getElementById('med-end-date').value = med.end_date ? med.end_date.split('T')[0] : '';

    // Parse schedule
    let sched;
    try {
        sched = JSON.parse(med.schedule);
    } catch (e) {
        // Legacy format
        sched = { type: 'daily', times: [med.schedule] };
    }

    document.getElementById('schedule-type').value = sched.type;
    toggleScheduleFields();

    // Set times
    const timeContainer = document.getElementById('time-inputs');
    timeContainer.innerHTML = '';
    if (sched.times && sched.times.length > 0) {
        sched.times.forEach(t => addTimeInput(t));
    } else {
        addTimeInput();
    }

    // Set days
    document.querySelectorAll('.days-select span').forEach(s => s.classList.remove('selected'));
    if (sched.days) {
        sched.days.forEach(d => {
            const span = document.querySelector(`span[data-day="${d}"]`);
            if (span) span.classList.add('selected');
        });
    }
}

function closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    document.getElementById('med-modal').classList.add('hidden');
}

function toggleScheduleFields() {
    const type = document.getElementById('schedule-type').value;
    const daysContainer = document.getElementById('days-container');
    const timesContainer = document.getElementById('times-container');

    if (type === 'weekly') {
        daysContainer.classList.remove('hidden');
    } else {
        daysContainer.classList.add('hidden');
    }

    if (type === 'as_needed') {
        timesContainer.classList.add('hidden');
    } else {
        timesContainer.classList.remove('hidden');
    }
}

function toggleDay(el) {
    el.classList.toggle('selected');
}

function addTimeInput(value = '') {
    const container = document.getElementById('time-inputs');
    const div = document.createElement('div');
    div.className = 'time-row';
    div.innerHTML = `
        <input type="time" class="med-time-input" value="${value}">
        <button class="remove-time" onclick="removeTime(this)">×</button>
    `;
    container.appendChild(div);
}

function removeTime(btn) {
    btn.parentElement.remove();
}

// Render
// Render
function renderMeds() {
    const list = document.getElementById('med-list');
    list.innerHTML = '';

    // Helper to calculate next scheduled time
    const getNextScheduled = (m) => {
        try {
            const sched = JSON.parse(m.schedule);
            const now = new Date();

            if (sched.type === 'daily' && sched.times) {
                // Find next time today or tomorrow
                let candidates = [];
                sched.times.forEach(t => {
                    const [h, min] = t.split(':').map(Number);
                    let d = new Date(now);
                    d.setHours(h, min, 0, 0);
                    if (d <= now) d.setDate(d.getDate() + 1); // Tomorrow
                    candidates.push(d);
                });
                return candidates.sort((a, b) => a - b)[0];
            }
            if (sched.type === 'weekly' && sched.days && sched.times) {
                // Complex weekly logic, fallback to far future if hard
                // Simple implementation: check next 7 days
                let candidates = [];
                for (let i = 0; i < 8; i++) {
                    let dBase = new Date(now);
                    dBase.setDate(dBase.getDate() + i);
                    const day = dBase.getDay(); // 0-6
                    if (sched.days.includes(day)) {
                        sched.times.forEach(t => {
                            const [h, min] = t.split(':').map(Number);
                            let d = new Date(dBase);
                            d.setHours(h, min, 0, 0);
                            if (d > now) candidates.push(d);
                        });
                    }
                }
                return candidates.sort((a, b) => a - b)[0];
            }
        } catch (e) { }
        return null;
    };

    // Buckets
    const scheduledSoon = [];
    const recentTaken = []; // Recurring but not soon (taken today/yesterday)
    const asNeeded = [];
    const archived = [];

    medications.forEach(m => {
        if (m.archived) {
            archived.push(m);
            return;
        }

        let type = 'daily';
        try { type = JSON.parse(m.schedule).type; } catch (e) { }

        if (type === 'as_needed') {
            asNeeded.push(m);
        } else {
            // Recurring
            const next = getNextScheduled(m);
            m._next = next; // Cache for sort

            // "Scheduled Soon" definition:
            // If next is within 18 hours? Or just sort all by next?
            // User: "then from recent to oldest that were taken"
            // This implies a group that is NOT "Scheduled Soon".
            // If I took my morning med, next is tomorrow morning (24h away).
            // That fits "Recent Taken".
            // If I have a med tonight, it is "Soon".

            // Threshold: Let's say 14 hours.
            const hoursUntil = next ? (next - new Date()) / (1000 * 60 * 60) : 999;

            if (hoursUntil < 14) {
                scheduledSoon.push(m);
            } else {
                recentTaken.push(m);
            }
        }
    });

    // Sort Buckets
    scheduledSoon.sort((a, b) => (a._next || 0) - (b._next || 0));

    // Recent Taken: Recent logs first
    const sortByTaken = (a, b) => {
        const tA = a.last_taken_at ? new Date(a.last_taken_at) : 0;
        const tB = b.last_taken_at ? new Date(b.last_taken_at) : 0;
        return tB - tA;
    };

    recentTaken.sort(sortByTaken);
    asNeeded.sort(sortByTaken);
    archived.sort(sortByTaken);

    // Combine
    const sorted = [...scheduledSoon, ...recentTaken, ...asNeeded, ...archived];

    sorted.forEach(m => {
        const div = document.createElement('div');
        div.className = 'med-item';
        if (m.archived) div.classList.add('archived');

        let scheduleText = '';
        try {
            const sched = JSON.parse(m.schedule);
            if (sched.type === 'daily') {
                scheduleText = `Daily: ${sched.times.join(', ')}`;
            } else if (sched.type === 'weekly') {
                // Convert [1,2] -> ["Mon", "Tue"]
                const daysMap = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
                const dayNames = (sched.days || []).map(d => daysMap[d]);
                scheduleText = `Weekly (${dayNames.join(', ')}): ${sched.times.join(', ')}`;
            } else {
                scheduleText = 'As Needed';
            }
        } catch (e) {
            // Legacy fallback
            scheduleText = m.schedule;
        }

        let dateRangeText = '';
        if (m.start_date || m.end_date) {
            const start = m.start_date ? formatDate(m.start_date).split(' ')[0] : 'N/A';
            const end = m.end_date ? formatDate(m.end_date).split(' ')[0] : 'N/A';
            dateRangeText = `<p>Dates: ${start} - ${end}</p>`;
        }

        div.innerHTML = `
            <div class="med-info" onclick="showEditModal(${m.id})" style="cursor: pointer;">
                <h4>${escapeHtml(m.name)} <small>(${escapeHtml(m.dosage)})</small></h4>
                <p>Schedule: ${scheduleText}</p>
                ${dateRangeText}
            </div>
            <button class="delete-btn" onclick="deleteMed(${m.id})">&times;</button>
        `;
        list.appendChild(div);
    });
}

function renderHistory(logs) {
    const list = document.getElementById('history-list');
    list.innerHTML = '';

    if (!logs || logs.length === 0) {
        list.innerHTML = '<p style="text-align:center;color:var(--hint-color)">No history yet.</p>';
        return;
    }

    // Group logs by taken_at timestamp (formatted to minute precision)
    const groups = [];
    // Helper for European Date Format (DD.MM.YYYY HH:MM)
    /* formatDate is now global */

    logs.forEach(l => {
        let key = l.scheduled_at; // Default key
        let timeLabel = formatDate(l.scheduled_at);

        // If taken, use taken_at as grouping key
        if (l.status === 'TAKEN' && l.taken_at) {
            const d = new Date(l.taken_at);
            // Key is string to minute precision
            key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`;
            timeLabel = formatDate(l.taken_at);
        }

        // Check if group exists
        let grp = groups.find(g => g.key === key && g.status === l.status);
        if (!grp) {
            grp = { key, status: l.status, timeLabel, items: [] };
            groups.push(grp);
        }
        grp.items.push(l);
    });

    // Render Groups
    groups.forEach(g => {
        const div = document.createElement('div');
        div.className = 'history-group';

        const statusIcon = g.status === 'TAKEN' ? '✅' : (g.status === 'PENDING' ? '⏳' : '❌');
        let headerHTML = `<div class="history-header"><strong>${statusIcon} ${g.timeLabel}</strong></div>`;

        let itemsHTML = '<div class="history-items">';
        g.items.forEach(l => {
            const med = medications.find(m => m.id === l.medication_id) || { name: 'Unknown Med', dosage: '' };
            itemsHTML += `<div class="history-subitem">${escapeHtml(med.name)}</div>`;
        });
        itemsHTML += '</div>';

        div.innerHTML = headerHTML + itemsHTML;
        list.appendChild(div);
    });
}

function escapeHtml(text) {
    if (!text) return "";
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// Logic
async function loadMeds() {
    const res = await apiCall('/api/medications?archived=true');
    if (res) {
        medications = res;
        renderMeds();
        populateMedFilter();
    }
}

function populateMedFilter() {
    const select = document.getElementById('history-filter-med');
    if (!select) return;
    const currentVal = select.value;

    // Keep "All Medications"
    select.innerHTML = '<option value="0">All Medications</option>';

    // Sort alphabetically
    const sorted = [...medications].sort((a, b) => a.name.localeCompare(b.name));

    sorted.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.innerText = m.name + (m.archived ? ' (Archived)' : '');
        select.appendChild(opt);
    });

    select.value = currentVal;
}

async function saveMedication() {
    const name = document.getElementById('med-name').value;
    const dosage = document.getElementById('med-dosage').value;
    const type = document.getElementById('schedule-type').value;
    const archived = document.getElementById('med-archived').checked;

    const startDateRaw = document.getElementById('med-start-date').value;
    const endDateRaw = document.getElementById('med-end-date').value;

    if (!name) { tg.showAlert("Name is required!"); return; }

    const schedule = { type: type };

    if (type !== 'as_needed') {
        const times = Array.from(document.querySelectorAll('.med-time-input'))
            .map(i => i.value)
            .filter(v => v !== "");

        if (times.length === 0) {
            tg.showAlert("At least one time is required!");
            return;
        }
        schedule.times = times;
    }

    if (type === 'weekly') {
        const days = Array.from(document.querySelectorAll('.days-select span.selected'))
            .map(s => parseInt(s.dataset.day));

        if (days.length === 0) {
            tg.showAlert("Select at least one day!");
            return;
        }
        schedule.days = days;
    }

    const payload = {
        name,
        dosage,
        schedule: JSON.stringify(schedule),
        archived,
        start_date: startDateRaw ? new Date(startDateRaw).toISOString() : null,
        end_date: endDateRaw ? new Date(endDateRaw).toISOString() : null
    };

    if (editingMedId) {
        await apiCall(`/api/medications/${editingMedId}`, 'POST', payload);
    } else {
        await apiCall('/api/medications', 'POST', payload);
    }

    closeModal();
    loadMeds();
}

async function deleteMed(id) {
    const confirmMsg = "Archive this medication?";

    // Check if we are in Telegram and version supports it
    if (userInitData && tg.showConfirm) {
        try {
            tg.showConfirm(confirmMsg, (ok) => {
                if (ok) _archiveMedApi(id);
            });
            return;
        } catch (e) {
            console.log("tg.showConfirm failed, falling back", e);
        }
    }

    // Fallback for browser
    if (confirm(confirmMsg)) {
        _archiveMedApi(id);
    }
}

async function _archiveMedApi(id) {
    // Fetch current med data first to preserve other fields
    const med = medications.find(m => m.id === id);
    if (!med) return;

    const payload = {
        name: med.name,
        dosage: med.dosage,
        schedule: med.schedule,
        archived: true // Set archived to true
    };

    await apiCall(`/api/medications/${id}`, 'POST', payload);
    loadMeds();
}

async function loadHistory() {
    // Ensure medications are loaded for name resolution
    if (medications.length === 0) await loadMeds();

    const days = document.getElementById('history-filter-days').value;
    const medId = document.getElementById('history-filter-med').value;

    const res = await apiCall(`/api/history?days=${days}&med_id=${medId}`);
    // If res is null (not found or error), pass empty array to clear list
    renderHistory(res || []);
}

// Init
loadMeds();
