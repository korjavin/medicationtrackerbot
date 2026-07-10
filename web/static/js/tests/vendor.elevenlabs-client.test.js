// @vitest-environment jsdom
//
// Contract test for the vendored @elevenlabs/client bundle (bd med-7e7.1).
//
// The SDK used to load from https://esm.sh, which put a third-party script on
// the DEK-bearing cloud origin — the catastrophic case in docs/cloud-crypto.md.
// It is now bundled into web/static/vendor/elevenlabs-client.min.js and loaded
// same-origin, which is what lets both CSPs keep `script-src 'self'`.
//
// A hand-run `esbuild` produced that file, so nothing in CI would notice if a
// re-vendor dropped the one symbol features/elevenlabs-call.js actually reaches
// for (`sdk.Conversation.startSession`) — the failure would surface only when a
// user pressed "Call agent". This pins that surface. Same spirit as
// backup-crypto.test.js over the vendored typage.
import { describe, expect, it } from 'vitest';

const VENDOR_URL = '../../vendor/elevenlabs-client.min.js';

describe('vendored @elevenlabs/client', () => {
    it('exposes the Conversation.startSession surface elevenlabs-call.js uses', async () => {
        const sdk = await import(VENDOR_URL);

        expect(sdk.Conversation).toBeDefined();
        expect(typeof sdk.Conversation.startSession).toBe('function');
    });

    it('is self-contained — no third-party host survives in the bundle', async () => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        const here = path.dirname(fileURLToPath(import.meta.url));
        const src = await fs.readFile(path.join(here, '../../vendor/elevenlabs-client.min.js'), 'utf8');

        // A leftover bare import would silently reintroduce the off-origin fetch
        // that vendoring exists to remove, and CSP would then block it at runtime.
        expect(src).not.toMatch(/from\s*["']https?:\/\//);
        expect(src).not.toMatch(/import\s*\(\s*["']https?:\/\//);
    });
});
