class PushManager {
    constructor() {
        this.vapidPublicKey = null;
        this.subscription = null;
    }

    async initialize() {
        if (!('serviceWorker' in navigator && 'PushManager' in window)) {
            console.log('Push not supported');
            return false;
        }

        // Fetch VAPID public key
        try {
            const response = await fetch('/api/webpush/vapid-public-key', {
                headers: window.makeAuthHeaders()
            });
            if (!response.ok) return false;
            const data = await response.json();
            this.vapidPublicKey = data.public_key;
        } catch (e) {
            console.error("Failed to fetch VAPID key", e);
            return false;
        }

        // Check existing subscription
        try {
            const reg = await navigator.serviceWorker.ready;
            this.subscription = await reg.pushManager.getSubscription();
        } catch (e) {
            console.error("Failed to checking subscription", e);
        }

        return true;
    }

    // WebKit/iOS still implement the legacy callback form of
    // Notification.requestPermission(), and have been seen invoking that
    // callback with no argument — so `await Notification.requestPermission()`
    // yields undefined and reads as "denied" even after the user taps Allow.
    // Resolve with Notification.permission instead, read once the request
    // settles. Skip the prompt entirely when the choice is already made: on
    // that path WebKit may settle nothing, hanging this await forever.
    //
    // Third copy of this shim (see web/cloud/js/push.js and
    // features/settings.js) — the two cloud ones cannot be imported from a
    // classic script before the click's transient activation. med-1n6.
    requestPermission() {
        if (typeof Notification === 'undefined') return Promise.resolve('denied');
        if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
        const normalize = (v) => (['granted', 'denied', 'default'].includes(v) ? v : Notification.permission);
        return new Promise((resolve) => {
            const settle = (value) => resolve(normalize(value));
            const maybe = Notification.requestPermission(settle);
            if (maybe && typeof maybe.then === 'function') maybe.then(settle, () => settle(undefined));
        });
    }

    async subscribe() {
        if (!this.vapidPublicKey) return false;

        const permission = await this.requestPermission();
        if (permission !== 'granted') {
            return false;
        }

        try {
            const reg = await navigator.serviceWorker.ready;

            // Unsubscribe first if key changed (optional, but good practice)
            if (this.subscription) {
                // Check if existing sub uses same key? Complex.
                // Just proceed to subscribe.
            }

            const sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: this.urlBase64ToUint8Array(this.vapidPublicKey)
            });

            this.subscription = sub;

            // Save to server
            const response = await fetch('/api/webpush/subscribe', {
                method: 'POST',
                headers: window.makeAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    endpoint: sub.endpoint,
                    keys: {
                        auth: this.arrayBufferToBase64(sub.getKey('auth')),
                        p256dh: this.arrayBufferToBase64(sub.getKey('p256dh'))
                    }
                })
            });

            return response.ok;
        } catch (e) {
            console.error("Subscription failed", e);
            return false;
        }
    }

    async unsubscribe() {
        if (!this.subscription) return true;

        try {
            // Unsubscribe from Push Manager
            await this.subscription.unsubscribe();

            // Notify server
            await fetch('/api/webpush/unsubscribe', {
                method: 'POST',
                headers: window.makeAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ endpoint: this.subscription.endpoint })
            });

            this.subscription = null;
            return true;
        } catch (e) {
            console.error("Unsubscribe failed", e);
            return false;
        }
    }

    urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding)
            .replace(/\-/g, '+')
            .replace(/_/g, '/');
        const rawData = window.atob(base64);
        return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
    }

    arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
    }
}

window.MedTrackerPush = new PushManager();
