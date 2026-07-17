import { describe, expect, it } from 'vitest';
import { computeReminderHorizon } from '../../../domain/reminders.js';

describe('domain/reminders.js — horizon scheduling', () => {
    it('computes correct BP and weight reminder entries using configured timeZone, not system timezone', () => {
        const nowMs = Date.UTC(2026, 6, 7, 12, 0, 0); // July 7, 2026 12:00:00 UTC
        const timeZone = 'Asia/Tokyo'; // JST is UTC+9. Local wall time is 21:00:00.

        const entries = computeReminderHorizon({
            medications: [], intakes: [], bps: [], weights: [], timeZone, now: nowMs,
            bpStatus: { enabled: true, preferred_reminder_hour: 20 },
            weightStatus: { enabled: true, preferred_reminder_hour: 9 }
        });

        // BP preferred hour is 20:00 JST.
        // Today's 20:00 JST is 11:00 UTC. Since now is 12:00 UTC, today's target is in the past.
        // Tomorrow's 20:00 JST is July 8, 2026 11:00 UTC.
        const bpEntries = entries.filter(e => e.text.includes('blood pressure'));
        const expectedNextBpTargetMs = Date.UTC(2026, 6, 8, 11, 0, 0);
        expect(bpEntries[0].fireAtUnix).toBe(expectedNextBpTargetMs / 1000);

        // Weight preferred hour is 09:00 JST.
        // Today's 09:00 JST is July 7, 00:00 UTC. Past.
        // Tomorrow's 09:00 JST is July 8, 00:00 UTC.
        const weightEntries = entries.filter(e => e.text.includes('weight'));
        const expectedNextWeightTargetMs = Date.UTC(2026, 6, 8, 0, 0, 0);
        expect(weightEntries[0].fireAtUnix).toBe(expectedNextWeightTargetMs / 1000);
    });

    it('computes correctly for negative-offset zones where UTC date differs from local date', () => {
        // now is July 7, 01:00:00 UTC.
        const nowMs = Date.UTC(2026, 6, 7, 1, 0, 0);
        const timeZone = 'America/Los_Angeles'; // Local wall time is July 6, 18:00:00.

        const entries = computeReminderHorizon({
            medications: [], intakes: [], bps: [], weights: [], timeZone, now: nowMs,
            bpStatus: { enabled: true, preferred_reminder_hour: 20 },
            weightStatus: { enabled: false }
        });

        // The user configured 20:00 local time. The loop should start on July 6 (today in local calendar).
        // July 6 20:00 local is July 7 03:00 UTC.
        const bpEntries = entries.filter(e => e.text.includes('blood pressure'));
        const expectedNextBpTargetMs = Date.UTC(2026, 6, 7, 3, 0, 0);

        expect(bpEntries[0].fireAtUnix).toBe(expectedNextBpTargetMs / 1000);
    });
});

// med-eas.57 — low-stock warning kind, ported from internal/scheduler/low_stock.go.
// Fires daily at 11:00 local when any med is < 7 days of supply; no callback.
describe('domain/reminders.js — low-stock reminder kind', () => {
    const nowMs = Date.UTC(2026, 6, 7, 6, 0, 0); // July 7, 06:00 UTC — before today's 11:00

    it('emits a low_stock entry at the next local 11:00 naming the low med', () => {
        const entries = computeReminderHorizon({
            medications: [{ id: 'm1', name: 'Lisinopril', schedule: '08:00', inventory_count: 3 }],
            intakes: [], bps: [], weights: [], timeZone: 'UTC', now: nowMs,
        });
        const low = entries.filter((e) => e.kind === 'low_stock');
        expect(low.length).toBeGreaterThan(0);
        // 3 units / 1 dose/day = 3 days < 7 → low. First fire is today 11:00 UTC.
        expect(low[0].fireAtUnix).toBe(Date.UTC(2026, 6, 7, 11, 0, 0) / 1000);
        expect(low[0].text).toContain('Lisinopril');
        expect(low[0].text).toContain('3 units');
        expect(low[0].text).toContain('~3 days left');
        expect(low[0].callback).toBeUndefined();
        // genericText is name-free.
        expect(low[0].genericText).not.toContain('Lisinopril');
        expect(low[0].genericText.length).toBeGreaterThan(0);
    });

    it('does not emit for well-stocked, null-inventory, or as-needed meds', () => {
        const entries = computeReminderHorizon({
            medications: [
                { id: 'm1', name: 'Plenty', schedule: '08:00', inventory_count: 100 },
                { id: 'm2', name: 'Untracked', schedule: '08:00', inventory_count: null },
                { id: 'm3', name: 'AsNeeded', schedule: JSON.stringify({ type: 'as_needed', times: [] }), inventory_count: 1 },
            ],
            intakes: [], bps: [], weights: [], timeZone: 'UTC', now: nowMs,
        });
        expect(entries.some((e) => e.kind === 'low_stock')).toBe(false);
    });
});

// med-eas.59 — workout-session reminder kind, ported from internal/scheduler/workout.go.
// Primary fire only: fires at scheduledInstant - notification_advance_minutes for
// recurring groups, at the scheduled moment for planned ad-hoc sessions.
describe('domain/reminders.js — workout reminder kind', () => {
    const nowMs = Date.UTC(2026, 6, 7, 6, 0, 0); // July 7, 2026 06:00 UTC
    const group = {
        id: 1, name: 'Push Day', active: true, is_rotating: false,
        days_of_week: '[0,1,2,3,4,5,6]', scheduled_time: '18:00', notification_advance_minutes: 30,
    };
    const variant = { id: 10, group_id: 1, name: 'Variant A', rotation_order: 0 };
    const exercise = {
        id: 100, variant_id: 10, exercise_name: 'Bench Press',
        target_sets: 3, target_reps_min: 8, order_index: 0,
    };

    it('emits a workout entry at scheduledInstant - advance for a recurring group', () => {
        const entries = computeReminderHorizon({
            timeZone: 'UTC', now: nowMs,
            workoutGroups: [group], workoutVariants: [variant], workoutExercises: [exercise],
            workoutStatus: { enabled: true },
        });
        const workout = entries.filter((e) => e.kind === 'workout');
        expect(workout.length).toBeGreaterThan(0);
        // Today 18:00 UTC minus 30 min advance → 17:30 UTC.
        expect(workout[0].fireAtUnix).toBe(Date.UTC(2026, 6, 7, 17, 30, 0) / 1000);
        expect(workout[0].text).toContain('Push Day - Variant A');
        expect(workout[0].text).toContain('Bench Press');
        // genericText is name-free.
        expect(workout[0].genericText).not.toContain('Push Day');
        expect(workout[0].genericText.length).toBeGreaterThan(0);
    });

    it('emits a workout entry for a planned ad-hoc session at its scheduled moment', () => {
        const session = {
            id: 5, group_id: -1, status: 'pending',
            scheduled_date: '2026-07-09T00:00:00.000Z', scheduled_time: '19:00',
        };
        const entries = computeReminderHorizon({
            timeZone: 'UTC', now: nowMs,
            workoutSessions: [session],
            workoutStatus: { enabled: true },
        });
        const workout = entries.filter((e) => e.kind === 'workout');
        expect(workout.length).toBe(1);
        expect(workout[0].fireAtUnix).toBe(Date.UTC(2026, 6, 9, 19, 0, 0) / 1000);
        expect(workout[0].genericText.length).toBeGreaterThan(0);
    });

    it('emits nothing when the workout reminder pref is disabled', () => {
        const entries = computeReminderHorizon({
            timeZone: 'UTC', now: nowMs,
            workoutGroups: [group], workoutVariants: [variant], workoutExercises: [exercise],
            workoutStatus: { enabled: false },
        });
        expect(entries.some((e) => e.kind === 'workout')).toBe(false);
    });
});

// med-eas.58 — the weekly-digest formatter ports Go FormatWeeklyReview, and
// the fire-time helper lands on the next Sunday 19:00 local (weekly_digest.go).
describe('domain/reminders.js — weekly digest formatter + fire time', () => {
    it('formats a populated weekly review into the section lines', async () => {
        const { formatWeeklyDigest } = await import('../../../domain/reminders.js');
        const review = {
            enabled: true, quiet: false,
            health_score: { now: { value: 72.4 }, prior: { value: 68.6 } },
            levers: [
                { key: 'bedtime', closed_this_week: 5 },
                { key: 'movement', closed_this_week: 3 },
            ],
            best_day: { day_unix: Date.UTC(2026, 6, 8, 0, 0, 0) / 1000, rings_closed: 3 }, // Wed
            gauges: {
                weight: { status: 'ok', velocity_pct_per_week: -0.42, pace_status: 'on_pace', acceleration: 'holding' },
                bp: { status: 'ok', count_30d: 12, share_30d: 0.75 },
                bp_share_30d_prior: 0.6,
                resting_hr: { status: 'ok', recent_14d_mean: 58.3, delta_from_baseline: -2.1 },
            },
        };
        const text = formatWeeklyDigest(review);
        expect(text).toContain('\u{1F5D3} Your week');
        expect(text).toContain('Health Score 72 \u{00B7} up 3');
        expect(text).toContain('Bedtime closed 5 of 7 \u{00B7} Movement 3');
        expect(text).toContain('Weight -0.4%/wk \u{00B7} on pace \u{00B7} holding steady');
        expect(text).toContain('BP in range 75% \u{00B7} up from 60%');
        expect(text).toContain('Resting HR 58 avg \u{00B7} 2 below your baseline');
        expect(text).toContain('Best day: Wednesday \u{00B7} 3 rings closed');
    });

    it('renders the quiet-week fallback', async () => {
        const { formatWeeklyDigest } = await import('../../../domain/reminders.js');
        const text = formatWeeklyDigest({ enabled: true, quiet: true });
        expect(text).toBe('\u{1F5D3} Your week\nA quiet week \u{2014} everything picks up where you left off.');
    });

    it('omits absent gauge sections and singularizes one ring', async () => {
        const { formatWeeklyDigest } = await import('../../../domain/reminders.js');
        const text = formatWeeklyDigest({
            enabled: true, quiet: false,
            health_score: { now: { value: 50 }, prior: { value: null } },
            levers: [],
            best_day: { day_unix: Date.UTC(2026, 6, 12, 0, 0, 0) / 1000, rings_closed: 1 }, // Sun
            gauges: { weight: { status: 'insufficient_data' }, bp: { status: 'insufficient_data' }, resting_hr: { status: 'insufficient_data' } },
        });
        expect(text).toContain('Health Score 50');
        expect(text).not.toContain('Weight');
        expect(text).not.toContain('BP in range');
        expect(text).not.toContain('Resting HR');
        expect(text).toContain('Best day: Sunday \u{00B7} 1 ring closed');
    });

    it('nextWeeklyDigestFireUnix lands on next Sunday 19:00 local', async () => {
        const { nextWeeklyDigestFireUnix } = await import('../../../domain/reminders.js');
        // Tue July 7, 2026 06:00 UTC → next Sunday is July 12.
        const now = Date.UTC(2026, 6, 7, 6, 0, 0);
        expect(nextWeeklyDigestFireUnix(now, 'UTC')).toBe(Date.UTC(2026, 6, 12, 19, 0, 0) / 1000);
        // On Sunday before 19:00 → today 19:00; after 19:00 → next week.
        expect(nextWeeklyDigestFireUnix(Date.UTC(2026, 6, 12, 10, 0, 0), 'UTC')).toBe(Date.UTC(2026, 6, 12, 19, 0, 0) / 1000);
        expect(nextWeeklyDigestFireUnix(Date.UTC(2026, 6, 12, 20, 0, 0), 'UTC')).toBe(Date.UTC(2026, 6, 19, 19, 0, 0) / 1000);
        // Timezone offset applies: America/Los_Angeles Sunday 19:00 = Mon 02:00/03:00 UTC (PDT UTC-7).
        expect(nextWeeklyDigestFireUnix(now, 'America/Los_Angeles')).toBe(Date.UTC(2026, 6, 13, 2, 0, 0) / 1000);
    });
});

// bd med-76c.1 — Telegram reminders transit the cloud relay as plaintext, so
// every entry must carry a name-free twin the user can opt into, and the
// delivery/verbosity pref must default to the documented values.
describe('domain/reminders.js — Telegram delivery pref + generic verbosity', () => {
    it('every horizon entry carries a genericText with no medication name in it', () => {
        const nowMs = Date.UTC(2026, 6, 7, 6, 0, 0);
        const entries = computeReminderHorizon({
            // Low inventory so a low_stock entry is also produced and covered here.
            medications: [{ id: 'm1', name: 'Lisinopril', dosage: '10 mg', schedule: '20:00', inventory_count: 2 }],
            intakes: [],
            bps: [], weights: [],
            timeZone: 'UTC',
            now: nowMs,
            bpStatus: { enabled: true, preferred_reminder_hour: 20 },
            weightStatus: { enabled: true, preferred_reminder_hour: 9 },
        });

        expect(entries.some((e) => e.kind === 'low_stock')).toBe(true);
        expect(entries.length).toBeGreaterThan(0);
        for (const e of entries) {
            expect(typeof e.genericText).toBe('string');
            expect(e.genericText.length).toBeGreaterThan(0);
            expect(e.genericText).not.toContain('Lisinopril');
        }
        // The detailed text still names the drug — that is the default channel payload.
        expect(entries.some((e) => e.text.includes('Lisinopril'))).toBe(true);
    });

    it('delivery pref defaults to webpush/generic and round-trips, ignoring invalid values', async () => {
        const { createRemindersDomain } = await import('../../../domain/reminders.js');
        const { createInMemoryRecordsPort } = await import('./helpers/cloud-shim-harness.js');
        const records = createInMemoryRecordsPort();
        const domain = createRemindersDomain({ records, now: () => 1_700_000_000_000 });

        // bd med-yor.13: verbosity defaults to name-free 'generic'; 'detailed'
        // (medication names over the Telegram relay) is an explicit opt-in.
        expect(await domain.getDeliveryPref()).toEqual({ delivery: 'webpush', verbosity: 'generic' });

        expect(await domain.setDeliveryPref({ delivery: 'both', verbosity: 'generic' }))
            .toEqual({ delivery: 'both', verbosity: 'generic' });

        // Garbage keeps the stored value rather than silently resetting to defaults.
        expect(await domain.setDeliveryPref({ delivery: 'carrier-pigeon', verbosity: 'shouty' }))
            .toEqual({ delivery: 'both', verbosity: 'generic' });
    });

    // med-eas.59 part 1 — workout-session reminder pref singleton.
    it('workout pref defaults to disabled with no active mute, and toggles/mutes round-trip', async () => {
        const { createRemindersDomain, SNOOZE_MS, DONT_BUG_MS } = await import('../../../domain/reminders.js');
        const { createInMemoryRecordsPort } = await import('./helpers/cloud-shim-harness.js');
        const records = createInMemoryRecordsPort();
        const fixedNow = 1_700_000_000_000;
        const domain = createRemindersDomain({ records, now: () => fixedNow });

        expect(await domain.getWorkoutStatus()).toEqual({ enabled: false, snoozed_until: 0, dont_remind_until: 0 });

        expect(await domain.setWorkoutEnabled(true)).toEqual({ enabled: true, snoozed_until: 0, dont_remind_until: 0 });

        // snooze/dont-bug are mute-until instants; enabling must not clear them.
        const snoozed = await domain.snoozeWorkout();
        expect(snoozed.enabled).toBe(true);
        expect(snoozed.snoozed_until).toBe(fixedNow + SNOOZE_MS);

        const bugged = await domain.dontBugWorkout();
        expect(bugged.dont_remind_until).toBe(fixedNow + DONT_BUG_MS);
        expect(bugged.snoozed_until).toBe(fixedNow + SNOOZE_MS); // not clobbered

        const toggled = await domain.setWorkoutEnabled(false);
        expect(toggled.enabled).toBe(false);
        expect(toggled.snoozed_until).toBe(fixedNow + SNOOZE_MS);
        expect(toggled.dont_remind_until).toBe(fixedNow + DONT_BUG_MS);
    });
});

// bd med-9b8.3 — snooze (2h) / don't-bug (24h) are mute-until instants, not
// flags: `enabled` stays true and the horizon simply omits targets inside the
// window. Mirrors internal/scheduler/bp_reminders.go's skip condition.
describe('domain/reminders.js — snooze / dont-bug mute windows', () => {
    const nowMs = Date.UTC(2026, 6, 7, 6, 0, 0); // 06:00 UTC; BP fires 20:00, weight 09:00

    const horizon = (bpStatus, weightStatus) => computeReminderHorizon({
        medications: [], intakes: [], bps: [], weights: [],
        timeZone: 'UTC', now: nowMs, bpStatus, weightStatus,
    });

    it('drops BP targets inside an active snooze but keeps later ones', () => {
        const enabled = { enabled: true, preferred_reminder_hour: 20 };
        const before = horizon(enabled, { enabled: false });
        expect(before.some((e) => e.kind === 'bp')).toBe(true);

        // Snooze past today's 20:00 target (14h out) — tomorrow's must survive.
        const snoozed = horizon({ ...enabled, snoozed_until: nowMs + 15 * 60 * 60 * 1000 }, { enabled: false });
        const bpFires = snoozed.filter((e) => e.kind === 'bp').map((e) => e.fireAtUnix);
        expect(bpFires.length).toBe(before.filter((e) => e.kind === 'bp').length - 1);
        expect(Math.min(...bpFires) * 1000).toBeGreaterThan(nowMs + 15 * 60 * 60 * 1000);
    });

    it("a 24h don't-bug suppresses every BP target inside the day", () => {
        const muted = horizon(
            { enabled: true, preferred_reminder_hour: 20, dont_remind_until: nowMs + 24 * 60 * 60 * 1000 },
            { enabled: false },
        );
        for (const e of muted.filter((x) => x.kind === 'bp')) {
            expect(e.fireAtUnix * 1000).toBeGreaterThan(nowMs + 24 * 60 * 60 * 1000);
        }
    });

    it('mute never touches enabled, and the two windows OR together', () => {
        // snooze short, dontbug long → the longer one wins.
        const muted = horizon(
            {
                enabled: true,
                preferred_reminder_hour: 20,
                snoozed_until: nowMs + 60 * 1000,
                dont_remind_until: nowMs + 48 * 60 * 60 * 1000,
            },
            { enabled: false },
        );
        for (const e of muted.filter((x) => x.kind === 'bp')) {
            expect(e.fireAtUnix * 1000).toBeGreaterThan(nowMs + 48 * 60 * 60 * 1000);
        }
    });

    it('weight reminders honor their own mute window independently of BP', () => {
        const both = horizon(
            { enabled: true, preferred_reminder_hour: 20 },
            { enabled: true, preferred_reminder_hour: 9, dont_remind_until: nowMs + 24 * 60 * 60 * 1000 },
        );
        expect(both.some((e) => e.kind === 'bp')).toBe(true);
        for (const e of both.filter((x) => x.kind === 'weight')) {
            expect(e.fireAtUnix * 1000).toBeGreaterThan(nowMs + 24 * 60 * 60 * 1000);
        }
    });

    it('snoozeBPReminder sets a 2h window and preserves enabled + preferred hour', async () => {
        const { createRemindersDomain, SNOOZE_MS, DONT_BUG_MS } = await import('../../../domain/reminders.js');
        const { createInMemoryRecordsPort } = await import('./helpers/cloud-shim-harness.js');
        const records = createInMemoryRecordsPort();
        const fixedNow = 1_700_000_000_000;
        const domain = createRemindersDomain({ records, now: () => fixedNow });

        await domain.setBPEnabled(true, 18);
        const snoozed = await domain.snoozeBPReminder();
        expect(snoozed.enabled).toBe(true);
        expect(snoozed.preferred_reminder_hour).toBe(18);
        expect(snoozed.snoozed_until).toBe(fixedNow + SNOOZE_MS);

        const bugged = await domain.dontBugBPReminder();
        expect(bugged.dont_remind_until).toBe(fixedNow + DONT_BUG_MS);
        expect(bugged.snoozed_until).toBe(fixedNow + SNOOZE_MS); // not clobbered
        expect(bugged.enabled).toBe(true);

        // Toggling must not silently clear an active mute.
        const toggled = await domain.setBPEnabled(false);
        expect(toggled.snoozed_until).toBe(fixedNow + SNOOZE_MS);
        expect(toggled.dont_remind_until).toBe(fixedNow + DONT_BUG_MS);
    });
});
