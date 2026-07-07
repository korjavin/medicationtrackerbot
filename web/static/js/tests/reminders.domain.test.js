import { describe, expect, it } from 'vitest';
import { computeReminderHorizon } from '../../../domain/reminders.js';

describe('domain/reminders.js — horizon scheduling', () => {
    it('computes correct BP and weight reminder entries using configured timeZone, not system timezone', () => {
        // Assume system timezone is America/Los_Angeles or UTC, let's use Asia/Tokyo (+0900)
        // We will mock `now` to be 2026-07-07T12:00:00Z
        const nowMs = Date.UTC(2026, 6, 7, 12, 0, 0); // July 7, 2026 12:00:00 UTC
        const timeZone = 'Asia/Tokyo'; // JST is UTC+9. So local wall time is 21:00:00.

        const entries = computeReminderHorizon({
            medications: [], intakes: [], bps: [], weights: [], timeZone, now: nowMs,
            bpStatus: { enabled: true, preferred_reminder_hour: 20 },
            weightStatus: { enabled: true, preferred_reminder_hour: 9 }
        });

        // BP preferred hour is 20:00 JST.
        // Today's 20:00 JST is 11:00 UTC. Since now is 12:00 UTC, today's target is in the past.
        // Tomorrow's 20:00 JST is July 8, 2026 11:00 UTC.
        // Let's check the first BP reminder target in the output.
        const bpEntries = entries.filter(e => e.text.includes('blood pressure'));

        // Target: 2026-07-08T20:00:00 JST -> 2026-07-08T11:00:00 UTC
        const expectedNextBpTargetMs = Date.UTC(2026, 6, 8, 11, 0, 0);
        expect(bpEntries[0].fireAtUnix).toBe(expectedNextBpTargetMs / 1000);

        // Weight preferred hour is 09:00 JST.
        // Today's 09:00 JST is July 7, 00:00 UTC. Past.
        // Tomorrow's 09:00 JST is July 8, 00:00 UTC.
        const weightEntries = entries.filter(e => e.text.includes('weight'));
        const expectedNextWeightTargetMs = Date.UTC(2026, 6, 8, 0, 0, 0);
        expect(weightEntries[0].fireAtUnix).toBe(expectedNextWeightTargetMs / 1000);
    });
});
