// Sync UI shell for Med Tracker (cloud-only).
// Handles online/offline detection, the offline banner, toast notifications,
// the sync status bar, and the SyncDebug diagnostics panel.
//
// There is NO offline write queue here: the legacy bot-mode queue
// (defineOfflineEntity, BP/weight/intake sync pipelines, the SW action-queue
// drain, and the offlineAwareApiCall wrapper) was removed in med-a9n5.9. In
// cloud mode that queue never ran — web/cloud/js/apishim.js overwrites
// window.offlineAwareApiCall at boot (installApiShim), checkAuth() awaits
// MedTrackerCloudReady before the first apiCall, the cloud service worker
// never posts SYNC_* messages, and nothing ever wrote to the Dexie queue
// stores (dropped by db.js schema version 7). Offline writes in cloud go
// through the encrypted-oplog sync engine in web/cloud/js/sync.js.

// Debug logger - visible in Telegram WebApp where console isn't accessible
const SyncDebug = {
    enabled: true,
    maxLogs: 50,
    logs: [],

    log(level, message, data = null) {
        const entry = {
            time: new Date().toLocaleTimeString(),
            level,
            message,
            data: data ? JSON.stringify(data).substring(0, 100) : null
        };
        this.logs.unshift(entry);
        if (this.logs.length > this.maxLogs) this.logs.pop();

        // Also log to console if available
        const consoleMsg = `[Sync ${level}] ${message}` + (data ? ` ${JSON.stringify(data)}` : '');
        if (level === 'ERROR') console.error(consoleMsg);
        else console.log(consoleMsg);

        this.updateDebugPanel();
    },

    info(msg, data) { this.log('INFO', msg, data); },
    error(msg, data) { this.log('ERROR', msg, data); },
    warn(msg, data) { this.log('WARN', msg, data); },

    // Robust fallback for escaping HTML entities. window.escapeHtml is defined
    // in core/utils.js (loaded before sync.js); the inline branch is the safety
    // net for any execution path that loads sync.js standalone (tests, tooling).
    _escapeHtml(unsafe) {
        if (!unsafe) return '';
        if (typeof window.escapeHtml === 'function') {
            return window.escapeHtml(unsafe);
        }
        return String(unsafe)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    },

    updateDebugPanel() {
        const panel = document.getElementById('sync-debug-panel');
        if (!panel || panel.style.display === 'none') return;

        const content = panel.querySelector('.debug-content');
        if (!content) return;

        content.innerHTML = this.logs.map(l => {
            const safeMsg = this._escapeHtml(l.message);
            const safeData = l.data ? this._escapeHtml(l.data) : '';
            const safeLevel = this._escapeHtml(l.level);
            const safeTime = this._escapeHtml(l.time);

            return `<div class="debug-line ${safeLevel.toLowerCase()}">
                <span class="debug-time">${safeTime}</span>
                <span class="debug-level">${safeLevel}</span>
                <span class="debug-msg">${safeMsg}</span>
                ${l.data ? `<span class="debug-data">${safeData}</span>` : ''}
            </div>`;
        }).join('');
    },

    // Toggle debug panel visibility
    toggle() {
        const panel = document.getElementById('sync-debug-panel');
        if (panel) {
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
            if (panel.style.display === 'block') this.updateDebugPanel();
        }
    },

    // Create debug panel if it doesn't exist
    createPanel() {
        if (document.getElementById('sync-debug-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'sync-debug-panel';
        panel.className = 'sync-debug-panel';
        panel.innerHTML = `
            <div class="sync-debug-header">
                <strong>Sync Debug Log</strong>
                <button type="button" class="sync-debug-close">Close</button>
            </div>
            <div class="debug-content"></div>
        `;
        const closeBtn = panel.querySelector('.sync-debug-close');
        if (closeBtn) closeBtn.addEventListener('click', () => this.toggle());
        document.body.appendChild(panel);
        // The .debug-* line styles live in css/styles.css (not a runtime-injected
        // <style>, which the cloud origin's strict style-src 'self' CSP blocks —
        // med-eas.22).
    }
};

// Expose globally
window.SyncDebug = SyncDebug;

const SyncManager = {
    isOnline: navigator.onLine,
    isSyncing: false,
    statusCallbacks: [],

    // Initialize sync manager
    init() {
        SyncDebug.createPanel();
        SyncDebug.info('SyncManager initializing', { online: this.isOnline });
        // Listen for online/offline events
        window.addEventListener('online', () => this.handleOnline());
        window.addEventListener('offline', () => this.handleOffline());

        // Update UI
        this.updateOfflineBanner(!this.isOnline);
        this.updateStatus();
        SyncDebug.info('SyncManager initialized', { online: this.isOnline });
    },

    // Handle coming online
    handleOnline() {
        SyncDebug.info('Network: back online');
        this.isOnline = true;
        this.updateOfflineBanner(false);
        this.updateStatus();

        // Reload current tab data to fetch from server
        if (window.requestTabRefresh) {
            SyncDebug.info('Scheduling soft tab refresh');
            window.requestTabRefresh({ source: 'online' });
        } else if (window.reloadCurrentTab) {
            SyncDebug.info('Reloading current tab data');
            window.reloadCurrentTab();
        }
    },

    // Handle going offline
    handleOffline() {
        SyncDebug.warn('Network: gone offline');
        this.isOnline = false;
        this.updateOfflineBanner(true);
        this.updateStatus();
    },

    // Show/hide the offline banner. Nothing else: every cloud write is
    // local-first (durable in IndexedDB before it resolves), so no button is
    // ever disabled for being offline (med-mgvo — the old sweep made Finish a
    // silent no-op).
    updateOfflineBanner(offline) {
        const banner = document.getElementById('offline-banner');
        if (banner) banner.classList.toggle('hidden', !offline);
    },

    // Register callback for status updates
    onStatusChange(callback) {
        this.statusCallbacks.push(callback);
    },

    // Update status in UI. Returns totalPending count (always 0 — the bot
    // offline-write queues are gone, so there is nothing pending by
    // construction; the cloud oplog engine owns offline writes).
    async updateStatus() {
        const status = {
            isOnline: this.isOnline,
            isSyncing: this.isSyncing,
            pendingCount: 0,
            rejectedCount: 0
        };

        // Notify all callbacks
        this.statusCallbacks.forEach(cb => cb(status));

        // Update status bar UI
        this.updateStatusBar(status);
        return 0;
    },

    // Update the status bar in the UI
    updateStatusBar(status) {
        const statusBar = document.getElementById('sync-status-bar');
        if (!statusBar) return;

        // Make status bar clickable to show debug panel
        statusBar.onclick = () => SyncDebug.toggle();

        if (!status.isOnline) {
            statusBar.className = 'sync-status-bar offline cursor-pointer';
            statusBar.innerHTML = '<span class="sync-icon">&#x1F4F4;</span> Offline - changes saved locally <span class="sync-hint">(tap for logs)</span>';
        } else if (status.isSyncing) {
            statusBar.className = 'sync-status-bar syncing cursor-pointer';
            statusBar.innerHTML = '<span class="sync-icon spinning">&#x21BB;</span> Syncing... <span class="sync-hint">(tap for logs)</span>';
        } else if (status.pendingCount > 0 && status.rejectedCount > 0) {
            statusBar.className = 'sync-status-bar error cursor-pointer';
            statusBar.innerHTML = `<span class="sync-icon">&#x26A0;</span> ${status.rejectedCount} failed, ${status.pendingCount} pending <span class="sync-hint">(tap for details)</span>`;
        } else if (status.pendingCount > 0) {
            statusBar.className = 'sync-status-bar pending cursor-pointer';
            statusBar.innerHTML = `<span class="sync-icon">&#x23F3;</span> ${status.pendingCount} item${status.pendingCount > 1 ? 's' : ''} pending sync <span class="sync-hint">(tap for logs)</span>`;
        } else if (status.rejectedCount > 0) {
            statusBar.className = 'sync-status-bar error cursor-pointer';
            statusBar.innerHTML = `<span class="sync-icon">&#x26A0;</span> ${status.rejectedCount} item${status.rejectedCount > 1 ? 's' : ''} failed to sync <span class="sync-hint">(tap for details)</span>`;
        } else {
            // Show a minimal "synced" indicator that can still be tapped for debug
            statusBar.className = 'sync-status-bar synced cursor-pointer';
            statusBar.innerHTML = '<span class="sync-hint-dim">&#x2705; Synced (tap for debug)</span>';
        }
        statusBar.classList.remove('wg-settings-hidden');
    },

    // Show toast notification
    showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `sync-toast ${type}`;
        toast.textContent = message;

        // Remove existing toasts
        document.querySelectorAll('.sync-toast').forEach(t => t.remove());

        document.body.appendChild(toast);

        // Trigger animation
        setTimeout(() => toast.classList.add('show'), 10);

        // Remove after 3 seconds
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
};

// Check if error indicates server is down (5xx from reverse proxy)
function isServerError(err) {
    if (typeof err.status === 'number' && err.status >= 500) return true;
    const msg = err.message || '';
    return (
        msg.includes('Bad Gateway') ||
        msg.includes('Service Unavailable') ||
        msg.includes('Gateway Timeout') ||
        msg.includes('502') ||
        msg.includes('503') ||
        msg.includes('504')
    );
}

// Export for global access
window.SyncManager = SyncManager;
window.isServerError = isServerError;
