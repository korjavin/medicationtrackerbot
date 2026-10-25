// The tap target of a reminder (bd med-9d1a). Today push.js seals it inside the
// Web Push NK ciphertext; the native shells' local notifications
// (reminders.js localNotificationItems, which shares KIND_SECTION) are meant to
// emit the same shape — wiring them is med-w6gx.20. Pure, no imports, so a
// test that mocks push.js or reminders.js still gets it.

// The section a reminder of each kind belongs to.
export const KIND_SECTION = { medication: 'meds', low_stock: 'meds', bp: 'bp', weight: 'weight', workout: 'workouts' };

// A dose opens the take sheet for its slot through handlePushAction
// (deeplink-router.js → app.js); anything else opens its section (?tab=meds is
// only honoured inside the native shells — on the web it opens the default tab,
// as before). Always a same-origin relative path with query keys limited to
// tab / action / ids / scheduled — the shape sw.js reminderOpenUrl allowlists
// (and a shell must allowlist likewise). No names: the page resolves them from the vault
// and the url carries only opaque ids. No intake ids: the slot may not be
// materialized yet, which the confirm sheet already handles.
export function reminderDeeplink(entry) {
  const ids = entry && entry.kind === 'medication' && Array.isArray(entry.medicationIds) ? entry.medicationIds : [];
  if (ids.length && Number.isFinite(entry.fireAtUnix)) {
    const q = new URLSearchParams({
      action: 'medication_confirm',
      ids: ids.join(','),
      // The planned slot, not the fire time: a snooze-end reminder fires later
      // than its dose (bd med-4j49).
      scheduled: new Date((Number.isFinite(entry.slotUnix) ? entry.slotUnix : entry.fireAtUnix) * 1000).toISOString(),
    });
    return `/?${q}`;
  }
  return `/?tab=${KIND_SECTION[entry && entry.kind] || 'today'}`;
}
