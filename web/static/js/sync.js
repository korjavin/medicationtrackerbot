// Sync Layer for Med Tracker
// Handles online/offline detection and background synchronization

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

    // Robust fallback for escaping HTML entities
    _escapeHtml(unsafe) {
        if (!unsafe) return '';
        // Use global escapeHtml if available, otherwise fallback
        const escapeFn = window['escapeHtml'];
        if (typeof escapeFn === 'function') {
            return escapeFn(unsafe);
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
                <button onclick="SyncDebug.toggle()" class="sync-debug-close">Close</button>
            </div>
            <div class="debug-content"></div>
        `;
        document.body.appendChild(panel);

        // Add CSS for debug lines
        const style = document.createElement('style');
        style.textContent = `
            .debug-line { padding: 2px 0; border-bottom: 1px solid #333; }
            .debug-time { color: #888; margin-right: 8px; }
            .debug-level { font-weight: bold; margin-right: 8px; }
            .debug-line.error .debug-level { color: #f66; }
            .debug-line.warn .debug-level { color: #fa0; }
            .debug-line.info .debug-level { color: #0af; }
            .debug-msg { color: #fff; }
            .debug-data { color: #888; font-size: 10px; display: block; margin-left: 60px; }
        `;
        document.head.appendChild(style);
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

        // Listen for messages from Service Worker
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
            SyncDebug.info('SW controller found, adding message listener');
            navigator.serviceWorker.addEventListener('message', (event) => {
                SyncDebug.info('SW message received', event.data);
                if (event.data.type === 'SYNC_BP_READINGS') {
                    this.syncBPReadings();
                } else if (event.data.type === 'SYNC_WEIGHT_LOGS') {
                    this.syncWeightLogs();
                } else if (event.data.type === 'SYNC_INTAKE_LOGS') {
                    this.syncIntakeLogs();
                }
            });
        } else {
            SyncDebug.warn('No SW controller, background sync not available');
        }

        // Initial sync attempt if online
        if (this.isOnline) {
            SyncDebug.info('Online at init, starting sync');
            this.syncAll();
        }

        // Update UI
        this.updateStatus();
        SyncDebug.info('SyncManager initialized', { online: this.isOnline });
    },

    // Handle coming online
    handleOnline() {
        SyncDebug.info('Network: back online');
        this.isOnline = true;
        this.updateStatus();
        this.syncAll();

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
        this.updateStatus();
    },

    // Register callback for status updates
    onStatusChange(callback) {
        this.statusCallbacks.push(callback);
    },

    // Update status in UI
    async updateStatus() {
        const bpPending = await window.MedTrackerDB.BPStore.getPendingCount();
        const weightPending = await window.MedTrackerDB.WeightStore.getPendingCount();
        const intakePending = window.MedTrackerDB.IntakeQueueStore
            ? await window.MedTrackerDB.IntakeQueueStore.getPendingCount() : 0;
        const totalPending = bpPending + weightPending + intakePending;

        const status = {
            isOnline: this.isOnline,
            isSyncing: this.isSyncing,
            pendingCount: totalPending,
            bpPending,
            weightPending
        };

        // Notify all callbacks
        this.statusCallbacks.forEach(cb => cb(status));

        // Update status bar UI
        this.updateStatusBar(status);
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
            statusBar.style.display = 'flex';
        } else if (status.isSyncing) {
            statusBar.className = 'sync-status-bar syncing cursor-pointer';
            statusBar.innerHTML = '<span class="sync-icon spinning">&#x21BB;</span> Syncing... <span class="sync-hint">(tap for logs)</span>';
            statusBar.style.display = 'flex';
        } else if (status.pendingCount > 0) {
            statusBar.className = 'sync-status-bar pending cursor-pointer';
            statusBar.innerHTML = `<span class="sync-icon">&#x23F3;</span> ${status.pendingCount} item${status.pendingCount > 1 ? 's' : ''} pending sync <span class="sync-hint">(tap for logs)</span>`;
            statusBar.style.display = 'flex';
        } else {
            // Show a minimal "synced" indicator that can still be tapped for debug
            statusBar.className = 'sync-status-bar synced cursor-pointer';
            statusBar.innerHTML = '<span class="sync-hint-dim">&#x2705; Synced (tap for debug)</span>';
            statusBar.style.display = 'flex';
        }
    },

    // Sync all pending data
    async syncAll() {
        if (!this.isOnline || this.isSyncing) {
            SyncDebug.info('syncAll skipped', { online: this.isOnline, syncing: this.isSyncing });
            return;
        }

        SyncDebug.info('Starting full sync...');
        this.isSyncing = true;
        this.updateStatus();

        try {
            await Promise.all([
                this.syncBPReadings(),
                this.syncWeightLogs(),
                this.syncIntakeLogs()
            ]);
            SyncDebug.info('Full sync completed');
        } catch (err) {
            SyncDebug.error('Error during sync', { error: err.message });
        } finally {
            this.isSyncing = false;
            this.updateStatus();
        }
    },

    // Sync BP readings to server
    async syncBPReadings() {
        if (!this.isOnline) return;

        const pending = await window.MedTrackerDB.BPStore.getPending();
        if (pending.length === 0) {
            SyncDebug.info('No pending BP readings');
            return;
        }

        SyncDebug.info(`Syncing ${pending.length} BP readings...`);

        for (const reading of pending) {
            try {
                // Prepare payload for server
                const payload = {
                    measured_at: reading.measured_at,
                    systolic: reading.systolic,
                    diastolic: reading.diastolic,
                    pulse: reading.pulse,
                    site: reading.site,
                    position: reading.position,
                    notes: reading.notes
                };

                SyncDebug.info('Sending BP to server', { localId: reading.localId, sys: reading.systolic });

                // Send to server using the global apiCall function
                const result = await window.apiCallDirect('/api/bp', 'POST', payload);

                if (result && result.id) {
                    // Delete from local DB since it's now on the server
                    // We don't need to keep synced records locally
                    await window.MedTrackerDB.BPStore.confirmDelete(reading.localId);
                    SyncDebug.info('BP synced and removed from local DB', { localId: reading.localId, serverId: result.id });
                } else {
                    throw new Error('No ID returned from server');
                }
            } catch (err) {
                SyncDebug.error(`BP sync failed for ${reading.localId}`, { error: err.message });
                await window.MedTrackerDB.BPStore.markError(reading.localId, err.message);
            }
        }

        this.updateStatus();
    },

    // Sync weight logs to server
    async syncWeightLogs() {
        if (!this.isOnline) return;

        const pending = await window.MedTrackerDB.WeightStore.getPending();
        if (pending.length === 0) {
            SyncDebug.info('No pending weight logs');
            return;
        }

        SyncDebug.info(`Syncing ${pending.length} weight logs...`);

        for (const log of pending) {
            try {
                // Prepare payload for server
                const payload = {
                    measured_at: log.measured_at,
                    weight: log.weight,
                    notes: log.notes
                };

                SyncDebug.info('Sending weight to server', { localId: log.localId, weight: log.weight });

                // Send to server
                const result = await window.apiCallDirect('/api/weight', 'POST', payload);

                if (result && result.id) {
                    // Delete from local DB since it's now on the server
                    // We don't need to keep synced records locally
                    await window.MedTrackerDB.WeightStore.confirmDelete(log.localId);
                    SyncDebug.info('Weight synced and removed from local DB', { localId: log.localId, serverId: result.id });
                } else {
                    throw new Error('No ID returned from server');
                }
            } catch (err) {
                SyncDebug.error(`Weight sync failed for ${log.localId}`, { error: err.message });
                await window.MedTrackerDB.WeightStore.markError(log.localId, err.message);
            }
        }

        this.updateStatus();
    },

    // Sync intake logs to server
    async syncIntakeLogs() {
        if (!this.isOnline) return;
        if (!window.MedTrackerDB || !window.MedTrackerDB.IntakeQueueStore) return;

        const pending = await window.MedTrackerDB.IntakeQueueStore.getPending();
        if (pending.length === 0) {
            SyncDebug.info('No pending intake logs');
            return;
        }

        SyncDebug.info(`Syncing ${pending.length} intake logs...`);

        for (const entry of pending) {
            try {
                const payload = {
                    scheduled_at: entry.scheduled_at,
                    medication_ids: entry.medication_ids,
                    intake_ids: entry.intake_ids || []
                };

                SyncDebug.info('Sending intake to server', { localId: entry.localId });

                const result = await window.apiCallDirect('/api/medications/confirm-schedule', 'POST', payload);

                if (result) {
                    await window.MedTrackerDB.IntakeQueueStore.markSynced(entry.localId);
                    SyncDebug.info('Intake synced', { localId: entry.localId });
                } else {
                    throw new Error('No response from server');
                }
            } catch (err) {
                SyncDebug.error(`Intake sync failed for ${entry.localId}`, { error: err.message });
                await window.MedTrackerDB.IntakeQueueStore.markError(entry.localId, err.message);
            }
        }

        this.updateStatus();
    },

    // Register background sync with Service Worker
    async registerBackgroundSync(tag) {
        if ('serviceWorker' in navigator && 'SyncManager' in window) {
            try {
                const registration = await navigator.serviceWorker.ready;
                await registration.sync.register(tag);
                console.log(`[Sync] Background sync registered: ${tag}`);
            } catch (err) {
                console.log('[Sync] Background sync not available:', err);
            }
        }
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

// Offline-aware API call wrapper
// This replaces the original apiCall function with offline support
async function offlineAwareApiCall(endpoint, method = "GET", body = null) {
    const isWrite = method === 'POST' || method === 'PUT' || method === 'DELETE';

    SyncDebug.info(`API: ${method} ${endpoint}`, { online: SyncManager.isOnline, isWrite });

    // For writes, check if this is a BP or weight endpoint that supports offline
    if (isWrite && !SyncManager.isOnline) {
        SyncDebug.warn('Offline write attempt', { endpoint });
        // Handle offline writes for BP
        if (endpoint === '/api/bp' && method === 'POST') {
            return await handleOfflineBPWrite(body);
        }
        // Handle offline writes for weight
        if (endpoint === '/api/weight' && method === 'POST') {
            return await handleOfflineWeightWrite(body);
        }
        // Handle offline medication intake confirmations
        if (endpoint === '/api/medications/confirm-schedule' && method === 'POST') {
            return await handleOfflineIntakeWrite(body);
        }
        // Other endpoints don't support offline writes - silently fail
        // The calling code will handle the null return appropriately
        SyncDebug.warn('Endpoint does not support offline writes', { endpoint });
        return null;
    }

    // Try the network request
    try {
        SyncDebug.info('Sending to network...', { endpoint });
        const result = await window.apiCallDirect(endpoint, method, body);
        SyncDebug.info('Network response OK', { endpoint, hasResult: !!result });

        // Return the server response directly
        // Note: We don't save to IndexedDB here because:
        // 1. For offline writes that later sync, the sync layer calls markSynced()
        // 2. For online writes, we don't need local storage - data comes from server
        return result;
    } catch (err) {
        SyncDebug.error('Network request failed', { endpoint, error: err.message });

        // If network error and this is a supported offline write, handle it
        if (isWrite && isNetworkError(err)) {
            SyncDebug.warn('Falling back to offline write', { endpoint });
            if (endpoint === '/api/bp' && method === 'POST') {
                return await handleOfflineBPWrite(body);
            }
            if (endpoint === '/api/weight' && method === 'POST') {
                return await handleOfflineWeightWrite(body);
            }
            if (endpoint === '/api/medications/confirm-schedule' && method === 'POST') {
                return await handleOfflineIntakeWrite(body);
            }
        }

        // For read operations when offline, try to serve from cache
        if (method === 'GET' && isNetworkError(err)) {
            SyncDebug.warn('Falling back to offline read', { endpoint });
            if (endpoint.startsWith('/api/bp')) {
                return await handleOfflineBPRead(endpoint);
            }
            if (endpoint.startsWith('/api/weight')) {
                return await handleOfflineWeightRead(endpoint);
            }
            if (endpoint.startsWith('/api/history')) {
                return await handleOfflineHistoryRead(endpoint);
            }
            if (endpoint.startsWith('/api/workout')) {
                return await handleOfflineWorkoutRead(endpoint);
            }
            // For other GET endpoints that don't have offline support,
            // return empty data instead of throwing to avoid alerts
            SyncDebug.warn('No offline support for endpoint, returning empty', { endpoint });
            return null;
        }

        // Only throw for write operations or non-network errors
        throw err;
    }
}

// Handle offline BP write
async function handleOfflineBPWrite(body) {
    SyncDebug.info('Saving BP offline', { sys: body.systolic, dia: body.diastolic });

    const localEntry = await window.MedTrackerDB.BPStore.save(body);
    SyncDebug.info('BP saved to IndexedDB', { localId: localEntry.localId });

    // Register background sync
    SyncManager.registerBackgroundSync('sync-bp-readings');

    // Show toast
    SyncManager.showToast('Saved offline - will sync when online', 'info');

    // Update status
    SyncManager.updateStatus();

    // Return a mock response that looks like the server response
    return {
        ...body,
        id: `local_${localEntry.localId}`,
        localId: localEntry.localId,
        isLocal: true
    };
}

// Handle offline weight write
async function handleOfflineWeightWrite(body) {
    SyncDebug.info('Saving weight offline', { weight: body.weight });

    const localEntry = await window.MedTrackerDB.WeightStore.save(body);
    SyncDebug.info('Weight saved to IndexedDB', { localId: localEntry.localId });

    // Register background sync
    SyncManager.registerBackgroundSync('sync-weight-logs');

    // Show toast
    SyncManager.showToast('Saved offline - will sync when online', 'info');

    // Update status
    SyncManager.updateStatus();

    // Return a mock response
    return {
        ...body,
        id: `local_${localEntry.localId}`,
        localId: localEntry.localId,
        isLocal: true
    };
}

// Handle offline BP read
async function handleOfflineBPRead(endpoint) {
    const readings = await window.MedTrackerDB.BPStore.getAll();
    return readings.map(r => ({
        id: r.serverId || `local_${r.localId}`,
        ...r,
        isLocal: r.syncStatus !== 'synced'
    }));
}

// Handle offline weight read
async function handleOfflineWeightRead(endpoint) {
    const logs = await window.MedTrackerDB.WeightStore.getAll();
    return logs.map(l => ({
        id: l.serverId || `local_${l.localId}`,
        ...l,
        isLocal: l.syncStatus !== 'synced'
    }));
}

// Handle offline history read
async function handleOfflineHistoryRead(endpoint) {
    if (!window.MedTrackerDB || !window.MedTrackerDB.IntakeHistoryStore) return null;

    // Parse query params to build cache key
    const url = new URL(endpoint, window.location.origin);
    const days = url.searchParams.get('days') || '7';
    const medId = url.searchParams.get('med_id') || '';
    const cacheKey = `history_${days}_${medId}`;

    const cached = await window.MedTrackerDB.IntakeHistoryStore.getCache(cacheKey);
    if (cached) {
        SyncDebug.info('Serving intake history from cache', { key: cacheKey, count: cached.length });
        return cached;
    }

    SyncDebug.warn('No cached intake history', { key: cacheKey });
    return [];
}

// Handle offline workout read
async function handleOfflineWorkoutRead(endpoint) {
    if (!window.MedTrackerDB || !window.MedTrackerDB.WorkoutStore) return null;

    if (endpoint.includes('/api/workout/groups')) {
        const cached = await window.MedTrackerDB.WorkoutStore.getCache('groups');
        if (cached) {
            SyncDebug.info('Serving workout groups from cache');
            return cached;
        }
    }

    if (endpoint.includes('/api/workout/sessions')) {
        const cached = await window.MedTrackerDB.WorkoutStore.getCache('sessions');
        if (cached) {
            SyncDebug.info('Serving workout sessions from cache');
            return cached;
        }
    }

    SyncDebug.warn('No cached workout data', { endpoint });
    return null;
}

// Handle offline medication intake confirmation
async function handleOfflineIntakeWrite(body) {
    if (!window.MedTrackerDB || !window.MedTrackerDB.IntakeQueueStore) return null;

    SyncDebug.info('Saving intake confirmation offline', { medication_ids: body.medication_ids });

    const localEntry = await window.MedTrackerDB.IntakeQueueStore.save({
        scheduled_at: body.scheduled_at,
        medication_ids: body.medication_ids,
        intake_ids: body.intake_ids || [],
        taken_at: new Date().toISOString()
    });

    // Register background sync
    SyncManager.registerBackgroundSync('sync-intake-logs');

    // Show toast
    SyncManager.showToast('Intake saved offline - will sync when online', 'info');

    // Update status
    SyncManager.updateStatus();

    return {
        ...body,
        id: `local_${localEntry.localId}`,
        localId: localEntry.localId,
        isLocal: true
    };
}

// Check if error is a network error or server unavailable
function isNetworkError(err) {
    return (
        err instanceof TypeError && err.message.includes('fetch') ||
        err.message === 'Network request failed' ||
        err.message === 'Failed to fetch' ||
        err.name === 'TypeError' && !navigator.onLine ||
        isServerError(err)
    );
}

// Check if error indicates server is down (5xx from reverse proxy)
function isServerError(err) {
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
window.offlineAwareApiCall = offlineAwareApiCall;
