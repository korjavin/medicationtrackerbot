// Task 3: the remote-connector fetch calls (POST/DELETE/GET /api/mcp/remote)
// that sit on top of mcp-pairing.js's existing connectClaude/disconnectClaude.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../mcp-pairing.js', () => ({
  connectClaude: vi.fn(),
  disconnectClaude: vi.fn(),
}));

import { connectRemote, disconnectRemote, getRemoteStatus } from '../mcp-remote.js';
import { connectClaude, disconnectClaude } from '../mcp-pairing.js';

const ctx = { dek: 'fake-dek' };

beforeEach(() => {
  global.location = { origin: 'https://acct.example.test' };
});

afterEach(() => {
  delete global.fetch;
  delete global.location;
});

describe('getRemoteStatus', () => {
  it('returns the enabled flag from the status endpoint', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ enabled: true }) }));
    await expect(getRemoteStatus()).resolves.toBe(true);
  });

  it('treats a failed request as disabled', async () => {
    global.fetch = vi.fn(async () => ({ ok: false }));
    await expect(getRemoteStatus()).resolves.toBe(false);
  });
});

describe('connectRemote', () => {
  it('mints a pairing, posts the code, and builds the connector URL from the token', async () => {
    connectClaude.mockResolvedValue({ code: 'mtmcp1.fake' });
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ token: 'abc-def' }) }));

    const result = await connectRemote(ctx);

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/mcp/remote',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ pairing_code: 'mtmcp1.fake' }) })
    );
    expect(result).toEqual({ token: 'abc-def', url: 'https://acct.example.test/mcp/abc-def' });
  });

  it('rolls back the freshly-minted pairing if the server-side enable fails', async () => {
    connectClaude.mockResolvedValue({ code: 'mtmcp1.fake' });
    disconnectClaude.mockResolvedValue();
    global.fetch = vi.fn(async () => ({ ok: false }));

    await expect(connectRemote(ctx)).rejects.toThrow(/Could not enable/);
    expect(disconnectClaude).toHaveBeenCalledWith(ctx);
  });

  it('rolls back the freshly-minted pairing if the POST itself rejects (offline)', async () => {
    connectClaude.mockResolvedValue({ code: 'mtmcp1.fake' });
    disconnectClaude.mockResolvedValue();
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });

    await expect(connectRemote(ctx)).rejects.toThrow(/Failed to fetch/);
    expect(disconnectClaude).toHaveBeenCalledWith(ctx);
  });
});

describe('disconnectRemote', () => {
  it('deletes the server-side enablement then drops the underlying pairing', async () => {
    global.fetch = vi.fn(async () => ({ ok: true }));
    disconnectClaude.mockResolvedValue();

    await disconnectRemote(ctx);

    expect(global.fetch).toHaveBeenCalledWith('/api/mcp/remote', { method: 'DELETE' });
    expect(disconnectClaude).toHaveBeenCalledWith(ctx);
  });

  it('throws without touching the pairing if the delete request fails', async () => {
    global.fetch = vi.fn(async () => ({ ok: false }));

    await expect(disconnectRemote(ctx)).rejects.toThrow(/Could not disconnect/);
    expect(disconnectClaude).not.toHaveBeenCalled();
  });
});
