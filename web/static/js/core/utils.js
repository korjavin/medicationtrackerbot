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
// on sync.js load order. type is 'info' (default), 'success' or 'error';
// opts are SyncManager.showToast's ({ action: { label, onClick }, detail,
// duration, … }). Returns the toast controller ({ root, dismiss }), or null
// on the safeAlert fallback.
function safeToast(msg, type, opts) {
    const sm = window.SyncManager;
    if (sm && typeof sm.showToast === 'function') {
        // Plain toasts keep the 2-arg call shape callers' spies assert on.
        return (opts === undefined ? sm.showToast(msg, type || 'info') : sm.showToast(msg, type || 'info', opts)) || null;
    }
    safeAlert(msg);
    return null;
}

// deleteWithUndo — the one row-delete path (kit rule 3: a row delete never
// asks first; it undoes from a toast). The row leaves the cached payloads at
// once through DataStore.applyOptimistic; the server delete runs only when
// the Undo window closes (or the page is being hidden, so closing the app
// still deletes). Undo rolls the snapshots back and sends nothing.
//   opts.message    — toast text ("Reading deleted")
//   opts.optimistic — [{ key, mutator, tags }] applied via applyOptimistic
//   opts.remove()   — performs the delete; resolve truthy on success. Falsy
//                     or a throw rolls the snapshots back (the row returns).
// One Undo window at a time: a new delete flushes the previous one first, so
// two whole-list snapshots of one key are never both open for rollback.
//   opts.duration   — ms the Undo window stays open (default 5000)
//   opts.replay     — { fn, arg }: a PENDING_DELETE_REPLAY function name + the
//                     record id. Journaled in localStorage while the delete is
//                     owed, so a tab killed mid-window (or mid-remove) still
//                     deletes on the next boot (replayPendingDeletes).
// Returns { undo(), flush(), done }: flush() deletes now; done resolves
// 'deleted' | 'undone' | 'failed'.
function deleteWithUndo(opts) {
    const o = opts || {};
    if (deleteWithUndo._active) deleteWithUndo._active.flush();
    const duration = typeof o.duration === 'number' ? o.duration : 5000;
    const journalId = o.replay ? _pendingDeletesAdd(o.replay, duration) : null;
    const ds = window.DataStore;
    const optimistic = Array.isArray(o.optimistic) ? o.optimistic : [];
    const handlesReady = (async () => {
        const hs = [];
        if (!ds || typeof ds.applyOptimistic !== 'function') return hs;
        for (const x of optimistic) {
            try { hs.push(await ds.applyOptimistic(x.key, x.mutator, x.tags || [])); }
            catch (e) { console.error('deleteWithUndo: optimistic remove failed', e); }
        }
        return hs;
    })();
    const settle = async (method) => {
        for (const h of await handlesReady) {
            try { await h[method](null); } catch (_) { /* best-effort */ }
        }
    };

    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    let running = null;
    let toast = null;
    let timer = null;
    // Leaving the app closes the Undo window: delete now rather than lose it.
    const onHide = (e) => {
        if (e.type === 'pagehide' || document.visibilityState === 'hidden') finish(false);
    };
    function finish(undo) {
        if (running) return running;
        if (deleteWithUndo._active === ctl) deleteWithUndo._active = null;
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', onHide);
        window.removeEventListener('pagehide', onHide);
        if (toast) toast.dismiss();
        running = (async () => {
            if (undo) {
                _pendingDeletesDrop(journalId);
                await settle('rollback');
                return 'undone';
            }
            // The handles stay pending through remove(): DataStore skips GETs
            // for those keys meanwhile, so a reload inside remove() can't
            // repaint the pre-delete row. Commit's refresh then reads the truth.
            await handlesReady;
            let ok = false;
            let threw = false;
            try { ok = !!(await o.remove()); } catch (e) {
                threw = true;
                console.error('deleteWithUndo: delete failed', e);
            }
            _pendingDeletesDrop(journalId);
            if (ok) {
                await settle('commit');
                return 'deleted';
            }
            await settle('rollback');
            // A falsy result means apiCall already reported the failure.
            if (threw) safeToast("Couldn't delete. It's back in the list.", 'error');
            return 'failed';
        })();
        running.then(resolveDone);
        return running;
    }

    // No toast surface (isolated shells) means no Undo; the timer still deletes.
    const sm = window.SyncManager;
    if (sm && typeof sm.showToast === 'function') {
        toast = sm.showToast(o.message || 'Deleted', 'info', {
            action: { label: 'Undo', onClick: () => finish(true) },
            duration: 0,
        }) || null;
    }
    timer = setTimeout(() => finish(false), duration);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);

    const ctl = { undo: () => finish(true), flush: () => finish(false), done };
    deleteWithUndo._active = ctl;
    return ctl;
}

// Close the open Undo window now and wait for its delete — for programmatic
// reloads (update banner, SW controllerchange) that would otherwise cut it.
// Null when no window is open, so callers stay synchronous then.
function flushPendingDelete() {
    const a = deleteWithUndo._active;
    return a ? a.flush() : null;
}

// The delete journal holds only a function name and a record id — never
// record content (localStorage is outside the vault).
const PENDING_DELETES_KEY = 'wg-pending-deletes';
const PENDING_DELETE_REPLAY = ['_deleteBPApi', '_deleteWeightApi', '_deleteFoodLogApi',
    '_deleteNoteApi', '_deleteWorkoutSessionApi', '_archiveMedById'];

function _pendingDeletesRead() {
    try {
        const v = JSON.parse(localStorage.getItem(PENDING_DELETES_KEY) || '[]');
        return Array.isArray(v) ? v : [];
    } catch (_) { return []; }
}

function _pendingDeletesWrite(list) {
    try {
        if (list.length) localStorage.setItem(PENDING_DELETES_KEY, JSON.stringify(list));
        else localStorage.removeItem(PENDING_DELETES_KEY);
    } catch (_) { /* storage blocked: no journal, the in-page path still runs */ }
}

// at/ttl let another tab tell a live Undo window from an abandoned one.
function _pendingDeletesAdd(replay, ttl) {
    const id = Date.now() + '-' + Math.random().toString(36).slice(2);
    _pendingDeletesWrite([..._pendingDeletesRead(),
        { id, fn: String(replay.fn), arg: replay.arg, at: Date.now(), ttl }]);
    return id;
}

function _pendingDeletesDrop(id) {
    if (id) _pendingDeletesWrite(_pendingDeletesRead().filter((e) => e && e.id !== id));
}

// Grace past an entry's Undo window before another tab may take it over: an
// entry still inside window + grace may belong to a live tab (Undo pending).
const PENDING_DELETE_GRACE_MS = 10000;

// Boot: run deletes a page owed but never finished. A replay that already
// landed is a harmless repeat (delete/archive are idempotent). Each entry
// leaves the journal only once its delete succeeds; a failing one is retried
// on later boots, three tries at most.
async function replayPendingDeletes() {
    let waiting = false;
    for (const e of _pendingDeletesRead()) {
        const fn = e && PENDING_DELETE_REPLAY.includes(e.fn) ? window[e.fn] : null;
        if (typeof fn !== 'function') { _pendingDeletesDrop(e && e.id); continue; }
        if (Date.now() - (Number(e.at) || 0) < (Number(e.ttl) || 5000) + PENDING_DELETE_GRACE_MS) {
            waiting = true;
            continue;
        }
        let ok = false;
        try { ok = !!(await fn(e.arg)); } catch (err) { console.error('replayPendingDeletes failed', e.fn, err); }
        const tries = (Number(e.tries) || 0) + 1;
        if (ok || tries >= 3) _pendingDeletesDrop(e.id);
        else _pendingDeletesWrite(_pendingDeletesRead().map((x) => (x && x.id === e.id ? { ...x, tries } : x)));
    }
    // Young entries: their tab finishes (or Undoes) them; if it died, take over.
    if (waiting) setTimeout(replayPendingDeletes, PENDING_DELETE_GRACE_MS);
}

// opts (optional): { title, confirmLabel, cancelLabel, icon, tone,
// destructive, facts, typedConfirm, link } — custom wording for the in-page
// dialog (the D1 family, see _mountConfirmModal); destructive paints the
// confirm filled clay, typedConfirm gates it on typing that word.
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
// 'decimal' for a numeric keypad), confirmLabel, cancelLabel, emptyError,
// note }. note(value) → Node|null is a live, non-blocking hint under the field,
// re-run on every keystroke (the BMI goal warning, med-a6fb.8).
function safePrompt(msg, opts) {
    return new Promise((resolve) => {
        _mountConfirmModal(msg, resolve, { ...(opts || {}), input: true });
    });
}

// safeChoose — the in-page replacement for a native <select>: a list of
// tappable options in the confirm modal shell. choices: [{ value, label, sub,
// selected, disabled }]. Resolves the picked choice's value, or null on
// cancel. opts: { title, cancelLabel, icon, tone }. With opts.confirmLabel
// (D1 "choose + Continue"): a tap only selects, the preselected choice is
// opts.selected (or the one marked selected), and the confirm button settles
// the selected value.
function safeChoose(msg, choices, opts) {
    return new Promise((resolve) => {
        _mountConfirmModal(msg, resolve, { ...(opts || {}), choices: choices || [] });
    });
}

// safeForm — the confirm modal shell around caller-built content (a DOM node).
// Confirm calls opts.collect(); a null/undefined return keeps the dialog open,
// anything else settles as the resolved value. Cancel resolves null.
// opts: { title, confirmLabel, cancelLabel, collect }.
function safeForm(msg, content, opts) {
    return new Promise((resolve) => {
        _mountConfirmModal(msg, resolve, { ...(opts || {}), content });
    });
}

// In-page dialog used by safeAlert / safeConfirm / safePrompt / safeChoose /
// safeForm — the kit .wg-dialog anatomy (App UI kit v2, components.html):
// optional __icon, __title, __body, __acts with .wg-btn actions (Cancel
// ghost; confirm sun primary, or filled clay with opts.destructive). The
// element stays <mt-modal class="mt-confirm-modal">: ModalManager.isDialogOpen
// and modal-history.js key Back/Esc handling off that hook.
// It renders non-blockingly (unlike the synchronous native dialogs) and
// resolves via its buttons, the backdrop click, or the Escape key. Confirm
// mode settles true/false; input and choices modes settle the value or null;
// alert mode has one OK button in the .mt-confirm-modal__cancel slot, so
// Back's cancel-first path (modal-manager.js) dismisses it too.
// Shared opts: { title, icon (WGIcons name), tone, destructive }. The D1
// dialog family (kit components.html "Dialog family (D1)", med-ckm5.5):
//   tone 'danger' (data loss) | 'warn' (reversible) | 'info' (a choice) picks
//     the icon tile; destructive:true with no tone means tone 'danger'.
//     destructive (or tone 'danger') paints the confirm filled clay.
//   facts: [{ text, gone }] — what goes (gone: ×, li.is-gone) and what stays
//     (✓), rendered as .wg-dialog__facts under the message.
//   link: { label, onClick } — a .wg-link in the body ("Export a backup
//     first"); tapping it cancels the dialog, then runs onClick.
//   dangerOutline: Cancel raised (the safe choice), confirm .wg-btn--danger-ghost.
// safeConfirm also takes opts.typedConfirm: a word the user must type
// (case-insensitive) before the confirm button enables (.wg-dialog__confirm,
// "Type ERASE to confirm"). safeChoose with opts.confirmLabel selects on tap
// and settles on the confirm button (see safeChoose).
function _mountConfirmModal(msg, onResult, opts = {}) {
    const doc = document;
    const alertMode = opts.alert === true;
    const inputMode = opts.input === true;
    const choiceMode = Array.isArray(opts.choices);
    const pickMode = choiceMode && !!opts.confirmLabel;
    const contentMode = !!opts.content;
    const typedWord = (!inputMode && !choiceMode && !contentMode && !alertMode && opts.typedConfirm)
        ? String(opts.typedConfirm).trim() : '';
    const typedPhrase = typedWord.toLowerCase();
    const tone = opts.tone || (opts.destructive ? 'danger' : 'warn');
    const danger = !!opts.destructive || opts.tone === 'danger';
    const iconSvg = (name, size) => {
        if (!window.WGIcons) return null;
        try { return window.WGIcons.iconSvg(name, { size }); } catch (_) { return null; }
    };
    const backdrop = doc.createElement('div');
    backdrop.className = 'mt-confirm-backdrop';

    const modal = doc.createElement('mt-modal');
    modal.className = 'wg-dialog mt-confirm-modal';
    modal.setAttribute('role', 'alertdialog');
    const titleText = opts.title || (alertMode ? 'Notice' : 'Confirm');
    modal.setAttribute('aria-label', titleText);

    // The icon is decorative; the passkey shell has no WGIcons and skips it
    // (so does an unknown icon name).
    const svg = opts.icon ? iconSvg(opts.icon, 24) : null;
    if (svg) {
        const icon = doc.createElement('span');
        icon.className = tone === 'danger' ? 'wg-dialog__icon' : `wg-dialog__icon wg-dialog__icon--${tone === 'info' ? 'info' : 'warn'}`;
        icon.appendChild(svg);
        modal.appendChild(icon);
    }

    const title = doc.createElement('p');
    title.className = 'wg-dialog__title mt-confirm-modal__title';
    title.textContent = titleText;

    const body = doc.createElement('div');
    body.className = 'wg-dialog__body mt-confirm-modal__body';
    const facts = Array.isArray(opts.facts) ? opts.facts : [];
    let linkBtn = null;
    if (opts.link && opts.link.label) {
        linkBtn = doc.createElement('button');
        linkBtn.type = 'button';
        linkBtn.className = 'wg-link mt-confirm-modal__link';
        linkBtn.textContent = opts.link.label;
    }
    if (msg || linkBtn || !(inputMode || choiceMode || contentMode || facts.length)) {
        const messageEl = doc.createElement('p');
        messageEl.className = 'mt-confirm-modal__message';
        if (linkBtn) messageEl.append(linkBtn, msg ? ' ' : '');
        messageEl.append(String(msg ?? ''));
        body.appendChild(messageEl);
    }
    if (facts.length) {
        const list = doc.createElement('ul');
        list.className = 'wg-dialog__facts';
        for (const fact of facts) {
            const li = doc.createElement('li');
            if (fact.gone) li.className = 'is-gone';
            const mark = iconSvg(fact.gone ? 'x' : 'check', 16);
            if (mark) {
                mark.setAttribute('class', 'wg-ico');
                li.appendChild(mark);
            }
            const text = doc.createElement('span');
            text.textContent = fact.text;
            li.appendChild(text);
            list.appendChild(li);
        }
        body.appendChild(list);
    }

    const actions = doc.createElement('div');
    actions.className = 'wg-dialog__acts';
    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    // opts.dangerOutline (the "Switch account?" D1, bd med-ta2n.7): the safe
    // choice is the raised button, the risky one a danger outline.
    const outline = !!opts.dangerOutline;
    cancelBtn.className = alertMode
        ? 'wg-btn wg-btn--primary mt-confirm-modal__cancel'
        : `wg-btn${outline ? '' : ' wg-btn--ghost'} mt-confirm-modal__cancel`;
    cancelBtn.textContent = alertMode ? (opts.confirmLabel || 'OK') : (opts.cancelLabel || 'Cancel');
    actions.appendChild(cancelBtn);
    let confirmBtn = null;
    if ((!choiceMode || pickMode) && !alertMode) {
        confirmBtn = doc.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = `wg-btn ${outline ? 'wg-btn--danger-ghost' : danger ? 'wg-btn--danger' : 'wg-btn--primary'} mt-confirm-modal__confirm`;
        confirmBtn.textContent = opts.confirmLabel || (inputMode ? 'Save' : 'Confirm');
        if (typedPhrase) confirmBtn.disabled = true;
        actions.appendChild(confirmBtn);
    }

    let input = null;
    let errorEl = null;
    if (inputMode || typedPhrase) {
        const field = doc.createElement('label');
        // A typed confirm is the kit's .wg-dialog__confirm: "Type <b>ERASE</b>
        // to confirm" over the field.
        field.className = typedPhrase ? 'wg-dialog__confirm' : 'wg-field';
        if (typedPhrase) {
            const labelEl = doc.createElement('span');
            labelEl.className = 'wg-label mt-confirm-modal__label';
            const word = doc.createElement('b');
            word.textContent = typedWord;
            labelEl.append('Type ', word, ' to confirm');
            field.appendChild(labelEl);
        } else if (opts.label) {
            const labelEl = doc.createElement('span');
            labelEl.className = 'mt-confirm-modal__label';
            labelEl.textContent = opts.label;
            field.appendChild(labelEl);
        }
        input = doc.createElement('input');
        input.type = 'text';
        input.className = 'wg-input mt-confirm-modal__input';
        input.autocomplete = 'off';
        if (typedPhrase) {
            input.classList.add('wg-input--text');
            // An upper-case word (ERASE) gets the caps keyboard; the match
            // stays case-insensitive either way.
            input.setAttribute('autocapitalize', typedWord === typedWord.toUpperCase() ? 'characters' : 'none');
            input.spellcheck = false;
        }
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
    let noteSlot = null;
    const paintNote = () => {
        const node = noteSlot ? opts.note(input.value.trim()) : null;
        if (noteSlot) noteSlot.replaceChildren(...(node ? [node] : []));
    };
    if (inputMode && typeof opts.note === 'function') {
        noteSlot = doc.createElement('div');
        noteSlot.className = 'mt-confirm-modal__note';
        body.appendChild(noteSlot);
        paintNote();
    }
    let pickedValue;
    if (choiceMode) {
        const list = doc.createElement('div');
        list.className = 'wg-choices mt-confirm-modal__choices';
        const preselected = opts.selected !== undefined
            ? opts.selected
            : (opts.choices.find((c) => c.selected && !c.disabled) || {}).value;
        if (pickMode) {
            pickedValue = preselected;
            confirmBtn.disabled = preselected === undefined;
        }
        for (const choice of opts.choices) {
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'wg-choice mt-confirm-modal__choice';
            const pressed = pickMode ? choice.value === preselected : !!choice.selected;
            btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
            btn.disabled = !!choice.disabled;
            if (choice.sub) {
                const text = doc.createElement('span');
                const sub = doc.createElement('span');
                sub.className = 'wg-choice__sub';
                sub.textContent = choice.sub;
                text.append(String(choice.label), sub);
                btn.appendChild(text);
            } else {
                btn.textContent = choice.label;
            }
            btn.addEventListener('click', () => {
                if (!pickMode) { settle(choice.value); return; }
                pickedValue = choice.value;
                for (const other of list.children) other.setAttribute('aria-pressed', other === btn ? 'true' : 'false');
                confirmBtn.disabled = false;
            });
            list.appendChild(btn);
        }
        body.appendChild(list);
    }
    if (contentMode) body.appendChild(opts.content);

    // Dialogs with a field or a list keep their actions top-right beside the
    // title so the mobile keyboard never covers them (med-8j5w.5); a confirm
    // — typed or not — keeps the kit's full-width actions row below the body,
    // where a long destructive label ("Verify passkey & delete") still fits,
    // and so does choose + Continue (no keyboard; the D1 frame).
    if (inputMode || (choiceMode && !pickMode) || contentMode) {
        const head = doc.createElement('div');
        head.className = 'mt-confirm-modal__head';
        actions.classList.add('mt-confirm-modal__head-acts');
        head.appendChild(title);
        head.appendChild(actions);
        modal.appendChild(head);
        modal.appendChild(body);
    } else {
        modal.appendChild(title);
        modal.appendChild(body);
        modal.appendChild(actions);
    }

    const cancelValue = alertMode ? undefined : (inputMode || choiceMode || contentMode ? null : false);

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

    const typedMatches = () => input.value.trim().toLowerCase() === typedPhrase;

    function submit() {
        if (contentMode) {
            const value = typeof opts.collect === 'function' ? opts.collect() : true;
            if (value != null) settle(value);
            return;
        }
        if (typedPhrase) {
            if (typedMatches()) settle(true);
            return;
        }
        if (pickMode) {
            if (pickedValue !== undefined) settle(pickedValue);
            return;
        }
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
            // The dialog owns this Esc: the app's Esc (AppBack.step,
            // modal-manager.js) must not also step back under it.
            e.preventDefault();
            e.stopPropagation();
            settle(cancelValue);
        } else if (e.key === 'Enter' && input && e.target === input && !e.isComposing) {
            e.preventDefault();
            submit();
        }
    }

    if (input) {
        input.addEventListener('input', () => {
            errorEl.hidden = true;
            input.removeAttribute('aria-invalid');
            if (typedPhrase) confirmBtn.disabled = !typedMatches();
            paintNote();
        });
        // The dialog is centred in the visual viewport (dialog.css), so with
        // the keyboard up a tall one (icon, facts, typed field) scrolls inside
        // itself: bring the field into view once the keyboard has opened.
        // ponytail: fixed delay for the keyboard animation; a visualViewport
        // resize listener if 300ms proves short on some device.
        input.addEventListener('focus', () => {
            setTimeout(() => {
                if (typeof input.scrollIntoView === 'function') input.scrollIntoView({ block: 'nearest' });
            }, 300);
        });
    }
    if (linkBtn) {
        linkBtn.addEventListener('click', () => {
            settle(cancelValue);
            if (typeof opts.link.onClick === 'function') opts.link.onClick();
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
        || (choiceMode ? modal.querySelector('.mt-confirm-modal__choice[aria-pressed="true"]') : null)
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

// Parse a user-typed non-negative decimal from a type="text" inputmode="decimal"
// field (bd med-mysj). iOS comma-locale decimal pads type ',', which
// <input type="number"> silently drops, so fractional fields are text inputs and
// every read goes through here: ',' or '.' as the separator; '' / junk /
// negative → NaN. Integer fields stay type="number" inputmode="numeric".
function parseDecimal(v) {
    const s = String(v == null ? '' : v).trim().replace(',', '.');
    return /^(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
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
