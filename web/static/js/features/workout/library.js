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
            _renderExerciseLibrary(container, cached);
        },
        onFresh: async (fresh) => {
            renderedSomething = true;
            _renderExerciseLibrary(container, fresh);
        },
        onError: async (error, cached) => {
            console.error('Error loading exercise library:', error);
            if (cached) {
                renderedSomething = true;
            } else if (container) {
                renderedSomething = true;
                const message = document.createElement('p');
                message.className = 'text-hint';
                message.textContent = 'No cached data — will load when online';
                container.replaceChildren(message);
            }
        }
    });
    if (!renderedSomething && container) {
        const message = document.createElement('p');
        message.className = 'text-hint';
        message.textContent = 'No cached data — will load when online';
        container.replaceChildren(message);
    }
}

function _renderExerciseLibrary(container, items) {
    if (!container) return;
    const doc = container.ownerDocument;
    if (!doc || typeof doc.createElement !== 'function') return;

    container.classList.add('wg-workouts-exercises');

    if (!items || items.length === 0) {
        const empty = doc.createElement('p');
        empty.className = 'wg-workouts-exercises__empty';
        empty.textContent = 'No exercises in library yet — tap Add to create one.';
        container.replaceChildren(empty);
        return;
    }

    const list = doc.createElement('ul');
    list.className = 'list-reset wg-workouts-exercises__list';

    items.forEach((item) => {
        list.appendChild(_buildExerciseLibraryRow(doc, item));
    });

    container.replaceChildren(list);
}

function _buildExerciseLibraryRow(doc, item) {
    const slot = getRotationSlot(item.name || '');
    const slotMod = _slotTagModifier(slot);

    const card = doc.createElement('li');
    card.className = 'wg-card wg-workouts-exercises-row';
    card.dataset.exerciseId = String(item.id || '');
    card.dataset.slot = slot;

    const body = doc.createElement('div');
    body.className = 'wg-workouts-exercises-row__body';

    const title = doc.createElement('div');
    title.className = 'wg-workouts-exercises-row__title';

    const slotTag = doc.createElement('span');
    slotTag.className = `wg-tag wg-tag--mono wg-workouts-slot-tag wg-workouts-slot-tag--${slotMod} wg-workouts-exercises-row__slot`;
    slotTag.textContent = slot;
    title.appendChild(slotTag);

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

    const actions = doc.createElement('div');
    actions.className = 'wg-workouts-exercises-row__actions';
    actions.appendChild(_buildExercisesIconBtn(doc, 'edit', 'Edit exercise', 'pencil', () => {
        showEditExerciseLibraryModal(item.id);
    }));
    actions.appendChild(_buildExercisesIconBtn(doc, 'delete', 'Delete exercise', 'trash', (event) => {
        deleteExerciseLibraryItem(item.id, event);
    }));
    card.appendChild(actions);

    card.addEventListener('click', (e) => {
        if (e.target.closest('.wg-workouts-exercises-row__actions')) return;
        showEditExerciseLibraryModal(item.id);
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

function showExerciseLibraryModal(id) {
    window.WorkoutEdit.editingLibraryItemId = null;
    document.getElementById('exercise-library-modal-title').textContent = 'Add Exercise';
    document.getElementById('exercise-library-rename-hint').hidden = true;
    window.ModalManager.exerciseLibrary.open();

    document.getElementById('exercise-library-name').value = '';
    document.getElementById('exercise-library-sets').value = '';
    document.getElementById('exercise-library-reps-min').value = '';
    document.getElementById('exercise-library-reps-max').value = '';
    document.getElementById('exercise-library-weight').value = '';
    document.getElementById('exercise-library-notes').value = '';

    bindExerciseTypeahead(
        document.getElementById('exercise-library-name'),
        document.getElementById('exercise-catalog-datalist')
    );
}

async function showEditExerciseLibraryModal(id) {
    const items = await apiCall('/api/workout/exercise-library');
    const item = items && items.find(i => i.id === id);
    if (!item) return;

    window.WorkoutEdit.editingLibraryItemId = id;
    document.getElementById('exercise-library-modal-title').textContent = 'Edit Exercise';
    document.getElementById('exercise-library-rename-hint').hidden = false;
    window.ModalManager.exerciseLibrary.open();

    document.getElementById('exercise-library-name').value = item.name;
    document.getElementById('exercise-library-sets').value = item.default_sets || '';
    document.getElementById('exercise-library-reps-min').value = item.default_reps_min || '';
    document.getElementById('exercise-library-reps-max').value = item.default_reps_max || '';
    document.getElementById('exercise-library-weight').value = item.default_weight_kg || '';
    document.getElementById('exercise-library-notes').value = item.notes || '';

    // Bound after the name is filled in, so the initial refresh matches the
    // edited exercise instead of whatever the input held from a previous open.
    bindExerciseTypeahead(
        document.getElementById('exercise-library-name'),
        document.getElementById('exercise-catalog-datalist')
    );
}

function closeExerciseLibraryModal() {
    window.ModalManager.exerciseLibrary.close();
    window.WorkoutEdit.editingLibraryItemId = null;
}

async function saveExerciseLibraryItem() {
    const name = document.getElementById('exercise-library-name').value.trim();
    const sets = parseInt(document.getElementById('exercise-library-sets').value) || 0;
    const repsMin = parseInt(document.getElementById('exercise-library-reps-min').value) || 0;
    const repsMaxRaw = document.getElementById('exercise-library-reps-max').value;
    const repsMax = repsMaxRaw !== '' ? parseInt(repsMaxRaw) : null;
    const weightRaw = document.getElementById('exercise-library-weight').value;
    const weight = weightRaw !== '' ? parseFloat(weightRaw) : null;
    const notes = document.getElementById('exercise-library-notes').value.trim();

    if (!name) {
        safeAlert('Exercise name is required!');
        return;
    }

    const payload = {
        name: name,
        default_sets: sets,
        default_reps_min: repsMin,
        default_reps_max: repsMax,
        default_weight_kg: weight,
        notes: notes
    };

    let result;
    if (window.WorkoutEdit.editingLibraryItemId) {
        result = await apiCall(`/api/workout/exercise-library/update?id=${window.WorkoutEdit.editingLibraryItemId}`, 'PUT', payload);
    } else {
        result = await apiCall('/api/workout/exercise-library/create', 'POST', payload);
    }

    if (result || result === true) {
        closeExerciseLibraryModal();
        loadExerciseLibrary();
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

// Canonical exercise-name suggestions from the vendored static catalog
// (med-s5m.2). Suggest-only: fills a <datalist> so the name inputs surface
// canonical names ("Barbell bench press") and cut near-duplicates, without
// ever constraining free typing. The 913 KB asset is fetched once, lazily
// (only when the user actually types into a name field — see the type-ahead
// below); a failed fetch is silent — the inputs just fall back to no catalog
// suggestions — and is retried on the next keystroke.
let _exerciseCatalogNamesPromise = null; // module-state: single-flight cache for the one-time static exercise-catalog fetch (med-s5m.2)
function _loadExerciseCatalogNames() {
    if (!_exerciseCatalogNamesPromise) {
        _exerciseCatalogNamesPromise = fetch('/static/data/exercises-catalog.json')
            .then(r => (r.ok ? r.json() : Promise.reject(new Error('catalog ' + r.status))))
            .then(cat => (cat.exercises || []).map(e => e.name).filter(Boolean))
            .catch(err => {
                console.error('Error loading exercise catalog:', err);
                _exerciseCatalogNamesPromise = null; // allow a later retry (e.g. offline -> online)
                return [];
            });
    }
    return _exerciseCatalogNamesPromise;
}

// Type-ahead over BOTH halves of the add-exercise pickers (med-3q8.1,
// med-max). Dumping the user's whole library and/or all 1324 catalog names
// into a <datalist> makes mobile browsers render a half-screen scrolling
// suggestion sheet that buries the keyboard, so every option is rebuilt from
// what the user typed: nothing at all until the first character, the user's
// own library first (it carries the autofill dataset), then catalog names —
// those still gated at 2 characters so the 913 KB asset is not fetched on the
// very first keystroke. No debounce: the match runs over in-memory arrays.
//
// ponytail: EXERCISE_SUGGESTION_LIMIT is the only lever a native <datalist>
// gives us — its popup height cannot be capped or styled from CSS. If 6 rows
// still overlay too much of the screen, the real fix is dropping <datalist>
// for our own styled suggestion list.
const EXERCISE_CATALOG_MIN_QUERY = 2;
const EXERCISE_SUGGESTION_LIMIT = 6;

// The user-library rows backing each picker <datalist>, registered by
// populatePickerOptions so a refresh can rebuild the library half from the
// typed query instead of dumping all of it. A datalist with no entry here (the
// exercise-library modal's) stays catalog-only.
const _pickerLibraryItems = new WeakMap();

// Library rows carry the autofill dataset the three re-look-up sites read;
// catalog-only names stay id-less so callers route them through
// resolveOrCreateLibraryId instead of posting a bogus exercise_id.
function _buildSuggestionOption(item) {
    const option = document.createElement('option');
    option.value = item.name;
    if (item.id == null) {
        option.dataset.catalog = '1';
        return option;
    }
    option.dataset.id = item.id;
    option.dataset.sets = item.default_sets || '';
    option.dataset.repsMin = item.default_reps_min || '';
    option.dataset.repsMax = item.default_reps_max || '';
    option.dataset.weight = item.default_weight_kg || '';
    return option;
}

// Replace every option of a <datalist> with the capped, deduped top of
// `matches` (already in library-then-catalog order).
function _paintSuggestions(datalist, matches, q) {
    // Hoist an exact match ahead of the cap: onSessionExerciseSelect,
    // saveNewSessionExercise and the exercises.js onchange all re-look-up the
    // picked value in datalist.options, and picking from the native popup
    // fires `input` (a refresh, with the full picked name as the query) before
    // `change` (the lookup) — slicing the exact row away would make a picked
    // name look like an unknown one.
    const ordered = matches.slice();
    const exact = ordered.findIndex(m => (m.name || '').toLowerCase() === q);
    if (exact > 0) ordered.unshift(ordered.splice(exact, 1)[0]);

    const frag = document.createDocumentFragment();
    const seen = new Set();
    for (const item of ordered) {
        const key = (item.name || '').toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        frag.appendChild(_buildSuggestionOption(item));
        if (seen.size >= EXERCISE_SUGGESTION_LIMIT) break;
    }
    datalist.replaceChildren();
    datalist.appendChild(frag);
}

// Rebuild every option of a <datalist> from the typed query.
let _catalogRefreshSeq = 0; // module-state: last-writer-wins guard for the awaited first fetch
async function refreshExerciseSuggestions(datalist, query) {
    if (!datalist) return;
    const seq = ++_catalogRefreshSeq;
    const q = (query || '').trim().toLowerCase();
    // Library first: those options carry the autofill dataset, so when a name
    // sits in both halves the library one wins the dedupe.
    const matches = q
        ? (_pickerLibraryItems.get(datalist) || []).filter(i => (i.name || '').toLowerCase().includes(q))
        : [];
    // Paint the library half NOW: it is a local vault read, while the first
    // catalog refresh awaits a 913 KB asset. Leaving the previous query's rows
    // up until that lands would keep offering suggestions the user has already
    // typed past.
    _paintSuggestions(datalist, matches, q);
    if (q.length >= EXERCISE_CATALOG_MIN_QUERY && matches.length < EXERCISE_SUGGESTION_LIMIT) {
        const names = await _loadExerciseCatalogNames();
        // Only the first refresh actually awaits a network fetch; while it is
        // in flight the user can type on or delete back below the threshold,
        // and that later refresh already repainted the datalist. Drop this
        // stale continuation instead of re-appending its matches.
        if (seq !== _catalogRefreshSeq) return;
        for (const name of names) {
            if (name.toLowerCase().includes(q)) matches.push({ name });
        }
        _paintSuggestions(datalist, matches, q);
    }
}

// Wire a name input to its <datalist> so typing refilters the suggestions.
// `oninput` assignment (not addEventListener) so reopening a modal cannot
// stack handlers; the handler returns the refresh promise so callers/tests can
// await it. Also runs one refresh for the input's current value, which clears
// options left over from a previous open.
function bindExerciseTypeahead(input, datalist) {
    if (!input || !datalist) return Promise.resolve();
    input.oninput = () => refreshExerciseSuggestions(datalist, input.value);
    return refreshExerciseSuggestions(datalist, input.value);
}

// Shared add-exercise picker (med-prk.3): register the user's library as the
// first half of the type-ahead and wire `input` on the name field so both
// halves refilter as the user types (med-3q8.1, med-max) — plan-editing
// (exercises.js) and in-session add (sessions.js) search one surface. The
// session modal's single reps input reads `repsMin` too, so one convention
// serves both call sites. Nothing is rendered until the user types: dumping
// the whole library on open is what covered half the phone screen (med-max).
async function populatePickerOptions(datalist, nameInput) {
    if (!datalist) return;
    datalist.replaceChildren();
    let items = [];
    try {
        items = await apiCall('/api/workout/exercise-library') || [];
    } catch (error) {
        console.error('Error loading exercise library for picker:', error);
    }
    _pickerLibraryItems.set(datalist, items);
    await bindExerciseTypeahead(nameInput, datalist);
}

// Create-new half of the shared picker: resolve a typed name to a library
// exercise id, upserting a new library row when the name is unknown (the
// server INSERTs without dedup, so match by trimmed, case-insensitive name
// first). Returns null on empty name or failure.
async function resolveOrCreateLibraryId(name, defaults = {}) {
    const trimmed = (name || '').trim();
    if (!trimmed) return null;
    const items = await apiCall('/api/workout/exercise-library') || [];
    const existing = items.find(i => (i.name || '').trim().toLowerCase() === trimmed.toLowerCase());
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
    const raced = after.find(i => (i.name || '').trim().toLowerCase() === trimmed.toLowerCase());
    return raced ? raced.id : null;
}

window.WorkoutLibrary = {
    load: loadExerciseLibrary,
    save: saveExerciseLibraryItem,
    openAdd: showExerciseLibraryModal,
    openEdit: showEditExerciseLibraryModal,
    close: closeExerciseLibraryModal,
    delete: deleteExerciseLibraryItem,
    bindTypeahead: bindExerciseTypeahead,
    refreshSuggestions: refreshExerciseSuggestions,
    populatePickerOptions: populatePickerOptions,
    resolveOrCreateLibraryId: resolveOrCreateLibraryId
};
