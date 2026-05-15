// Sync Layer for Med Tracker
// Handles online/offline detection and background synchronization

// Detect permanent (non-retriable) sync errors.
// apiCallDirect attaches the HTTP status code as err.status.
// 4xx errors (client errors) are generally permanent — retrying won't help.
// However, 401/403 are auth expiry errors — they resolve after re-login,
// and 429 is rate limiting — both resolve on their own,
// so they are treated as transient to avoid stranding offline writes.
// Network errors and 5xx are transient — retry with backoff.
function isPermanentSyncError(err) {
    if (!err) return false;
    // apiCallDirect sets err.status for HTTP errors
    if (typeof err.status === 'number') {
        // 401/403 = auth expired, will succeed after re-login → transient
        if (err.status === 401 || err.status === 403) return false;
        // 429 = rate limited by reverse proxy, transient
        if (err.status === 429) return false;
        // 408 = request timeout, transient
        if (err.status === 408) return false;
        return err.status >= 400 && err.status < 500;
    }
    // No status code → network error or internal throw → transient
    return false;
}

// Map a queued SW action endpoint to the DataStore tags that should be
// invalidated when the replay succeeds. The queued envelopes are POSTs
// from notification handlers (medication confirm/skip/snooze/cancel,
// workout snooze/skip, bp/weight reminder snooze/dontbug, tz-plan
// approve/reject) — the affected tags mirror the invalidateTags calls
// the main-thread mutation paths already use.
function swActionEndpointTags(endpoint) {
    if (!endpoint) return [];
    if (endpoint.startsWith('/api/medications/')) return ['medications', 'history'];
    if (endpoint.startsWith('/api/bp/')) return ['bp'];
    if (endpoint.startsWith('/api/weight/')) return ['weight'];
    if (endpoint.startsWith('/api/workout/')) return ['workout'];
    if (endpoint.startsWith('/api/tz-plan/')) return ['settings'];
    return [];
}

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

// Factory for offline-write entities. Compresses the near-identical
// BP / weight / intake sync pipelines into one configurable shape.
// Config keys: name, store (ref or getter), endpoint, buildPayload(row),
// onSuccess(localId, result, store), backgroundSyncTag, toastSingular,
// prepareOfflineEntry(body)?. Returns { syncPending, handleOfflineWrite,
// handleOfflineRead }. SyncManager is referenced lazily so the factory
// may be defined above it.
function defineOfflineEntity(config) {
    const {
        name,
        store,
        endpoint,
        buildPayload,
        onSuccess,
        backgroundSyncTag,
        toastSingular,
        prepareOfflineEntry
    } = config;

    function resolveStore() {
        return typeof store === 'function' ? store() : store;
    }

    async function syncPending() {
        if (!SyncManager.isOnline) return;
        const targetStore = resolveStore();
        if (!targetStore) return;

        const pending = await targetStore.getPending();
        if (pending.length === 0) {
            SyncDebug.info(`No pending ${name}`);
            return;
        }

        SyncDebug.info(`Syncing ${pending.length} ${name}...`);

        for (const entry of pending) {
            try {
                const payload = buildPayload(entry);
                SyncDebug.info(`Sending ${name} to server`, { localId: entry.localId });

                const result = await window.apiCallDirect(endpoint, 'POST', payload);

                if (!result) throw new Error('No response from server');

                await onSuccess(entry.localId, result, targetStore);
                SyncDebug.info(`${name} synced`, {
                    localId: entry.localId,
                    serverId: (result && result.id) || null
                });
            } catch (err) {
                SyncDebug.error(`${name} sync failed for ${entry.localId}`, { error: err.message });
                if (isPermanentSyncError(err)) {
                    SyncDebug.warn(`${name} ${entry.localId} rejected permanently`, { error: err.message });
                    await targetStore.markRejected(entry.localId, err.message);
                } else {
                    await targetStore.markError(entry.localId, err.message);
                }
            }
        }

        SyncManager.updateStatus();
    }

    async function handleOfflineWrite(body) {
        const targetStore = resolveStore();
        if (!targetStore) return null;

        SyncDebug.info(`Saving ${name} offline`);
        const entryToSave = typeof prepareOfflineEntry === 'function'
            ? prepareOfflineEntry(body)
            : body;
        const localEntry = await targetStore.save(entryToSave);
        SyncDebug.info(`${name} saved to IndexedDB`, { localId: localEntry.localId });

        SyncManager.registerBackgroundSync(backgroundSyncTag);
        SyncManager.showToast(`${toastSingular} — will sync when online`, 'info');
        SyncManager.updateStatus();

        return {
            ...body,
            id: `local_${localEntry.localId}`,
            localId: localEntry.localId,
            isLocal: true
        };
    }

    async function handleOfflineRead() {
        const targetStore = resolveStore();
        if (!targetStore) return [];
        const items = await targetStore.getAll();
        return items.map(r => ({
            id: r.serverId || `local_${r.localId}`,
            ...r,
            isLocal: !r.serverId
        }));
    }

    return { syncPending, handleOfflineWrite, handleOfflineRead };
}

// Expose factory globally for tests and Task 2 entity definitions.
window.defineOfflineEntity = defineOfflineEntity;

// Entity definitions for the three offline-write pipelines.
// Stores are resolved lazily via getter functions because
// window.MedTrackerDB may not be loaded at the time sync.js is parsed
// (notably during tests that import sync.js before db.js).
const BPSync = defineOfflineEntity({
    name: 'BP readings',
    store: () => window.MedTrackerDB && window.MedTrackerDB.BPStore,
    endpoint: '/api/bp',
    buildPayload: (reading) => ({
        measured_at: reading.measured_at,
        systolic: reading.systolic,
        diastolic: reading.diastolic,
        pulse: reading.pulse,
        site: reading.site,
        position: reading.position,
        notes: reading.notes
    }),
    onSuccess: async (localId, result, store) => {
        if (!(result && result.id)) {
            throw new Error('No ID returned from server');
        }
        await store.confirmDelete(localId);
    },
    backgroundSyncTag: 'sync-bp-readings',
    toastSingular: 'BP reading saved locally'
});

const WeightSync = defineOfflineEntity({
    name: 'weight logs',
    store: () => window.MedTrackerDB && window.MedTrackerDB.WeightStore,
    endpoint: '/api/weight',
    buildPayload: (log) => ({
        measured_at: log.measured_at,
        weight: log.weight,
        notes: log.notes
    }),
    onSuccess: async (localId, result, store) => {
        if (!(result && result.id)) {
            throw new Error('No ID returned from server');
        }
        await store.confirmDelete(localId);
    },
    backgroundSyncTag: 'sync-weight-logs',
    toastSingular: 'Weight saved locally'
});

const IntakeSync = defineOfflineEntity({
    name: 'intake logs',
    store: () => window.MedTrackerDB && window.MedTrackerDB.IntakeQueueStore,
    endpoint: '/api/medications/confirm-schedule',
    buildPayload: (entry) => ({
        scheduled_at: entry.scheduled_at,
        medication_ids: entry.medication_ids,
        intake_ids: entry.intake_ids || []
    }),
    onSuccess: async (localId, result, store) => {
        await store.markSynced(localId);
    },
    backgroundSyncTag: 'sync-intake-logs',
    toastSingular: 'Medication confirmed locally',
    prepareOfflineEntry: (body) => ({
        scheduled_at: body.scheduled_at,
        medication_ids: body.medication_ids,
        intake_ids: body.intake_ids || [],
        taken_at: new Date().toISOString()
    })
});

const SyncManager = {
    isOnline: navigator.onLine,
    isSyncing: false,
    statusCallbacks: [],
    retryDelayMs: 5000,
    retryTimer: null,
    retryScheduledAt: null,
    RETRY_INITIAL_MS: 5000,
    RETRY_MAX_MS: 300000,

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
                } else if (event.data.type === 'SW_ACTION_QUEUED') {
                    // A notification-handler POST just failed and got
                    // enqueued. Route through syncAll() so a transient
                    // failure on the immediate replay still schedules
                    // the exponential-backoff retry (drainSwActionQueue
                    // by itself only marks rows back to 'error' and
                    // exits — retry scheduling lives in syncAll).
                    this.syncAll();
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
        this.updateOfflineBanner(!this.isOnline);
        this.updateStatus();
        SyncDebug.info('SyncManager initialized', { online: this.isOnline });
    },

    // Cancel any pending retry timer
    cancelRetry() {
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
            this.retryScheduledAt = null;
            SyncDebug.info('Retry timer cancelled');
        }
    },

    // Reset backoff delay to initial value
    resetBackoff() {
        this.retryDelayMs = this.RETRY_INITIAL_MS;
    },

    // Schedule a retry with exponential backoff
    scheduleRetry() {
        this.cancelRetry();
        const delay = this.retryDelayMs;
        this.retryScheduledAt = Date.now() + delay;
        SyncDebug.info('Scheduling retry', { delayMs: delay });
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.retryScheduledAt = null;
            this.syncAll();
        }, delay);
        // Double the delay for next time, capped at max
        this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.RETRY_MAX_MS);
        this.updateStatus();
    },

    // Handle coming online
    handleOnline() {
        SyncDebug.info('Network: back online');
        this.isOnline = true;
        this.cancelRetry();
        this.resetBackoff();
        this.updateOfflineBanner(false);
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
        this.updateOfflineBanner(true);
        this.updateStatus();
    },

    // Show/hide offline banner and disable unsupported write buttons
    updateOfflineBanner(offline) {
        const banner = document.getElementById('offline-banner');
        if (banner) {
            if (offline) {
                banner.classList.remove('hidden');
            } else {
                banner.classList.add('hidden');
            }
        }

        // Buttons that require online (no offline write support)
        const offlineUnsupported = [
            'add-btn',
            'med-modal-save-btn',
            'add-food-inline-btn',
            'notes-save-btn',
            'start-adhoc-workout-btn',
            'add-workout-group-btn',
            'add-exercise-library-btn',
            'workout-group-save-btn',
            'variant-save-btn',
            'exercise-save-btn',
            'exercise-library-save-btn',
            'food-modal-save-btn',
            'food-product-save-btn',
            'workout-session-save-btn',
            'workout-session-delete-btn',
            'workout-session-add-exercise-btn',
            'session-add-exercise-save-btn'
        ];

        for (const id of offlineUnsupported) {
            const btn = document.getElementById(id);
            if (!btn) continue;

            if (offline) {
                btn.classList.add('offline-disabled');
                btn.setAttribute('data-offline-disabled', 'true');
                btn.disabled = true;
                // Add tooltip right after the button if not already present
                if (!btn.nextElementSibling || !btn.nextElementSibling.classList.contains('offline-disabled-tooltip')) {
                    const tip = document.createElement('span');
                    tip.className = 'offline-disabled-tooltip';
                    tip.textContent = 'Available when online';
                    btn.insertAdjacentElement('afterend', tip);
                }
            } else {
                btn.classList.remove('offline-disabled');
                btn.removeAttribute('data-offline-disabled');
                // Don't re-enable buttons that are mid-submit (withSubmit guard)
                if (!btn.hasAttribute('data-submit-in-flight')) {
                    btn.disabled = false;
                }
                if (btn.nextElementSibling && btn.nextElementSibling.classList.contains('offline-disabled-tooltip')) {
                    btn.nextElementSibling.remove();
                }
            }
        }

        // Also disable/enable dynamically-created workout action buttons
        const dynamicBtns = document.querySelectorAll('.workout-action-btn');
        for (const btn of dynamicBtns) {
            if (offline) {
                btn.classList.add('offline-disabled');
                btn.setAttribute('data-offline-disabled', 'true');
                btn.disabled = true;
            } else {
                btn.classList.remove('offline-disabled');
                btn.removeAttribute('data-offline-disabled');
                // Don't re-enable buttons that are mid-submit (withSubmit guard)
                if (!btn.hasAttribute('data-submit-in-flight')) {
                    btn.disabled = false;
                }
            }
        }
    },

    // Register callback for status updates
    onStatusChange(callback) {
        this.statusCallbacks.push(callback);
    },

    // Update status in UI. Returns totalPending count.
    async updateStatus() {
        const bpPending = await window.MedTrackerDB.BPStore.getPendingCount();
        const weightPending = await window.MedTrackerDB.WeightStore.getPendingCount();
        const intakePending = window.MedTrackerDB.IntakeQueueStore
            ? await window.MedTrackerDB.IntakeQueueStore.getPendingCount() : 0;
        const swActionPending = window.MedTrackerDB.SwActionQueue
            ? await window.MedTrackerDB.SwActionQueue.getPendingCount() : 0;
        const totalPending = bpPending + weightPending + intakePending + swActionPending;

        const bpRejected = await window.MedTrackerDB.BPStore.getRejectedCount();
        const weightRejected = await window.MedTrackerDB.WeightStore.getRejectedCount();
        const intakeRejected = window.MedTrackerDB.IntakeQueueStore
            ? await window.MedTrackerDB.IntakeQueueStore.getRejectedCount() : 0;
        const swActionRejected = window.MedTrackerDB.SwActionQueue
            ? await window.MedTrackerDB.SwActionQueue.getRejectedCount() : 0;
        const totalRejected = bpRejected + weightRejected + intakeRejected + swActionRejected;

        const status = {
            isOnline: this.isOnline,
            isSyncing: this.isSyncing,
            pendingCount: totalPending,
            rejectedCount: totalRejected,
            bpPending,
            weightPending
        };

        // Notify all callbacks
        this.statusCallbacks.forEach(cb => cb(status));

        // Update status bar UI
        this.updateStatusBar(status);
        return totalPending;
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
            let retryInfo = '';
            if (this.retryScheduledAt) {
                const secsLeft = Math.max(0, Math.ceil((this.retryScheduledAt - Date.now()) / 1000));
                retryInfo = ` · retry in ${secsLeft}s`;
            }
            statusBar.innerHTML = `<span class="sync-icon">&#x26A0;</span> ${status.rejectedCount} failed, ${status.pendingCount} pending${retryInfo} <span class="sync-hint">(tap for details)</span>`;
        } else if (status.pendingCount > 0) {
            statusBar.className = 'sync-status-bar pending cursor-pointer';
            let retryInfo = '';
            if (this.retryScheduledAt) {
                const secsLeft = Math.max(0, Math.ceil((this.retryScheduledAt - Date.now()) / 1000));
                retryInfo = ` · retry in ${secsLeft}s`;
            }
            statusBar.innerHTML = `<span class="sync-icon">&#x23F3;</span> ${status.pendingCount} item${status.pendingCount > 1 ? 's' : ''} pending sync${retryInfo} <span class="sync-hint">(tap for logs)</span>`;
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

    // Sync all pending data
    async syncAll() {
        if (!this.isOnline || this.isSyncing) {
            SyncDebug.info('syncAll skipped', { online: this.isOnline, syncing: this.isSyncing });
            return;
        }

        // Cancel any pending retry since we're syncing now
        this.cancelRetry();

        SyncDebug.info('Starting full sync...');
        this.isSyncing = true;
        this.updateStatus();

        try {
            await Promise.all([
                this.syncBPReadings(),
                this.syncWeightLogs(),
                this.syncIntakeLogs(),
                this.drainSwActionQueue()
            ]);
            SyncDebug.info('Full sync completed');
        } catch (err) {
            SyncDebug.error('Error during sync', { error: err.message });
        } finally {
            this.isSyncing = false;
            const totalPending = await this.updateStatus();

            if (totalPending > 0 && this.isOnline) {
                SyncDebug.info('Pending items remain after sync, scheduling retry', { pending: totalPending });
                this.scheduleRetry();
            } else if (totalPending === 0) {
                this.resetBackoff();
            }
        }
    },

    // Sync BP readings to server (forwards to BPSync factory entity)
    async syncBPReadings() {
        return BPSync.syncPending();
    },

    // Sync weight logs to server (forwards to WeightSync factory entity)
    async syncWeightLogs() {
        return WeightSync.syncPending();
    },

    // Sync intake logs to server (forwards to IntakeSync factory entity)
    async syncIntakeLogs() {
        return IntakeSync.syncPending();
    },

    // Drain failed Service Worker notification-action POSTs.
    // The SW writes envelopes (endpoint, method, body) into
    // pending_sw_actions when its in-handler fetch fails (offline,
    // transient 5xx, blip). We re-issue them here with the same
    // permanent-vs-transient logic as the BP/weight queues so a 4xx
    // (e.g. intake already confirmed) doesn't loop forever.
    //
    // Concurrency: rows are claimed atomically by claimPending() — two
    // tabs draining at once cannot replay the same envelope twice, which
    // matters because most endpoints (snooze/skip/cancel/tz-approve) are
    // not idempotent.
    async drainSwActionQueue() {
        if (!this.isOnline) return;
        if (!window.MedTrackerDB || !window.MedTrackerDB.SwActionQueue) return;

        const claimFn = window.MedTrackerDB.SwActionQueue.claimPending
            || window.MedTrackerDB.SwActionQueue.getPending;
        const pending = await claimFn.call(window.MedTrackerDB.SwActionQueue);
        if (pending.length === 0) {
            SyncDebug.info('No pending SW actions');
            return;
        }

        SyncDebug.info(`Draining ${pending.length} SW actions...`);

        const invalidatedTags = new Set();

        for (const entry of pending) {
            try {
                SyncDebug.info('Replaying SW action', {
                    localId: entry.localId,
                    endpoint: entry.endpoint
                });

                await window.apiCallDirect(
                    entry.endpoint,
                    entry.method || 'POST',
                    entry.body ?? null
                );

                await window.MedTrackerDB.SwActionQueue.markSynced(entry.localId);
                SyncDebug.info('SW action synced', { localId: entry.localId });

                // Collect DataStore tags affected by this endpoint so the
                // visible tab refreshes cached views (mirrors the
                // invalidateTags calls done by the main-thread mutation
                // sites — see meds.js / bp.js / weight.js / workout.js).
                const tags = swActionEndpointTags(entry.endpoint);
                for (const t of tags) invalidatedTags.add(t);
            } catch (err) {
                SyncDebug.error(`SW action sync failed for ${entry.localId}`, {
                    error: err.message
                });
                if (isPermanentSyncError(err)) {
                    SyncDebug.warn(`SW action ${entry.localId} rejected permanently`, {
                        error: err.message
                    });
                    await window.MedTrackerDB.SwActionQueue.markRejected(
                        entry.localId, err.message
                    );
                } else {
                    await window.MedTrackerDB.SwActionQueue.markError(
                        entry.localId, err.message
                    );
                }
            }
        }

        if (invalidatedTags.size > 0 && window.DataStore
            && typeof window.DataStore.invalidateTags === 'function') {
            try {
                await window.DataStore.invalidateTags([...invalidatedTags]);
            } catch (e) {
                SyncDebug.error('DataStore.invalidateTags failed after drain', {
                    error: e.message
                });
            }
            // apiCallDirect advances the change cursor silently after a
            // POST, so the normal change-poll path won't repaint the
            // visible tab for replayed writes. Trigger a refresh
            // explicitly — mirrors the loadX() call that main-thread
            // mutation sites do after invalidateTags.
            const tags = [...invalidatedTags];
            if (window.DataStore
                && typeof window.DataStore.requestTabRefresh === 'function') {
                try { window.DataStore.requestTabRefresh(tags); }
                catch (e) {
                    SyncDebug.error('DataStore.requestTabRefresh failed after drain', {
                        error: e.message
                    });
                }
            } else if (typeof window.requestTabRefresh === 'function') {
                try { window.requestTabRefresh({ changedTags: tags, source: 'sw-action-drain' }); }
                catch (e) {
                    SyncDebug.error('requestTabRefresh failed after drain', {
                        error: e.message
                    });
                }
            }
        }

        await this.updateStatus();
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
async function offlineAwareApiCall(endpoint, method = "GET", body = null, opts = {}) {
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
        // Other endpoints don't support offline writes — throw so apiCall shows an alert
        SyncDebug.warn('Endpoint does not support offline writes', { endpoint });
        throw new Error('This action requires an internet connection');
    }

    // Try the network request
    try {
        SyncDebug.info('Sending to network...', { endpoint });
        const result = await window.apiCallDirect(endpoint, method, body, opts);
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

// Handle offline BP write (forwards to BPSync factory entity)
async function handleOfflineBPWrite(body) {
    return BPSync.handleOfflineWrite(body);
}

// Handle offline weight write (forwards to WeightSync factory entity)
async function handleOfflineWeightWrite(body) {
    return WeightSync.handleOfflineWrite(body);
}

// Handle offline BP read — return pending/rejected local writes.
// Server-synced data is served by the SW dynamic cache; IndexedDB only holds
// records created offline that haven't been synced yet.
async function handleOfflineBPRead(endpoint) {
    const readings = await window.MedTrackerDB.BPStore.getAll();
    return readings.map(r => ({
        id: r.serverId || `local_${r.localId}`,
        ...r,
        isLocal: !r.serverId
    }));
}

// Handle offline weight read — return pending/rejected local writes.
async function handleOfflineWeightRead(endpoint) {
    const logs = await window.MedTrackerDB.WeightStore.getAll();
    return logs.map(l => ({
        id: l.serverId || `local_${l.localId}`,
        ...l,
        isLocal: !l.serverId
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

// Handle offline medication intake confirmation (forwards to IntakeSync factory entity)
async function handleOfflineIntakeWrite(body) {
    return IntakeSync.handleOfflineWrite(body);
}

// Check if error is a network error or server unavailable
function isNetworkError(err) {
    if (!err) return false;
    // AbortController timeouts (and caller-signal aborts) thrown by
    // apiCallDirect indicate the request never reached a usable backend
    // response. Treat them like other network failures so the offline
    // write queue / cached read fallback engage on stalled networks.
    if (err.aborted === true || err.name === 'AbortError' || err.name === 'TimeoutError') return true;
    // All fetch API network failures are TypeErrors; when the browser
    // reports offline, treat any TypeError as a network error regardless
    // of the message text (different browsers/WebViews use different wording).
    if (err instanceof TypeError && !navigator.onLine) return true;
    const msg = err.message || '';
    return (
        (err instanceof TypeError && msg.includes('fetch')) ||
        msg === 'Network request failed' ||
        msg === 'Failed to fetch' ||
        isServerError(err)
    );
}

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
window.offlineAwareApiCall = offlineAwareApiCall;
window.isServerError = isServerError;
