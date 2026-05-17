// ====================================
// FOOD LOG — daily list, edit modal, targets, totals
// ====================================
//
// Owns the daily food log + the macros card + the food-targets state:
//   - GET /api/food/log (via cachedFetch) + /api/food/stats
//   - the .wg-food-meal-group / .wg-food-item-row renderers
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
    let foodMultiSelectMode = false;
    let foodSelectedLogIds = new Set();

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
    Object.defineProperty(window.FoodLog, 'multiSelectMode', {
        get: () => foodMultiSelectMode,
        set: (v) => { foodMultiSelectMode = !!v; },
        enumerable: true,
        configurable: true
    });
    window.FoodLog.getSelectedIds = () => Array.from(foodSelectedLogIds);
    window.FoodLog.hasSelected = (id) => foodSelectedLogIds.has(id);
    window.FoodLog.addSelected = (id) => { foodSelectedLogIds.add(id); };
    window.FoodLog.deleteSelected = (id) => { foodSelectedLogIds.delete(id); };
    window.FoodLog.clearSelected = () => { foodSelectedLogIds.clear(); };
    window.FoodLog.selectedCount = () => foodSelectedLogIds.size;

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

// Threshold past which the food daily-log cache is considered stale. Shared
// by the cachedFetch call (so the helper's isStale flag aligns) and the badge
// renderer (so the warning tone fires at the same age).
const FOOD_LOGS_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

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
    container.querySelectorAll('.wg-food-macros-card__toggle-btn').forEach((btn) => {
        const isActive = btn.dataset.range === window.FoodLog.macrosRange;
        btn.classList.toggle('wg-food-macros-card__toggle-btn--active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
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

function formatFoodDateLabel(dateStr) {
    if (!dateStr) return '';
    const date = new Date(`${dateStr}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const diffTime = date.getTime() - today.getTime();
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === -1) return 'Yesterday';
    if (diffDays === 1) return 'Tomorrow';

    return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatFoodDateSubtitle(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

function updateFoodDateNav() {
    const dateFilter = document.getElementById('food-date-filter');
    const label = document.getElementById('food-date-label');
    const subtitle = document.getElementById('food-date-subtitle');
    const nextBtn = document.getElementById('food-date-next-btn');
    if (!dateFilter || !label || !nextBtn) return;

    const dateStr = dateFilter.value;
    if (!dateStr) return;

    label.textContent = formatFoodDateLabel(dateStr);
    if (subtitle) subtitle.textContent = formatFoodDateSubtitle(dateStr);

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
        const linkText = log.is_meal ? '→ View Meal' : '→ View in Products';
        const link = document.createElement('a');
        link.href = '#';
        link.className = 'food-product-link';
        link.textContent = linkText;
        const productId = log.product_id;
        const isMeal = !!log.is_meal;
        link.addEventListener('click', (event) => {
            event.preventDefault();
            navigateToFoodProduct(event, productId, isMeal);
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

    const payload = {
        eaten_at: new Date(dateStr).toISOString(),
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
        payload.product_id = parseInt(pidEl.value, 10);
    }

    const btn = document.getElementById('food-modal-save-btn');
    await withSubmit(btn, async () => {
        let res;
        if (id) {
            res = await apiCall(`/api/food/log/${id}`, 'PUT', payload);
        } else {
            res = await apiCall('/api/food/log', 'POST', payload);
        }
        if (!res) return;
        // Invalidate the `food` tag so Today's per-day food cache
        // (`food_<date>_day`) is evicted. Without this, loadToday()'s
        // presence check sees the stale cache and skips the refetch,
        // leaving the macros card out of date. loadFoodLogs() writes its
        // own `food_<date>_v2` cache and doesn't touch the Today key.
        await window.DataStore.invalidateTags(['food']);
        // Belt-and-suspenders: the per-day food key is a dynamic-family
        // entry, so it's evicted by the food family-tag registration from
        // CacheKeys.registerAll. Clearing the key directly guarantees the
        // current-day row is gone even if a future refactor reshapes the
        // family prefix — Today's presence check would otherwise see the
        // stale {groups: []} row and skip the refetch.
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

// AI-mode toggle (Plan 2026-05-17, Task 4). The checkbox at the top of the
// food modal swaps the body into "describe your meal" mode: macros / weight /
// barcode / per-100g / calories fields are CSS-hidden via the
// `wg-food-modal--ai-mode` class on the modal root, the food-name label
// reads "Describe your meal", and Save POSTs to /api/food/log/from-description
// instead of /api/food/log. The shared autocomplete handler short-circuits
// when the modal is in AI mode so a long meal description doesn't hit
// /api/food/products/search.
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
        ['food-weight', 'food-barcode', 'food-carbs', 'food-protein', 'food-fat', 'food-calories'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
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

    const payload = {
        description,
        eaten_at: new Date(dateStr).toISOString(),
    };

    const btn = document.getElementById('food-modal-save-btn');
    await withSubmit(btn, async () => {
        let res;
        try {
            res = await fetch('/api/food/log/from-description', {
                method: 'POST',
                headers: window.makeAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(payload),
            });
        } catch (e) {
            console.error('Food AI parse network error:', e);
            safeAlert('Failed to parse meal: ' + (e && e.message ? e.message : e));
            return;
        }

        if (!res.ok) {
            let msg = `HTTP ${res.status}`;
            try { msg = (await res.text()) || msg; } catch (_) { /* keep status fallback */ }
            safeAlert('Failed to parse meal: ' + msg);
            return;
        }

        let data = null;
        try { data = await res.json(); } catch (_) { data = null; }
        const items = (data && Array.isArray(data.items)) ? data.items : [];

        await window.DataStore.invalidateTags(['food']);
        if (typeof todayFoodKey === 'function' && window.DataStore.clearCached) {
            await window.DataStore.clearCached(todayFoodKey(new Date()));
        }
        if (window.DataStore?.advanceCursorSilently) {
            window.DataStore.advanceCursorSilently();
        }

        closeFoodModal();
        loadFoodLogs();
        if (typeof loadToday === 'function') loadToday();

        if (items.length && typeof showFoodPhotoSummary === 'function'
            && typeof undoFoodAIItems === 'function') {
            let summaryHandle;
            summaryHandle = showFoodPhotoSummary({
                items,
                source: 'description',
                onUndo: () => undoFoodAIItems(items, summaryHandle),
            });
        } else if (items.length) {
            safeAlert(`Logged ${items.length} item${items.length === 1 ? '' : 's'}.`);
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

    const weekDisplay = document.getElementById('food-week-display');
    if (weekDisplay) weekDisplay.classList.add('hidden');

    const sortButtons = document.querySelectorAll('.fooddb-sort-btn');
    sortButtons.forEach(btn => {
        const isActive = btn.dataset.sort === (window.FoodDB ? window.FoodDB.sort : 'usage');
        btn.classList.toggle('active', isActive);
        btn.classList.toggle('wg-gloss--sun', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });

    // Show cached data immediately (stale-while-revalidate). Cache key
    // mirrors the always-fetch-both shape; the macros toggle reads from
    // the same cache without invalidating it. The newer cachedFetch path
    // populates `food_<date>_day` (matching the bootstrap apply path) so
    // offline reloads survive even when this v2 cache is empty.
    const cacheKey = `food_${dateStr}_v2`;
    const dayFoodCacheKey = window.CacheKeys.dayFoodKey(dateStr);
    const cached = await window.DataStore.getCached(cacheKey);
    if (cached) {
        _renderFoodData(cached.groups, cached.weekStats, window.FoodLog.macrosRange, dateStr);
    } else {
        const loadingStr = document.createTextNode('Loading...');
        list.replaceChildren(loadingStr);
    }

    updateFoodDateNav();

    const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tzOffset = new Date(`${dateStr}T00:00:00`).getTimezoneOffset();
    const tzParams = tzName
        ? `&tz=${encodeURIComponent(tzName)}`
        : `&tz_offset=${tzOffset}`;

    try {
        let groups = [];
        let groupsMeta = null;
        if (typeof window.cachedFetch === 'function') {
            const groupsResult = await window.cachedFetch(
                dayFoodCacheKey,
                `/api/food/log?date=${dateStr}${tzParams}`,
                {
                    freshAfterMs: 60_000,
                    staleAfterMs: FOOD_LOGS_STALE_AFTER_MS,
                    transform: (raw) => ({ groups: Array.isArray(raw) ? raw : [] })
                }
            );
            groups = (groupsResult?.data && Array.isArray(groupsResult.data.groups))
                ? groupsResult.data.groups
                : [];
            groupsMeta = groupsResult ? {
                fetchedAt: groupsResult.fetchedAt,
                isStale: !!groupsResult.isStale,
                isFromCache: !!groupsResult.isFromCache
            } : null;
        } else {
            const raw = await apiCall(`/api/food/log?date=${dateStr}${tzParams}`, 'GET');
            groups = Array.isArray(raw) ? raw : [];
            groupsMeta = { fetchedAt: Date.now(), isStale: false, isFromCache: false };
        }

        const weekStats = await apiCall(`/api/food/stats?date=${dateStr}&days=7${tzParams}`, 'GET');

        const persistedWeekStats = weekStats != null
            ? weekStats
            : (cached && cached.weekStats != null ? cached.weekStats : null);
        // Tag the v2 cache row under the `food` family so `invalidateTags(['food'])`
        // (mutation refresh, change-poll) evicts it alongside `food_<date>_day`.
        // The key already matches the `food_` family prefix registered at boot.
        await window.DataStore.setCachedWithTags(cacheKey, { groups: groups || [], weekStats: persistedWeekStats }, ['food']);

        window.FoodLog.meta = groupsMeta;
        _renderFoodData(groups || [], persistedWeekStats, window.FoodLog.macrosRange, dateStr);
    } catch (e) {
        if (window.OfflineNoCacheError && e instanceof window.OfflineNoCacheError) {
            if (!cached) {
                const errP = document.createElement('p');
                errP.className = 'error';
                errP.textContent = 'No cached food data — connect to load.';
                list.replaceChildren(errP);
                window.FoodLog.meta = null;
            } else {
                let v2Ts = null;
                try {
                    if (window.MedTrackerDB?.ApiCache?.getWithMeta) {
                        const v2Entry = await window.MedTrackerDB.ApiCache.getWithMeta(`food_${dateStr}_v2`);
                        if (v2Entry && Number.isFinite(v2Entry.timestamp)) v2Ts = v2Entry.timestamp;
                    }
                } catch (_) { /* best-effort cache read */ }
                window.FoodLog.meta = v2Ts !== null
                    ? { fetchedAt: v2Ts, isStale: true, isFromCache: true }
                    : null;
            }
            renderFoodStaleBadge();
            return;
        }
        console.error(e);
        if (!cached) {
            const errP = document.createElement('p');
            errP.className = 'error';
            errP.textContent = 'Failed to load food logs.';
            list.replaceChildren(errP);
        }
    }
}

// Phase 4, Task 5 — meal-grouped item list renderers. The daily log list
// is built from `.wg-food-meal-group` containers: each group has a
// `.wg-section-label` header (meal name + time + trailing mono kcal total)
// followed by `.wg-card` rows per logged item.
function renderFoodMealGroup(group) {
    const groupEl = document.createElement('section');
    groupEl.className = 'wg-food-meal-group';

    const header = document.createElement('div');
    header.className = 'wg-section-label wg-food-meal-group__header';

    const title = document.createElement('span');
    title.className = 'wg-food-meal-group__title';
    const namePart = group.name || 'Meal';
    const timePart = group.time ? ` · ${group.time}` : '';
    title.textContent = `${namePart}${timePart}`;
    header.appendChild(title);

    const total = document.createElement('span');
    total.className = 'wg-mono-display wg-food-meal-group__total';
    total.textContent = `${Math.round(group.calories || 0)} kcal`;
    header.appendChild(total);

    groupEl.appendChild(header);

    const rows = document.createElement('div');
    rows.className = 'wg-food-meal-group__rows';
    (group.logs || []).forEach(log => {
        window.FoodLog.setLog(log.id, log);
        rows.appendChild(renderFoodItemRow(log));
    });
    groupEl.appendChild(rows);

    return groupEl;
}

function renderFoodItemRow(log) {
    const item = document.createElement('div');
    item.className = 'wg-card wg-food-item-row';
    item.setAttribute('data-log-id', String(log.id));
    if (log.isLocal || log.pending) {
        item.classList.add('wg-food-item-row--pending');
    }
    if (log.isRejected || log.errorMessage) {
        item.classList.add('wg-food-item-row--rejected');
    }

    if (window.FoodLog.multiSelectMode) {
        const checkboxDiv = document.createElement('div');
        checkboxDiv.className = 'food-checkbox-wrap wg-food-item-row__checkbox';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'food-checkbox';
        cb.checked = window.FoodLog.hasSelected(log.id);
        cb.addEventListener('click', (e) => {
            e.stopPropagation();
            if (cb.checked) {
                window.FoodLog.addSelected(log.id);
            } else {
                window.FoodLog.deleteSelected(log.id);
            }
            updateFoodSelectUI();
        });
        checkboxDiv.appendChild(cb);
        item.appendChild(checkboxDiv);
        item.addEventListener('click', () => cb.click());
    } else {
        item.addEventListener('click', () => editFoodLog(log.id));
    }

    const body = document.createElement('div');
    body.className = 'wg-food-item-row__body';

    const name = document.createElement('div');
    name.className = 'wg-food-item-row__name';
    name.textContent = log.is_meal ? `🍽 ${log.name || 'Food'}` : (log.name || 'Food');
    body.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'wg-food-item-row__meta';
    const grams = document.createElement('span');
    grams.className = 'wg-food-item-row__grams';
    grams.textContent = `${Math.round(log.weight || 0)}g`;
    meta.appendChild(grams);

    if (log.isRejected || log.errorMessage) {
        meta.appendChild(buildFoodSyncTag('rejected', 'Failed', log.errorMessage));
    } else if (log.isLocal || log.pending) {
        meta.appendChild(buildFoodSyncTag('pending', 'Pending'));
    }

    body.appendChild(meta);
    item.appendChild(body);

    const stats = document.createElement('div');
    stats.className = 'wg-food-item-row__stats';

    const kcal = document.createElement('span');
    kcal.className = 'wg-mono-display wg-food-item-row__kcal';
    kcal.textContent = `${Math.round(log.calories || 0)} kcal`;
    stats.appendChild(kcal);

    const macros = document.createElement('span');
    macros.className = 'wg-food-item-row__macros';
    macros.textContent = `P ${Math.round(log.protein || 0)} / F ${Math.round(log.fat || 0)}`;
    stats.appendChild(macros);

    item.appendChild(stats);

    const actions = document.createElement('div');
    actions.className = 'wg-food-item-row__actions';
    actions.appendChild(buildFoodActionButton('pencil', 'Edit entry', (event) => {
        event.stopPropagation();
        editFoodLog(log.id);
    }));
    actions.appendChild(buildFoodActionButton('trash', 'Delete entry', (event) => {
        event.stopPropagation();
        deleteFoodLog(log.id);
    }));
    item.appendChild(actions);

    return item;
}

function buildFoodSyncTag(kind, label, tooltip) {
    const tag = document.createElement('span');
    tag.className = `wg-tag wg-tag--mono wg-tag--${kind} wg-food-item-row__sync`;
    tag.textContent = label;
    if (tooltip) tag.title = tooltip;
    return tag;
}

function buildFoodActionButton(iconName, ariaLabel, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wg-icon-btn wg-food-item-row__action';
    btn.setAttribute('aria-label', ariaLabel);
    btn.title = ariaLabel;
    btn.setAttribute('data-icon', iconName);

    const gloss = document.createElement('span');
    gloss.className = 'wg-gloss';
    if (window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
        gloss.appendChild(window.WGIcons.iconSvg(iconName, { size: 16 }));
    }
    btn.appendChild(gloss);

    btn.addEventListener('click', onClick);
    return btn;
}

function _renderFoodData(groups, weekStats, range, dateStr) {
    const list = document.getElementById('food-list');
    const summary = document.getElementById('food-summary');

    list.replaceChildren();
    let dayCals = 0, dayCarbs = 0, dayProt = 0, dayFat = 0;
    window.FoodLog.setCurrent({});

    if (!window.FoodLog.multiSelectMode) {
        window.FoodLog.clearSelected();
    }

    if (!groups || groups.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'hint text-center wg-food-meal-list__empty';
        empty.textContent = 'No food logs for this day.';
        list.appendChild(empty);
    } else {
        groups.forEach(group => {
            dayCals += Number(group.calories) || 0;
            dayCarbs += Number(group.carbs) || 0;
            dayProt += Number(group.protein) || 0;
            dayFat += Number(group.fat) || 0;

            list.appendChild(renderFoodMealGroup(group));
        });
    }

    const progress = document.getElementById('food-target-progress');
    if (progress) {
        progress.classList.add('hidden');
        progress.replaceChildren();
    }
    summary.classList.add('hidden');

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

    updateFoodSelectUI();

    renderFoodStaleBadge();
}

// Task 5 of local-first read resilience — paints the wg-stale-badge chip into
// the #food-stale-badge slot using the freshness metadata captured by the
// most recent cachedFetch call (window.FoodLog.meta). The slot is hidden when
// no metadata exists yet OR when the data was just fetched online (avoids
// flashing a "Updated just now" chip on every keystroke-driven re-render).
function renderFoodStaleBadge() {
    const slot = document.getElementById('food-stale-badge');
    if (!slot) return;
    const api = (typeof window !== 'undefined') ? window.WGStaleBadge : null;
    if (!api || typeof api.render !== 'function') {
        slot.replaceChildren();
        slot.classList.add('hidden');
        return;
    }
    const meta = window.FoodLog.meta;
    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
    if (!meta || !Number.isFinite(meta.fetchedAt)) {
        if (!isOnline) {
            const badge = api.render({ fetchedAt: null, isOffline: true });
            slot.replaceChildren(badge);
            slot.classList.remove('hidden');
            return;
        }
        slot.replaceChildren();
        slot.classList.add('hidden');
        return;
    }
    const badge = api.render({
        fetchedAt: meta.fetchedAt,
        isOffline: !isOnline,
        staleAfterMs: FOOD_LOGS_STALE_AFTER_MS,
    });
    slot.replaceChildren(badge);
    slot.classList.remove('hidden');
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
        if (window.WGMacroBar && typeof window.WGMacroBar.render === 'function') {
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

function toggleFoodSelectMode() {
    window.FoodLog.multiSelectMode = !window.FoodLog.multiSelectMode;
    if (!window.FoodLog.multiSelectMode) {
        window.FoodLog.clearSelected();
    }
    loadFoodLogs();
}

function updateFoodSelectUI() {
    let actionBtn = document.getElementById('food-save-meal-floating-btn');
    if (window.FoodLog.multiSelectMode && window.FoodLog.selectedCount() >= 2) {
        if (!actionBtn) {
            actionBtn = document.createElement('button');
            actionBtn.id = 'food-save-meal-floating-btn';
            actionBtn.className = 'btn btn-primary btn-pill food-floating-btn';
            actionBtn.addEventListener('click', openFoodSaveMealModal);

            const foodView = document.getElementById('food-view');
            if (foodView) {
                foodView.appendChild(actionBtn);
            } else {
                document.body.appendChild(actionBtn);
            }
        }
        actionBtn.textContent = `Save as Meal (${window.FoodLog.selectedCount()})`;
        actionBtn.classList.remove('hidden');
    } else {
        if (actionBtn) {
            actionBtn.classList.add('hidden');
        }
    }
}

// Day-view entry point for the multi-select + Save-as-Meal workflow. Phase 4
// replaced the old "Daily Total" summary with the macros card, which removed
// the Select button that lived on the summary. Re-render just the Select
// button into #food-summary on day view so the My Meals creation flow stays
// reachable.
function renderFoodDaySelectControl(summaryEl, hasLogs) {
    summaryEl.replaceChildren();
    if (!hasLogs) {
        summaryEl.classList.add('hidden');
        return;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'food-summary-wrapper';
    const selectBtn = document.createElement('button');
    selectBtn.type = 'button';
    selectBtn.className = 'btn btn-sm btn-secondary food-select-btn';
    if (window.FoodLog.multiSelectMode) {
        selectBtn.classList.replace('btn-secondary', 'btn-primary');
        selectBtn.textContent = 'Cancel';
    } else {
        selectBtn.textContent = '☑ Select';
    }
    selectBtn.addEventListener('click', toggleFoodSelectMode);
    wrapper.appendChild(selectBtn);
    summaryEl.appendChild(wrapper);
    summaryEl.classList.remove('hidden');
}

function renderFoodSummary(summaryEl, label, calories, carbs, protein, fat) {
    summaryEl.replaceChildren();

    const wrapper = document.createElement('div');
    wrapper.className = 'food-summary-wrapper';

    const textGroup = document.createElement('div');
    const text = document.createTextNode(`${label}: ${Math.round(calories)} kcal `);
    const details = document.createElement('span');
    details.className = 'food-summary-details';
    details.textContent = `(C:${Math.round(carbs * 10) / 10} P:${Math.round(protein)} F:${Math.round(fat * 10) / 10})`;
    textGroup.appendChild(text);
    textGroup.appendChild(details);

    wrapper.appendChild(textGroup);

    if (label === 'Daily Total') {
        const selectBtn = document.createElement('button');
        selectBtn.className = 'btn btn-sm btn-secondary food-select-btn';

        if (window.FoodLog.multiSelectMode) {
            selectBtn.classList.replace('btn-secondary', 'btn-primary');
            selectBtn.textContent = 'Cancel';
        } else {
            selectBtn.innerHTML = '&#9745; Select';
        }

        selectBtn.addEventListener('click', toggleFoodSelectMode);
        wrapper.appendChild(selectBtn);
    }

    summaryEl.appendChild(wrapper);
}

function renderFoodTargetProgress(valCals, valCarbs, valProt, valFat, period = 'day') {
    const container = document.getElementById('food-target-progress');
    if (!container) return;

    const targets = [
        { key: 'calories', label: 'Energy', unit: 'kcal', value: valCals, color: '#60a5fa' },
        { key: 'protein', label: 'Protein', unit: 'g', value: valProt, color: '#4ade80' },
        { key: 'carbs', label: 'Carbs', unit: 'g', value: valCarbs, color: '#22d3ee' },
        { key: 'fat', label: 'Fat', unit: 'g', value: valFat, color: '#f59e0b' }
    ];

    const activeTargets = targets.filter(t => (window.FoodLog.targets[t.key] || 0) > 0);
    if (activeTargets.length === 0) {
        container.classList.add('hidden');
        container.replaceChildren();
        return;
    }

    container.classList.remove('hidden');
    container.replaceChildren();
    activeTargets.forEach((t) => {
        let targetValue = window.FoodLog.targets[t.key];
        if (period === 'week') {
            targetValue = targetValue * 7;
        } else if (period === '2weeks') {
            targetValue = targetValue * 14;
        }

        let progress = Math.round((t.value / targetValue) * 100);
        const isExcess = progress > 100;
        const displayProgress = Math.min(100, progress);

        const excessClass = isExcess ? ' excess' : '';
        const bgColor = isExcess ? 'var(--danger-color, #ef4444)' : t.color;

        const row = document.createElement('div');
        row.className = `food-target-row${excessClass}`;

        const topline = document.createElement('div');
        topline.className = 'food-target-topline';

        const name = document.createElement('span');
        name.className = 'food-target-name';
        name.textContent = t.label;

        const values = document.createElement('span');
        values.className = `food-target-values${isExcess ? ' excess-text' : ''}`;
        const displayValue = (t.key === 'calories' || t.key === 'protein') ? Math.round(t.value) : Math.round(t.value * 10) / 10;
        values.textContent = `${displayValue} / ${targetValue} ${t.unit}`;

        topline.appendChild(name);
        topline.appendChild(values);

        const bar = document.createElement('div');
        bar.className = `food-target-bar${excessClass}`;
        const fill = document.createElement('div');
        fill.className = `food-target-fill${excessClass}`;
        fill.style.width = `${displayProgress}%`;
        fill.style.background = bgColor;
        bar.appendChild(fill);

        row.appendChild(topline);
        row.appendChild(bar);
        container.appendChild(row);
    });
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

async function saveFoodTargets() {
    const payload = {
        calories: parseInt(document.getElementById('food-target-calories').value, 10) || 0,
        carbs: parseInt(document.getElementById('food-target-carbs').value, 10) || 0,
        protein: parseInt(document.getElementById('food-target-protein').value, 10) || 0,
        fat: parseInt(document.getElementById('food-target-fat').value, 10) || 0
    };

    try {
        await apiCall('/api/food/settings/targets', 'POST', payload);
        window.FoodLog.targets = payload;
        await window.DataStore.invalidateTags(['settings', 'food_targets']);
        safeAlert('Food targets saved');
        const currentTab = (window.AppStore && typeof window.AppStore.get === 'function' && window.AppStore.get('currentTab'))
            || document.querySelector('.view.active')?.id?.replace(/-view$/, '');
        if (currentTab === 'food') {
            loadFoodLogs();
        }
    } catch (e) {
        console.error('Failed to save food targets:', e);
        safeAlert('Failed to save food targets');
    }
}

async function deleteFoodLog(id) {
    await safeConfirm("Delete this entry?", async (ok) => {
        if (ok) {
            const res = await apiCall(`/api/food/log/${id}`, 'DELETE');
            if (res) loadFoodLogs();
        }
    });
}

window.FoodLog.load = loadFoodLogs;
window.FoodLog.save = saveFoodLog;
window.FoodLog.delete = deleteFoodLog;
window.FoodLog.openAdd = showAddFoodModal;
window.FoodLog.openEdit = editFoodLog;
window.FoodLog.close = closeFoodModal;
window.FoodLog.computeTotals = computeFoodTotals;
window.FoodLog.calculate = calculateFoodCalories;
window.FoodLog.toggleSelectMode = toggleFoodSelectMode;

// Back-compat: maintain the legacy `window.loadFoodLogs` / `window.loadFoodTargets`
// / `window.saveFoodTargets` names because the architecture.globals allowlist
// already calls them out as approved cross-file globals.
window.loadFoodTargets = loadFoodTargets;
window.saveFoodTargets = saveFoodTargets;
window.loadFoodLogs = loadFoodLogs;
