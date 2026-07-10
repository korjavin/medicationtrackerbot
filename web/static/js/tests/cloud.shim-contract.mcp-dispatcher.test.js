// Plan 2026-07-06 cloud-voice, Task 2 — the in-tab MCP dispatcher
// (createDispatcher from web/cloud/js/mcp-responder.js) published as
// window.CloudMCPDispatcher by apishim.js over the same bp/weight/notes
// domain instances the shim serves. This is the seam the voice clientTools
// (Task 3) dispatch into directly — no relay/crypto — so the contract is:
// handle('mcp_call', {op}) returns wire-shaped domain JSON, handle('mcp_help')
// returns the catalog + usage protocol.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';

describe('cloud shim contract — in-tab MCP dispatcher (window.CloudMCPDispatcher)', () => {
    let env;

    beforeEach(() => {
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                bp: [
                    { recordId: 'bp-1', clientTs: 2, deleted: false, measured_at: '2026-07-05T08:00:00.000Z', systolic: 120, diastolic: 80 },
                    { recordId: 'bp-2', clientTs: 1, deleted: false, measured_at: '2026-07-04T08:00:00.000Z', systolic: 130, diastolic: 85 },
                ],
            },
        });
        env.window.__MEDTRACKER_CLOUD__ = true;
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('mcp_call bp.list returns the vault readings over the in-memory records port', async () => {
        const result = await env.window.CloudMCPDispatcher.handle('mcp_call', { op: 'health.bp.list', params: {} });
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(2);
        // Newest first — same wire shape the /api/bp GET route returns.
        expect(result[0].systolic).toBe(120);
        expect(result[0].diastolic).toBe(80);
    });

    it('mcp_help returns the catalog + usage_protocol', async () => {
        const help = await env.window.CloudMCPDispatcher.handle('mcp_help', {});
        expect(Array.isArray(help.compact_operations)).toBe(true);
        expect(help.compact_operations.map((op) => op.id)).toContain('health.bp.list');
        expect(typeof help.usage_protocol).toBe('string');
        expect(help.usage_protocol.length).toBeGreaterThan(0);
    });

    it('unknown op throws a did-you-mean error (never dispatches a bogus result)', async () => {
        await expect(env.window.CloudMCPDispatcher.handle('mcp_call', { op: 'health.bp.lst', params: {} }))
            .rejects.toThrow(/unknown operation.*did you mean.*health\.bp\.list/i);
    });
});
