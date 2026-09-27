// PRF diagnostic harness (med-eas.2.1). Every test pins the same invariant
// two ways: the harness reports create-plus-immediate-get outcomes
// faithfully, and the outcome/report carries no secret material — no PRF
// bytes, no credential IDs, no attestation, no raw error text.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertReportSanitized,
  buildDiagnosticReport,
  classifyPrfError,
  clientPrfHint,
  downloadDiagnosticReport,
  probePrfResult,
  runEnrollmentDiagnostic,
} from '../prf-diagnostic.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function prfAssertion(byteLength) {
  // Marker-filled output: if any byte of this ever lands in an outcome or
  // report, the JSON scan below catches it.
  const bytes = new Uint8Array(byteLength).fill(0xab);
  return {
    getClientExtensionResults: () => ({ prf: { results: { first: bytes.buffer } } }),
  };
}

function outcomeLeaksSecrets(value) {
  const json = JSON.stringify(value);
  // 0xab repeated never appears in a sanitized outcome; neither does any
  // rawId-shaped field.
  return (
    json.includes('rawId') ||
    json.includes('credential') ||
    json.includes('attestation') ||
    /ab{8,}/.test(json)
  );
}

describe('classifyPrfError', () => {
  it('maps DOMException names to coarse classes and drops messages', () => {
    expect(classifyPrfError({ name: 'NotSupportedError', message: 'rp.example.test rejected' })).toBe('not-supported');
    expect(classifyPrfError({ name: 'NotAllowedError' })).toBe('not-allowed');
    expect(classifyPrfError({ name: 'InvalidStateError' })).toBe('invalid-state');
    expect(classifyPrfError({ name: 'TimeoutError' })).toBe('timeout');
    expect(classifyPrfError({ name: 'SecurityError' })).toBe('security');
    expect(classifyPrfError({ name: 'AbortError' })).toBe('aborted');
    expect(classifyPrfError({ name: '', message: 'credential-id hunter2' })).toBe('unknown');
    expect(classifyPrfError(null)).toBe('unknown');
  });
});

describe('clientPrfHint', () => {
  it('reads extension:prf when exposed, unknown otherwise', async () => {
    vi.stubGlobal('PublicKeyCredential', {
      getClientCapabilities: async () => ({ 'extension:prf': true }),
    });
    expect(await clientPrfHint()).toBe('yes');
    vi.stubGlobal('PublicKeyCredential', {
      getClientCapabilities: async () => ({ 'extension:prf': false }),
    });
    expect(await clientPrfHint()).toBe('no');
    vi.stubGlobal('PublicKeyCredential', undefined);
    expect(await clientPrfHint()).toBe('unknown');
  });
});

describe('probePrfResult', () => {
  const CRED_ID = new Uint8Array(32).fill(0xcd);

  it('reports a 32-byte result as present without retaining it', async () => {
    const out = await probePrfResult(CRED_ID, { getFn: async () => prfAssertion(32) });
    expect(out).toEqual({ assertOk: true, prfPresent: true, prfLen: 32, errorClass: null });
    expect(outcomeLeaksSecrets(out)).toBe(false);
  });

  it('rejects a short result as unusable', async () => {
    const out = await probePrfResult(CRED_ID, { getFn: async () => prfAssertion(16) });
    expect(out).toEqual({ assertOk: true, prfPresent: false, prfLen: 16, errorClass: null });
    expect(outcomeLeaksSecrets(out)).toBe(false);
  });

  it('reports a missing prf extension as absent', async () => {
    const out = await probePrfResult(CRED_ID, {
      getFn: async () => ({ getClientExtensionResults: () => ({}) }),
    });
    expect(out).toEqual({ assertOk: true, prfPresent: false, prfLen: null, errorClass: null });
  });

  it('classifies assertion failures without their messages', async () => {
    const err = new Error('relay https://bitwarden.example/auth failed');
    err.name = 'NotAllowedError';
    const out = await probePrfResult(CRED_ID, {
      getFn: async () => {
        throw err;
      },
    });
    expect(out).toEqual({ assertOk: false, prfPresent: false, prfLen: null, errorClass: 'not-allowed' });
    expect(outcomeLeaksSecrets(out)).toBe(false);
  });
});

describe('runEnrollmentDiagnostic', () => {
  function fakeCredential() {
    return {
      rawId: new Uint8Array(32).fill(0xef).buffer,
      getClientExtensionResults: () => ({ prf: { enabled: true } }),
    };
  }

  it('proves create plus immediate get end to end', async () => {
    const out = await runEnrollmentDiagnostic(
      { publicKey: {} },
      { createFn: async () => fakeCredential(), getFn: async () => prfAssertion(32) }
    );
    expect(out.createOk).toBe(true);
    expect(out.createPrfEnabled).toBe(true);
    expect(out.assertOk).toBe(true);
    expect(out.prfPresent).toBe(true);
    expect(out.prfLen).toBe(32);
    expect(out.errorStage).toBeNull();
    expect(outcomeLeaksSecrets(out)).toBe(false);
  });

  it('pins the registration caveat: enabled at create without an output must not pass', async () => {
    const out = await runEnrollmentDiagnostic(
      { publicKey: {} },
      {
        createFn: async () => fakeCredential(),
        getFn: async () => ({ getClientExtensionResults: () => ({}) }),
      }
    );
    expect(out.createOk).toBe(true);
    expect(out.createPrfEnabled).toBe(true);
    expect(out.prfPresent).toBe(false);
    expect(outcomeLeaksSecrets(out)).toBe(false);
  });

  it('reports create-stage failures with their stage', async () => {
    const err = new Error('nope');
    err.name = 'NotSupportedError';
    const out = await runEnrollmentDiagnostic(
      { publicKey: {} },
      {
        createFn: async () => {
          throw err;
        },
      }
    );
    expect(out.createOk).toBe(false);
    expect(out.errorStage).toBe('create');
    expect(out.errorClass).toBe('not-supported');
  });
});

describe('buildDiagnosticReport', () => {
  it('exports labels and outcome only', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh) Chrome/126.0 hunter2-build-id',
      platform: 'MacIntel',
    });
    const report = buildDiagnosticReport({
      createOk: true,
      createPrfEnabled: true,
      assertOk: true,
      prfPresent: false,
      prfLen: null,
      errorStage: 'assert',
      errorClass: 'not-allowed',
      clientPrfHint: 'yes',
    });
    expect(report.browser).toBe('chrome');
    expect(report.os).toBe('macos');
    expect(report.prfPresent).toBe(false);
    expect(outcomeLeaksSecrets(report)).toBe(false);
    // The coarse labels must not smuggle the raw UA/build tokens through.
    expect(JSON.stringify(report)).not.toContain('hunter2');
  });

  it('fails closed on secret-shaped fields', () => {
    expect(() =>
      assertReportSanitized({ app: 'x', prf: new Uint8Array([1, 2, 3]) })
    ).toThrow(/refusing to export/);
    expect(() => assertReportSanitized({ app: 'x'.repeat(200) })).toThrow(/refusing to export/);
    expect(() => assertReportSanitized({ app: 'ok', extra: 'some free text' })).toThrow(/refusing to export/);
  });

  it('downloads the report as JSON', async () => {
    const clicked = [];
    const fakeDoc = {
      createElement: () => ({ click: () => clicked.push(true), remove: () => {} }),
      body: { appendChild: () => {} },
    };
    let blobText = '';
    const fakeURL = {
      createObjectURL: (blob) => {
        blob.text().then((t) => {
          blobText = t;
        });
        return 'blob:fake';
      },
      revokeObjectURL: () => {},
    };
    const report = { ts: '2026-01-01T00:00:00.000Z', prfPresent: true };
    downloadDiagnosticReport(report, { document: fakeDoc, url: fakeURL });
    await vi.waitFor(() => expect(blobText).toContain('prfPresent'));
    expect(clicked).toHaveLength(1);
  });
});
