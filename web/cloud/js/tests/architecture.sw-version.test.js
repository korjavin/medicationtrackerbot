// bd med-jb7.2 — the cloud service worker's cache name was a hardcoded literal
// ('medtracker-cloud-v1'), so the file was byte-identical across deploys and the
// browser's byte-diff update check never fired: an installed cloud SW, push
// handler and all, could never be updated. The fix is a CI-rewritten placeholder,
// mirroring web/static/sw.js. This test fails if anyone hardcodes it again, or
// removes the sed step that stamps it.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SW = fs.readFileSync(path.join(REPO_ROOT, 'web/cloud/sw.js'), 'utf8');
const DEPLOY = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8');

describe('cloud service worker versioning', () => {
    it('carries the CI-rewritten placeholder, not a hardcoded version', () => {
        expect(SW).toContain('CACHE_VERSION_PLACEHOLDER');
        expect(SW).not.toMatch(/medtracker-cloud-v\d/);
    });

    it('is stamped by the deploy workflow, alongside the static SW', () => {
        const sed = DEPLOY.split('\n').find((l) => l.includes('CACHE_VERSION_PLACEHOLDER') && l.includes('sed'));
        expect(sed, 'no sed step rewrites CACHE_VERSION_PLACEHOLDER').toBeDefined();
        expect(sed).toContain('web/cloud/sw.js');
    });

    // Push-only: no fetch handler means no cache to precache into. If a fetch
    // handler is ever added, this test should be updated together with it —
    // a precache list without a fetch handler is dead weight (that was the bug).
    it('declares no cache it never serves from', () => {
        expect(SW).not.toContain('PRECACHE_URLS');
        expect(SW).not.toMatch(/addEventListener\(\s*['"]fetch['"]/);
        expect(SW).not.toContain('caches.open');
    });
});
