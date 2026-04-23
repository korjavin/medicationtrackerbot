// Wandergeek Workouts — Today's-workout card (Phase 7, Task 3).
//
// Covers the `renderTodaysWorkoutCard(rotation, todaySessions, opts)` helper
// added in Phase 7. The helper picks one of three states (non-rest / rest /
// already-completed), derives the rotation slot from the variant name, and
// exposes `onStart` / `onAdhoc` callback hooks so tests can intercept the
// click dispatch without booting the live workout action path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('Workouts today card (Phase 7, Task 3)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv({ withWorkout: true });
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    describe('getRotationSlot', () => {
        it('maps common variant names to PUSH / PULL / LEGS slots', () => {
            const { getRotationSlot } = env.window;
            expect(getRotationSlot('Push Day')).toBe('PUSH');
            expect(getRotationSlot('PULL')).toBe('PULL');
            expect(getRotationSlot('leg day')).toBe('LEGS');
            expect(getRotationSlot('Legs')).toBe('LEGS');
        });

        it('returns REST for rest / off variant names', () => {
            const { getRotationSlot } = env.window;
            expect(getRotationSlot('Rest')).toBe('REST');
            expect(getRotationSlot('OFF DAY')).toBe('REST');
        });

        it('falls back to AD-HOC for empty / unknown variant names', () => {
            const { getRotationSlot } = env.window;
            expect(getRotationSlot('')).toBe('AD-HOC');
            expect(getRotationSlot(undefined)).toBe('AD-HOC');
            expect(getRotationSlot('Core & Cardio')).toBe('AD-HOC');
        });
    });

    describe('non-rest (today) state', () => {
        it('renders a .wg-gloss--sun card with the rotation slot and Start button', () => {
            const { renderTodaysWorkoutCard } = env.window;
            const rotation = {
                session: { id: 42, status: 'notified' },
                group_name: 'Upper/Lower',
                variant_name: 'Push Day',
                exercises_count: 5,
                is_rotating: true
            };
            const card = renderTodaysWorkoutCard(rotation, [], {});

            expect(card.classList.contains('wg-workouts-today-card')).toBe(true);
            expect(card.classList.contains('wg-gloss--sun')).toBe(true);
            expect(card.dataset.state).toBe('today');
            expect(card.dataset.slot).toBe('PUSH');

            const subtitle = card.querySelector('.wg-workouts-today-card__subtitle');
            expect(subtitle.textContent).toBe('Today · PUSH');

            const slotTag = card.querySelector('.wg-workouts-slot-tag');
            expect(slotTag).not.toBeNull();
            expect(slotTag.classList.contains('wg-workouts-slot-tag--push')).toBe(true);
            expect(slotTag.textContent).toBe('PUSH');

            const startBtn = card.querySelector('.wg-workouts-today-card__start');
            expect(startBtn).not.toBeNull();
            expect(startBtn.classList.contains('wg-gloss--sun')).toBe(true);
            expect(startBtn.textContent).toBe('Start');
        });

        it('renders a mono exercise-cluster list truncated to "Name1 · Name2 · Name3 · +N" when > 3', () => {
            const { renderTodaysWorkoutCard } = env.window;
            const rotation = {
                session: { id: 9 },
                group_name: 'PPL',
                variant_name: 'Pull',
                exercises_count: 5,
                exercises: [
                    { name: 'Rows' },
                    { name: 'Pulldown' },
                    { name: 'Curls' },
                    { name: 'Face Pulls' },
                    { name: 'Shrugs' }
                ]
            };
            const card = renderTodaysWorkoutCard(rotation, [], {});
            const value = card.querySelector('.wg-workouts-today-card__value');
            expect(value.textContent).toBe('Rows · Pulldown · Curls · +2');
        });

        it('falls back to "Variant · N exercises" when no exercise names are provided', () => {
            const { renderTodaysWorkoutCard } = env.window;
            const rotation = {
                session: { id: 1 },
                group_name: 'PPL',
                variant_name: 'Legs',
                exercises_count: 6
            };
            const card = renderTodaysWorkoutCard(rotation, [], {});
            const value = card.querySelector('.wg-workouts-today-card__value');
            expect(value.textContent).toBe('Legs · 6 exercises');
            expect(card.dataset.slot).toBe('LEGS');
            const slotTag = card.querySelector('.wg-workouts-slot-tag');
            expect(slotTag.classList.contains('wg-workouts-slot-tag--legs')).toBe(true);
        });

        it('invokes opts.onStart with the session id when the Start button is clicked', () => {
            const { renderTodaysWorkoutCard } = env.window;
            const onStart = vi.fn();
            const rotation = {
                session: { id: 77, status: 'notified' },
                group_name: 'Upper/Lower',
                variant_name: 'Push',
                exercises_count: 4
            };
            const card = renderTodaysWorkoutCard(rotation, [], { onStart });
            const startBtn = card.querySelector('.wg-workouts-today-card__start');
            startBtn.click();
            expect(onStart).toHaveBeenCalledWith(77);
        });
    });

    describe('rest state', () => {
        it('renders a muted .wg-card with "Rest day" eyebrow and ad-hoc CTA when variant resolves to REST', () => {
            const { renderTodaysWorkoutCard } = env.window;
            const rotation = {
                session: { id: 11 },
                group_name: 'PPL',
                variant_name: 'Rest',
                exercises_count: 0
            };
            const card = renderTodaysWorkoutCard(rotation, [], {});

            expect(card.classList.contains('wg-card')).toBe(true);
            expect(card.classList.contains('wg-workouts-today-card--rest')).toBe(true);
            expect(card.classList.contains('wg-gloss--sun')).toBe(false);
            expect(card.dataset.state).toBe('rest');
            expect(card.dataset.slot).toBe('REST');

            const subtitle = card.querySelector('.wg-workouts-today-card__subtitle');
            expect(subtitle.textContent).toBe('Rest day');
            const value = card.querySelector('.wg-workouts-today-card__value');
            expect(value.textContent).toBe('Start ad-hoc?');

            const slotTag = card.querySelector('.wg-workouts-slot-tag');
            expect(slotTag.classList.contains('wg-workouts-slot-tag--rest')).toBe(true);

            const adhocBtn = card.querySelector('.wg-workouts-today-card__adhoc');
            expect(adhocBtn).not.toBeNull();
            expect(adhocBtn.textContent).toBe('Start ad-hoc');
            // Rest-state CTA is `.wg-gloss` (not sun) — ad-hoc is a neutral
            // secondary action when there's no rotation to perform.
            expect(adhocBtn.classList.contains('wg-gloss')).toBe(true);
            expect(adhocBtn.classList.contains('wg-gloss--sun')).toBe(false);
        });

        it('renders rest state when rotation is null (no scheduled session)', () => {
            const { renderTodaysWorkoutCard } = env.window;
            const card = renderTodaysWorkoutCard(null, [], {});

            expect(card.classList.contains('wg-workouts-today-card--rest')).toBe(true);
            expect(card.dataset.state).toBe('rest');
            // Null rotation has no variant name — classifier returns AD-HOC,
            // which the rest-state branch overrides to display "Rest day"
            // while keeping the AD-HOC slot tag.
            expect(card.dataset.slot).toBe('AD-HOC');
        });

        it('invokes opts.onAdhoc (not onStart) when the ad-hoc CTA is clicked', () => {
            const { renderTodaysWorkoutCard } = env.window;
            const onStart = vi.fn();
            const onAdhoc = vi.fn();
            const rotation = {
                session: { id: 1 },
                group_name: 'PPL',
                variant_name: 'Rest',
                exercises_count: 0
            };
            const card = renderTodaysWorkoutCard(rotation, [], { onStart, onAdhoc });
            const adhocBtn = card.querySelector('.wg-workouts-today-card__adhoc');
            adhocBtn.click();
            expect(onAdhoc).toHaveBeenCalledTimes(1);
            expect(onStart).not.toHaveBeenCalled();
        });
    });

    describe('already-completed state', () => {
        it('renders a muted .wg-card with "Completed · 45m" eyebrow when todaySessions has a completed session', () => {
            const { renderTodaysWorkoutCard } = env.window;
            const rotation = {
                session: { id: 3, status: 'completed' },
                group_name: 'Upper/Lower',
                variant_name: 'Push Day',
                exercises_count: 4
            };
            const todaySessions = [
                { id: 3, status: 'completed', duration_minutes: 45 }
            ];
            const card = renderTodaysWorkoutCard(rotation, todaySessions, {});

            expect(card.classList.contains('wg-card')).toBe(true);
            expect(card.classList.contains('wg-workouts-today-card--completed')).toBe(true);
            expect(card.classList.contains('wg-gloss--sun')).toBe(false);
            expect(card.dataset.state).toBe('completed');

            const subtitle = card.querySelector('.wg-workouts-today-card__subtitle');
            expect(subtitle.textContent).toBe('Completed · 45m');

            const value = card.querySelector('.wg-workouts-today-card__value');
            expect(value.textContent).toBe('Upper/Lower');

            // Slot tag still reflects the rotation that was completed.
            const slotTag = card.querySelector('.wg-workouts-slot-tag');
            expect(slotTag.classList.contains('wg-workouts-slot-tag--push')).toBe(true);

            // No Start button and no ad-hoc CTA.
            expect(card.querySelector('.wg-workouts-today-card__start')).toBeNull();
            expect(card.querySelector('.wg-workouts-today-card__adhoc')).toBeNull();
        });

        it('formats duration > 60 minutes as "Xh Ym"', () => {
            const { renderTodaysWorkoutCard } = env.window;
            const rotation = {
                session: { id: 4 },
                group_name: 'Upper/Lower',
                variant_name: 'Push',
                exercises_count: 4
            };
            const todaySessions = [{ status: 'completed', duration_minutes: 75 }];
            const card = renderTodaysWorkoutCard(rotation, todaySessions, {});
            const subtitle = card.querySelector('.wg-workouts-today-card__subtitle');
            expect(subtitle.textContent).toBe('Completed · 1h 15m');
        });

        it('takes precedence over rest state when a completed session exists today', () => {
            const { renderTodaysWorkoutCard } = env.window;
            // Even if the rotation currently points at a REST variant,
            // a completed session elsewhere today should still show the
            // already-completed card (not the rest-day CTA).
            const rotation = {
                session: { id: 5 },
                group_name: 'PPL',
                variant_name: 'Rest',
                exercises_count: 0
            };
            const todaySessions = [{ status: 'completed', duration_minutes: 30 }];
            const card = renderTodaysWorkoutCard(rotation, todaySessions, {});
            expect(card.dataset.state).toBe('completed');
        });
    });

    describe('default callbacks fall back to window globals', () => {
        it('Start button invokes window.startWorkoutSession when no onStart is supplied', () => {
            const spy = vi.fn();
            env.window.startWorkoutSession = spy;
            const rotation = {
                session: { id: 88 },
                group_name: 'PPL',
                variant_name: 'Pull',
                exercises_count: 4
            };
            const card = env.window.renderTodaysWorkoutCard(rotation, [], {});
            card.querySelector('.wg-workouts-today-card__start').click();
            expect(spy).toHaveBeenCalledWith(88);
        });

        it('ad-hoc CTA invokes window.startAdHocWorkout when no onAdhoc is supplied', () => {
            const spy = vi.fn();
            env.window.startAdHocWorkout = spy;
            const card = env.window.renderTodaysWorkoutCard(null, [], {});
            card.querySelector('.wg-workouts-today-card__adhoc').click();
            expect(spy).toHaveBeenCalledTimes(1);
        });
    });
});
