// Tier 2 "hosted-relay convenience mode" (Task 3, docs/cloud-mode.md "MCP"):
// the remote-connector half of the devices page's mode picker. Reuses
// mcp-pairing.js's connectClaude/disconnectClaude verbatim for the
// underlying pairing (vault record + responder) — the only new wire is
// POST/DELETE/GET /api/mcp/remote, which tells the server to run the hosted
// shim client against that same pairing. Server side: internal/cloudserver/
// mcp_remote.go + mcp_endpoint.go ("/mcp/<token>" on the account host).
import { connectClaude, disconnectClaude } from './mcp-pairing.js';

// Reports whether the caller's account currently has Tier 2 enabled, and the
// connector URL when it is — so the connectors page can show it again instead
// of forcing a rotate-to-recover (med-24d).
export async function getRemoteStatus() {
  const res = await fetch('/api/mcp/remote');
  // A non-2xx here is a genuine failure, not "disabled" — the endpoint returns
  // 200 {enabled:false} when off. Collapsing an error to `false` would let the
  // devices page render mode 'local' while Tier 2 is actually enabled, so
  // Disconnect would run client-only cleanup and orphan the server-side
  // enablement (a permanent relay pairing restored on every restart). Fail the
  // load instead, matching loadDevices' handling of /api/devices.
  if (!res.ok) throw new Error('Could not load the remote connector status.');
  const { enabled, token } = await res.json();
  return { enabled: !!enabled, url: token ? remoteURL(token) : '' };
}

function remoteURL(token) {
  return `${location.origin}/mcp/${token}`;
}

// Mints a fresh pairing (same code path as the local shim), hands the code
// to the server so it can run the hosted shim client, and returns the
// connector URL the user pastes into claude.ai/ChatGPT. Rolls the pairing
// back if the server-side enable fails, so a failed enable doesn't leave an
// orphaned vault record answering nothing.
export async function connectRemote(ctx) {
  const { code } = await connectClaude(ctx);
  let res;
  try {
    res = await fetch('/api/mcp/remote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairing_code: code }),
    });
  } catch (err) {
    // Network-level failure (offline/DNS): roll the just-minted pairing back
    // too, else it's orphaned answering nothing.
    await disconnectClaude(ctx);
    throw err;
  }
  if (!res.ok) {
    await disconnectClaude(ctx);
    throw new Error('Could not enable the remote connector. Try again.');
  }
  const { token } = await res.json();
  return { token, url: remoteURL(token) };
}

// Disables Tier 2 server-side and drops the underlying pairing (vault record
// + responder) — the same pairing the remote connector was using, so there
// is nothing left to answer once this resolves.
export async function disconnectRemote(ctx) {
  const res = await fetch('/api/mcp/remote', { method: 'DELETE' });
  if (!res.ok) throw new Error('Could not disconnect. Try again.');
  await disconnectClaude(ctx);
}
