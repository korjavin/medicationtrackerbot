// Self-service account deletion (bd med-d5t.8). Zero-knowledge means the server
// can wipe the account but can never hand the data back, so the flow offers a
// full-vault export FIRST, then gates the irreversible delete on a FRESH passkey
// assertion — a stolen session cookie alone must not be able to delete a vault.
//
// The server side lives in internal/cloudserver/account.go; the re-auth ceremony
// (POST /api/account/reauth → DELETE /api/account with the assertion) is verified
// there, not merely on the client.

// exportVaultToFile downloads a plaintext JSON copy of the whole vault, so a
// friend about to delete keeps their data without having to know to export
// beforehand. The featured export (optional passphrase) still lives in Settings
// → Import/Export; this is the safety copy in the delete flow itself.
// Returns true after a download, false when the secrets warning is declined —
// the caller must not claim "downloaded" on false, or the user proceeds to an
// irreversible delete believing they hold a backup.
export async function exportVaultToFile(nowMs = Date.now()) {
  if (!window.CloudVault || typeof window.CloudVault.exportAll !== 'function') {
    throw new Error('Vault not ready — unlock the app first.');
  }
  // Same gate as Settings → Import/Export: the file holds live secrets, so warn
  // BEFORE they land in ~/Downloads in plain text.
  if (!window.confirm('This backup will contain your provider API keys and access tokens in plain text. Download anyway?')) {
    return false;
  }
  const json = await window.CloudVault.exportAll({ includeSecrets: true });
  const stamp = new Date(nowMs).toISOString().slice(0, 10);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `medtracker-vault-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}

// reauthAndDelete runs the fresh-passkey ceremony and deletes the account.
// Throws on any failure with a message suitable to show the user; resolves only
// once the server has confirmed the delete (204).
export async function reauthAndDelete() {
  const beginRes = await fetch('/api/account/reauth', { method: 'POST' });
  if (!beginRes.ok) throw new Error('Could not start passkey verification.');
  const { publicKey } = await beginRes.json();

  const requestOptions = PublicKeyCredential.parseRequestOptionsFromJSON(publicKey);
  let assertion;
  try {
    assertion = await navigator.credentials.get({
      publicKey: { ...requestOptions, userVerification: 'required' },
    });
  } catch (e) {
    // User dismissed the prompt, or no matching authenticator.
    throw new Error('Passkey verification was cancelled.');
  }
  if (!assertion) throw new Error('Passkey verification failed.');

  const delRes = await fetch('/api/account', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(assertion.toJSON()),
  });
  if (delRes.status !== 204) {
    if (delRes.status === 403) throw new Error('That passkey did not verify. Try again.');
    throw new Error('The account could not be deleted. Please try again.');
  }
}

function deleteDbVerified(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || new Error('Could not erase this device’s local copy.'));
    req.onblocked = () => reject(new Error('Close other open tabs of this app and try again.'));
  });
}

// clearLocalVault wipes this device's local mirror + warm-unlock cache so the
// app can't try to reopen an account that no longer exists. The delete flow
// runs it both before AND after the server delete (see settings.js); it must
// stay idempotent. Contract: the IndexedDB deletions are VERIFIED — this
// resolves only after the browser confirms both databases are gone
// (`medtracker-cloud`, the encrypted mirror + LDK material, and Dexie's
// `MedTrackerDB`, the shared frontend's plaintext health caches), and THROWS a
// recoverable error if a delete fails or is blocked by another open tab, so
// the caller can surface an honest "local copy not erased" message instead of
// navigating away. The push unsubscribe, service-worker unregister, and caches
// cleanup are best-effort: their failures never block or fail the wipe.
export async function clearLocalVault() {
  // Browser-side unsubscribe only: the server rows were already cascaded away
  // by DELETE /api/account, and push.js's unsubscribe() is server-first — its
  // DELETE /api/push/subscriptions would 401 (session gone) and throw before
  // ever reaching the browser subscription. Must run before the SW unregister
  // below, which makes the registration (and its subscription) unreachable.
  try {
    const push = await import('./push.js');
    const sub = await push.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch { /* best-effort */ }
  try {
    const reg = await navigator.serviceWorker?.getRegistration('/');
    if (reg) await reg.unregister();
  } catch { /* best-effort */ }
  if (typeof indexedDB !== 'undefined' && indexedDB.deleteDatabase) {
    // Dexie holds a long-lived MedTrackerDB handle; its default versionchange
    // handler closes it, but close explicitly so our own tab can't block us.
    try { window.MedTrackerDB?.db?.close?.(); } catch { /* best-effort */ }
    await deleteDbVerified('medtracker-cloud');
    await deleteDbVerified('MedTrackerDB');
  }
  try {
    if (typeof caches !== 'undefined' && caches.keys) {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    }
  } catch { /* best-effort */ }
}

// The word the user types to confirm. Deliberately not the subdomain — a friend
// may not know it offhand, and a fixed intent phrase is clearer.
export const DELETE_CONFIRM_PHRASE = 'delete my account';

// baseDomainURL strips the account's own subdomain label so we can send the user
// somewhere that still exists after their subdomain is gone.
export function baseDomainURL(loc = (typeof location !== 'undefined' ? location : null)) {
  if (!loc) return '/';
  const parts = loc.hostname.split('.');
  const base = parts.length > 1 ? parts.slice(1).join('.') : loc.hostname;
  return `${loc.protocol}//${base}${loc.port ? ':' + loc.port : ''}/`;
}
