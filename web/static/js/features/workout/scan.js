// ====================================
// WORKOUT SHEET SCAN-BACK (bd med-ac5h → med-qj4.9)
// ====================================
//
// Photograph a hand-filled printed plan sheet and log its per-set numbers.
// Cloud only: the photo is parsed browser-direct by the user's own vision
// provider (window.CloudWorkoutSheetAI, same contract as food photos), so
// the image never crosses /api — legacy bot mode has no endpoint for this,
// by design, and the Scan button is hidden there.
//
// Flow: scan(group) → photo picker (window.MediaCapture abstraction) →
// plan context re-read from the same endpoints the sheet printed from →
// parse → review modal (editable, nothing writes before Confirm) →
// logSheetAsSession → cache invalidate.
//
// Nothing here invents a write path: the confirm step lands in the workout
// domain's own createAdHocSession/createLog/setSessionStatus, the same
// writes the session modal makes.

(function () {
    // Pending review state. Held on the namespace (not module-closed) so
    // tests can seed and read it without opening a picker or a modal.
    window.WorkoutScan = window.WorkoutScan || {};
    window.WorkoutScan._pending = null;
})();

// buildScanPlanContext(group, days, unit) → the planContext the sheet domain
// validates against. Pure over its inputs (no fetch, no DOM) so the mapping
// the model must hit is assertable without a photo.
function buildScanPlanContext(group, days, unit) {
    return {
        groupId: group && group.id,
        groupName: (group && group.name) || 'Workout plan',
        unit: unit === 'lb' ? 'lb' : 'kg',
        days: (days || []).map((d) => ({
            variant: { id: d.variant && d.variant.id, name: (d.variant && d.variant.name) || 'Day' },
            exercises: ((d && d.exercises) || []).map((ex) => ({ id: ex.id, exercise_name: ex.exercise_name })),
        })),
    };
}

// readScanReviewList(container) → [{ variantId, exerciseId, exerciseName,
// setIndex, reps, weightKg, unit }]. Reads the review modal back; a row the
// user emptied is dropped (not logged as zero), a non-number is dropped.
function readScanReviewList(container, unit) {
    const out = [];
    if (!container || typeof container.querySelectorAll !== 'function') return out;
    const rows = container.querySelectorAll('[data-scan-set]');
    rows.forEach((row) => {
        const repsRaw = row.querySelector('[data-scan-reps]');
        const weightRaw = row.querySelector('[data-scan-weight]');
        // A blank reps field means "cleared by hand" — drop the row. (Number('')
        // is 0, so the blank check must come before the numeric conversion.)
        const repsText = repsRaw ? String(repsRaw.value).trim() : '';
        if (repsText === '') return;
        const reps = Math.trunc(Number(repsText));
        if (!Number.isFinite(reps) || reps < 0) return;
        let weightKg = null;
        if (weightRaw && String(weightRaw.value).trim() !== '') {
            const w = Number(String(weightRaw.value).trim());
            if (!Number.isFinite(w) || w < 0) return;
            weightKg = unit === 'lb' ? Math.round(w * 0.45359237 * 100) / 100 : w;
        }
        out.push({
            variantId: Number(row.dataset.variantId) || 0,
            exerciseId: Number(row.dataset.exerciseId) || 0,
            exerciseName: row.dataset.exerciseName || '',
            setIndex: Number(row.dataset.setIndex) || 0,
            reps,
            weightKg,
            unit: unit === 'lb' ? 'lb' : 'kg',
        });
    });
    return out;
}

function setScanStatus(text) {
    const el = document.getElementById('workout-scan-status');
    if (el) el.textContent = text || '';
}

function renderScanReview() {
    const pending = window.WorkoutScan._pending;
    const list = document.getElementById('workout-scan-list');
    if (!list || !pending) return;
    const doc = list.ownerDocument;
    list.replaceChildren();

    const byExercise = new Map();
    for (const s of pending.sets) {
        const key = `${s.variantId}:${s.exerciseId}`;
        if (!byExercise.has(key)) byExercise.set(key, { name: s.exerciseName, sets: [] });
        byExercise.get(key).sets.push(s);
    }

    if (byExercise.size === 0) {
        const empty = doc.createElement('p');
        empty.className = 'text-hint';
        empty.textContent = 'No readable sets — edit by hand in the session, or retake the photo.';
        list.appendChild(empty);
    }

    byExercise.forEach((entry) => {
        const block = doc.createElement('div');
        block.className = 'wg-scan-block';

        const title = doc.createElement('div');
        title.className = 'wg-scan-block__title';
        title.textContent = entry.name;
        block.appendChild(title);

        entry.sets
            .slice()
            .sort((a, b) => a.setIndex - b.setIndex)
            .forEach((s) => {
                const row = doc.createElement('div');
                row.className = 'wg-scan-row';
                row.setAttribute('data-scan-set', '');
                row.dataset.variantId = String(s.variantId || '');
                row.dataset.exerciseId = String(s.exerciseId || '');
                row.dataset.exerciseName = s.exerciseName || '';
                row.dataset.setIndex = String(s.setIndex || '');

                const label = doc.createElement('span');
                label.className = 'wg-scan-row__label';
                label.textContent = `Set ${s.setIndex}`;
                row.appendChild(label);

                const reps = doc.createElement('input');
                reps.type = 'number';
                reps.min = '0';
                reps.max = '500';
                reps.setAttribute('data-scan-reps', '');
                reps.setAttribute('aria-label', `${s.exerciseName} set ${s.setIndex} reps`);
                reps.className = 'wg-scan-row__input';
                reps.value = String(s.reps);
                row.appendChild(reps);

                const weight = doc.createElement('input');
                weight.type = 'number';
                weight.min = '0';
                weight.setAttribute('data-scan-weight', '');
                weight.setAttribute('aria-label', `${s.exerciseName} set ${s.setIndex} weight (${pending.unit})`);
                weight.className = 'wg-scan-row__input';
                weight.placeholder = pending.unit;
                if (s.weightKg !== null && s.weightKg !== undefined) {
                    weight.value = String(pending.unit === 'lb'
                        ? Math.round((s.weightKg / 0.45359237) * 10) / 10
                        : s.weightKg);
                }
                row.appendChild(weight);

                block.appendChild(row);
            });

        list.appendChild(block);
    });

    const skipped = document.getElementById('workout-scan-skipped');
    if (skipped) {
        if (pending.skipped && pending.skipped.length > 0) {
            skipped.textContent = `Not on this plan, left out: ${pending.skipped.join(', ')}`;
            skipped.classList.remove('hidden');
        } else {
            skipped.textContent = '';
            skipped.classList.add('hidden');
        }
    }
}

async function readScanPlanDays(groupId) {
    const variants = await apiCall(`/api/workout/variants?group_id=${groupId}`);
    if (!Array.isArray(variants)) return null;
    const days = [];
    for (const variant of variants) {
        const exercises = await apiCall(`/api/workout/exercises?variant_id=${variant.id}`);
        // Same rule as printing: a partial read must never log — a Day with
        // silently missing exercises would misfile every set below it.
        if (!Array.isArray(exercises)) return null;
        days.push({ variant, exercises });
    }
    return days;
}

async function scanWorkoutSheet(group) {
    const g = group || {};
    if (!window.__MEDTRACKER_CLOUD__ || !window.CloudWorkoutSheetAI) {
        safeToast('Sheet scanning is available in cloud mode.', 'info');
        return;
    }
    const picker = window.MediaCapture && typeof window.MediaCapture.pickPhoto === 'function'
        ? window.MediaCapture.pickPhoto
        : null;
    if (!picker) {
        safeToast('Photo picking is not available on this device.', 'info');
        return;
    }
    const file = await picker();
    if (!file) return;

    setScanStatus('Reading the plan…');
    const days = await readScanPlanDays(g.id);
    if (!days || days.length === 0) {
        safeToast('Couldn\'t load the plan — try again online.', 'error');
        return;
    }
    const unit = (typeof readWeightUnitPreference === 'function') ? readWeightUnitPreference() : 'kg';
    const planContext = window.WorkoutScan.buildContext(g, days, unit);

    setScanStatus('Reading the handwriting…');
    const parsePhoto = () => window.CloudWorkoutSheetAI.parseSheetFromPhoto(file, planContext);
    let result;
    try {
        result = (window.TrialConsent && typeof window.TrialConsent.retryAfterConsent === 'function')
            ? await window.TrialConsent.retryAfterConsent(parsePhoto)
            : await parsePhoto();
    } catch (e) {
        console.error('Sheet scan failed:', e);
        safeToast('Couldn\'t read the sheet: ' + (e.message || e), 'error');
        return;
    }

    const sets = (result && Array.isArray(result.sets)) ? result.sets : [];
    const skipped = (result && Array.isArray(result.skipped)) ? result.skipped : [];
    if (sets.length === 0) {
        safeToast('No readable sets found — check the photo and try again.', 'error');
        return;
    }

    window.WorkoutScan._pending = { group: g, planContext, sets, skipped, unit };
    setScanStatus('');
    renderScanReview();
    const title = document.getElementById('workout-scan-modal-title');
    if (title) title.textContent = `Scan: ${g.name || 'Workout plan'}`;
    window.ModalManager.workoutScan.open();
}

function closeWorkoutScanModal() {
    window.ModalManager.workoutScan.close();
    window.WorkoutScan._pending = null;
    setScanStatus('');
}

async function confirmWorkoutScan() {
    const pending = window.WorkoutScan._pending;
    // In-flight guard: session create + log conflict checks are read-then-
    // write, so a second tap mid-save would mint a duplicate session.
    if (!pending || pending.saving) return;
    const list = document.getElementById('workout-scan-list');
    const sets = window.WorkoutScan.readList(list, pending.unit);
    if (sets.length === 0) {
        safeAlert('Every row is empty — fill at least one set or cancel.');
        return;
    }
    pending.saving = true;
    const confirmBtn = document.getElementById('workout-scan-confirm-btn');
    if (confirmBtn) confirmBtn.disabled = true;
    setScanStatus('Logging…');
    try {
        const res = await window.CloudWorkoutSheetAI.logSheetAsSession({
            planContext: pending.planContext,
            sets,
        });
        await invalidateWorkoutCache();
        if (typeof loadWorkoutGroups === 'function') loadWorkoutGroups();
        closeWorkoutScanModal();
        const suffix = res.failed > 0 ? ` (${res.failed} already logged)` : '';
        safeToast(`Logged ${res.logged} exercise${res.logged === 1 ? '' : 's'}${suffix}.`, 'info');
    } catch (e) {
        console.error('Sheet log failed:', e);
        setScanStatus('');
        safeToast('Failed to log the scan: ' + (e.message || e), 'error');
    } finally {
        pending.saving = false;
        if (confirmBtn) confirmBtn.disabled = false;
    }
}

window.WorkoutScan.scan = scanWorkoutSheet;
window.WorkoutScan.close = closeWorkoutScanModal;
window.WorkoutScan.confirm = confirmWorkoutScan;
window.WorkoutScan.buildContext = buildScanPlanContext;
window.WorkoutScan.readList = readScanReviewList;
window.WorkoutScan.renderReview = renderScanReview;
