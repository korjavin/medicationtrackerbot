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

    bindExerciseCatalogTypeahead(
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
    bindExerciseCatalogTypeahead(
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

// Type-ahead over the catalog (med-3q8.1). Dumping all 1324 catalog names into
// a <datalist> makes mobile browsers render a full-screen suggestion sheet
// instead of a short list above the keyboard, so the catalog half is rebuilt
// from what the user typed: nothing under 2 characters, at most
// EXERCISE_CATALOG_SUGGESTION_LIMIT substring matches otherwise. No debounce — the
// match runs over an in-memory array.
const EXERCISE_CATALOG_MIN_QUERY = 2;
const EXERCISE_CATALOG_SUGGESTION_LIMIT = 15;

// Rebuild ONLY the catalog options (marked `data-catalog`) of a <datalist>.
// User-library options are left untouched, and a catalog name already present
// as a library option is skipped so the autofill-carrying one wins.
let _catalogRefreshSeq = 0; // module-state: last-writer-wins guard for the awaited first fetch
async function refreshExerciseCatalogSuggestions(datalist, query) {
    if (!datalist) return;
    const seq = ++_catalogRefreshSeq;
    const q = (query || '').trim().toLowerCase();
    let matches = [];
    if (q.length >= EXERCISE_CATALOG_MIN_QUERY) {
        const names = await _loadExerciseCatalogNames();
        // Only the first refresh actually awaits a network fetch; while it is
        // in flight the user can delete back below the threshold, and that
        // shorter (synchronous) refresh already repainted the datalist. Drop
        // this stale continuation instead of re-appending its matches.
        if (seq !== _catalogRefreshSeq) return;
        matches = names.filter(n => n.toLowerCase().includes(q));
        // Keep an exact match inside the cap: onSessionExerciseSelect,
        // saveNewSessionExercise and the exercises.js onchange all re-look-up
        // the picked value in datalist.options, and slicing it away would make
        // a picked catalog name look like an unknown one.
        const exact = matches.findIndex(n => n.toLowerCase() === q);
        if (exact > 0) matches.unshift(matches.splice(exact, 1)[0]);
        matches = matches.slice(0, EXERCISE_CATALOG_SUGGESTION_LIMIT);
    }
    Array.from(datalist.options).forEach(o => { if (o.dataset.catalog) o.remove(); });
    const existing = new Set(Array.from(datalist.options).map(o => o.value));
    const frag = document.createDocumentFragment();
    for (const name of matches) {
        if (existing.has(name)) continue;
        existing.add(name);
        const option = document.createElement('option');
        option.value = name;
        option.dataset.catalog = '1';
        frag.appendChild(option);
    }
    datalist.appendChild(frag);
}

// Wire a name input to its <datalist> so typing refilters the catalog half.
// `oninput` assignment (not addEventListener) so reopening a modal cannot
// stack handlers; the handler returns the refresh promise so callers/tests can
// await it. Also runs one refresh for the input's current value, which clears
// catalog options left over from a previous open.
function bindExerciseCatalogTypeahead(input, datalist) {
    if (!input || !datalist) return Promise.resolve();
    input.oninput = () => refreshExerciseCatalogSuggestions(datalist, input.value);
    return refreshExerciseCatalogSuggestions(datalist, input.value);
}

// Shared add-exercise picker (med-prk.3): fill a <datalist> from the user's
// library (value=name + autofill dataset incl. library id), and wire `input`
// on the name field so canonical catalog names are type-ahead filtered in on
// top (med-3q8.1) — plan-editing (exercises.js) and in-session add
// (sessions.js) search one surface. The session modal's single reps input
// reads `repsMin` too, so one convention serves both call sites.
async function populatePickerOptions(datalist, nameInput) {
    if (!datalist) return;
    datalist.replaceChildren();
    try {
        const items = await apiCall('/api/workout/exercise-library') || [];
        items.forEach(item => {
            const option = document.createElement('option');
            option.value = item.name;
            option.dataset.id = item.id;
            option.dataset.sets = item.default_sets || '';
            option.dataset.repsMin = item.default_reps_min || '';
            option.dataset.repsMax = item.default_reps_max || '';
            option.dataset.weight = item.default_weight_kg || '';
            datalist.appendChild(option);
        });
    } catch (error) {
        console.error('Error loading exercise library for picker:', error);
    }
    // User-library options (with autofill dataset) win over bare catalog names.
    await bindExerciseCatalogTypeahead(nameInput, datalist);
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
    bindCatalogTypeahead: bindExerciseCatalogTypeahead,
    refreshCatalogSuggestions: refreshExerciseCatalogSuggestions,
    populatePickerOptions: populatePickerOptions,
    resolveOrCreateLibraryId: resolveOrCreateLibraryId
};
