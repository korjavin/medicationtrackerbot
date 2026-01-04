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
function renderMeds() {
    const list = document.getElementById('med-list');
    list.innerHTML = '';

    // Sort: non-archived first, then archived
    const sorted = [...medications].sort((a, b) => {
        if (a.archived === b.archived) return 0;
        return a.archived ? 1 : -1;
    });

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
            const start = m.start_date ? new Date(m.start_date).toLocaleDateString() : 'N/A';
            const end = m.end_date ? new Date(m.end_date).toLocaleDateString() : 'N/A';
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

    logs.forEach(l => {
        const div = document.createElement('div');
        div.className = 'history-item';
        const med = medications.find(m => m.id === l.medication_id) || { name: 'Unknown Med', dosage: '' };

        let timeText = '';
        const scheduled = new Date(l.scheduled_at).toLocaleString();

        if (l.status === 'TAKEN' && l.taken_at) {
            const taken = new Date(l.taken_at).toLocaleString();
            timeText = `<p><strong>Taken: ${taken}</strong></p><p style="font-size:0.85em; color:#666;">Scheduled: ${scheduled}</p>`;
        } else {
            timeText = `<p>Scheduled: ${scheduled}</p>`;
        }

        const statusIcon = l.status === 'TAKEN' ? '✅' : (l.status === 'PENDING' ? '⏳' : '❌');

        div.innerHTML = `
            <div class="med-info">
                <h4>${statusIcon} ${escapeHtml(med.name)}</h4>
                ${timeText}
            </div>
        `;
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
    if (res) { medications = res; renderMeds(); }
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
    // Always reload medications to ensure archived ones are included
    await loadMeds();
    const res = await apiCall('/api/history');
    if (res) renderHistory(res);
}

// Init
loadMeds();
