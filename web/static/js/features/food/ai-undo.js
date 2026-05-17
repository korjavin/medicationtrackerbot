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

    const results = await Promise.all(items.map(async (it) => {
        if (!it || !it.id) return { item: it, ok: false };
        try {
            const res = await fetch(`/api/food/log/${it.id}`, {
                method: 'DELETE',
                headers: window.makeAuthHeaders(),
            });
            return { item: it, ok: !!(res && res.ok) };
        } catch (_) {
            return { item: it, ok: false };
        }
    }));

    const allOk = results.every(r => r.ok);
    const anyOk = results.some(r => r.ok);

    if (anyOk) {
        try {
            await window.DataStore.invalidateTags(['food']);
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
