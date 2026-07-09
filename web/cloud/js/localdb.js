// Single shared per-device IndexedDB handle for the cloud shell. unlock.js
// (LDK warm-unlock cache) and sync.js (local record mirror) both open this
// same database — centralizing name/version here means adding a sync.js
// object store can never collide with unlock.js opening an older version.
const DB_NAME = 'medtracker-cloud';
// v3: 'recordType' index on records. Without it every records.list(type) was a
// full-store getAll() + JS filter, structured-cloning every record of every
// domain (sync.js listRecords).
const DB_VERSION = 3;

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('device')) db.createObjectStore('device');
      if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'recordId' });
      if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending', { keyPath: 'recordId' });
      if (!db.objectStoreNames.contains('sync_meta')) db.createObjectStore('sync_meta');
      // Existing v2 rows already carry recordType (putRecord always writes it),
      // so createIndex backfills the index from them — no data migration.
      const records = req.transaction.objectStore('records');
      if (!records.indexNames.contains('recordType')) records.createIndex('recordType', 'recordType');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
