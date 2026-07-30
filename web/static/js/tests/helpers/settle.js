/**
 * Progress-bounded settle barriers for async assertions (med-tc1.10).
 *
 * A `setTimeout(r, N)` used as a synchronization point asserts that async work
 * has (or has not) progressed by an arbitrary wall-clock deadline — the flake
 * class fixed in #716 (med-tc1.8) and #723 (med-tc1.9). Positive assertions get
 * a barrier that resolves from inside the code path (a mock that reports the
 * exact moment of interest); NEGATIVE assertions ("nothing else ran") need a
 * unit of WORK instead, which is what this file provides.
 *
 * `macrotask()` is one hop through Node's event loop. Node drains the ENTIRE
 * microtask queue — including microtasks enqueued while draining — before the
 * setImmediate callback runs, so after one hop every promise continuation that
 * *could* have run *has* run. That makes a single round sufficient for any
 * pure-promise chain no matter how long, which is the property a fixed sleep
 * could never promise: it is a count of work, not of time, and a loaded runner
 * cannot erode it.
 *
 * `idle(rounds)` chains those hops for paths that cross a macrotask boundary of
 * their own (a nested setImmediate, an IndexedDB request). The default was
 * calibrated by bisection, not guessed: with the guarantee broken, every call
 * site in med-tc1.10 that needs this barrier at all (bootstrap's two TZ-skip
 * branches, the workout-stats empty-catalog guard) is killed 5/5 at rounds=1
 * and survives 5/5 at rounds=0 — 1 is both necessary and sufficient, because a
 * single hop drains an unbounded microtask chain. 20 is a 20x margin for future
 * call sites whose path does hop macrotasks; raise it only with a measurement.
 *
 * Vitest runs these suites with `environment: 'node'` (vitest.config.mjs), so
 * `setImmediate` is always present.
 */
export const macrotask = () => new Promise((resolve) => setImmediate(resolve));

export async function idle(rounds = 20) {
    for (let i = 0; i < rounds; i += 1) await macrotask();
}

/**
 * A one-shot barrier resolved from inside a mock — the #716 pattern.
 *
 *   const entered = signal();
 *   window.fetch = vi.fn(() => { entered.fire(); return … });
 *   await entered.wait;   // the fetch was entered, provably
 *
 * Firing before anyone awaits still counts (the promise is already resolved)
 * and firing twice is a no-op, so there is no ordering trap.
 */
export function signal() {
    let fire;
    const wait = new Promise((resolve) => { fire = resolve; });
    return { wait, fire };
}
