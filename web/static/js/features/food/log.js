// ====================================
// FOOD LOG — daily list, edit modal, targets, totals
// ====================================
//
// Owns the daily food log + the macros card + the food-targets state:
//   - GET /api/food/log + /api/food/stats (via apiCall, vault-served)
//   - the day navigator label, meal list (.wg-section / .wg-row) and the
//     empty-day state (kit F1–F3)
//   - the food-modal lifecycle (open / edit / save / delete)
//   - the per-100g recompute + computeFoodTotals helper
//   - the daily/weekly macros card (renderFoodMacrosCard)
//   - food-targets fetch + save (formerly on app.js)
//
// Closure-private state (all the "module-state" globals from the original
// food.js + the `currentFoodLogs` duplicate from app.js:1079) lives in the
// IIFE below and is exposed via window.FoodLog accessors. The plan rule:
// only the orchestrator may keep `let _state`; extracted files use an
// IIFE-wrapped closure.

(function () {
    var currentFoodLogs = {};
    let foodTargets = {
        calories: 0,
        carbs: 0,
        protein: 0,
        fat: 0
    };
    let foodMacrosRange = 'day';
    let currentFoodStatsPeriod = 'day';
    let lastFoodLogsMeta = null;

    window.FoodLog = window.FoodLog || {};

    // currentFoodLogs accessor — canonical replacement for the deleted
    // `var currentFoodLogs` from app.js:1079. Maintains the same shape
    // ({id: log, ...}) so edit/delete handlers keep working.
    Object.defineProperty(window.FoodLog, '_logs', {
        get: () => currentFoodLogs,
        set: (v) => { currentFoodLogs = v || {}; },
        enumerable: true,
        configurable: true
    });
    window.FoodLog.getCurrent = () => currentFoodLogs;
    window.FoodLog.setCurrent = (v) => { currentFoodLogs = v || {}; };
    window.FoodLog.setLog = (id, log) => { currentFoodLogs[id] = log; };

    Object.defineProperty(window.FoodLog, 'targets', {
        get: () => foodTargets,
        set: (v) => { foodTargets = v || { calories: 0, carbs: 0, protein: 0, fat: 0 }; },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(window.FoodLog, 'macrosRange', {
        get: () => foodMacrosRange,
        set: (v) => { foodMacrosRange = v === 'week' ? 'week' : 'day'; },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(window.FoodLog, 'statsPeriod', {
        get: () => currentFoodStatsPeriod,
        set: (v) => { currentFoodStatsPeriod = v; },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(window.FoodLog, 'meta', {
        get: () => lastFoodLogsMeta,
        set: (v) => { lastFoodLogsMeta = v; },
        enumerable: true,
        configurable: true
    });
    // Backward-compatible alias for the legacy `window.foodTargets` global
    // surfaced by app.js. Settings tests + the targets save flow read this
    // directly. Kept as a live getter so writes through window.FoodLog.targets
    // stay observable on the old name.
    Object.defineProperty(window, 'foodTargets', {
        get: () => foodTargets,
        set: (v) => { foodTargets = v || { calories: 0, carbs: 0, protein: 0, fat: 0 }; },
        enumerable: true,
        configurable: true
    });
})();

const FOOD_MACROS_RANGES = ['day', 'week'];

function setFoodMacrosRange(range) {
    if (FOOD_MACROS_RANGES.indexOf(range) === -1) return;
    window.FoodLog.macrosRange = range;
    // Keep `currentFoodStatsPeriod` in sync so shiftFoodDate() steps by 7 days
    // in weekly mode and 1 day in daily mode.
    window.FoodLog.statsPeriod = range;
    syncFoodMacrosToggleActiveClass();
    loadFoodLogs();
}

function syncFoodMacrosToggleActiveClass() {
    const container = document.getElementById('food-macros-toggle');
    if (!container) return;
    container.querySelectorAll('.wg-seg__opt').forEach((btn) => {
        btn.setAttribute('aria-pressed', btn.dataset.range === window.FoodLog.macrosRange ? 'true' : 'false');
    });
}

function calculateFoodCalories(force = false) {
    const weight = parseFloat(document.getElementById('food-weight').value) || 0;
    const carbs = parseFloat(document.getElementById('food-carbs').value) || 0;
    const protein = parseFloat(document.getElementById('food-protein').value) || 0;
    const fat = parseFloat(document.getElementById('food-fat').value) || 0;
    const per100g = document.getElementById('food-per-100g').checked;
    const caloriesInput = document.getElementById('food-calories');

    let totalCarbs = carbs;
    let totalProt = protein;
    let totalFat = fat;
    if (per100g) {
        totalCarbs = (carbs * weight) / 100;
        totalProt = (protein * weight) / 100;
        totalFat = (fat * weight) / 100;
    }

    const totalCals = Math.round((4 * totalCarbs) + (4 * totalProt) + (9 * totalFat));
    if (force || per100g || caloriesInput.value === '') {
        caloriesInput.value = totalCals;
    }
}

function onFoodPer100gChange() {
    calculateFoodCalories(true);
}

function onFoodCaloriesFocus() {
    // No-op: focusing the calories field should not auto-uncheck the per-100g mode
    // or mutate macro values. Users can manually edit calories without losing mode context.
}

function parseOptionalNumber(rawValue) {
    const v = String(rawValue || '').trim();
    if (v === '') return null;
    const n = parseFloat(v);
    if (Number.isNaN(n)) return null;
    return n;
}

function computeFoodTotals() {
    const carbsInput = parseOptionalNumber(document.getElementById('food-carbs').value);
    const proteinInput = parseOptionalNumber(document.getElementById('food-protein').value);
    const fatInput = parseOptionalNumber(document.getElementById('food-fat').value);
    const caloriesInput = parseOptionalNumber(document.getElementById('food-calories').value);
    const weightInput = parseOptionalNumber(document.getElementById('food-weight').value);
    const per100g = document.getElementById('food-per-100g').checked;
    const weight = weightInput && weightInput > 0 ? weightInput : 0;
    const multiplier = per100g && weight > 0 ? weight / 100 : 1;

    let totalCarbs = carbsInput === null ? null : carbsInput * multiplier;
    let totalProtein = proteinInput === null ? null : proteinInput * multiplier;
    let totalFat = fatInput === null ? null : fatInput * multiplier;
    let totalCalories = caloriesInput;

    const missing = [];
    if (totalCarbs === null) missing.push('carbs');
    if (totalProtein === null) missing.push('protein');
    if (totalFat === null) missing.push('fat');
    if (totalCalories === null) missing.push('calories');

    if (missing.length === 1) {
        const missingField = missing[0];
        if (missingField === 'calories' && totalCarbs !== null && totalProtein !== null && totalFat !== null) {
            totalCalories = (4 * totalCarbs) + (4 * totalProtein) + (9 * totalFat);
        } else if (missingField === 'carbs' && totalCalories !== null && totalProtein !== null && totalFat !== null) {
            totalCarbs = (totalCalories - (4 * totalProtein) - (9 * totalFat)) / 4;
        } else if (missingField === 'protein' && totalCalories !== null && totalCarbs !== null && totalFat !== null) {
            totalProtein = (totalCalories - (4 * totalCarbs) - (9 * totalFat)) / 4;
        } else if (missingField === 'fat' && totalCalories !== null && totalCarbs !== null && totalProtein !== null) {
            totalFat = (totalCalories - (4 * totalCarbs) - (4 * totalProtein)) / 9;
        }
    }

    return {
        weight: Math.round(weight),
        carbs: Math.round(totalCarbs || 0),
        protein: Math.round(totalProtein || 0),
        fat: Math.round(totalFat || 0),
        calories: Math.round(totalCalories || 0),
        per100g
    };
}

function toISODateLocal(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// 'Today' / 'Yesterday' / 'Tomorrow', or '' for any other day.
function foodRelativeDay(dateStr) {
    if (!dateStr) return '';
    const date = new Date(`${dateStr}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    return { '0': 'Today', '-1': 'Yesterday', '1': 'Tomorrow' }[String(diffDays)] || '';
}

function formatFoodDateLabel(dateStr) {
    if (!dateStr) return '';
    return foodRelativeDay(dateStr)
        || new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatFoodDateSubtitle(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

// Day-navigator date (kit F1/F2): a relative day sits as a chip beside the
// short "Thu 08.10"; any other day spells out "Wednesday · 07.10.2026".
function formatFoodDayNavDate(dateStr) {
    const date = new Date(`${dateStr}T00:00:00`);
    const full = formatFoodDateSubtitle(dateStr);
    if (foodRelativeDay(dateStr)) {
        return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${full.slice(0, 5)}`;
    }
    return `${date.toLocaleDateString(undefined, { weekday: 'long' })} · ${full}`;
}

function updateFoodDateNav() {
    const dateFilter = document.getElementById('food-date-filter');
    const chip = document.getElementById('food-date-chip');
    const text = document.getElementById('food-date-text');
    const nextBtn = document.getElementById('food-date-next-btn');
    if (!dateFilter || !nextBtn) return;

    const dateStr = dateFilter.value;
    if (!dateStr) return;

    const rel = foodRelativeDay(dateStr);
    if (chip) {
        chip.textContent = rel;
        chip.classList.toggle('hidden', !rel);
    }
    if (text) text.textContent = formatFoodDayNavDate(dateStr);

    const date = new Date(`${dateStr}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const isTodayOrFuture = date.getTime() >= today.getTime();
    nextBtn.disabled = isTodayOrFuture;
}

function shiftFoodDate(deltaDays) {
    const dateFilter = document.getElementById('food-date-filter');
    if (!dateFilter) return;

    const period = window.FoodLog.statsPeriod || 'day';
    const multiplier = period === 'week' ? 7 : 1;

    const baseDate = dateFilter.value ? new Date(`${dateFilter.value}T00:00:00`) : new Date();
    baseDate.setDate(baseDate.getDate() + (deltaDays * multiplier));
    dateFilter.value = toISODateLocal(baseDate);
    loadFoodLogs();
    updateFoodDateNav();
}

function showAddFoodModal() {
    window.ModalManager.food.open();
    document.getElementById('food-modal-title').innerText = 'New entry';

    document.getElementById('food-datetime').value = formatDateTimeLocalForInput();

    document.getElementById('food-id').value = '';
    const pidEl = document.getElementById('food-log-product-id');
    if (pidEl) pidEl.value = '';
    const isMealEl = document.getElementById('food-log-is-meal');
    if (isMealEl) isMealEl.value = '';

    const linkContainer = document.getElementById('food-product-link-container');
    if (linkContainer) {
        linkContainer.innerHTML = '';
        linkContainer.classList.add('hidden');
    }

    document.getElementById('food-name').value = '';
    document.getElementById('food-barcode').value = '';
    document.getElementById('food-weight').value = '';
    document.getElementById('food-carbs').value = '';
    document.getElementById('food-protein').value = '';
    document.getElementById('food-fat').value = '';
    document.getElementById('food-calories').value = '';
    document.getElementById('food-per-100g').checked = true;
    setFoodParseAIMode(false);
    const aiCheckboxAdd = document.getElementById('food-parse-ai');
    if (aiCheckboxAdd) aiCheckboxAdd.disabled = false;
    document.getElementById('food-weight').focus();

    const cache = window.FoodProducts && window.FoodProducts.cache;
    if (!cache || cache.length === 0) {
        initFoodProductsCache().then(() => renderFoodAutocomplete(window.FoodProducts.cache, false, null, false));
    } else {
        renderFoodAutocomplete(cache, false, null, false);
    }
}

function editFoodLog(id) {
    const log = window.FoodLog._logs[id];
    if (!log) return;

    window.ModalManager.food.open();
    document.getElementById('food-modal-title').innerText = 'Edit entry';
    // Edits always run through the manual path — the AI parse endpoint
    // only creates new rows, so AI mode would be a dead-end for edits.
    setFoodParseAIMode(false);
    const aiCheckbox = document.getElementById('food-parse-ai');
    if (aiCheckbox) aiCheckbox.disabled = true;

    document.getElementById('food-id').value = log.id;
    const pidEl = document.getElementById('food-log-product-id');
    if (pidEl) pidEl.value = log.product_id || '';
    const isMealEl = document.getElementById('food-log-is-meal');
    if (isMealEl) isMealEl.value = log.is_meal ? 'true' : '';
    document.getElementById('food-name').value = log.name || '';
    document.getElementById('food-barcode').value = log.barcode || '';
    document.getElementById('food-weight').value = log.weight || '';

    if (log.weight > 0) {
        document.getElementById('food-per-100g').checked = true;
        document.getElementById('food-carbs').value = +((log.carbs / log.weight) * 100).toFixed(1);
        document.getElementById('food-protein').value = +((log.protein / log.weight) * 100).toFixed(1);
        document.getElementById('food-fat').value = +((log.fat / log.weight) * 100).toFixed(1);
        calculateFoodCalories();
    } else {
        document.getElementById('food-per-100g').checked = false;
        document.getElementById('food-carbs').value = log.carbs || '';
        document.getElementById('food-protein').value = log.protein || '';
        document.getElementById('food-fat').value = log.fat || '';
        document.getElementById('food-calories').value = log.calories || '';
    }

    if (log.eaten_at) {
        document.getElementById('food-datetime').value = formatDateTimeLocalForInput(log.eaten_at);
    }

    const linkContainer = document.getElementById('food-product-link-container');
    if (log.product_id) {
        const link = document.createElement('a');
        link.href = '#';
        link.className = 'food-product-link';
        link.textContent = '→ View in Products';
        const productId = log.product_id;
        link.addEventListener('click', (event) => {
            event.preventDefault();
            navigateToFoodProduct(event, productId);
        });
        linkContainer.replaceChildren(link);
        linkContainer.classList.remove('hidden');
    } else {
        linkContainer.replaceChildren();
        linkContainer.classList.add('hidden');
    }

    document.getElementById('food-weight').focus();
}

function closeFoodModal() {
    window.ModalManager.food.close();
}

async function saveFoodLog() {
    const id = document.getElementById('food-id').value;
    const aiCheckbox = document.getElementById('food-parse-ai');
    // AI mode only creates new rows, so it's only valid for "add" — never for
    // edits. Editing an existing row falls through to the manual update path
    // regardless of checkbox state.
    if (!id && aiCheckbox && aiCheckbox.checked) {
        return saveFoodLogFromDescription();
    }

    const name = document.getElementById('food-name').value;
    const dateStr = document.getElementById('food-datetime').value;

    if (!dateStr) {
        safeAlert("Please enter date.");
        return;
    }
    const totals = computeFoodTotals();
    if (totals.per100g && totals.weight <= 0) {
        safeAlert("Please enter weight for per 100g mode, or uncheck it.");
        return;
    }

    const eatenAtIso = new Date(dateStr).toISOString();
    const payload = {
        eaten_at: eatenAtIso,
        weight: totals.weight,
        carbs: totals.carbs,
        protein: totals.protein,
        fat: totals.fat,
        calories: totals.calories,
        name: name,
        barcode: document.getElementById('food-barcode').value,
        per_100g: false
    };

    const pidEl = document.getElementById('food-log-product-id');
    if (pidEl && pidEl.value) {
        // Bot-mode product ids are numeric; cloud-mode ids are string recordIds
        // (`foodproduct_…`). parseInt on a recordId yields NaN (falsy), which
        // silently drops the product link — keep numeric strings as numbers but
        // leave recordIds intact (mirrors the editingId guard below).
        payload.product_id = /^\d+$/.test(pidEl.value) ? parseInt(pidEl.value, 10) : pidEl.value;
    }

    const isUpdate = !!id;

    const btn = document.getElementById('food-modal-save-btn');
    await withSubmit(btn, async () => {
        // Optimistic projection on the day caches so the row + Today's
        // macros tile update before the network round-trip resolves. The
        // log's eaten_at decides which day caches are affected; we keep
        // both `food_<date>_v2` (loadFoodLogs's cache) and `food_<date>_day`
        // (Today's per-day key) in sync because they share the same shape.
        const localDay = toISODateLocal(new Date(dateStr));
        const v2Key = `food_${localDay}_v2`;
        const dayKey = typeof todayFoodKey === 'function'
            ? todayFoodKey(new Date(dateStr))
            : `food_${localDay}_day`;
        // Bot-mode log ids are numeric (server JSON numbers); cloud-mode ids are
        // string recordIds (`foodlog_…`). Keep numeric strings as numbers so the
        // `l.id === editingId` match in buildOptimisticFoodCache still hits the
        // number-typed cache rows, but leave string ids intact — parseInt on a
        // recordId yields NaN, which never matches and duplicates the edited row.
        const editingId = isUpdate ? (/^\d+$/.test(id) ? parseInt(id, 10) : id) : null;
        const localId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const optimisticLog = {
            id: editingId || localId,
            name: payload.name,
            barcode: payload.barcode,
            weight: payload.weight,
            carbs: payload.carbs,
            protein: payload.protein,
            fat: payload.fat,
            calories: payload.calories,
            eaten_at: payload.eaten_at,
            product_id: payload.product_id || null,
            isLocal: !isUpdate,
            pending: true
        };

        const handles = [];
        if (window.DataStore && typeof window.DataStore.applyOptimistic === 'function') {
            const v2Mutator = (prev) => buildOptimisticFoodCache(prev, optimisticLog, editingId, { includeWeekStats: true });
            const dayMutator = (prev) => buildOptimisticFoodCache(prev, optimisticLog, editingId, { includeWeekStats: false });
            handles.push(await window.DataStore.applyOptimistic(v2Key, v2Mutator, ['food']));
            handles.push(await window.DataStore.applyOptimistic(dayKey, dayMutator, ['food']));
        }

        let res;
        try {
            if (isUpdate) {
                res = await apiCall(`/api/food/log/${id}`, 'PUT', payload);
            } else {
                res = await apiCall('/api/food/log', 'POST', payload);
            }
        } catch (e) {
            for (const h of handles) { try { await h.rollback(); } catch (_) { /* best-effort */ } }
            throw e;
        }

        if (!res) {
            for (const h of handles) { try { await h.rollback(); } catch (_) { /* best-effort */ } }
            return;
        }

        // POST succeeded — invalidate the `food` tag so the next read fetches
        // authoritative server data layered on top of the optimistic state.
        // Use invalidateTags rather than handle.commit because the server
        // returns only `{ status, id }` for creates, not the full payload.
        for (const h of handles) {
            try { await h.commit(null); } catch (_) { /* best-effort */ }
        }
        await window.DataStore.invalidateTags(['food', 'gamification']);
        if (typeof todayFoodKey === 'function' && window.DataStore.clearCached) {
            await window.DataStore.clearCached(todayFoodKey(new Date()));
        }
        closeFoodModal();
        loadFoodLogs();
        if (window.AppStore && window.AppStore.get('currentTab') === 'today'
            && typeof window.loadToday === 'function') {
            window.loadToday();
        }
    });
}

// buildOptimisticFoodCache produces the post-mutation `{ groups, weekStats? }`
// cache payload for saveFoodLog. Add/edit branches share this code path:
//   - editingId != null: find the existing log in `groups`, replace its
//     fields, and recompute that group's totals.
//   - editingId == null: append a synthetic single-entry group so the row
//     renders + the Today aggregator picks up the new calories.
//
// The renderer + aggregator only care about `groups[*].{calories, carbs,
// protein, fat, logs}`; weekStats is left untouched and reconciled on the
// next loadFoodLogs() read.
function buildOptimisticFoodCache(prev, log, editingId, opts = {}) {
    const groups = Array.isArray(prev?.groups) ? prev.groups.map((g) => ({
        ...g,
        logs: Array.isArray(g.logs) ? g.logs.slice() : []
    })) : [];

    if (editingId != null) {
        let found = false;
        for (const g of groups) {
            const idx = g.logs.findIndex((l) => l && l.id === editingId);
            if (idx === -1) continue;
            g.logs[idx] = { ...g.logs[idx], ...log };
            recomputeFoodGroupTotals(g);
            found = true;
            break;
        }
        if (!found) {
            groups.push(makeOptimisticFoodGroup(log));
        }
    } else {
        groups.push(makeOptimisticFoodGroup(log));
    }

    const next = prev && prev.incomplete === true ? { groups, incomplete: true } : { groups };
    if (opts.includeWeekStats) {
        next.weekStats = prev && prev.weekStats != null ? prev.weekStats : null;
    }
    return next;
}

function makeOptimisticFoodGroup(log) {
    let timeLabel = '';
    try {
        const d = new Date(log.eaten_at);
        if (!Number.isNaN(d.getTime())) {
            timeLabel = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        }
    } catch (_) { /* best-effort */ }
    const group = {
        name: log.name || 'Snack',
        time: timeLabel,
        logs: [log]
    };
    recomputeFoodGroupTotals(group);
    return group;
}

function recomputeFoodGroupTotals(group) {
    let cals = 0, carbs = 0, protein = 0, fat = 0;
    for (const l of group.logs) {
        if (Number.isFinite(l.calories)) cals += l.calories;
        if (Number.isFinite(l.carbs)) carbs += l.carbs;
        if (Number.isFinite(l.protein)) protein += l.protein;
        if (Number.isFinite(l.fat)) fat += l.fat;
    }
    group.calories = cals;
    group.carbs = carbs;
    group.protein = protein;
    group.fat = fat;
}

// AI-mode toggle (Plan 2026-05-17, Task 4). The checkbox at the top of the
// food modal swaps the body into "describe your meal" mode: macros / weight /
// barcode / per-100g / calories fields are CSS-hidden via the
// `wg-food-modal--ai-mode` class on the modal root, the food-name label
// reads "Describe your meal", and Save parses via the browser-direct AI
// path (window.CloudFoodAI) instead of /api/food/log. The shared
// autocomplete handler short-circuits when the modal is in AI mode so a
// long meal description doesn't hit the product search.
function setFoodParseAIMode(on) {
    const modal = document.getElementById('food-modal');
    const checkbox = document.getElementById('food-parse-ai');
    if (!modal) return;
    const enabled = !!on;
    modal.classList.toggle('wg-food-modal--ai-mode', enabled);
    if (checkbox) checkbox.checked = enabled;

    const nameInput = document.getElementById('food-name');
    if (nameInput && nameInput.dataset.aiPlaceholder !== undefined) {
        if (!nameInput.dataset.manualPlaceholder) {
            nameInput.dataset.manualPlaceholder = nameInput.placeholder || '';
        }
        nameInput.placeholder = enabled
            ? nameInput.dataset.aiPlaceholder
            : nameInput.dataset.manualPlaceholder;
    }

    if (enabled) {
        // A pending name- or barcode-search debounce scheduled before the
        // toggle would still fire ~800ms later and either render stale
        // autocomplete suggestions or autofill the form (barcode path calls
        // autofillFoodProduct, which sets #food-log-product-id). Cancel any
        // in-flight search so the AI mode entry is clean.
        if (typeof cancelInFlightFoodSearch === 'function') {
            cancelInFlightFoodSearch();
        }
        ['food-weight', 'food-barcode', 'food-carbs', 'food-protein', 'food-fat', 'food-calories'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        // A prior autocomplete selection may have left product_id/is_meal set
        // and the link chip visible. AI mode discards that linkage entirely —
        // the resulting logs are free-form parsed items, not bound to the
        // previously selected product. Without this clear, a user who picks
        // a product, toggles AI on, edits the description, then toggles back
        // off would silently submit the stale product_id with the new name.
        const pidEl = document.getElementById('food-log-product-id');
        if (pidEl) pidEl.value = '';
        const isMealEl = document.getElementById('food-log-is-meal');
        if (isMealEl) isMealEl.value = '';
        const linkContainer = document.getElementById('food-product-link-container');
        if (linkContainer) {
            linkContainer.replaceChildren();
            linkContainer.classList.add('hidden');
        }
        const list = document.getElementById('food-autocomplete-list');
        if (list) list.classList.add('hidden');
        const status = document.getElementById('food-search-status');
        if (status) {
            status.classList.add('hidden');
            status.textContent = '';
        }
    }
}

function bindFoodParseAIToggle() {
    const checkbox = document.getElementById('food-parse-ai');
    if (!checkbox || checkbox.dataset.bound === '1') return;
    checkbox.addEventListener('change', () => {
        setFoodParseAIMode(checkbox.checked);
    });
    checkbox.dataset.bound = '1';
}

async function saveFoodLogFromDescription() {
    const description = (document.getElementById('food-name').value || '').trim();
    const dateStr = document.getElementById('food-datetime').value;

    if (!description) {
        safeAlert('Please describe your meal.');
        return;
    }
    if (!dateStr) {
        safeAlert('Please enter date.');
        return;
    }

    const eatenAt = new Date(dateStr);

    const btn = document.getElementById('food-modal-save-btn');
    await withSubmit(btn, async () => {
        let items, failed;
        // The description never leaves the device via /api — it goes
        // straight from the browser to the user's own AI provider
        // (web/domain/foodai.js + web/cloud/js/aiclient.js).
        // Trial path may refuse with trial_consent_required; the
        // TrialConsent seam shows the disclosure dialog and reruns the
        // parse once on Allow (bd med-yor.2 Task 4).
        const parseDescription = () => window.CloudFoodAI.parseMealFromDescription(description, { eatenAt });
        let result;
        try {
            result = (window.TrialConsent && typeof window.TrialConsent.retryAfterConsent === 'function')
                ? await window.TrialConsent.retryAfterConsent(parseDescription)
                : await parseDescription();
        } catch (e) {
            console.error('Food AI parse failed:', e);
            safeToast('Failed to parse meal: ' + (e && e.message ? e.message : e), 'error');
            return;
        }
        items = Array.isArray(result.items) ? result.items : [];
        failed = Math.max(0, Math.trunc(Number(result.failed) || 0));

        await window.DataStore.invalidateTags(['food', 'gamification']);
        if (typeof todayFoodKey === 'function' && window.DataStore.clearCached) {
            await window.DataStore.clearCached(todayFoodKey(new Date()));
        }
        closeFoodModal();
        loadFoodLogs();
        if (typeof loadToday === 'function') loadToday();

        if (items.length && typeof showFoodPhotoSummary === 'function'
            && typeof undoFoodAIItems === 'function') {
            let summaryHandle;
            summaryHandle = showFoodPhotoSummary({
                items,
                failed,
                source: 'description',
                onUndo: () => undoFoodAIItems(items, summaryHandle),
            });
        } else if (items.length) {
            const suffix = failed > 0 ? ` (${failed} failed)` : '';
            safeToast(`Logged ${items.length} item${items.length === 1 ? '' : 's'}${suffix}.`, 'info');
        }
    });
}

function setFoodStatsPeriod(period) {
    if (period !== 'day' && period !== 'week') return;
    window.FoodLog.statsPeriod = period;
    window.FoodLog.macrosRange = period;
    syncFoodMacrosToggleActiveClass();
    loadFoodLogs();
}

async function loadFoodLogs() {
    const list = document.getElementById('food-list');

    await loadFoodTargets();

    const dateFilter = document.getElementById('food-date-filter');
    let dateStr = dateFilter.value;
    if (!dateStr) {
        dateStr = toISODateLocal(new Date());
        dateFilter.value = dateStr;
    }

    const sortButtons = document.querySelectorAll('.fooddb-sort-btn');
    sortButtons.forEach(btn => {
        const isActive = btn.dataset.sort === (window.FoodDB ? window.FoodDB.sort : 'usage');
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });

    // Show cached data immediately (stale-while-revalidate). Cache key
    // mirrors the always-fetch-both shape; the macros toggle reads from
    // the same cache without invalidating it.
    const cacheKey = `food_${dateStr}_v2`;
    const cached = await window.DataStore.getCached(cacheKey);
    if (cached) {
        _renderFoodData(cached.groups, cached.weekStats, window.FoodLog.macrosRange, dateStr);
        renderFoodDayStatus(cached.incomplete === true);
    } else {
        list.replaceChildren(createSkeleton('row', 3));
    }

    updateFoodDateNav();

    const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tzOffset = new Date(`${dateStr}T00:00:00`).getTimezoneOffset();
    const tzParams = tzName
        ? `&tz=${encodeURIComponent(tzName)}`
        : `&tz_offset=${tzOffset}`;

    try {
        let groups = [];
        // apiCall serves /api/food/log from the local vault via the cloud
        // shim (cachedFetch's raw-network path 404s on the account
        // subdomain, so the bot-mode branch was removed).
        const raw = await apiCall(`/api/food/log?date=${dateStr}${tzParams}`, 'GET');
        groups = Array.isArray(raw) ? raw : [];

        const weekStats = await apiCall(`/api/food/stats?date=${dateStr}&days=7${tzParams}`, 'GET');

        const persistedWeekStats = weekStats != null
            ? weekStats
            : (cached && cached.weekStats != null ? cached.weekStats : null);
        // Tag the v2 cache row under the `food` family so `invalidateTags(['food'])`
        // (mutation refresh, change-poll) evicts it alongside `food_<date>_day`.
        // The key already matches the `food_` family prefix registered at boot.
        const incomplete = await fetchFoodDayIncomplete(dateStr, !!(cached && cached.incomplete === true));
        await window.DataStore.setCachedWithTags(cacheKey, { groups: groups || [], weekStats: persistedWeekStats, incomplete }, ['food']);

        _renderFoodData(groups || [], persistedWeekStats, window.FoodLog.macrosRange, dateStr);
        renderFoodDayStatus(incomplete);
    } catch (e) {
        console.error(e);
        if (!cached) {
            list.replaceChildren(createErrorState('Failed to load food logs.', () => loadFoodLogs()));
        }
    }
    await loadFoodIncompleteNudge();
}

// Meal list (kit F1): each meal is a .wg-section — eyebrow "Lunch · 12:42",
// the meal's kcal and a Move button in the head — over a .wg-list of .wg-row
// items. Tap a row to edit; swipe / the overflow menu has Edit and Delete.
function renderFoodMealGroup(group) {
    const groupEl = document.createElement('section');
    groupEl.className = 'wg-section wg-food-meal-group';

    const header = document.createElement('div');
    header.className = 'wg-section__head';

    const title = document.createElement('span');
    title.className = 'wg-eyebrow wg-eyebrow--dot wg-food-meal-group__title';
    title.textContent = `${group.name || 'Meal'}${group.time ? ` · ${group.time}` : ''}`;
    header.appendChild(title);

    const trail = document.createElement('span');
    trail.className = 'wg-hstack';
    const total = document.createElement('span');
    total.className = 'wg-meta wg-food-meal-group__total';
    total.textContent = `${Math.round(group.calories || 0)} kcal`;
    trail.appendChild(total);

    if ((group.logs || []).length) {
        const moveBtn = document.createElement('button');
        moveBtn.type = 'button';
        moveBtn.className = 'wg-btn wg-btn--ghost wg-btn--icon wg-btn--sm wg-food-meal-group__move';
        moveBtn.setAttribute('aria-label', 'Move to another day');
        moveBtn.title = 'Move to another day';
        const ico = document.createElement('i');
        ico.className = 'wg-ico';
        ico.appendChild(window.WGIcons.iconSvg('calendar', { size: 16 }));
        moveBtn.appendChild(ico);
        moveBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            openFoodMoveSheet(group);
        });
        trail.appendChild(moveBtn);
    }
    header.appendChild(trail);
    groupEl.appendChild(header);

    if ((group.logs || []).length) {
        const rows = document.createElement('div');
        rows.className = 'wg-list';
        group.logs.forEach(log => {
            window.FoodLog.setLog(log.id, log);
            rows.appendChild(renderFoodItemRow(log));
        });
        groupEl.appendChild(rows);
    }

    return groupEl;
}

function renderFoodItemRow(log) {
    const item = document.createElement('div');
    item.className = 'wg-row wg-food-item-row';
    item.setAttribute('data-log-id', String(log.id));

    const body = document.createElement('span');
    body.className = 'wg-row__body';

    const name = document.createElement('span');
    name.className = 'wg-row__title';
    if (log.is_meal) {
        const ico = document.createElement('i');
        ico.className = 'wg-ico wg-food-item-row__meal-ico';
        ico.appendChild(window.WGIcons.iconSvg('food', { size: 14 }));
        name.appendChild(ico);
    }
    name.appendChild(document.createTextNode(log.name || 'Food'));
    body.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'wg-row__meta';
    const macros = document.createElement('span');
    macros.textContent = `${Math.round(log.weight || 0)} g · P ${Math.round(log.protein || 0)} · F ${Math.round(log.fat || 0)}`;
    meta.appendChild(macros);
    const syncChip = window.WGChip.sync(log);
    if (syncChip) meta.appendChild(syncChip);
    body.appendChild(meta);
    item.appendChild(body);

    const kcal = document.createElement('span');
    kcal.className = 'wg-row__value wg-row__value--sun';
    kcal.textContent = String(Math.round(log.calories || 0));
    const unit = document.createElement('small');
    unit.textContent = 'kcal';
    kcal.appendChild(unit);
    item.appendChild(kcal);

    const trail = document.createElement('span');
    trail.className = 'wg-row__trail';
    item.appendChild(trail);

    return window.WGRowActions.attach(item, {
        label: log.name || 'Food',
        trail,
        tapEdits: true,
        onEdit: () => editFoodLog(log.id),
        onDelete: () => deleteFoodLog(log.id),
    });
}

// Empty day (kit F3): secondary shortcuts to the fast paths; Add in the app
// bar stays the one primary.
function renderFoodEmptyDay(dateStr) {
    const openAdd = () => {
        showAddFoodModal();
        return document.getElementById('food-name');
    };
    const card = document.createElement('div');
    card.className = 'wg-card wg-card--flush';
    card.appendChild(createEmptyState({
        icon: 'food',
        title: foodRelativeDay(dateStr) === 'Today' ? 'No food logged today' : 'No food logged this day',
        body: 'Snap a photo, scan a barcode or just describe the meal. Totals and macros fill in here.',
        actions: [
            { label: 'Search', icon: 'search', onClick: () => { const n = openAdd(); if (n) n.focus(); } },
            { label: 'Scan', icon: 'barcode', onClick: () => { openAdd(); openFoodScannerModal(); } },
            { label: 'Photo', icon: 'camera', onClick: () => triggerFoodPhotoPicker() },
            {
                label: 'Describe',
                icon: 'sparkle',
                onClick: () => {
                    const n = openAdd();
                    setFoodParseAIMode(true);
                    if (n) n.focus();
                },
            },
        ],
    }));
    return card;
}

function _renderFoodData(groups, weekStats, range, dateStr) {
    const list = document.getElementById('food-list');

    list.replaceChildren();
    let dayCals = 0, dayCarbs = 0, dayProt = 0, dayFat = 0;
    window.FoodLog.setCurrent({});

    if (!groups || groups.length === 0) {
        list.appendChild(renderFoodEmptyDay(dateStr));
    } else {
        groups.forEach(group => {
            dayCals += Number(group.calories) || 0;
            dayCarbs += Number(group.carbs) || 0;
            dayProt += Number(group.protein) || 0;
            dayFat += Number(group.fat) || 0;

            list.appendChild(renderFoodMealGroup(group));
        });
    }

    const isWeek = range === 'week';
    const stats = weekStats || {};
    const targets = window.FoodLog.targets || {};
    const weeklyTargets = {
        calories: (Number(targets.calories) > 0) ? Number(targets.calories) * 7 : 0,
        carbs:    (Number(targets.carbs) > 0)    ? Number(targets.carbs) * 7    : 0,
        protein:  (Number(targets.protein) > 0)  ? Number(targets.protein) * 7  : 0,
        fat:      (Number(targets.fat) > 0)      ? Number(targets.fat) * 7      : 0,
    };

    if (isWeek) {
        renderFoodMacrosCard(
            Math.round(Number(stats.calories) || 0),
            Math.round(Number(stats.carbs) || 0),
            Math.round(Number(stats.protein) || 0),
            Math.round(Number(stats.fat) || 0),
            weeklyTargets,
            { range: 'week' }
        );
    } else {
        renderFoodMacrosCard(
            Math.round(dayCals),
            Math.round(dayCarbs),
            Math.round(dayProt),
            Math.round(dayFat),
            window.FoodLog.targets,
            { range: 'day' }
        );
    }

    syncFoodMacrosToggleActiveClass();

}

// Phase 4, Task 4 — populate the Wandergeek daily macros card. Renders the
// big mono kcal total, the sun-tinted "NN% of target" subtitle, and four
// WGMacroBar rows (Energy / Protein / Carbs / Fat) into the existing
// #food-macros-card shell. Empty-state callers pass zeros; bars collapse
// to 0% rather than being hidden. Missing targets fall back to "—" in the
// bar's target suffix and to "—% of target" in the card header.
function renderFoodMacrosCard(calories, carbs, protein, fat, targets, opts) {
    const card = document.getElementById('food-macros-card');
    if (!card) return;

    const safeTargets = targets || {};
    const targetCalories = Number(safeTargets.calories) > 0 ? Number(safeTargets.calories) : 0;
    const targetCarbs = Number(safeTargets.carbs) > 0 ? Number(safeTargets.carbs) : 0;
    const targetProtein = Number(safeTargets.protein) > 0 ? Number(safeTargets.protein) : 0;
    const targetFat = Number(safeTargets.fat) > 0 ? Number(safeTargets.fat) : 0;

    const safeCalories = Number.isFinite(calories) && calories > 0 ? calories : 0;
    const range = (opts && opts.range) || 'day';

    const kcalEl = document.getElementById('food-macros-card-kcal');
    if (kcalEl) kcalEl.textContent = String(Math.round(safeCalories));

    const noTargets = !(targetCalories || targetCarbs || targetProtein || targetFat);
    const percentBox = document.getElementById('food-macros-card-percent');
    if (percentBox) percentBox.classList.toggle('hidden', noTargets);
    const percentEl = document.getElementById('food-macros-card-percent-value');
    if (percentEl) {
        if (targetCalories > 0) {
            const pct = Math.round((safeCalories / targetCalories) * 100);
            percentEl.textContent = `${pct}%`;
        } else {
            percentEl.textContent = '—';
        }
    }

    const avgEl = document.getElementById('food-macros-card-avg');
    if (avgEl) {
        if (range === 'week' && safeCalories > 0) {
            avgEl.textContent = `avg ${Math.round(safeCalories / 7).toLocaleString()} kcal/day · 7d`;
            avgEl.classList.remove('hidden');
        } else {
            avgEl.textContent = '';
            avgEl.classList.add('hidden');
        }
    }

    const bars = document.getElementById('food-macros-card-bars');
    if (bars) {
        bars.replaceChildren();
        if (noTargets) {
            // Kit F3: no targets → one inline line, not four 0% bars.
            // ponytail: lands on Settings home (Targets is a row there); pushing
            // the Targets page directly needs the Settings bundle loaded first.
            bars.appendChild(createEmptyState({
                icon: 'flag',
                title: 'No daily target set',
                body: 'Set kcal and macro targets to see progress.',
                inline: true,
                actions: [{ label: 'Set targets', onClick: () => switchTab('settings') }],
            }));
        } else if (window.WGMacroBar && typeof window.WGMacroBar.render === 'function') {
            const rows = [
                { label: 'Energy', value: calories, target: targetCalories, unit: 'kcal', variant: 'energy' },
                { label: 'Protein', value: protein, target: targetProtein, unit: 'g', variant: 'protein' },
                { label: 'Carbs', value: carbs, target: targetCarbs, unit: 'g', variant: 'carbs' },
                { label: 'Fat', value: fat, target: targetFat, unit: 'g', variant: 'fat' }
            ];
            rows.forEach(row => bars.appendChild(window.WGMacroBar.render(row)));
        }
    }

    card.classList.remove('hidden');
}

async function loadFoodTargets() {
    const cachedTargets = await window.DataStore.getCached('food_targets');
    if (cachedTargets) {
        window.FoodLog.targets = cachedTargets;
    }

    try {
        const targets = await apiCall('/api/food/settings/targets', 'GET');
        window.FoodLog.targets = {
            calories: targets?.calories || 0,
            carbs: targets?.carbs || 0,
            protein: targets?.protein || 0,
            fat: targets?.fat || 0
        };

        await window.DataStore.setCached('food_targets', window.FoodLog.targets);

        const calsInput = document.getElementById('food-target-calories');
        const carbsInput = document.getElementById('food-target-carbs');
        const protInput = document.getElementById('food-target-protein');
        const fatInput = document.getElementById('food-target-fat');
        if (calsInput) calsInput.value = window.FoodLog.targets.calories || '';
        if (carbsInput) carbsInput.value = window.FoodLog.targets.carbs || '';
        if (protInput) protInput.value = window.FoodLog.targets.protein || '';
        if (fatInput) fatInput.value = window.FoodLog.targets.fat || '';
    } catch (e) {
        console.error('Failed to load food targets:', e);
    }
}

function readFoodTargetsForm() {
    const num = (id) => parseInt(document.getElementById(id).value, 10) || 0;
    return {
        calories: num('food-target-calories'),
        carbs: num('food-target-carbs'),
        protein: num('food-target-protein'),
        fat: num('food-target-fat'),
    };
}

// Optimistic write (Critical Rule #9) on both keys that render food targets:
// 'food_targets' (Food tab) and 'settings_bundle' (Settings — every optimistic
// write reloads the current tab, and applyBundle would otherwise repaint the
// pre-save values). A failed POST rolls both back. Resolves true on success.
// `toast: false` lets the Settings Targets page (one Save for food + Journey
// bands) report once for both; it passes `payload` read before the Journey
// save, whose optimistic tab reload re-fills these inputs from the bundle.
async function saveFoodTargets({ toast = true, payload = readFoodTargetsForm() } = {}) {
    const ds = window.DataStore;
    const handles = [];
    const settle = (op) => Promise.all(handles.map((h) => h[op]()));
    try {
        if (ds && typeof ds.applyOptimistic === 'function') {
            // No tags on food_targets: the registry maps it to tag null, so the
            // invalidateTags below must not evict the row just committed.
            handles.push(await ds.applyOptimistic('food_targets', () => ({ ...payload }), []));
            // settings_bundle keeps its loadSWR tags (features/settings.js).
            handles.push(await ds.applyOptimistic('settings_bundle',
                (prev) => (prev ? { ...prev, foodTargets: { ...payload } } : prev),
                ['settings', 'food_targets', 'feature_settings']));
        }
        const res = await apiCall('/api/food/settings/targets', 'POST', payload);
        if (!res) {
            // apiCall already surfaced the failure; don't stack a second message.
            await settle('rollback');
            return false;
        }
        await settle('commit');
    } catch (e) {
        await settle('rollback');
        console.error('Failed to save food targets:', e);
        safeToast('Failed to save food targets', 'error');
        return false;
    }

    window.FoodLog.targets = payload;
    try {
        // Nourishment scoring reads calorie/protein targets (s.food.GetTargets), so a
        // target change shifts today's HP — evict the gamification rings/journey too.
        await window.DataStore.invalidateTags(['settings', 'food_targets', 'gamification']);
    } catch (e) {
        console.warn('Failed to invalidate caches after saving food targets:', e);
    }
    if (toast) safeToast('Food targets saved', 'info');
    const currentTab = (window.AppStore && typeof window.AppStore.get === 'function' && window.AppStore.get('currentTab'))
        || document.querySelector('.view.active')?.id?.replace(/-view$/, '');
    if (currentTab === 'food') {
        loadFoodLogs();
    }
    return true;
}

// The cached day payloads a food-log delete touches: both day caches (v2 +
// Today's per-day key) for the filtered day and today.
function _foodLogDeleteOptimistic(id) {
    const dateFilter = document.getElementById('food-date-filter');
    const filterDate = dateFilter && dateFilter.value ? dateFilter.value : toISODateLocal(new Date());
    const candidateDays = new Set([filterDate, toISODateLocal(new Date())]);
    const mutator = (prev) => removeOptimisticFoodLog(prev, id);
    const out = [];
    for (const dayStr of candidateDays) {
        const dayKey = typeof todayFoodKey === 'function'
            ? todayFoodKey(new Date(`${dayStr}T00:00:00`))
            : `food_${dayStr}_day`;
        out.push({ key: `food_${dayStr}_v2`, mutator, tags: ['food'] });
        out.push({ key: dayKey, mutator, tags: ['food'] });
    }
    return out;
}

// Delete a food-log row: gone at once, Undo from the toast (kit rule 3).
function deleteFoodLog(id) {
    return deleteWithUndo({
        message: 'Entry deleted',
        optimistic: _foodLogDeleteOptimistic(id),
        remove: () => _deleteFoodLogApi(id),
        replay: { fn: '_deleteFoodLogApi', arg: id },
    });
}

// The server delete. Optimistic: drop the row from the day caches before
// awaiting the DELETE; rollback restores the prior snapshot on failure.
// Resolves true on success.
async function _deleteFoodLogApi(id) {
    const handles = [];
    if (window.DataStore && typeof window.DataStore.applyOptimistic === 'function') {
        for (const o of _foodLogDeleteOptimistic(id)) {
            handles.push(await window.DataStore.applyOptimistic(o.key, o.mutator, o.tags));
        }
    }

    let res;
    try {
        res = await apiCall(`/api/food/log/${id}`, 'DELETE');
    } catch (e) {
        for (const h of handles) { try { await h.rollback(); } catch (_) { /* best-effort */ } }
        throw e;
    }

    if (!res) {
        for (const h of handles) { try { await h.rollback(); } catch (_) { /* best-effort */ } }
        return false;
    }

    for (const h of handles) { try { await h.commit(null); } catch (_) { /* best-effort */ } }
    await window.DataStore.invalidateTags(['food', 'gamification']);
    loadFoodLogs();
    return true;
}

// Filter a single log id out of a cached `{ groups }` payload and recompute
// affected group totals. Groups that empty out are dropped so the renderer
// doesn't show a header with no rows.
function removeOptimisticFoodLog(prev, logId) {
    if (!prev || !Array.isArray(prev.groups)) return prev;
    const numericId = typeof logId === 'string' ? parseInt(logId, 10) : logId;
    const groups = [];
    for (const g of prev.groups) {
        const filtered = (g.logs || []).filter((l) => l && l.id !== numericId && l.id !== logId);
        if (filtered.length === (g.logs || []).length) {
            groups.push(g);
            continue;
        }
        if (filtered.length === 0) continue;
        const next = { ...g, logs: filtered };
        recomputeFoodGroupTotals(next);
        groups.push(next);
    }
    const out = prev.incomplete === true ? { groups, incomplete: true } : { groups };
    if (Object.prototype.hasOwnProperty.call(prev, 'weekStats')) {
        out.weekStats = prev.weekStats;
    }
    return out;
}

// med-don1 — move a meal group's rows (e.g. a late-uploaded photo, all stamped
// "now") to another day. Pre-checks only the newest batch: one photo shares one
// identical eaten_at, so a real meal logged nearby starts unchecked.
function foodLocalTimeHHMM(when) {
    const d = new Date(when);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function openFoodMoveSheet(group) {
    const logs = (group.logs || []).filter((l) => l && l.id != null);
    if (!logs.length) return Promise.resolve(null);
    const newestMs = Math.max(...logs.map((l) => Date.parse(l.eaten_at) || 0));
    const daysAgo = (n) => {
        const d = new Date();
        d.setDate(d.getDate() - n);
        return toISODateLocal(d);
    };

    const content = document.createElement('div');
    content.className = 'wg-food-move';

    const allLabel = document.createElement('label');
    allLabel.className = 'wg-food-move__all';
    const allBox = document.createElement('input');
    allBox.type = 'checkbox';
    allBox.className = 'wg-food-move__all-box';
    allLabel.append(allBox, ' Select all');
    content.appendChild(allLabel);

    const list = document.createElement('div');
    list.className = 'wg-food-move__items';
    const boxes = logs.map((log) => {
        const row = document.createElement('label');
        row.className = 'wg-food-move__item';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'wg-food-move__box';
        box.value = String(log.id);
        box.checked = (Date.parse(log.eaten_at) || 0) === newestMs;
        const text = document.createElement('span');
        text.textContent = `${foodLocalTimeHHMM(log.eaten_at)} · ${log.name || 'Food'} · ${Math.round(log.weight || 0)}g · ${Math.round(log.calories || 0)} kcal`;
        row.append(box, text);
        list.appendChild(row);
        return box;
    });
    content.appendChild(list);

    const chips = document.createElement('div');
    chips.className = 'wg-food-move__days';
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'wg-input wg-food-move__date';
    dateInput.value = daysAgo(1);
    const chipBtns = [[1, 'Yesterday'], [2, '2 days ago']].map(([n, label]) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'wg-gloss wg-food-move__chip';
        chip.dataset.daysAgo = String(n);
        chip.textContent = label;
        chip.addEventListener('click', () => { dateInput.value = daysAgo(n); syncChips(); });
        chips.appendChild(chip);
        return chip;
    });
    const syncChips = () => chipBtns.forEach((c) => {
        c.classList.toggle('wg-gloss--sun', dateInput.value === daysAgo(Number(c.dataset.daysAgo)));
    });
    dateInput.addEventListener('input', syncChips);
    dateInput.addEventListener('change', syncChips);
    chips.appendChild(dateInput);
    content.appendChild(chips);

    const timeInput = document.createElement('input');
    timeInput.type = 'time';
    timeInput.className = 'wg-input wg-food-move__time';
    timeInput.value = foodLocalTimeHHMM(newestMs);
    content.appendChild(timeInput);

    const checkedIds = () => boxes.filter((b) => b.checked).map((b) => b.value);
    let moveBtn = null;
    const syncState = () => {
        allBox.checked = boxes.every((b) => b.checked);
        if (moveBtn) moveBtn.disabled = checkedIds().length === 0;
    };
    allBox.addEventListener('change', () => {
        boxes.forEach((b) => { b.checked = allBox.checked; });
        syncState();
    });
    boxes.forEach((b) => b.addEventListener('change', syncState));

    const result = safeForm('', content, {
        title: 'Move to another day',
        confirmLabel: 'Move',
        collect: () => {
            const ids = checkedIds();
            if (!ids.length || !dateInput.value || !timeInput.value) return null;
            const target = new Date(`${dateInput.value}T${timeInput.value}`);
            if (Number.isNaN(target.getTime())) return null;
            return { ids, eatenAt: target.toISOString() };
        }
    });
    const modal = content.closest('.mt-confirm-modal');
    moveBtn = modal ? modal.querySelector('.mt-confirm-modal__confirm') : null;
    syncChips();
    syncState();

    return result.then((choice) => (choice ? moveFoodLogs(logs, choice.ids, choice.eatenAt) : null));
}

async function moveFoodLogs(groupLogs, ids, eatenAt) {
    const idSet = new Set(ids.map(String));
    const sources = groupLogs.filter((l) => idSet.has(String(l.id)));
    const moved = sources.map((l) => ({ ...l, eaten_at: eatenAt, pending: true }));
    const targetDay = toISODateLocal(new Date(eatenAt));
    const days = new Set(sources.map((l) => toISODateLocal(new Date(l.eaten_at))));
    days.add(targetDay);

    const mutatorFor = (day, includeWeekStats) => (prev) => {
        let next = prev;
        for (const l of moved) next = removeOptimisticFoodLog(next, l.id);
        if (day !== targetDay) return next;
        const group = makeOptimisticFoodGroup(moved[0]);
        group.logs = moved.slice();
        recomputeFoodGroupTotals(group);
        const out = { groups: [...((next && next.groups) || []), group] };
        if (next && next.incomplete === true) out.incomplete = true; // med-0sgs.3: keep the day flag
        if (includeWeekStats || (next && Object.prototype.hasOwnProperty.call(next, 'weekStats'))) {
            out.weekStats = next && next.weekStats != null ? next.weekStats : null;
        }
        return out;
    };

    const handles = [];
    if (window.DataStore && typeof window.DataStore.applyOptimistic === 'function') {
        for (const day of days) {
            const dayKey = typeof todayFoodKey === 'function'
                ? todayFoodKey(new Date(`${day}T00:00:00`))
                : `food_${day}_day`;
            handles.push(await window.DataStore.applyOptimistic(`food_${day}_v2`, mutatorFor(day, true), ['food']));
            handles.push(await window.DataStore.applyOptimistic(dayKey, mutatorFor(day, false), ['food']));
        }
    }
    const rollback = async () => {
        for (const h of handles) { try { await h.rollback(); } catch (_) { /* best-effort */ } }
    };

    let res;
    try {
        res = await apiCall('/api/food/log/move', 'POST', { ids, eaten_at: eatenAt });
    } catch (e) {
        await rollback();
        safeToast(`Failed to move: ${e.message}`, 'error');
        return null;
    }
    if (!res) {
        // apiCall already surfaced the error.
        await rollback();
        return null;
    }

    for (const h of handles) { try { await h.commit(null); } catch (_) { /* best-effort */ } }
    await window.DataStore.invalidateTags(['food', 'gamification']);
    safeToast(`Moved ${ids.length} item${ids.length === 1 ? '' : 's'} to ${formatFoodDateLabel(targetDay)}`);
    loadFoodLogs();
    if (window.AppStore && window.AppStore.get('currentTab') === 'today'
        && typeof window.loadToday === 'function') {
        window.loadToday();
    }
    return res;
}

// med-0sgs.3 — per-day "tracking incomplete" flag (record + routes: med-0sgs.1).
// The toggle flags the selected day; the nudge chip offers to flag a recent
// near-empty day. Flagged days keep their logs; analytics skip them.
const FOOD_NUDGE_DISMISS_KEY = 'wg-food-incomplete-nudge-dismissed';
const FOOD_NUDGE_LOOKBACK_DAYS = 3;
const FOOD_NUDGE_FALLBACK_KCAL = 800;

// A failed or empty read keeps the cached status rather than reading as "complete".
async function fetchFoodDayIncomplete(dateStr, fallback) {
    try {
        const days = await apiCall(`/api/food/days?date=${dateStr}&days=1`, 'GET');
        if (!Array.isArray(days)) return fallback;
        return days.some((d) => d && d.date === dateStr && d.incomplete === true);
    } catch (_) {
        return fallback;
    }
}

function renderFoodDayStatus(incomplete) {
    const toggle = document.getElementById('food-incomplete-toggle');
    if (toggle) toggle.checked = incomplete;
    // A flagged day's totals stay visible but dimmed, with a stale chip (kit F2).
    const excluded = incomplete && window.FoodLog.macrosRange !== 'week';
    const badge = document.getElementById('food-incomplete-badge');
    if (badge) badge.classList.toggle('hidden', !excluded);
    ['food-macros-card-total', 'food-macros-card-bars'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('wg-row--muted', excluded);
    });
}

async function setFoodDayIncomplete(dateStr, incomplete) {
    const dateFilter = document.getElementById('food-date-filter');
    if (dateFilter && dateFilter.value === dateStr) renderFoodDayStatus(incomplete);
    const handle = await window.DataStore.applyOptimistic(
        `food_${dateStr}_v2`, (prev) => (prev ? { ...prev, incomplete } : prev), ['food']);
    let res = null;
    try {
        res = await apiCall(`/api/food/days/${dateStr}`, 'PUT', { incomplete });
    } catch (_) {
        res = null; // apiCall already alerted
    }
    if (!res) {
        await handle.rollback();
        await loadFoodLogs();
        return null;
    }
    await handle.commit(null);
    await window.DataStore.invalidateTags(['food', 'gamification']);
    await loadFoodLogs();
    return res;
}

function readFoodNudgeDismissed() {
    try {
        const parsed = JSON.parse(window.localStorage.getItem(FOOD_NUDGE_DISMISS_KEY) || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function dismissFoodNudge(dateStr) {
    // ponytail: per-viewer convenience only; keep the last 10 dates.
    const next = readFoodNudgeDismissed().filter((d) => d !== dateStr).concat(dateStr).slice(-10);
    try { window.localStorage.setItem(FOOD_NUDGE_DISMISS_KEY, JSON.stringify(next)); } catch (_) { /* best-effort */ }
    const nudge = document.getElementById('food-incomplete-nudge');
    if (nudge) nudge.classList.add('hidden');
}

// The most recent of the last 3 days (today excluded) that is unflagged,
// undismissed, and empty or under 40% of the calorie target (800 kcal with
// no target). Null when none qualifies or the reads fail.
async function findFoodNudgeDay() {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const yStr = toISODateLocal(yesterday);
    const statuses = await apiCall(`/api/food/days?date=${yStr}&days=${FOOD_NUDGE_LOOKBACK_DAYS}`, 'GET');
    if (!Array.isArray(statuses)) return null;

    const target = Number(window.FoodLog.targets && window.FoodLog.targets.calories) || 0;
    const threshold = target > 0 ? target * 0.4 : FOOD_NUDGE_FALLBACK_KCAL;
    const dismissed = new Set(readFoodNudgeDismissed());
    const candidates = statuses
        .filter((s) => s && typeof s.date === 'string' && s.incomplete !== true && !dismissed.has(s.date))
        .sort((a, b) => (a.date < b.date ? 1 : -1));
    for (const s of candidates) {
        // Per-day stats bucket by the account timezone, same as the statuses.
        const stats = await apiCall(`/api/food/stats?date=${s.date}&days=1`, 'GET');
        if (!stats) return null;
        if ((Number(stats.calories) || 0) < threshold) return s.date;
    }
    return null;
}

async function loadFoodIncompleteNudge() {
    const nudge = document.getElementById('food-incomplete-nudge');
    const chip = document.getElementById('food-incomplete-nudge-btn');
    if (!nudge || !chip) return;
    let dateStr = null;
    try {
        dateStr = await findFoodNudgeDay();
    } catch (_) {
        dateStr = null;
    }
    nudge.classList.toggle('hidden', !dateStr);
    if (!dateStr) return;
    nudge.dataset.date = dateStr;
    chip.textContent = `Was ${formatFoodDateLabel(dateStr)} (${formatFoodDateSubtitle(dateStr)}) logged incompletely? Tap to exclude it`;
}

// Click handlers bound once by index.js; the nudge carries its date.
function onFoodNudgeFlag() {
    const nudge = document.getElementById('food-incomplete-nudge');
    const dateStr = nudge && nudge.dataset.date;
    if (!dateStr) return null;
    nudge.classList.add('hidden');
    return setFoodDayIncomplete(dateStr, true);
}

function onFoodNudgeDismiss() {
    const nudge = document.getElementById('food-incomplete-nudge');
    if (nudge && nudge.dataset.date) dismissFoodNudge(nudge.dataset.date);
}

window.FoodLog.setDayIncomplete = setFoodDayIncomplete;
window.FoodLog.load = loadFoodLogs;
window.FoodLog.openMove = openFoodMoveSheet;
window.FoodLog.save = saveFoodLog;
window.FoodLog.delete = deleteFoodLog;
window.FoodLog.openAdd = showAddFoodModal;
window.FoodLog.openEdit = editFoodLog;
window.FoodLog.close = closeFoodModal;
window.FoodLog.computeTotals = computeFoodTotals;
window.FoodLog.calculate = calculateFoodCalories;
window.FoodLog.readTargetsForm = readFoodTargetsForm;

// Back-compat: maintain the legacy `window.loadFoodLogs` / `window.loadFoodTargets`
// / `window.saveFoodTargets` names because the architecture.globals allowlist
// already calls them out as approved cross-file globals.
window.loadFoodTargets = loadFoodTargets;
window.saveFoodTargets = saveFoodTargets;
window.loadFoodLogs = loadFoodLogs;
