import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

function loadTimeFormat(html = '<!DOCTYPE html><html><body></body></html>') {
    const dom = new JSDOM(html, {
        url: 'https://example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    const src = fs.readFileSync(
        path.join(REPO_ROOT, 'web/static/js/core/time-format.js'),
        'utf8'
    );
    window.eval(`${src}\n//# sourceURL=file://time-format.js`);
    return { window, document: window.document, cleanup: () => dom.window.close() };
}

describe('TimeFormat', () => {
    let env;
    afterEach(() => { if (env) { env.cleanup(); env = null; } });

    it('exposes window.TimeFormat with the documented API surface', () => {
        env = loadTimeFormat();
        const tf = env.window.TimeFormat;
        expect(typeof tf).toBe('object');
        expect(typeof tf.formatSettingsDateTime).toBe('function');
        expect(typeof tf.parseRFC3339OffsetMinutes).toBe('function');
        expect(typeof tf.formatFixedOffsetDateTime).toBe('function');
        expect(typeof tf.render).toBe('function');
        expect(typeof tf.ensureTimer).toBe('function');
        expect(typeof tf.getLiveServerTime).toBe('function');
        expect(typeof tf.updateFromBundle).toBe('function');
    });

    it('mirrors render() on window.renderSettingsTimeInfo for backwards compat', () => {
        env = loadTimeFormat();
        expect(env.window.renderSettingsTimeInfo).toBe(env.window.TimeFormat.render);
    });

    describe('parseRFC3339OffsetMinutes', () => {
        beforeEach(() => { env = loadTimeFormat(); });

        it('returns null for falsy or non-string input', () => {
            const fn = env.window.TimeFormat.parseRFC3339OffsetMinutes;
            expect(fn(null)).toBeNull();
            expect(fn(undefined)).toBeNull();
            expect(fn('')).toBeNull();
            expect(fn(42)).toBeNull();
        });

        it('returns 0 for the Z suffix (UTC)', () => {
            const fn = env.window.TimeFormat.parseRFC3339OffsetMinutes;
            expect(fn('2026-05-14T12:00:00Z')).toBe(0);
        });

        it('parses positive offsets', () => {
            const fn = env.window.TimeFormat.parseRFC3339OffsetMinutes;
            expect(fn('2026-05-14T12:00:00+02:00')).toBe(120);
            expect(fn('2026-05-14T12:00:00+05:30')).toBe(330);
        });

        it('parses negative offsets', () => {
            const fn = env.window.TimeFormat.parseRFC3339OffsetMinutes;
            expect(fn('2026-05-14T12:00:00-08:00')).toBe(-480);
            expect(fn('2026-05-14T12:00:00-03:30')).toBe(-210);
        });

        it('returns null for strings without an offset suffix', () => {
            const fn = env.window.TimeFormat.parseRFC3339OffsetMinutes;
            expect(fn('2026-05-14T12:00:00')).toBeNull();
            expect(fn('not a date')).toBeNull();
        });
    });

    describe('formatFixedOffsetDateTime', () => {
        beforeEach(() => { env = loadTimeFormat(); });

        it('returns Unavailable for invalid input', () => {
            const fn = env.window.TimeFormat.formatFixedOffsetDateTime;
            const W = env.window;
            expect(fn(null, 0)).toBe('Unavailable');
            expect(fn(new W.Date('not a date'), 0)).toBe('Unavailable');
            expect(fn(new W.Date(), 'oops')).toBe('Unavailable');
        });

        it('renders a fixed offset by shifting and formatting as UTC', () => {
            const fn = env.window.TimeFormat.formatFixedOffsetDateTime;
            const W = env.window;
            // 2026-05-14T00:00:00Z, +60min → 01:00 wall time. Output format
            // depends on the runtime locale (e.g. "1:00:00 AM" en-US vs
            // "01:00:00" en-GB), so verify the shift produced the right hour.
            const utc = new W.Date(W.Date.UTC(2026, 4, 14, 0, 0, 0));
            const at1AM = fn(utc, 60);
            const at0AM = fn(utc, 0);
            expect(at1AM).not.toBe(at0AM);
            expect(at1AM).toMatch(/\b0?1[:\s]/);
        });

        it('passing a zero offset formats the date in UTC', () => {
            const fn = env.window.TimeFormat.formatFixedOffsetDateTime;
            const W = env.window;
            const utc = new W.Date(W.Date.UTC(2026, 4, 14, 12, 0, 0));
            const out = fn(utc, 0);
            expect(out).toMatch(/2026/);
            expect(out).toMatch(/12[:\s]/);
        });
    });

    describe('formatSettingsDateTime', () => {
        beforeEach(() => { env = loadTimeFormat(); });

        it('returns a non-empty string for a valid date with no timezone', () => {
            const W = env.window;
            const fn = W.TimeFormat.formatSettingsDateTime;
            const out = fn(new W.Date(W.Date.UTC(2026, 4, 14, 12, 0, 0)));
            expect(typeof out).toBe('string');
            expect(out.length).toBeGreaterThan(0);
        });

        it('honours a passed-in timeZone option', () => {
            const W = env.window;
            const fn = W.TimeFormat.formatSettingsDateTime;
            const utc = new W.Date(W.Date.UTC(2026, 4, 14, 12, 0, 0));
            const newYork = fn(utc, 'America/New_York');
            const tokyo = fn(utc, 'Asia/Tokyo');
            expect(newYork).not.toBe(tokyo);
        });

        it('falls back to toLocaleString when DateTimeFormat throws (invalid timeZone)', () => {
            const W = env.window;
            const fn = W.TimeFormat.formatSettingsDateTime;
            const d = new W.Date(W.Date.UTC(2026, 4, 14, 12, 0, 0));
            const out = fn(d, 'Not/A_Real_Zone');
            expect(typeof out).toBe('string');
            expect(out.length).toBeGreaterThan(0);
        });
    });

    describe('updateFromBundle + getLiveServerTime', () => {
        beforeEach(() => { env = loadTimeFormat(); });

        it('getLiveServerTime returns null before any bundle is applied', () => {
            expect(env.window.TimeFormat.getLiveServerTime()).toBeNull();
        });

        it('after updateFromBundle, getLiveServerTime returns a Date close to the synced base', () => {
            const tf = env.window.TimeFormat;
            tf.updateFromBundle({
                timezone: 'UTC',
                serverTime: '2026-05-14T12:00:00Z',
                serverTimezone: 'UTC',
            });
            const live = tf.getLiveServerTime();
            expect(live).toBeInstanceOf(env.window.Date);
            // Within a few seconds of the bundle's server_time
            const expected = Date.parse('2026-05-14T12:00:00Z');
            expect(Math.abs(live.getTime() - expected)).toBeLessThan(5000);
        });
    });

    describe('render', () => {
        const settingsHTML = `<!DOCTYPE html><html><body>
            <span id="settings-timezone-value"></span>
            <span id="settings-saved-time-value"></span>
            <span id="settings-local-time-value"></span>
            <span id="settings-server-time-value"></span>
            <p id="settings-timezone-note"></p>
        </body></html>`;

        it('returns silently when DOM nodes are missing', () => {
            env = loadTimeFormat();
            expect(() => env.window.TimeFormat.render({ timezone: 'UTC' })).not.toThrow();
        });

        it('writes timezone, saved time, and timezone note when the bundle has a timezone', () => {
            env = loadTimeFormat(settingsHTML);
            env.window.TimeFormat.render({
                timezone: 'UTC',
                serverTime: '2026-05-14T12:00:00Z',
                serverTimezone: 'UTC',
            });
            expect(env.document.getElementById('settings-timezone-value').textContent).toBe('UTC');
            expect(env.document.getElementById('settings-saved-time-value').textContent).not.toBe('Unavailable until a timezone is saved');
            expect(env.document.getElementById('settings-timezone-note').textContent).toContain('Saved timezone affects');
            expect(env.document.getElementById('settings-server-time-value').textContent).toContain('UTC');
        });

        it('writes the "Not set" placeholder when the bundle has no timezone', () => {
            env = loadTimeFormat(settingsHTML);
            env.window.TimeFormat.render({ timezone: '', serverTime: '', serverTimezone: '' });
            expect(env.document.getElementById('settings-timezone-value').textContent).toBe('Not set');
            expect(env.document.getElementById('settings-saved-time-value').textContent).toBe('Unavailable until a timezone is saved');
            expect(env.document.getElementById('settings-timezone-note').textContent).toContain('No saved timezone yet');
            expect(env.document.getElementById('settings-server-time-value').textContent).toBe('Unavailable');
        });
    });
});
