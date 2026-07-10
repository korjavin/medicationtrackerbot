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
import { recordsPort, flushConfirmed } from './sync.js';

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

// listInboxEvents returns the pending sealed events, oldest first, each already
// opened into its plaintext object. `createdAtUnix` comes from the sealed
// payload — never from the clear-text column, which the server could lie about.
// An event that fails to open is surfaced, not skipped: silently dropping it
// would lose a Confirm the user actually tapped.
export async function listInboxEvents(ctx, privateKey, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl('/api/inbox');
  if (!res.ok) throw new Error(`could not read the inbox (${res.status})`);
  const { events = [] } = await res.json();

  const out = [];
  for (const e of events) {
    const plaintext = await openInboxEvent(privateKey, ctx.accountId, fromBase64(e.ct));
    out.push({ id: e.id, event: JSON.parse(new TextDecoder().decode(plaintext)) });
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
// is retried next drain) and continue. Returns a small report for tests/logs.
export async function drainInbox(ctx, { apply, records, fetchImpl = fetch, flush = flushConfirmed } = {}) {
  const key = (ctx && ctx.accountId) || ctx;
  if (draining.has(key)) return { applied: 0, failed: 0, skipped: true };
  draining.add(key);
  try {
    const privateKey = await readInboxKey(ctx, { records });
    if (!privateKey) return { applied: 0, failed: 0 };

    const pending = await listInboxEvents(ctx, privateKey, { fetchImpl });
    if (pending.length === 0) return { applied: 0, failed: 0 };

    // Rule 4. Ties (same second) fall back to arrival order.
    pending.sort((a, b) => (a.event.at_unix - b.event.at_unix) || (a.id - b.id));

    let applied = 0;
    let failed = 0;
    for (const { id, event } of pending) {
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
          continue;
        }
        await ackInboxEvent(id, { fetchImpl });
        applied++;
      } catch (e) {
        failed++;
        console.error('[inbox] event failed, leaving it queued', id, e);
      }
    }
    return { applied, failed };
  } finally {
    draining.delete(key);
  }
}

// How often a VISIBLE tab checks the mailbox. The relay answers a Telegram
// command with "⏳ Queued" and only an unlocked client can turn that into
// "✅ Recorded", so this interval is the latency the user actually feels.
//
// ponytail: a poll, not a push. The alternative — a silent web push waking the
// service worker to nudge a drain — is lower-latency and lower-traffic, but it
// needs notification permission, and browsers penalize pushes that show no
// notification. GET /api/inbox on an empty mailbox is one indexed lookup
// returning `{"events":[]}`. Revisit if the mailbox ever gets chatty.
const INBOX_POLL_MS = 5000;

// startInboxPolling drains the mailbox on a timer while the tab is visible, and
// immediately whenever it becomes visible again. Without it a Confirm tapped in
// Telegram sits unapplied until the next full page load, because nothing else
// in cloud mode polls (no SSE, no change stream).
//
// Hidden tabs do not poll: a backgrounded phone browser draining every 5s is
// pure battery burn, and the drain-on-becoming-visible below covers the gap.
// Returns a stop() for tests and teardown.
export function startInboxPolling(ctx, {
  apply,
  intervalMs = INBOX_POLL_MS,
  doc = typeof document === 'undefined' ? null : document,
  onApplied = () => {},
  ...drainOpts
} = {}) {
  let stopped = false;

  const tick = async () => {
    if (stopped || !apply) return;
    // drainInbox already no-ops when another drain is in flight for this
    // account, so a slow drain cannot pile up behind the timer.
    if (doc && doc.visibilityState !== 'visible') return;
    try {
      const result = await drainInbox(ctx, { apply, ...drainOpts });
      if (result && result.applied > 0) onApplied(result);
    } catch (e) {
      console.error('[inbox] poll drain failed', e);
    }
  };

  const timer = setInterval(tick, intervalMs);
  const onVisible = () => { if (doc.visibilityState === 'visible') tick(); };
  if (doc) doc.addEventListener('visibilitychange', onVisible);

  return function stop() {
    stopped = true;
    clearInterval(timer);
    if (doc) doc.removeEventListener('visibilitychange', onVisible);
  };
}
