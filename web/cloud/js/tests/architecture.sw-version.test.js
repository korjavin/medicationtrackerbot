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

    // med-deq.1 added an offline app-shell fetch handler. The original bug was
    // a precache list with no fetch handler serving it — so the invariant is
    // now the inverse pairing: a cache exists only alongside the fetch handler
    // that serves it, and its name is keyed on the deploy-stamped SW_VERSION.
    it('pairs the cache with a fetch handler and versions it per deploy', () => {
        expect(SW).not.toContain('PRECACHE_URLS');
        expect(SW).toMatch(/addEventListener\(\s*['"]fetch['"]/);
        expect(SW).toContain('${CACHE_PREFIX}-shell-${SW_VERSION}');
    });
});
