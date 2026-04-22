// Wandergeek Meds next-action card (Phase 5, Task 3).
//
// Covers the pure renderNextActionCard helper exported as a script-scope
// global from features/meds.js: primary state with subtitle "Next · HH:MM ·
// in Xh Ym", >3 names truncation to "Name1 · Name2 · +N", empty state with
// hidden Take button, and Take-button dispatch via opts.onTake (so tests do
// not have to reach into the global modal stack). Also asserts that
// mountNextActionCard() pushes the rendered card into #med-next-action.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('Meds next-action card (Phase 5, Task 3)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    function makeMeds(names) {
        return names.map((name, idx) => ({
            id: idx + 1,
            name,
            dosage: '10mg',
            schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }),
            archived: false
        }));
    }

    it('renders subtitle, names, and a Take button when an upcoming dose is within the 24h window', () => {
        const { window } = env;
        const now = new Date('2026-04-22T07:30:00Z');
        const scheduledAt = new Date(now.getTime() + 90 * 60 * 1000).toISOString(); // +1h30m
        const card = window.renderNextActionCard(
            makeMeds(['Allopurinol', 'Bisoprolol']),
            { scheduled_at: scheduledAt, medication_names: ['Allopurinol', 'Bisoprolol'] },
            { now }
        );

        expect(card).not.toBeNull();
        expect(card.classList.contains('wg-meds-next-action')).toBe(true);
        expect(card.classList.contains('wg-gloss--sun')).toBe(true);
        expect(card.classList.contains('wg-meds-next-action--empty')).toBe(false);

        const subtitle = card.querySelector('.wg-meds-next-action__subtitle').textContent;
        expect(subtitle).toMatch(/^Next · \d{2}:\d{2} · in 1h 30m$/);

        const value = card.querySelector('.wg-meds-next-action__value').textContent;
        expect(value).toBe('Allopurinol · Bisoprolol');

        const takeBtn = card.querySelector('.wg-meds-next-action__take');
        expect(takeBtn).not.toBeNull();
        expect(takeBtn.textContent).toBe('Take');
        expect(takeBtn.classList.contains('wg-gloss--sun')).toBe(true);
    });

    it('truncates the names line to "Name1 · Name2 · +N" when more than three meds cluster', () => {
        const { window } = env;
        const now = new Date('2026-04-22T07:00:00Z');
        const scheduledAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
        const names = ['Allopurinol', 'Bisoprolol', 'Metformin', 'Omeprazole', 'Atorvastatin', 'Aspirin'];
        const card = window.renderNextActionCard(
            makeMeds(names),
            { scheduled_at: scheduledAt, medication_names: names },
            { now }
        );

        const value = card.querySelector('.wg-meds-next-action__value').textContent;
        expect(value).toBe('Allopurinol · Bisoprolol · +4');
    });

    it('formats the relative time as "in Xm" when under one hour, and "in Xh" when on the hour', () => {
        const { window } = env;
        const now = new Date('2026-04-22T07:00:00Z');
        const minsOnly = window.renderNextActionCard(
            [],
            { scheduled_at: new Date(now.getTime() + 25 * 60 * 1000).toISOString(), medication_names: [] },
            { now }
        );
        expect(minsOnly.querySelector('.wg-meds-next-action__subtitle').textContent).toMatch(/in 25m$/);

        const hoursOnly = window.renderNextActionCard(
            [],
            { scheduled_at: new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString(), medication_names: [] },
            { now }
        );
        expect(hoursOnly.querySelector('.wg-meds-next-action__subtitle').textContent).toMatch(/in 3h$/);
    });

    it('renders the empty state and omits the Take button when no upcoming dose is within 24h', () => {
        const { window } = env;
        const now = new Date('2026-04-22T07:00:00Z');
        const card = window.renderNextActionCard(makeMeds(['A']), null, { now });

        expect(card).not.toBeNull();
        expect(card.classList.contains('wg-meds-next-action--empty')).toBe(true);
        expect(card.querySelector('.wg-meds-next-action__subtitle').textContent).toBe('No upcoming doses');
        expect(card.querySelector('.wg-meds-next-action__take')).toBeNull();
    });

    it('renders the empty state when scheduled_at is more than 24h in the future', () => {
        const { window } = env;
        const now = new Date('2026-04-22T07:00:00Z');
        const farOff = new Date(now.getTime() + 36 * 60 * 60 * 1000).toISOString();
        const card = window.renderNextActionCard(
            makeMeds(['A']),
            { scheduled_at: farOff, medication_names: ['A'] },
            { now }
        );
        expect(card.classList.contains('wg-meds-next-action--empty')).toBe(true);
        expect(card.querySelector('.wg-meds-next-action__take')).toBeNull();
    });

    it('Take button click invokes opts.onTake with resolved IDs, names, and scheduledAt', () => {
        const { window } = env;
        const now = new Date('2026-04-22T07:00:00Z');
        const scheduledAt = new Date(now.getTime() + 45 * 60 * 1000).toISOString();
        const meds = makeMeds(['Allopurinol', 'Bisoprolol', 'Metformin']);
        const onTake = vi.fn();

        const card = window.renderNextActionCard(
            meds,
            { scheduled_at: scheduledAt, medication_names: ['Allopurinol', 'Bisoprolol'] },
            { now, onTake }
        );

        card.querySelector('.wg-meds-next-action__take').click();

        expect(onTake).toHaveBeenCalledTimes(1);
        const arg = onTake.mock.calls[0][0];
        expect(arg.ids).toEqual([1, 2]);
        expect(arg.names).toEqual(['Allopurinol', 'Bisoprolol']);
        expect(arg.scheduledAt).toBe(scheduledAt);
    });

    it('Take button keeps resolved ids and names aligned when a cached name no longer resolves locally', () => {
        const { window } = env;
        const now = new Date('2026-04-22T07:00:00Z');
        const scheduledAt = new Date(now.getTime() + 45 * 60 * 1000).toISOString();
        // Local meds list lost "Allopurinol" (e.g. deleted after the
        // next_intake payload was cached). The handler must drop the
        // unresolved name from BOTH the ids and names arrays so the
        // confirm modal's zip-by-index pairing cannot mismatch.
        const meds = [{ id: 2, name: 'Bisoprolol', schedule: '', archived: false }];
        const onTake = vi.fn();
        const card = window.renderNextActionCard(
            meds,
            { scheduled_at: scheduledAt, medication_names: ['Allopurinol', 'Bisoprolol'] },
            { now, onTake }
        );

        card.querySelector('.wg-meds-next-action__take').click();

        expect(onTake).toHaveBeenCalledTimes(1);
        const arg = onTake.mock.calls[0][0];
        expect(arg.ids).toEqual([2]);
        expect(arg.names).toEqual(['Bisoprolol']);
    });

    it('Take button falls back to showMedicationConfirmModal when opts.onTake is omitted', () => {
        const { window } = env;
        const spy = vi.fn();
        window.showMedicationConfirmModal = spy;

        const now = new Date('2026-04-22T07:00:00Z');
        const scheduledAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
        const meds = makeMeds(['Allopurinol']);
        const card = window.renderNextActionCard(
            meds,
            { scheduled_at: scheduledAt, medication_names: ['Allopurinol'] },
            { now }
        );

        card.querySelector('.wg-meds-next-action__take').click();

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith([1], ['Allopurinol'], scheduledAt, 'confirm');
    });

    it('mountNextActionCard pulls cached next_intake from DataStore and replaces the mount node children', async () => {
        const { window, document } = env;
        const now = new Date();
        const scheduledAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

        // Seed the DataStore cache and the in-memory medications list.
        window.medications = makeMeds(['Allopurinol']);
        window.DataStore.getCached = async (key) => (key === 'next_intake'
            ? { scheduled_at: scheduledAt, medication_names: ['Allopurinol'] }
            : null);

        await window.mountNextActionCard();

        const mount = document.getElementById('med-next-action');
        expect(mount).not.toBeNull();
        const card = mount.querySelector('.wg-meds-next-action');
        expect(card).not.toBeNull();
        expect(card.querySelector('.wg-meds-next-action__value').textContent).toBe('Allopurinol');
    });

    it('mountNextActionCard renders the empty card when DataStore has no cached next_intake', async () => {
        const { window, document } = env;
        window.DataStore.getCached = async () => null;
        window.medications = [];

        await window.mountNextActionCard();

        const mount = document.getElementById('med-next-action');
        const card = mount.querySelector('.wg-meds-next-action');
        expect(card).not.toBeNull();
        expect(card.classList.contains('wg-meds-next-action--empty')).toBe(true);
        expect(card.querySelector('.wg-meds-next-action__take')).toBeNull();
    });
});
