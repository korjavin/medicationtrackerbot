// Passkey ceremony log, app shells only (Android bd med-nt9p.22, docs/android.md;
// iOS bd med-w6gx.24, docs/ios.md).
//
// Every create/get in the cloud shells and the server begin/finish statuses
// are posted to the shell (`diag.append`, no reply), which redacts the hosts
// and keeps the last ~200 entries for "Copy diagnostics". Outside the shells
// (the web) every function here returns before doing anything.
//
// Never logged: credential IDs (only a 3-byte SHA-256 tag), user handles,
// PRF output (only its length), challenges, tokens, URL fragments or queries.

import { inAndroidShell, iosShellBridge } from './passkey-get.js';

let t0 = Date.now();

const inShell = () => !!iosShellBridge() || inAndroidShell();

function post(fields) {
  try {
    const entry = { ms: Date.now() - t0, path: globalThis.location?.pathname, ...fields };
    const msg = { op: 'diag.append', args: { entry: JSON.stringify(entry) } };
    const ios = iosShellBridge();
    // iOS: {op, args} like native/index.js; its reply promise is not awaited.
    if (ios) Promise.resolve(ios.postMessage(msg)).catch(() => {});
    else window.wgNative.postMessage(JSON.stringify(msg));
  } catch {
    // Diagnostics must never break a ceremony.
  }
}

// One free-text line from another subsystem (the Health import's per-run
// counts, bd med-w6gx.30) into the same log. Callers pass counts only.
export function diagLine(line) {
  if (inShell()) post({ op: 'log', line });
}

// A server ceremony step's HTTP status; returns res unchanged. A begin (or the
// account-delete reauth) starts the ceremony clock.
export function diagHttp(step, res) {
  if (!inShell()) return res;
  if (/begin|reauth/.test(step)) t0 = Date.now();
  post({ op: 'http', step, status: res && res.status });
  return res;
}

// Runs one navigator.credentials call and logs its options and outcome.
// `publicKey` is the caller's request (before the shell's allowCredentials: []).
export async function diagCeremony(op, publicKey, attempt, run) {
  if (!inShell()) return run();
  const sel = publicKey.authenticatorSelection || {};
  const allow = publicKey.allowCredentials || [];
  const fields = {
    op,
    attempt,
    rp: op === 'create' ? publicKey.rp && publicKey.rp.id : publicKey.rpId,
    allow: allow.length,
    uv: publicKey.userVerification || sel.userVerification,
    rk: sel.residentKey,
    att: sel.authenticatorAttachment,
    prf: !!(publicKey.extensions && publicKey.extensions.prf),
  };
  const start = Date.now();
  try {
    const cred = await run();
    outcome(fields, start, cred, allow).catch(() => {});
    return cred;
  } catch (e) {
    post({ ...fields, took: Date.now() - start, error: e && e.name, message: e && e.message });
    throw e;
  }
}

async function outcome(fields, start, cred, allow) {
  const took = Date.now() - start;
  const id = cred && cred.rawId ? new Uint8Array(cred.rawId) : null;
  const prf = cred && cred.getClientExtensionResults ? cred.getClientExtensionResults().prf : undefined;
  const first = prf && prf.results && prf.results.first;
  post({
    ...fields,
    took,
    result: 'ok',
    id: id ? await tag(id) : null,
    // Whether the asserted credential is in the caller's allowlist (for the
    // post-create probe: the passkey just created).
    match: allow.length ? allow.some((c) => same(c.id, id)) : undefined,
    prfEnabled: prf ? prf.enabled : undefined,
    prfLen: first ? first.byteLength : 0,
  });
}

async function tag(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d.slice(0, 3), (b) => b.toString(16).padStart(2, '0')).join('');
}

function same(a, b) {
  if (!a || !b) return false;
  const x = ArrayBuffer.isView(a) ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}
