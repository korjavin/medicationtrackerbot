// Init Telegram Web App
const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

// Config
const userInitData = tg.initData;
if (!userInitData) {
    if (window.location.hostname === "localhost") {
        console.warn("No InitData. Running in localhost mode. NOTE: API will fail if backend enforces auth.");
    } else {
        document.body.innerHTML = "<h2 style='text-align:center;margin-top:20px;'>Please open this app in Telegram</h2>";
    }
}

// API Client
async function apiCall(endpoint, method = "GET", body = null) {
    const headers = {
        "X-Telegram-Init-Data": userInitData
    };
    if (body) {
        headers["Content-Type"] = "application/json";
    }

    try {
        const res = await fetch(endpoint, {
            method,
            headers,
            body: body ? JSON.stringify(body) : null
        });

        if (res.status === 401 || res.status === 403) {
            alert("Unauthorized!");
            return null;
        }
        
        if (!res.ok) {
            const txt = await res.text();
            throw new Error(txt);
        }

        if (method !== "DELETE" && res.status !== 204) {
             // Handle empty response for void returns
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

// UI Functions
function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    
    // Find button with onclick matching tab
    const btn = Array.from(document.querySelectorAll('.tab')).find(b => b.textContent.toLowerCase() === (tab === 'meds' ? 'medications' : 'history'));
    // Actually simpler to just use tab index or class logic, but strict match:
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
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('med-modal').classList.remove('hidden');
}

function closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    document.getElementById('med-modal').classList.add('hidden');
    document.getElementById('med-name').value = '';
    document.getElementById('med-dosage').value = '';
    document.getElementById('med-time').value = '';
}

// Render
function renderMeds() {
    const list = document.getElementById('med-list');
    list.innerHTML = '';
    
    medications.forEach(m => {
        const div = document.createElement('div');
        div.className = 'med-item';
        div.innerHTML = `
            <div class="med-info">
                <h4>${escapeHtml(m.name)} <small>(${escapeHtml(m.dosage)})</small></h4>
                <p>Schedule: ${m.schedule}</p>
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
        // Need to match med ID to name? 
        // We can fetch meds or just display ID for now, or backend should have returned details.
        // For simplicity: Backend returns IDs. We can look up in 'medications' if loaded, otherwise just show Date.
        // Let's assume user visits Meds tab first OR we fetch meds on init.
        
        const med = medications.find(m => m.id === l.medication_id) || { name: 'Unknown Med', dosage: '' };
        
        const scheduled = new Date(l.scheduled_at).toLocaleString();
        const statusIcon = l.status === 'TAKEN' ? '✅' : (l.status === 'PENDING' ? '⏳' : '❌');
        
        div.innerHTML = `
            <div class="med-info">
                <h4>${statusIcon} ${escapeHtml(med.name)}</h4>
                <p>${scheduled}</p>
            </div>
        `;
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
    const res = await apiCall('/api/medications');
    if (res) {
        medications = res;
        renderMeds();
    }
}

async function saveMedication() {
    const name = document.getElementById('med-name').value;
    const dosage = document.getElementById('med-dosage').value;
    const time = document.getElementById('med-time').value; // HH:MM
    
    if (!name || !time) {
        tg.showAlert("Name and Time are required!");
        return;
    }
    
    await apiCall('/api/medications', 'POST', {
        name,
        dosage,
        schedule: time
    });
    
    closeModal();
    loadMeds();
}

async function deleteMed(id) {
    tg.showConfirm("Archive this medication?", (ok) => {
        if (ok) {
            _deleteMedApi(id);
        }
    });
}

async function _deleteMedApi(id) {
     await apiCall(`/api/medications/${id}`, 'DELETE');
     loadMeds();
}

async function loadHistory() {
    // Ideally ensure meds are loaded to map IDs
    if (medications.length === 0) {
        await loadMeds(); // Prefetch meds for names
    }
    const res = await apiCall('/api/history');
    if (res) {
        renderHistory(res);
    }
}

// Init
loadMeds();
