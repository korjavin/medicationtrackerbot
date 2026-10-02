// Shared utility functions.
// Loaded early (before app.js) — no dependencies on other app files. The
// few globals used here (window.SyncManager) resolve lazily at call time, so
// utils.js can be evaluated standalone (isolated tests, and the passkey shell
// document signup.html, which loads it for the in-page dialogs).
//
// No native browser dialogs (alert/confirm/prompt) anywhere in the app: every
// dialog is the in-page one below (bd med-v83g; enforced by
// architecture.no-native-dialogs.test.js).

// safeAlert — the in-page replacement for native alert(): the message and a
// single OK button. Non-blocking; resolves (undefined) once dismissed via OK,
// Escape, the backdrop, or Back. opts (optional): { title, confirmLabel }.
function safeAlert(msg, opts) {
    return new Promise((resolve) => {
        _mountConfirmModal(msg, () => resolve(), { ...(opts || {}), alert: true });
    });
}

// safeToast prefers the non-blocking SyncManager toast and falls back to
// safeAlert when no toast surface exists (bd med-omvw — success/info
// messages should not pop blocking alerts). Like safeAlert it resolves
// window.SyncManager lazily at call time, so utils.js keeps no dependency
// on sync.js load order. type is 'info' (default) or 'error'.
function safeToast(msg, type) {
    const sm = window.SyncManager;
    if (sm && typeof sm.showToast === 'function') {
        sm.showToast(msg, type || 'info');
        return;
    }
    safeAlert(msg);
}

// opts (optional): { title, confirmLabel, cancelLabel } — custom wording for
// the in-page modal.
function safeConfirm(msg, callback, opts) {
    const invokeCallback = (ok) => {
        if (typeof callback !== 'function') return ok;
        return callback(ok);
    };

    return new Promise((resolve, reject) => {
        const handleResult = (ok) => {
            Promise.resolve(invokeCallback(ok)).then(resolve).catch(reject);
        };

        _mountConfirmModal(msg, handleResult, opts);
    });
}

// safePrompt — the in-page replacement for native prompt(): a text field in
// the confirm modal shell. Resolves the trimmed value, or null on cancel. An
// empty value shows opts.emptyError inline and keeps the dialog open.
// opts: { title, label, value, placeholder, maxLength, inputMode (e.g.
// 'decimal' for a numeric keypad), confirmLabel, cancelLabel, emptyError }.
function safePrompt(msg, opts) {
    return new Promise((resolve) => {
        _mountConfirmModal(msg, resolve, { ...(opts || {}), input: true });
    });
}

// safeChoose — the in-page replacement for a native <select>: a list of
// tappable options in the confirm modal shell. choices: [{ value, label,
// selected, disabled }]. Resolves the picked choice's value, or null on
// cancel. opts: { title, cancelLabel }.
function safeChoose(msg, choices, opts) {
    return new Promise((resolve) => {
        _mountConfirmModal(msg, resolve, { ...(opts || {}), choices: choices || [] });
    });
}

// In-page dialog used by safeAlert / safeConfirm / safePrompt / safeChoose.
// It renders non-blockingly (unlike the synchronous native dialogs) and
// resolves via its buttons, the backdrop click, or the Escape key. Confirm
// mode settles true/false; input and choices modes settle the value or null;
// alert mode has one OK button in the .mt-confirm-modal__cancel slot, so
// Back's cancel-first path (modal-manager.js) dismisses it too.
function _mountConfirmModal(msg, onResult, opts = {}) {
    const doc = document;
    const alertMode = opts.alert === true;
    const inputMode = opts.input === true;
    const choiceMode = Array.isArray(opts.choices);
    const backdrop = doc.createElement('div');
    backdrop.className = 'mt-confirm-backdrop';

    const modal = doc.createElement('mt-modal');
    modal.className = 'wg-modal mt-confirm-modal';

    const header = doc.createElement('div');
    header.className = 'wg-modal__header';
    const title = doc.createElement('h3');
    title.className = 'wg-modal__title';
    title.textContent = opts.title || (alertMode ? 'Notice' : 'Confirm');
    header.appendChild(title);

    const body = doc.createElement('div');
    body.className = 'wg-modal__body';
    if (!(inputMode || choiceMode) || msg) {
        const messageEl = doc.createElement('p');
        messageEl.className = 'mt-confirm-modal__message';
        messageEl.textContent = String(msg ?? '');
        body.appendChild(messageEl);
    }

    const actions = doc.createElement('div');
    actions.className = 'wg-modal__actions';
    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = alertMode
        ? 'wg-gloss wg-gloss--sun mt-confirm-modal__cancel'
        : 'wg-gloss mt-confirm-modal__cancel';
    cancelBtn.textContent = alertMode ? (opts.confirmLabel || 'OK') : (opts.cancelLabel || 'Cancel');
    actions.appendChild(cancelBtn);
    let confirmBtn = null;
    if (!choiceMode && !alertMode) {
        confirmBtn = doc.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'wg-gloss wg-gloss--sun mt-confirm-modal__confirm';
        confirmBtn.textContent = opts.confirmLabel || (inputMode ? 'Save' : 'Confirm');
        actions.appendChild(confirmBtn);
    }

    let input = null;
    let errorEl = null;
    if (inputMode) {
        const field = doc.createElement('label');
        field.className = 'wg-field';
        if (opts.label) {
            const labelEl = doc.createElement('span');
            labelEl.className = 'mt-confirm-modal__label';
            labelEl.textContent = opts.label;
            field.appendChild(labelEl);
        }
        input = doc.createElement('input');
        input.type = 'text';
        input.className = 'wg-input mt-confirm-modal__input';
        input.autocomplete = 'off';
        if (opts.inputMode) input.setAttribute('inputmode', opts.inputMode);
        input.value = opts.value == null ? '' : String(opts.value);
        if (opts.placeholder) input.placeholder = opts.placeholder;
        if (opts.maxLength) input.maxLength = opts.maxLength;
        field.appendChild(input);
        errorEl = doc.createElement('p');
        errorEl.className = 'mt-confirm-modal__error';
        errorEl.setAttribute('role', 'alert');
        errorEl.hidden = true;
        field.appendChild(errorEl);
        body.appendChild(field);
    }
    if (choiceMode) {
        const list = doc.createElement('div');
        list.className = 'mt-confirm-modal__choices';
        list.setAttribute('role', 'listbox');
        for (const choice of opts.choices) {
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'wg-gloss mt-confirm-modal__choice';
            btn.setAttribute('role', 'option');
            btn.setAttribute('aria-selected', choice.selected ? 'true' : 'false');
            if (choice.selected) btn.classList.add('mt-confirm-modal__choice--selected');
            btn.disabled = !!choice.disabled;
            btn.textContent = choice.label;
            btn.addEventListener('click', () => settle(choice.value));
            list.appendChild(btn);
        }
        body.appendChild(list);
    }

    // Input/choices dialogs keep their actions top-right so the mobile
    // keyboard never covers them; a plain confirm keeps them below.
    modal.appendChild(header);
    modal.appendChild(body);
    if (inputMode || choiceMode) {
        actions.classList.add('mt-confirm-modal__header-actions');
        header.appendChild(actions);
    } else {
        modal.appendChild(actions);
    }

    const cancelValue = alertMode ? undefined : (inputMode || choiceMode ? null : false);

    let resolved = false;
    function settle(result) {
        if (resolved) return;
        resolved = true;
        doc.removeEventListener('keydown', onKeydown, true);
        if (typeof modal.close === 'function') {
            try { modal.close(); } catch (_) { /* ignore */ }
        }
        if (modal.parentNode) modal.parentNode.removeChild(modal);
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        onResult(result);
    }

    function submit() {
        if (!inputMode) { settle(true); return; }
        const value = input.value.trim();
        if (!value) {
            errorEl.textContent = opts.emptyError || 'Please enter a value.';
            errorEl.hidden = false;
            input.setAttribute('aria-invalid', 'true');
            try { input.focus(); } catch (_) { /* ignore */ }
            return;
        }
        settle(value);
    }

    function onKeydown(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            settle(cancelValue);
        } else if (e.key === 'Enter' && inputMode && e.target === input && !e.isComposing) {
            e.preventDefault();
            submit();
        }
    }

    if (input) {
        input.addEventListener('input', () => {
            errorEl.hidden = true;
            input.removeAttribute('aria-invalid');
        });
    }
    cancelBtn.addEventListener('click', () => settle(cancelValue));
    if (confirmBtn) confirmBtn.addEventListener('click', submit);
    backdrop.addEventListener('click', () => settle(cancelValue));
    doc.addEventListener('keydown', onKeydown, true);

    doc.body.appendChild(backdrop);
    doc.body.appendChild(modal);
    if (typeof modal.open === 'function') {
        try { modal.open(); } catch (_) { /* ignore */ }
    }
    const focusEl = input
        || (choiceMode ? modal.querySelector('.mt-confirm-modal__choice--selected') : null)
        || confirmBtn || cancelBtn;
    try { focusEl.focus(); } catch (_) { /* ignore */ }
    if (input) { try { input.select(); } catch (_) { /* ignore */ } }
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

function escapeHtml(text) {
    if (!text) return "";
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

if (typeof window !== 'undefined') {
    window.escapeHtml = escapeHtml;
}
