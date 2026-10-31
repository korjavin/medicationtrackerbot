// ====================================
// EXERCISE LIBRARY
// ====================================
//
// Owns:
//   - "currently editing library item id" form state (closure-private,
//     not exposed on WorkoutEdit because no other concern reads it).

(function () {
    let _editingLibraryItemId = null;
    window.WorkoutEdit = window.WorkoutEdit || {};
    Object.defineProperty(window.WorkoutEdit, 'editingLibraryItemId', {
        get: () => _editingLibraryItemId,
        set: (v) => { _editingLibraryItemId = v; },
        enumerable: true,
        configurable: true
    });
})();

// Library screen view state (med: searchable library + Mine/All toggle).
// "Mine" is the user's own library rows; "All" appends the vendored static
// catalog, so the 1300-odd imported exercises are browsable and not only
// reachable by typing into a name field. Kept in module state so a keystroke
// or a toggle repaints from the already-loaded arrays instead of refetching.
let _libraryItems = []; // module-state: last-loaded library rows, so a keystroke repaints without refetching
let _libraryQuery = ''; // module-state: current library search text
let _librarySource = 'mine'; // module-state: current library source — 'mine' | 'all'

// The catalog half is unbounded; painting 1300 rows on a phone is not.
const EXERCISE_LIBRARY_ROW_CAP = 100;

async function loadExerciseLibrary() {
    const container = document.getElementById('exercise-library-list');
    // Tracks whether any callback (cached / fresh / error) painted the list.
    // The fetcher uses `apiCall`, which silently returns `null` on offline/5xx.
    // When that null reaches loadSWR with no cached value, neither onFresh
    // nor onError fires — leaving the initial "Loading exercise library..."
    // placeholder visible. Mirrors loadBPReadings / loadMeds.
    let renderedSomething = false;
    await window.DataStore.loadSWR({
        key: 'exercise_library',
        tags: ['exercise_library'],
        fetcher: async () => await apiCall('/api/workout/exercise-library'),
        onCached: async (cached) => {
            renderedSomething = true;
            _libraryItems = Array.isArray(cached) ? cached : [];
            await _repaintExerciseLibrary();
        },
        onFresh: async (fresh) => {
            renderedSomething = true;
            _libraryItems = Array.isArray(fresh) ? fresh : [];
            await _repaintExerciseLibrary();
        },
        onError: async (error, cached) => {
            console.error('Error loading exercise library:', error);
            if (cached) {
                renderedSomething = true;
            } else if (container) {
                renderedSomething = true;
                container.replaceChildren(createOfflineEmptyState({ reason: error }));
            }
        }
    });
    if (!renderedSomething && container) {
        container.replaceChildren(createOfflineEmptyState());
    }
}

// Same match rules as the name picker (word-prefix, then substring), applied
// to a whole list instead of the picker's 6-row shortlist.
function _filterExercises(items, q) {
    if (!q) return items;
    const tokens = q.split(/\s+/).filter(Boolean);
    return items.filter(item => _exerciseMatchTier(item.name, tokens, q) > 0);
}

// Repaint from module state — no fetch except the one-time catalog asset, and
// only when the user actually asks for "All".
//
// The first "All" repaint awaits the 913 KB asset, during which the user can
// type on or switch back to "Mine". Last-writer-wins, same guard the name
// picker uses: a stale continuation must not paint catalog rows over the newer
// view.
let _repaintSeq = 0; // module-state: last-writer-wins guard for the awaited catalog fetch
async function _repaintExerciseLibrary() {
    const seq = ++_repaintSeq;
    const container = document.getElementById('exercise-library-list');
    if (!container) return;
    let items = _filterExercises(_libraryItems, _libraryQuery);
    if (_librarySource === 'all') {
        const own = new Set(_libraryItems.map(i => (i.name || '').trim().toLowerCase()));
        const catalog = (await _loadExerciseCatalog())
            .filter(e => e.name && !own.has(e.name.trim().toLowerCase()))
            // equipment/target ride the existing `notes` meta slot rather than
            // growing a second meta renderer for two strings.
            // body_part rides along so a catalog row tags itself on the spot
            // instead of each of them re-resolving its own name asynchronously.
            .map(e => ({
                name: e.name,
                body_part: e.body_part,
                notes: [e.equipment, e.target].filter(Boolean).join(' · ')
            }));
        if (seq !== _repaintSeq) return;
        items = items.concat(_filterExercises(catalog, _libraryQuery));
    }
    _renderExerciseLibrary(container, items);
}

function setExerciseLibraryQuery(value) {
    _libraryQuery = (value || '').trim().toLowerCase();
    return _repaintExerciseLibrary();
}

function setExerciseLibrarySource(source) {
    _librarySource = source === 'all' ? 'all' : 'mine';
    document.querySelectorAll('#exercise-library-source [data-source]').forEach((btn) => {
        const active = btn.dataset.source === _librarySource;
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    return _repaintExerciseLibrary();
}

function _renderExerciseLibrary(container, items) {
    if (!container) return;
    const doc = container.ownerDocument;
    if (!doc || typeof doc.createElement !== 'function') return;

    container.classList.add('wg-workouts-exercises');

    if (!items || items.length === 0) {
        const empty = doc.createElement('p');
        empty.className = 'wg-workouts-exercises__empty';
        empty.textContent = _libraryQuery
            ? 'No exercises match that search.'
            : 'No exercises in library yet — tap Add to create one.';
        container.replaceChildren(empty);
        return;
    }

    const list = doc.createElement('ul');
    list.className = 'list-reset wg-workouts-exercises__list';

    items.slice(0, EXERCISE_LIBRARY_ROW_CAP).forEach((item) => {
        list.appendChild(_buildExerciseLibraryRow(doc, item));
    });

    const children = [list];
    if (items.length > EXERCISE_LIBRARY_ROW_CAP) {
        const hint = doc.createElement('p');
        hint.className = 'wg-hint wg-workouts-exercises__cap-hint';
        hint.textContent = `Showing ${EXERCISE_LIBRARY_ROW_CAP} of ${items.length} — type to narrow.`;
        children.push(hint);
    }
    container.replaceChildren(...children);
}

// A library row is tagged by the exercise's TARGET MUSCLE GROUP (a since-removed
// variant-name classifier used to label most of the library "AD-HOC").
// Resolution order: the user's stored override, else the
// static catalog's body_part for this name (async — the catalog is a lazily
// fetched asset), else an em dash.
function _libraryBodyPartLabel(bodyPart) {
    if (!bodyPart) return '';
    const friendly = window.WorkoutExerciseCatalog
        && window.WorkoutExerciseCatalog.friendlyBodyPart(bodyPart);
    return friendly || (bodyPart.charAt(0).toUpperCase() + bodyPart.slice(1));
}

async function _fillLibraryBodyPartTag(card, tag, name) {
    if (!window.WorkoutExerciseCatalog) return;
    const bodyPart = await window.WorkoutExerciseCatalog.getBodyPart(name);
    // The list may have been re-rendered while the catalog fetch was in flight.
    if (!bodyPart || !tag.isConnected) return;
    tag.textContent = _libraryBodyPartLabel(bodyPart);
    tag.classList.remove('wg-workouts-slot-tag--adhoc');
    tag.classList.add('wg-workouts-slot-tag--muscle');
    card.dataset.bodyPart = bodyPart;
}

function _buildExerciseLibraryRow(doc, item) {
    const bodyPart = (item.body_part || '').trim();

    const card = doc.createElement('li');
    card.className = 'wg-card wg-workouts-exercises-row';
    card.dataset.exerciseId = String(item.id || '');
    card.dataset.bodyPart = bodyPart;

    const body = doc.createElement('div');
    body.className = 'wg-workouts-exercises-row__body';

    const title = doc.createElement('div');
    title.className = 'wg-workouts-exercises-row__title';

    const slotTag = doc.createElement('span');
    slotTag.className = `wg-tag wg-tag--mono wg-workouts-slot-tag wg-workouts-slot-tag--${bodyPart ? 'muscle' : 'adhoc'} wg-workouts-exercises-row__slot`;
    slotTag.textContent = _libraryBodyPartLabel(bodyPart) || '—';
    title.appendChild(slotTag);
    if (!bodyPart) _fillLibraryBodyPartTag(card, slotTag, item.name || '');

    const name = doc.createElement('span');
    name.className = 'wg-workouts-exercises-row__name';
    name.textContent = item.name || 'Exercise';
    title.appendChild(name);

    body.appendChild(title);

    const meta = doc.createElement('div');
    meta.className = 'wg-workouts-exercises-row__meta';

    const setsCount = Number(item.default_sets) || 0;
    const repsMin = Number(item.default_reps_min) || 0;
    const repsMax = Number(item.default_reps_max) || 0;
    const repsStr = repsMax ? `${repsMin}-${repsMax}` : `${repsMin}`;
    if (setsCount > 0 || repsMin > 0) {
        const defaults = doc.createElement('span');
        defaults.className = 'wg-workouts-exercises-row__defaults';
        defaults.textContent = `${setsCount}×${repsStr}`;
        meta.appendChild(defaults);
    }

    if (Number.isFinite(Number(item.default_weight_kg)) && Number(item.default_weight_kg) > 0) {
        const weight = doc.createElement('span');
        weight.className = 'wg-workouts-exercises-row__weight';
        weight.textContent = `${Number(item.default_weight_kg)}kg`;
        meta.appendChild(weight);
    }

    if (item.notes) {
        const notes = doc.createElement('span');
        notes.className = 'wg-workouts-exercises-row__notes';
        notes.textContent = item.notes;
        meta.appendChild(notes);
    }

    if (meta.childNodes.length > 0) body.appendChild(meta);

    card.appendChild(body);

    // A catalog row (source "All") is not a library row yet — it has no id, so
    // there is nothing to edit or delete; the one action is "add it to mine",
    // which is the add modal with the name pre-filled.
    const isCatalogRow = !item.id;
    const actions = doc.createElement('div');
    actions.className = 'wg-workouts-exercises-row__actions';
    if (isCatalogRow) {
        actions.appendChild(_buildExercisesIconBtn(doc, 'add', 'Add to my library', 'plus', () => {
            showExerciseLibraryModal(item.name);
        }));
    } else {
        actions.appendChild(_buildExercisesIconBtn(doc, 'edit', 'Edit exercise', 'pencil', () => {
            showEditExerciseLibraryModal(item.id);
        }));
        actions.appendChild(_buildExercisesIconBtn(doc, 'delete', 'Delete exercise', 'trash', (event) => {
            deleteExerciseLibraryItem(item.id, event);
        }));
    }
    card.appendChild(actions);

    card.addEventListener('click', (e) => {
        if (e.target.closest('.wg-workouts-exercises-row__actions')) return;
        if (isCatalogRow) showExerciseLibraryModal(item.name);
        else showEditExerciseLibraryModal(item.id);
    });

    return card;
}

function _buildExercisesIconBtn(doc, kind, ariaLabel, iconName, handler) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = `wg-icon-btn wg-workouts-exercises-row__${kind}`;
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

// Fill the muscle-group <select> from the shared catalog vocabulary and select
// `current`. The blank option is the default: no override, so the row falls back
// to the catalog's own classification of the name.
function _syncBodyPartSelect(current) {
    const select = document.getElementById('exercise-library-body-part');
    if (!select) return;
    const options = window.WorkoutExerciseCatalog
        ? window.WorkoutExerciseCatalog.bodyPartOptions()
        : [];
    select.replaceChildren();
    [{ value: '', label: 'Auto (from exercise name)' }, ...options].forEach(({ value, label }) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        select.appendChild(opt);
    });
    select.value = current || '';
}

// Fill an Equipment <select> from the inventory (med-niix.5, optional
// library-level binding) and select `currentId`. The blank option is the
// default: unbound, which behaves exactly as before. Reads through the
// equipment module's shared cachedFetch list — no second fetch path.
// Shared by the library editor and the plan-exercise modal (med-niix.8):
// one implementation, `selectId` picks which modal's select to fill.
// Returns the inventory array (null when the select is missing, the read
// failed, or `isCurrent` reports this fill superseded) so callers can render
// step/max helper text without a second read; existing callers that ignore
// the return value are unaffected. `isCurrent`, when given, is checked after
// the inventory read and before the selection lands: a superseded fill leaves
// the newer select state (options reset, value, loaded flag) alone instead
// of painting its stale binding over it.
async function _syncEquipmentSelect(currentId, selectId = 'exercise-library-equipment', isCurrent = null) {
    const select = document.getElementById(selectId);
    if (!select) return null;
    // Build options against the select's own document: the inventory read
    // below is async, and a fire-and-forget modal open (or a torn-down test
    // env) must never resolve bare `document` after it is gone.
    const doc = select.ownerDocument;
    if (!doc || typeof doc.createElement !== 'function') return;
    // Reset synchronously FIRST: every opener is fire-and-forget from a click
    // handler, so the previous open's options/selection must not survive
    // until the read lands — saving inside that window would bind equipment
    // the user never chose. dataset.loaded tracks whether the options below
    // are a real inventory read; the save omits equipment_id when it is not,
    // and updateLibraryItem preserves the stored binding on an omitted key —
    // so a failed/offline read can never silently unbind.
    select.replaceChildren();
    const none = doc.createElement('option');
    none.value = '';
    none.textContent = 'None';
    select.appendChild(none);
    select.value = '';
    select.dataset.loaded = 'false';
    let items = null;
    try {
        if (window.WorkoutEquipment && typeof window.WorkoutEquipment.list === 'function') {
            items = await window.WorkoutEquipment.list();
        } else {
            const raw = await apiCall('/api/workout/equipment', 'GET');
            if (Array.isArray(raw)) items = raw;
        }
    } catch (e) {
        items = null; // offline / failure: "None" alone, the save preserves
    }
    if (!Array.isArray(items)) return null;
    // med-8j5w.2: with gyms, group the options per gym (+ Portable) so the
    // owner sees which gym an explicit binding points at. Every item stays
    // selectable — the full inventory, never filtered. No gyms (or a failed
    // gym read) keeps the flat list.
    let locations = [];
    try {
        if (window.WorkoutEquipment && typeof window.WorkoutEquipment.locations === 'function') {
            locations = (await window.WorkoutEquipment.locations()).locations;
        }
    } catch (_) {
        locations = [];
    }
    if (typeof isCurrent === 'function' && !isCurrent()) return null;
    const option = (item) => {
        const opt = doc.createElement('option');
        opt.value = String(item.id);
        opt.textContent = item.name || `Equipment ${item.id}`;
        return opt;
    };
    const valid = items.filter((item) => item && item.id != null);
    if (locations.length === 0) {
        valid.forEach((item) => select.appendChild(option(item)));
    } else {
        const groups = locations.map((loc) => ({ label: loc.name || `Gym ${loc.id}`, id: String(loc.id), items: [] }));
        const portable = { label: 'Portable / everywhere', items: [] };
        valid.forEach((item) => {
            const lid = item.location_id;
            const g = lid == null ? null : groups.find((x) => x.id === String(lid));
            (g || portable).items.push(item);
        });
        groups.concat([portable]).forEach((g) => {
            if (g.items.length === 0) return;
            const og = doc.createElement('optgroup');
            og.label = g.label;
            g.items.forEach((item) => og.appendChild(option(item)));
            select.appendChild(og);
        });
    }
    select.dataset.loaded = 'true';
    select.value = currentId != null && currentId !== '' ? String(currentId) : '';
    return items;
}

// `presetName` pre-fills the name field — that is how a catalog row from the
// "All" source becomes a library row of the user's own.
async function showExerciseLibraryModal(presetName) {
    window.WorkoutEdit.editingLibraryItemId = null;
    document.getElementById('exercise-library-modal-title').textContent = 'Add Exercise';
    _sheetSession++;
    _editingRow = null;
    _editLibrary = _libraryItems;
    document.getElementById('exercise-library-names').hidden = true;
    document.getElementById('exercise-library-merge-btn').hidden = true;
    window.ModalManager.exerciseLibrary.open();

    document.getElementById('exercise-library-name').value = typeof presetName === 'string' ? presetName : '';
    checkExerciseLibraryName();
    _loadIdentityDomain().then(checkExerciseLibraryName);
    document.getElementById('exercise-library-sets').value = '';
    document.getElementById('exercise-library-reps-min').value = '';
    document.getElementById('exercise-library-reps-max').value = '';
    document.getElementById('exercise-library-weight').value = '';
    document.getElementById('exercise-library-notes').value = '';
    _syncBodyPartSelect('');

    // Catalog-only: this modal is where library rows get created, so suggesting
    // the library back at the user would just offer duplicates.
    // (Runs before the await below so fire-and-forget openers still see the
    // picker reset synchronously, exactly as before.)
    bindExercisePicker({
        input: document.getElementById('exercise-library-name'),
        mount: document.getElementById('exercise-library-suggest'),
        withLibrary: false,
        // A pick sets the value without an input event: re-check the name.
        onPick: () => checkExerciseLibraryName()
    });

    // Awaited last: awaiting callers see the filled select, while
    // fire-and-forget openers already got the synchronous reset above.
    await _syncEquipmentSelect('');
}

async function showEditExerciseLibraryModal(id) {
    const items = await apiCall('/api/workout/exercise-library');
    const item = items && items.find(i => i.id === id);
    if (!item) return;

    window.WorkoutEdit.editingLibraryItemId = id;
    document.getElementById('exercise-library-modal-title').textContent = 'Edit Exercise';
    const session = ++_sheetSession;
    const isCurrent = () => session === _sheetSession;
    _editingRow = item;
    _editLibrary = items;
    document.getElementById('exercise-library-names').hidden = false;
    document.getElementById('exercise-library-merge-btn').hidden = false;
    window.ModalManager.exerciseLibrary.open();

    document.getElementById('exercise-library-name').value = item.name;
    document.getElementById('exercise-library-sets').value = item.default_sets || '';
    document.getElementById('exercise-library-reps-min').value = item.default_reps_min || '';
    document.getElementById('exercise-library-reps-max').value = item.default_reps_max || '';
    document.getElementById('exercise-library-weight').value = item.default_weight_kg || '';
    document.getElementById('exercise-library-notes').value = item.notes || '';
    _syncBodyPartSelect(item.body_part || '');
    // Reset the previous sheet's binding before any identity read can yield.
    const equipment = _syncEquipmentSelect(item.equipment_id, 'exercise-library-equipment', isCurrent);
    _paintExerciseAliases();
    checkExerciseLibraryName();

    // The picker starts closed, so the stored name is not immediately buried
    // under suggestions for itself; it opens again as soon as the user types.
    bindExercisePicker({
        input: document.getElementById('exercise-library-name'),
        mount: document.getElementById('exercise-library-suggest'),
        withLibrary: false,
        onPick: () => checkExerciseLibraryName()
    });

    await Promise.all([equipment, _loadIdentityDomain(), _loadExerciseNames()]);
    // Alias writes replace _editingRow within this same sheet.
    if (!isCurrent()) return;
    _paintExerciseAliases();
    checkExerciseLibraryName();
}

function closeExerciseLibraryModal() {
    closeExerciseLibraryPicker();
    window.ModalManager.exerciseLibrary.close();
    window.WorkoutEdit.editingLibraryItemId = null;
    _editingRow = null;
    _sheetSession++;
}

// Save reads the form NOW, then queues the write behind any pending +/×: the
// queued write stays bound to this row and payload even if the sheet is
// closed or reopened meanwhile, and only touches the sheet it came from.
function saveExerciseLibraryItem() {
    const write = _collectExerciseLibrarySave();
    if (!write) return Promise.resolve();
    return _serialIdentityWrite(() => _writeExerciseLibraryItem(write));
}

function _collectExerciseLibrarySave() {
    const name = document.getElementById('exercise-library-name').value.trim();
    const sets = parseInt(document.getElementById('exercise-library-sets').value) || 0;
    const repsMin = parseInt(document.getElementById('exercise-library-reps-min').value) || 0;
    const repsMaxRaw = document.getElementById('exercise-library-reps-max').value;
    const repsMax = repsMaxRaw !== '' ? parseInt(repsMaxRaw) : null;
    const weightRaw = document.getElementById('exercise-library-weight').value;
    const weight = weightRaw.trim() !== '' ? parseDecimal(weightRaw) : null;
    const notes = document.getElementById('exercise-library-notes').value.trim();
    const bodyPartEl = document.getElementById('exercise-library-body-part');
    const bodyPart = bodyPartEl ? bodyPartEl.value : '';
    const equipmentEl = document.getElementById('exercise-library-equipment');
    // The key rides the same payload only when the select holds a real
    // inventory read. Otherwise it is omitted and updateLibraryItem preserves
    // the stored binding (see _syncEquipmentSelect).
    const equipmentLoaded = !!equipmentEl && equipmentEl.dataset.loaded === 'true';
    const equipmentRaw = equipmentLoaded ? equipmentEl.value : null;

    if (!name) {
        safeAlert('Exercise name is required!');
        return null;
    }
    // A taken name is shown on the field (kit EI3) and Save stays off.
    if (checkExerciseLibraryName()) return null;

    const payload = {
        name: name,
        default_sets: sets,
        default_reps_min: repsMin,
        default_reps_max: repsMax,
        default_weight_kg: weight,
        notes: notes,
        body_part: bodyPart
    };
    if (equipmentRaw !== null) payload.equipment_id = equipmentRaw !== '' ? Number(equipmentRaw) : null;
    return { payload, name, bodyPart, editingId: window.WorkoutEdit.editingLibraryItemId, session: _sheetSession };
}

async function _writeExerciseLibraryItem({ payload, name, bodyPart, editingId, session }) {
    const isCreate = !editingId;
    const sameSheet = () => session === _sheetSession;
    const handle = await _optimisticLibrary((list) => (isCreate
        ? [...list, { ...payload, id: `local_${Date.now()}` }]
        : list.map((r) => (r && r.id === editingId ? { ...r, ...payload } : r))));
    let result = null;
    try {
        result = isCreate
            ? await apiCall('/api/workout/exercise-library/create', 'POST', payload, { suppressWriteAlert: true })
            : await apiCall(`/api/workout/exercise-library/update?id=${editingId}`, 'PUT', payload, { suppressWriteAlert: true });
    } catch (e) {
        if (handle) await handle.rollback().catch(() => {});
        safeAlert('Error: ' + (e && e.message ? e.message : e));
        return;
    }

    if (result || result === true) {
        if (handle) await handle.commit(null).catch(() => {});
        if (sameSheet()) closeExerciseLibraryModal();
        loadExerciseLibrary();
        if (isCreate && !bodyPart) _autoTagIfUnresolved(name);
        return;
    }
    if (handle) await handle.rollback().catch(() => {});
    // A duplicate 409 (another device took the name since this sheet opened):
    // re-read the library and show the taken-name state with its merge offer
    // instead of a dead end — on the sheet it came from only.
    if (!sameSheet()) {
        safeAlert(`Couldn't save ${name} — try again.`);
        return;
    }
    const fresh = await apiCall('/api/workout/exercise-library');
    if (Array.isArray(fresh)) _editLibrary = fresh;
    if (!checkExerciseLibraryName()) safeAlert("Couldn't save the exercise — try again.");
}

// A freshly created row with "Auto" muscle group that the static catalog
// cannot classify gets one LLM pass (names only). Best-effort: a failure just
// leaves the row untagged, exactly where a manual tag would fix it.
async function _autoTagIfUnresolved(name) {
    if (!window.WorkoutExerciseCatalog) return;
    if (await window.WorkoutExerciseCatalog.getBodyPart(name)) return;
    try {
        const res = await apiCall('/api/workout/exercise-library/auto-tag', 'POST', { names: [name] });
        console.info('exercise auto-tag (on create): result', res);
        if (res && Array.isArray(res.tagged) && res.tagged.length) loadExerciseLibrary();
    } catch (e) {
        console.warn('exercise auto-tag (on create) failed:', e);
    }
}

async function deleteExerciseLibraryItem(id, event) {
    event?.stopPropagation?.();
    await safeConfirm('Delete this exercise from library?', async (ok) => {
        if (ok) {
            await _deleteExerciseLibraryApi(id);
        }
    });
}

async function _deleteExerciseLibraryApi(id) {
    const result = await apiCall(`/api/workout/exercise-library/delete?id=${id}`, 'DELETE');
    if (result || result === true) {
        loadExerciseLibrary();
    }
}

// ---- Exercise identity: other names, rename, merge (med-l5yr.4, kit EI1–EI6) ----
// The Edit sheet lists the names whose logs count as this row ("Also logged
// as", each removable), checks the typed name against the rest of the library
// (a taken name offers the merge), and opens one picker sheet over itself for
// the merge target (EI4) or a history-only name to add (EI6). The domain does
// the work: findLibraryRowByName / exerciseKey, the merge route, aliases on
// update.
let _editingRow = null; // module-state: the library row the Edit sheet opened on (null in Add)
let _editLibrary = []; // module-state: library rows the open sheet checks names against
let _exerciseNames = []; // module-state: last GET /api/workout/exercises/names (log counts, history-only names)
let _identityDomain = null; // module-state: web/domain/workout.js once loaded (findLibraryRowByName, exerciseKey)
let _pickerMode = null; // module-state: what the picker sheet shows — 'merge' (EI4) | 'names' (EI6)
let _sheetSession = 0; // module-state: bumps on every open/close of the library sheet; queued writes check it

async function _loadIdentityDomain() {
    if (!_identityDomain) {
        try { _identityDomain = await window.WorkoutLibrary.loadDomain(); } catch (_) { _identityDomain = null; }
    }
    return _identityDomain;
}

async function _loadExerciseNames() {
    let names = null;
    try { names = await apiCall('/api/workout/exercises/names'); } catch (_) { names = null; }
    _exerciseNames = Array.isArray(names) ? names : [];
    return _exerciseNames;
}

function _nameKey(name) {
    if (_identityDomain && typeof _identityDomain.exerciseKey === 'function') return _identityDomain.exerciseKey(name);
    return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function _logsMeta(count, date) {
    const n = Number(count) || 0;
    if (!n) return 'No logs yet';
    // scheduled_date carries its recorded calendar day, not the viewer's day.
    const day = date && !Number.isNaN(new Date(date).getTime()) ? String(date).split('T')[0] : '';
    const when = day ? new Date(`${day}T00:00:00Z`) : null;
    const last = when && !Number.isNaN(when.getTime())
        ? ` · last ${when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}` : '';
    return `${n} log${n === 1 ? '' : 's'}${last}`;
}

function _namesEntryFor(row) {
    return row ? _exerciseNames.find((e) => e && e.library_id === row.id) || null : null;
}

// One kit list row: title + meta, and an optional trailing node.
function _identityRow(doc, tag, title, meta, trail) {
    const row = doc.createElement(tag);
    row.className = 'wg-row';
    if (tag === 'button') row.type = 'button';
    const body = doc.createElement('span');
    body.className = 'wg-row__body';
    const t = doc.createElement('span');
    t.className = 'wg-row__title';
    t.textContent = title;
    const m = doc.createElement('span');
    m.className = 'wg-row__meta';
    m.textContent = meta;
    body.append(t, m);
    row.appendChild(body);
    if (trail) row.appendChild(trail);
    return row;
}

function _identityIconBtn(doc, icon, label, onClick) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'wg-btn wg-btn--ghost wg-btn--icon wg-btn--sm';
    btn.setAttribute('aria-label', label);
    btn.appendChild(_wgExerciseIco(icon));
    btn.addEventListener('click', onClick);
    return btn;
}

// EI1: "Also logged as" — each alias with its own log count and last date.
function _paintExerciseAliases() {
    const list = document.getElementById('exercise-library-aliases');
    const empty = document.getElementById('exercise-library-aliases-empty');
    if (!list || !empty) return;
    const doc = list.ownerDocument;
    const aliases = (_editingRow && Array.isArray(_editingRow.aliases)) ? _editingRow.aliases : [];
    const entry = _namesEntryFor(_editingRow);
    const spellings = (entry && Array.isArray(entry.spellings)) ? entry.spellings : [];
    list.replaceChildren(...aliases.map((alias) => {
        const sp = spellings.find((s) => s && s.key === _nameKey(alias));
        return _identityRow(doc, 'div', alias, sp ? _logsMeta(sp.log_count, sp.last_date) : 'No logs yet',
            _identityIconBtn(doc, 'x', `Remove ${alias}`, () => removeExerciseAlias(alias)));
    }));
    list.hidden = aliases.length === 0;
    empty.hidden = aliases.length > 0;
}

// EI2/EI3: the hint under Name, or the taken-name error with its merge offer.
// Returns the row the typed name already belongs to (null when free), and
// keeps Save off while it is taken.
function checkExerciseLibraryName() {
    const input = document.getElementById('exercise-library-name');
    if (!input) return null;
    const name = input.value.trim();
    const editing = _editingRow;
    const others = (_editLibrary || []).filter((r) => r && !r.deleted && (!editing || r.id !== editing.id));
    let taken = null;
    if (name && _identityDomain) {
        // A name that keeps this row's own key (a case-only rename) is held
        // only to the exact-name rule, as in the domain's duplicate guard.
        taken = editing && _nameKey(name) === _nameKey(editing.name)
            ? others.find((r) => r.name === name) || null
            : _identityDomain.findLibraryRowByName(others, name);
    }

    const field = document.getElementById('exercise-library-name-field');
    const hint = document.getElementById('exercise-library-rename-hint');
    const error = document.getElementById('exercise-library-name-error');
    const merge = document.getElementById('exercise-library-name-merge');
    const save = document.getElementById('exercise-library-save-btn');
    if (field) field.classList.toggle('wg-workouts-library-modal__field--error', !!taken);
    if (save) save.disabled = !!taken;
    if (error) {
        error.hidden = !taken;
        error.textContent = !taken ? ''
            : _nameKey(taken.name) === _nameKey(name)
                ? `You already have ${taken.name}.`
                : `"${name}" is already an alias of ${taken.name}.`;
    }
    if (merge) {
        merge.hidden = !(taken && editing);
        merge.lastElementChild.textContent = taken ? `Merge into ${taken.name}` : '';
        merge.onclick = taken && editing ? () => confirmExerciseMerge(taken) : null;
    }
    if (hint) {
        hint.hidden = !editing || !!taken;
        hint.textContent = !editing ? ''
            : _nameKey(name) !== _nameKey(editing.name)
                ? `History stays. "${editing.name}" will be kept under "Also logged as".`
                : 'Renaming keeps the history. The old name moves to "Also logged as".';
    }
    return taken;
}

// The library cache projection every write here goes through (rule 9).
async function _optimisticLibrary(mutator, tags = ['exercise_library']) {
    if (!window.DataStore || typeof window.DataStore.applyOptimistic !== 'function') return null;
    try {
        return await window.DataStore.applyOptimistic('exercise_library',
            (prev) => (Array.isArray(prev) ? mutator(prev.slice()) : prev), tags);
    } catch (_) {
        return null; // a failed cache projection must not block the write
    }
}

// POST the merge route; history, stats and records regroup, so 'workout'
// rides with the library tag. Names that stayed with a third row
// (skipped_aliases) are told, not dropped silently.
async function _postExerciseMerge(body, mutator) {
    const handle = await _optimisticLibrary(mutator, ['exercise_library', 'workout']);
    let res = null;
    let err = null;
    try {
        res = await apiCall('/api/workout/exercise-library/merge', 'POST', body, { suppressWriteAlert: true });
    } catch (e) {
        err = e;
    }
    if (!res) {
        if (handle) await handle.rollback().catch(() => {});
        safeAlert(err && err.message ? `Couldn't merge: ${err.message}` : "Couldn't merge — try again.");
        return null;
    }
    if (handle) await handle.commit(null).catch(() => {});
    if (Array.isArray(res.skipped_aliases) && res.skipped_aliases.length) {
        const list = res.skipped_aliases.map((s) => `"${s.name}" stays with ${s.owner}`).join('; ');
        await safeAlert(`${list}: that exercise already answers to it.`, { title: 'Some names stayed put' });
    }
    return res;
}

// EI5: merge the row being edited into `target`, after a confirm that says
// what moves and what goes. Removing an alias only separates history again.
async function confirmExerciseMerge(target) {
    const src = _editingRow;
    if (!src || !target) return;
    const entry = _namesEntryFor(src);
    const n = entry ? Number(entry.log_count) || 0 : 0;
    const logs = n ? `Its ${n} log${n === 1 ? '' : 's'} count` : 'Its logs count';
    const msg = `${logs} as ${target.name} in history, stats and records. ${src.name} leaves your library, `
        + `and plans that use it switch to ${target.name}. Remove the name under "Also logged as" to separate its history again.`;
    const ok = await safeConfirm(msg, null, {
        title: `Merge ${src.name} into ${target.name}?`, confirmLabel: 'Merge', icon: 'link', tone: 'warn',
        focusCancel: true,
    });
    if (!ok) return;
    const session = _sheetSession;
    const res = await _serialIdentityWrite(() => {
        const cur = _editingRow && _editingRow.id === src.id ? _editingRow : src;
        const moved = [cur.name, ...(Array.isArray(cur.aliases) ? cur.aliases : [])];
        return _postExerciseMerge({ id: src.id, into_id: target.id }, (list) => list
            .filter((r) => !(r && r.id === src.id))
            .map((r) => (r && r.id === target.id ? { ...r, aliases: [...(r.aliases || []), ...moved] } : r)));
    });
    if (!res) return;
    if (session === _sheetSession) closeExerciseLibraryModal();
    loadExerciseLibrary();
}

// The sheet's identity writes (+, ×, Save) each read-modify-write the row's
// aliases, so they run one at a time: two quick taps must not lose an alias.
let _identityWriteChain = Promise.resolve(); // module-state: serializes the Edit sheet's alias/merge/save writes
function _serialIdentityWrite(fn) {
    const run = _identityWriteChain.then(fn, fn);
    _identityWriteChain = run.catch(() => {});
    return run;
}

// A queued + / × is bound to the sheet it was tapped on: if that sheet was
// closed (or another opened) before its turn, it is dropped. Within one
// sheet, each write reads the row as the previous write's result left it.
function _queueSheetAliasWrite(fn) {
    const session = _sheetSession;
    const rowId = _editingRow ? _editingRow.id : null;
    return _serialIdentityWrite(() => {
        if (session !== _sheetSession || !_editingRow || _editingRow.id !== rowId) return undefined;
        return fn(_editingRow, session);
    });
}

// EI6 "+": a name only history carries becomes this row's alias at once.
function addExerciseNameFromHistory(name) {
    return _queueSheetAliasWrite((row, session) => _addExerciseNameFromHistory(row, session, name));
}

async function _addExerciseNameFromHistory(row, session, name) {
    if (!name) return;
    const res = await _postExerciseMerge({ name, into_id: row.id }, (list) => list
        .map((r) => (r && r.id === row.id ? { ...r, aliases: [...(r.aliases || []), name] } : r)));
    if (!res || session !== _sheetSession) return;
    _editingRow = { ..._editingRow, aliases: Array.isArray(res.aliases) ? res.aliases : [] };
    await _loadExerciseNames();
    _paintExerciseAliases();
    _paintExerciseLibraryPicker();
    loadExerciseLibrary();
}

// EI1 "×": send only the removal intent. The domain reads the current row,
// preserving edits/aliases that arrived since this sheet opened; unsaved
// form inputs stay untouched.
function removeExerciseAlias(alias) {
    return _queueSheetAliasWrite((row, session) => _removeExerciseAlias(row, session, alias));
}

async function _removeExerciseAlias(row, session, alias) {
    const key = _nameKey(alias);
    const withoutAlias = (current) => ({
        ...current, aliases: (current.aliases || []).filter((name) => _nameKey(name) !== key),
    });
    _editingRow = withoutAlias(row);
    _paintExerciseAliases();
    const handle = await _optimisticLibrary((list) => list
        .map((r) => (r && r.id === row.id ? withoutAlias(r) : r)), ['exercise_library', 'workout']);
    let current = null;
    try {
        current = await apiCall(`/api/workout/exercise-library/remove-alias?id=${row.id}`, 'POST', { alias }, { suppressWriteAlert: true });
    } catch (_) {
        current = null;
    }
    if (!current) {
        if (handle) await handle.rollback().catch(() => {});
        if (session === _sheetSession) {
            _editingRow = row;
            _paintExerciseAliases();
        }
        safeAlert("Couldn't remove the name — try again.");
        return;
    }
    if (handle) await handle.commit(null).catch(() => {});
    loadExerciseLibrary();
    if (session !== _sheetSession) return;
    _editingRow = current;
    _editLibrary = _editLibrary.map((r) => (r && r.id === current.id ? current : r));
    _paintExerciseAliases();
    await _loadExerciseNames();
    if (session !== _sheetSession) return;
    _paintExerciseAliases();
    _paintExerciseLibraryPicker();
}

function openExerciseLibraryPicker(mode) {
    const src = _editingRow;
    if (!src) return;
    _pickerMode = mode === 'names' ? 'names' : 'merge';
    const merge = _pickerMode === 'merge';
    document.getElementById('exercise-library-picker-eyebrow').textContent = merge ? `Merge ${src.name} into` : src.name;
    document.getElementById('exercise-library-picker-title').textContent = merge ? 'Pick the exercise' : 'Add a name from history';
    const search = document.getElementById('exercise-library-picker-search');
    search.value = '';
    search.placeholder = merge ? 'Search your exercises' : 'Search names';
    const hint = document.getElementById('exercise-library-picker-hint');
    hint.hidden = merge;
    hint.textContent = merge ? '' : "Names in your logs that aren't in your library.";
    window.ModalManager.open('exercise-library-picker', { overlay: false });
    _paintExerciseLibraryPicker();
}

function closeExerciseLibraryPicker() {
    _pickerMode = null;
    const picker = document.getElementById('exercise-library-picker');
    if (picker && !picker.classList.contains('hidden')) window.ModalManager.close('exercise-library-picker');
}

function _pickerSection(doc, label, rows) {
    const section = doc.createElement('section');
    section.className = 'wg-section';
    const head = doc.createElement('div');
    head.className = 'wg-section__head';
    const eyebrow = doc.createElement('span');
    eyebrow.className = 'wg-eyebrow';
    eyebrow.textContent = label;
    head.appendChild(eyebrow);
    const list = doc.createElement('div');
    list.className = 'wg-list';
    list.append(...rows);
    section.append(head, list);
    return section;
}

// EI4: "Closest names" (up to 3 rows sharing a word with this one), then every
// other row A–Z with body part and log count; a query narrows to matches.
// EI6: names only history carries, most logs first.
function _paintExerciseLibraryPicker() {
    const mount = document.getElementById('exercise-library-picker-list');
    const search = document.getElementById('exercise-library-picker-search');
    const src = _editingRow;
    if (!mount || !search || !src || !_pickerMode) return;
    const doc = mount.ownerDocument;
    const q = search.value.trim().toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);
    const empty = (text) => {
        const p = doc.createElement('p');
        p.className = 'wg-hint';
        p.textContent = text;
        return p;
    };

    if (_pickerMode === 'names') {
        const names = _exerciseNames
            .filter((e) => e && e.name && e.library_id == null && (!q || _exerciseMatchTier(e.name, tokens, q) > 0))
            .sort((a, b) => (b.log_count - a.log_count) || a.name.localeCompare(b.name));
        if (!names.length) {
            mount.replaceChildren(empty(q ? 'No names match that search.' : 'Every name in your logs is in your library.'));
            return;
        }
        const list = doc.createElement('div');
        list.className = 'wg-list';
        list.append(...names.map((e) => _identityRow(doc, 'div', e.name, _logsMeta(e.log_count, e.last_date),
            _identityIconBtn(doc, 'plus', `Add ${e.name}`, () => addExerciseNameFromHistory(e.name)))));
        mount.replaceChildren(list);
        return;
    }

    const rows = (_editLibrary || []).filter((r) => r && r.id != null && !r.deleted && r.id !== src.id);
    const logsOf = (r) => Number((_namesEntryFor(r) || {}).log_count) || 0;
    const target = (r) => {
        const n = logsOf(r);
        const meta = [_libraryBodyPartLabel((r.body_part || '').trim()), `${n} log${n === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
        const chev = _wgExerciseIco('chev-r');
        chev.classList.add('wg-row__chev');
        const btn = _identityRow(doc, 'button', r.name, meta, chev);
        btn.addEventListener('click', () => confirmExerciseMerge(r));
        return btn;
    };
    const byName = (a, b) => a.name.localeCompare(b.name);
    if (q) {
        const hits = _filterExercises(rows, q).sort(byName);
        mount.replaceChildren(hits.length ? _pickerSection(doc, 'Matches', hits.map(target)) : empty('No exercises match that search.'));
        return;
    }
    const words = new Set(_nameKey(src.name).split(/[\s/-]+/).filter(Boolean));
    const closest = rows
        .map((r) => ({ r, shared: _nameKey(r.name).split(/[\s/-]+/).filter((w) => words.has(w)).length }))
        .filter((x) => x.shared > 0)
        .sort((a, b) => (b.shared - a.shared) || byName(a.r, b.r))
        .slice(0, 3)
        .map((x) => x.r);
    const sections = [];
    if (closest.length) sections.push(_pickerSection(doc, 'Closest names', closest.map(target)));
    sections.push(_pickerSection(doc, 'All your exercises', rows.slice().sort(byName).map(target)));
    mount.replaceChildren(...sections);
}

// Canonical exercise-name suggestions from the vendored static catalog
// (med-s5m.2). Suggest-only: the name inputs surface canonical names ("Barbell
// bench press") and cut near-duplicates, without ever constraining free typing.
// The 913 KB asset is fetched once, lazily (only when the user actually types
// into a name field — see the picker below); a failed fetch is silent — the
// inputs just fall back to no catalog suggestions — and is retried on the next
// keystroke.
let _exerciseCatalogPromise = null; // module-state: single-flight cache for the one-time static exercise-catalog fetch (med-s5m.2)
function _loadExerciseCatalog() {
    if (!_exerciseCatalogPromise) {
        _exerciseCatalogPromise = fetch('/static/data/exercises-catalog.json')
            .then(r => (r.ok ? r.json() : Promise.reject(new Error('catalog ' + r.status))))
            .then(cat => (cat.exercises || []).filter(e => e && e.name))
            .catch(err => {
                console.error('Error loading exercise catalog:', err);
                _exerciseCatalogPromise = null; // allow a later retry (e.g. offline -> online)
                return [];
            });
    }
    return _exerciseCatalogPromise;
}

function _loadExerciseCatalogNames() {
    return _loadExerciseCatalog().then(list => list.map(e => e.name));
}

// Exercise-name suggestions (med-s5m.2 -> med-3q8.1 -> med-max): ONE shared
// component behind every name input — session add-exercise, plan add-exercise
// and the exercise-library modal.
//
// It renders its own list into a container that sits IN THE DOCUMENT FLOW
// under the input, replacing the native <datalist> the first two iterations
// used. A datalist popup can be neither height-capped nor styled, so on a
// phone it covered half the screen and buried the keyboard whatever we did to
// the option count; an in-flow list pushes the rest of the form down instead of
// covering it, and cannot be clipped by .wg-modal's own `overflow-y: auto`.
//
// Query rules (carried over from the datalist versions): nothing at all until
// the first typed character; the user's own library first — those rows carry
// the defaults that pre-fill sets/reps/weight — then canonical catalog names,
// still gated at 2 characters so the 913 KB asset is not fetched on the very
// first keystroke; EXERCISE_SUGGESTION_LIMIT rows total. No debounce: the match
// runs over in-memory arrays.
const EXERCISE_CATALOG_MIN_QUERY = 2;
const EXERCISE_SUGGESTION_LIMIT = 6;

// How well one candidate name answers the query. Lower tier = better; 0 = no
// match at all.
//   1 — every whitespace-separated query token is the PREFIX of some word in
//       the name, in any order: "lat ro" and "ro lat" both find "lateral rows",
//       which a plain substring test cannot ("lateral rows" does not contain
//       "lat ro"). Names split on whitespace and on `-` and `/` too, because
//       the catalog holds things like "3/4 sit-up" and "45° side bend".
//   2 — the whole query is a substring of the name, so mid-word typing keeps
//       working: "ench" still finds "barbell bench press".
// The catalog is entirely lowercase and the user's library is hand-cased
// ("Barbell rows"), so both sides are lowercased for every comparison.
function _exerciseMatchTier(name, tokens, q) {
    const lower = (name || '').toLowerCase();
    if (!lower) return 0;
    const words = lower.split(/[\s/-]+/).filter(Boolean);
    if (tokens.every(t => words.some(w => w.startsWith(t)))) return 1;
    return lower.includes(q) ? 2 : 0;
}

// Match, order, dedupe and cap the candidates for one query. `candidates`
// arrives in library-then-catalog order and `sort` is stable, so sorting by
// tier alone keeps library entries ahead of catalog ones inside each tier — and
// makes a name present in both halves dedupe to the library row, the one
// carrying the autofill defaults and the user's own casing. An exact match is
// hoisted ahead of the cap so finishing a name by hand never scrolls its own
// row out of view.
function _rankExerciseMatches(candidates, q) {
    const tokens = q.split(/\s+/).filter(Boolean);
    const ordered = candidates
        .map(item => ({ item, tier: _exerciseMatchTier(item.name, tokens, q) }))
        .filter(m => m.tier > 0)
        .sort((a, b) => a.tier - b.tier)
        .map(m => m.item);

    const exact = ordered.findIndex(m => (m.name || '').toLowerCase() === q);
    if (exact > 0) ordered.unshift(ordered.splice(exact, 1)[0]);

    const ranked = [];
    const seen = new Set();
    for (const item of ordered) {
        const key = (item.name || '').toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        ranked.push(item);
        if (ranked.length >= EXERCISE_SUGGESTION_LIMIT) break;
    }
    return ranked;
}

// Wire a name input to its suggestion container.
//   input       — the <input type="text"> the user types into
//   mount       — the in-flow container the list renders into
//   withLibrary — include the user's exercise library (false = catalog only,
//                 which is what the exercise-library modal wants: that is the
//                 screen where library rows get created)
//   onPick      — called with the picked item. Library items carry
//                 { id, name, default_sets, default_reps_min, default_reps_max,
//                 default_weight_kg }; catalog-only items carry just { name }
//                 and therefore no id, so the caller must fall back to
//                 resolveOrCreateLibraryId on save.
// Handlers are assigned as properties, never addEventListener, so reopening a
// modal cannot stack them.
let _catalogRefreshSeq = 0; // module-state: last-writer-wins guard for the awaited first catalog fetch
async function bindExercisePicker({ input, mount, withLibrary = true, onPick } = {}) {
    if (!input || !mount) return;
    // Invalidate any refresh still in flight from a previous modal open, so its
    // continuation cannot paint stale rows into the container we just rebound.
    _catalogRefreshSeq++;

    let library = [];
    if (withLibrary) {
        try {
            // apiCall returns null offline / on 5xx; anything not a list means
            // no library half rather than a crash on the first keystroke.
            const items = await apiCall('/api/workout/exercise-library');
            if (Array.isArray(items)) library = items;
        } catch (error) {
            console.error('Error loading exercise library for picker:', error);
        }
    }

    let rendered = [];
    const hide = () => {
        rendered = [];
        mount.replaceChildren();
        mount.hidden = true;
    };

    const paint = (candidates, q) => {
        rendered = _rankExerciseMatches(candidates, q);
        if (rendered.length === 0) {
            hide();
            return 0;
        }
        const list = document.createElement('ul');
        list.className = 'list-reset wg-exercise-suggest__list';
        rendered.forEach((item, index) => {
            const row = document.createElement('li');
            // A real <button> so keyboard focus and screen-reader semantics
            // come for free.
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'wg-exercise-suggest__row';
            btn.dataset.index = String(index);
            btn.textContent = item.name;
            row.appendChild(btn);
            list.appendChild(row);
        });
        mount.replaceChildren(list);
        mount.hidden = false;
        return rendered.length;
    };

    const refresh = async () => {
        const seq = ++_catalogRefreshSeq;
        const q = (input.value || '').trim().toLowerCase();
        // Paint the library half NOW: it is a local vault read, while the first
        // catalog refresh awaits a 913 KB asset. Leaving the previous query's
        // rows up until that lands would keep offering names already typed past.
        const libraryHits = paint(q ? library : [], q);
        if (q.length >= EXERCISE_CATALOG_MIN_QUERY && libraryHits < EXERCISE_SUGGESTION_LIMIT) {
            const names = await _loadExerciseCatalogNames();
            // Only the first refresh actually awaits a network fetch; while it
            // is in flight the user can type on or delete back below the
            // threshold, and that later refresh already repainted the list.
            // Drop this stale continuation instead of appending its matches.
            if (seq !== _catalogRefreshSeq) return;
            paint(library.concat(names.map(name => ({ name }))), q);
        }
    };

    input.oninput = refresh;
    // An open list eats the Esc; a second Esc reaches ModalManager and closes the modal.
    input.onkeydown = (e) => { if (e.key === 'Escape' && !mount.hidden) { e.preventDefault(); hide(); } };
    input.onblur = (e) => {
        // Tabbing from the input into the list must not tear it down before a
        // row can take focus — that would make the rows unreachable by
        // keyboard, which is the whole reason they are real buttons.
        if (e && e.relatedTarget && mount.contains(e.relatedTarget)) return;
        hide();
    };
    // Keep focus on the input while a row is being pressed. Without this the
    // input blurs first, `hide()` tears the row out of the DOM, and the click
    // lands on nothing — the classic hand-rolled-autocomplete failure on
    // mobile. Enter on a focused row fires `click` with no mousedown, so the
    // commit itself stays on `click` and one path serves tap and keyboard.
    mount.onmousedown = (e) => {
        if (e.target.closest('.wg-exercise-suggest__row')) e.preventDefault();
    };
    mount.onclick = (e) => {
        const row = e.target.closest('.wg-exercise-suggest__row');
        if (!row) return;
        const item = rendered[Number(row.dataset.index)];
        hide();
        // hide() just removed the row the keyboard was on; put focus back where
        // the user can keep typing.
        input.focus();
        if (!item) return;
        input.value = item.name;
        if (onPick) onPick(item);
    };

    // Start closed: an empty field means no list at all (med-max).
    hide();
}

// The add-exercise row list (kit WA3b, med-okwf.3; med-okwf.4's Next step
// reuses it): the same query rules as bindExercisePicker, but every row is a
// kit .wg-row that ADDS on tap — no Save. Own library rows first, then catalog
// names, then an 'Add "<typed>"' row unless the typed name is already listed.
// Meta: "last …" from lastLine(name) when that exercise was logged before,
// else "Library · <body part>" (or "Library"); the add row says "New exercise".
//   input    — the search field; mount — the container the section renders into
//   exclude  — names already in the session (case-insensitive): never offered,
//              so a tap cannot hit the (session, exercise, source) dedup
//   excludeIds — library ids the session already logged (a renamed library
//              row keeps its old name on the log), never offered either
//   lastLine — async name → "last 3 × 15 · 20 kg" | null
//   onAdd    — called with the tapped item: a library row (id + defaults),
//              { name, body_part } for a catalog name, or { name } typed
//   upNext   — optional promise of ranked rows (med-okwf.4, kit WA3/WA5) shown
//              as "Up next" while the field is empty; none → nothing at rest
// The input is live before the reads land (the Next step shows it at once):
// typing early paints with what is loaded so far, and the load repaints for
// whatever the field holds by then.
async function bindExerciseAddList({ input, mount, exclude = [], excludeIds = [], lastLine, onAdd, upNext: upNextP } = {}) {
    if (!input || !mount) return;
    _catalogRefreshSeq++;
    const skip = new Set(exclude.map(n => String(n || '').trim().toLowerCase()));
    const skipIds = new Set(excludeIds.filter(id => id > 0));
    const keep = item => !skip.has((item.name || '').trim().toLowerCase()) && !(item.id > 0 && skipIds.has(item.id));

    let library = [];
    let upNext = [];
    let loaded = false;

    let rendered = [];
    const row = (item, title, meta, icon) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wg-row';
        btn.dataset.index = String(rendered.length);
        const lead = document.createElement('span');
        lead.className = 'wg-row__lead';
        lead.appendChild(_wgExerciseIco(icon));
        const body = document.createElement('span');
        body.className = 'wg-row__body';
        const t = document.createElement('span');
        t.className = 'wg-row__title';
        t.textContent = title;
        const m = document.createElement('span');
        m.className = 'wg-row__meta';
        m.textContent = meta;
        body.append(t, m);
        const trail = document.createElement('span');
        trail.className = 'wg-row__trail';
        trail.appendChild(_wgExerciseIco('plus'));
        btn.append(lead, body, trail);
        rendered.push(item);
        return { btn, m };
    };

    const paint = (candidates, q, typed) => {
        rendered = [];
        const matches = q ? _rankExerciseMatches(candidates.filter(keep), q) : upNext;
        const list = document.createElement('div');
        list.className = 'wg-list';
        matches.forEach((item) => {
            const bp = _libraryBodyPartLabel((item.body_part || '').trim());
            const { btn, m } = row(item, item.name, bp ? `Library · ${bp}` : 'Library', 'dumbbell');
            list.appendChild(btn);
            if (lastLine) {
                Promise.resolve(lastLine(item.name)).then((line) => {
                    if (line && m.isConnected) m.textContent = line;
                }, () => {});
            }
        });
        // No add row before the library read: only it knows which typed names
        // are already in the session under a library row (excludeIds).
        if (q && loaded && !matches.some(i => (i.name || '').trim().toLowerCase() === q) && keep({ name: typed })) {
            list.appendChild(row({ name: typed }, `Add “${typed}”`, 'New exercise', 'plus').btn);
        }
        if (!rendered.length) {
            mount.replaceChildren();
            mount.hidden = true;
            return 0;
        }
        const head = document.createElement('div');
        head.className = 'wg-section__head';
        const eyebrow = document.createElement('span');
        eyebrow.className = 'wg-eyebrow';
        eyebrow.textContent = q ? 'Matches' : 'Up next';
        head.appendChild(eyebrow);
        mount.replaceChildren(head, list);
        mount.hidden = false;
        return matches.length;
    };

    const refresh = async () => {
        const seq = ++_catalogRefreshSeq;
        const typed = (input.value || '').trim();
        const q = typed.toLowerCase();
        const libraryHits = paint(library, q, typed);
        // Catalog rows wait for the library read too (same reason as the add row).
        if (loaded && q.length >= EXERCISE_CATALOG_MIN_QUERY && libraryHits < EXERCISE_SUGGESTION_LIMIT) {
            const catalog = await _loadExerciseCatalog();
            if (seq !== _catalogRefreshSeq) return;
            paint(library.concat(catalog.map(e => ({ name: e.name, body_part: e.body_part }))), q, typed);
        }
    };

    input.oninput = refresh;
    mount.onclick = (e) => {
        const btn = e.target.closest('.wg-row');
        const item = btn ? rendered[Number(btn.dataset.index)] : null;
        if (item && onAdd) onAdd(item);
    };
    paint([], '', '');

    try {
        const [items, ranked] = await Promise.all([
            apiCall('/api/workout/exercise-library'),
            Promise.resolve(upNextP).catch(() => null)
        ]);
        if (Array.isArray(items)) {
            // An excluded library row's CURRENT name is taken too, so neither a
            // catalog row nor the typed add row can resolve back to it.
            items.forEach((i) => { if (i && i.id > 0 && skipIds.has(i.id)) skip.add((i.name || '').trim().toLowerCase()); });
            library = items.filter(keep);
        }
        if (Array.isArray(ranked)) upNext = ranked.filter(item => item && item.name && keep(item)).slice(0, 3);
    } catch (error) {
        console.error('Error loading exercise library for picker:', error);
    }
    loaded = true;
    await refresh();
}

function _wgExerciseIco(name) {
    const i = document.createElement('i');
    i.className = 'wg-ico';
    i.setAttribute('data-icon', name);
    if (window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
        try { i.appendChild(window.WGIcons.iconSvg(name)); } catch (_) { /* unknown icon: leave the placeholder */ }
    }
    return i;
}

// Create-new half of the shared picker: resolve a typed name to a library
// exercise id, upserting a new library row when the name is unknown (the
// server INSERTs without dedup, so match by trimmed, case-insensitive name
// first). Returns null on empty name or failure.
// Domain module for the name lookup. Same convention as groups.js
// loadWorkoutEquipmentDomain: the indirection is the test seam.
function loadWorkoutLibraryDomain() { return import('/domain/workout.js'); }

async function resolveOrCreateLibraryId(name, defaults = {}) {
    const trimmed = (name || '').trim();
    if (!trimmed) return null;
    // The domain's one ingestion lookup (med-l5yr.2): exact name, else any
    // case/spacing of a row's name, else an alias. The domain 409s a create on
    // any of these, so the picker must land on the same row first.
    const { findLibraryRowByName } = await window.WorkoutLibrary.loadDomain();
    const match = (list) => findLibraryRowByName(list, trimmed);
    const items = await apiCall('/api/workout/exercise-library') || [];
    const existing = match(items);
    if (existing) return existing.id;
    const created = await apiCall('/api/workout/exercise-library/create', 'POST', {
        name: trimmed,
        default_sets: defaults.sets || 0,
        default_reps_min: defaults.repsMin || 0,
        default_reps_max: defaults.repsMax ?? null,
        default_weight_kg: defaults.weight ?? null,
        notes: ''
    });
    if (created && created.id) return created.id;
    // Create failed. The UNIQUE (user_id, name) index means a concurrent
    // tab/client may have just created this exact name in the gap since our
    // list read — the INSERT then 500s. Refetch and match by name so we log
    // against the now-existing row instead of refusing an exercise that exists.
    const after = await apiCall('/api/workout/exercise-library') || [];
    const raced = match(after);
    return raced ? raced.id : null;
}

window.WorkoutLibrary = {
    load: loadExerciseLibrary,
    save: saveExerciseLibraryItem,
    openAdd: showExerciseLibraryModal,
    openEdit: showEditExerciseLibraryModal,
    close: closeExerciseLibraryModal,
    delete: deleteExerciseLibraryItem,
    setQuery: setExerciseLibraryQuery,
    setSource: setExerciseLibrarySource,
    bindExercisePicker: bindExercisePicker,
    bindExerciseAddList: bindExerciseAddList,
    resolveOrCreateLibraryId: resolveOrCreateLibraryId,
    loadDomain: loadWorkoutLibraryDomain,
    // Exercise identity (med-l5yr.4, kit EI1–EI6).
    checkName: checkExerciseLibraryName,
    openPicker: openExerciseLibraryPicker,
    closePicker: closeExerciseLibraryPicker,
    repaintPicker: () => _paintExerciseLibraryPicker(),
    confirmMerge: confirmExerciseMerge,
    addNameFromHistory: addExerciseNameFromHistory,
    removeAlias: removeExerciseAlias
};
