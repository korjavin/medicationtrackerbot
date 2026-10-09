// food-photo-summary.js
//
// Post-log feedback after an AI food log (photo or description): the
// standard toast (kit .wg-toast, med-xso6.5) with "N items logged", the
// kcal total, and an Undo that calls back into the supplied handler
// (ai-undo.js issues the DELETEs). Undo's outcome replaces the toast:
// "Removed N items", or an error toast whose Retry re-attempts the rest.
//
// The toast root carries .wg-food-photo-summary as a JS/test hook only.

const FOOD_PHOTO_SUMMARY_AUTO_DISMISS_MS = 8000;

function fpsTotalKcal(items) {
    let kcal = 0;
    for (const it of items || []) kcal += Number(it && it.calories) || 0;
    return Math.round(kcal);
}

// No toast surface (isolated shells): the summary is skipped, only an error
// still interrupts via safeAlert.
function fpsToast(message, type, opts) {
    const sm = window.SyncManager;
    if (sm && typeof sm.showToast === 'function') {
        return sm.showToast(message, type, { className: 'wg-food-photo-summary', ...opts }) || null;
    }
    if (type === 'error') safeAlert(message);
    return null;
}

/**
 * @param {object} opts
 * @param {Array<object>} opts.items     - Items returned by the from-photo /
 *                                         from-description log call.
 * @param {'photo'|'description'} [opts.source='photo']
 * @param {number} [opts.failed=0]       - Items parsed but not persisted.
 * @param {function():(void|Promise<void>)} [opts.onUndo] - Called once on Undo.
 * @param {number} [opts.autoDismissMs]  - Override the auto-dismiss delay (0 = sticky).
 * @returns {{ root: (HTMLElement|null), dismiss: function():void,
 *             showRemoved: function(number):void,
 *             showError: function(string, function=):void }}
 */
function showFoodPhotoSummary(opts) {
    const o = opts || {};
    const items = Array.isArray(o.items) ? o.items : [];
    const onUndo = typeof o.onUndo === 'function' ? o.onUndo : null;
    const duration = typeof o.autoDismissMs === 'number' ? o.autoDismissMs : FOOD_PHOTO_SUMMARY_AUTO_DISMISS_MS;
    const sourceLabel = o.source === 'description' ? 'from description' : 'from photo';
    const failed = Math.max(0, Math.trunc(Number(o.failed) || 0));

    const n = items.length;
    const title = n ? `${n} item${n === 1 ? '' : 's'} logged` : 'Logged';
    const detail = [`${fpsTotalKcal(items)} kcal`, sourceLabel, failed > 0 ? `${failed} failed` : '']
        .filter(Boolean).join(' · ');

    let current = null;
    const swap = (next) => {
        if (current) current.dismiss();
        current = next;
    };

    swap(fpsToast(title, 'success', {
        detail,
        duration,
        action: onUndo ? {
            label: 'Undo',
            onClick: () => {
                Promise.resolve()
                    .then(onUndo)
                    .catch((e) => console.error('Food photo undo handler failed:', e));
            },
        } : undefined,
    }));

    return {
        get root() { return current ? current.root : null; },
        dismiss() { swap(null); },
        showRemoved(count) {
            const k = Number(count) || 0;
            swap(fpsToast(`Removed ${k} item${k === 1 ? '' : 's'}`, 'success', { duration }));
        },
        showError(message, retryHandler) {
            swap(fpsToast(String(message || 'Could not undo all items.'), 'error', {
                duration,
                action: typeof retryHandler === 'function' ? {
                    label: 'Retry',
                    onClick: () => {
                        Promise.resolve()
                            .then(retryHandler)
                            .catch((e) => console.error('Food photo retry handler failed:', e));
                    },
                } : undefined,
            }));
        },
    };
}
