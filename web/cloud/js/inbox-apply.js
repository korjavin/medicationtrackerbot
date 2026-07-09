// Applies sealed inbound Telegram events through the normal JS domain layer
// (bd med-76c.2, part 2). The relay could not apply these itself — it cannot
// write ciphertext it cannot produce — so it sealed the user's intent and an
// unlocked client replays it here.
//
// The only event kind today is a Confirm/Snooze tap on a medication reminder.
// Its callback_data is slot-scoped ("s:<slotUnix>"), because a cloud dose
// reminder bundles every medication due at one instant into a single message
// (web/domain/reminders.js groups targets bySlot). So "Confirm" means "I took
// the meds due at 08:00", and expanding the slot to its intakes happens HERE,
// on an unlocked client that can actually see which meds those are.
import { createIntakeDomain } from '../../domain/medintake.js';
import { recordsPort } from './sync.js';

export const INTAKE_SLOT_ACTION = 'intake_slot_action';

const INTAKE_RECORD_TYPE = 'intake';

// Mirrors DEFAULT_SNOOZE_MINUTES in web/domain/medintake.js (and the server's
// own default). Not imported because that module does not export it.
const DEFAULT_SNOOZE_MINUTES = 10;

function defaultTimeZone() {
  return (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
}

// A re-drained event finds its intakes already TAKEN, and the domain's confirm()
// throws rather than double-decrement inventory. That throw is the idempotency
// guard doing its job, not a failure — swallow it so the event still gets acked.
// Anything else propagates and leaves the event queued for the next drain.
//
// Keyed on the domain's structured `code`, not its message text.
function isAlreadyApplied(err) {
  return !!err && err.code === 'not_pending';
}

// applyIntakeSlotAction confirms (or snoozes) every PENDING intake at slotUnix.
//
// atUnix is the SERVER's timestamp for the tap, so a Confirm tapped at 09:00
// records taken_at 09:00 even when the app first opens at noon — the backdating
// rule (docs/cloud-mode.md → drain protocol, rule 4).
export async function applyIntakeSlotAction(event, { intake, records, now = Date.now }) {
  const slotMs = event.slot_unix * 1000;
  const atMs = event.at_unix * 1000;

  // The tap may name a slot whose intakes were never materialized (the app has
  // not been open since it came due). Materializing first is what makes them
  // exist to confirm; it is idempotent via the deterministic intake id.
  await intake.materializeDueDoses();

  const intakes = await records.list(INTAKE_RECORD_TYPE);
  const atSlot = intakes.filter((i) => !i.deleted
    && i.status === 'PENDING'
    && Date.parse(i.scheduled_at) === slotMs);

  for (const i of atSlot) {
    try {
      if (event.action === 'confirm') {
        await intake.confirm(i.recordId, atMs);
      } else {
        // Snooze from the TAP, not from the drain. If that window already
        // elapsed while the app was closed, snoozing is meaningless — the
        // re-reminders it would have suppressed have already fired.
        const minutes = (atMs + DEFAULT_SNOOZE_MINUTES * 60_000 - now()) / 60_000;
        if (minutes <= 0) continue;
        await intake.snooze(i.recordId, minutes);
      }
    } catch (e) {
      if (!isAlreadyApplied(e)) throw e;
    }
  }
}

// createInboxApplier returns the `apply` callback drainInbox expects: one
// decrypted event in, a domain write out. Unknown kinds are ignored rather than
// thrown — a newer relay may queue kinds this client predates, and stalling the
// whole drain on one of them would block the events it does understand.
export function createInboxApplier(ctx, { records: recordsOverride, now = Date.now } = {}) {
  const records = recordsOverride || recordsPort(ctx);
  const intake = createIntakeDomain({ records, now, timeZone: defaultTimeZone() });

  return async function apply(event) {
    if (!event || event.kind !== INTAKE_SLOT_ACTION) {
      console.warn('[inbox] ignoring unknown event kind', event && event.kind);
      return;
    }
    if (event.action !== 'confirm' && event.action !== 'snooze') {
      console.warn('[inbox] ignoring unknown action', event.action);
      return;
    }
    await applyIntakeSlotAction(event, { intake, records, now });
  };
}
