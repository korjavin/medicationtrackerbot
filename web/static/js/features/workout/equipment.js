// ====================================
// WORKOUT EQUIPMENT — INVENTORY UI
// ====================================
//
// med-niix.3: fifth Workouts sub-tab (inventory list + fixed/plated editor).
// Owns:
//   - the equipment list render (window.WorkoutEquipment.load)
//   - "currently editing equipment id" form state (closure-private,
//     exposed on WorkoutEdit because switchWorkoutTab/index.js routes here)
//   - the editor modal flows (open/add/edit/close/save/delete)
//
// Read path is local-first per CLAUDE.md "Adding a local-first read":
// list via window.cachedFetch (key `workout_equipment`) + <wg-stale-badge>
// mounted from the same key; OfflineNoCacheError renders an explicit empty
// state. Writes go through DataStore.applyOptimistic (rule 9).
//
// The list shows the API's computed min_step_kg / max_kg verbatim — never
// recomputed client-side (the knapsack lives in web/domain/equipment.js).

(function () {
    let _editingEquipmentId = null;
    // Last-rendered equipment rows. Hydrated by loadWorkoutEquipment;
    // consumed by showEditWorkoutEquipmentModal so edit opens without a fetch.
    let _cachedEquipment = [];

    window.WorkoutEdit = window.WorkoutEdit || {};
    Object.defineProperty(window.WorkoutEdit, 'editingEquipmentId', {
        get: () => _editingEquipmentId,
        set: (v) => { _editingEquipmentId = v; },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(window.WorkoutEdit, 'cachedEquipment', {
        get: () => _cachedEquipment,
        set: (v) => { _cachedEquipment = Array.isArray(v) ? v : []; },
        enumerable: true,
        configurable: true
    });
})();

const WORKOUT_EQUIPMENT_CACHE_KEY = 'workout_equipment';
const WORKOUT_EQUIPMENT_URL = '/api/workout/equipment';
// ponytail: mirrors the domain's MAX_FIXED_LOADS ceiling (web/domain/equipment.js)
// so the generator can never build a list the API would reject.
const WORKOUT_EQUIPMENT_MAX_GENERATED_LOADS = 200;

async function loadWorkoutEquipment() {
    const container = document.getElementById('workout-equipment-list');
    if (!container) return;

    if (typeof window.cachedFetch !== 'function') {
        // Early boot / non-browser harness: best-effort direct read.
        try {
            const raw = await apiCall(WORKOUT_EQUIPMENT_URL, 'GET');
            const items = Array.isArray(raw) ? raw : [];
            window.WorkoutEdit.cachedEquipment = items;
            _renderWorkoutEquipment(container, items);
        } catch (e) {
            console.error('Error loading workout equipment:', e);
            _renderWorkoutEquipmentEmpty(container, 'Failed to load equipment.');
        }
        await renderWorkoutEquipmentStaleBadge();
        return;
    }

    try {
        const result = await window.cachedFetch(
            WORKOUT_EQUIPMENT_CACHE_KEY,
            WORKOUT_EQUIPMENT_URL,
            { tags: ['workout'], freshAfterMs: 60_000, staleAfterMs: 24 * 60 * 60_000 }
        );
        const items = result && Array.isArray(result.data) ? result.data : [];
        window.WorkoutEdit.cachedEquipment = items;
        _renderWorkoutEquipment(container, items);
        await renderWorkoutEquipmentStaleBadge();
    } catch (e) {
        if (window.OfflineNoCacheError && e instanceof window.OfflineNoCacheError) {
            window.WorkoutEdit.cachedEquipment = [];
            _renderWorkoutEquipmentEmpty(container, 'No cached equipment — connect to load.');
            await renderWorkoutEquipmentStaleBadge();
            return;
        }
        console.error('Error loading workout equipment:', e);
        _renderWorkoutEquipmentEmpty(container, 'Failed to load equipment.');
        await renderWorkoutEquipmentStaleBadge();
    }
}

async function renderWorkoutEquipmentStaleBadge() {
    const slot = (typeof document !== 'undefined') ? document.getElementById('workout-equipment-stale-badge') : null;
    if (!slot) return;
    const api = (typeof window !== 'undefined') ? window.WGStaleBadge : null;
    if (!api || typeof api.mountFromKey !== 'function') {
        slot.replaceChildren();
        slot.classList.add('hidden');
        return;
    }
    await api.mountFromKey({ slot, key: WORKOUT_EQUIPMENT_CACHE_KEY });
}

function _renderWorkoutEquipmentEmpty(container, message) {
    if (!container) return;
    const doc = container.ownerDocument;
    if (!doc || typeof doc.createElement !== 'function') return;
    const empty = doc.createElement('p');
    empty.className = 'wg-equipment__empty';
    empty.textContent = message;
    container.replaceChildren(empty);
}

function _renderWorkoutEquipment(container, items) {
    if (!container) return;
    const doc = container.ownerDocument;
    if (!doc || typeof doc.createElement !== 'function') return;

    container.classList.add('wg-equipment');

    if (!items || items.length === 0) {
        _renderWorkoutEquipmentEmpty(container, 'No equipment yet — tap Add to log your first barbell.');
        return;
    }

    const list = doc.createElement('ul');
    list.className = 'list-reset wg-equipment__list';
    items.forEach((item) => {
        list.appendChild(_buildWorkoutEquipmentRow(doc, item));
    });
    container.replaceChildren(list);
}

// The step/max line is the API's computed min_step_kg / max_kg, rendered
// verbatim. A row with no max_kg is an uncommitted optimistic create.
function _equipmentStepMaxText(item) {
    if (item == null || item.max_kg == null) return 'Saving…';
    if (item.min_step_kg == null) return `max ${item.max_kg} kg`;
    return `step ${item.min_step_kg} kg · max ${item.max_kg} kg`;
}

function _buildWorkoutEquipmentRow(doc, item) {
    const card = doc.createElement('li');
    card.className = 'wg-card wg-equipment-row';
    card.dataset.equipmentId = String(item.id || '');

    const body = doc.createElement('div');
    body.className = 'wg-equipment-row__body';

    const title = doc.createElement('div');
    title.className = 'wg-equipment-row__title';

    const kindTag = doc.createElement('span');
    kindTag.className = 'wg-tag wg-tag--mono wg-equipment-row__kind';
    kindTag.textContent = item.kind === 'plated' ? 'Plated' : 'Fixed';
    title.appendChild(kindTag);

    const name = doc.createElement('span');
    name.className = 'wg-equipment-row__name';
    name.textContent = item.name || 'Equipment';
    title.appendChild(name);
    body.appendChild(title);

    const meta = doc.createElement('div');
    meta.className = 'wg-equipment-row__meta';
    const steps = doc.createElement('span');
    steps.className = 'wg-equipment-row__steps';
    steps.textContent = _equipmentStepMaxText(item);
    meta.appendChild(steps);
    body.appendChild(meta);

    card.appendChild(body);

    const actions = doc.createElement('div');
    actions.className = 'wg-equipment-row__actions';
    actions.appendChild(_buildEquipmentIconBtn(doc, 'edit', 'Edit equipment', 'pencil', () => {
        showEditWorkoutEquipmentModal(item.id);
    }));
    actions.appendChild(_buildEquipmentIconBtn(doc, 'delete', 'Delete equipment', 'trash', (event) => {
        deleteWorkoutEquipmentItem(item.id, event);
    }));
    card.appendChild(actions);

    card.addEventListener('click', (e) => {
        if (e.target.closest('.wg-equipment-row__actions')) return;
        showEditWorkoutEquipmentModal(item.id);
    });

    return card;
}

function _buildEquipmentIconBtn(doc, kind, ariaLabel, iconName, handler) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = `wg-icon-btn wg-equipment-row__${kind}`;
    btn.setAttribute('aria-label', ariaLabel);
    const gloss = doc.createElement('span');
    gloss.className = 'wg-gloss';
    if (typeof window !== 'undefined' && window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
        gloss.appendChild(window.WGIcons.iconSvg(iconName, { size: 16 }));
    }
    btn.appendChild(gloss);
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handler(e);
    });
    return btn;
}

// ====================================
// EDITOR MODAL
// ====================================

function _getEquipmentKind() {
    const active = document.querySelector('#workout-equipment-kind [data-kind][aria-pressed="true"]');
    const kind = active ? active.dataset.kind : 'fixed';
    return kind === 'plated' ? 'plated' : 'fixed';
}

function _setEquipmentKind(kind) {
    const want = kind === 'plated' ? 'plated' : 'fixed';
    document.querySelectorAll('#workout-equipment-kind [data-kind]').forEach((btn) => {
        const active = btn.dataset.kind === want;
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        btn.classList.toggle('wg-gloss--sun', active);
    });
    const fixed = document.getElementById('workout-equipment-fixed-section');
    const plated = document.getElementById('workout-equipment-plated-section');
    if (fixed) fixed.hidden = want !== 'fixed';
    if (plated) plated.hidden = want !== 'plated';
}

function _getEquipmentSides() {
    const active = document.querySelector('#workout-equipment-sides [data-sides][aria-pressed="true"]');
    return active && active.dataset.sides === '1' ? 1 : 2;
}

function _setEquipmentSides(sides) {
    const want = sides === 1 ? '1' : '2';
    document.querySelectorAll('#workout-equipment-sides [data-sides]').forEach((btn) => {
        const active = btn.dataset.sides === want;
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        btn.classList.toggle('wg-gloss--sun', active);
    });
}

function _addEquipmentPlateRow(kg, count) {
    const list = document.getElementById('workout-equipment-plates');
    if (!list) return;
    const doc = list.ownerDocument;
    const row = doc.createElement('div');
    row.className = 'wg-equipment-plate-row';
    row.setAttribute('data-plate-row', '');

    const kgInput = doc.createElement('input');
    kgInput.type = 'number';
    kgInput.min = '0';
    kgInput.step = '0.25';
    kgInput.placeholder = 'kg';
    kgInput.className = 'wg-equipment-plate-row__input';
    kgInput.setAttribute('data-plate-kg', '');
    kgInput.setAttribute('aria-label', 'Plate weight (kg)');
    if (kg != null && kg !== '') kgInput.value = String(kg);

    const times = doc.createElement('span');
    times.className = 'wg-equipment-plate-row__times';
    times.textContent = '×';

    const countInput = doc.createElement('input');
    countInput.type = 'number';
    countInput.min = '1';
    countInput.step = '1';
    countInput.placeholder = 'count';
    countInput.className = 'wg-equipment-plate-row__input';
    countInput.setAttribute('data-plate-count', '');
    countInput.setAttribute('aria-label', 'Plate count');
    if (count != null && count !== '') countInput.value = String(count);

    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'wg-gloss wg-equipment-plate-row__remove';
    remove.setAttribute('aria-label', 'Remove plate row');
    remove.textContent = 'Remove';

    row.appendChild(kgInput);
    row.appendChild(times);
    row.appendChild(countInput);
    row.appendChild(remove);
    list.appendChild(row);
}

function _readEquipmentPlateRows() {
    const rows = Array.from(document.querySelectorAll('#workout-equipment-plates [data-plate-row]'));
    const plates = [];
    for (const row of rows) {
        const kgRaw = row.querySelector('[data-plate-kg]').value;
        const countRaw = row.querySelector('[data-plate-count]').value;
        if ((kgRaw === '' || kgRaw == null) && (countRaw === '' || countRaw == null)) continue;
        const kg = Number(kgRaw);
        const count = Number(countRaw);
        if (!Number.isFinite(kg) || kg <= 0) {
            safeAlert('Plate weight must be a positive number.');
            return null;
        }
        if (!Number.isInteger(count) || count < 1) {
            safeAlert('Plate count must be a whole number of at least 1.');
            return null;
        }
        plates.push({ kg, count });
    }
    return plates;
}

function _parseEquipmentLoads(text) {
    return String(text || '')
        .split(/[,;\s]+/)
        .filter((s) => s !== '')
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0);
}

function fillEquipmentLoadsFromGenerator() {
    const min = Number(document.getElementById('workout-equipment-gen-min').value);
    const max = Number(document.getElementById('workout-equipment-gen-max').value);
    const step = Number(document.getElementById('workout-equipment-gen-step').value);
    if (!Number.isFinite(min) || min <= 0 || !Number.isFinite(max) || !Number.isFinite(step)) {
        safeAlert('Generator needs a min, max and step.');
        return;
    }
    if (!(step > 0)) {
        safeAlert('Generator step must be greater than 0.');
        return;
    }
    if (max < min) {
        safeAlert('Generator max must be at least min.');
        return;
    }
    const count = Math.floor((max - min) / step) + 1;
    if (count > WORKOUT_EQUIPMENT_MAX_GENERATED_LOADS || count < 1) {
        safeAlert(`Generator would build ${count} loads — keep it under ${WORKOUT_EQUIPMENT_MAX_GENERATED_LOADS + 1}.`);
        return;
    }
    const loads = [];
    for (let i = 0; i < count; i += 1) {
        loads.push(Math.round((min + i * step) * 100) / 100);
    }
    document.getElementById('workout-equipment-loads').value = loads.join(', ');
}

function showAddWorkoutEquipmentModal() {
    window.WorkoutEdit.editingEquipmentId = null;
    document.getElementById('workout-equipment-modal-title').textContent = 'Add Equipment';
    window.ModalManager.open('workout-equipment-modal');

    document.getElementById('workout-equipment-name').value = '';
    _setEquipmentKind('fixed');
    document.getElementById('workout-equipment-loads').value = '';
    document.getElementById('workout-equipment-gen-min').value = '';
    document.getElementById('workout-equipment-gen-max').value = '';
    document.getElementById('workout-equipment-gen-step').value = '';
    document.getElementById('workout-equipment-bar').value = '';
    _setEquipmentSides(2);
    document.getElementById('workout-equipment-pair').checked = false;
    const plates = document.getElementById('workout-equipment-plates');
    if (plates) plates.replaceChildren();
    _addEquipmentPlateRow('', '');
}

async function showEditWorkoutEquipmentModal(id) {
    let item = (window.WorkoutEdit.cachedEquipment || []).find((e) => e && e.id === id);
    if (!item) {
        try {
            item = await apiCall(`${WORKOUT_EQUIPMENT_URL}/${id}`, 'GET');
        } catch (e) {
            console.error('Error loading equipment item:', e);
            return;
        }
        if (!item) return;
    }

    window.WorkoutEdit.editingEquipmentId = id;
    document.getElementById('workout-equipment-modal-title').textContent = 'Edit Equipment';
    window.ModalManager.open('workout-equipment-modal');

    document.getElementById('workout-equipment-name').value = item.name || '';
    const kind = item.kind === 'plated' ? 'plated' : 'fixed';
    _setEquipmentKind(kind);
    if (kind === 'fixed') {
        const loads = Array.isArray(item.loads_kg) ? item.loads_kg : [];
        document.getElementById('workout-equipment-loads').value = loads.join(', ');
    } else {
        document.getElementById('workout-equipment-bar').value = item.bar_kg != null ? String(item.bar_kg) : '';
        _setEquipmentSides(item.sides === 1 ? 1 : 2);
        document.getElementById('workout-equipment-pair').checked = !!item.pair;
        const plates = document.getElementById('workout-equipment-plates');
        if (plates) plates.replaceChildren();
        const rows = Array.isArray(item.plates) && item.plates.length > 0 ? item.plates : [{ kg: '', count: '' }];
        rows.forEach((p) => _addEquipmentPlateRow(p.kg, p.count));
    }
}

function closeWorkoutEquipmentModal() {
    window.ModalManager.close('workout-equipment-modal');
    window.WorkoutEdit.editingEquipmentId = null;
}

function _buildEquipmentPayload() {
    const name = document.getElementById('workout-equipment-name').value.trim();
    if (!name) {
        safeAlert('Equipment name is required!');
        return null;
    }
    const kind = _getEquipmentKind();
    if (kind === 'fixed') {
        const loads = _parseEquipmentLoads(document.getElementById('workout-equipment-loads').value);
        if (loads.length === 0) {
            safeAlert('Fixed equipment needs at least one load (comma-separated, or use the generator).');
            return null;
        }
        return { kind: 'fixed', name, loads_kg: loads };
    }
    const barKg = Number(document.getElementById('workout-equipment-bar').value);
    if (!Number.isFinite(barKg) || barKg <= 0) {
        safeAlert('Bar weight must be a positive number.');
        return null;
    }
    const plates = _readEquipmentPlateRows();
    if (plates === null) return null;
    return {
        kind: 'plated',
        name,
        bar_kg: barKg,
        sides: _getEquipmentSides(),
        pair: !!document.getElementById('workout-equipment-pair').checked,
        plates
    };
}

// Writes honour rule 9: the projected row lands in the `workout_equipment`
// cache up-front and the handle commits or rolls back on failure. On success
// the cache is reconciled against an authoritative list read — the client
// must never project the API's computed step/max itself (PUT returns true,
// not the record, so the read is the only source).
async function saveWorkoutEquipmentItem() {
    const payload = _buildEquipmentPayload();
    if (!payload) return;

    const isCreate = !window.WorkoutEdit.editingEquipmentId;
    const editingId = window.WorkoutEdit.editingEquipmentId;
    const handle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
        ? await window.DataStore.applyOptimistic(WORKOUT_EQUIPMENT_CACHE_KEY, (prev) => {
            const list = Array.isArray(prev) ? prev.slice() : [];
            if (isCreate) {
                list.push({ ...payload, id: `local_${Date.now()}`, min_step_kg: null, max_kg: null });
                return list;
            }
            return list.map((e) => (e && e.id === editingId ? { ...e, ...payload } : e));
        }, ['workout'])
        : null;

    let result = null;
    try {
        if (isCreate) {
            result = await apiCall(WORKOUT_EQUIPMENT_URL, 'POST', payload, { suppressWriteAlert: true });
        } else {
            result = await apiCall(`${WORKOUT_EQUIPMENT_URL}/${editingId}`, 'PUT', payload, { suppressWriteAlert: true });
        }
    } catch (e) {
        if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
        safeAlert('Error: ' + (e && e.message ? e.message : e));
        return;
    }
    if (result || result === true) {
        let fresh = null;
        try {
            fresh = await apiCall(WORKOUT_EQUIPMENT_URL, 'GET', null, { suppressWriteAlert: true });
        } catch (_) { /* commit keeps the optimistic row; the next load reconciles */ }
        if (handle) {
            try { await handle.commit(Array.isArray(fresh) ? fresh : null); }
            catch (_) { /* the reload covers it */ }
        }
        closeWorkoutEquipmentModal();
        await loadWorkoutEquipment();
    } else {
        if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
        safeAlert("Couldn't save the equipment — try again online.");
    }
}

async function deleteWorkoutEquipmentItem(id, event) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    await safeConfirm('Delete this equipment?', async (ok) => {
        if (ok) {
            await _deleteWorkoutEquipmentApi(id);
        }
    });
}

async function _deleteWorkoutEquipmentApi(id) {
    const handle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
        ? await window.DataStore.applyOptimistic(WORKOUT_EQUIPMENT_CACHE_KEY, (prev) => {
            if (!Array.isArray(prev)) return prev;
            return prev.filter((e) => e && e.id !== id);
        }, ['workout'])
        : null;
    let result = null;
    try {
        result = await apiCall(`${WORKOUT_EQUIPMENT_URL}/${id}`, 'DELETE', null, { suppressWriteAlert: true });
    } catch (e) {
        if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
        safeAlert('Error: ' + (e && e.message ? e.message : e));
        return;
    }
    if (result || result === true) {
        if (handle) { try { await handle.commit(null); } catch (_) { /* the reload covers it */ } }
        loadWorkoutEquipment();
    } else {
        if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
        safeAlert("Couldn't delete the equipment — try again online.");
    }
}

window.WorkoutEquipment = {
    load: loadWorkoutEquipment,
    save: saveWorkoutEquipmentItem,
    openAdd: showAddWorkoutEquipmentModal,
    openEdit: showEditWorkoutEquipmentModal,
    close: closeWorkoutEquipmentModal,
    delete: deleteWorkoutEquipmentItem,
    fillFromGenerator: fillEquipmentLoadsFromGenerator
};

(function () {
    let equipmentControlsBound = false;

    function bindWorkoutEquipmentControls() {
        if (equipmentControlsBound) return;
        equipmentControlsBound = true;

        const bindClick = (id, handler) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', handler);
        };

        bindClick('add-workout-equipment-btn', () => showAddWorkoutEquipmentModal());
        bindClick('workout-equipment-cancel-btn', () => closeWorkoutEquipmentModal());
        bindClick('workout-equipment-save-btn', () => saveWorkoutEquipmentItem());
        bindClick('workout-equipment-gen-fill', () => fillEquipmentLoadsFromGenerator());
        bindClick('workout-equipment-plate-add', () => _addEquipmentPlateRow('', ''));

        const kindGroup = document.getElementById('workout-equipment-kind');
        if (kindGroup) {
            kindGroup.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-kind]');
                if (btn) _setEquipmentKind(btn.dataset.kind);
            });
        }

        const sidesGroup = document.getElementById('workout-equipment-sides');
        if (sidesGroup) {
            sidesGroup.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-sides]');
                if (btn) _setEquipmentSides(Number(btn.dataset.sides));
            });
        }

        // Plate-row Remove buttons are per-row (rows come and go); one
        // delegated listener covers present and future rows.
        const plates = document.getElementById('workout-equipment-plates');
        if (plates) {
            plates.addEventListener('click', (e) => {
                const remove = e.target.closest('[data-plate-row] .wg-equipment-plate-row__remove');
                if (!remove) return;
                const row = remove.closest('[data-plate-row]');
                if (row) row.remove();
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindWorkoutEquipmentControls, { once: true });
    }
    bindWorkoutEquipmentControls();
})();
