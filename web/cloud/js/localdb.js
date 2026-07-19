// Single shared per-device IndexedDB handle for the cloud shell. unlock.js
// (LDK warm-unlock cache) and sync.js (local record mirror) both open this
// same database — centralizing name/version here means adding a sync.js
// object store can never collide with unlock.js opening an older version.
const DB_NAME = 'medtracker-cloud';
// v3: 'recordType' index on records. Without it every records.list(type) was a
// full-store getAll() + JS filter, structured-cloning every record of every
// domain (sync.js listRecords).
// v4: 'feedback_outbox' store (med-dni.3) — durable age-ciphertext submit queue,
// keyed by client_id. Independent of the sync oplog stores.
const DB_VERSION = 4;

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('device')) db.createObjectStore('device');
      if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'recordId' });
      if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending', { keyPath: 'recordId' });
      if (!db.objectStoreNames.contains('sync_meta')) db.createObjectStore('sync_meta');
      if (!db.objectStoreNames.contains('feedback_outbox')) db.createObjectStore('feedback_outbox', { keyPath: 'client_id' });
      // Existing v2 rows already carry recordType (putRecord always writes it),
      // so createIndex backfills the index from them — no data migration.
      const records = req.transaction.objectStore('records');
      if (!records.indexNames.contains('recordType')) records.createIndex('recordType', 'recordType');
    };
    req.onsuccess = () => {
      // Auto-close on versionchange so a live handle never blocks
      // account-delete's deleteDatabase() (or a future version upgrade).
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
}
