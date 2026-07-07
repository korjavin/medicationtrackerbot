// "Connect Claude" pairing lifecycle (Task 4, docs/cloud-mode.md "MCP" Tier
// 1 PoC). Mints a relay pairing + generates the E2E key client-side, stores
// both in a singleton vault record (`mcppairing`, same "provision once, any
// unlocked device reads it" shape as sync.js's NK record) so any unlocked
// tab can answer via mcp-responder.js, and builds the one-time pairing code
// the user pastes into the shim's MEDTRACKER_MCP_CODE env var. Wire format:
// internal/mcpshim/pairingcode.go.
import { recordsPort } from './sync.js';
import { toBase64, toBase64Url, utf8 } from './crypto.js';
import { refreshResponder, stopResponder } from './mcp-responder.js';

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

  // Start answering immediately: the tab that just minted the pairing is
  // typically the one still open when the shim connects, so it must become the
  // responder now — before this fix the responder only started on the next
  // page load, and the shim's first call timed out to "no device online".
  refreshResponder(ctx);

  const wire = { relay_url: relayUrl, pairing_id: pairingId, key: toBase64(key) };
  const code = `mtmcp1.${toBase64Url(utf8(JSON.stringify(wire)))}`;
  return { code };
}

// Silently drops the vault record and stops the responder without making a
// server network request. Used when the responder detects the server has
// already forgotten the pairing (e.g. after a server redeploy).
export async function purgePairing(ctx) {
  await recordsPort(ctx).del(MCPPAIRING_RECORD_TYPE, MCPPAIRING_RECORD_ID);
  stopResponder();
}

// Revokes the pairing server-side and drops the vault record.
export async function disconnectClaude(ctx) {
  const res = await fetch('/api/mcp/pairings', { method: 'DELETE' });
  if (!res.ok) throw new Error('Could not disconnect. Try again.');
  await recordsPort(ctx).del(MCPPAIRING_RECORD_TYPE, MCPPAIRING_RECORD_ID);
  // Stop this tab's responder so it doesn't loop reconnecting to the now-
  // revoked pairing (the relay 404s it; the WS API can't see that status, so
  // onclose would otherwise reconnect forever).
  stopResponder();
}
