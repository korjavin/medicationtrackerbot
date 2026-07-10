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
