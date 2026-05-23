import { beforeEach, describe, expect, it } from 'vitest';
import { loadDataStoreEnv } from './helpers/data-store-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('DataStore.getClientId', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  it('returns a UUID-shaped string on first call', () => {
    const { window, cleanup } = loadDataStoreEnv();
    try {
      const id = window.DataStore.getClientId();
      expect(typeof id).toBe('string');
      expect(id).toMatch(UUID_RE);
    } finally {
      cleanup();
    }
  });

  it('returns the same id on subsequent calls within the session', () => {
    const { window, cleanup } = loadDataStoreEnv();
    try {
      const first = window.DataStore.getClientId();
      const second = window.DataStore.getClientId();
      const third = window.DataStore.getClientId();
      expect(second).toBe(first);
      expect(third).toBe(first);
    } finally {
      cleanup();
    }
  });

  it('persists the id to localStorage under wg.clientId', () => {
    const { window, cleanup } = loadDataStoreEnv();
    try {
      const id = window.DataStore.getClientId();
      expect(window.localStorage.getItem('wg.clientId')).toBe(id);
    } finally {
      cleanup();
    }
  });

  it('reuses an existing localStorage value across separate environments (simulated reload)', () => {
    const first = loadDataStoreEnv();
    let savedId;
    try {
      savedId = first.window.DataStore.getClientId();
    } finally {
      first.cleanup();
    }

    // Boot a fresh env and pre-seed localStorage with the previous id to
    // simulate a page reload. The new DataStore must reuse the same id
    // instead of minting a new one.
    const second = loadDataStoreEnv();
    try {
      second.window.localStorage.setItem('wg.clientId', savedId);
      const reloadedId = second.window.DataStore.getClientId();
      expect(reloadedId).toBe(savedId);
    } finally {
      second.cleanup();
    }
  });

  it('regenerates and re-persists a new id when localStorage is empty on boot', () => {
    // Mint and persist an id, then simulate a localStorage clear by booting
    // a fresh env (whose localStorage starts empty). The new env must mint a
    // fresh, valid UUID and persist it — i.e. not crash on the missing key.
    const first = loadDataStoreEnv();
    let firstId;
    try {
      firstId = first.window.DataStore.getClientId();
      expect(first.window.localStorage.getItem('wg.clientId')).toBe(firstId);
    } finally {
      first.cleanup();
    }

    const second = loadDataStoreEnv();
    try {
      expect(second.window.localStorage.getItem('wg.clientId')).toBeNull();
      const newId = second.window.DataStore.getClientId();
      expect(newId).toMatch(UUID_RE);
      expect(second.window.localStorage.getItem('wg.clientId')).toBe(newId);
    } finally {
      second.cleanup();
    }
  });
});
