// Shared utility functions.
// Loaded early (before app.js) — no dependencies on other app files.

function safeAlert(msg) {
    const tg = window.Telegram && window.Telegram.WebApp;
    if (tg && tg.showAlert) {
        try {
            tg.showAlert(msg);
        } catch (e) {
            alert(msg);
        }
    } else {
        alert(msg);
    }
}

function safeConfirm(msg, callback) {
    const tg = window.Telegram && window.Telegram.WebApp;
    const hasTelegramContext = !!(tg && (window.userInitData || tg.initData));
    const invokeCallback = (ok) => {
        if (typeof callback !== 'function') return ok;
        return callback(ok);
    };

    return new Promise((resolve, reject) => {
        const handleResult = (ok) => {
            Promise.resolve(invokeCallback(ok)).then(resolve).catch(reject);
        };

        if (hasTelegramContext && tg.showConfirm) {
            try {
                tg.showConfirm(msg, handleResult);
                return;
            } catch (e) {
                // fall through to in-page modal — never to native confirm(),
                // which is synchronous-modal and freezes first paint.
            }
        }

        _mountConfirmModal(msg, handleResult);
    });
}

// In-page replacement for the synchronous native confirm() dialog. The
// Telegram-native path (tg.showConfirm) is preferred when available because
// it renders non-blockingly over the WebView; this is the fallback for
// regular browsers and for any Telegram environment where showConfirm fails.
function _mountConfirmModal(msg, onResult) {
    const doc = document;
    const backdrop = doc.createElement('div');
    backdrop.className = 'mt-confirm-backdrop';

    const modal = doc.createElement('mt-modal');
    modal.className = 'wg-modal mt-confirm-modal';

    const header = doc.createElement('div');
    header.className = 'wg-modal__header';
    const title = doc.createElement('h3');
    title.className = 'wg-modal__title';
    title.textContent = 'Confirm';
    header.appendChild(title);

    const body = doc.createElement('div');
    body.className = 'wg-modal__body';
    const messageEl = doc.createElement('p');
    messageEl.className = 'mt-confirm-modal__message';
    messageEl.textContent = String(msg ?? '');
    body.appendChild(messageEl);

    const actions = doc.createElement('div');
    actions.className = 'wg-modal__actions';
    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'wg-gloss mt-confirm-modal__cancel';
    cancelBtn.textContent = 'Cancel';
    const confirmBtn = doc.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'wg-gloss wg-gloss--sun mt-confirm-modal__confirm';
    confirmBtn.textContent = 'Confirm';
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(actions);

    let resolved = false;
    function settle(ok) {
        if (resolved) return;
        resolved = true;
        doc.removeEventListener('keydown', onKeydown, true);
        if (typeof modal.close === 'function') {
            try { modal.close(); } catch (_) { /* ignore */ }
        }
        if (modal.parentNode) modal.parentNode.removeChild(modal);
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        onResult(ok);
    }

    function onKeydown(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            settle(false);
        }
    }

    cancelBtn.addEventListener('click', () => settle(false));
    confirmBtn.addEventListener('click', () => settle(true));
    backdrop.addEventListener('click', () => settle(false));
    doc.addEventListener('keydown', onKeydown, true);

    doc.body.appendChild(backdrop);
    doc.body.appendChild(modal);
    if (typeof modal.open === 'function') {
        try { modal.open(); } catch (_) { /* ignore */ }
    }
    try { confirmBtn.focus(); } catch (_) { /* ignore */ }
}

function formatDateTimeLocalForInput(dateValue = new Date()) {
    const localDate = dateValue instanceof Date ? new Date(dateValue.getTime()) : new Date(dateValue);
    localDate.setMinutes(localDate.getMinutes() - localDate.getTimezoneOffset());
    return localDate.toISOString().slice(0, 16);
}

function downloadBlobAsFile(blob, filename) {
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(link);
}

// Convert a stored kg weight into the user's preferred display unit. Storage
// is always kg; this is purely a render-time helper so display surfaces
// (Today tile, goal card, history list, chart legend) share a single
// rounding + label convention.
const KG_PER_LB = 0.45359237;

function formatWeight(kg, unit) {
    const u = unit === 'lb' ? 'lb' : 'kg';
    const num = Number(kg);
    if (!Number.isFinite(num)) return { value: NaN, label: u };
    const display = u === 'lb' ? num / KG_PER_LB : num;
    return { value: Math.round(display * 10) / 10, label: u };
}

function readWeightUnitPreference() {
    if (typeof window === 'undefined') return 'kg';
    return window.weightUnitPreference === 'lb' ? 'lb' : 'kg';
}
