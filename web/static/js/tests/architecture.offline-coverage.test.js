/**
 * architecture.offline-coverage.test.js
 *
 * Lint guard: every file under `web/static/js/features/*.js` must either
 * use one of the offline-aware read primitives (cachedFetch, loadSWR,
 * hydrateFromDexie, offlineAwareApiCall) OR appear in the ALLOWLIST below
 * with a `reason` string.
 *
 * Intent: prevent the next new section file from silently being non-local-first.
 * Every bottom-nav destination must render last-known data when relaunched
 * offline — the only acceptable opt-out is a file that genuinely does not
 * read API data (pure UI helpers, event-driven indicators, etc.).
 *
 * Adding a new feature file:
 *   - If it reads API data: route the reads through one of the primitives.
 *   - If it doesn't: add an entry to ALLOWLIST with a clear `reason`.
 *
 * See docs/frontend.md → "Local-First Read Resilience".
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const FEATURES_DIR = path.join(REPO_ROOT, 'web/static/js/features');

/**
 * Files that legitimately do not read API data and therefore do not need
 * an offline-aware primitive. Each entry must include a `reason`.
 */
const ALLOWLIST = [
    {
        file: 'auth-flow.js',
        reason: 'auth-cache localStorage helpers only — no API reads',
    },
    {
        file: 'back-button.js',
        reason: 'wires Telegram WebApp BackButton to section navigation — no API reads',
    },
    {
        file: 'bootstrap.js',
        reason: 'post-auth init orchestrator; the only API call is a one-shot POST /api/settings to sync timezone, not a section data read',
    },
    {
        file: 'call-indicator.js',
        reason: 'floating call-state pill subscribed to the wg-call-state window event — no API reads',
    },
    {
        file: 'deeplink-router.js',
        reason: 'pure URL → tab/deeplink routing — no API reads',
    },
    {
        file: 'elevenlabs-call.js',
        reason: 'ElevenLabs call widget; reaches for window.offlineAwareApiCall via aliased variable indirection (not statically detectable) and the request is a transient signed-URL fetch, not a cached section render',
    },
    {
        file: 'food-photo-summary.js',
        reason: 'transient in-app summary card rendered after a photo upload — no API reads, pure DOM construction from a passed-in payload',
    },
    {
        file: 'modal-history.js',
        reason: 'MutationObserver wiring modal show/hide into history.back() — no API reads',
    },
    {
        file: 'today.js',
        reason: 'pure aggregation + render contract; consumes bootstrap + DataStore caches seeded elsewhere, never reads the network directly',
    },
    {
        file: 'tz-plan-banner.js',
        reason: 'transient banner that fetches /api/tz-plan/current as a single-shot; if offline the banner simply does not appear — no cached section state to surface',
    },
];

/**
 * Regex that matches any of the offline-aware read primitives followed by
 * an open paren (allowing whitespace). Matches both bare calls
 * (e.g. `loadSWR(`) and qualified calls (`DataStore.loadSWR(`) since the
 * suffix is the same.
 */
const PRIMITIVE_RE = /(?:cachedFetch|loadSWR|hydrateFromDexie|offlineAwareApiCall)\s*\(/;

function listFeatureFiles() {
    return fs.readdirSync(FEATURES_DIR)
        .filter((name) => name.endsWith('.js') && !name.endsWith('.min.js'))
        .sort();
}

describe('Architecture – offline coverage allowlist', () => {
    it('every features/*.js uses an offline-aware primitive or is allowlisted', () => {
        const allowSet = new Map(ALLOWLIST.map((e) => [e.file, e.reason]));
        const files = listFeatureFiles();
        expect(files.length).toBeGreaterThan(0);

        const offenders = [];
        for (const name of files) {
            if (allowSet.has(name)) continue;
            const source = fs.readFileSync(path.join(FEATURES_DIR, name), 'utf8');
            if (!PRIMITIVE_RE.test(source)) {
                offenders.push(name);
            }
        }

        if (offenders.length > 0) {
            throw new Error(
                'features/*.js files missing an offline-aware read primitive.\n' +
                'Either route reads through cachedFetch / DataStore.loadSWR / DataStore.hydrateFromDexie / offlineAwareApiCall,\n' +
                'or add an entry to ALLOWLIST in architecture.offline-coverage.test.js with a clear reason:\n\n' +
                offenders.map((f) => `  • ${f}`).join('\n')
            );
        }
    });

    it('every ALLOWLIST entry has a non-empty reason', () => {
        for (const entry of ALLOWLIST) {
            expect(entry.file, 'allowlist entry needs a file name').toBeTypeOf('string');
            expect(entry.file.length).toBeGreaterThan(0);
            expect(entry.reason, `allowlist entry for ${entry.file} needs a reason`).toBeTypeOf('string');
            expect(entry.reason.length).toBeGreaterThan(0);
        }
    });

    it('every ALLOWLIST entry points at a real file', () => {
        for (const entry of ALLOWLIST) {
            const full = path.join(FEATURES_DIR, entry.file);
            expect(
                fs.existsSync(full),
                `allowlist entry ${entry.file} does not exist under features/`
            ).toBe(true);
        }
    });

    it('no ALLOWLIST entry is dead — files that adopt a primitive must be removed from the allowlist', () => {
        const stale = [];
        for (const entry of ALLOWLIST) {
            const full = path.join(FEATURES_DIR, entry.file);
            if (!fs.existsSync(full)) continue;
            const source = fs.readFileSync(full, 'utf8');
            if (PRIMITIVE_RE.test(source)) {
                stale.push(entry.file);
            }
        }
        if (stale.length > 0) {
            throw new Error(
                'These files are on the offline-coverage ALLOWLIST but already use an offline-aware primitive.\n' +
                'Remove them from ALLOWLIST in architecture.offline-coverage.test.js:\n\n' +
                stale.map((f) => `  • ${f}`).join('\n')
            );
        }
    });
});
