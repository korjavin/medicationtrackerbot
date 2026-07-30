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

    // bd med-yor.8. The SDK inlines each AudioWorklet's source and, absent an
    // explicit path, hands it to addModule() as a blob: URL (data: fallback) —
    // which forces the DEK-bearing document's CSP to widen script-src, because
    // no engine ships worklet-src. elevenlabs-call.js passes workletPaths
    // instead, pointing at vendor/worklets/*.js. Those files are extracted
    // verbatim from this bundle, so a re-vendor that changes a processor would
    // otherwise leave the served copy stale — and the SDK does NOT fall back to
    // a blob: when a supplied path loads the wrong thing. On a re-vendor, copy
    // each processor's template literal out of the new bundle into its file.
    it('serves worklet modules byte-identical to the ones the SDK would inline', async () => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        const here = path.dirname(fileURLToPath(import.meta.url));
        const src = await fs.readFile(path.join(here, '../../vendor/elevenlabs-client.min.js'), 'utf8');

        // esbuild emits `<fn>("<name>", `<source>`)`; the sources carry no
        // backslash escapes and no ${} interpolation, so the literal ends at
        // the first backtick (asserted below, so a future bundle that does
        // escape something fails loudly rather than silently truncating).
        function inlinedWorklet(name) {
            const marker = `("${name}",\``;
            const start = src.indexOf(marker);
            expect(start, `bundle no longer inlines ${name}`).toBeGreaterThan(-1);
            const from = start + marker.length;
            const end = src.indexOf('`', from);
            const body = src.slice(from, end);
            expect(body).not.toContain('\\');
            expect(body).not.toContain('${');
            return body;
        }

        for (const [name, file] of [
            ['rawAudioProcessor', 'raw-audio-processor.js'],
            ['audioConcatProcessor', 'audio-concat-processor.js'],
        ]) {
            const served = await fs.readFile(path.join(here, '../../vendor/worklets/', file), 'utf8');
            expect(served, `${file} drifted from the bundle's ${name}`).toBe(inlinedWorklet(name));
        }
    });
});
