// food-photo-summary.js
//
// In-app summary card shown after a successful "log food from photo" upload.
// Replaces the old browser alert() with a richer view: lists each parsed
// item (name, weight, kcal), shows totals across the items, and offers an
// Undo button that calls back into the supplied handler.
//
// All visuals come from CSS classes + design tokens — no inline styles, no
// hardcoded colors (project rule from CLAUDE.md).

const FOOD_PHOTO_SUMMARY_AUTO_DISMISS_MS = 8000;

function fpsFormatNumber(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '0';
    return Math.round(num).toString();
}

function fpsFormatGrams(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '0 g';
    return `${Math.round(num)} g`;
}

function fpsComputeTotals(items) {
    const totals = { kcal: 0, carbs: 0, protein: 0, fat: 0 };
    for (const it of items || []) {
        totals.kcal += Number(it && it.calories) || 0;
        totals.carbs += Number(it && it.carbs) || 0;
        totals.protein += Number(it && it.protein) || 0;
        totals.fat += Number(it && it.fat) || 0;
    }
    return totals;
}

function fpsBuildItemRow(item) {
    const row = document.createElement('div');
    row.className = 'wg-food-photo-summary__item';

    const name = document.createElement('span');
    name.className = 'wg-food-photo-summary__item-name';
    name.textContent = (item && item.name) ? String(item.name) : 'Item';

    const weight = document.createElement('span');
    weight.className = 'wg-food-photo-summary__item-weight';
    weight.textContent = fpsFormatGrams(item && item.weight);

    const kcal = document.createElement('span');
    kcal.className = 'wg-food-photo-summary__item-kcal wg-mono-display';
    kcal.textContent = `${fpsFormatNumber(item && item.calories)} kcal`;

    row.appendChild(name);
    row.appendChild(weight);
    row.appendChild(kcal);
    return row;
}

function fpsBuildTotalsRow(totals) {
    const wrap = document.createElement('div');
    wrap.className = 'wg-food-photo-summary__totals';

    const label = document.createElement('span');
    label.className = 'wg-food-photo-summary__totals-label';
    label.textContent = 'Total';

    const macros = document.createElement('span');
    macros.className = 'wg-food-photo-summary__totals-macros';
    macros.textContent =
        `C ${fpsFormatNumber(totals.carbs)}g · ` +
        `P ${fpsFormatNumber(totals.protein)}g · ` +
        `F ${fpsFormatNumber(totals.fat)}g`;

    const kcal = document.createElement('span');
    kcal.className = 'wg-food-photo-summary__totals-kcal wg-mono-display';
    kcal.textContent = `${fpsFormatNumber(totals.kcal)} kcal`;

    wrap.appendChild(label);
    wrap.appendChild(macros);
    wrap.appendChild(kcal);
    return wrap;
}

/**
 * Show the food-photo summary card. The card auto-dismisses after a short
 * delay; both Undo and Close cancel the auto-dismiss timer. Returns a small
 * controller so callers / tests can dismiss programmatically and inspect
 * card state.
 *
 * @param {object} opts
 * @param {Array<object>} opts.items     - Items returned by /api/food/log/from-photo
 *                                         or /api/food/log/from-description.
 * @param {'photo'|'description'} [opts.source='photo'] - Drives the title suffix
 *   ("from photo" vs "from description") so the description AI flow doesn't
 *   advertise items as logged "from photo".
 * @param {function():(void|Promise<void>)} [opts.onUndo] - Called once when Undo is clicked.
 * @param {HTMLElement} [opts.mountPoint=document.body]   - Where to attach the card.
 * @param {number} [opts.autoDismissMs]                   - Override auto-dismiss delay.
 * @returns {{ root: HTMLElement, dismiss: function():void }}
 */
function showFoodPhotoSummary(opts) {
    const items = (opts && Array.isArray(opts.items)) ? opts.items : [];
    const onUndo = opts && typeof opts.onUndo === 'function' ? opts.onUndo : null;
    const mountPoint = (opts && opts.mountPoint) || document.body;
    const autoDismissMs = (opts && typeof opts.autoDismissMs === 'number')
        ? opts.autoDismissMs
        : FOOD_PHOTO_SUMMARY_AUTO_DISMISS_MS;
    const sourceLabel = (opts && opts.source === 'description') ? 'from description' : 'from photo';

    // Tear down any prior card so a second photo upload doesn't stack toasts.
    const stale = document.querySelectorAll('.wg-food-photo-summary');
    stale.forEach((el) => el.remove());

    const root = document.createElement('div');
    root.className = 'wg-food-photo-summary';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');

    const header = document.createElement('div');
    header.className = 'wg-food-photo-summary__header';
    const title = document.createElement('span');
    title.className = 'wg-food-photo-summary__title';
    title.textContent = items.length
        ? `Logged ${items.length} item${items.length === 1 ? '' : 's'} ${sourceLabel}`
        : `Logged ${sourceLabel}`;
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'wg-food-photo-summary__close';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.textContent = '×';
    header.appendChild(closeBtn);

    const itemsWrap = document.createElement('div');
    itemsWrap.className = 'wg-food-photo-summary__items';
    for (const it of items) {
        itemsWrap.appendChild(fpsBuildItemRow(it));
    }

    const totals = fpsComputeTotals(items);
    const totalsRow = fpsBuildTotalsRow(totals);

    const actions = document.createElement('div');
    actions.className = 'wg-food-photo-summary__actions';
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'wg-food-photo-summary__undo wg-toolbar-btn wg-toolbar-btn--secondary';
    const undoLabel = document.createElement('span');
    undoLabel.className = 'wg-toolbar-btn__label';
    undoLabel.textContent = 'Undo';
    undoBtn.appendChild(undoLabel);
    actions.appendChild(undoBtn);

    root.appendChild(header);
    root.appendChild(itemsWrap);
    root.appendChild(totalsRow);
    root.appendChild(actions);

    let dismissed = false;
    let autoTimer = null;

    function clearAutoTimer() {
        if (autoTimer !== null) {
            clearTimeout(autoTimer);
            autoTimer = null;
        }
    }

    function dismiss() {
        if (dismissed) return;
        dismissed = true;
        clearAutoTimer();
        if (root.parentNode) root.parentNode.removeChild(root);
    }

    if (autoDismissMs > 0) {
        autoTimer = setTimeout(dismiss, autoDismissMs);
    }

    closeBtn.addEventListener('click', () => {
        dismiss();
    });

    // Undo: fire the handler exactly once. The button is disabled immediately
    // and the auto-dismiss timer cancelled so a slow handler can't be
    // interrupted by the card disappearing on its own. The card itself does
    // NOT auto-dismiss after Undo — the Task 4 caller swaps content to
    // "Removed N items" / error state and re-arms its own dismissal.
    let undoFired = false;
    undoBtn.addEventListener('click', async () => {
        if (undoFired) return;
        undoFired = true;
        clearAutoTimer();
        undoBtn.disabled = true;
        try {
            if (onUndo) await onUndo();
        } catch (e) {
            console.error('Food photo undo handler failed:', e);
        }
    });

    mountPoint.appendChild(root);

    // Replace everything below the header so the card can transition between
    // the initial "summary" view and the post-Undo "Removed N items" /
    // "Could not undo" views without re-mounting.
    function clearBodyContent() {
        const headerEl = root.querySelector('.wg-food-photo-summary__header');
        Array.from(root.children).forEach((child) => {
            if (child !== headerEl) root.removeChild(child);
        });
    }

    function showRemoved(count) {
        if (dismissed) return;
        clearAutoTimer();
        clearBodyContent();
        const n = Number(count) || 0;
        const msg = document.createElement('div');
        msg.className = 'wg-food-photo-summary__message';
        msg.textContent = `Removed ${n} item${n === 1 ? '' : 's'}`;
        root.appendChild(msg);
        if (autoDismissMs > 0) {
            autoTimer = setTimeout(dismiss, autoDismissMs);
        }
    }

    function showError(message, retryHandler) {
        if (dismissed) return;
        clearAutoTimer();
        clearBodyContent();
        const msg = document.createElement('div');
        msg.className = 'wg-food-photo-summary__message wg-food-photo-summary__message--error';
        msg.textContent = String(message || 'Could not undo all items.');
        root.appendChild(msg);
        if (typeof retryHandler === 'function') {
            const actions = document.createElement('div');
            actions.className = 'wg-food-photo-summary__actions';
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'wg-food-photo-summary__retry wg-toolbar-btn wg-toolbar-btn--secondary';
            const label = document.createElement('span');
            label.className = 'wg-toolbar-btn__label';
            label.textContent = 'Retry';
            retry.appendChild(label);
            let retryFired = false;
            retry.addEventListener('click', async () => {
                if (retryFired) return;
                retryFired = true;
                retry.disabled = true;
                try {
                    await retryHandler();
                } catch (e) {
                    console.error('Food photo retry handler failed:', e);
                }
            });
            actions.appendChild(retry);
            root.appendChild(actions);
        }
    }

    return { root, dismiss, showRemoved, showError };
}
