// The tap target of a reminder (bd med-9d1a), one shape for every emitter:
// the Web Push payload (push.js seals it inside the NK ciphertext) and the
// native shells' local notifications (reminders.js localNotificationItems).
// Pure, no imports — so a test that mocks push.js or reminders.js still gets it.

// The section a reminder of each kind belongs to.
export const KIND_SECTION = { medication: 'meds', low_stock: 'meds', bp: 'bp', weight: 'weight', workout: 'workouts' };

// A dose opens the take sheet for its slot through handlePushAction
// (deeplink-router.js → app.js); anything else opens its section. Always a
// same-origin relative path with query keys limited to tab / action / ids /
// scheduled — the service worker (sw.js reminderOpenUrl) and the shells
// allowlist exactly that shape. No names: the page resolves them from the vault
// and the url carries only opaque ids. No intake ids: the slot may not be
// materialized yet, which the confirm sheet already handles.
export function reminderDeeplink(entry) {
  const ids = entry && entry.kind === 'medication' && Array.isArray(entry.medicationIds) ? entry.medicationIds : [];
  if (ids.length && Number.isFinite(entry.fireAtUnix)) {
    const q = new URLSearchParams({
      action: 'medication_confirm',
      ids: ids.join(','),
      scheduled: new Date(entry.fireAtUnix * 1000).toISOString(),
    });
    return `/?${q}`;
  }
  return `/?tab=${KIND_SECTION[entry && entry.kind] || 'today'}`;
}
