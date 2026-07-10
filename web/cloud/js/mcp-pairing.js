// "Connect Claude" pairing lifecycle (Task 4, docs/cloud-mode.md "MCP" Tier
// 1 PoC). Mints a relay pairing + generates the E2E key client-side, stores
// both in a singleton vault record (`mcppairing`, same "provision once, any
// unlocked device reads it" shape as sync.js's NK record) so any unlocked
// tab can answer via mcp-responder.js, and builds the one-time pairing code
// the user pastes into the shim's MEDTRACKER_MCP_CODE env var. Wire format:
// internal/mcpshim/pairingcode.go.
import { recordsPort } from './sync.js';
import { toBase64, toBase64Url, utf8 } from './crypto.js';
import { refreshResponder, stopResponder, clearNonceRing } from './mcp-responder.js';

export const MCPPAIRING_RECORD_TYPE = 'mcppairing';
export const MCPPAIRING_RECORD_ID = 'mcppairing';

function relayOrigin() {
  return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host;
}

// Reads the account's current pairing (if any) from the vault. Any unlocked
// device sees the same record, so this is also what cloud-boot.js consults
// to decide whether to start the responder.
export async function getPairing(ctx) {
  const records = await recordsPort(ctx).list(MCPPAIRING_RECORD_TYPE);
  return records.find((r) => r.recordId === MCPPAIRING_RECORD_ID) || null;
}

// Mints a relay pairing, generates the pairing key client-side (the relay
// never sees it), stores both in the vault, and returns the one-time code
// to paste into MEDTRACKER_MCP_CODE.
export async function connectClaude(ctx) {
  // Read the pairing this one replaces before overwriting the singleton
  // record: its nonce ring is keyed by pairing_id, so re-connecting without
  // disconnecting first would orphan one ring per old pairing in IndexedDB.
  const previous = await getPairing(ctx);

  const res = await fetch('/api/mcp/pairings', { method: 'POST' });
  if (!res.ok) throw new Error('Could not create a pairing. Try again.');
  const { pairing_id: pairingId } = await res.json();

  const key = crypto.getRandomValues(new Uint8Array(32));
  const relayUrl = relayOrigin();
  await recordsPort(ctx).put(MCPPAIRING_RECORD_TYPE, {
    recordId: MCPPAIRING_RECORD_ID,
    clientTs: Date.now(),
    deleted: false,
    pairingId,
    relayUrl,
    key: toBase64(key),
  });
  if (previous && previous.pairingId && previous.pairingId !== pairingId) {
    await clearNonceRing(previous.pairingId);
  }

  // Start answering immediately: the tab that just minted the pairing is
  // typically the one still open when the shim connects, so it must become the
  // responder now — before this fix the responder only started on the next
  // page load, and the shim's first call timed out to "no device online".
  refreshResponder(ctx);

  const wire = { relay_url: relayUrl, pairing_id: pairingId, key: toBase64(key) };
  const code = `mtmcp1.${toBase64Url(utf8(JSON.stringify(wire)))}`;
  return { code };
}

// Drops the vault record, the pairing's local anti-replay nonce ring, and this
// tab's responder. Reads the pairing first: the ring is keyed by pairing_id,
// which is only recoverable from the record we are about to delete.
async function forgetPairing(ctx) {
  const pairing = await getPairing(ctx);
  await recordsPort(ctx).del(MCPPAIRING_RECORD_TYPE, MCPPAIRING_RECORD_ID);
  if (pairing) await clearNonceRing(pairing.pairingId);
  // Stop this tab's responder so it doesn't loop reconnecting to a pairing
  // that is now revoked or already forgotten by the relay.
  stopResponder();
}

// Revokes the pairing server-side and drops the vault record.
export async function disconnectClaude(ctx) {
  const res = await fetch('/api/mcp/pairings', { method: 'DELETE' });
  if (!res.ok) throw new Error('Could not disconnect. Try again.');
  await forgetPairing(ctx);
}

// Drops the vault record for a pairing the relay has already forgotten — its
// table is in-memory (lost on redeploy) and entries expire after 24h, while
// the vault record has no TTL and syncs across devices. Unlike
// disconnectClaude this makes NO request: there is nothing left to revoke,
// and DELETE /api/mcp/pairings would also run the tier-2 teardown path.
export async function purgePairing(ctx) {
  await forgetPairing(ctx);
}
