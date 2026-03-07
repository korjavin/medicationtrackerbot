// Service Worker for Med Tracker PWA
const CACHE_VERSION = 'CACHE_VERSION_PLACEHOLDER'; // Auto-updated by CI/CD
const STATIC_CACHE = `medtracker-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `medtracker-dynamic-${CACHE_VERSION}`;
const APP_SHELL_CACHE_KEY = '/__app_shell__';

// Static assets to cache on install
const STATIC_ASSETS = [
    '/',
    '/static/css/styles.css',
    '/static/js/app.js',
    '/static/js/workout.js',
    '/static/js/db.js',
    '/static/js/sync.js',
    '/static/js/data-store.js',
    '/static/js/push.js',
    '/static/icons/icon-192.png',
    '/static/icons/icon-512.png',
    '/static/manifest.json'
];

// External CDN resources to cache (try caching but don't fail if unavailable)
const EXTERNAL_ASSETS = [
    'https://telegram.org/js/telegram-web-app.js',
    'https://cdn.jsdelivr.net/npm/dexie@3/dist/dexie.min.js'
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

            // Then try to cache external resources (don't fail if unavailable)
            console.log('[SW] Attempting to cache external resources');
            await Promise.allSettled(
                EXTERNAL_ASSETS.map(url =>
                    cache.add(url).catch(err => {
                        console.warn('[SW] Failed to cache external asset:', url, err);
                    })
                )
            );
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

    // Skip SSE streams — they are long-lived and cannot be cached
    if (url.pathname.startsWith('/api/changes/stream')) {
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
    event.respondWith(
        caches.match(event.request)
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
    // Cache external CDN resources
    if (url.hostname.includes('cdn.jsdelivr.net')) return true;
    if (url.hostname.includes('telegram.org')) return true;

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
    } else if (data.type === 'workout') {
        // For workout, open the app for all actions for now to show the modal options
        // We could implement background handlers later
        const params = new URLSearchParams();
        params.set('action', 'workout_start');
        if (data.session_id) params.set('session_id', data.session_id);

        const url = '/?' + params.toString();
        event.waitUntil(clients.openWindow(url));
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
        if (action === 'cancel_intake') {
            // Cancel/undo the early intake
            event.waitUntil(handleCancelIntake(data));
        } else {
            // Body click -> Open history tab
            event.waitUntil(clients.openWindow('/?tab=history'));
        }
    } else {
        event.waitUntil(clients.openWindow('/'));
    }
});

async function handleCancelIntake(data) {
    // POST to API to cancel
    try {
        const response = await fetch('/api/medications/cancel-intake', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                intake_ids: data.intake_ids
            })
        });

        if (response.ok) {
            console.log('[SW] Intake cancelled, reverted to PENDING');
            // Show a new notification confirming the cancellation
            await self.registration.showNotification('Intake Cancelled', {
                body: 'Your medication has been unmarked. The scheduled notification will still arrive.',
                icon: '/static/icons/icon-192.png',
                tag: 'intake-cancelled'
            });
        }
    } catch (e) {
        console.error('[SW] Failed to cancel intake', e);
    }

    // Notify all clients to update UI
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
        client.postMessage({ type: 'INTAKE_CANCELLED' });
    });
}

async function handleMedicationConfirm(data) {
    // POST to API
    try {
        const response = await fetch('/api/medications/confirm-schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                scheduled_at: data.scheduled_at,
                medication_ids: data.medication_ids,
                intake_ids: data.intake_ids
            })
        });

        if (response.ok) {
            console.log("Confirmed from push");
        }
    } catch (e) {
        console.error("Failed to confirm from push", e);
        // Maybe sync later?
    }

    // Notify all clients to update UI
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
        client.postMessage({ type: 'MEDICATION_CONFIRMED' });
    });
}

async function handleBPSnooze() {
    try {
        const response = await fetch('/api/bp/reminder/snooze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.ok) {
            console.log('[SW] BP reminder snoozed');
        }
    } catch (e) {
        console.error('[SW] Failed to snooze BP reminder', e);
    }
}

async function handleBPDontBug() {
    try {
        const response = await fetch('/api/bp/reminder/dontbug', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.ok) {
            console.log('[SW] BP reminder disabled for 24h');
        }
    } catch (e) {
        console.error('[SW] Failed to disable BP reminder', e);
    }
}

async function handleWeightSnooze() {
    try {
        const response = await fetch('/api/weight/reminder/snooze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.ok) {
            console.log('[SW] Weight reminder snoozed');
        }
    } catch (e) {
        console.error('[SW] Failed to snooze weight reminder', e);
    }
}

async function handleWeightDontBug() {
    try {
        const response = await fetch('/api/weight/reminder/dontbug', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.ok) {
            console.log('[SW] Weight reminder disabled for 24h');
        }
    } catch (e) {
        console.error('[SW] Failed to disable weight reminder', e);
    }
}
