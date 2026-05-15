import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CORE_API_JS = path.join(REPO_ROOT, 'web/static/js/core/api.js');

function loadApiEnv({ initData } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  if (typeof initData !== 'undefined') {
    window.userInitData = initData;
  }
  const source = fs.readFileSync(CORE_API_JS, 'utf8');
  window.eval(`${source}\n//# sourceURL=file://${CORE_API_JS}`);
  return { window, cleanup: () => dom.window.close() };
}

describe('makeAuthHeaders', () => {
  it('returns headers containing X-Telegram-Init-Data when token is present', () => {
    const { window, cleanup } = loadApiEnv({ initData: 'token-abc' });
    try {
      const headers = window.makeAuthHeaders();
      expect(headers).toEqual({ 'X-Telegram-Init-Data': 'token-abc' });
    } finally {
      cleanup();
    }
  });

  it('omits the X-Telegram-Init-Data key when token is absent', () => {
    const { window, cleanup } = loadApiEnv();
    try {
      // window.userInitData not assigned — must be falsy in jsdom.
      expect(window.userInitData).toBeUndefined();
      const headers = window.makeAuthHeaders();
      expect(headers).toEqual({});
      expect('X-Telegram-Init-Data' in headers).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('omits the X-Telegram-Init-Data key when token is the empty string', () => {
    const { window, cleanup } = loadApiEnv({ initData: '' });
    try {
      const headers = window.makeAuthHeaders();
      expect('X-Telegram-Init-Data' in headers).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('merges caller-supplied extras (e.g. Content-Type) alongside the auth header', () => {
    const { window, cleanup } = loadApiEnv({ initData: 'token-xyz' });
    try {
      const headers = window.makeAuthHeaders({ 'Content-Type': 'application/json' });
      expect(headers).toEqual({
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': 'token-xyz',
      });
    } finally {
      cleanup();
    }
  });

  it('returns extras alone when token is absent', () => {
    const { window, cleanup } = loadApiEnv();
    try {
      const headers = window.makeAuthHeaders({ Accept: 'text/csv' });
      expect(headers).toEqual({ Accept: 'text/csv' });
    } finally {
      cleanup();
    }
  });

  it('does not mutate the caller-supplied extras object', () => {
    const { window, cleanup } = loadApiEnv({ initData: 'token-1' });
    try {
      const extras = { 'Content-Type': 'application/json' };
      const snapshot = { ...extras };
      const headers = window.makeAuthHeaders(extras);
      expect(extras).toEqual(snapshot);
      expect(headers).not.toBe(extras);
    } finally {
      cleanup();
    }
  });

  it('returns a fresh object on each call (no shared reference)', () => {
    const { window, cleanup } = loadApiEnv({ initData: 'token-1' });
    try {
      const a = window.makeAuthHeaders();
      const b = window.makeAuthHeaders();
      expect(a).not.toBe(b);
      a['X-Telegram-Init-Data'] = 'mutated';
      expect(b['X-Telegram-Init-Data']).toBe('token-1');
    } finally {
      cleanup();
    }
  });

  it('reads window.userInitData lazily so SW-token updates are reflected on subsequent calls', () => {
    const { window, cleanup } = loadApiEnv({ initData: 'first-token' });
    try {
      const first = window.makeAuthHeaders();
      expect(first['X-Telegram-Init-Data']).toBe('first-token');

      // Simulate the SW pushing a refreshed token after a Telegram re-auth.
      window.userInitData = 'second-token';
      const second = window.makeAuthHeaders();
      expect(second['X-Telegram-Init-Data']).toBe('second-token');

      // And clearing the token should remove the header entirely.
      window.userInitData = '';
      const third = window.makeAuthHeaders();
      expect('X-Telegram-Init-Data' in third).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('apiCallDirect routes its auth header construction through the helper', async () => {
    const { window, cleanup } = loadApiEnv({ initData: 'apidirect-token' });
    try {
      let seenHeaders = null;
      window.fetch = async (_url, opts) => {
        seenHeaders = opts.headers;
        return {
          status: 200,
          ok: true,
          async text() { return JSON.stringify({ ok: true }); },
        };
      };
      await window.apiCallDirect('/api/foo', 'POST', { a: 1 });
      expect(seenHeaders['X-Telegram-Init-Data']).toBe('apidirect-token');
      expect(seenHeaders['Content-Type']).toBe('application/json');
    } finally {
      cleanup();
    }
  });

  it('apiCallDirect on GET (no body) omits Content-Type but keeps the auth header', async () => {
    const { window, cleanup } = loadApiEnv({ initData: 'apidirect-token' });
    try {
      let seenHeaders = null;
      window.fetch = async (_url, opts) => {
        seenHeaders = opts.headers;
        return {
          status: 200,
          ok: true,
          async text() { return JSON.stringify({ ok: true }); },
        };
      };
      await window.apiCallDirect('/api/foo');
      expect(seenHeaders['X-Telegram-Init-Data']).toBe('apidirect-token');
      expect('Content-Type' in seenHeaders).toBe(false);
    } finally {
      cleanup();
    }
  });
});
