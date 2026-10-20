// Emergency Kit save state, ceremony page → vault (bd med-ckm5.2). The kit page
// (signup, /recover, the /devices regenerate flow) runs on signup.html, where
// no vault records port exists, so it leaves {savedAt, how} in this origin's
// localStorage and cloud-boot files it into the synced `emergencykit` record
// (web/domain/settings.js) on the next unlocked open. Storage blocked, or a
// failed write: nothing is recorded and Settings keeps its kit reminder — the
// safe side. Same hand-off as the wizard's trial choice (signup.js).
const KEY = 'wg-emergency-kit-saved';

// `storage` defaults to localStorage, read inside the try: a blocked one throws on access.
export function stashKitSaved(state, storage) {
  try {
    (storage || globalThis.localStorage).setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage blocked: see above.
  }
}

// call = cloud-boot's shimCall(endpoint, method, body).
export async function drainKitSaved(call, storage) {
  let state = null;
  try {
    storage = storage || globalThis.localStorage;
    state = JSON.parse(storage.getItem(KEY) || 'null');
  } catch {
    // Storage blocked or an unreadable stash: nothing to file.
  }
  if (!state) return;
  try {
    await call('/api/settings/emergency-kit', 'PUT', state);
  } finally {
    // One shot: a stash that fails to file is dropped, never retried forever.
    try { storage.removeItem(KEY); } catch { /* storage blocked */ }
  }
}
