// Tests for the WGStaleBadge component (Task 4 of the local-first
// read-resilience plan). The badge is rendered into section headers by
// feature modules and consumes the {fetchedAt, isOffline, staleAfterMs}
// triple produced by cachedFetch. Tone selection is deterministic and
// driven exclusively by CSS classes — no inline colours.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const WG_STALE_BADGE_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-stale-badge.js');

function loadEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only',
    });
    dom.window.eval(fs.readFileSync(WG_STALE_BADGE_JS, 'utf8'));
    return {
        window: dom.window,
        api: dom.window.WGStaleBadge,
        cleanup: () => dom.window.close(),
    };
}

const NOW = Date.UTC(2026, 4, 9, 12, 0, 0); // 2026-05-09T12:00:00Z, fixed clock for determinism
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

describe('WGStaleBadge.render', () => {
    let env;
    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env.cleanup(); });

    it('exposes WGStaleBadge on window with render + formatLabel', () => {
        expect(typeof env.api).toBe('object');
        expect(typeof env.api.render).toBe('function');
        expect(typeof env.api.formatLabel).toBe('function');
    });

    it('renders "Updated Nm ago" for a recent timestamp (online, neutral tone)', () => {
        const fetchedAt = NOW - 5 * MINUTE;
        const el = env.api.render({ fetchedAt, isOffline: false, now: NOW });
        expect(el.classList.contains('wg-stale-badge')).toBe(true);
        expect(el.classList.contains('wg-stale-badge--neutral')).toBe(true);
        expect(el.classList.contains('wg-stale-badge--warning')).toBe(false);
        expect(el.classList.contains('wg-stale-badge--offline')).toBe(false);
        expect(el.textContent).toBe('Updated 5m ago');
    });

    it('renders "Updated Nh ago" for older online data still under the stale threshold', () => {
        const fetchedAt = NOW - 2 * HOUR;
        const el = env.api.render({
            fetchedAt,
            isOffline: false,
            staleAfterMs: 6 * HOUR,
            now: NOW,
        });
        expect(el.classList.contains('wg-stale-badge--neutral')).toBe(true);
        expect(el.classList.contains('wg-stale-badge--warning')).toBe(false);
        expect(el.textContent).toBe('Updated 2h ago');
    });

    it('renders "Updated just now" when fetchedAt is within the last minute', () => {
        const fetchedAt = NOW - 5 * 1000;
        const el = env.api.render({ fetchedAt, isOffline: false, now: NOW });
        expect(el.textContent).toBe('Updated just now');
        expect(el.classList.contains('wg-stale-badge--neutral')).toBe(true);
    });

    it('prefixes the label with "Offline · " and applies offline + warning tone when isOffline=true', () => {
        const fetchedAt = NOW - 12 * MINUTE;
        const el = env.api.render({ fetchedAt, isOffline: true, now: NOW });
        expect(el.classList.contains('wg-stale-badge--offline')).toBe(true);
        expect(el.classList.contains('wg-stale-badge--warning')).toBe(true);
        expect(el.classList.contains('wg-stale-badge--neutral')).toBe(false);
        expect(el.textContent).toBe('Offline · 12m old');
    });

    it('renders "Offline · Nh old" with warning tone when offline for hours', () => {
        const fetchedAt = NOW - 3 * HOUR;
        const el = env.api.render({ fetchedAt, isOffline: true, now: NOW });
        expect(el.textContent).toBe('Offline · 3h old');
        expect(el.classList.contains('wg-stale-badge--warning')).toBe(true);
    });

    it('applies the warning tone class when age exceeds staleAfterMs (online)', () => {
        const fetchedAt = NOW - 90 * MINUTE; // 1h30m
        const el = env.api.render({
            fetchedAt,
            isOffline: false,
            staleAfterMs: HOUR, // 1h threshold → 1h30m exceeds it
            now: NOW,
        });
        expect(el.classList.contains('wg-stale-badge--warning')).toBe(true);
        expect(el.classList.contains('wg-stale-badge--neutral')).toBe(false);
        // Not offline → label still uses the "Updated" prefix.
        expect(el.textContent).toBe('Updated 1h ago');
    });

    it('falls back to "Never updated" with neutral tone when fetchedAt is missing', () => {
        const el = env.api.render({ fetchedAt: null, isOffline: false, now: NOW });
        expect(el.textContent).toBe('Never updated');
        expect(el.classList.contains('wg-stale-badge--neutral')).toBe(true);
    });

    it('falls back to "Offline · no cache" with warning + offline tone when offline and no fetchedAt', () => {
        const el = env.api.render({ fetchedAt: undefined, isOffline: true, now: NOW });
        expect(el.textContent).toBe('Offline · no cache');
        expect(el.classList.contains('wg-stale-badge--offline')).toBe(true);
        expect(el.classList.contains('wg-stale-badge--warning')).toBe(true);
    });

    it('does not write any hardcoded hex colour or inline style into the DOM', () => {
        const el = env.api.render({ fetchedAt: NOW - HOUR, isOffline: true, now: NOW });
        expect(el.outerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}/);
        expect(el.getAttribute('style')).toBeNull();
    });

    it('exposes role="status" + aria-live="polite" so freshness changes are announced', () => {
        const el = env.api.render({ fetchedAt: NOW - MINUTE, isOffline: false, now: NOW });
        expect(el.getAttribute('role')).toBe('status');
        expect(el.getAttribute('aria-live')).toBe('polite');
    });

    it('formats day-scale ages as "Nd"', () => {
        const fetchedAt = NOW - 3 * 24 * HOUR;
        const el = env.api.render({ fetchedAt, isOffline: true, now: NOW });
        expect(el.textContent).toBe('Offline · 3d old');
    });
});
