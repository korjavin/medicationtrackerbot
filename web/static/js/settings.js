// Notification Settings Management

let notificationSettings = [];
let notificationProviders = [];

// Load notification providers and settings
async function loadNotificationSettings() {
    try {
        // Load providers
        const providersResp = await fetch('/api/notifications/providers');
        const providersData = await providersResp.json();
        notificationProviders = providersData.providers || [];

        // Load user settings
        const settingsResp = await fetch('/api/notifications/settings');
        const settingsData = await settingsResp.json();
        notificationSettings = settingsData.settings || [];

        renderNotificationSettings();
    } catch (error) {
        console.error('Failed to load notification settings:', error);
        document.getElementById('notification-providers-loading').textContent = 
            'Failed to load settings. Please refresh.';
    }
}

// Render the notification settings UI
function renderNotificationSettings() {
    const loadingEl = document.getElementById('notification-providers-loading');
    const matrixEl = document.getElementById('notification-providers-matrix');
    
    if (!matrixEl) return;
    
    loadingEl.style.display = 'none';
    matrixEl.style.display = 'block';

    // Render provider status badges
    renderProviderStatus();

    // Render notification matrix
    renderNotificationMatrix();
}

// Render provider status indicators
function renderProviderStatus() {
    const statusEl = document.getElementById('provider-status');
    if (!statusEl) return;

    statusEl.innerHTML = notificationProviders.map(provider => {
        const statusClass = provider.enabled ? 'enabled' : 'disabled';
        const statusText = provider.enabled ? 'Active' : 'Unavailable';
        
        return `
            <div class="provider-status-badge ${statusClass}">
                <span class="status-dot"></span>
                <span>${provider.display_name}: ${statusText}</span>
            </div>
        `;
    }).join('');
}

// Render the notification type × provider matrix
function renderNotificationMatrix() {
    const tbody = document.getElementById('notification-matrix-body');
    if (!tbody) return;

    const notifTypes = [
        { key: 'medication', label: 'Medications' },
        { key: 'workout', label: 'Workouts' },
        { key: 'low_stock', label: 'Low Stock Warnings' },
        { key: 'reminder', label: 'Reminders' }
    ];

    tbody.innerHTML = notifTypes.map(type => {
        return `
            <tr>
                <td>${type.label}</td>
                ${notificationProviders.map(provider => {
                    const setting = notificationSettings.find(
                        s => s.provider === provider.name && s.type === type.key
                    );
                    const isEnabled = setting ? setting.enabled : true;
                    const isProviderAvailable = provider.enabled;
                    
                    return `
                        <td>
                            <label class="toggle">
                                <input type="checkbox" 
                                    ${isEnabled ? 'checked' : ''}
                                    ${!isProviderAvailable ? 'disabled' : ''}
                                    onchange="toggleNotificationSetting('${provider.name}', '${type.key}', this.checked)"
                                >
                                <span class="toggle-slider"></span>
                            </label>
                        </td>
                    `;
                }).join('')}
            </tr>
        `;
    }).join('');
}

// Toggle individual notification setting
async function toggleNotificationSetting(provider, type, enabled) {
    try {
        const resp = await fetch('/api/notifications/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider, type, enabled })
        });

        if (!resp.ok) {
            throw new Error('Failed to update setting');
        }

        // Update local state
        const existing = notificationSettings.find(
            s => s.provider === provider && s.type === type
        );
        if (existing) {
            existing.enabled = enabled;
        } else {
            notificationSettings.push({ provider, type, enabled });
        }

        console.log(`Updated ${provider} ${type}: ${enabled}`);
    } catch (error) {
        console.error('Failed to update notification setting:', error);
        alert('Failed to update setting. Please try again.');
        // Reload to reset UI
        loadNotificationSettings();
    }
}

// Initialize on page load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadNotificationSettings);
} else {
    loadNotificationSettings();
}
