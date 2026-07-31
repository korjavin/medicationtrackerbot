// Sealed inbound mailbox — client half of the foundation (bd med-76c.2).
//
// The relay receives Telegram events it cannot apply (it can't write ciphertext
// it can't produce). It seals each one to this account's X25519 inbox public key
// and queues it. This module owns that keypair and the raw mailbox transport;
// the drain that *applies* events lands with the Telegram surface (part 2).
//
// Key placement matters: the private key is an ordinary vault record, so it
// syncs to every device and any unlocked client can drain. It is generated once,
// on the first unlock that finds none, and the public half is (re)published on
// every unlock — PUT /api/inbox/key is last-write-wins, and republishing the key
// we just read from the vault is idempotent.
import {
  generateInboxKeypair,
  inboxCryptoSupported,
  inboxPublicFromPrivate,
  openInboxEvent,
  toBase64,
  fromBase64,
} from './crypto.js';
import { recordsPort, flushConfirmed, isSyncWedged } from './sync.js';

const INBOXKEY_RECORD_TYPE = 'inboxkey';
const INBOXKEY_RECORD_ID = 'inboxkey';

function findSingleton(all, recordId) {
  return all.find((r) => r.recordId === recordId && !r.deleted) || null;
}

// readInboxKey returns the vault's PKCS#8 private key, or null when this account
// has never generated one.
export async function readInboxKey(ctx, { records: recordsOverride } = {}) {
  const records = recordsOverride || recordsPort(ctx);
  const rec = findSingleton(await records.list(INBOXKEY_RECORD_TYPE), INBOXKEY_RECORD_ID);
  return rec && rec.privateKey ? fromBase64(rec.privateKey) : null;
}

// ensureInboxKey generates the account's inbox keypair if the vault has none,
// then publishes the public half so the server can start sealing.
//
// Ordering is load-bearing: the private key is written to the vault BEFORE the
// public key is published. Publishing first would let the server seal events to
// a key we might never persist (a crash between the two), stranding them
// permanently. Doing it in this order can only ever republish a key we can open.
//
// Returns the PKCS#8 private key, or null when this browser cannot do X25519 —
// in which case the mailbox stays unusable rather than half-provisioned.
export async function ensureInboxKey(ctx, { records: recordsOverride, fetchImpl = fetch } = {}) {
  if (!(await inboxCryptoSupported())) {
    console.warn('[inbox] this browser has no WebCrypto X25519 — inbound Telegram events cannot be received');
    return null;
  }
  const records = recordsOverride || recordsPort(ctx);

  let privateKey = await readInboxKey(ctx, { records });
  let publicKey;
  if (privateKey) {
    publicKey = await inboxPublicFromPrivate(privateKey);
  } else {
    const kp = await generateInboxKeypair();
    privateKey = kp.privateKey;
    publicKey = kp.publicKey;
    // Vault first — see the ordering note above.
    await records.put(INBOXKEY_RECORD_TYPE, {
      recordId: INBOXKEY_RECORD_ID,
      clientTs: Date.now(),
      deleted: false,
      privateKey: toBase64(privateKey),
    });
  }

  const res = await fetchImpl('/api/inbox/key', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_key: toBase64(publicKey) }),
  });
  if (!res.ok) throw new Error(`could not publish the inbox key (${res.status})`);
  return privateKey;
}

// listInboxEvents returns the pending sealed events, oldest first. Each entry is
// either `{id, event}` (opened into its plaintext object) or `{id, error}` when
// this device cannot open it. `createdAtUnix` comes from the sealed payload —
// never from the clear-text column, which the server could lie about.
//
// An event that fails to open is SURFACED PER EVENT, never silently dropped
// (that would lose a Confirm the user actually tapped) and never thrown out of
// here (bd med-3q8.3). Throwing aborted the whole page: one permanently
// un-openable seal — e.g. sealed to an inbox public key a concurrent device's
// last-write-wins PUT /api/inbox/key superseded — made every later Telegram
// command sit at "⏳ Queued" forever, because the drain died before it ever
// reached the events it COULD apply. The caller leaves an un-openable event
// queued (never acks it), so a device that still holds the matching private key
// can drain it.
export async function listInboxEvents(ctx, privateKey, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl('/api/inbox');
  if (!res.ok) throw new Error(`could not read the inbox (${res.status})`);
  const { events = [] } = await res.json();

  const out = [];
  for (const e of events) {
    try {
      const plaintext = await openInboxEvent(privateKey, ctx.accountId, fromBase64(e.ct));
      out.push({ id: e.id, event: JSON.parse(new TextDecoder().decode(plaintext)) });
    } catch (error) {
      out.push({ id: e.id, error });
    }
  }
  return out;
}

// ackInboxEvent deletes one event. Only ever call this once the ops the event
// produced are CONFIRMED flushed (sync.js flushConfirmed) — acking earlier is
// exactly the failure this design exists to prevent: an event marked processed
// that never reached the vault.
export async function ackInboxEvent(id, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`/api/inbox/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`could not ack inbox event ${id} (${res.status})`);
}

// clearInbox drops the whole server-side backlog and returns the count cleared.
// This DISCARDS any un-applied sealed events — the same recovery trade
// resetLocalSync makes when it wipes un-synced local writes. It exists only for
// the reset escape hatch (med-eas.51): a permanently un-appliable sealed .nxk
// wedges sync forever, so un-wedging must also drop the poison backlog or the
// drain re-fetches it (up to ~160MB) on the very next poll. Never call this on a
// healthy account — it throws away real queued Confirms.
export async function clearInbox({ fetchImpl = fetch } = {}) {
  const res = await fetchImpl('/api/inbox', { method: 'DELETE' });
  if (!res.ok) throw new Error(`could not clear the inbox (${res.status})`);
  const { cleared = 0 } = await res.json();
  return cleared;
}

// One drain at a time per account. Two overlapping drains in the SAME tab would
// both apply every event and race on the ack; across tabs/devices that is fine
// (deletes are idempotent, applies converge) but within a tab it is pure waste.
const draining = new Set();

// drainInbox applies every pending event, then acks it. The binding rules
// (docs/cloud-mode.md → "Drain protocol") in the order they appear here:
//
//   4. Apply in SERVER-timestamp order. The mailbox returns rows in arrival
//      order; `at_unix` is the sealed instant Telegram's tap actually happened.
//      Those differ if the relay queued out of order, so we sort.
//   1. Ack strictly AFTER flush. `apply` writes through the domain layer, then
//      flushConfirmed() must resolve true — meaning the ops reached the sync
//      log — before the event is deleted. A crash anywhere earlier leaves the
//      event queued for the next drain, which is the whole point.
//   2. At-least-once + idempotent. Re-draining an applied event must converge,
//      not duplicate; `apply` is responsible for that (deterministic ids).
//   3. Concurrent drainers are expected. A second drainer deleting an event we
//      already deleted is a no-op, so nothing here locks across devices.
//
// One event's failure must not strand the rest: we log it, skip its ack (so it
// is retried next drain) and continue. That holds for an event this device
// cannot even OPEN too (bd med-3q8.3) — it is counted in `unopenable`, left
// queued, and stepped over, never allowed to abort the page. Returns a small
// report for tests/logs.
export async function drainInbox(ctx, { apply, records, fetchImpl = fetch, flush = flushConfirmed, wedged = isSyncWedged } = {}) {
  const key = (ctx && ctx.accountId) || ctx;
  if (draining.has(key)) return { applied: 0, failed: 0, skipped: true };
  draining.add(key);
  try {
    // Sync wedged (med-eas.51): flushConfirmed can never resolve true, so no
    // event could ever ack. Skip the fetch entirely — the backlog can be ~160MB
    // and re-fetching it every poll is the self-DoS this guard exists to stop.
    // Derived from the same syncWedged meta, so resetLocalSync un-pauses us.
    if (await wedged(ctx)) return { applied: 0, failed: 0, wedged: true };

    const privateKey = await readInboxKey(ctx, { records });
    if (!privateKey) return { applied: 0, failed: 0 };

    const pending = await listInboxEvents(ctx, privateKey, { fetchImpl });
    if (pending.length === 0) return { applied: 0, failed: 0 };

    // Rule 4. Ties (same second) fall back to arrival order. An un-openable
    // event carries no sealed instant, so it sorts LAST: the events we can
    // actually apply go first and a poison seal never delays them (nor trips the
    // leading-flush-false abort below on their behalf).
    const atUnix = (p) => (p.event ? p.event.at_unix : Number.MAX_SAFE_INTEGER);
    pending.sort((a, b) => (atUnix(a) - atUnix(b)) || (a.id - b.id));

    let applied = 0;
    let failed = 0;
    let unopenable = 0;
    let stalled = false;
    for (const { id, event, error } of pending) {
      if (error) {
        // Left QUEUED (no ack) — another device may still hold the private key
        // this was sealed to. Counted separately from an apply failure because
        // it is cheap and permanent for THIS device: the poller must not treat
        // it as the bricked-mailbox signal (see startInboxPolling).
        unopenable++;
        failed++;
        console.error('[inbox] could not open event, leaving it queued', id, error);
        continue;
      }
      try {
        // The event id is passed so appliers can derive a DETERMINISTIC record
        // id from it (drain rule 2): a crash between flush and ack re-applies
        // this event, and the write must overwrite its own row, not add one.
        await apply(event, id);
        // Rule 1: the barrier. `false` means ops are still pending — leave the
        // event queued rather than ack something that may never land.
        const flushed = await flush(ctx);
        if (!flushed) {
          failed++;
          console.warn('[inbox] ops not confirmed flushed; leaving event queued', id);
          // A LEADING flush-false (nothing acked yet this drain) means sync
          // can't confirm anything — almost always a wedge just forming. Abort
          // the whole drain instead of apply+fail every remaining event, and
          // signal the poller to back off (med-eas.51). Once we've made
          // progress, a later flush-false is just that event's ops still
          // settling, so keep the existing leave-queued-and-continue behaviour.
          if (applied === 0) { stalled = true; break; }
          continue;
        }
        await ackInboxEvent(id, { fetchImpl });
        applied++;
      } catch (e) {
        failed++;
        console.error('[inbox] event failed, leaving it queued', id, e);
      }
    }
    // `unopenable`/`stalled` only appear when they happened — the report is read
    // by the poller's backoff gate and asserted verbatim by its tests.
    const report = { applied, failed };
    if (unopenable) report.unopenable = unopenable;
    if (stalled) report.stalled = true;
    return report;
  } finally {
    draining.delete(key);
  }
}

// How often a tab checks the mailbox — visible or hidden (med-d15). The relay
// answers a Telegram command with "⏳ Queued" and only an unlocked client can
// turn that into "✅ Recorded", so this interval is the latency the user
// actually feels — and while they are typing in Telegram, this tab is by
// definition hidden. A hidden tab that skipped the timer was a permanently
// silent mailbox until the user looked at the app.
//
// The cost of keeping it running in the background is small because we do not
// pay this interval there: browsers clamp timers in a backgrounded tab to
// roughly one fire per minute on their own, so a backgrounded tab is about one
// empty GET /api/inbox per minute, not one per 5s.
//
// This is the FLOOR, not the only signal: the server also pushes a content-free
// inbox-wake the instant it seals an event, which cloud-boot.js turns into an
// immediate drain (bd med-5fo). The poll still matters — a wake needs
// notification permission and a live subscription — and GET /api/inbox on an
// empty mailbox is one indexed lookup returning `{"events":[]}`.
const INBOX_POLL_MS = 5000;

// Backoff ceiling for a wedged/stalled mailbox (med-eas.51). Consecutive
// no-progress drains skip an exponentially growing number of scheduled ticks so
// a bricked account stops hammering GET /api/inbox every 5s; capped so recovery
// (a reset that un-wedges) is still noticed within ~a minute at the 5s interval.
const MAX_INBOX_BACKOFF_TICKS = 12;

// startInboxPolling drains the mailbox on a timer, and immediately whenever the
// tab becomes visible again. Without it a Confirm tapped in Telegram sits
// unapplied until the next full page load, because nothing else in cloud mode
// polls (no SSE, no change stream).
//
// Hidden tabs DO poll (med-d15). Skipping them looked like battery thrift but
// was the bug: the user is in Telegram exactly when this tab is hidden, so the
// mailbox was silent for the whole time it mattered and the ✅ only ever landed
// the instant they switched back. Browsers already throttle background timers to
// roughly one fire per minute, so the real cost is one empty GET /api/inbox per
// minute per backgrounded tab.
//
// The visibilitychange tick below stays: it is the instant-on-focus path and it
// deliberately bypasses the backoff gate. Returns a stop() for tests and
// teardown.
export function startInboxPolling(ctx, {
  apply,
  intervalMs = INBOX_POLL_MS,
  doc = typeof document === 'undefined' ? null : document,
  onApplied = () => {},
  // `drain` defaults to the real drainInbox; tests inject a deterministic fake so
  // the backoff-gate assertions don't race real WebCrypto event-opening against
  // fake timers (that async slop leaks logs across tests and skews GET counts).
  drain = drainInbox,
  ...drainOpts
} = {}) {
  let stopped = false;
  // Backoff state (med-eas.51): after consecutive no-progress drains (wedged or
  // stalled), skip `skipTicks` scheduled fires so a bricked account stops
  // re-fetching the backlog every interval. A manual visibility trigger bypasses
  // the gate once — the user opened the tab expecting fresh data.
  let noProgress = 0;
  let skipTicks = 0;

  const tick = async ({ force = false } = {}) => {
    if (stopped || !apply) return;
    // drainInbox already no-ops when another drain is in flight for this
    // account, so a slow drain cannot pile up behind the timer.
    if (!force && skipTicks > 0) { skipTicks--; return; }
    try {
      const result = await drain(ctx, { apply, ...drainOpts });
      if (!result || result.skipped) {
        // Another drain held the lock — leave the backoff window untouched.
      } else if (result.applied > 0) {
        noProgress = 0;
        skipTicks = 0;
        onApplied(result);
      } else if (result.wedged || result.stalled || result.failed > (result.unopenable || 0)) {
        // No progress this tick: wedged, a leading flush-false stall, or every
        // event failed to APPLY (a poison event that throws in apply). Back off
        // on ANY such no-progress drain, not just the flush-false one — the byte
        // cap already bounds each fetch, but a poison event that never applies
        // would otherwise re-fetch its chunk every interval (med-eas.51).
        noProgress++;
        skipTicks = Math.min(2 ** noProgress, MAX_INBOX_BACKOFF_TICKS);
      } else {
        // Healthy idle: empty mailbox, no key — or a mailbox holding nothing but
        // seals THIS device can never open (a superseded inbox key). Those are
        // deliberately not the bricked-mailbox signal (bd med-3q8.3): they are
        // skipped client-side after a fetch the byte cap already bounds, so they
        // cost exactly what an empty poll costs, and throttling on them left the
        // NEXT real command sitting at "⏳ Queued" for up to a minute. Drop any
        // backoff so a fresh event is picked up at the normal interval.
        noProgress = 0;
        skipTicks = 0;
      }
    } catch (e) {
      // A thrown drain (poison event that fails to decrypt, or a network error)
      // is also no-progress — back off rather than retry at full cadence.
      console.error('[inbox] poll drain failed', e);
      noProgress++;
      skipTicks = Math.min(2 ** noProgress, MAX_INBOX_BACKOFF_TICKS);
    }
  };

  const timer = setInterval(tick, intervalMs);
  const onVisible = () => { if (doc.visibilityState === 'visible') tick({ force: true }); };
  if (doc) doc.addEventListener('visibilitychange', onVisible);

  return function stop() {
    stopped = true;
    clearInterval(timer);
    if (doc) doc.removeEventListener('visibilitychange', onVisible);
  };
}
