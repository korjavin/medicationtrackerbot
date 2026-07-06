// ====================================
// FOOD AI UNDO — shared undo helper
// ====================================
//
// Undo handler shared by the food-photo and food-description AI flows. Issues
// a parallel DELETE for every just-logged item, refreshes the food list +
// Today, then transitions the summary card to a "Removed N items" success
// state. On partial failure the card flips to its retry-able error state, and
// Retry only re-attempts the items that haven't already been deleted —
// otherwise the store's "no rows" 500 for already-deleted ids would lock the
// user in permanent error after a single successful round.

async function undoFoodAIItems(items, summary, originalCount) {
    if (!Array.isArray(items) || items.length === 0) return;
    const total = (typeof originalCount === 'number') ? originalCount : items.length;

    // Stamp the timing-window fallback once for the whole undo batch — these
    // DELETEs all originate from the user's current tab, and the SSE echoes
    // they trigger must not surface as a foreign banner if the broker's
    // source attribution doesn't reach the subscriber for any reason. The
    // rollback restores the prior stamp when the entire batch failed (no
    // server-side write happened) so a 5s false-suppress window doesn't
    // hide unrelated cross-source banners.
    let rollbackOwnWriteStamp = null;
    if (window.DataStore && typeof window.DataStore.recordOwnWriteWithRollback === 'function') {
        rollbackOwnWriteStamp = window.DataStore.recordOwnWriteWithRollback();
    } else if (window.DataStore && typeof window.DataStore.recordOwnWrite === 'function') {
        window.DataStore.recordOwnWrite();
    }

    const results = await Promise.all(items.map(async (it) => {
        if (!it || !it.id) return { item: it, ok: false };
        // Cloud mode has no /api/food/log/:id on the wire — apiCall routes
        // through the shim (installApiShim's food.remove) instead of a raw
        // fetch; bot mode keeps the direct DELETE untouched.
        if (window.__MEDTRACKER_CLOUD__) {
            try {
                const res = await apiCall(`/api/food/log/${it.id}`, 'DELETE');
                return { item: it, ok: !!res };
            } catch (_) {
                return { item: it, ok: false };
            }
        }
        try {
            const res = await fetch(`/api/food/log/${it.id}`, {
                method: 'DELETE',
                headers: window.makeWriteHeaders(),
            });
            return { item: it, ok: !!(res && res.ok) };
        } catch (_) {
            return { item: it, ok: false };
        }
    }));

    const allOk = results.every(r => r.ok);
    const anyOk = results.some(r => r.ok);
    if (!anyOk && rollbackOwnWriteStamp) rollbackOwnWriteStamp();

    if (anyOk) {
        try {
            await window.DataStore.invalidateTags(['food', 'gamification']);
            if (typeof todayFoodKey === 'function' && window.DataStore.clearCached) {
                await window.DataStore.clearCached(todayFoodKey(new Date()));
            }
            if (window.DataStore?.advanceCursorSilently) {
                window.DataStore.advanceCursorSilently();
            }
        } catch (e) {
            console.error('Food AI undo cache invalidation failed:', e);
        }
        if (typeof loadFoodLogs === 'function') loadFoodLogs();
        if (typeof loadToday === 'function') loadToday();
    }

    if (!allOk) {
        const remaining = results.filter(r => !r.ok).map(r => r.item);
        if (summary && typeof summary.showError === 'function') {
            summary.showError(
                'Could not undo all items. Tap retry to try again.',
                () => undoFoodAIItems(remaining, summary, total),
            );
        }
        return;
    }

    if (summary && typeof summary.showRemoved === 'function') {
        summary.showRemoved(total);
    }
}
