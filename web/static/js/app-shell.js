// PWA Registration and App Shell Management

// Send the Telegram init-data blob to the active SW so its notification
// action handlers can attach the X-Telegram-Init-Data auth header. Safe to
// call repeatedly; no-op when initData is absent or no controller is active.
window.sendSwAuthToken = function () {
    if (!navigator.serviceWorker) return;
    const token = window.userInitData;
    if (!token) return;
    const controller = navigator.serviceWorker.controller;
    if (!controller) return;
    try {
        controller.postMessage({ type: 'SET_AUTH_TOKEN', token });
    } catch (err) {
        console.log('SW token post failed:', err);
    }
};

window.initServiceWorker = function () {
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', async () => {
            try {
                const registration = await navigator.serviceWorker.register('/static/sw.js', {
                    scope: '/',
                    updateViaCache: 'none'
                });
                console.log('SW registered:', registration.scope);
                window.sendSwAuthToken();
                const checkForUpdate = () => registration.update().catch(() => { /* Ignore transient update-check failures */ });
                checkForUpdate();

                // iOS PWAs often resume from a backgrounded state without firing 'load',
                // so the one-shot update check above never re-runs. Re-check whenever the
                // app becomes visible/focused, plus a periodic tick for long-lived sessions.
                document.addEventListener('visibilitychange', () => {
                    if (document.visibilityState === 'visible') checkForUpdate();
                });
                window.addEventListener('focus', checkForUpdate);
                setInterval(checkForUpdate, 60 * 60 * 1000);

                // Check for updates
                registration.onupdatefound = () => {
                    const newWorker = registration.installing;
                    newWorker.onstatechange = () => {
                        if (newWorker.state === 'installed') {
                            if (navigator.serviceWorker.controller) {
                                // New version found! Show gentle update toast
                                window.showUpdateToast(newWorker, registration);
                            }
                        }
                    };
                };

            } catch (err) {
                console.log('SW registration failed:', err);
            }
        });

        // Reload when the controller changes (e.g. after skipWaiting).
        // Re-post the auth token first so the new SW receives it even if the
        // reload races; the new page load will also call sendSwAuthToken.
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            window.sendSwAuthToken();
            console.log('Controller changed, reloading...');
            window.location.reload();
        });
    }

    // Request persistent storage for Telegram WebApp context
    if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().then(granted => {
            console.log('Persistent storage:', granted ? 'granted' : 'not granted');
        });
    }
};

window.showUpdateToast = function (worker, registration) {
    const toast = document.createElement('div');
    toast.className = 'pwa-update-toast';
    toast.id = 'pwa-update-toast';

    const text = document.createElement('span');
    text.textContent = 'New version available';

    const btn = document.createElement('button');
    btn.textContent = 'Update';
    btn.id = 'pwa-update-btn';
    btn.className = 'pwa-update-btn';
    btn.onclick = () => {
        btn.textContent = 'Updating…';
        btn.disabled = true;
        // Use registration.waiting which is the correct reference
        // once the worker has moved from 'installing' to 'installed'
        const waiting = registration.waiting || worker;
        waiting.postMessage({ type: 'SKIP_WAITING' });
        // Fallback: if controllerchange doesn't fire within 2s, force reload
        setTimeout(() => window.location.reload(), 2000);
    };

    toast.appendChild(text);
    toast.appendChild(btn);
    document.body.appendChild(toast);
};

// Auto-init by default if not in test env
if (typeof process === 'undefined' || process.env.NODE_ENV !== 'test') {
    window.initServiceWorker();
}
