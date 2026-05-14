// Integration tests for features/medication-utils.js (Plan 2026-05-13, Task 5).
//
// The module hosts four pure helpers extracted from app.js that parse the
// `medication.schedule` JSON column and derive (a) the next scheduled
// occurrence, (b) a human-readable schedule label, and (c) the last-taken
// timestamp in ms. These were duplicated as global function declarations in
// app.js; consumers (features/meds.js renderer + bucket sort, app.js's
// _todayRender helper-hand-off, features/today.js fallback path) reach them
// through window.MedicationUtils.* or the bare-name backwards-compat shims.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('features/medication-utils.js — MedicationUtils (Plan 2026-05-13, Task 5)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('exposes the MedicationUtils public surface on window', () => {
        const { window } = env;
        expect(typeof window.MedicationUtils).toBe('object');
        expect(typeof window.MedicationUtils.parseMedicationSchedule).toBe('function');
        expect(typeof window.MedicationUtils.getNextScheduledDate).toBe('function');
        expect(typeof window.MedicationUtils.getMedicationScheduleText).toBe('function');
        expect(typeof window.MedicationUtils.getLastTakenTimeMs).toBe('function');
    });

    it('preserves the bare-name backwards-compat shims used by today.js fallback path', () => {
        const { window } = env;
        // today.js:163 / today.js:165 look up window.parseMedicationSchedule and
        // window.getNextScheduledDate when the aggregator opts arg omits helpers.
        expect(window.parseMedicationSchedule).toBe(window.MedicationUtils.parseMedicationSchedule);
        expect(window.getNextScheduledDate).toBe(window.MedicationUtils.getNextScheduledDate);
        expect(window.getMedicationScheduleText).toBe(window.MedicationUtils.getMedicationScheduleText);
        expect(window.getLastTakenTimeMs).toBe(window.MedicationUtils.getLastTakenTimeMs);
    });

    describe('parseMedicationSchedule', () => {
        it('parses valid JSON into an object', () => {
            const { window } = env;
            const out = window.MedicationUtils.parseMedicationSchedule(
                JSON.stringify({ type: 'daily', times: ['08:00', '20:00'] })
            );
            expect(out).toEqual({ type: 'daily', times: ['08:00', '20:00'] });
        });

        it('returns null for invalid JSON instead of throwing', () => {
            const { window } = env;
            expect(window.MedicationUtils.parseMedicationSchedule('not-json')).toBeNull();
            expect(window.MedicationUtils.parseMedicationSchedule('')).toBeNull();
            expect(window.MedicationUtils.parseMedicationSchedule(undefined)).toBeNull();
        });
    });

    describe('getNextScheduledDate — daily', () => {
        it('returns the next future time today when one is still ahead', () => {
            const { window } = env;
            const now = new Date('2026-05-09T07:30:00');
            const schedule = { type: 'daily', times: ['09:00', '21:00'] };
            const next = window.MedicationUtils.getNextScheduledDate(schedule, now);
            // `next` is a Date constructed inside the jsdom window's realm, so
            // `instanceof Date` against the test-runner's global Date returns
            // false. Use the duck-typed `getTime` check instead.
            expect(typeof next?.getTime).toBe('function');
            expect(next.getHours()).toBe(9);
            expect(next.getMinutes()).toBe(0);
            expect(next.toDateString()).toBe(now.toDateString());
        });

        it('rolls over to tomorrow when every time today has already passed', () => {
            const { window } = env;
            const now = new Date('2026-05-09T22:30:00');
            const schedule = { type: 'daily', times: ['09:00', '21:00'] };
            const next = window.MedicationUtils.getNextScheduledDate(schedule, now);
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            expect(next.toDateString()).toBe(tomorrow.toDateString());
            // The earliest of the two times tomorrow is 09:00.
            expect(next.getHours()).toBe(9);
        });

        it('skips invalid time strings without crashing', () => {
            const { window } = env;
            const now = new Date('2026-05-09T07:30:00');
            const schedule = { type: 'daily', times: ['bogus', '09:00'] };
            const next = window.MedicationUtils.getNextScheduledDate(schedule, now);
            // `next` is a Date constructed inside the jsdom window's realm, so
            // `instanceof Date` against the test-runner's global Date returns
            // false. Use the duck-typed `getTime` check instead.
            expect(typeof next?.getTime).toBe('function');
            expect(next.getHours()).toBe(9);
        });

        it('returns null when times array is empty', () => {
            const { window } = env;
            const schedule = { type: 'daily', times: [] };
            expect(window.MedicationUtils.getNextScheduledDate(schedule, new Date())).toBeNull();
        });
    });

    describe('getNextScheduledDate — weekly', () => {
        it('finds the next matching weekday/time across the week boundary', () => {
            const { window } = env;
            // Saturday 2026-05-09 at 22:30 — the next Monday (day=1) at 08:00.
            const now = new Date('2026-05-09T22:30:00');
            const schedule = { type: 'weekly', days: [1, 3], times: ['08:00'] };
            const next = window.MedicationUtils.getNextScheduledDate(schedule, now);
            // `next` is a Date constructed inside the jsdom window's realm, so
            // `instanceof Date` against the test-runner's global Date returns
            // false. Use the duck-typed `getTime` check instead.
            expect(typeof next?.getTime).toBe('function');
            expect(next.getDay()).toBe(1);
            expect(next.getHours()).toBe(8);
            expect(next > now).toBe(true);
        });

        it('returns same-day match when today matches and a time is still ahead', () => {
            const { window } = env;
            // Saturday 2026-05-09 at 07:00 — schedule fires Saturdays 09:00.
            const now = new Date('2026-05-09T07:00:00');
            const schedule = { type: 'weekly', days: [6], times: ['09:00'] };
            const next = window.MedicationUtils.getNextScheduledDate(schedule, now);
            // `next` is a Date constructed inside the jsdom window's realm, so
            // `instanceof Date` against the test-runner's global Date returns
            // false. Use the duck-typed `getTime` check instead.
            expect(typeof next?.getTime).toBe('function');
            expect(next.getDay()).toBe(6);
            expect(next.toDateString()).toBe(now.toDateString());
            expect(next.getHours()).toBe(9);
        });

        it('skips today when the only matching time today has passed', () => {
            const { window } = env;
            // Saturday 2026-05-09 at 10:00 — schedule fires Saturdays 09:00; next is
            // the following Saturday.
            const now = new Date('2026-05-09T10:00:00');
            const schedule = { type: 'weekly', days: [6], times: ['09:00'] };
            const next = window.MedicationUtils.getNextScheduledDate(schedule, now);
            // `next` is a Date constructed inside the jsdom window's realm, so
            // `instanceof Date` against the test-runner's global Date returns
            // false. Use the duck-typed `getTime` check instead.
            expect(typeof next?.getTime).toBe('function');
            expect(next.getDay()).toBe(6);
            expect(next > now).toBe(true);
            // 7 days later.
            const dayDiff = Math.round((next - now) / (1000 * 60 * 60 * 24));
            expect(dayDiff).toBe(7);
        });

        it('returns null when neither days nor times are provided', () => {
            const { window } = env;
            expect(
                window.MedicationUtils.getNextScheduledDate({ type: 'weekly', days: [], times: [] }, new Date())
            ).toBeNull();
        });
    });

    describe('getNextScheduledDate — edge cases', () => {
        it('returns null for null/undefined schedule', () => {
            const { window } = env;
            expect(window.MedicationUtils.getNextScheduledDate(null, new Date())).toBeNull();
            expect(window.MedicationUtils.getNextScheduledDate(undefined, new Date())).toBeNull();
        });

        it('returns null for unrecognised schedule type', () => {
            const { window } = env;
            const schedule = { type: 'as_needed' };
            expect(window.MedicationUtils.getNextScheduledDate(schedule, new Date())).toBeNull();
        });
    });

    describe('getMedicationScheduleText', () => {
        it('renders daily schedules with comma-separated times', () => {
            const { window } = env;
            const text = window.MedicationUtils.getMedicationScheduleText(
                { schedule: '...' },
                { type: 'daily', times: ['08:00', '20:00'] }
            );
            expect(text).toBe('Daily: 08:00, 20:00');
        });

        it('renders weekly schedules with day names and times', () => {
            const { window } = env;
            const text = window.MedicationUtils.getMedicationScheduleText(
                { schedule: '...' },
                { type: 'weekly', days: [1, 3, 5], times: ['09:00'] }
            );
            expect(text).toBe('Weekly (Mon, Wed, Fri): 09:00');
        });

        it('returns "As Needed" for any other schedule type', () => {
            const { window } = env;
            const text = window.MedicationUtils.getMedicationScheduleText(
                { schedule: '...' },
                { type: 'as_needed' }
            );
            expect(text).toBe('As Needed');
        });

        it('falls back to escapeHtml(med.schedule) when no parsed schedule is provided', () => {
            const { window } = env;
            const text = window.MedicationUtils.getMedicationScheduleText(
                { schedule: '<custom & wild>' },
                null
            );
            // escapeHtml encodes &, <, > so the raw string is safe to drop into innerHTML.
            expect(text).toContain('&lt;custom');
            expect(text).toContain('&amp;');
            expect(text).toContain('wild&gt;');
        });
    });

    describe('getLastTakenTimeMs', () => {
        it('returns the parsed timestamp in ms', () => {
            const { window } = env;
            const out = window.MedicationUtils.getLastTakenTimeMs({
                last_taken_at: '2026-02-15T10:00:00Z'
            });
            expect(out).toBe(new Date('2026-02-15T10:00:00Z').getTime());
        });

        it('returns 0 when last_taken_at is missing/null', () => {
            const { window } = env;
            expect(window.MedicationUtils.getLastTakenTimeMs({})).toBe(0);
            expect(window.MedicationUtils.getLastTakenTimeMs({ last_taken_at: null })).toBe(0);
        });
    });

    it('confirms app.js no longer hosts the original function declarations', async () => {
        // Plan acceptance: the four helpers must live in features/medication-utils.js
        // only. This test reads app.js source from disk so a regression that
        // re-introduces a `function parseMedicationSchedule(...)` declaration
        // in app.js fails CI loudly.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        const __dir = path.dirname(fileURLToPath(import.meta.url));
        const APP_JS = path.resolve(__dir, '..', 'app.js');
        const src = fs.readFileSync(APP_JS, 'utf8');
        expect(src).not.toMatch(/^function parseMedicationSchedule\(/m);
        expect(src).not.toMatch(/^function getNextScheduledDate\(/m);
        expect(src).not.toMatch(/^function getMedicationScheduleText\(/m);
        expect(src).not.toMatch(/^function getLastTakenTimeMs\(/m);
    });
});
