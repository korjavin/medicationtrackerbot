// Service worker for the cloud shell (Task 6, docs/cloud-mode.md "Push relay
// & reminder lifecycle"). Classic script (not `type: module`) for the widest
// browser support; NK decrypt needs crypto.js/localdb.js (ES modules), so it
// dynamic-imports them inside the push handler instead of a static top-level
// import — dynamic import() is available in classic workers in every browser
// this project targets (Chrome, Firefox, Safari 15+).

const CACHE_NAME = 'medtracker-cloud-v1';
const PRECACHE_URLS = [
  '/index.html',
  '/signup.html',
  '/css/cloud.css',
  '/js/app.js',
  '/js/claim.js',
  '/js/crypto.js',
  '/js/devices.js',
  '/js/localdb.js',
  '/js/notes.js',
  '/js/push.js',
  '/js/recover.js',
  '/js/signup.js',
  '/js/sync.js',
  '/js/transfer.js',
  '/js/unlock.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

const GENERIC_NOTIFICATION = { title: 'Med Tracker', body: 'Medication reminder' };

// NK plaintext cache lives in the 'device' object store under key 'nk'
// (docs/cloud-crypto.md: "plaintext copy in device IndexedDB" for the SW).
async function readNK() {
  const { openDb } = await import('./js/localdb.js');
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('device', 'readonly');
      const req = tx.objectStore('device').get('nk');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

// Task 7's stale-sync warning is a server-composed, content-free push sent
// outside the NK app-layer encryption path (the server has no NK to encrypt
// with). It's plain JSON tagged kind=="server-warning" — anything else is NK
// ciphertext and falls through to the decrypt attempt below.
const STALE_SYNC_WARNING = { title: 'Med Tracker', body: 'Open the app to keep reminders running' };

function tryDecodeServerWarning(data) {
  try {
    const payload = JSON.parse(new TextDecoder().decode(data));
    if (payload && payload.kind === 'server-warning') {
      // The server is untrusted in the zero-knowledge model: render a fixed
      // client-side constant keyed only on the `kind` flag, never the
      // server-supplied title/body, so a hostile server can't inject arbitrary
      // (phishing) notification text on this one non-NK-encrypted channel.
      return { ...STALE_SYNC_WARNING };
    }
  } catch {
    // Not JSON — real NK ciphertext, ignore.
  }
  return null;
}

// NK absent, or the app-layer ciphertext fails to decrypt (tampered, or this
// device's vault was never provisioned) — fall back to the content-free
// generic notification rather than surfacing an error to the user.
async function decodePush(data) {
  const warning = tryDecodeServerWarning(data);
  if (warning) return warning;
  try {
    const nk = await readNK();
    if (!nk) return GENERIC_NOTIFICATION;
    const { decryptPushPayload } = await import('./js/crypto.js');
    const plaintext = await decryptPushPayload(nk, new Uint8Array(data));
    const payload = JSON.parse(new TextDecoder().decode(plaintext));
    return { title: payload.title || GENERIC_NOTIFICATION.title, body: payload.body || GENERIC_NOTIFICATION.body };
  } catch {
    return GENERIC_NOTIFICATION;
  }
}

self.addEventListener('push', (event) => {
  const raw = event.data ? event.data.arrayBuffer() : Promise.resolve(null);
  event.waitUntil(
    raw
      .then((buf) => (buf && buf.byteLength ? decodePush(buf) : GENERIC_NOTIFICATION))
      .then((n) => self.registration.showNotification(n.title, { body: n.body }))
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
