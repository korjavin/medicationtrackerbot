// Plan 2026-07-06 cloud-c2d, Task 7 — the two-domain-instance convergence
// case called out in the plan's Testing Strategy: two devices concurrently
// resolving getNext() for the same rotating group must not fork into two
// session records. Pure domain-level test (no jsdom) — the deterministic
// sessionRecordId(groupId, date) slot is the load-bearing property, not any
// browser wiring.
import { describe, expect, it } from 'vitest';
import { createWorkoutDomain } from '../../../domain/workout.js';
import { createInMemoryRecordsPort } from './helpers/cloud-shim-harness.js';

describe('two-instance lazy getNext convergence', () => {
    it('two devices resolving next for the same group+day converge on one session record', async () => {
        const nowMs = Date.now();
        const records = createInMemoryRecordsPort({
            workoutgroup: [{
                recordId: 'group-1', clientTs: nowMs, deleted: false, id: 1, user_id: 1, name: 'Push',
                is_rotating: false, days_of_week: '[0,1,2,3,4,5,6]', scheduled_time: '23:59',
                notification_advance_minutes: 0, active: true,
                created_at: new Date(nowMs).toISOString(), updated_at: new Date(nowMs).toISOString()
            }],
            workoutvariant: [{
                recordId: 'variant-1', clientTs: nowMs, deleted: false, id: 1, group_id: 1, name: 'A',
                rotation_order: 0, created_at: new Date(nowMs).toISOString()
            }]
        });

        const deviceA = createWorkoutDomain({ records, now: () => nowMs, timeZone: 'UTC' });
        const deviceB = createWorkoutDomain({ records, now: () => nowMs + 5, timeZone: 'UTC' });

        const [resA, resB] = await Promise.all([deviceA.getNext(), deviceB.getNext()]);

        expect(resA).not.toBeNull();
        expect(resB).not.toBeNull();
        // Same deterministic slot: both writes hit the same recordId, so only
        // one session record survives regardless of which write landed last.
        const sessions = await records.list('workoutsession');
        expect(sessions).toHaveLength(1);
        // Whichever body won, both devices' next resolution names its id —
        // there is no second, orphaned session lurking under a different id.
        expect([resA.session.id, resB.session.id]).toContain(sessions[0].id);
    });
});

describe('createMiBand deterministic recordId convergence', () => {
    it('re-calling with the same recordId overwrites rather than duplicating', async () => {
        const nowMs = Date.now();
        const records = createInMemoryRecordsPort({});
        const domain = createWorkoutDomain({ records, now: () => nowMs, timeZone: 'UTC' });

        const first = await domain.createMiBand({ recordId: 'tg-42', activityName: 'Bicycle', durationSec: 600 });
        const second = await domain.createMiBand({ recordId: 'tg-42', activityName: 'Bicycle', durationSec: 600 });

        const rows = await records.list('miband');
        expect(rows).toHaveLength(1);
        // Same deterministic numeric id survives the re-drain (edits key on it).
        expect(second.id).toBe(first.id);
        expect(rows[0].source).toBe('manual');
        expect(rows[0].activity_type).toBe(0);
        expect(rows[0].duration_sec).toBe(600);
        expect(second.activity_name).toBe('Bicycle');
    });
});

// bd med-9a87: getNext is a READ that WRITES — it materializes the day's
// session into the deterministic sessionRecordId slot. In production a second
// browser whose mirror predated the workout re-derived today's slot as PENDING
// hours after it was completed; stamped with now() that placeholder was the
// newest write, so LWW erased the finished session (history lost it, its
// exercise logs orphaned onto a dead session id, and the reminder
// un-suppressed). A materialized row must lose every merge against a real one.
describe('stale-device re-materialization vs. a completed session', () => {
    // The merge sync.js applyIncoming performs on every pulled record.
    const lww = (existing, incoming) => (!existing || incoming.clientTs > existing.clientTs ? incoming : existing);

    it('materializes the day slot at the LWW floor, so a stale device cannot erase a completed workout', async () => {
        const nowMs = Date.UTC(2026, 7, 31, 16, 0, 0);
        const seed = () => ({
            workoutgroup: [{
                recordId: 'group-1', clientTs: nowMs, deleted: false, id: 1, user_id: 1, name: 'Evening',
                is_rotating: false, days_of_week: '[0,1,2,3,4,5,6]', scheduled_time: '18:00',
                notification_advance_minutes: 0, active: true,
                created_at: new Date(nowMs).toISOString(), updated_at: new Date(nowMs).toISOString()
            }],
            workoutvariant: [{
                recordId: 'variant-1', clientTs: nowMs, deleted: false, id: 1, group_id: 1, name: 'LEGS',
                rotation_order: 0, created_at: new Date(nowMs).toISOString()
            }]
        });

        // Live device: materialize today's slot, then actually do the workout.
        const live = createInMemoryRecordsPort(seed());
        const domain = createWorkoutDomain({ records: live, now: () => nowMs, timeZone: 'UTC' });
        const next = await domain.getNext();
        await domain.startSession(next.session.id);
        await domain.setSessionStatus(next.session.id, 'completed');
        const completed = (await live.list('workoutsession'))[0];
        expect(completed.status).toBe('completed');

        // Stale device: its mirror never saw today's slot, so getNext re-derives
        // one — later on the wall clock than the completion it does not know about.
        const stale = createInMemoryRecordsPort(seed());
        const staleDomain = createWorkoutDomain({
            records: stale, now: () => nowMs + 3 * 60 * 60 * 1000, timeZone: 'UTC'
        });
        await staleDomain.getNext();
        const placeholder = (await stale.list('workoutsession'))[0];
        expect(placeholder.recordId).toBe(completed.recordId); // same deterministic slot
        expect(placeholder.status).toBe('pending');

        // Merging the stale placeholder must not disturb the completed session.
        const merged = lww(completed, placeholder);
        expect(merged.status).toBe('completed');
        expect(merged.id).toBe(completed.id);
    });
});
