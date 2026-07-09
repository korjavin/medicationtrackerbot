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

// bd med-76c.1 — Telegram reminders transit the cloud relay as plaintext, so
// every entry must carry a name-free twin the user can opt into, and the
// delivery/verbosity pref must default to the documented values.
describe('domain/reminders.js — Telegram delivery pref + generic verbosity', () => {
    it('every horizon entry carries a genericText with no medication name in it', () => {
        const nowMs = Date.UTC(2026, 6, 7, 6, 0, 0);
        const entries = computeReminderHorizon({
            medications: [{ id: 'm1', name: 'Lisinopril', dosage: '10 mg', schedule: '20:00' }],
            intakes: [],
            bps: [], weights: [],
            timeZone: 'UTC',
            now: nowMs,
            bpStatus: { enabled: true, preferred_reminder_hour: 20 },
            weightStatus: { enabled: true, preferred_reminder_hour: 9 },
        });

        expect(entries.length).toBeGreaterThan(0);
        for (const e of entries) {
            expect(typeof e.genericText).toBe('string');
            expect(e.genericText.length).toBeGreaterThan(0);
            expect(e.genericText).not.toContain('Lisinopril');
        }
        // The detailed text still names the drug — that is the default channel payload.
        expect(entries.some((e) => e.text.includes('Lisinopril'))).toBe(true);
    });

    it('delivery pref defaults to webpush/detailed and round-trips, ignoring invalid values', async () => {
        const { createRemindersDomain } = await import('../../../domain/reminders.js');
        const { createInMemoryRecordsPort } = await import('./helpers/cloud-shim-harness.js');
        const records = createInMemoryRecordsPort();
        const domain = createRemindersDomain({ records, now: () => 1_700_000_000_000 });

        expect(await domain.getDeliveryPref()).toEqual({ delivery: 'webpush', verbosity: 'detailed' });

        expect(await domain.setDeliveryPref({ delivery: 'both', verbosity: 'generic' }))
            .toEqual({ delivery: 'both', verbosity: 'generic' });

        // Garbage keeps the stored value rather than silently resetting to defaults.
        expect(await domain.setDeliveryPref({ delivery: 'carrier-pigeon', verbosity: 'shouty' }))
            .toEqual({ delivery: 'both', verbosity: 'generic' });
    });
});
