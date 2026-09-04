// Plan 2026-07-06 cloud-c2d, Task 7 — the two-domain-instance convergence
// case called out in the plan's Testing Strategy: two devices concurrently
// resolving getNext() for the same rotating group must not fork into two
// session records. Pure domain-level test (no jsdom) — the deterministic
// sessionRecordId(groupId, date) slot is the load-bearing property, not any
// browser wiring.
import { describe, expect, it } from 'vitest';
import { createWorkoutDomain } from '../../../domain/workout.js';
import { createInMemoryRecordsPort } from './helpers/cloud-shim-harness.js';

// A local REPLICA of the comparison web/cloud/js/sync.js applyIncoming makes on
// every pulled record: strict `>` on clientTs, so equal stamps leave the
// existing row in place. Shared by the two-port suites below.
const applyIncoming = (existing, incoming) => (
    !existing || incoming.clientTs > existing.clientTs ? incoming : existing
);

const seedGroup = (nowMs) => ({
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

// bd med-8j12: the schedule-materialized session's numeric body id used to come
// from mintNumericId (now() + Math.random()), so two devices filling the same
// deterministic `session-<group>-<date>` slot produced two DIFFERENT bodies. At
// the med-9a87 clientTs floor both sit at 0 and applyIncoming's strict `>` means
// neither displaces the other: each device keeps its own numeric id, exercise
// logs attach to both, and the loser's orphan on the first real transition.
describe('two-device getNext materialization (two ports, applyIncoming merge)', () => {
    it('two independent domains materializing the same slot produce byte-identical bodies', async () => {
        const nowMs = Date.UTC(2026, 7, 31, 10, 0, 0);
        // Two devices, two separate stores — nothing is shared but the schedule.
        const portA = createInMemoryRecordsPort(seedGroup(nowMs));
        const portB = createInMemoryRecordsPort(seedGroup(nowMs));
        const deviceA = createWorkoutDomain({ records: portA, now: () => nowMs, timeZone: 'UTC' });
        // Different clock: the id must not depend on when the device derived it.
        const deviceB = createWorkoutDomain({
            records: portB, now: () => nowMs + 7 * 60 * 60 * 1000, timeZone: 'UTC'
        });

        const [resA, resB] = await Promise.all([deviceA.getNext(), deviceB.getNext()]);
        expect(resA).not.toBeNull();
        expect(resB).not.toBeNull();

        const bodyA = (await portA.list('workoutsession'))[0];
        const bodyB = (await portB.list('workoutsession'))[0];
        expect(bodyA.recordId).toBe(bodyB.recordId);
        expect(bodyA.clientTs).toBe(0); // still the derived-state floor (med-9a87)
        expect(bodyA.id).toBe(bodyB.id);
        expect(bodyB).toEqual(bodyA); // byte-identical, id included
        expect(Number.isSafeInteger(bodyA.id)).toBe(true);
        expect(resA.session.id).toBe(resB.session.id);

        // Sync each device's row into the other: with identical bodies at the
        // floor, applyIncoming's strict `>` is a no-op and both mirrors agree.
        expect(applyIncoming(bodyA, bodyB)).toEqual(bodyA);
        expect(applyIncoming(bodyB, bodyA)).toEqual(bodyB);
    });

    it('a log written on one device resolves against the other device\'s session', async () => {
        const nowMs = Date.UTC(2026, 7, 31, 10, 0, 0);
        const portA = createInMemoryRecordsPort(seedGroup(nowMs));
        const portB = createInMemoryRecordsPort(seedGroup(nowMs));
        const deviceA = createWorkoutDomain({ records: portA, now: () => nowMs, timeZone: 'UTC' });
        const deviceB = createWorkoutDomain({ records: portB, now: () => nowMs + 1000, timeZone: 'UTC' });

        const resA = await deviceA.getNext();
        const resB = await deviceB.getNext();

        // Device A starts the workout; that real write (clientTs = now()) beats
        // the floor and propagates to B.
        await deviceA.startSession(resA.session.id);
        const started = (await portA.list('workoutsession'))[0];
        const bMirror = (await portB.list('workoutsession'))[0];
        const mergedOnB = applyIncoming(bMirror, started);
        expect(mergedOnB.status).toBe('in_progress');
        // The surviving body carries the id B had already been logging against,
        // so nothing B attached to its session orphans.
        expect(mergedOnB.id).toBe(resB.session.id);
    });

    it('derived session ids sit in a band mintNumericId can never reach', async () => {
        const nowMs = Date.UTC(2026, 7, 31, 10, 0, 0);
        const records = createInMemoryRecordsPort(seedGroup(nowMs));
        const domain = createWorkoutDomain({ records, now: () => nowMs, timeZone: 'UTC' });

        const derivedId = (await domain.getNext()).session.id;
        // Ad-hoc sessions keep the minted (clock-stamped) id.
        const adhoc = await domain.createAdHocSession();

        expect(derivedId).toBeLessThan(1e14);
        expect(derivedId).toBeGreaterThanOrEqual(1e12);
        expect(adhoc.id).toBeGreaterThan(1e14);
        expect(Number.isSafeInteger(adhoc.id)).toBe(true);
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
// This is a domain-layer test: it does not go through the records port, so
// nextClientTs' skew correction and its promotion of a floored row over an
// existing raw row (tombstone included) are NOT covered here — see bd med-qhpu.
describe('stale-device re-materialization vs. a completed session', () => {
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
        const merged = applyIncoming(completed, placeholder);
        expect(merged.status).toBe('completed');
        expect(merged.id).toBe(completed.id);
    });
});
