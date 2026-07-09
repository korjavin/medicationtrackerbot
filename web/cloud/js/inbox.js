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
import { recordsPort } from './sync.js';

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
