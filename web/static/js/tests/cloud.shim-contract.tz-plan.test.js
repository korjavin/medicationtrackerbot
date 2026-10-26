// Plan 2026-07-05 cloud-c2b, Task 8 — shim-mode contract run of the TZ
// transition plan banner (web/static/js/features/tz-plan-banner.js) over
// web/domain/tzplan.js. Drives the real window.TZPlanBanner.refresh() /
// mountCard() through window.apiCall, which routes to the cloud shim
// (web/cloud/js/apishim.js) instead of the network — same pattern as
// cloud.shim-contract.bp.test.js.
import {
    afterEach, beforeEach, describe, expect, it, vi
} from 'vitest';
import {
    applyIncomingReplica, createInMemoryRecordsPort, createStampingRecordsPort, loadCloudShimFrontendEnv
} from './helpers/cloud-shim-harness.js';
import { createTzPlanDomain, planDosesWithTzPlan } from '../../../domain/tzplan.js';
import { createApiRouter } from '../../../cloud/js/apishim.js';

// Apply/Cancel round-trip twice — the POST, then the re-read refresh() does so
// the approved card can replace the pending one — so drain the queue instead of
// counting microtask ticks.
async function flushAsync() {
    for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 0); });
    }
}

function seedPendingPlan(overrides = {}) {
    return {
        recordId: 'tzplan-current',
        clientTs: Date.now(),
        deleted: false,
        old_tz: 'America/New_York',
        new_tz: 'Asia/Tokyo',
        status: 'PENDING_APPROVAL',
        created_at: new Date().toISOString(),
        steps: [
            {
                medicationId: 1, medName: 'Metformin', stepNumber: 1, totalSteps: 2, scheduledAtMs: Date.now() + 3600_000, note: 'Shift dose 1h'
            },
            {
                medicationId: 1, medName: 'Metformin', stepNumber: 2, totalSteps: 2, scheduledAtMs: Date.now() + 7200_000, note: 'Shift dose 2h'
            }
        ],
        ...overrides
    };
}

describe('cloud shim contract — TZ plan banner (features/tz-plan-banner.js over web/domain/tzplan.js)', () => {
    let env;

    beforeEach(() => {
        env = loadCloudShimFrontendEnv({ seedRecords: { tzplan: [seedPendingPlan()] } });
        env.window.reloadCurrentTab = vi.fn();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('renders the pending plan as an actionable card with Apply/Cancel', async () => {
        const { window, document } = env;

        await window.TZPlanBanner.refresh();
        const root = document.createElement('div');
        const card = window.TZPlanBanner.mountCard(root);

        expect(card).not.toBeNull();
        expect(card.querySelector('.wg-tz-plan-card__value').textContent).toContain('America/New_York');
        expect(card.querySelector('.wg-tz-plan-card__value').textContent).toContain('Asia/Tokyo');
        expect(card.querySelectorAll('button')).toHaveLength(2);

        // Kit T2 shape: a .wg-card with a globe lead, a plain steps list (no
        // <details> disclosure) and Cancel ghost / Apply primary kit buttons.
        expect(card.classList.contains('wg-card')).toBe(true);
        expect(card.querySelector('.wg-row__lead [data-wg-icon="globe"]')).not.toBeNull();
        expect(card.querySelector('details')).toBeNull();
        expect(card.querySelectorAll('.wg-tz-plan-card__steps li').length).toBeGreaterThan(0);
        const [cancel, apply] = card.querySelectorAll('.wg-card__foot > button');
        expect(cancel.textContent).toBe('Cancel');
        expect(cancel.className).toBe('wg-btn wg-btn--sm wg-btn--ghost');
        expect(apply.textContent).toBe('Apply');
        expect(apply.className).toBe('wg-btn wg-btn--sm wg-btn--primary');
    });

    it('Apply approves the plan and updates settings.timezone', async () => {
        const { window, document } = env;

        await window.TZPlanBanner.refresh();
        const root = document.createElement('div');
        const card = window.TZPlanBanner.mountCard(root);
        const applyBtn = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Apply');

        applyBtn.click();
        await flushAsync();

        expect(window.reloadCurrentTab).toHaveBeenCalled();
        const { plan } = await window.apiCall('/api/tz-plan/current');
        expect(plan.status).toBe('APPROVED');
        const settings = await window.apiCall('/api/settings');
        expect(settings.timezone).toBe('Asia/Tokyo');

        // The approved plan takes over the same card slot rather than leaving
        // an empty Today — the whole point of bd med-gut.3.
        const afterApply = window.TZPlanBanner.mountCard(document.createElement('div'));
        expect(afterApply).not.toBeNull();
        expect(afterApply.querySelector('.wg-tz-plan-card__title').textContent)
            .toBe('Transition in progress');
    });

    it('Cancel rejects the plan and reverts settings.timezone', async () => {
        const { window, document } = env;

        await window.TZPlanBanner.refresh();
        const root = document.createElement('div');
        const card = window.TZPlanBanner.mountCard(root);
        const cancelBtn = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Cancel');

        cancelBtn.click();
        await flushAsync();

        expect(window.reloadCurrentTab).toHaveBeenCalled();
        const { plan } = await window.apiCall('/api/tz-plan/current');
        expect(plan.status).toBe('REJECTED');
        const settings = await window.apiCall('/api/settings');
        expect(settings.timezone).toBe('America/New_York');

        // Rejected renders nothing.
        expect(window.TZPlanBanner.mountCard(document.createElement('div'))).toBeNull();
    });

    // bd med-gjsp — declining the plan declines the move: it records the
    // dismissal so the next boot in new_tz does not re-prompt.
    it('reject records dismissed_tz_suggestion = plan.new_tz; another zone still prompts', async () => {
        const { window } = env;
        const ask = (tz) => window.apiCall(`/api/tz-suggestion/should-prompt?detected_tz=${encodeURIComponent(tz)}`);

        // Pending plan already targets Tokyo → no prompt.
        expect((await ask('Asia/Tokyo')).prompt).toBe(false);

        await window.apiCall('/api/tz-plan/tzplan-current/reject', 'POST');

        const settings = await window.apiCall('/api/settings');
        expect(settings.timezone).toBe('America/New_York');
        expect(settings.dismissed_tz_suggestion).toBe('Asia/Tokyo');
        expect((await ask('Asia/Tokyo')).prompt).toBe(false);
        expect(await ask('Europe/Paris')).toEqual({ prompt: true, reason: '', current_tz: 'America/New_York' });
        expect((await ask('America/New_York')).prompt).toBe(false);
    });
});

describe('cloud shim contract — POST /api/settings returns the planner result (bd med-gjsp)', () => {
    let env;

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('no gradual-shift medication: applies immediately → { changed: true, planCreated: false }', async () => {
        env = loadCloudShimFrontendEnv({
            seedRecords: { settings: [{ recordId: 'settings', clientTs: Date.now(), deleted: false, timezone: 'Europe/Berlin' }] }
        });
        const res = await env.window.apiCall('/api/settings', 'POST', { timezone: 'Asia/Tokyo' });
        expect(res).toEqual({ changed: true, planCreated: false });
        expect((await env.window.apiCall('/api/settings')).timezone).toBe('Asia/Tokyo');
    });

    // bootstrap.js navigates to Today on planCreated: true (bd med-26gl).
    it('strict-policy medication: stages a plan → { changed: false, planCreated: true }, clock unmoved', async () => {
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                settings: [{ recordId: 'settings', clientTs: Date.now(), deleted: false, timezone: 'Europe/Berlin' }],
                medication: [{
                    recordId: 1,
                    clientTs: Date.now(),
                    deleted: false,
                    name: 'Metformin',
                    dosage: '500mg',
                    schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }),
                    archived: false,
                    start_date: null,
                    end_date: null,
                    tz_shift_policy: 'strict',
                    created_at: '2026-01-01T00:00:00.000Z'
                }]
            }
        });
        env.window.reloadCurrentTab = vi.fn();
        const res = await env.window.apiCall('/api/settings', 'POST', { timezone: 'Asia/Tokyo' });
        expect(res).toEqual({ changed: false, planCreated: true });
        expect((await env.window.apiCall('/api/settings')).timezone).toBe('Europe/Berlin');
        const { plan } = await env.window.apiCall('/api/tz-plan/current');
        expect(plan.status).toBe('PENDING_APPROVAL');
        expect(plan.new_tz).toBe('Asia/Tokyo');
        // Staged, not switched: no zone history until Apply (bd med-wi09.9).
        expect(await env.records.list('tztransition')).toHaveLength(0);
    });

    it('same zone → { changed: false, planCreated: false }', async () => {
        env = loadCloudShimFrontendEnv({
            seedRecords: { settings: [{ recordId: 'settings', clientTs: Date.now(), deleted: false, timezone: 'Asia/Tokyo' }] }
        });
        const res = await env.window.apiCall('/api/settings', 'POST', { timezone: 'Asia/Tokyo' });
        expect(res).toEqual({ changed: false, planCreated: false });
    });
});

// bd med-wi09.9 — zone history: one immutable tztransition-* per actual zone
// change, so the planner can regenerate the past. tzplan-current stays the
// banner's handle; nothing reads the history yet.
describe('zone history — tztransition-* on every zone change and plan approve (bd med-wi09.9)', () => {
    let env;

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('a flexible-only change writes one transition with no steps', async () => {
        env = loadCloudShimFrontendEnv({
            seedRecords: { settings: [{ recordId: 'settings', clientTs: 1, deleted: false, timezone: 'Europe/Berlin' }] }
        });
        await env.window.apiCall('/api/settings', 'POST', { timezone: 'Asia/Tokyo' });
        const rows = await env.records.list('tztransition');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            // No meds, so the lineage (bd med-wi09.10) cancels nothing.
            old_tz: 'Europe/Berlin', new_tz: 'Asia/Tokyo', steps: [], boundary: []
        });
        const sec = Math.floor(Date.parse(rows[0].switch_at) / 1000);
        expect(rows[0].recordId).toMatch(new RegExp(`^tztransition-${sec}-[a-z0-9]+$`));

        // Same zone again: no change, no row.
        await env.window.apiCall('/api/settings', 'POST', { timezone: 'Asia/Tokyo' });
        expect(await env.records.list('tztransition')).toHaveLength(1);
    });

    it('Apply writes one transition carrying the plan steps; Cancel writes none', async () => {
        env = loadCloudShimFrontendEnv({ seedRecords: { tzplan: [seedPendingPlan()] } });
        await env.window.apiCall('/api/tz-plan/tzplan-current/approve', 'POST');
        const [row] = await env.records.list('tztransition');
        expect(row).toMatchObject({ old_tz: 'America/New_York', new_tz: 'Asia/Tokyo', boundary: [] });
        expect(row.steps.map((s) => s.stepNumber)).toEqual([1, 2]);

        env.cleanup();
        env = loadCloudShimFrontendEnv({ seedRecords: { tzplan: [seedPendingPlan()] } });
        await env.window.apiCall('/api/tz-plan/tzplan-current/reject', 'POST');
        expect(await env.records.list('tztransition')).toHaveLength(0);
    });
});

// bd med-gut.3 — an APPROVED plan used to vanish from the UI while its steps
// kept shifting dose times, so the user saw "something happened but what
// exactly is unclear". The card now stays on Today, read-only, until
// refreshPlanStatus flips the plan to COMPLETED.
describe('TZ plan banner — approved plan in progress (bd med-gut.3)', () => {
    let env;

    // Two meds, seeded grouped-by-medication rather than chronologically —
    // that is how internal/domain/tzreschedule/engine.go emits StepsJSON (it
    // appends per med and never sorts across meds), so the banner has to order
    // them itself before picking "next".
    function seedApprovedPlan() {
        const nowMs = Date.now();
        return seedPendingPlan({
            status: 'APPROVED',
            approved_at: new Date(nowMs).toISOString(),
            steps: [
                {
                    medicationId: 1, medName: 'Metformin', stepNumber: 1, totalSteps: 2, scheduledAtMs: nowMs - 3600_000, note: 'Metformin: step 1/2 — already shifted'
                },
                {
                    medicationId: 1, medName: 'Metformin', stepNumber: 2, totalSteps: 2, scheduledAtMs: nowMs + 7200_000, note: 'Metformin: step 2/2 — 09:00 EST old / 23:00 JST new'
                },
                {
                    medicationId: 2, medName: 'Lisinopril', stepNumber: 1, totalSteps: 1, scheduledAtMs: nowMs + 3600_000, note: 'Lisinopril: step 1/1 — 08:00 EST old / 22:00 JST new'
                }
            ]
        });
    }

    beforeEach(() => {
        env = loadCloudShimFrontendEnv({ seedRecords: { tzplan: [seedApprovedPlan()] } });
        env.window.reloadCurrentTab = vi.fn();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('renders a read-only in-progress card with direction, progress, next dose and remaining steps', async () => {
        const { window, document } = env;

        await window.TZPlanBanner.refresh();
        const root = document.createElement('div');
        const card = window.TZPlanBanner.mountCard(root);

        expect(card).not.toBeNull();
        expect(card.querySelector('.wg-tz-plan-card__title').textContent).toBe('Transition in progress');

        const value = card.querySelector('.wg-tz-plan-card__value').textContent;
        expect(value).toContain('America/New_York');
        expect(value).toContain('Asia/Tokyo');

        const details = [...card.querySelectorAll('.wg-tz-plan-card__detail')].map((el) => el.textContent);
        expect(details[0]).toBe('1 of 3 steps done');
        // Soonest remaining step wins, not the first one in the array.
        expect(details[1]).toContain('Next shifted dose:');
        expect(details[1]).toContain('Lisinopril');

        // Read-only: no Apply/Cancel on an already-approved plan.
        expect(card.querySelectorAll('button')).toHaveLength(0);

        // Progress strip: one .wg-steps tick per step, done ones then "now".
        const ticks = [...card.querySelectorAll('.wg-steps > i')].map((i) => i.className);
        expect(ticks).toEqual(['is-done', 'is-now', '']);

        // Only the two future steps are "remaining"; the past one is dropped,
        // and the rest are listed chronologically.
        expect(card.querySelector('.wg-tz-plan-card__steps-title').textContent)
            .toBe('2 transition doses left');
        const notes = [...card.querySelectorAll('.wg-tz-plan-card__steps li')]
            .map((li) => li.textContent);
        expect(notes).toEqual([
            'Lisinopril: step 1/1 — 08:00 EST old / 22:00 JST new',
            'Metformin: step 2/2 — 09:00 EST old / 23:00 JST new'
        ]);
    });

    it('stops rendering once the last step is past; the read itself flips the status', async () => {
        const { window, document } = env;

        await window.TZPlanBanner.refresh();
        expect(window.TZPlanBanner.mountCard(document.createElement('div'))).not.toBeNull();

        // Push every step into the past without touching the status. There is
        // no sweep to complete the plan any more (bd med-wi09.12): the next
        // read of the current plan does, so a tab left open never keeps an
        // in-progress card with nothing left in it.
        window.reloadCurrentTab.mockClear();
        const [rec] = await env.records.list('tzplan');
        await env.records.put('tzplan', {
            ...rec,
            steps: rec.steps.map((s) => ({ ...s, scheduledAtMs: Date.now() - 3600_000 }))
        });

        await window.TZPlanBanner.refresh();
        const { plan } = await window.apiCall('/api/tz-plan/current');
        expect(plan.status).toBe('COMPLETED');
        expect(window.TZPlanBanner.mountCard(document.createElement('div'))).toBeNull();
        // The step count is part of the render key, so the already-mounted card
        // gets repainted away rather than lingering until an unrelated render.
        expect(window.reloadCurrentTab).toHaveBeenCalled();
    });

    it('drops the card once every step is past and refreshPlanStatus flips the plan to COMPLETED', async () => {
        const { window, document } = env;

        await window.TZPlanBanner.refresh();
        expect(window.TZPlanBanner.mountCard(document.createElement('div'))).not.toBeNull();
        window.reloadCurrentTab.mockClear();

        // Same call getCurrentPlan makes on every read, on a clock past the
        // last step — driven explicitly so the flip is deterministic.
        const afterAllSteps = Date.now() + 24 * 3600_000;
        await createTzPlanDomain({
            records: env.records, now: () => afterAllSteps, timeZone: 'UTC'
        }).refreshPlanStatus();

        const { plan } = await window.apiCall('/api/tz-plan/current');
        expect(plan.status).toBe('COMPLETED');

        await window.TZPlanBanner.refresh();
        expect(window.TZPlanBanner.mountCard(document.createElement('div'))).toBeNull();
        expect(window.reloadCurrentTab).toHaveBeenCalled();
    });
});

// planDosesWithTzPlan suppression rule — mirrors the server's
// MedsWithFuturePendingTZStepsForPlan gate: a med's normal doses are only
// dropped while that med still has a FUTURE step. In a multi-med plan an
// early-finishing med must resume its normal schedule even though the plan is
// still APPROVED because another med has steps left.
describe('planDosesWithTzPlan — per-med future-step suppression (web/domain/tzplan.js)', () => {
    it('resumes an early-finishing med\'s normal doses while a later med still has future steps', () => {
        const now = Date.UTC(2026, 0, 15, 6, 0); // 06:00 UTC
        const window = 12 * 3600_000; // 12h forecast
        const timeZone = 'UTC';

        // Both meds dose daily at 12:00 UTC → next dose is now+6h (in window).
        const medications = [
            { id: 1, name: 'MedA', schedule: '12:00' },
            { id: 2, name: 'MedB', schedule: '12:00' }
        ];

        const tzPlan = {
            recordId: 'tzplan-current',
            status: 'APPROVED',
            steps: [
                // MedA finished: its only step is already in the past.
                { medicationId: 1, medName: 'MedA', scheduledAtMs: now - 3600_000, stepNumber: 1 },
                // MedB still transitioning: a step 9h out, i.e. its transition
                // is still running when its normal now+6h dose would land.
                { medicationId: 2, medName: 'MedB', scheduledAtMs: now + 9 * 3600_000, stepNumber: 1 }
            ]
        };

        const targets = planDosesWithTzPlan({
            medications, timeZone, now, window, tzPlan
        });

        const medANormal = targets.filter((t) => t.medicationId === 1 && t.source === 'normal_schedule');
        const medBNormal = targets.filter((t) => t.medicationId === 2 && t.source === 'normal_schedule');
        const medBStep = targets.filter((t) => t.medicationId === 2 && t.source === 'tz_step');

        // MedA (no future step) resumes its normal schedule...
        expect(medANormal).toHaveLength(1);
        // ...while MedB (mid-transition) stays suppressed and shows its step.
        expect(medBNormal).toHaveLength(0);
        expect(medBStep).toHaveLength(1);
    });

    // The suppression is judged per TARGET, not once against `now`. Judging it
    // once meant a forecast dropped every normal dose in the window as soon as
    // the med had any future step — including doses landing well AFTER the
    // last step, which the projection regenerates once that instant
    // arrives. The forecast then under-reported reality and the reminder
    // horizon skipped a real dose.
    it('keeps a normal dose that lands after the medication\'s last step', () => {
        const now = Date.UTC(2026, 0, 15, 0, 0);
        const timeZone = 'UTC';
        const medications = [{ id: 1, name: 'MedA', schedule: '20:00' }];
        const tzPlan = {
            recordId: 'tzplan-current',
            status: 'APPROVED',
            steps: [{ medicationId: 1, medName: 'MedA', scheduledAtMs: now + 2 * 3600_000, stepNumber: 1, totalSteps: 1 }]
        };

        const targets = planDosesWithTzPlan({
            medications, timeZone, now, window: 24 * 3600_000, tzPlan
        });

        expect(targets.map((t) => [t.source, t.scheduledAtMs - now])).toEqual([
            ['tz_step', 2 * 3600_000],
            ['normal_schedule', 20 * 3600_000]
        ]);
    });

    // Fire mode is unchanged: every target is at-or-before `now`, so any step
    // still ahead covers them all and the med stays fully suppressed.
    it('still suppresses a due normal dose while a step is ahead of it (fire mode)', () => {
        const now = Date.UTC(2026, 0, 15, 21, 0);
        const targets = planDosesWithTzPlan({
            medications: [{ id: 1, name: 'MedA', schedule: '20:00' }],
            timeZone: 'UTC',
            now,
            window: 0,
            tzPlan: {
                recordId: 'tzplan-current',
                status: 'APPROVED',
                steps: [{ medicationId: 1, medName: 'MedA', scheduledAtMs: now + 2 * 3600_000, stepNumber: 1 }]
            }
        });

        expect(targets).toEqual([]);
    });
});

// bd med-y4ue — refreshPlanStatus is a TIMER-side read/write on the singleton
// plan record, so a device whose mirror is stale must not be able to complete a
// plan another device has already replaced with a fresh PENDING_APPROVAL. Two
// ports + the harness replicas of sync.js's nextClientTs promotion (which turns
// the derived floor into "beats exactly what I read") and applyIncoming's
// strict `>` merge.
describe('TZ plan — a stale refreshPlanStatus cannot complete a newer pending plan (bd med-y4ue)', () => {
    const T0 = Date.UTC(2026, 0, 15, 8, 0);

    // The approved plan both devices hold, every step already in the past.
    const approvedPlan = () => ({
        recordId: 'tzplan-current', clientTs: T0, deleted: false,
        old_tz: 'America/New_York', new_tz: 'Asia/Tokyo', status: 'APPROVED',
        created_at: new Date(T0).toISOString(),
        approved_at: new Date(T0).toISOString(),
        steps: [{
            medicationId: 1, medName: 'Metformin', stepNumber: 1, totalSteps: 1,
            scheduledAtMs: T0 - 3600_000, note: 'Shift dose 1h'
        }]
    });

    it('the timer-side COMPLETED write loses the merge against a PENDING_APPROVAL it never saw', async () => {
        const freshPort = createStampingRecordsPort({ tzplan: [approvedPlan()] });
        const stalePort = createStampingRecordsPort({ tzplan: [approvedPlan()] });

        // Fresh device: the user travels again, so proposeTimezoneChange
        // overwrites the singleton with a new pending plan (a real write).
        await freshPort.put('tzplan', {
            ...approvedPlan(),
            clientTs: T0 + 60_000, new_tz: 'Europe/Berlin', status: 'PENDING_APPROVAL',
            approved_at: undefined,
            steps: [{
                medicationId: 1, medName: 'Metformin', stepNumber: 1, totalSteps: 1,
                scheduledAtMs: T0 + 7200_000, note: 'Shift dose 2h'
            }]
        });
        const pending = (await freshPort.list('tzplan'))[0];

        // Stale device: never pulled that op; its materialization sweep fires a
        // day later and sees only past steps on an APPROVED plan.
        await createTzPlanDomain({
            records: stalePort, now: () => T0 + 24 * 3600_000, timeZone: 'UTC'
        }).refreshPlanStatus();
        const completed = (await stalePort.list('tzplan'))[0];
        expect(completed.status).toBe('COMPLETED');  // still flipped locally
        expect(completed.clientTs).toBe(T0 + 1);     // floored to what it read

        const merged = applyIncomingReplica(pending, completed);
        expect(merged.status).toBe('PENDING_APPROVAL');
        expect(merged.new_tz).toBe('Europe/Berlin');
    });
});

// bd med-7ujt — the shim used to hand the DEVICE zone to every domain factory,
// so a user who pinned a zone in Settings still got device-zone wall-clock math
// everywhere (day buckets, forecasts, the reminders horizon). The pinned zone
// lives in the vault, so the router resolves it asynchronously and rebuilds its
// domains on it; these two cases pin the precedence in both directions.
describe('cloud shim contract — settings.timezone drives the router clock', () => {
    // 13:00 in Berlin, 21:00 in Tokyo.
    const NOW = Date.UTC(2026, 2, 10, 12, 0, 0);
    // One Tokyo day (both readings fall on Mar 10 JST), two Berlin days (Mar 9 +
    // Mar 10) — which is exactly what stats_14.days counts.
    const seedBP = () => ({
        bp: [
            {
                recordId: 'bp-1', clientTs: NOW, deleted: false, measured_at: '2026-03-09T16:30:00.000Z', systolic: 120, diastolic: 80
            },
            {
                recordId: 'bp-2', clientTs: NOW, deleted: false, measured_at: '2026-03-10T08:00:00.000Z', systolic: 130, diastolic: 85
            }
        ]
    });
    const pinned = (timezone) => ({
        settings: [{
            recordId: 'settings', clientTs: NOW, deleted: false, timezone
        }]
    });

    let tzEnv;

    function setup(seedRecords) {
        tzEnv = loadCloudShimFrontendEnv({
            seedRecords, now: () => NOW, timeZone: 'Europe/Berlin'
        });
        return tzEnv;
    }

    afterEach(() => {
        if (tzEnv) tzEnv.cleanup();
        tzEnv = null;
    });

    it('buckets a BP day on the pinned zone, not the device zone', async () => {
        const { window } = setup({ ...seedBP(), ...pinned('Asia/Tokyo') });

        const stats = await window.offlineAwareApiCall('/api/bp/stats', 'GET');
        expect(stats.stats_14.days).toBe(1);

        const settings = await window.offlineAwareApiCall('/api/settings', 'GET');
        expect(settings.timezone).toBe('Asia/Tokyo');
    });

    it('falls back to the device zone when no timezone is pinned', async () => {
        const { window } = setup(seedBP());

        const stats = await window.offlineAwareApiCall('/api/bp/stats', 'GET');
        expect(stats.stats_14.days).toBe(2);
    });

    it('a mid-session pin re-buckets without a reload', async () => {
        const { window } = setup(seedBP());

        expect((await window.offlineAwareApiCall('/api/bp/stats', 'GET')).stats_14.days).toBe(2);

        // No medications seeded, so this writes settings.timezone straight
        // through instead of staging a transition plan.
        await window.offlineAwareApiCall('/api/settings', 'POST', { timezone: 'Asia/Tokyo' });

        expect((await window.offlineAwareApiCall('/api/bp/stats', 'GET')).stats_14.days).toBe(1);
    });
});

// bd med-wi09.26 — a travel-prompt dismissal holds for every dismissed
// detected zone (dismissed_tz_suggestions) beside the legacy string, so two
// devices off-zone at once in different zones stop re-prompting each other.
describe('travel prompt dismissals across devices (bd med-wi09.26)', () => {
    let clock;
    const device = (records, timeZone) => {
        const call = createApiRouter({}, {
            records, win: {}, effects: {}, now: () => clock, timeZone,
        });
        return {
            asks: async (tz) => (await call(`/api/tz-suggestion/should-prompt?detected_tz=${encodeURIComponent(tz)}`)).prompt,
            dismiss: (tz) => call('/api/tz-suggestion/dismiss', 'POST', { detected_tz: tz }),
            call,
        };
    };
    const sync = async (from, to) => {
        for (const r of await from.listRaw('settings')) {
            const cur = (await to.listRaw('settings')).find((x) => x.recordId === r.recordId);
            const won = applyIncomingReplica(cur, r);
            if (won !== cur) await to.put('settings', won);
        }
    };
    const berlin = (extra = {}) => ({
        settings: [{
            recordId: 'settings', clientTs: 1, deleted: false, timezone: 'Europe/Berlin', ...extra,
        }],
    });
    const stored = async (records) => (await records.list('settings'))[0];
    // What a pre-med-wi09.26 bundle decides: the string alone.
    const oldBundleSkips = (rec, tz) => rec.timezone === tz || rec.dismissed_tz_suggestion === tz;
    const tick = () => { clock += 60_000; };

    beforeEach(() => { clock = Date.UTC(2026, 9, 1); });

    it('A (UTC) and B (New York) dismiss in turn: neither prompts on the next launch; a zone change clears both and re-asks once', async () => {
        const a = createInMemoryRecordsPort(berlin());
        const b = createInMemoryRecordsPort();
        await sync(a, b);
        const onA = device(a, 'UTC');
        const onB = device(b, 'America/New_York');

        expect(await onA.asks('UTC')).toBe(true);
        tick(); await onA.dismiss('UTC');
        await sync(a, b);
        expect(await onB.asks('America/New_York')).toBe(true);
        tick(); await onB.dismiss('America/New_York');
        await sync(b, a);

        expect(await onA.asks('UTC')).toBe(false);
        expect(await onB.asks('America/New_York')).toBe(false);
        const rec = await stored(a);
        expect(rec).toMatchObject({
            dismissed_tz_suggestion: 'America/New_York',
            dismissed_tz_suggestions: ['UTC', 'America/New_York'],
        });
        // The legacy string keeps its meaning: an old bundle on B skips, an
        // old bundle on A re-asks (once: its dismissal writes the string).
        expect(oldBundleSkips(rec, 'America/New_York')).toBe(true);
        expect(oldBundleSkips(rec, 'UTC')).toBe(false);

        // An actual zone change (the prompt's accept on B) clears both.
        tick();
        expect(await onB.call('/api/settings', 'POST', { timezone: 'Asia/Tokyo' })).toEqual({ changed: true, planCreated: false });
        await sync(b, a);
        expect(await stored(a)).toMatchObject({ timezone: 'Asia/Tokyo', dismissed_tz_suggestion: '', dismissed_tz_suggestions: [] });
        expect(await onA.asks('UTC')).toBe(true);
        tick(); await onA.dismiss('UTC');
        expect(await onA.asks('UTC')).toBe(false);
        expect(await onB.asks('America/New_York')).toBe(true);
    });

    it('re-saving the same zone keeps the dismissals', async () => {
        const a = createInMemoryRecordsPort(berlin({ dismissed_tz_suggestion: 'UTC', dismissed_tz_suggestions: ['UTC'] }));
        const onA = device(a, 'UTC');
        tick(); await onA.call('/api/settings', 'POST', { timezone: 'Europe/Berlin' });
        expect(await onA.asks('UTC')).toBe(false);
    });

    it('an old-bundle record (string only) still suppresses, and its zone joins the list on the next dismissal', async () => {
        const a = createInMemoryRecordsPort(berlin({ dismissed_tz_suggestion: 'UTC' }));
        const onA = device(a, 'UTC');
        expect(await onA.asks('UTC')).toBe(false);
        expect(await onA.asks('America/New_York')).toBe(true);
        tick(); await onA.dismiss('America/New_York');
        expect(await onA.asks('UTC')).toBe(false);
        expect(await onA.asks('America/New_York')).toBe(false);
        expect((await stored(a)).dismissed_tz_suggestions).toEqual(['UTC', 'America/New_York']);
    });

    it('a zone change by an old bundle (clears the string, carries the list) leaves no stale dismissal', async () => {
        const a = createInMemoryRecordsPort(berlin({
            dismissed_tz_suggestion: 'America/New_York', dismissed_tz_suggestions: ['UTC', 'America/New_York'],
        }));
        const rec = await stored(a);
        tick();
        await a.put('settings', {
            ...rec, clientTs: clock, timezone: 'Asia/Tokyo', dismissed_tz_suggestion: '',
        });
        const onA = device(a, 'UTC');
        expect(await onA.asks('UTC')).toBe(true);
        expect(await onA.asks('America/New_York')).toBe(true);
        expect((await onA.call('/api/settings')).timezone).toBe('Asia/Tokyo');
    });

    it('the list is deduped and keeps the newest ten', async () => {
        const a = createInMemoryRecordsPort(berlin());
        const onA = device(a, 'UTC');
        const zones = Array.from({ length: 12 }, (_, i) => `Etc/GMT+${i + 1}`);
        for (const z of [...zones, 'Etc/GMT+5']) {
            tick();
            await onA.dismiss(z);
        }
        const rec = await stored(a);
        expect(rec.dismissed_tz_suggestion).toBe('Etc/GMT+5');
        expect(rec.dismissed_tz_suggestions).toEqual([...zones.slice(2).filter((z) => z !== 'Etc/GMT+5'), 'Etc/GMT+5']);
        expect(await onA.asks('Etc/GMT+1')).toBe(true);
        expect(await onA.asks('Etc/GMT+12')).toBe(false);
    });
});
