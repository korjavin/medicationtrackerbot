// Service Worker for Med Tracker PWA
importScripts('/static/js/sw-api-helper.js');
const CACHE_VERSION = 'CACHE_VERSION_PLACEHOLDER'; // Auto-updated by CI/CD
// Manual bump knob: increment when shipping a UI change clients must pick up
// even if the deploy timestamp alone fails to invalidate (e.g. mid-cycle
// hotfix, or to force re-fetch of today.js for the Photo meal shortcut tile).
const BUILD_REVISION = '4';
const STATIC_CACHE = `medtracker-static-${CACHE_VERSION}-r${BUILD_REVISION}`;
const DYNAMIC_CACHE = `medtracker-dynamic-${CACHE_VERSION}-r${BUILD_REVISION}`;
const APP_SHELL_CACHE_KEY = '/__app_shell__';

// Static assets to cache on install
const STATIC_ASSETS = [
    '/',
    '/static/css/styles.css',
    // Core modules
    '/static/js/core/utils.js',
    '/static/js/core/time-format.js',
    '/static/js/core/api.js',
    '/static/js/core/app-kernel.js',
    '/static/js/core/store.js',
    '/static/js/core/modal-manager.js',
    '/static/js/core/modal-controller.js',
    '/static/js/core/chart-utils.js',
    '/static/js/core/cache-keys.js',
    // Components
    '/static/js/components/mt-elements.js',
    '/static/js/components/empty-state.js',
    '/static/js/components/stat-card.js',
    '/static/js/components/action-row.js',
    '/static/js/components/wg-icons.js',
    '/static/js/components/wg-bottom-nav.js',
    '/static/js/components/wg-sparkline.js',
    '/static/js/components/wg-phone-chrome.js',
    '/static/js/components/wg-bp-chart.js',
    '/static/js/components/wg-weight-chart.js',
    '/static/js/components/wg-workout-chart.js',
    '/static/js/components/wg-sleep-chart.js',
    '/static/js/components/wg-steps-chart.js',
    '/static/js/components/wg-vitals-chart.js',
    '/static/js/components/wg-macro-bar.js',
    '/static/js/components/wg-stale-badge.js',
    '/static/js/components/wg-toggle.js',
    '/static/js/components/wg-settings.js',
    // Infrastructure
    '/static/js/sw-api-helper.js',
    '/static/js/db.js',
    '/static/js/sync.js',
    '/static/js/data-store.js',
    '/static/js/cached-fetch.js',
    '/static/js/app.js',
    '/static/js/push.js',
    '/static/js/app-shell.js',
    // Features
    '/static/js/features/meds.js',
    '/static/js/features/food-photo-summary.js',
    '/static/js/features/food/products.js',
    '/static/js/features/food/scanner.js',
    '/static/js/features/food/photo.js',
    '/static/js/features/food/log.js',
    '/static/js/features/food/meals.js',
    '/static/js/features/food/db.js',
    '/static/js/features/food/index.js',
    '/static/js/features/bp.js',
    '/static/js/features/weight.js',
    '/static/js/features/health.js',
    '/static/js/features/auth-flow.js',
    '/static/js/features/modal-history.js',
    '/static/js/features/back-button.js',
    '/static/js/features/deeplink-router.js',
    '/static/js/features/today.js',
    '/static/js/features/tz-plan-banner.js',
    '/static/js/features/elevenlabs-call.js',
    '/static/js/features/call-indicator.js',
    '/static/js/features/workout/next-card.js',
    '/static/js/features/workout/groups.js',
    '/static/js/features/workout/variants.js',
    '/static/js/features/workout/exercises.js',
    '/static/js/features/workout/library.js',
    '/static/js/features/workout/history.js',
    '/static/js/features/workout/miband.js',
    '/static/js/features/workout/sessions.js',
    '/static/js/features/workout/stats.js',
    '/static/js/features/workout/index.js',
    '/static/js/features/bootstrap.js',
    // Config
    '/static/config.js',
    // Vendor
    '/static/vendor/dexie.min.js',
    '/static/vendor/zxing.min.js',
    // Icons & manifest
    '/static/icons/icon-192.png',
    '/static/icons/icon-512.png',
    '/static/icons/favicon.ico',
    '/static/icons/favicon-16x16.png',
    '/static/icons/favicon-32x32.png',
    '/static/manifest.json'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
    console.log('[SW] Installing...');
    event.waitUntil((async () => {
        try {
            const cache = await caches.open(STATIC_CACHE);
            console.log('[SW] Caching static assets');

            // Cache static assets first
            await cache.addAll(STATIC_ASSETS);

            // Seed canonical app shell key from root document.
            const rootResponse = await cache.match('/');
            if (rootResponse) {
                await cache.put(APP_SHELL_CACHE_KEY, rootResponse);
            }
        } catch (err) {
            console.error('[SW] Failed to cache static assets:', err);
        }
    })());
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating...');
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(
            keys
                .filter((key) => key !== STATIC_CACHE && key !== DYNAMIC_CACHE)
                .map((key) => {
                    console.log('[SW] Removing old cache:', key);
                    return caches.delete(key);
                })
        );
        await self.clients.claim();
    })());
});

// Fetch event - network-first for API, stale-while-revalidate for navigations, cache-first for static assets
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET requests
    if (event.request.method !== 'GET') {
        return;
    }

    // Let the browser handle cross-origin and auth requests directly.
    if (url.origin !== self.location.origin || url.pathname.startsWith('/auth/')) {
        return;
    }

    // Skip SSE streams — they are long-lived and cannot be cached
    if (url.pathname.startsWith('/api/changes/stream')) {
        return;
    }

    // Bootstrap endpoint — stale-while-revalidate for instant app startup
    if (url.pathname === '/api/bootstrap') {
        event.respondWith(
            caches.open(DYNAMIC_CACHE).then(async (cache) => {
                const cachedResponse = await cache.match(event.request);
                if (cachedResponse) {
                    // Clone for comparison before respondWith consumes the body
                    const cachedClone = cachedResponse.clone();
                    // Serve cached immediately, revalidate in background
                    event.waitUntil(
                        fetch(event.request)
                            .then(async (freshResponse) => {
                                if (freshResponse.ok) {
                                    // Compare fresh vs cached — only notify clients if data changed
                                    const freshText = await freshResponse.clone().text();
                                    const freshData = JSON.parse(freshText); // Validate JSON before caching
                                    const cachedText = await cachedClone.text();
                                    await cache.put(event.request, freshResponse.clone());
                                    if (freshText !== cachedText) {
                                        const clients = await self.clients.matchAll();
                                        clients.forEach((client) => {
                                            client.postMessage({ type: 'BOOTSTRAP_UPDATED', data: freshData });
                                        });
                                    }
                                }
                            })
                            .catch(() => { /* offline — cached response already served */ })
                    );
                    return cachedResponse;
                }
                // No cache — fall through to network-first (same as general API handler)
                return fetch(event.request)
                    .then((response) => {
                        if (response.ok) {
                            cache.put(event.request, response.clone());
                        }
                        if (response.status >= 500) {
                            return response;
                        }
                        return response;
                    })
                    .catch(() => {
                        return new Response(
                            JSON.stringify({ error: 'offline', message: 'You are offline' }),
                            { status: 503, headers: { 'Content-Type': 'application/json' } }
                        );
                    });
            })
        );
        return;
    }

    // API calls - network first with cache fallback for GET requests
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    // Cache successful GET requests for offline support
                    if (response.ok && event.request.method === 'GET') {
                        const responseClone = response.clone();
                        caches.open(DYNAMIC_CACHE)
                            .then((cache) => {
                                cache.put(event.request, responseClone);
                                console.log('[SW] Cached API response:', url.pathname);
                            });
                    }
                    // Server error (e.g. 502 from reverse proxy) — try cache before returning error
                    if (response.status >= 500) {
                        console.log('[SW] Server error', response.status, '- trying cache for:', url.pathname);
                        return caches.match(event.request)
                            .then(cached => cached || response);
                    }
                    return response;
                })
                .catch(() => {
                    // Try to return cached response if offline
                    return caches.match(event.request)
                        .then((cachedResponse) => {
                            if (cachedResponse) {
                                console.log('[SW] Returning cached API response:', url.pathname);
                                return cachedResponse;
                            }
                            // No cache available, return offline error
                            return new Response(
                                JSON.stringify({ error: 'offline', message: 'You are offline' }),
                                {
                                    status: 503,
                                    headers: { 'Content-Type': 'application/json' }
                                }
                            );
                        });
                })
        );
        return;
    }

    // HTML navigations - return cached shell immediately and refresh in background.
    if (event.request.mode === 'navigate') {
        event.respondWith(
            caches.open(STATIC_CACHE)
                .then((cache) => {
                    return cache.match(APP_SHELL_CACHE_KEY)
                        .then((cachedShell) => {
                            const refreshShellPromise = fetch(event.request)
                                .then((networkResponse) => {
                                    if (networkResponse.ok) {
                                        // Keep a canonical navigation shell entry to avoid query-param cache misses.
                                        cache.put(APP_SHELL_CACHE_KEY, networkResponse.clone());
                                    }
                                    return networkResponse;
                                })
                                .catch(() => null);

                            // If we have cached shell, serve instantly and refresh in background.
                            if (cachedShell) {
                                event.waitUntil(refreshShellPromise);
                                return cachedShell;
                            }

                            // First navigation: fall back to network, then fallback to old '/' cache if offline.
                            return refreshShellPromise.then((networkResponse) => {
                                if (networkResponse) {
                                    return networkResponse;
                                }
                                return cache.match('/').then((fallbackShell) => {
                                    return fallbackShell || new Response('Offline', { status: 503 });
                                });
                            });
                        });
                })
        );
        return;
    }

    // Static assets - cache first, then network
    // Use ignoreSearch so precached assets (no query string) match versioned requests (?v=...)
    event.respondWith(
        caches.match(event.request, { ignoreSearch: true })
            .then((cachedResponse) => {
                if (cachedResponse) {
                    // Return cached version, but also update cache in background
                    event.waitUntil(
                        fetch(event.request)
                            .then((networkResponse) => {
                                if (networkResponse.ok) {
                                    caches.open(STATIC_CACHE)
                                        .then((cache) => cache.put(event.request, networkResponse));
                                }
                            })
                            .catch(() => { /* Ignore network errors during background update */ })
                    );
                    return cachedResponse;
                }

                // Not in cache, fetch from network
                return fetch(event.request)
                    .then((networkResponse) => {
                        // Cache successful responses for static resources
                        if (networkResponse.ok && shouldCache(url)) {
                            const responseClone = networkResponse.clone();
                            caches.open(DYNAMIC_CACHE)
                                .then((cache) => cache.put(event.request, responseClone));
                        }
                        return networkResponse;
                    })
                    .catch(() => {
                        // Return offline page for navigation requests
                        if (event.request.mode === 'navigate') {
                            return caches.match('/');
                        }
                        return new Response('Offline', { status: 503 });
                    });
            })
    );
});

// Background sync event - sync pending data when online
self.addEventListener('sync', (event) => {
    console.log('[SW] Sync event:', event.tag);

    if (event.tag === 'sync-bp-readings') {
        event.waitUntil(syncBPReadings());
    } else if (event.tag === 'sync-weight-logs') {
        event.waitUntil(syncWeightLogs());
    } else if (event.tag === 'sync-intake-logs') {
        event.waitUntil(syncIntakeLogs());
    } else if (event.tag === 'sync-all') {
        event.waitUntil(
            Promise.all([
                syncBPReadings(),
                syncWeightLogs(),
                syncIntakeLogs()
            ])
        );
    }
});

// Helper: Determine if a URL should be cached
function shouldCache(url) {
    // Cache static assets
    if (url.pathname.startsWith('/static/')) return true;
    // Cache the main page
    if (url.pathname === '/') return true;
    // Don't cache API calls
    if (url.pathname.startsWith('/api/')) return false;

    return false;
}

// Sync BP readings to server
async function syncBPReadings() {
    console.log('[SW] Syncing BP readings...');
    // This will be handled by the sync.js in the main thread
    // Notify all clients to perform sync
    const clients = await self.clients.matchAll();
    clients.forEach((client) => {
        client.postMessage({ type: 'SYNC_BP_READINGS' });
    });
}

// Sync weight logs to server
async function syncWeightLogs() {
    console.log('[SW] Syncing weight logs...');
    // This will be handled by the sync.js in the main thread
    // Notify all clients to perform sync
    const clients = await self.clients.matchAll();
    clients.forEach((client) => {
        client.postMessage({ type: 'SYNC_WEIGHT_LOGS' });
    });
}

// Sync intake logs to server
async function syncIntakeLogs() {
    console.log('[SW] Syncing intake logs...');
    const clients = await self.clients.matchAll();
    clients.forEach((client) => {
        client.postMessage({ type: 'SYNC_INTAKE_LOGS' });
    });
}

// Listen for messages from the main thread
self.addEventListener('message', (event) => {
    if (event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    } else if (event.data.type === 'SET_AUTH_TOKEN' && self.SwApi) {
        self.SwApi.authToken = event.data.token || null;
    }
});

// Push Notification Listeners
self.addEventListener('push', (event) => {
    console.log('[SW] Push received');

    let data = {
        title: 'Med Tracker',
        body: 'New notification',
        icon: '/static/icons/icon-192.png',
        badge: '/static/icons/icon-192.png'
    };

    if (event.data) {
        data = event.data.json();
    }

    // Handle silent close notifications
    if (data.data && data.data.type === 'close' && data.tag) {
        event.waitUntil(
            self.registration.getNotifications({ tag: data.tag }).then(notifications => {
                notifications.forEach(notification => notification.close());
            })
        );
        return;
    }

    event.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body,
            icon: data.icon,
            badge: data.badge,
            tag: data.tag,
            data: data.data,
            actions: data.actions || [],
            requireInteraction: true
        })
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const data = event.notification.data;
    const action = event.action;

    if (!data) {
        event.waitUntil(clients.openWindow('/'));
        return;
    }

    if (data.type === 'medication') {
        if (action === 'confirm_all') {
            event.waitUntil(handleMedicationConfirm(data));
        } else if (action === 'snooze') {
            // Snooze 10 minutes (local re-notify)
            event.waitUntil(
                new Promise(resolve => {
                    setTimeout(() => {
                        self.registration.showNotification(
                            event.notification.title,
                            event.notification
                        );
                        resolve();
                    }, 10 * 60 * 1000)
                })
            );
        } else {
            // Body click -> Open App with Modal
            const params = new URLSearchParams();
            params.set('action', 'medication_confirm');
            if (data.medication_ids) params.set('ids', data.medication_ids.join(','));
            if (data.intake_ids) params.set('intake_ids', data.intake_ids.join(','));
            if (data.scheduled_at) params.set('scheduled', data.scheduled_at);
            if (data.medication_names) params.set('names', data.medication_names.join(','));

            const url = '/?' + params.toString();
            event.waitUntil(clients.openWindow(url));
        }
    } else if (data.type === 'medication_individual') {
        if (action.startsWith('confirm_')) {
            const id = action.split('_')[1];
            event.waitUntil(handleMedicationConfirm({
                scheduled_at: data.scheduled_at,
                medication_ids: [data.medication_id],
                intake_ids: [parseInt(id, 10)]
            }));
        } else if (action.startsWith('skip_')) {
            const id = action.split('_')[1];
            event.waitUntil(handleMedicationSkip(parseInt(id, 10)));
        } else if (action === 'snooze') {
            event.waitUntil(handleMedicationServerSnooze(data.intake_id, 10));
        } else {
            // Body click -> Open App with Modal
            const params = new URLSearchParams();
            params.set('action', 'medication_confirm');
            params.set('ids', data.medication_id);
            params.set('intake_ids', data.intake_id);
            params.set('scheduled', data.scheduled_at);
            params.set('names', event.notification.body);

            const url = '/?' + params.toString();
            event.waitUntil(clients.openWindow(url));
        }
    } else if (data.type === 'workout') {
        if (action.startsWith('workout_snooze1_') || action === 'snooze_1h') {
            event.waitUntil(handleWorkoutSnooze(data.session_id || parseInt(action.split('_')[2], 10), 1));
        } else if (action.startsWith('workout_snooze2_')) {
            event.waitUntil(handleWorkoutSnooze(data.session_id || parseInt(action.split('_')[2], 10), 2));

        } else if (action.startsWith('workout_skip_') || action === 'workout_skip' || action === 'skip') {
            const parsedId = action.startsWith('workout_skip_') ? parseInt(action.split('_')[2], 10) : data.session_id;
            event.waitUntil(handleWorkoutSkip(parsedId));

        } else {
            const params = new URLSearchParams();
            params.set('action', 'workout_start');
            if (data.session_id) params.set('session_id', data.session_id);

            const url = '/?' + params.toString();
            event.waitUntil(clients.openWindow(url));
        }
    } else if (data.type === 'bp_reminder') {
        if (action === 'bp_confirm') {
            // Open app to BP add page
            event.waitUntil(clients.openWindow('/?tab=bp&action=add'));
        } else if (action === 'bp_snooze') {
            // Snooze for 2 hours
            event.waitUntil(handleBPSnooze());
        } else if (action === 'bp_dontbug') {
            // Don't bug me for 24 hours
            event.waitUntil(handleBPDontBug());
        } else {
            // Body click -> Open BP add modal directly
            event.waitUntil(clients.openWindow('/?tab=bp&action=add'));
        }
    } else if (data.type === 'weight_reminder') {
        if (action === 'weight_confirm') {
            // Open app to weight add page
            event.waitUntil(clients.openWindow('/?tab=weight&action=add'));
        } else if (action === 'weight_snooze') {
            // Snooze for 2 hours
            event.waitUntil(handleWeightSnooze());
        } else if (action === 'weight_dontbug') {
            // Don't bug me for 24 hours
            event.waitUntil(handleWeightDontBug());
        } else {
            // Body click -> Open weight tab
            event.waitUntil(clients.openWindow('/?tab=weight'));
        }
    } else if (data.type === 'medication_early_confirmed') {
        // User took medication early and got a confirmation notification
        if (action.startsWith('cancel_intake')) {
            // Cancel/undo the early intake
            event.waitUntil(handleCancelIntake(data));
        } else {
            // Body click -> Open history tab
            event.waitUntil(clients.openWindow('/?tab=history'));
        }
    } else if (data.type === 'tz_plan') {
        const planId = data.plan_id;
        if (action.startsWith('tz_plan_approve:')) {
            event.waitUntil(handleTZPlanAction(planId, 'approve'));
        } else if (action.startsWith('tz_plan_reject:')) {
            event.waitUntil(handleTZPlanAction(planId, 'reject'));
        } else {
            // Body click -> Open settings
            event.waitUntil(clients.openWindow('/?tab=settings'));
        }
    } else {
        event.waitUntil(clients.openWindow('/'));
    }
});

async function handleTZPlanAction(planId, action) {
    const endpoint = `/api/tz-plan/${planId}/${action}`;
    try {
        await self.swApiCall(endpoint, 'POST');
    } catch (e) {
        await self.SwApi.enqueueFailedAction({ endpoint, method: 'POST', body: null });
        await self.registration.showNotification('Timezone Plan Action Failed', {
            body: 'Could not process your response. Please try again in the app.',
            icon: '/static/icons/icon-192.png',
            tag: 'tz_plan_result'
        });
        return;
    }
    const label = action === 'approve' ? 'Approved' : 'Rejected';
    await self.registration.showNotification(`Timezone Plan ${label}`, {
        body: action === 'approve'
            ? 'Medication doses will shift as scheduled.'
            : 'Your original medication schedule is retained.',
        icon: '/static/icons/icon-192.png',
        tag: 'tz_plan_result'
    });
}

async function handleCancelIntake(data) {
    const body = { intake_ids: data.intake_ids };
    try {
        await self.swApiCall('/api/medications/cancel-intake', 'POST', body);
    } catch (e) {
        await self.SwApi.enqueueFailedAction({
            endpoint: '/api/medications/cancel-intake',
            method: 'POST',
            body,
        });
        return;
    }
    await self.registration.showNotification('Intake Cancelled', {
        body: 'Your medication has been unmarked. The scheduled notification will still arrive.',
        icon: '/static/icons/icon-192.png',
        tag: 'intake-cancelled'
    });
    const clients = await self.clients.matchAll();
    clients.forEach(client => client.postMessage({ type: 'INTAKE_CANCELLED' }));
}

async function handleMedicationConfirm(data) {
    const body = {
        scheduled_at: data.scheduled_at,
        medication_ids: data.medication_ids,
        intake_ids: data.intake_ids
    };
    try {
        await self.swApiCall('/api/medications/confirm-schedule', 'POST', body);
    } catch (e) {
        await self.SwApi.enqueueFailedAction({
            endpoint: '/api/medications/confirm-schedule',
            method: 'POST',
            body,
        });
        return;
    }
    const clients = await self.clients.matchAll();
    clients.forEach(client => client.postMessage({ type: 'MEDICATION_CONFIRMED' }));
}

async function handleBPSnooze() {
    try {
        await self.swApiCall('/api/bp/reminder/snooze', 'POST');
    } catch (e) {
        await self.SwApi.enqueueFailedAction({
            endpoint: '/api/bp/reminder/snooze',
            method: 'POST',
            body: null,
        });
    }
}

async function handleBPDontBug() {
    try {
        await self.swApiCall('/api/bp/reminder/dontbug', 'POST');
    } catch (e) {
        await self.SwApi.enqueueFailedAction({
            endpoint: '/api/bp/reminder/dontbug',
            method: 'POST',
            body: null,
        });
    }
}

async function handleWeightSnooze() {
    try {
        await self.swApiCall('/api/weight/reminder/snooze', 'POST');
    } catch (e) {
        await self.SwApi.enqueueFailedAction({
            endpoint: '/api/weight/reminder/snooze',
            method: 'POST',
            body: null,
        });
    }
}

async function handleWeightDontBug() {
    try {
        await self.swApiCall('/api/weight/reminder/dontbug', 'POST');
    } catch (e) {
        await self.SwApi.enqueueFailedAction({
            endpoint: '/api/weight/reminder/dontbug',
            method: 'POST',
            body: null,
        });
    }
}

async function handleWorkoutSnooze(sessionId, hours) {
    const endpoint = `/api/workout/sessions/${sessionId}/snooze`;
    const body = { minutes: hours * 60 };
    try {
        await self.swApiCall(endpoint, 'POST', body);
    } catch (e) {
        await self.SwApi.enqueueFailedAction({ endpoint, method: 'POST', body });
        return;
    }
    const clients = await self.clients.matchAll();
    clients.forEach(client => client.postMessage({ type: 'WORKOUT_SNOOZED' }));
}

async function handleWorkoutSkip(sessionId) {
    const endpoint = `/api/workout/sessions/${sessionId}/skip`;
    try {
        await self.swApiCall(endpoint, 'POST');
    } catch (e) {
        await self.SwApi.enqueueFailedAction({ endpoint, method: 'POST', body: null });
        return;
    }
    const clients = await self.clients.matchAll();
    clients.forEach(client => client.postMessage({ type: 'WORKOUT_SKIPPED' }));
}

async function handleMedicationSkip(intakeId) {
    const body = { intake_id: intakeId };
    try {
        await self.swApiCall('/api/medications/skip', 'POST', body);
    } catch (e) {
        await self.SwApi.enqueueFailedAction({
            endpoint: '/api/medications/skip',
            method: 'POST',
            body,
        });
        return;
    }
    const clients = await self.clients.matchAll();
    clients.forEach(client => client.postMessage({ type: 'MEDICATION_SKIPPED' }));
}

async function handleMedicationServerSnooze(intakeId, minutes) {
    const body = { intake_id: intakeId, duration_minutes: minutes };
    try {
        await self.swApiCall('/api/medications/snooze', 'POST', body);
    } catch (e) {
        await self.SwApi.enqueueFailedAction({
            endpoint: '/api/medications/snooze',
            method: 'POST',
            body,
        });
        return;
    }
    const clients = await self.clients.matchAll();
    clients.forEach(client => client.postMessage({ type: 'MEDICATION_SNOOZED' }));
}
