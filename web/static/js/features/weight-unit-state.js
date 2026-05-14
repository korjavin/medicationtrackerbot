// Weight-unit (kg/lb) preference state machine.
//
// Owns the racy cluster previously sprawled across app.js — the serial PATCH
// queue, the intent sequence number, the failure-revert baseline, the pending
// PATCH count, and the locally-mutated flag. All five become closure-private
// fields on a single object so hydration paths (bootstrap, cache, SW
// BOOTSTRAP_UPDATED) and the Settings + modal-submit PATCH paths cannot drift
// out of sync.
//
// Public surface (also mirrored under the original window.X names for
// backwards compatibility with existing tests / features/weight.js):
//   - WeightUnitState.commitAuthoritative(unit) → effective unit ('kg'|'lb')
//   - WeightUnitState.applySegmentedState(unit) → paints the toggle DOM
//   - WeightUnitState.applyAuthoritative(unit)  → commit + paint in lockstep
//   - WeightUnitState.reconcile(unit)           → policy-only (no mutation)
//   - WeightUnitState.setPreference(unit, opts) → serial PATCH (Settings tap)
//
// Regression scenarios this module's invariants defend (each has a test):
//   1. A→B→A click sequence whose tail PATCH fails reverts UI to the last
//      server-confirmed unit (lastCommitted), not the optimistic state at
//      the tail click — equality-based "still latest" would clobber a newer
//      same-unit click, so intentSeq is monotonic.
//   2. SW BOOTSTRAP_UPDATED carrying the pre-PATCH server unit must NOT
//      overwrite a just-committed local PATCH. After the queue drains the
//      pendingPatches guard alone is insufficient; locallyMutated rejects
//      stale hydration that disagrees with lastCommitted.
//   3. Concurrent user clicks while a PATCH is in flight: the patchTail
//      promise chain preserves arrival order at the server.

window.WeightUnitState = (function () {
    let _state = {
        patchTail: Promise.resolve(),
        intentSeq: 0,
        lastCommitted: null,
        pendingPatches: 0,
        locallyMutated: false,
    }; // module-state: weight-unit reducer; invariants documented above

    function applySegmentedState(unit) {
        const root = document.getElementById('weight-unit-segmented');
        if (!root) return;
        const target = unit === 'lb' ? 'lb' : 'kg';
        root.querySelectorAll('.wg-settings-segmented__btn').forEach((btn) => {
            const isActive = btn.getAttribute('data-unit') === target;
            btn.classList.toggle('wg-settings-segmented__btn--active', isActive);
            btn.classList.toggle('wg-gloss--sun', isActive);
            btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
    }

    // Choose the unit to apply when an external source (bootstrap payload,
    // cache hydration, BOOTSTRAP_UPDATED postMessage) hands us a unit. While
    // PATCHes are queued, the user's mid-click intent in
    // window.weightUnitPreference owns the UI — pass the incoming value
    // through so the optimistic state isn't pre-empted by hydration racing
    // their click. Once the queue is drained AND a local PATCH succeeded in
    // this session, prefer the last successful commit over a disagreeing
    // incoming value: the bootstrap fetch was almost certainly issued before
    // the PATCH and is carrying the pre-PATCH server unit.
    function reconcile(unit) {
        if (unit !== 'kg' && unit !== 'lb') return unit;
        if (_state.pendingPatches > 0) return unit;
        if (!_state.locallyMutated) return unit;
        if (!_state.lastCommitted) return unit;
        if (unit === _state.lastCommitted) return unit;
        return _state.lastCommitted;
    }

    // Sync the failure-revert target with an authoritative unit. Bootstrap,
    // cache hydration, and out-of-band PATCHes (modal-side inference) all
    // need to nudge lastCommitted forward — otherwise a later Settings PATCH
    // that fails will revert UI to a stale unit even though the server has
    // long since moved on. Returns the effective unit (after reconciliation)
    // so callers can paint the toggle to the same value — paying the raw
    // incoming value to applySegmentedState while commitAuthoritative
    // reconciled internally would leave window.weightUnitPreference correct
    // but the toggle visually flipped to the stale unit.
    function commitAuthoritative(unit) {
        const effective = reconcile(unit);
        if (effective !== 'kg' && effective !== 'lb') return null;
        window.weightUnitPreference = effective;
        // While Settings PATCHes are queued/in-flight, leave the rollback
        // baseline alone — the queue's own advance is authoritative, and
        // stale hydration could otherwise overwrite a just-committed success
        // with the pre-PATCH server value before the next queued PATCH
        // resolves.
        if (_state.pendingPatches === 0) {
            _state.lastCommitted = effective;
        }
        return effective;
    }

    // Commit + paint the segmented control in lockstep. Hydration sites
    // should call this rather than commitAuthoritative + applySegmentedState
    // separately — using the raw incoming unit to paint while commit
    // reconciled internally is the desync class of bug.
    function applyAuthoritative(unit) {
        const effective = commitAuthoritative(unit);
        if (effective) applySegmentedState(effective);
        return effective;
    }

    async function _cacheSnapshot(key, value, tags) {
        if (!window.DataStore) return;
        if (tags && tags.length > 0 && typeof window.DataStore.setCachedWithTags === 'function') {
            await window.DataStore.setCachedWithTags(key, value, tags);
        } else if (typeof window.DataStore.setCached === 'function') {
            await window.DataStore.setCached(key, value);
        }
    }

    // Serial queue for the Settings PATCH: rapid toggling could otherwise
    // race at the server — two concurrent PATCHes can land in arrival order
    // opposite to click order, leaving the server on the older intent while
    // the client/cache show the newer one. We chain each PATCH onto the
    // previous one so the server observes the same order the user did.
    // Optimistic local state still flips instantly so the UI feels responsive.
    //
    // Stale-completion guard uses a monotonic intent counter (not unit
    // equality): in an A-B-A click sequence (kg→lb→kg→lb) the latest intent
    // and an early failed PATCH can carry the same unit value, so equality
    // would falsely classify the failed older PATCH as "still latest" and
    // clobber the user's newer choices. The seq id is unique per click.
    async function setPreference(unit, opts = {}) {
        if (unit !== 'kg' && unit !== 'lb') return false;
        const reload = opts.reload !== false;
        if (_state.lastCommitted === null) {
            _state.lastCommitted = window.weightUnitPreference === 'lb' ? 'lb' : 'kg';
        }
        if (unit === window.weightUnitPreference) return true;
        // PATCH has no offline-queue fallback in sync.js (offlineAwareApiCall
        // only queues POST/PUT/DELETE), so an offline attempt would surface a
        // "needs internet" alert via apiCall after a useless network round-
        // trip. Treat offline clicks as a silent no-op: the UI stays on the
        // committed unit, mirroring the modal-submit path.
        if (window.SyncManager && window.SyncManager.isOnline === false) return false;

        // Optimistically commit so a fast follow-up click compares against
        // the latest intended unit, not the still-in-flight previous value.
        const seq = ++_state.intentSeq;
        _state.pendingPatches++;
        window.weightUnitPreference = unit;
        applySegmentedState(unit);

        const run = async () => {
            try {
                const isLatestIntent = () => seq === _state.intentSeq;
                const result = await window.apiCall('/api/settings/weight-unit', 'PATCH', { unit });
                if (!result) {
                    // Only revert if this PATCH still represents the latest
                    // user intent — a later queued PATCH owns the final UI
                    // state otherwise.
                    if (isLatestIntent()) {
                        window.weightUnitPreference = _state.lastCommitted;
                        applySegmentedState(_state.lastCommitted);
                    }
                    return false;
                }
                _state.lastCommitted = unit;
                // Mark the session as having a known-good local commit so a
                // delayed BOOTSTRAP_UPDATED carrying the pre-PATCH server unit
                // can be rejected by reconcile() instead of clobbering this
                // just-committed success.
                _state.locallyMutated = true;

                if (window.DataStore && typeof window.DataStore.getCached === 'function') {
                    try {
                        const cached = await window.DataStore.getCached('settings_bundle');
                        if (cached) {
                            cached.weightUnitPreference = unit;
                            // setCachedWithTags bumps the settings_bundle
                            // generation and drops any in-flight bootstrap
                            // fetch so a concurrent loadSettings() SWR cannot
                            // resolve later and overwrite this authoritative
                            // unit with a stale pre-PATCH bundle.
                            await _cacheSnapshot('settings_bundle', cached, ['settings', 'food_targets', 'feature_settings']);
                        }
                    } catch (_) { /* best-effort */ }
                }

                // Skip the rerender when a newer click has already moved on
                // — the newer call's reload will paint the final unit and
                // avoids flashing intermediate states.
                if (isLatestIntent()) {
                    // Re-sync window.weightUnitPreference: a stale bootstrap
                    // / SWR / loadSettings hydration may have landed during
                    // the awaits above and called commitAuthoritative with
                    // the pre-PATCH server value, clobbering window
                    // .weightUnitPreference. (lastCommitted is already
                    // protected by pendingPatches > 0.)
                    commitAuthoritative(unit);
                    applySegmentedState(unit);
                    // Modal-submit callers pass reload:false because
                    // handleWeightSubmit already calls loadWeightLogs() (and
                    // conditionally loadToday()) after closing the modal — a
                    // queued reload here would duplicate that work and could
                    // repaint mid-modal.
                    if (reload && typeof window.reloadCurrentTab === 'function') {
                        window.reloadCurrentTab();
                    }
                }
                return true;
            } finally {
                _state.pendingPatches--;
            }
        };

        const next = _state.patchTail.then(run, run);
        _state.patchTail = next;
        return next;
    }

    // Reset hook for tests — clears the closure-private state without
    // requiring an environment reload. NOT part of the public production API.
    function _resetForTesting() {
        _state.patchTail = Promise.resolve();
        _state.intentSeq = 0;
        _state.lastCommitted = null;
        _state.pendingPatches = 0;
        _state.locallyMutated = false;
    }

    function _stateForTesting() {
        return {
            intentSeq: _state.intentSeq,
            lastCommitted: _state.lastCommitted,
            pendingPatches: _state.pendingPatches,
            locallyMutated: _state.locallyMutated,
        };
    }

    return {
        commitAuthoritative,
        applySegmentedState,
        applyAuthoritative,
        reconcile,
        setPreference,
        _resetForTesting,
        _stateForTesting,
    };
})();

// Backwards-compatible globals. Existing tests and features/weight.js call
// these by name; the shims keep the contract while the implementation moves
// behind WeightUnitState.
window.commitAuthoritativeWeightUnit = function commitAuthoritativeWeightUnit(unit) {
    return window.WeightUnitState.commitAuthoritative(unit);
};
window.setWeightUnitPreference = function setWeightUnitPreference(unit, opts) {
    return window.WeightUnitState.setPreference(unit, opts);
};
