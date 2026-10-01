// ====================================
// WORKOUT EQUIPMENT — INVENTORY UI
// ====================================
//
// med-niix.3: fifth Workouts sub-tab (inventory list + fixed/plated editor).
// Owns:
//   - the equipment list render (window.WorkoutEquipment.load)
//   - "currently editing equipment id" form state (closure-private,
//     published on window.WorkoutEdit via accessors — the no-module-state
//     rule forbids top-level let here while the top-level editor functions
//     below still need shared form state; same shape as groups.js/library.js)
//   - the editor modal flows (open/add/edit/close/save/delete)
//
// Read path is local-first per CLAUDE.md "Adding a local-first read":
// list via window.cachedFetch (key `workout_equipment`);
// OfflineNoCacheError renders an explicit empty state. Writes go through
// DataStore.applyOptimistic (rule 9).
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
// med-8j5w.2: gyms (flat location list) + the synced active-gym singleton,
// each its own cachedFetch key so writes can project optimistically (rule 9).
const WORKOUT_LOCATIONS_CACHE_KEY = 'workout_locations';
const WORKOUT_ACTIVE_LOCATION_CACHE_KEY = 'workout_active_location';
const WORKOUT_LOCATIONS_URL = '/api/workout/locations';
const WORKOUT_ACTIVE_LOCATION_URL = '/api/workout/locations/active';
const WORKOUT_LOCATION_FETCH_OPTS = { tags: ['workout'], freshAfterMs: 60_000, staleAfterMs: 24 * 60 * 60_000 };
// ponytail: mirrors the domain's MAX_FIXED_LOADS ceiling (web/domain/equipment.js)
// so the generator can never build a list the API would reject.
const WORKOUT_EQUIPMENT_MAX_GENERATED_LOADS = 200;
// med-v75c.1: the shared Type select values, stored as `implement` on both
// kinds (mirrors the domain's IMPLEMENT_VALUES in web/domain/equipment.js).
const WORKOUT_EQUIPMENT_IMPLEMENTS = ['barbell', 'dumbbell', 'kettlebell', 'other'];
// Implements with a row icon (a WGIcons name each); 'other' gets none.
const WORKOUT_EQUIPMENT_ICON_IMPLEMENTS = ['barbell', 'dumbbell', 'kettlebell'];

async function loadWorkoutEquipment() {
    const container = document.getElementById('workout-equipment-list');
    if (!container) return;

    if (typeof window.cachedFetch !== 'function') {
        // Early boot / non-browser harness: best-effort direct read.
        try {
            const raw = await apiCall(WORKOUT_EQUIPMENT_URL, 'GET');
            const items = Array.isArray(raw) ? raw : [];
            window.WorkoutEdit.cachedEquipment = items;
            _renderWorkoutEquipment(container, items, await _readWorkoutLocationsForList());
        } catch (e) {
            console.error('Error loading workout equipment:', e);
            _renderWorkoutEquipmentEmpty(container, 'Failed to load equipment.');
        }
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
        _renderWorkoutEquipment(container, items, await _readWorkoutLocationsForList());
    } catch (e) {
        if (window.OfflineNoCacheError && e instanceof window.OfflineNoCacheError) {
            window.WorkoutEdit.cachedEquipment = [];
            _renderWorkoutEquipmentEmpty(container, 'No cached equipment — connect to load.');
            return;
        }
        console.error('Error loading workout equipment:', e);
        _renderWorkoutEquipmentEmpty(container, 'Failed to load equipment.');
    }
}

// med-niix.5: shared inventory read for the library-editor Equipment
// <select> and the plan-modal hint — the same cachedFetch key/URL/options as
// the list render above, so consumers reuse this read instead of adding a
// second fetch path. Throws on failure (offline / network): the select must
// distinguish "inventory failed to load" from "no equipment" so a failed read
// can never silently unbind on the next save; the hint catches and hides.
async function getWorkoutEquipmentList() {
    try {
        if (typeof window.cachedFetch === 'function') {
            const result = await window.cachedFetch(
                WORKOUT_EQUIPMENT_CACHE_KEY,
                WORKOUT_EQUIPMENT_URL,
                { tags: ['workout'], freshAfterMs: 60_000, staleAfterMs: 24 * 60 * 60_000 }
            );
            const items = result && Array.isArray(result.data) ? result.data : [];
            window.WorkoutEdit.cachedEquipment = items;
            return items;
        }
        const raw = await apiCall(WORKOUT_EQUIPMENT_URL, 'GET');
        const items = Array.isArray(raw) ? raw : [];
        window.WorkoutEdit.cachedEquipment = items;
        return items;
    } catch (e) {
        window.WorkoutEdit.cachedEquipment = [];
        throw e;
    }
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

// med-8j5w.2: shared gyms read — { locations, activeId } (activeId null when
// unset, deleted, or its read failed). Throws when the location LIST fails:
// a failed read must never pass for "no gyms", which would show every item
// as portable and let an edit save it that way.
async function getWorkoutLocations() {
    const read = async (key, url) => {
        if (typeof window.cachedFetch === 'function') {
            const result = await window.cachedFetch(key, url, WORKOUT_LOCATION_FETCH_OPTS);
            return result ? result.data : null;
        }
        return apiCall(url, 'GET');
    };
    const raw = await read(WORKOUT_LOCATIONS_CACHE_KEY, WORKOUT_LOCATIONS_URL);
    if (!Array.isArray(raw)) throw new Error('Gyms failed to load');
    const locations = raw.filter((l) => l && l.id !== null && l.id !== undefined);
    let activeId = null;
    try {
        const active = await read(WORKOUT_ACTIVE_LOCATION_CACHE_KEY, WORKOUT_ACTIVE_LOCATION_URL);
        const id = active && typeof active === 'object' ? active.location_id : null;
        if (locations.some((l) => String(l.id) === String(id))) activeId = id;
    } catch (_) { activeId = null; }
    return { locations, activeId };
}

// The list's gym read: { locations, activeId } or { failed: true }.
async function _readWorkoutLocationsForList() {
    try {
        return await getWorkoutLocations();
    } catch (_) {
        return { failed: true };
    }
}

function _renderWorkoutEquipment(container, items, locState) {
    if (!container) return;
    const doc = container.ownerDocument;
    if (!doc || typeof doc.createElement !== 'function') return;

    container.classList.add('wg-equipment');
    const locations = locState && Array.isArray(locState.locations) ? locState.locations : [];

    // No gyms (or a failed gym read): exactly the pre-locations flat list.
    if (locations.length === 0) {
        if (!items || items.length === 0) {
            _renderWorkoutEquipmentEmpty(container, 'No equipment yet — tap Add to log your first barbell.');
        } else {
            const list = doc.createElement('ul');
            list.className = 'list-reset wg-equipment__list';
            items.forEach((item) => {
                list.appendChild(_buildWorkoutEquipmentRow(doc, item));
            });
            container.replaceChildren(list);
        }
        if (locState && locState.failed) {
            const err = doc.createElement('p');
            err.className = 'wg-equipment__error';
            err.textContent = 'Couldn\'t load your gyms — showing all equipment ungrouped.';
            container.insertBefore(err, container.firstChild);
        }
        return;
    }

    // Grouped by gym: one section per location, then "Portable / everywhere"
    // for unassigned items and items whose gym no longer exists (dangling).
    const groups = locations.map((loc) => ({ loc, items: [] }));
    const portable = [];
    (items || []).forEach((item) => {
        const lid = item && item.location_id;
        const group = (lid === null || lid === undefined) ? null
            : groups.find((g) => String(g.loc.id) === String(lid));
        if (group) group.items.push(item);
        else portable.push(item);
    });
    const sections = groups.map((g) => _buildWorkoutEquipmentGroup(
        doc, g.loc, g.items, String(g.loc.id) === String(locState.activeId)));
    sections.push(_buildWorkoutEquipmentGroup(doc, null, portable, false));
    container.replaceChildren(...sections);
}

// One gym section: header (name, active badge, rename/delete for a real gym)
// plus its rows. `loc` null is the Portable / everywhere group.
function _buildWorkoutEquipmentGroup(doc, loc, items, isActive) {
    const section = doc.createElement('section');
    section.className = 'wg-equipment-group';
    section.dataset.locationId = loc ? String(loc.id) : '';

    const header = doc.createElement('div');
    header.className = 'wg-equipment-group__header';
    const label = doc.createElement('span');
    label.className = 'wg-section-label wg-equipment-group__label';
    label.textContent = loc ? (loc.name || 'Gym') : 'Portable / everywhere';
    header.appendChild(label);
    if (isActive) {
        const badge = doc.createElement('span');
        badge.className = 'wg-tag wg-tag--mono wg-equipment-group__active';
        badge.textContent = 'Active';
        header.appendChild(badge);
    }
    // A pending optimistic gym carries a local_ id the API would reject.
    if (loc && !_isPendingEquipmentRow(loc)) {
        const actions = doc.createElement('div');
        actions.className = 'wg-equipment-row__actions wg-equipment-group__actions';
        actions.appendChild(_buildEquipmentIconBtn(doc, 'rename-location', `Rename ${loc.name || 'gym'}`, 'pencil', () => {
            renameWorkoutLocation(loc.id);
        }));
        actions.appendChild(_buildEquipmentIconBtn(doc, 'delete-location', `Delete ${loc.name || 'gym'}`, 'trash', () => {
            deleteWorkoutLocation(loc.id);
        }));
        header.appendChild(actions);
    }
    section.appendChild(header);

    if (items.length === 0) {
        const empty = doc.createElement('p');
        empty.className = 'wg-equipment__empty wg-equipment-group__empty';
        empty.textContent = loc ? 'No equipment here yet.' : 'Nothing portable.';
        section.appendChild(empty);
    } else {
        const list = doc.createElement('ul');
        list.className = 'list-reset wg-equipment__list';
        items.forEach((item) => list.appendChild(_buildWorkoutEquipmentRow(doc, item)));
        section.appendChild(list);
    }
    return section;
}

// The step/max line is the API's computed min_step_kg / max_kg, rendered
// verbatim. A row with no max_kg is an uncommitted optimistic create.
function _equipmentStepMaxText(item) {
    if (item == null || item.max_kg == null) return 'Saving…';
    if (item.min_step_kg == null) return `max ${item.max_kg} kg`;
    return `step ${item.min_step_kg} kg · max ${item.max_kg} kg`;
}

function _isPendingEquipmentRow(item) {
    return typeof item.id === 'string' && item.id.indexOf('local_') === 0;
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
    const kindLabel = item.kind === 'plated' ? 'Plated' : 'Fixed';
    const implementLabel = _implementLabel(item.implement);
    kindTag.textContent = implementLabel ? `${implementLabel} · ${kindLabel}` : kindLabel;
    title.appendChild(kindTag);

    // Decorative implement icon (iconSvg sets aria-hidden). The response's
    // implement is already resolved (implementOf: a plated item without a
    // stored implement reads as barbell); other/absent renders none.
    if (WORKOUT_EQUIPMENT_ICON_IMPLEMENTS.indexOf(item.implement) !== -1
        && typeof window !== 'undefined' && window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
        const icon = window.WGIcons.iconSvg(item.implement, { size: 16 });
        icon.classList.add('wg-equipment-row__icon');
        title.appendChild(icon);
    }

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

    // An uncommitted optimistic create ('Saving…') carries a local_ id the
    // API would reject: no edit/delete affordances until the reconcile lands.
    if (!_isPendingEquipmentRow(item)) {
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
    }

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

// Display label for the stored implement enum; unknown/absent renders no
// prefix so legacy rows keep their bare kind tag.
function _implementLabel(implement) {
    switch (implement) {
        case 'barbell': return 'Barbell';
        case 'dumbbell': return 'Dumbbell';
        case 'kettlebell': return 'Kettlebell';
        case 'other': return 'Other';
        default: return null;
    }
}

function _getEquipmentType() {
    const el = document.getElementById('workout-equipment-type');
    const value = el ? el.value : '';
    // Blank ("—") or anything unrecognized reads as unset; the payload omits
    // implement and plated geometry falls back to barbell.
    return WORKOUT_EQUIPMENT_IMPLEMENTS.indexOf(value) === -1 ? '' : value;
}

function _setEquipmentType(type) {
    const el = document.getElementById('workout-equipment-type');
    if (!el) return;
    el.value = WORKOUT_EQUIPMENT_IMPLEMENTS.indexOf(type) === -1 ? '' : type;
}

// ponytail: only three (sides, pair) combinations exist in practice, so a
// record outside them (e.g. sides:1 pair:true) opens on the nearest option —
// sides:1 wins the tie, matching the read path's derive order
// (defaultPlatedImplement in web/domain/equipment.js).
function _sidesPairToEquipmentType(sides, pair) {
    if (sides === 1) return 'kettlebell';
    if (pair) return 'dumbbell';
    return 'barbell';
}

function _equipmentTypeToSidesPair(type) {
    if (type === 'kettlebell') return { sides: 1, pair: false };
    if (type === 'dumbbell') return { sides: 2, pair: true };
    // other rides on the barbell geometry (sides:2, single) — implement is a
    // label, so an unrecognized shape still loads like a bar.
    return { sides: 2, pair: false };
}

function _addEquipmentPlateRow(kg, count) {
    const list = document.getElementById('workout-equipment-plates');
    if (!list) return;
    const doc = list.ownerDocument;
    const row = doc.createElement('div');
    row.className = 'wg-equipment-plate-row';
    row.setAttribute('data-plate-row', '');

    const kgWrap = doc.createElement('div');
    kgWrap.className = 'wg-gloss--inset wg-equipment-modal__input-wrap wg-equipment-plate-row__field';
    const kgInput = doc.createElement('input');
    kgInput.type = 'number';
    kgInput.min = '0';
    kgInput.step = '0.25';
    kgInput.placeholder = 'kg';
    kgInput.className = 'wg-equipment-plate-row__input';
    kgInput.setAttribute('data-plate-kg', '');
    kgInput.setAttribute('aria-label', 'Plate weight (kg)');
    if (kg != null && kg !== '') kgInput.value = String(kg);
    kgWrap.appendChild(kgInput);

    const times = doc.createElement('span');
    times.className = 'wg-equipment-plate-row__times';
    times.textContent = '×';

    const countWrap = doc.createElement('div');
    countWrap.className = 'wg-gloss--inset wg-equipment-modal__input-wrap wg-equipment-plate-row__field';
    const countInput = doc.createElement('input');
    countInput.type = 'number';
    countInput.min = '1';
    countInput.step = '1';
    countInput.placeholder = 'count';
    countInput.className = 'wg-equipment-plate-row__input';
    countInput.setAttribute('data-plate-count', '');
    countInput.setAttribute('aria-label', 'Plate count');
    if (count != null && count !== '') countInput.value = String(count);
    countWrap.appendChild(countInput);

    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'wg-gloss wg-equipment-plate-row__remove';
    remove.setAttribute('aria-label', 'Remove plate row');
    remove.textContent = 'Remove';

    row.appendChild(kgWrap);
    row.appendChild(times);
    row.appendChild(countWrap);
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

// Strict: any non-numeric token aborts with null (the caller alerts) so a
// typo never saves a load set the user did not ask for.
function _parseEquipmentLoads(text) {
    const tokens = String(text || '').split(/[,;\s]+/).filter((s) => s !== '');
    const loads = [];
    for (const token of tokens) {
        const n = Number(token);
        if (!Number.isFinite(n) || n <= 0) return null;
        loads.push(n);
    }
    return loads;
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
    window.ModalManager.workoutEquipment.open();

    document.getElementById('workout-equipment-name').value = '';
    _setEquipmentKind('fixed');
    document.getElementById('workout-equipment-loads').value = '';
    document.getElementById('workout-equipment-gen-min').value = '';
    document.getElementById('workout-equipment-gen-max').value = '';
    document.getElementById('workout-equipment-gen-step').value = '';
    document.getElementById('workout-equipment-bar').value = '';
    _setEquipmentType('barbell');
    const plates = document.getElementById('workout-equipment-plates');
    if (plates) plates.replaceChildren();
    _addEquipmentPlateRow('', '');
    return _fillEquipmentLocationSelect(undefined);
}

// med-8j5w.2: the editor's Location select. Hidden (and left unloaded) until a
// real gym read lands with at least one gym; with none, the editor is exactly
// today's. `current` is the item's stored location_id (undefined = a new item,
// which defaults to the active gym). A dangling id preselects Portable — it
// already reads as portable. The save sends location_id only when the user
// changed the pick, so a failed read or an untouched dangling id is preserved.
async function _fillEquipmentLocationSelect(current) {
    const select = document.getElementById('workout-equipment-location');
    const field = document.getElementById('workout-equipment-location-field');
    if (!select) return;
    const doc = select.ownerDocument;
    const seq = String(Number(select.dataset.seq || 0) + 1);
    select.dataset.seq = seq;
    select.replaceChildren();
    select.dataset.loaded = 'false';
    select.dataset.initial = '';
    if (field) field.hidden = true;
    let state = null;
    try {
        state = await getWorkoutLocations();
    } catch (_) {
        state = null;
    }
    if (select.dataset.seq !== seq || !state || state.locations.length === 0) return;
    for (const loc of state.locations) {
        const opt = doc.createElement('option');
        opt.value = String(loc.id);
        opt.textContent = loc.name || `Gym ${loc.id}`;
        select.appendChild(opt);
    }
    const portable = doc.createElement('option');
    portable.value = '';
    portable.textContent = 'Portable / everywhere';
    select.appendChild(portable);
    const want = current === undefined ? state.activeId : current;
    const live = want !== null && want !== undefined
        && state.locations.some((l) => String(l.id) === String(want));
    select.value = live ? String(want) : '';
    select.dataset.initial = current === undefined ? 'new-item' : select.value;
    select.dataset.loaded = 'true';
    if (field) field.hidden = false;
}

// The payload's location_id: absent unless the select holds a real gym read
// and (for an edit) the user changed it; '' = Portable (null).
function _equipmentLocationPayload() {
    const select = document.getElementById('workout-equipment-location');
    if (!select || select.dataset.loaded !== 'true') return undefined;
    if (select.value === select.dataset.initial) return undefined;
    return select.value === '' ? null : Number(select.value);
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
    window.ModalManager.workoutEquipment.open();

    document.getElementById('workout-equipment-name').value = item.name || '';
    // The modal is a singleton: reset both halves first so the previous item's
    // bar/plates (or loads) cannot leak into a mid-edit kind conversion.
    document.getElementById('workout-equipment-loads').value = '';
    document.getElementById('workout-equipment-gen-min').value = '';
    document.getElementById('workout-equipment-gen-max').value = '';
    document.getElementById('workout-equipment-gen-step').value = '';
    document.getElementById('workout-equipment-bar').value = '';
    _setEquipmentType('barbell');
    const platesEl = document.getElementById('workout-equipment-plates');
    if (platesEl) platesEl.replaceChildren();
    const kind = item.kind === 'plated' ? 'plated' : 'fixed';
    _setEquipmentKind(kind);
    // The shared Type select preselects the stored implement; a legacy plated
    // record without one falls back to sides/pair, while a legacy fixed
    // record opens on the blank "—" option so saving it never stamps a
    // label the user never chose.
    let type = item.implement;
    if (WORKOUT_EQUIPMENT_IMPLEMENTS.indexOf(type) === -1) {
        type = kind === 'plated' ? _sidesPairToEquipmentType(item.sides, item.pair) : '';
    }
    _setEquipmentType(type);
    if (kind === 'fixed') {
        const loads = Array.isArray(item.loads_kg) ? item.loads_kg : [];
        document.getElementById('workout-equipment-loads').value = loads.join(', ');
    } else {
        document.getElementById('workout-equipment-bar').value = item.bar_kg != null ? String(item.bar_kg) : '';
        const rows = Array.isArray(item.plates) && item.plates.length > 0 ? item.plates : [{ kg: '', count: '' }];
        rows.forEach((p) => _addEquipmentPlateRow(p.kg, p.count));
    }
    await _fillEquipmentLocationSelect(item.location_id === undefined ? null : item.location_id);
}

function closeWorkoutEquipmentModal() {
    window.ModalManager.workoutEquipment.close();
    window.WorkoutEdit.editingEquipmentId = null;
}

function _buildEquipmentPayload() {
    const payload = _buildEquipmentShapePayload();
    if (!payload) return null;
    const locationId = _equipmentLocationPayload();
    if (locationId !== undefined) payload.location_id = locationId;
    return payload;
}

function _buildEquipmentShapePayload() {
    const name = document.getElementById('workout-equipment-name').value.trim();
    if (!name) {
        safeAlert('Equipment name is required!');
        return null;
    }
    const kind = _getEquipmentKind();
    if (kind === 'fixed') {
        const loads = _parseEquipmentLoads(document.getElementById('workout-equipment-loads').value);
        if (!loads || loads.length === 0) {
            safeAlert('Fixed loads must be positive numbers, comma-separated (or use the generator).');
            return null;
        }
        const fixedPayload = { kind: 'fixed', name, loads_kg: loads };
        const fixedImplement = _getEquipmentType();
        if (fixedImplement) fixedPayload.implement = fixedImplement;
        return fixedPayload;
    }
    const barKg = Number(document.getElementById('workout-equipment-bar').value);
    if (!Number.isFinite(barKg) || barKg <= 0) {
        safeAlert('Bar weight must be a positive number.');
        return null;
    }
    const plates = _readEquipmentPlateRows();
    if (plates === null) return null;
    const implement = _getEquipmentType();
    const { sides, pair } = _equipmentTypeToSidesPair(implement);
    const platedPayload = {
        kind: 'plated',
        name,
        bar_kg: barKg,
        sides,
        pair,
        plates
    };
    if (implement) platedPayload.implement = implement;
    return platedPayload;
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
            // The projected row must not present step/max it has not read back
            // (renders 'Saving…' until the reconcile lands), and a kind change
            // must not leave the disowned side's fields behind — mirroring the
            // domain's own strip on update (web/domain/equipment.js).
            return list.map((e) => {
                if (!e || e.id !== editingId) return e;
                const projected = { ...e, ...payload, min_step_kg: null, max_kg: null };
                const disowned = payload.kind === 'fixed'
                    ? ['bar_kg', 'sides', 'pair', 'plates']
                    : ['loads_kg'];
                for (const k of disowned) delete projected[k];
                return projected;
            });
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

// ====================================
// GYMS (med-8j5w.2)
// ====================================

// _writeWorkoutLocations runs one gym write under rule 9: `mutator` projects
// the cached gym list up-front, the request runs, and success commits an
// authoritative re-read (or keeps the projection) while failure rolls back.
// Returns true on success. The equipment list repaints either way.
async function _writeWorkoutLocations(mutator, method, url, body, failMessage) {
    const handle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
        ? await window.DataStore.applyOptimistic(WORKOUT_LOCATIONS_CACHE_KEY, (prev) => mutator(Array.isArray(prev) ? prev.slice() : []), ['workout'])
        : null;
    let result = null;
    try {
        result = await apiCall(url, method, body, { suppressWriteAlert: true });
    } catch (e) {
        if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
        safeAlert('Error: ' + (e && e.message ? e.message : e));
        await loadWorkoutEquipment();
        return false;
    }
    if (!result) {
        if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
        safeAlert(failMessage);
        await loadWorkoutEquipment();
        return false;
    }
    let fresh = null;
    try {
        fresh = await apiCall(WORKOUT_LOCATIONS_URL, 'GET', null, { suppressWriteAlert: true });
    } catch (_) { /* commit keeps the projection; the next load reconciles */ }
    if (handle) { try { await handle.commit(Array.isArray(fresh) ? fresh : null); } catch (_) { /* reload covers it */ } }
    await loadWorkoutEquipment();
    return true;
}

function _promptWorkoutLocationName(current) {
    const raw = typeof window.prompt === 'function' ? window.prompt('Gym name', current || '') : null;
    const name = raw == null ? '' : String(raw).trim();
    return name || null;
}

async function addWorkoutLocation() {
    const name = _promptWorkoutLocationName('');
    if (!name) return false;
    return _writeWorkoutLocations(
        (list) => list.concat([{ id: `local_${Date.now()}`, name }]),
        'POST', WORKOUT_LOCATIONS_URL, { name }, "Couldn't add the gym — try again online.");
}

async function renameWorkoutLocation(id) {
    let current = '';
    try {
        const state = await getWorkoutLocations();
        current = (state.locations.find((l) => String(l.id) === String(id)) || {}).name || '';
    } catch (_) { current = ''; }
    const name = _promptWorkoutLocationName(current);
    if (!name || name === current) return false;
    return _writeWorkoutLocations(
        (list) => list.map((l) => (l && String(l.id) === String(id) ? { ...l, name } : l)),
        'PUT', `${WORKOUT_LOCATIONS_URL}/${id}`, { name }, "Couldn't rename the gym — try again online.");
}

async function deleteWorkoutLocation(id) {
    let ok = false;
    await safeConfirm('Delete this gym? Its equipment becomes portable (available everywhere).', async (yes) => {
        if (!yes) return;
        ok = await _writeWorkoutLocations(
            (list) => list.filter((l) => !l || String(l.id) !== String(id)),
            'DELETE', `${WORKOUT_LOCATIONS_URL}/${id}`, null, "Couldn't delete the gym — try again online.");
    });
    return ok;
}

// buildWorkoutGymSwitch → "At: <select>" over the gyms plus a "No gym"
// option (value ''), preselecting `selectedId`. `extra` ({ value, label }) adds
// a disabled placeholder option, e.g. a session's deleted gym. Shared by the
// next-workout card and the session header.
function buildWorkoutGymSwitch(doc, locations, selectedId, extra) {
    const wrap = doc.createElement('label');
    wrap.className = 'wg-workouts-gym-switch';
    const prefix = doc.createElement('span');
    prefix.className = 'wg-workouts-gym-switch__prefix';
    prefix.textContent = 'At:';
    const select = doc.createElement('select');
    select.className = 'wg-workouts-gym-switch__select';
    select.setAttribute('aria-label', 'Gym');
    for (const loc of locations) {
        const opt = doc.createElement('option');
        opt.value = String(loc.id);
        opt.textContent = loc.name || `Gym ${loc.id}`;
        select.appendChild(opt);
    }
    const none = doc.createElement('option');
    none.value = '';
    none.textContent = 'No gym';
    select.appendChild(none);
    if (extra) {
        const opt = doc.createElement('option');
        opt.value = extra.value;
        opt.textContent = extra.label;
        opt.disabled = true;
        opt.selected = true;
        select.appendChild(opt);
    } else {
        const live = selectedId !== null && selectedId !== undefined
            && locations.some((l) => String(l.id) === String(selectedId));
        select.value = live ? String(selectedId) : '';
    }
    wrap.appendChild(prefix);
    wrap.appendChild(select);
    return wrap;
}

// setWorkoutActiveLocation switches the synced active gym (null = none).
// Rule 9 on the active-gym cache key; returns true on success. Callers
// repaint what depends on it (next card, open session chips).
async function setWorkoutActiveLocation(locationId) {
    const id = locationId === '' || locationId === undefined ? null : locationId;
    let handle = null;
    try {
        if (window.DataStore && typeof window.DataStore.applyOptimistic === 'function') {
            handle = await window.DataStore.applyOptimistic(WORKOUT_ACTIVE_LOCATION_CACHE_KEY,
                () => ({ location_id: id, location: null }), ['workout']);
        }
    } catch (_) { handle = null; /* a failed cache projection must not block the write */ }
    let result = null;
    try {
        result = await apiCall(WORKOUT_ACTIVE_LOCATION_URL, 'PUT', { location_id: id }, { suppressWriteAlert: true });
    } catch (e) {
        result = null;
    }
    if (!result) {
        if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
        safeToast("Couldn't switch the gym — try again.", 'error');
        return false;
    }
    if (handle) { try { await handle.commit(result); } catch (_) { /* best-effort */ } }
    if (window.WorkoutSessions && typeof window.WorkoutSessions.refreshGear === 'function') {
        window.WorkoutSessions.refreshGear();
    }
    return true;
}

// med-8j5w.1: the gym scope the shared equipment rule resolves at —
// { locationId, liveLocationIds } for the domain's equipmentForExercise /
// inventoryAt. `stamped` is a session's own location_id when the caller has a
// stamped session (null included); undefined = the active gym. Never throws:
// no gyms or any failed read resolves to null (whole inventory, the
// pre-locations rule).
async function getWorkoutLocationScope(stamped) {
    try {
        const locs = await apiCall('/api/workout/locations', 'GET');
        if (!Array.isArray(locs) || locs.length === 0) return null;
        let locationId = stamped;
        if (locationId === undefined) {
            const active = await apiCall('/api/workout/locations/active', 'GET');
            locationId = active && typeof active === 'object' && !Array.isArray(active)
                && active.location_id !== undefined ? active.location_id : null;
        }
        return { locationId: locationId, liveLocationIds: locs.map((l) => l && l.id) };
    } catch (_) {
        return null;
    }
}

window.WorkoutEquipment = {
    load: loadWorkoutEquipment,
    list: getWorkoutEquipmentList,
    locationScope: getWorkoutLocationScope,
    locations: getWorkoutLocations,
    setActiveLocation: setWorkoutActiveLocation,
    gymSwitch: buildWorkoutGymSwitch,
    addLocation: addWorkoutLocation,
    renameLocation: renameWorkoutLocation,
    deleteLocation: deleteWorkoutLocation,
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

        // The `workout_equipment` key is read through cachedFetch with inline
        // tags, which registers it on first load — but a cold boot that pulls
        // remote changes invalidates ['workout'] before any feature loader
        // runs, so register the mapping at module load: without it the
        // pre-sync row survives invalidation and the first Equipment visit
        // paints stale inventory (registerTags is the documented seam for
        // keys read outside loadSWR; see data-store.js).
        if (window.DataStore && typeof window.DataStore.registerTags === 'function') {
            try {
                window.DataStore.registerTags(WORKOUT_EQUIPMENT_CACHE_KEY, ['workout']);
                window.DataStore.registerTags(WORKOUT_LOCATIONS_CACHE_KEY, ['workout']);
                window.DataStore.registerTags(WORKOUT_ACTIVE_LOCATION_CACHE_KEY, ['workout']);
            } catch (_) { /* best-effort */ }
        }

        const bindClick = (id, handler) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', handler);
        };

        bindClick('add-workout-equipment-btn', () => showAddWorkoutEquipmentModal());
        bindClick('add-workout-location-btn', () => addWorkoutLocation());
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
