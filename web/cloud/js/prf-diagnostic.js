// PRF capability diagnostic harness (med-eas.2.1 POC). Answers one question
// per authenticator — "can this credential evaluate PRF right now?" — by
// running the enrollment-grade probe from
// docs/2026-07-13-cloud-prf-compatibility-research.md (create with the prf
// extension, then an immediate assertion with a prf eval), and recording ONLY
// capability outcomes.
//
// What is recorded: stage outcomes, boolean flags, the PRF result's LENGTH,
// and a coarse error class. What is NEVER recorded, retained, or transmitted:
// PRF bytes, credential IDs, attestation, or user handles. Every secret-
// adjacent value is used transiently inside the probe and dropped; the
// outcome object is safe to download, paste into a support thread, or keep
// for the lab matrix.
import { saltKek } from './crypto.js';

export const EXPECTED_PRF_BYTES = 32;

// classifyPrfError reduces a WebAuthn failure to a coarse, non-identifying
// class. The raw message is deliberately discarded: DOMException messages can
// embed RP IDs, relay URLs, or authenticator labels.
export function classifyPrfError(err) {
  const name = err && typeof err.name === 'string' ? err.name : '';
  switch (name) {
    case 'NotSupportedError':
      return 'not-supported';
    case 'NotAllowedError':
      return 'not-allowed';
    case 'InvalidStateError':
      return 'invalid-state';
    case 'TimeoutError':
      return 'timeout';
    case 'SecurityError':
      return 'security';
    case 'AbortError':
      return 'aborted';
    default:
      return 'unknown';
  }
}

// clientPrfHint reads the static client capability enumeration, if the
// browser exposes it. A "yes" here is an explanatory hint only — it never
// proves the SELECTED authenticator can evaluate PRF (research doc:
// "probe the credential, not the brand").
export async function clientPrfHint() {
  try {
    if (
      typeof PublicKeyCredential !== 'undefined' &&
      typeof PublicKeyCredential.getClientCapabilities === 'function'
    ) {
      const caps = await PublicKeyCredential.getClientCapabilities();
      if (caps && typeof caps === 'object' && 'extension:prf' in caps) {
        return caps['extension:prf'] ? 'yes' : 'no';
      }
    }
  } catch {
    // Capability enumeration itself failing carries no signal.
  }
  return 'unknown';
}

// probePrfResult runs the immediate-assertion half of the probe against one
// already-created credential and reports whether a 32-byte PRF result came
// back. credentialId is used transiently to scope the assertion and never
// leaves this function; the PRF output's length is recorded but its bytes
// are dropped on the floor (the local binding is cleared before returning so
// a retained outcome can never resurrect them).
export async function probePrfResult(credentialId, { getFn } = {}) {
  const get = getFn || ((opts) => navigator.credentials.get(opts));
  const salt = await saltKek();
  let prfOutput = null;
  try {
    const assertion = await get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: credentialId }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: salt } } },
      },
    });
    prfOutput =
      assertion && typeof assertion.getClientExtensionResults === 'function'
        ? assertion.getClientExtensionResults().prf?.results?.first || null
        : null;
  } catch (err) {
    return { assertOk: false, prfPresent: false, prfLen: null, errorClass: classifyPrfError(err) };
  }
  // Length only. A present-but-wrong-size result is as unusable as an
  // absent one (the KEK derivation needs exactly 32 bytes), so both map
  // to prfPresent: false — the harness must never bless a short output.
  const prfLen = prfOutput ? prfOutput.byteLength ?? null : null;
  const prfPresent = prfLen === EXPECTED_PRF_BYTES;
  prfOutput = null;
  return { assertOk: true, prfPresent, prfLen, errorClass: null };
}

// runEnrollmentDiagnostic runs the full create-plus-immediate-get harness the
// research doc's acceptance tests require. createArgs is passed straight to
// navigator.credentials.create (the caller supplies creation options from a
// real register/begin or a lab fixture); injection points exist so tests can
// drive every outcome without an authenticator. The returned outcome carries
// no secret material — see the module comment.
export async function runEnrollmentDiagnostic(createArgs, { createFn, getFn } = {}) {
  const create = createFn || ((opts) => navigator.credentials.create(opts));
  const hint = await clientPrfHint();
  let credential = null;
  try {
    credential = await create(createArgs);
  } catch (err) {
    return {
      createOk: false,
      createPrfEnabled: null,
      assertOk: false,
      prfPresent: false,
      prfLen: null,
      errorStage: 'create',
      errorClass: classifyPrfError(err),
      clientPrfHint: hint,
    };
  }
  // create()'s own "enabled" flag is recorded for the lab matrix, but the
  // verdict always comes from the assertion below — "enabled" without an
  // output is the exact shape that must not enroll (registration caveat).
  let createPrfEnabled = null;
  try {
    const ext = credential.getClientExtensionResults().prf;
    createPrfEnabled = ext ? ext.enabled === true : false;
  } catch {
    createPrfEnabled = null;
  }
  const probe = await probePrfResult(credential.rawId, { getFn });
  credential = null;
  return {
    createOk: true,
    createPrfEnabled,
    assertOk: probe.assertOk,
    prfPresent: probe.prfPresent,
    prfLen: probe.prfLen,
    errorStage: probe.errorClass ? 'assert' : null,
    errorClass: probe.errorClass,
    clientPrfHint: hint,
  };
}

// buildDiagnosticReport wraps a harness outcome in a sanitized, downloadable
// self-test report: browser/OS labels, a timestamp, and the outcome. It
// re-verifies the outcome carries no secret-shaped fields before returning,
// so a future caller cannot smuggle PRF bytes or credential IDs into a file
// the user is invited to share.
export function buildDiagnosticReport(outcome) {
  const {
    createOk,
    createPrfEnabled,
    assertOk,
    prfPresent,
    prfLen,
    errorStage,
    errorClass,
    clientPrfHint,
  } = outcome || {};
  const report = {
    app: 'medtracker-cloud-prf-diagnostic',
    v: 1,
    ts: new Date().toISOString(),
    browser: browserLabel(),
    os: osLabel(),
    createOk: createOk === true,
    createPrfEnabled: createPrfEnabled === true ? true : createPrfEnabled === false ? false : null,
    assertOk: assertOk === true,
    prfPresent: prfPresent === true,
    prfLen: typeof prfLen === 'number' ? prfLen : null,
    errorStage: typeof errorStage === 'string' ? errorStage : null,
    errorClass: typeof errorClass === 'string' ? errorClass : null,
    clientPrfHint: typeof clientPrfHint === 'string' ? clientPrfHint : 'unknown',
  };
  assertReportSanitized(report);
  return report;
}

// assertReportSanitized fails closed: any secret-shaped value (a byte buffer,
// a base64/blob-looking string beyond the known enums) rejects the report
// rather than leaking it into a downloadable file.
export function assertReportSanitized(report) {
  const fail = (field) => {
    throw new Error(`diagnostic report field ${field} looks like secret material — refusing to export`);
  };
  for (const [field, value] of Object.entries(report)) {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) fail(field);
    if (typeof value !== 'string') continue;
    if (['app', 'ts', 'browser', 'os', 'errorStage', 'errorClass', 'clientPrfHint'].includes(field)) {
      // Free-text-ish fields stay short and printable; anything longer is
      // not a label, it is a payload.
      if (value.length > 128 || /[^ -~]/.test(value)) fail(field);
      continue;
    }
    fail(field);
  }
}

export function downloadDiagnosticReport(report, { document: doc, url = URL } = {}) {
  const target = doc || (typeof document !== 'undefined' ? document : null);
  if (!target) throw new Error('no document to download from');
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const objectUrl = url.createObjectURL(blob);
  const a = target.createElement('a');
  a.href = objectUrl;
  a.download = `prf-diagnostic-${report.ts.replace(/[:.]/g, '-')}.json`;
  target.body.appendChild(a);
  a.click();
  a.remove();
  url.revokeObjectURL(objectUrl);
}

function browserLabel() {
  try {
    const ua = typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : '';
    if (!ua) return 'unknown';
    // Coarse family only — the full UA string can carry build IDs and
    // device tokens the lab matrix does not need.
    if (/Edg\//.test(ua)) return 'edge';
    if (/OPR\//.test(ua)) return 'opera';
    if (/Chrome\//.test(ua)) return 'chrome';
    if (/Firefox\//.test(ua)) return 'firefox';
    if (/Safari\//.test(ua)) return 'safari';
    return 'other';
  } catch {
    return 'unknown';
  }
}

function osLabel() {
  try {
    const platform =
      typeof navigator !== 'undefined'
        ? String(navigator.userAgentData?.platform || navigator.platform || '')
        : '';
    if (/mac/i.test(platform)) return 'macos';
    if (/win/i.test(platform)) return 'windows';
    if (/android/i.test(platform)) return 'android';
    if (/iphone|ipad|ios/i.test(platform)) return 'ios';
    if (/linux/i.test(platform)) return 'linux';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
