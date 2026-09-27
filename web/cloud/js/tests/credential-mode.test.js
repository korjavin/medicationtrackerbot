// Explicit credential modes + the POC opt-in flag (med-eas.2.1). The flag
// defaults off everywhere: local-only enrollment and unlock must be
// impossible to reach by accident.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CREDENTIAL_MODE_LOCAL_ONLY,
  CREDENTIAL_MODE_PRF,
  LOCAL_ONLY_WARNING_COPY,
  isLocalOnlyPocEnabled,
  isValidCredentialMode,
  normalizeCredentialMode,
} from '../credential-mode.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('credential-mode', () => {
  it('defines exactly the two explicit modes', () => {
    expect(CREDENTIAL_MODE_PRF).toBe('prf');
    expect(CREDENTIAL_MODE_LOCAL_ONLY).toBe('local_only');
    expect(isValidCredentialMode('prf')).toBe(true);
    expect(isValidCredentialMode('local_only')).toBe(true);
    expect(isValidCredentialMode('')).toBe(false);
    expect(isValidCredentialMode('xor-split')).toBe(false);
    expect(isValidCredentialMode('PRF')).toBe(false);
  });

  it('normalizes a missing mode to the prf default', () => {
    expect(normalizeCredentialMode(undefined)).toBe('prf');
    expect(normalizeCredentialMode(null)).toBe('prf');
    expect(normalizeCredentialMode('')).toBe('prf');
    expect(normalizeCredentialMode('local_only')).toBe('local_only');
    expect(normalizeCredentialMode('prf')).toBe('prf');
  });

  it('keeps the warned-consent copy honest about recovery', () => {
    expect(LOCAL_ONLY_WARNING_COPY).toContain('cannot recover');
    expect(LOCAL_ONLY_WARNING_COPY).toContain('Emergency Kit');
    expect(LOCAL_ONLY_WARNING_COPY.toLowerCase()).not.toContain('prf compatible');
  });

  it('is off by default with no location or storage', () => {
    vi.stubGlobal('location', undefined);
    vi.stubGlobal('localStorage', undefined);
    expect(isLocalOnlyPocEnabled()).toBe(false);
  });

  it('opts in via ?local-only-poc=1', () => {
    vi.stubGlobal('location', { search: '?local-only-poc=1' });
    expect(isLocalOnlyPocEnabled()).toBe(true);
  });

  it('stays off for any other query value', () => {
    vi.stubGlobal('location', { search: '?local-only-poc=0' });
    vi.stubGlobal('localStorage', undefined);
    expect(isLocalOnlyPocEnabled()).toBe(false);
  });

  it('persists a query-string opt-in across navigations', () => {
    const store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
    });
    vi.stubGlobal('location', { search: '?local-only-poc=1' });
    expect(isLocalOnlyPocEnabled()).toBe(true);
    // The enrollment redirect dropped the query string — the flag survives.
    vi.stubGlobal('location', { search: '' });
    expect(isLocalOnlyPocEnabled()).toBe(true);
  });

  it('opts in via localStorage', () => {
    vi.stubGlobal('location', { search: '' });
    vi.stubGlobal('localStorage', { getItem: () => '1' });
    expect(isLocalOnlyPocEnabled()).toBe(true);
  });

  it('stays off when storage denies access', () => {
    vi.stubGlobal('location', { search: '' });
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
    });
    expect(isLocalOnlyPocEnabled()).toBe(false);
  });
});
