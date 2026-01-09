// Init Telegram Web App
const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

// Config
// Config
// Config
const userInitData = tg.initData;
let initialAuthLoad = false;

// Check Auth Environment
async function checkAuth() {
    if (userInitData) {
        // We are in Telegram, proceed as normal
        return true;
    }

    // Not in Telegram. Try to access API to see if we have valid Session Cookie
    try {
        // Optimization: Fetch full data here to avoid second request
        const res = await fetch('/api/medications?archived=true', { method: 'GET' });
        if (res.status === 200) {
            // Authorized via Cookie!
            const data = await res.json();
            medications = data;
            initialAuthLoad = true;
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
    } else if (tab === 'history') {
        document.querySelector('button[onclick="switchTab(\'history\')"]').classList.add('active');
        document.getElementById('history-view').classList.add('active');
        loadHistory();
    } else if (tab === 'bp') {
        document.querySelector('button[onclick="switchTab(\'bp\')"]').classList.add('active');
        document.getElementById('bp-view').classList.add('active');
        loadBPReadings();
    } else if (tab === 'weight') {
        document.querySelector('button[onclick="switchTab(\'weight\')"]').classList.add('active');
        document.getElementById('weight-view').classList.add('active');
        loadWeightLogs();
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
    document.getElementById('med-rx-display').style.display = 'none';
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

    // Show RxNorm
    const rxDisplay = document.getElementById('med-rx-display');
    if (med.normalized_name) {
        rxDisplay.innerText = "Rx: " + med.normalized_name;
        rxDisplay.style.display = 'block';
    } else {
        rxDisplay.style.display = 'none';
    }

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
                    dBase.setDate(now.getDate() + i);
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
                ${m.normalized_name ? `<p style="font-size:0.85em;color:var(--hint-color);margin-top:-5px;margin-bottom:4px;">Rx: ${escapeHtml(m.normalized_name)}</p>` : ''}
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
            grp = { key, status: l.status, timeLabel, items: [], sortTime: 0 };

            // Determine sort time
            if (l.status === 'TAKEN' && l.taken_at) {
                grp.sortTime = new Date(l.taken_at).getTime();
            } else {
                grp.sortTime = new Date(l.scheduled_at).getTime();
            }

            groups.push(grp);
        }
        grp.items.push(l);
    });

    // Sort Groups Descending (Most Recent First)
    groups.sort((a, b) => b.sortTime - a.sortTime);

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
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Logic
async function loadMeds() {
    if (initialAuthLoad) {
        initialAuthLoad = false;
        renderMeds();
        populateMedFilter();
        return;
    }

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

    let res;
    if (editingMedId) {
        res = await apiCall(`/api/medications/${editingMedId}`, 'POST', payload);
    } else {
        res = await apiCall('/api/medications', 'POST', payload);
    }

    if (res && res.warning) {
        tg.showAlert("⚠️ " + res.warning);
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

    const res = await apiCall(`/api/medications/${id}`, 'POST', payload);
    if (res && res.warning) {
        tg.showAlert("⚠️ " + res.warning);
    }
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
// loadMeds() removed to avoid redundant call. It is called by checkAuth -> switchTab.


// --- Weekly Adherence Visualization ---

const MED_COLORS = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEEAD',
    '#D4A5A5', '#9B59B6', '#3498DB', '#E67E22', '#2ECC71'
];

function getMedColor(id) {
    // Deterministic color based on ID
    return MED_COLORS[id % MED_COLORS.length];
}

async function renderWeeklyHub() {
    const container = document.getElementById('weekly-hub-container');
    if (!container) return;

    // 1. Calculate last 7 days (including today)
    const days = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        days.push(d);
    }

    // 2. Fetch history for this range (7 days)
    // We reuse the existing history API but maybe we need to fetch enough.
    // The existing API defaults to 3 days. We need to force it or add a specific call.
    // Let's just use the history API with days=7 for all meds (med_id=0).
    const res = await apiCall(`/api/history?days=7&med_id=0`);
    const historyLogs = res || [];

    // 3. Build HTML
    let html = `
        <h3 class="weekly-header">Last 7 Days</h3>
        <div class="weekly-days">
    `;

    days.forEach(dateObj => {
        const dateStr = dateObj.toISOString().split('T')[0]; // YYYY-MM-DD
        const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'short' }); // Mon, Tue...
        const dayNum = dateObj.getDate();

        // Find what should have been taken on this day
        // This is tricky because "schedule" logic is complex (weekly, days, etc.)
        // We will simplify: Check all active meds.
        // If a med was scheduled for this day (based on its schedule), we expect a log.
        // OR we just look at the logs? No, logs only show what happened.
        // We need to know what *should* have happened.
        // For now, let's look at logs to see if anything was done.
        // BUT the requirement is: "different scheduled medicine might have different color"
        // So we need to know the schedule.

        let scheduledMeds = [];
        const dayOfWeek = dateObj.getDay(); // 0-6

        medications.forEach(m => {
            if (m.archived) return;
            // Check if m applies to this day
            // Start/End date check
            const start = m.start_date ? new Date(m.start_date) : null;
            const end = m.end_date ? new Date(m.end_date) : null;

            // Normalize dateObj to midnight for comparison
            const checkDate = new Date(dateStr);
            if (start && checkDate < new Date(start.toISOString().split('T')[0])) return;
            if (end && checkDate > new Date(end.toISOString().split('T')[0])) return;

            try {
                const sched = JSON.parse(m.schedule);
                if (sched.type === 'daily') {
                    scheduledMeds.push(m);
                } else if (sched.type === 'weekly') {
                    if (sched.days && sched.days.includes(dayOfWeek)) {
                        scheduledMeds.push(m);
                    }
                }
                // 'as_needed' doesn't count for adherence circles usually
            } catch (e) { }
        });

        // Now check status for these meds on this date
        // We look for logs where scheduled_at (or taken_at if no scheduled_at) matches dateStr
        // Actually, logs store specific timestamps.
        // We'll check if there's a TAKEN log for this med on this day.

        const segments = [];
        if (scheduledMeds.length === 0) {
            // No meds scheduled -> maybe grey or empty?
            // Let's leave it empty (grey default)
        } else {
            const segmentSize = 100 / scheduledMeds.length;
            let currentAngle = 0;

            scheduledMeds.forEach(m => {
                // Did we take it?
                // Look for a log for this med on this date with status TAKEN
                const taken = historyLogs.find(l => {
                    if (l.medication_id !== m.id) return false;
                    if (l.status !== 'TAKEN') return false;
                    // Check date match.
                    // If scheduled_at exists, use it. Else use taken_at.
                    const refIso = l.scheduled_at || l.taken_at;
                    return refIso.startsWith(dateStr);
                });

                const color = taken ? getMedColor(m.id) : '#e0e0e0';
                segments.push(`${color} ${currentAngle}% ${currentAngle + segmentSize}%`);
                currentAngle += segmentSize;
            });
        }

        let backgroundStyle = '';
        if (segments.length > 0) {
            backgroundStyle = `background: conic-gradient(${segments.join(', ')});`;
        }

        html += `
            <div class="day-column">
                <div class="day-label">${dayName}</div>
                <div class="day-circle" style="${backgroundStyle}"></div>
                <div class="day-date">${dayNum}</div>
            </div>
        `;
    });

    html += `</div>`;
    container.innerHTML = html;
}

// Hook into loadMeds to trigger this update
const originalLoadMeds = loadMeds;
loadMeds = async function () {
    await originalLoadMeds();
    renderWeeklyHub();
};

// ==================== Blood Pressure Functions ====================

// Get BP category based on ISH 2020 guidelines (for users < 65 years)
function getBPCategory(sys, dia) {
    // Grade 2 Hypertension: ≥160 and/or ≥100
    if (sys >= 160 || dia >= 100) return { label: 'Grade 2 HTN', class: 'grade2' };
    // Grade 1 Hypertension: 140-159 and/or 90-99
    if (sys >= 140 || dia >= 90) return { label: 'Grade 1 HTN', class: 'grade1' };
    // High-normal: 130-139 and/or 85-89
    if (sys >= 130 || dia >= 85) return { label: 'High-normal', class: 'highnormal' };
    // Normal: <130 and <85
    return { label: 'Normal', class: 'normal' };
}

// Show BP recording modal
function showBPRecordModal() {
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('bp-modal').classList.remove('hidden');

    // Set default datetime to now
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    const localISOTime = (new Date(now - offset)).toISOString().slice(0, 16);
    document.getElementById('bp-datetime').value = localISOTime;

    // Clear other fields
    document.getElementById('bp-systolic').value = '';
    document.getElementById('bp-diastolic').value = '';
    document.getElementById('bp-pulse').value = '';
    document.getElementById('bp-notes').value = '';
    document.getElementById('bp-site').value = 'right_arm';
    document.getElementById('bp-position').value = 'seated';
}

// Close BP modal
function closeBPRecordModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    document.getElementById('bp-modal').classList.add('hidden');
}

// Handle BP form submission
async function handleBPSubmit(event) {
    event.preventDefault();

    const datetime = document.getElementById('bp-datetime').value;
    const systolic = parseInt(document.getElementById('bp-systolic').value);
    const diastolic = parseInt(document.getElementById('bp-diastolic').value);
    const pulse = document.getElementById('bp-pulse').value ? parseInt(document.getElementById('bp-pulse').value) : null;
    const site = document.getElementById('bp-site').value;
    const position = document.getElementById('bp-position').value;
    const notes = document.getElementById('bp-notes').value;

    if (!datetime || !systolic || !diastolic) {
        tg.showAlert('Please fill in all required fields');
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

    const res = await apiCall('/api/bp', 'POST', payload);

    if (res) {
        closeBPRecordModal();
        loadBPReadings();
    }
}

// Load BP readings from API
async function loadBPReadings() {
    const list = document.getElementById('bp-list');
    list.innerHTML = '<li style="text-align:center;color:var(--hint-color);padding:20px;">Loading...</li>';

    const [readingsRes, goalRes] = await Promise.all([
        apiCall('/api/bp?days=30'),
        apiCall('/api/bp/goal')
    ]);

    if (readingsRes === null) {
        list.innerHTML = '<li style="text-align:center;color:var(--hint-color);padding:20px;">Failed to load readings</li>';
        return;
    }

    renderBPChart(readingsRes || [], goalRes || {});
    renderBPReadings(readingsRes || []);
}

// Render BP Chart with smooth curves
function renderBPChart(readings, goalData) {
    const container = document.getElementById('bpChart');
    if (!container) return;

    container.innerHTML = '';

    if (!readings || readings.length === 0) {
        container.innerHTML = '<span style="color:var(--hint-color);font-size:14px;">No data available</span>';
        return;
    }

    // Sort by date (oldest first)
    const sorted = [...readings].sort((a, b) => new Date(a.measured_at) - new Date(b.measured_at));

    // Extract data series
    const data = sorted.map(r => ({
        date: new Date(r.measured_at),
        sys: r.systolic,
        dia: r.diastolic,
        pulse: r.pulse
    }));

    // Dimensions
    const leftPadding = 35;
    const totalWidth = container.clientWidth;
    const chartWidth = totalWidth - leftPadding - 10;
    const chartHeight = container.clientHeight - 35;

    // Find min/max across all series
    let minVal = Math.min(...data.map(d => d.dia), ...data.filter(d => d.pulse).map(d => d.pulse));
    let maxVal = Math.max(...data.map(d => d.sys), ...data.filter(d => d.pulse).map(d => d.pulse));

    // Include goals in range
    if (goalData && goalData.target_systolic) {
        maxVal = Math.max(maxVal, goalData.target_systolic);
    }
    if (goalData && goalData.target_diastolic) {
        minVal = Math.min(minVal, goalData.target_diastolic);
    }

    const range = maxVal - minVal || 1;
    const yPad = range * 0.1;
    const effectiveMin = minVal - yPad;
    const effectiveMax = maxVal + yPad;
    const effectiveRange = effectiveMax - effectiveMin;

    // Date range
    const firstDate = data[0].date;
    const lastDate = data[data.length - 1].date;
    const dateRange = lastDate - firstDate || 1;

    const xScaleByDate = (date) => leftPadding + ((date - firstDate) / dateRange) * chartWidth;
    const yScale = (v) => chartHeight - ((v - effectiveMin) / effectiveRange) * chartHeight;

    // Helper: generate smooth bezier path from points
    const smoothPath = (points) => {
        if (points.length < 2) return '';
        let d = `M ${points[0][0]},${points[0][1]}`;
        for (let i = 1; i < points.length; i++) {
            const prev = points[i - 1];
            const curr = points[i];
            const cpx = (prev[0] + curr[0]) / 2;
            d += ` Q ${prev[0]},${prev[1]} ${cpx},${(prev[1] + curr[1]) / 2}`;
        }
        // Final segment
        const last = points[points.length - 1];
        d += ` L ${last[0]},${last[1]}`;
        return d;
    };

    // Generate points for each series
    const sysPoints = data.map(d => [xScaleByDate(d.date), yScale(d.sys)]);
    const diaPoints = data.map(d => [xScaleByDate(d.date), yScale(d.dia)]);
    const pulsePoints = data.filter(d => d.pulse).map(d => [xScaleByDate(d.date), yScale(d.pulse)]);

    // SVG Construction
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("viewBox", `0 0 ${totalWidth} ${chartHeight + 20}`);

    // Y-Axis Labels
    const yAxisValues = [Math.round(minVal), Math.round(maxVal)];
    yAxisValues.forEach(val => {
        const y = yScale(val);
        const text = document.createElementNS(svgNs, "text");
        text.setAttribute("x", leftPadding - 5);
        text.setAttribute("y", y + 4);
        text.setAttribute("class", "chart-label");
        text.setAttribute("style", "text-anchor: end; fill: var(--hint-color);");
        text.textContent = val;
        svg.appendChild(text);

        const gridLine = document.createElementNS(svgNs, "line");
        gridLine.setAttribute("x1", leftPadding);
        gridLine.setAttribute("y1", y);
        gridLine.setAttribute("x2", totalWidth - 10);
        gridLine.setAttribute("y2", y);
        gridLine.setAttribute("class", "chart-grid");
        svg.appendChild(gridLine);
    });

    // Goal lines
    if (goalData && goalData.target_systolic) {
        const y = yScale(goalData.target_systolic);
        const line = document.createElementNS(svgNs, "line");
        line.setAttribute("x1", leftPadding);
        line.setAttribute("y1", y);
        line.setAttribute("x2", totalWidth - 10);
        line.setAttribute("y2", y);
        line.setAttribute("class", "bp-chart-target");
        svg.appendChild(line);

        const label = document.createElementNS(svgNs, "text");
        label.setAttribute("x", totalWidth - 15);
        label.setAttribute("y", y - 3);
        label.setAttribute("class", "chart-label");
        label.setAttribute("style", "text-anchor: end; fill: #f97316; font-size: 10px;");
        label.textContent = `High ${goalData.target_systolic}`;
        svg.appendChild(label);
    }

    if (goalData && goalData.target_diastolic) {
        const y = yScale(goalData.target_diastolic);
        const line = document.createElementNS(svgNs, "line");
        line.setAttribute("x1", leftPadding);
        line.setAttribute("y1", y);
        line.setAttribute("x2", totalWidth - 10);
        line.setAttribute("y2", y);
        line.setAttribute("class", "bp-chart-target");
        svg.appendChild(line);

        const label = document.createElementNS(svgNs, "text");
        label.setAttribute("x", totalWidth - 15);
        label.setAttribute("y", y + 10);
        label.setAttribute("class", "chart-label");
        label.setAttribute("style", "text-anchor: end; fill: #f97316; font-size: 10px;");
        label.textContent = `Low ${goalData.target_diastolic}`;
        svg.appendChild(label);
    }

    // Draw pulse line (behind others)
    if (pulsePoints.length > 1) {
        const pulsePath = document.createElementNS(svgNs, "path");
        pulsePath.setAttribute("d", smoothPath(pulsePoints));
        pulsePath.setAttribute("class", "bp-chart-pulse");
        svg.appendChild(pulsePath);
    }

    // Draw diastolic line
    const diaPath = document.createElementNS(svgNs, "path");
    diaPath.setAttribute("d", smoothPath(diaPoints));
    diaPath.setAttribute("class", "bp-chart-diastolic");
    svg.appendChild(diaPath);

    // Draw systolic line
    const sysPath = document.createElementNS(svgNs, "path");
    sysPath.setAttribute("d", smoothPath(sysPoints));
    sysPath.setAttribute("class", "bp-chart-systolic");
    svg.appendChild(sysPath);

    // Draw points
    sysPoints.forEach(p => {
        const circle = document.createElementNS(svgNs, "circle");
        circle.setAttribute("cx", p[0]);
        circle.setAttribute("cy", p[1]);
        circle.setAttribute("r", 3);
        circle.setAttribute("class", "bp-chart-point-sys");
        svg.appendChild(circle);
    });

    diaPoints.forEach(p => {
        const circle = document.createElementNS(svgNs, "circle");
        circle.setAttribute("cx", p[0]);
        circle.setAttribute("cy", p[1]);
        circle.setAttribute("r", 3);
        circle.setAttribute("class", "bp-chart-point-dia");
        svg.appendChild(circle);
    });

    // Date labels
    const firstLabel = document.createElementNS(svgNs, "text");
    firstLabel.setAttribute("x", leftPadding);
    firstLabel.setAttribute("y", chartHeight + 15);
    firstLabel.setAttribute("class", "chart-label");
    firstLabel.setAttribute("style", "text-anchor: start;");
    firstLabel.textContent = data[0].date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    svg.appendChild(firstLabel);

    const lastLabel = document.createElementNS(svgNs, "text");
    lastLabel.setAttribute("x", totalWidth - 10);
    lastLabel.setAttribute("y", chartHeight + 15);
    lastLabel.setAttribute("class", "chart-label");
    lastLabel.setAttribute("style", "text-anchor: end;");
    lastLabel.textContent = data[data.length - 1].date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    svg.appendChild(lastLabel);

    container.appendChild(svg);
}

// Render BP readings grouped by date
function renderBPReadings(readings) {
    const list = document.getElementById('bp-list');
    list.innerHTML = '';

    if (!readings || readings.length === 0) {
        list.innerHTML = '';
        return;
    }

    // Group readings by date
    const groups = { today: [], yesterday: [], older: [] };
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    readings.forEach(r => {
        const date = new Date(r.measured_at);
        date.setHours(0, 0, 0, 0);

        if (date.getTime() === today.getTime()) {
            groups.today.push(r);
        } else if (date.getTime() === yesterday.getTime()) {
            groups.yesterday.push(r);
        } else {
            groups.older.push(r);
        }
    });

    // Helper to render a group
    const renderGroup = (headerText, readings) => {
        if (readings.length === 0) return '';

        let html = `<li class="bp-date-group">
            <div class="bp-date-header">${headerText}</div>
            <ul style="list-style:none;padding:0;margin:0;">`;

        readings.forEach(r => {
            const category = getBPCategory(r.systolic, r.diastolic);
            const timeStr = formatDate(r.measured_at).split(' ')[1]; // Get HH:MM part

            html += `<li class="bp-item">
                <div class="bp-reading">
                    <div class="bp-values">
                        <span class="bp-sys">${r.systolic}</span>
                        <span class="bp-dia">/${r.diastolic}</span>
                    </div>
                    <div class="bp-meta">
                        <span>${timeStr}</span>`;

            if (r.pulse) {
                html += `<span class="bp-pulse">${r.pulse} bpm</span>`;
            }

            html += `<span class="bp-category ${category.class}">${category.label}</span>
                    </div>
                </div>
                <button class="delete-btn" onclick="deleteBPReading(${r.id})" title="Delete">&times;</button>
            </li>`;
        });

        html += '</ul></li>';
        return html;
    };

    // Render groups in order
    let html = '';
    html += renderGroup('Today', groups.today);
    html += renderGroup('Yesterday', groups.yesterday);

    if (groups.older.length > 0) {
        // Format older dates
        const olderGroups = {};
        groups.older.forEach(r => {
            const d = new Date(r.measured_at);
            const key = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
            if (!olderGroups[key]) olderGroups[key] = [];
            olderGroups[key].push(r);
        });

        Object.keys(olderGroups).forEach(dateKey => {
            html += renderGroup(dateKey, olderGroups[dateKey]);
        });
    }

    list.innerHTML = html;
}

// Delete a BP reading
async function deleteBPReading(id) {
    const confirmMsg = 'Delete this blood pressure reading?';

    if (userInitData && tg.showConfirm) {
        try {
            tg.showConfirm(confirmMsg, (ok) => {
                if (ok) _deleteBPApi(id);
            });
            return;
        } catch (e) {
            console.log('tg.showConfirm failed, falling back', e);
        }
    }

    if (confirm(confirmMsg)) {
        _deleteBPApi(id);
    }
}

async function _deleteBPApi(id) {
    const res = await apiCall(`/api/bp/${id}`, 'DELETE');
    if (res) {
        loadBPReadings();
    }
}

// Export BP data to CSV
async function exportBPCSV() {
    try {
        const response = await fetch('/api/bp/export', {
            method: 'GET',
            headers: {
                'Authorization': `tma ${userInitData}`
            }
        });

        if (!response.ok) {
            tg.showAlert('Failed to generate export');
            return;
        }

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'blood_pressure_export.csv';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    } catch (err) {
        console.error('Export error:', err);
        tg.showAlert('Failed to export data');
    }
}

// ==================== Weight Tracking Functions ====================

function showWeightModal() {
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('weight-modal').classList.remove('hidden');

    // Set default datetime to now
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    const localISOTime = (new Date(now - offset)).toISOString().slice(0, 16);
    document.getElementById('weight-datetime').value = localISOTime;

    // Clear other fields
    document.getElementById('weight-value').value = '';
    document.getElementById('weight-notes').value = '';
}

function closeWeightModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    document.getElementById('weight-modal').classList.add('hidden');
}

async function handleWeightSubmit(event) {
    event.preventDefault();

    const datetime = document.getElementById('weight-datetime').value;
    const weight = parseFloat(document.getElementById('weight-value').value);
    const notes = document.getElementById('weight-notes').value;

    if (!datetime || !weight) {
        tg.showAlert('Please fill in all required fields');
        return;
    }

    const payload = {
        measured_at: new Date(datetime).toISOString(),
        weight,
        notes
    };

    const res = await apiCall('/api/weight', 'POST', payload);

    if (res) {
        closeWeightModal();
        loadWeightLogs();
    }
}

// Render weight chart
// Render weight chart using SVG (Lightweight & Cute)
function renderWeightChart(logs, goalData) {
    const container = document.getElementById('weightChart');
    if (!container) return;

    container.innerHTML = ''; // Clear previous

    if (!logs || logs.length === 0) {
        container.innerHTML = '<span style="color:var(--hint-color);font-size:14px;">No data available</span>';
        return;
    }

    // Sort logs by date (oldest first)
    const sortedLogs = [...logs].sort((a, b) => new Date(a.measured_at) - new Date(b.measured_at));
    const data = sortedLogs.map(w => ({
        date: new Date(w.measured_at),
        val: w.weight
    }));

    // Dimensions with left padding for Y-axis
    const leftPadding = 45;
    const totalWidth = container.clientWidth;
    const chartWidth = totalWidth - leftPadding - 10;
    const chartHeight = container.clientHeight - 45;

    // Min/Max (include goal in range if set)
    const vals = data.map(d => d.val);
    let minVal = Math.min(...vals);
    let maxVal = Math.max(...vals);

    if (goalData && goalData.goal) {
        minVal = Math.min(minVal, goalData.goal);
        maxVal = Math.max(maxVal, goalData.goal);
    }

    const range = maxVal - minVal || 1;

    // Date range: from first data point to 3 days after last data point
    const firstDate = data[0].date;
    const lastDataDate = data[data.length - 1].date;
    const chartEndDate = new Date(lastDataDate.getTime() + 3 * 24 * 60 * 60 * 1000); // +3 days
    const dateRange = chartEndDate - firstDate || 1;

    const xScaleByDate = (date) => leftPadding + ((date - firstDate) / dateRange) * chartWidth;

    // Y Scale with padding (10% top/bottom)
    const yPad = range * 0.1;
    const effectiveMin = minVal - yPad;
    const effectiveMax = maxVal + yPad;
    const effectiveRange = effectiveMax - effectiveMin;
    const yScale = (v) => chartHeight - ((v - effectiveMin) / effectiveRange) * chartHeight;

    // Generate Points using date-based X positioning
    const points = data.map(d => [xScaleByDate(d.date), yScale(d.val)]);

    // Generate Path
    let pathD = `M ${points[0][0]},${points[0][1]}`;
    points.forEach((p, i) => {
        if (i === 0) return;
        pathD += ` L ${p[0]},${p[1]}`;
    });

    // Area Path
    const areaD = `${pathD} L ${points[points.length - 1][0]},${chartHeight} L ${points[0][0]},${chartHeight} Z`;

    // SVG Construction
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("class", "chart-svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("viewBox", `0 0 ${totalWidth} ${chartHeight + 25}`);

    // Y-Axis Labels (left side)
    const yAxisValues = [minVal, maxVal];
    yAxisValues.forEach(val => {
        const y = yScale(val);
        const text = document.createElementNS(svgNs, "text");
        text.setAttribute("x", leftPadding - 5);
        text.setAttribute("y", y + 4);
        text.setAttribute("class", "chart-label");
        text.setAttribute("style", "text-anchor: end; fill: var(--hint-color);");
        text.textContent = val.toFixed(1);
        svg.appendChild(text);

        // Grid line
        const gridLine = document.createElementNS(svgNs, "line");
        gridLine.setAttribute("x1", leftPadding);
        gridLine.setAttribute("y1", y);
        gridLine.setAttribute("x2", totalWidth - 10);
        gridLine.setAttribute("y2", y);
        gridLine.setAttribute("class", "chart-grid");
        svg.appendChild(gridLine);
    });

    // Goal Line (horizontal green line)
    if (goalData && goalData.goal) {
        const goalY = yScale(goalData.goal);
        const goalLine = document.createElementNS(svgNs, "line");
        goalLine.setAttribute("x1", leftPadding);
        goalLine.setAttribute("y1", goalY);
        goalLine.setAttribute("x2", totalWidth - 10);
        goalLine.setAttribute("y2", goalY);
        goalLine.setAttribute("class", "chart-goal-line");
        svg.appendChild(goalLine);

        // Goal label on left
        const goalLabel = document.createElementNS(svgNs, "text");
        goalLabel.setAttribute("x", leftPadding - 5);
        goalLabel.setAttribute("y", goalY + 4);
        goalLabel.setAttribute("class", "chart-label");
        goalLabel.setAttribute("style", "text-anchor: end; fill: #22c55e; font-weight: bold;");
        goalLabel.textContent = goalData.goal.toFixed(1);
        svg.appendChild(goalLabel);
    }

    // Plan Line: from max weight point straight to goal point
    if (goalData && goalData.goal && goalData.goal_date) {
        const goalDate = new Date(goalData.goal_date);
        const goalWeight = goalData.goal;

        // Find max weight point as starting reference
        const maxWeight = Math.max(...vals);
        let maxWeightDate = data[0].date;
        data.forEach(d => {
            if (d.val === maxWeight) maxWeightDate = d.date;
        });

        // Draw line from max weight point toward goal
        // Calculate where line intersects chart boundaries
        const totalTimeSpan = goalDate - maxWeightDate;
        const weightDiff = goalWeight - maxWeight;

        if (totalTimeSpan > 0) {
            // Linear interpolation function
            const getWeightAtDate = (date) => {
                const elapsed = date - maxWeightDate;
                return maxWeight + (weightDiff * elapsed / totalTimeSpan);
            };

            // Start point: max weight point (or left edge if max is before chart start)
            let startDate = maxWeightDate;
            if (startDate < firstDate) startDate = firstDate;
            const startWeight = getWeightAtDate(startDate);

            // End point: goal date or chart end, whichever is earlier
            let endDate = goalDate;
            if (endDate > chartEndDate) endDate = chartEndDate;
            const endWeight = getWeightAtDate(endDate);

            const startX = xScaleByDate(startDate);
            const startY = yScale(startWeight);
            const endX = xScaleByDate(endDate);
            const endY = yScale(endWeight);

            const planLine = document.createElementNS(svgNs, "line");
            planLine.setAttribute("x1", startX);
            planLine.setAttribute("y1", startY);
            planLine.setAttribute("x2", endX);
            planLine.setAttribute("y2", endY);
            planLine.setAttribute("class", "chart-plan-line");
            svg.appendChild(planLine);
        }
    }

    // Area
    const pathArea = document.createElementNS(svgNs, "path");
    pathArea.setAttribute("d", areaD);
    pathArea.setAttribute("class", "chart-area");
    svg.appendChild(pathArea);

    // Line
    const pathLine = document.createElementNS(svgNs, "path");
    pathLine.setAttribute("d", pathD);
    pathLine.setAttribute("class", "chart-line");
    svg.appendChild(pathLine);

    // Points
    points.forEach((p, i) => {
        const circle = document.createElementNS(svgNs, "circle");
        circle.setAttribute("cx", p[0]);
        circle.setAttribute("cy", p[1]);
        circle.setAttribute("r", 4);
        circle.setAttribute("class", "chart-point");
        svg.appendChild(circle);
    });

    // Data labels for first and last point only
    const firstLabel = document.createElementNS(svgNs, "text");
    firstLabel.setAttribute("x", points[0][0]);
    firstLabel.setAttribute("y", points[0][1] - 10);
    firstLabel.setAttribute("class", "chart-label");
    firstLabel.textContent = data[0].val.toFixed(1);
    svg.appendChild(firstLabel);

    const lastLabel = document.createElementNS(svgNs, "text");
    lastLabel.setAttribute("x", points[points.length - 1][0]);
    lastLabel.setAttribute("y", points[points.length - 1][1] - 10);
    lastLabel.setAttribute("class", "chart-label");
    lastLabel.textContent = data[data.length - 1].val.toFixed(1);
    svg.appendChild(lastLabel);

    // Date Labels (bottom)
    const firstDateLabel = document.createElementNS(svgNs, "text");
    firstDateLabel.setAttribute("x", leftPadding);
    firstDateLabel.setAttribute("y", chartHeight + 18);
    firstDateLabel.setAttribute("class", "chart-label");
    firstDateLabel.setAttribute("style", "text-anchor: start");
    firstDateLabel.textContent = data[0].date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    svg.appendChild(firstDateLabel);

    const lastDateLabel = document.createElementNS(svgNs, "text");
    lastDateLabel.setAttribute("x", totalWidth - 10);
    lastDateLabel.setAttribute("y", chartHeight + 18);
    lastDateLabel.setAttribute("class", "chart-label");
    lastDateLabel.setAttribute("style", "text-anchor: end");
    lastDateLabel.textContent = chartEndDate.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    svg.appendChild(lastDateLabel);

    container.appendChild(svg);
}

async function loadWeightLogs() {
    const list = document.getElementById('weight-list');
    list.innerHTML = '<li style="text-align:center;color:var(--hint-color);padding:20px;">Loading...</li>';

    const [logsRes, goalRes] = await Promise.all([
        apiCall('/api/weight?days=14'),
        apiCall('/api/weight/goal')
    ]);

    if (logsRes === null) {
        list.innerHTML = '<li style="text-align:center;color:var(--hint-color);padding:20px;">Failed to load weight logs</li>';
        return;
    }

    renderWeightLogs(logsRes || []);
    renderWeightChart(logsRes || [], goalRes || {});
}

function renderWeightLogs(logs) {
    const list = document.getElementById('weight-list');
    list.innerHTML = '';

    if (!logs || logs.length === 0) {
        list.innerHTML = '';
        return;
    }

    // Limit to 30 most recent
    if (logs.length > 30) {
        logs = logs.slice(0, 30);
    }

    let html = '';
    logs.forEach(w => {
        const dateStr = formatDate(w.measured_at);
        const trendDiff = w.weight_trend ? (w.weight - w.weight_trend).toFixed(1) : '0.0';
        const trendIcon = trendDiff > 0 ? '📈' : (trendDiff < 0 ? '📉' : '➡️');

        html += `<li class="weight-item">
            <div class="weight-data">
                <div class="weight-value">${w.weight.toFixed(1)} kg</div>
                <div class="weight-trend">${trendIcon} Trend: ${w.weight_trend ? w.weight_trend.toFixed(1) : w.weight.toFixed(1)} kg</div>
                <div class="weight-meta">${dateStr}</div>
            </div>
            <button class="delete-btn" onclick="deleteWeightLog(${w.id})" title="Delete">&times;</button>
        </li>`;
    });

    list.innerHTML = html;
}

async function deleteWeightLog(id) {
    const confirmMsg = 'Delete this weight log?';

    if (userInitData && tg.showConfirm) {
        try {
            tg.showConfirm(confirmMsg, (ok) => {
                if (ok) _deleteWeightApi(id);
            });
            return;
        } catch (e) {
            console.log('tg.showConfirm failed, falling back', e);
        }
    }

    if (confirm(confirmMsg)) {
        _deleteWeightApi(id);
    }
}

async function _deleteWeightApi(id) {
    const res = await apiCall(`/api/weight/${id}`, 'DELETE');
    if (res) {
        loadWeightLogs();
    }
}

async function exportWeightCSV() {
    try {
        const response = await fetch('/api/weight/export', {
            method: 'GET',
            headers: {
                'Authorization': `tma ${userInitData}`
            }
        });

        if (!response.ok) {
            tg.showAlert('Failed to generate export');
            return;
        }

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'weight_export.csv';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    } catch (err) {
        console.error('Export error:', err);
        tg.showAlert('Failed to export data');
    }
}
