// Service Worker for Med Tracker PWA
const CACHE_VERSION = 'CACHE_VERSION_PLACEHOLDER'; // Auto-updated by CI/CD
const STATIC_CACHE = `medtracker-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `medtracker-dynamic-${CACHE_VERSION}`;

// Static assets to cache on install
const STATIC_ASSETS = [
    '/',
    '/static/index.html',
    '/static/css/styles.css',
    '/static/js/app.js',
    '/static/js/workout.js',
    '/static/js/db.js',
    '/static/js/sync.js',
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
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then((cache) => {
                console.log('[SW] Caching static assets');
                // Cache static assets first
                return cache.addAll(STATIC_ASSETS)
                    .then(() => {
                        // Then try to cache external resources (don't fail if unavailable)
                        console.log('[SW] Attempting to cache external resources');
                        return Promise.allSettled(
                            EXTERNAL_ASSETS.map(url =>
                                cache.add(url).catch(err => {
                                    console.warn('[SW] Failed to cache external asset:', url, err);
                                })
                            )
                        );
                    });
            })
            .then(() => self.skipWaiting())
            .catch((err) => {
                console.error('[SW] Failed to cache static assets:', err);
            })
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating...');
    event.waitUntil(
        caches.keys()
            .then((keys) => {
                return Promise.all(
                    keys
                        .filter((key) => key !== STATIC_CACHE && key !== DYNAMIC_CACHE)
                        .map((key) => {
                            console.log('[SW] Removing old cache:', key);
                            return caches.delete(key);
                        })
                );
            })
            .then(() => self.clients.claim())
    );
});

// Fetch event - network-first for API, cache-first for static
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET requests
    if (event.request.method !== 'GET') {
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
    } else if (event.tag === 'sync-all') {
        event.waitUntil(
            Promise.all([
                syncBPReadings(),
                syncWeightLogs()
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
    } else {
        event.waitUntil(clients.openWindow('/'));
    }
});

async function handleMedicationConfirm(data) {
    // POST to API
    try {
        const response = await fetch('/api/medications/confirm-schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                scheduled_at: data.scheduled_at,
                medication_ids: data.medication_ids
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
