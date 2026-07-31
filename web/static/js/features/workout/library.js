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

    // Catalog-only: this modal is where library rows get created, so suggesting
    // the library back at the user would just offer duplicates.
    bindExercisePicker({
        input: document.getElementById('exercise-library-name'),
        mount: document.getElementById('exercise-library-suggest'),
        withLibrary: false
    });
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

    // The picker starts closed, so the stored name is not immediately buried
    // under suggestions for itself; it opens again as soon as the user types.
    bindExercisePicker({
        input: document.getElementById('exercise-library-name'),
        mount: document.getElementById('exercise-library-suggest'),
        withLibrary: false
    });
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
// (med-s5m.2). Suggest-only: the name inputs surface canonical names ("Barbell
// bench press") and cut near-duplicates, without ever constraining free typing.
// The 913 KB asset is fetched once, lazily (only when the user actually types
// into a name field — see the picker below); a failed fetch is silent — the
// inputs just fall back to no catalog suggestions — and is retried on the next
// keystroke.
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
    input.onblur = hide;
    input.onkeydown = (e) => { if (e.key === 'Escape') hide(); };
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
        if (!item) return;
        input.value = item.name;
        if (onPick) onPick(item);
    };

    // Start closed: an empty field means no list at all (med-max).
    hide();
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
    bindExercisePicker: bindExercisePicker,
    resolveOrCreateLibraryId: resolveOrCreateLibraryId
};
