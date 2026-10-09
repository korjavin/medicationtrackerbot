// ====================================
// FOOD PRODUCTS — search, autocomplete, CRUD
// ====================================
//
// Owns the food-product catalogue:
//   - the OpenFoodFacts-backed search (via window.CloudFoodSearch)
//   - the in-memory + Dexie-cached product list (foodProductsCache)
//   - the autocomplete datalist (#food-autocomplete-list) and the
//     barcode autofill that feeds the food-log modal
//   - the standalone Edit/Delete product modal (#food-product-modal)
//
// Cross-file coupling: log.js calls renderFoodAutocomplete after the modal
// opens; meals.js + db.js refresh foodProductsCache after writes. The cache
// itself + the inflight-search state live in this file's IIFE; the
// window.FoodProducts namespace exposes accessors so siblings can read
// without touching the closure directly.

(function () {
    // Closure-private state — the rule from Task 1 of the workout split
    // applies here too: no module-level `let foo` in the extracted files.
    let foodProductsCache = [];
    let foodAutoCompleteSuggestions = [];
    let foodSearchTimeout;
    let foodSearchRequestId = 0;
    let lastFoodSearchQueryNormalized = '';
    let foodSearchAbortController = null;

    window.FoodProducts = window.FoodProducts || {};
    Object.defineProperty(window.FoodProducts, 'cache', {
        get: () => foodProductsCache,
        set: (v) => { foodProductsCache = Array.isArray(v) ? v : []; },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(window.FoodProducts, 'suggestions', {
        get: () => foodAutoCompleteSuggestions,
        set: (v) => { foodAutoCompleteSuggestions = Array.isArray(v) ? v : []; },
        enumerable: true,
        configurable: true
    });
    window.FoodProducts._getSearchTimeout = () => foodSearchTimeout;
    window.FoodProducts._setSearchTimeout = (v) => { foodSearchTimeout = v; };
    window.FoodProducts._nextRequestId = () => ++foodSearchRequestId;
    window.FoodProducts._getRequestId = () => foodSearchRequestId;
    window.FoodProducts._getLastQuery = () => lastFoodSearchQueryNormalized;
    window.FoodProducts._setLastQuery = (v) => { lastFoodSearchQueryNormalized = v || ''; };
    window.FoodProducts._getAbortController = () => foodSearchAbortController;
    window.FoodProducts._setAbortController = (v) => { foodSearchAbortController = v || null; };
})();

function normalizeFoodSearchQuery(value) {
    return (value || '').trim().toLowerCase();
}

// Tear down any pending or in-flight food search so its async tail cannot
// render into a UI that has since moved on (the user cleared the input or
// picked a product). Bumping the requestId makes the existing guards in the
// streaming/loadMore callbacks bail; aborting the controller unblocks any
// fetch that hasn't returned yet.
function cancelInFlightFoodSearch() {
    const pendingTimeout = window.FoodProducts._getSearchTimeout();
    if (pendingTimeout !== undefined) {
        clearTimeout(pendingTimeout);
        window.FoodProducts._setSearchTimeout(undefined);
    }
    const prevController = window.FoodProducts._getAbortController();
    if (prevController) prevController.abort();
    window.FoodProducts._setAbortController(null);
    window.FoodProducts._nextRequestId();
}

// runCloudFoodSearch is cloud mode's replacement for the NDJSON stream: local
// results render immediately via web/domain/food.js's search(), and a second
// call (local+remote merged, once web/cloud/js/fooddb.js is wired in Task 5)
// backs the "Load more from OpenFoodFacts" button — feeding the exact same
// render callbacks as the bot-mode fetch path. `barcode`, when set, checks
// for a direct code match first and autofills instead of rendering a list,
// mirroring onFoodBarcodeChange's local/remote match branches.
async function runCloudFoodSearch(query, requestId, { barcode } = {}) {
    let local = [];
    try {
        local = await window.CloudFoodSearch.search(query, { remote: false });
    } catch (e) {
        if (requestId !== window.FoodProducts._getRequestId()) return;
        console.error('Search failed', e);
        setFoodSearchStatus('error', 'Search finished with an error. Please try again.');
        return;
    }
    if (requestId !== window.FoodProducts._getRequestId()) return;

    if (barcode) {
        const match = local.find(p => p.barcode === barcode);
        if (match) {
            document.getElementById('food-name').value = decodeFoodDisplayText(match.name);
            autofillFoodProduct(match);
            setFoodSearchStatus('success', 'Product found and filled in.');
            return;
        }
    }

    const loadMoreCallback = async () => {
        const myRequestId = window.FoodProducts._nextRequestId();

        // No remote food DB (no BYO url in the vault, no operator
        // CLOUD_FOOD_DB_URL) means search() can only ever return the local
        // results we already rendered. Say so instead of silently reporting
        // zero matches — the user typed a query and deserves to know the
        // database is missing, not that their food doesn't exist (med-1j1).
        if (typeof window.CloudFoodSearch.remoteConfigured === 'function'
            && !(await window.CloudFoodSearch.remoteConfigured())) {
            if (myRequestId !== window.FoodProducts._getRequestId()) return;
            renderFoodAutocomplete(local, false, null);
            setFoodSearchStatus('error', 'Food database not configured. Add one in Settings → Integrations.');
            return;
        }

        setFoodSearchStatus('loading', 'Searching OpenFoodFacts...');
        let merged;
        try {
            merged = await window.CloudFoodSearch.search(query, { remote: true });
        } catch (e) {
            if (myRequestId !== window.FoodProducts._getRequestId()) return;
            console.error('Load more failed', e);
            setFoodSearchStatus('success', `Found ${local.length} local result(s). Remote fetch failed.`);
            renderFoodAutocomplete(local, false, null);
            return;
        }
        if (myRequestId !== window.FoodProducts._getRequestId()) return;

        if (barcode) {
            const remoteMatch = merged.find(p => p.barcode === barcode);
            if (remoteMatch) {
                document.getElementById('food-name').value = decodeFoodDisplayText(remoteMatch.name);
                autofillFoodProduct(remoteMatch);
                const list = document.getElementById('food-autocomplete-list');
                if (list) list.classList.add('hidden');
                setFoodSearchStatus('success', 'Product found and filled in.');
                return;
            }
        }

        renderFoodAutocomplete(merged, false, null);
        setFoodSearchStatus('success', `Found ${merged.length} result(s).`);
    };

    renderFoodAutocomplete(local, local.length > 0, local.length > 0 ? loadMoreCallback : null);
    if (local.length > 0) {
        setFoodSearchStatus('success', `Found ${local.length} local result(s).`);
    } else {
        setFoodSearchStatus('empty', 'No local products found.');
        loadMoreCallback();
    }
}

function decodeFoodDisplayText(value) {
    const raw = (value || '').toString();
    if (!raw) return '';

    const textarea = document.createElement('textarea');
    textarea.textContent = raw;
    let decoded = textarea.value.trim();

    if (decoded.includes('%')) {
        try {
            decoded = decodeURIComponent(decoded);
        } catch (e) { }
    }
    return decoded;
}

async function initFoodProductsCache() {
    let cache = null;
    if (window.MedTrackerDB) {
        cache = await window.MedTrackerDB.FoodProductsStore.getCache();
    }
    if (!cache) {
        try {
            // apiCall serves /api/food/products from the vault via the cloud
            // shim (cachedFetch's raw-network path 404s on the account
            // subdomain, so the bot-mode branch was removed).
            const resp = await apiCall('/api/food/products', 'GET');
            const products = resp ? (resp.products || []) : [];
            cache = products;
            if (window.MedTrackerDB && cache.length > 0) {
                await window.MedTrackerDB.FoodProductsStore.saveCache(cache);
            }
        } catch (e) {
            console.error('Failed to load food products', e);
            cache = [];
        }
    }
    window.FoodProducts.cache = cache || [];
}

async function onFoodNameChange() {
    const foodNameInput = document.getElementById('food-name');
    const query = foodNameInput.value;
    const normalizedQuery = normalizeFoodSearchQuery(query);

    // Clear previous selection
    const pidEl = document.getElementById('food-log-product-id');
    if (pidEl) pidEl.value = '';
    const isMealEl = document.getElementById('food-log-is-meal');
    if (isMealEl) isMealEl.value = '';

    const linkContainer = document.getElementById('food-product-link-container');
    if (linkContainer) {
        linkContainer.innerHTML = '';
        linkContainer.classList.add('hidden');
    }

    if (normalizedQuery.length >= 2 && normalizedQuery === window.FoodProducts._getLastQuery()) {
        // The user typed back to the most recently completed query — but a
        // pending debounce from an intermediate keystroke (e.g. `apple` →
        // `banana` → back to `apple` within 800ms) could still fire and
        // render results for the intermediate value over the existing
        // suggestions. Cancel any in-flight work before re-showing.
        cancelInFlightFoodSearch();
        const list = document.getElementById('food-autocomplete-list');
        if (list && window.FoodProducts.suggestions.length > 0) {
            list.classList.remove('hidden');
        }
        return;
    }

    // Check if user selected something from the datalist
    const selected = window.FoodProducts.suggestions.find(p => decodeFoodDisplayText(p.name) === query);
    if (selected) {
        // The user picked a concrete product — any in-flight search is now
        // stale and must not render results on top of the selection. Cancel
        // the pending debounce, abort the in-flight controller, and bump
        // the requestId so async callbacks already past the fetch() bail
        // via the existing guards.
        cancelInFlightFoodSearch();
        autofillFoodProduct(selected);
        setFoodSearchStatus('success', 'Product selected.');
        return;
    }

    if (query.length < 2) {
        // The query is no longer searchable — same hazard as the selection
        // path: a pending debounce or an in-flight fetch tagged with the
        // current requestId would still complete and render stale
        // suggestions into a now-empty input. Cancel before returning.
        cancelInFlightFoodSearch();
        renderFoodAutocomplete(window.FoodProducts.cache);
        window.FoodProducts._setLastQuery('');
        setFoodSearchStatus();
        return;
    }

    // The query changed to a different searchable value — eagerly cancel
    // the prior in-flight fetch (bumps requestId, aborts controller,
    // clears the pending debounce). Without this, an old fetch that
    // completes during the new 800ms debounce window would still pass
    // the requestId guard and render stale results into the autocomplete.
    cancelInFlightFoodSearch();
    window.FoodProducts._setSearchTimeout(setTimeout(async () => {
        const requestId = window.FoodProducts._nextRequestId();
        window.FoodProducts._setLastQuery(normalizedQuery);
        setFoodSearchStatus('loading', 'Searching local database...');

        const prevController = window.FoodProducts._getAbortController();
        if (prevController) prevController.abort();
        const controller = new AbortController();
        window.FoodProducts._setAbortController(controller);

        // There is no /api/food/products/search on the wire (apishim.js
        // intentionally excludes it) — two-phase delivery straight from
        // web/domain/food.js's search() (local, then a local+remote merge)
        // feeds the render callbacks. AbortController state is still tracked
        // above so cancelInFlightFoodSearch() stays a no-op-safe call.
        await runCloudFoodSearch(query, requestId);
        return;
    }, 800));
}

async function onFoodBarcodeChange() {
    const barcode = document.getElementById('food-barcode').value;
    if (barcode.length < 5) {
        // Same hazard as the name-search too-short branch: a pending
        // debounce or in-flight barcode fetch must not autofill the form
        // after the user has cleared the field. Cancel before returning.
        cancelInFlightFoodSearch();
        setFoodSearchStatus();
        return;
    }

    // The barcode changed to a different valid value — eagerly cancel
    // any prior in-flight fetch. Without this, an old fetch that
    // completes during the new 800ms debounce window would still pass
    // the requestId guard and silently autofill the form with the
    // previous barcode's product data while the input shows the new
    // barcode.
    cancelInFlightFoodSearch();
    window.FoodProducts._setSearchTimeout(setTimeout(async () => {
        const requestId = window.FoodProducts._nextRequestId();
        setFoodSearchStatus('loading', 'Searching by barcode...');

        const prevController = window.FoodProducts._getAbortController();
        if (prevController) prevController.abort();
        const controller = new AbortController();
        window.FoodProducts._setAbortController(controller);

        // Same two-phase delivery as onFoodNameChange, with the
        // direct-barcode-match check runCloudFoodSearch performs before
        // falling back to rendering a result list.
        await runCloudFoodSearch(barcode, requestId, { barcode });
        return;
    }, 800));
}

function setFoodSearchStatus(type, message) {
    const status = document.getElementById('food-search-status');
    if (!status) return;

    status.classList.remove('loading', 'success', 'empty', 'error');
    if (!type || !message) {
        status.classList.add('hidden');
        status.textContent = '';
        return;
    }

    status.classList.remove('hidden');
    status.classList.add(type);
    status.textContent = message;
}

function renderFoodAutocomplete(products, showLoadMore = false, loadMoreCallback = null, showList = true) {
    window.FoodProducts.suggestions = products || [];
    const list = document.getElementById('food-autocomplete-list');
    if (!list) return;

    list.replaceChildren();

    if (window.FoodProducts.suggestions.length === 0) {
        list.classList.add('hidden');
        return;
    }

    const closeBtn = document.createElement('div');
    closeBtn.className = 'autocomplete-close';
    const closeSpan = document.createElement('span');
    closeSpan.textContent = '▲ Close';
    closeBtn.appendChild(closeSpan);
    closeBtn.onclick = function (e) {
        e.stopPropagation();
        list.classList.add('hidden');
    };
    list.appendChild(closeBtn);

    const displayList = window.FoodProducts.suggestions.slice(0, 50);

    displayList.forEach(p => {
        const displayName = decodeFoodDisplayText(p.name);
        const item = document.createElement('div');
        item.className = 'autocomplete-item';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'autocomplete-item-name';

        let metaText = '';
        if (p.is_meal) {
            nameSpan.textContent = displayName;
            metaText = 'Meal';
        } else {
            nameSpan.textContent = displayName;
            if (p.barcode) metaText = p.barcode;
        }

        nameSpan.onclick = function () {
            document.getElementById('food-name').value = displayName;
            autofillFoodProduct(p);
            setFoodSearchStatus('success', 'Product selected.');
            list.classList.add('hidden');
        };
        item.appendChild(nameSpan);

        if (metaText) {
            const metaSpan = document.createElement('span');
            metaSpan.className = 'autocomplete-item-meta';
            metaSpan.textContent = metaText;
            metaSpan.onclick = nameSpan.onclick;
            item.appendChild(metaSpan);
        }

        // Bot-mode product ids are positive integers; cloud-mode ids are
        // string recordIds (`foodproduct_…`). Remote food-DB results carry no
        // id. Render edit/delete only for saved local products (mirrors log.js).
        if (p.id && (typeof p.id === 'string' || p.id > 0)) {
            const actions = document.createElement('span');
            actions.className = 'autocomplete-item-actions';

            const editBtn = document.createElement('button');
            editBtn.className = 'autocomplete-action-btn';
            editBtn.textContent = '✎';
            editBtn.title = 'Edit product';
            editBtn.onclick = function (e) {
                e.stopPropagation();
                list.classList.add('hidden');
                showEditFoodProductModal(p);
            };
            actions.appendChild(editBtn);

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'autocomplete-action-btn autocomplete-action-delete';
            deleteBtn.textContent = '✕';
            deleteBtn.title = 'Delete product';
            deleteBtn.onclick = function (e) {
                e.stopPropagation();
                deleteFoodProduct(p.id, displayName);
            };
            actions.appendChild(deleteBtn);

            item.appendChild(actions);
        }

        list.appendChild(item);
    });

    if (showLoadMore && loadMoreCallback) {
        const loadMoreBtn = document.createElement('div');
        loadMoreBtn.className = 'autocomplete-load-more';
        loadMoreBtn.textContent = '... Load more from OpenFoodFacts ...';
        loadMoreBtn.onclick = function (e) {
            e.stopPropagation();
            loadMoreBtn.textContent = 'Loading...';
            loadMoreBtn.classList.add('loading');
            loadMoreCallback();
        };
        list.appendChild(loadMoreBtn);
    }

    if (showList) {
        list.classList.remove('hidden');
    } else {
        list.classList.add('hidden');
    }
}

function onFoodNameFocus() {
    const list = document.getElementById('food-autocomplete-list');
    if (!list) return;
    if (window.FoodProducts.suggestions.length > 0) {
        list.classList.remove('hidden');
    }
}

// Close autocomplete when clicking outside
document.addEventListener("click", function (e) {
    const list = document.getElementById("food-autocomplete-list");
    const input = document.getElementById("food-name");
    if (list && e.target !== input && e.target !== list && !list.contains(e.target)) {
        list.classList.add('hidden');
    }
});

function autofillFoodProduct(product) {
    const displayName = decodeFoodDisplayText(product.name);
    const input = document.getElementById('food-name');
    if (input && input.value !== displayName) {
        input.value = displayName;
    }

    document.getElementById('food-barcode').value = product.barcode || '';

    const pidEl = document.getElementById('food-log-product-id');
    if (pidEl) pidEl.value = product.id || '';
    const isMealEl = document.getElementById('food-log-is-meal');
    if (isMealEl) isMealEl.value = product.is_meal ? 'true' : '';

    setFoodPer100g(true);
    document.getElementById('food-carbs').value = product.carbs_100g;
    document.getElementById('food-protein').value = product.protein_100g;
    document.getElementById('food-fat').value = product.fat_100g;
    document.getElementById('food-calories').value = product.energy_kcal_100g;

    // Only write the weight when the product actually carries one (a meal with
    // a known total). A plain product has no weight to overwrite with, so
    // whatever is already in the field is left alone — clearing it here was
    // pure data loss (med-ejq.1).
    //
    // Picking a meal and then a plain product does leave the meal's weight
    // behind. That is deliberate: it is visible and editable, whereas any
    // scheme for telling "the user typed this" from "we auto-filled this"
    // needs state that outlives the modal and silently wipes a real value
    // whenever it goes stale — the exact bug being fixed.
    const weightInput = document.getElementById('food-weight');
    if (product.is_meal && product.total_weight_g > 0) {
        weightInput.value = product.total_weight_g;
    }

    if (weightInput.value) {
        document.getElementById('food-calories').focus();
    } else {
        weightInput.focus();
    }

    calculateFoodCalories();
}

function showEditFoodProductModal(product) {
    document.getElementById('food-product-id').value = product.id;
    document.getElementById('food-product-name').value = decodeFoodDisplayText(product.name);
    document.getElementById('food-product-barcode').value = product.barcode || '';
    document.getElementById('food-product-carbs').value = product.carbs_100g || '';
    document.getElementById('food-product-protein').value = product.protein_100g || '';
    document.getElementById('food-product-fat').value = product.fat_100g || '';
    document.getElementById('food-product-calories').value = product.energy_kcal_100g || '';

    const isMealInput = document.getElementById('food-product-is-meal');
    if (isMealInput) isMealInput.value = product.is_meal ? 'true' : 'false';

    const weightInput = document.getElementById('food-product-total-weight');
    if (weightInput) weightInput.value = product.total_weight_g || 0;

    window.ModalManager.foodProduct.open();
}

function closeFoodProductModal() {
    window.ModalManager.foodProduct.close();
}

async function saveFoodProduct() {
    const id = document.getElementById('food-product-id').value;
    const name = document.getElementById('food-product-name').value.trim();
    if (!name) {
        safeAlert('Please enter a product name.');
        return;
    }

    const isMealInput = document.getElementById('food-product-is-meal');
    const isMeal = isMealInput ? isMealInput.value === 'true' : false;

    const weightInput = document.getElementById('food-product-total-weight');
    const totalWeight = weightInput ? (parseInt(weightInput.value, 10) || 0) : 0;

    const payload = {
        name: name,
        barcode: document.getElementById('food-product-barcode').value.trim(),
        carbs_100g: Math.round((parseFloat(document.getElementById('food-product-carbs').value) || 0) * 10) / 10,
        protein_100g: Math.round((parseFloat(document.getElementById('food-product-protein').value) || 0) * 10) / 10,
        fat_100g: Math.round((parseFloat(document.getElementById('food-product-fat').value) || 0) * 10) / 10,
        energy_kcal_100g: Math.round(parseFloat(document.getElementById('food-product-calories').value) || 0),
        is_meal: isMeal,
        total_weight_g: totalWeight,
    };

    const btn = document.getElementById('food-product-save-btn');
    await withSubmit(btn, async () => {
        // Optimistic: patch the matching product in the in-memory cache + the
        // `food_products_cache` payload so the row reflects the edit before
        // the PUT resolves. Snapshot for rollback on failure.
        // Bot-mode cache rows carry numeric ids; cloud-mode rows carry string
        // recordIds. Keep numeric strings as numbers to match number-typed
        // cache rows, but leave recordIds intact — parseInt on a recordId
        // yields NaN, which never matches and no-ops the patch (mirrors log.js).
        const patchId = /^\d+$/.test(id) ? parseInt(id, 10) : id;
        const cacheBefore = Array.isArray(window.FoodProducts.cache)
            ? window.FoodProducts.cache.slice()
            : [];
        window.FoodProducts.cache = cacheBefore.map((p) => {
            if (!p || p.id !== patchId) return p;
            return { ...p, ...payload };
        });

        const handle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
            ? await window.DataStore.applyOptimistic('food_products_cache', (prev) => {
                if (!Array.isArray(prev)) return prev;
                return prev.map((p) => (p && p.id === patchId) ? { ...p, ...payload } : p);
            }, ['food'])
            : null;

        let res;
        try {
            res = await apiCall(`/api/food/products/${id}`, 'PUT', payload);
        } catch (e) {
            window.FoodProducts.cache = cacheBefore;
            if (handle) await handle.rollback();
            throw e;
        }

        if (!res) {
            window.FoodProducts.cache = cacheBefore;
            if (handle) await handle.rollback();
            return;
        }
        if (handle) await handle.commit(null);
        closeFoodProductModal();
        window.FoodProducts.cache = [];
        if (window.MedTrackerDB) {
            await window.MedTrackerDB.FoodProductsStore.clearCache();
        }
        await initFoodProductsCache();
        renderFoodAutocomplete(window.FoodProducts.cache, false, null, false);
        safeToast('Product updated.', 'info');
    });
}

async function deleteFoodProduct(id, displayName) {
    await safeConfirm(`Delete "${displayName}" from your food database?`, async (ok) => {
        if (!ok) return;

        try {
            await apiCall(`/api/food/products/${id}`, 'DELETE');
            window.FoodProducts.cache = [];
            if (window.MedTrackerDB) {
                await window.MedTrackerDB.FoodProductsStore.clearCache();
            }
            await initFoodProductsCache();

            const fooddbTab = document.getElementById('food-fooddb-tab');
            if (fooddbTab && fooddbTab.classList.contains('active')) {
                if (typeof loadFoodDB === 'function') loadFoodDB();
            }
        } catch (e) {
            console.error('Failed to delete food product:', e);
            safeToast('Failed to delete product.', 'error');
        }
    });
}

async function navigateToFoodProduct(event, productId) {
    event.preventDefault();
    window.ModalManager.food.close();

    if (!window.FoodProducts.cache || window.FoodProducts.cache.length === 0) {
        await initFoodProductsCache();
    }

    // med-ejq.3: meals and plain products both live in the Food DB pane now,
    // so there is nothing left to branch on — switchFoodTab loads the list.
    if (typeof switchFoodTab === 'function') switchFoodTab('fooddb');
    setTimeout(() => {
        const cache = window.FoodProducts.cache;
        if (cache && cache.length > 0) {
            const item = cache.find(p => p.id === productId);
            if (item) {
                showEditFoodProductModal(item);
            }
        }
    }, 100);
}
