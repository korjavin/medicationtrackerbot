// Task 6 of offline-meds-resilience — when the cached `next_intake` payload
// is missing (cold-start offline) or stale, the Today meds tile must fall
// back to computing the soonest planned dose from the cached medications
// list using the same client-side schedule helpers that meds.js uses. This
// is the offline-first equivalent of the server's
// /api/medications/next-intake response.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const EMPTY_STATE_JS = path.join(REPO_ROOT, 'web/static/js/components/empty-state.js');
const WG_ICONS_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-icons.js');
const WG_SPARKLINE_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-sparkline.js');
const WG_STALE_BADGE_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-stale-badge.js');
const TODAY_JS = path.join(REPO_ROOT, 'web/static/js/features/today.js');

// Standalone copies of app.js's medication schedule helpers — duplicated
// here intentionally so the test asserts the contract exposed via opts,
// not whatever happens to be on window. These mirror the implementations at
// app.js:2495 (parseMedicationSchedule) and app.js:2503 (getNextScheduledDate).
function parseMedicationSchedule(rawSchedule) {
    try { return JSON.parse(rawSchedule); } catch (_) { return null; }
}
function getNextScheduledDate(schedule, now) {
    if (!schedule) return null;
    const parseCandidate = (baseDate, timeStr) => {
        const [h, min] = String(timeStr).split(':').map(Number);
        if (Number.isNaN(h) || Number.isNaN(min)) return null;
        const candidate = new Date(baseDate);
        candidate.setHours(h, min, 0, 0);
        return candidate;
    };
    if (schedule.type === 'daily' && Array.isArray(schedule.times)) {
        const candidates = schedule.times
            .map((t) => {
                const c = parseCandidate(now, t);
                if (!c) return null;
                if (c <= now) c.setDate(c.getDate() + 1);
                return c;
            })
            .filter(Boolean);
        return candidates.sort((a, b) => a - b)[0] || null;
    }
    if (schedule.type === 'weekly' && Array.isArray(schedule.days) && Array.isArray(schedule.times)) {
        const candidates = [];
        for (let i = 0; i < 8; i++) {
            const dayBase = new Date(now);
            dayBase.setDate(now.getDate() + i);
            if (!schedule.days.includes(dayBase.getDay())) continue;
            schedule.times.forEach((t) => {
                const c = parseCandidate(dayBase, t);
                if (c && c > now) candidates.push(c);
            });
        }
        return candidates.sort((a, b) => a - b)[0] || null;
    }
    return null;
}

function loadEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(fs.readFileSync(EMPTY_STATE_JS, 'utf8') + '\nwindow.createEmptyState = createEmptyState;');
    window.eval(fs.readFileSync(WG_ICONS_JS, 'utf8'));
    window.eval(fs.readFileSync(WG_SPARKLINE_JS, 'utf8'));
    window.eval(fs.readFileSync(WG_STALE_BADGE_JS, 'utf8'));
    window.eval(fs.readFileSync(TODAY_JS, 'utf8'));
    return {
        window,
        document: window.document,
        aggregate: window.TodayDashboard.aggregateToday,
        render: window.TodayDashboard.renderToday,
        cleanup: () => dom.window.close()
    };
}

const HELPERS = { getNextScheduledDate, parseMedicationSchedule };

const FEATURES_MED_ONLY = {
    medication: true, bp: false, weight: false, food: false, workout: false, health: false
};

describe('Today next-intake meds fallback', () => {
    let env;
    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env.cleanup(); });

    it('renders the soonest planned dose from cached medications when next_intake is absent (offline cold start)', () => {
        const now = new Date('2026-05-09T07:30:00');
        const fetchedAt = now.getTime() - 2 * 60 * 60 * 1000; // meds cache 2h old
        // Two meds: one at 09:00, another at 12:00. Earliest is the 09:00 dose.
        const bootstrap = {
            features: FEATURES_MED_ONLY,
            medications: [
                { id: 1, name: 'Aspirin', archived: false, schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }) },
                { id: 2, name: 'Metformin', archived: false, schedule: JSON.stringify({ type: 'daily', times: ['12:00'] }) },
                { id: 3, name: 'Old', archived: true, schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }) }
            ],
            __medications_meta: { fetchedAt, isStale: true }
        };

        const state = env.aggregate(bootstrap, null, now, HELPERS);

        expect(state.nextMed.status).toBe('ok');
        expect(state.nextMed.value.names).toEqual(['Aspirin']);
        expect(state.nextMed.value.ids).toEqual([1]);
        // Computed dose should be at 09:00 the same local day.
        const expected = new Date(now);
        expected.setHours(9, 0, 0, 0);
        expect(state.nextMed.value.scheduledAt).toBe(expected.toISOString());
        // Meta carries the medications cache freshness so the chip can render.
        expect(state.nextMed.meta).toEqual({ fetchedAt, isStale: true });

        // Render with the freshness fed via state.__fetchedAt (mirrors what
        // app.js does after _todayReadCaches sets oldestCacheTimestamp).
        state.__fetchedAt = fetchedAt;
        state.__navigatorOffline = true;
        const root = env.document.createElement('div');
        env.render(state, root, { now });

        const medsCard = root.querySelector('.wg-today-meds');
        expect(medsCard).not.toBeNull();
        const names = Array.from(medsCard.querySelectorAll('.wg-today-meds__name')).map((n) => n.textContent);
        expect(names).toEqual(['Aspirin']);
        // Stale chip is mounted at the top of Today and reads "Offline · …".
        const badge = root.querySelector('.today-stale-badge-row .wg-stale-badge');
        expect(badge).not.toBeNull();
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);
    });

    it('groups multiple meds scheduled at the same slot (server next_intake parity)', () => {
        const now = new Date('2026-05-09T07:30:00');
        // Three daily meds, two of them share the 09:00 slot. Mirror the server
        // behavior of returning all medication_names for that earliest slot.
        const bootstrap = {
            features: FEATURES_MED_ONLY,
            medications: [
                { id: 10, name: 'Aspirin', archived: false, schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }) },
                { id: 11, name: 'Metformin', archived: false, schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }) },
                { id: 12, name: 'Vitamin D', archived: false, schedule: JSON.stringify({ type: 'daily', times: ['12:00'] }) }
            ],
            __medications_meta: { fetchedAt: now.getTime() - 60 * 60 * 1000, isStale: false }
        };

        const state = env.aggregate(bootstrap, null, now, HELPERS);

        expect(state.nextMed.status).toBe('ok');
        expect(state.nextMed.value.names.sort()).toEqual(['Aspirin', 'Metformin']);
        expect(state.nextMed.value.ids.sort()).toEqual([10, 11]);
    });

    it('falls back to medications when next_intake meta is stale even though next_intake payload exists', () => {
        const now = new Date('2026-05-09T07:30:00');
        // Stale next_intake (e.g. 14h old, past the 12h staleAfterMs window)
        // should be ignored in favour of the freshly-hydrated medications list.
        const bootstrap = {
            features: FEATURES_MED_ONLY,
            next_intake: {
                scheduled_at: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
                medication_names: ['Yesterday'],
                medication_ids: [99]
            },
            __next_intake_meta: { fetchedAt: now.getTime() - 14 * 60 * 60 * 1000, isStale: true },
            medications: [
                { id: 1, name: 'Aspirin', archived: false, schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }) }
            ],
            __medications_meta: { fetchedAt: now.getTime() - 60 * 60 * 1000, isStale: false }
        };

        const state = env.aggregate(bootstrap, null, now, HELPERS);

        expect(state.nextMed.status).toBe('ok');
        expect(state.nextMed.value.names).toEqual(['Aspirin']);
        expect(state.nextMed.value.ids).toEqual([1]);
    });

    it('preserves a fresh next_intake even when medications cache is also present', () => {
        const now = new Date('2026-05-09T07:30:00');
        // Fresh next_intake (server-authoritative — accounts for already-taken
        // doses in the day) must take precedence over the local fallback.
        const bootstrap = {
            features: FEATURES_MED_ONLY,
            next_intake: {
                scheduled_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
                medication_names: ['Server-Picked'],
                medication_ids: [42]
            },
            __next_intake_meta: { fetchedAt: now.getTime() - 60 * 1000, isStale: false },
            medications: [
                { id: 1, name: 'Aspirin', archived: false, schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }) }
            ],
            __medications_meta: { fetchedAt: now.getTime() - 60 * 1000, isStale: false }
        };

        const state = env.aggregate(bootstrap, null, now, HELPERS);

        expect(state.nextMed.status).toBe('ok');
        expect(state.nextMed.value.names).toEqual(['Server-Picked']);
        expect(state.nextMed.value.ids).toEqual([42]);
    });

    it('shows the existing offline empty state when neither next_intake nor medications cache is present', () => {
        const now = new Date('2026-05-09T07:30:00');
        const bootstrap = {
            features: FEATURES_MED_ONLY
            // no next_intake, no medications
        };

        const state = env.aggregate(bootstrap, null, now, HELPERS);
        expect(state.nextMed.status).toBe('missing');

        state.__offline = true;
        const root = env.document.createElement('div');
        env.render(state, root, { now });

        const medsCard = root.querySelector('.wg-today-meds');
        expect(medsCard).not.toBeNull();
        const kicker = medsCard.querySelector('.wg-next-action-card__kicker');
        expect(kicker.textContent).toBe('Next dose data unavailable offline');
    });

    it('returns missing when medications list is present but every entry has no computable next dose', () => {
        const now = new Date('2026-05-09T07:30:00');
        // All meds are as_needed (no schedule) or unparseable — fallback can't
        // produce a dose, so the cell should report 'missing' rather than
        // throw or hand back a sentinel value.
        const bootstrap = {
            features: FEATURES_MED_ONLY,
            medications: [
                { id: 1, name: 'AsNeeded', archived: false, schedule: JSON.stringify({ type: 'as_needed' }) },
                { id: 2, name: 'Broken', archived: false, schedule: 'not-json' }
            ],
            __medications_meta: { fetchedAt: now.getTime() - 60 * 1000, isStale: false }
        };

        const state = env.aggregate(bootstrap, null, now, HELPERS);
        expect(state.nextMed.status).toBe('missing');
        // The medications cache freshness should still surface on the chip so
        // the user knows the data backing the empty state is from the cached
        // list — falling back silently to no meta hides provenance.
        expect(state.nextMed.meta).toEqual({
            fetchedAt: bootstrap.__medications_meta.fetchedAt,
            isStale: false
        });
    });

    it('skips medications whose course has already ended or has not started yet (medplan.PlanDoses parity)', () => {
        const now = new Date('2026-05-09T07:30:00');
        const nowMs = now.getTime();
        // Three meds: a finished antibiotic course (end_date yesterday), a not-yet-started
        // course (start_date tomorrow), and an active med. Only the active one should drive
        // the next-dose tile — mirrors medplan.go's StartDate/EndDate filter at lines 117-122.
        const yesterday = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
        const tomorrow = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
        const bootstrap = {
            features: FEATURES_MED_ONLY,
            medications: [
                { id: 1, name: 'FinishedAntibiotic', archived: false, end_date: yesterday,
                  schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }) },
                { id: 2, name: 'NotYetStarted', archived: false, start_date: tomorrow,
                  schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }) },
                { id: 3, name: 'Active', archived: false,
                  schedule: JSON.stringify({ type: 'daily', times: ['12:00'] }) }
            ],
            __medications_meta: { fetchedAt: nowMs - 60 * 60 * 1000, isStale: true }
        };

        const state = env.aggregate(bootstrap, null, now, HELPERS);

        expect(state.nextMed.status).toBe('ok');
        expect(state.nextMed.value.names).toEqual(['Active']);
        expect(state.nextMed.value.ids).toEqual([3]);
    });

    it('skips computed next doses that fall after the course end_date', () => {
        const now = new Date('2026-05-09T07:30:00');
        const nowMs = now.getTime();
        // Med's end_date is 08:00 today — the daily schedule's next dose computes to 09:00
        // today, which is past end_date. Server-side medplan filters this target at line 132,
        // so the offline fallback must too.
        const earlierToday = new Date(now);
        earlierToday.setHours(8, 0, 0, 0);
        const bootstrap = {
            features: FEATURES_MED_ONLY,
            medications: [
                { id: 1, name: 'EndsBeforeNextDose', archived: false,
                  end_date: earlierToday.toISOString(),
                  schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }) }
            ],
            __medications_meta: { fetchedAt: nowMs - 60 * 60 * 1000, isStale: true }
        };

        const state = env.aggregate(bootstrap, null, now, HELPERS);
        expect(state.nextMed.status).toBe('missing');
    });

    it('does not throw when helpers are not provided (graceful degrade to existing missing state)', () => {
        const now = new Date('2026-05-09T07:30:00');
        const bootstrap = {
            features: FEATURES_MED_ONLY,
            medications: [
                { id: 1, name: 'Aspirin', archived: false, schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }) }
            ]
        };

        // No opts arg at all — exercises the no-helpers path. window.parseMedicationSchedule
        // is undefined inside the standalone today.js test env, so the fallback
        // is silently skipped and the cell falls through to 'missing'.
        const state = env.aggregate(bootstrap, null, now);
        expect(state.nextMed.status).toBe('missing');
    });
});
