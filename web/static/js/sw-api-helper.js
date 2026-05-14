// Service Worker API helper — POST wrapper used by notification action
// handlers in sw.js. Mirrors the main-thread apiCallDirect contract:
//   - sends X-Telegram-Init-Data when an auth token has been handed off
//     via the SET_AUTH_TOKEN message
//   - always sends credentials: 'include' so cookie-based deployments work
//   - returns the parsed JSON body on 2xx (true if empty)
//   - throws an Error with .status set for non-2xx
//
// Loaded into the SW via importScripts at the top of sw.js. Also imported
// directly in unit tests as plain JS.
//
// See docs/plans/2026-05-13-sw-handler-unification.md.

(function (root) {
    const SwApi = {
        authToken: null,
        async call(endpoint, method = 'GET', body = null) {
            const headers = {};
            if (body) headers['Content-Type'] = 'application/json';
            if (this.authToken) headers['X-Telegram-Init-Data'] = this.authToken;

            const res = await fetch(endpoint, {
                method,
                headers,
                credentials: 'include',
                body: body ? JSON.stringify(body) : null,
            });

            if (!res.ok) {
                const txt = await res.text().catch(() => '');
                const err = new Error(txt || res.statusText || 'Request failed');
                err.status = res.status;
                throw err;
            }

            if (res.status === 204) return true;
            const txt = await res.text();
            if (!txt) return true;
            try {
                return JSON.parse(txt);
            } catch (e) {
                return true;
            }
        },
        // Persist a failed POST envelope into the `pending_sw_actions`
        // Dexie object store so the main thread can drain it later via
        // SyncManager.drainSwActionQueue. Dexie itself lives on
        // `window` and isn't available inside a SW; we write through
        // the raw IndexedDB API against the already-existing
        // MedTrackerDB. The schema (++localId, endpoint, syncStatus,
        // createdAt) must already be present — it's created by the
        // main thread on first load (db.js v6).
        //
        // Errors swallowed: this is the SAFETY-NET for already-failed
        // requests. If we can't even queue the action (DB closed,
        // private mode, quota), we resolve(false) and let the user
        // re-trigger the action from the app the next time it opens.
        // Throwing here would break the calling handler's catch path.
        async enqueueFailedAction(action) {
            try {
                const record = {
                    endpoint: action.endpoint,
                    method: action.method || 'POST',
                    body: action.body ?? null,
                    syncStatus: 'pending',
                    createdAt: Date.now(),
                };
                await idbAddPendingAction(record);
                // Notify any open clients so SyncManager can drain
                // immediately. Without this, an enqueue from a transient
                // 5xx while the app is open sits idle until the next
                // online/offline transition or page reload. Best-effort:
                // clients may be absent (background push with no open
                // tab) — that path is covered by SyncManager.syncAll()
                // running on init / online.
                if (typeof root.clients !== 'undefined' && root.clients.matchAll) {
                    try {
                        const clientList = await root.clients.matchAll({
                            includeUncontrolled: true,
                            type: 'window',
                        });
                        for (const c of clientList) {
                            try { c.postMessage({ type: 'SW_ACTION_QUEUED' }); }
                            catch (_) { /* client may be gone */ }
                        }
                    } catch (_) { /* matchAll itself failed — ignore */ }
                }
                return true;
            } catch (e) {
                // Best-effort: cannot use console.error per Task 5
                // grep rule; the request is already lost so this
                // additional swallow is the failure mode of last
                // resort. The main thread's SyncManager will display
                // nothing because nothing got queued — that matches
                // the legacy "lost on failure" behaviour.
                return false;
            }
        },
    };

    function idbOpen() {
        return new Promise((resolve, reject) => {
            const req = root.indexedDB.open('MedTrackerDB');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('indexedDB.open failed'));
            req.onblocked = () => reject(new Error('indexedDB.open blocked'));
        });
    }

    function idbAddPendingAction(record) {
        return new Promise((resolve, reject) => {
            let db;
            idbOpen().then((openedDb) => {
                db = openedDb;
                if (!db.objectStoreNames.contains('pending_sw_actions')) {
                    db.close();
                    reject(new Error('pending_sw_actions store missing — main thread has not opened v6 yet'));
                    return;
                }
                const tx = db.transaction('pending_sw_actions', 'readwrite');
                const store = tx.objectStore('pending_sw_actions');
                const addReq = store.add(record);
                addReq.onsuccess = () => { /* localId in addReq.result */ };
                addReq.onerror = () => reject(addReq.error || new Error('add failed'));
                tx.oncomplete = () => { db.close(); resolve(true); };
                tx.onerror = () => { db.close(); reject(tx.error || new Error('tx failed')); };
                tx.onabort = () => { db.close(); reject(tx.error || new Error('tx aborted')); };
            }, reject);
        });
    }

    root.SwApi = SwApi;
    root.swApiCall = (endpoint, method, body) => SwApi.call(endpoint, method, body);
})(typeof self !== 'undefined' ? self : globalThis);
