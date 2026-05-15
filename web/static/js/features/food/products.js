// ====================================
// FOOD PRODUCTS — search, autocomplete, CRUD
// ====================================
//
// Owns the food-product catalogue:
//   - the OpenFoodFacts-backed search (streaming /api/food/products/search)
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
            let products = [];
            if (typeof window.cachedFetch === 'function') {
                try {
                    const result = await window.cachedFetch(
                        'food_products_cache',
                        '/api/food/products',
                        {
                            tags: ['food'],
                            freshAfterMs: 60 * 60 * 1000,
                            staleAfterMs: 7 * 24 * 60 * 60 * 1000,
                            transform: (raw) => (raw && Array.isArray(raw.products)) ? raw.products : []
                        }
                    );
                    products = Array.isArray(result?.data) ? result.data : [];
                } catch (cfErr) {
                    if (!(window.OfflineNoCacheError && cfErr instanceof window.OfflineNoCacheError)) {
                        throw cfErr;
                    }
                }
            } else {
                const resp = await apiCall('/api/food/products', 'GET');
                products = resp ? (resp.products || []) : [];
            }
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
        let timeoutId;

        try {
            if (!navigator.onLine) throw new Error("Network request failed");

            timeoutId = setTimeout(() => controller.abort(), 10_000);

            // First pass: local fast search
            const endpoint = `/api/food/products/search?q=${encodeURIComponent(query)}`;
            const headers = window.makeAuthHeaders();
            const res = await fetch(endpoint, { method: "GET", headers, signal: controller.signal });

            if (res.status === 503) throw new Error("Network request failed");
            if (!res.ok) throw new Error("Search failed");
            if (requestId !== window.FoodProducts._getRequestId()) return;

            const reader = res.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer = "";
            let localResults = [];

            while (true) {
                const { done, value } = await reader.read();
                if (value) {
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const results = JSON.parse(line);
                            if (requestId !== window.FoodProducts._getRequestId()) return;
                            localResults = results || [];
                        } catch (e) { console.error("Parse error on stream chunk", e); }
                    }
                }
                if (done) {
                    if (buffer.trim()) {
                        try {
                            const results = JSON.parse(buffer);
                            if (requestId === window.FoodProducts._getRequestId()) {
                                localResults = results || [];
                            }
                        } catch (e) { }
                    }
                    break;
                }
            }

            if (requestId !== window.FoodProducts._getRequestId()) return;

            // Local stream complete — release the 10s search budget. The
            // remote OpenFoodFacts callback below runs separately (and may
            // fire much later via a user click) so it shouldn't share the
            // local-search deadline.
            clearTimeout(timeoutId);
            timeoutId = undefined;

            const unique = [];
            const seen = new Set();
            for (const p of localResults) {
                if (!seen.has(p.name)) {
                    seen.add(p.name);
                    unique.push(p);
                }
            }

            // Define the callback for loading remote OpenFoodFacts. Each
            // invocation claims a fresh (requestId, controller) lifecycle:
            // a sibling search cancellation between the original render and
            // a user click would bump requestId and abort the parent's
            // controller, leaving a captured pair stale and freezing the
            // "Loading..." button. Claiming our own lifecycle here means the
            // click always reaches a real fetch with its own 10s deadline.
            const loadMoreCallback = async () => {
                const prevController = window.FoodProducts._getAbortController();
                if (prevController) prevController.abort();
                const myController = new AbortController();
                window.FoodProducts._setAbortController(myController);
                const myRequestId = window.FoodProducts._nextRequestId();

                setFoodSearchStatus('loading', 'Searching OpenFoodFacts...');
                let remoteTimeoutId;
                try {
                    remoteTimeoutId = setTimeout(() => myController.abort(), 10_000);
                    const remoteEndpoint = `/api/food/products/search?q=${encodeURIComponent(query)}&remote=true`;
                    const remoteRes = await fetch(remoteEndpoint, { method: "GET", headers, signal: myController.signal });
                    if (!remoteRes.ok) throw new Error("Remote search failed");
                    if (myRequestId !== window.FoodProducts._getRequestId()) return;

                    const remoteReader = remoteRes.body.getReader();
                    const remoteDecoder = new TextDecoder("utf-8");
                    let remoteBuffer = "";
                    let remoteResults = [];

                    while (true) {
                        const { done, value } = await remoteReader.read();
                        if (value) {
                            remoteBuffer += remoteDecoder.decode(value, { stream: true });
                            const lines = remoteBuffer.split('\n');
                            remoteBuffer = lines.pop();
                            for (const line of lines) {
                                if (!line.trim()) continue;
                                try {
                                    remoteResults = JSON.parse(line) || [];
                                } catch (e) { }
                            }
                        }
                        if (done) {
                            if (remoteBuffer.trim()) {
                                try {
                                    remoteResults = JSON.parse(remoteBuffer) || [];
                                } catch (e) { }
                            }
                            break;
                        }
                    }

                    if (myRequestId !== window.FoodProducts._getRequestId()) return;

                    // Merge remote on top of local
                    const mergedUnique = [...unique];
                    for (const p of remoteResults) {
                        if (!seen.has(p.name)) {
                            seen.add(p.name);
                            mergedUnique.push(p);
                        }
                    }

                    renderFoodAutocomplete(mergedUnique, false, null);
                    setFoodSearchStatus('success', `Found ${mergedUnique.length} result(s).`);

                } catch (e) {
                    // A new search starting aborts our controller — that is
                    // the user's intent, not a remote failure. The requestId
                    // guard filters that case silently. A 10s deadline firing
                    // surfaces a typed status without console noise. Anything
                    // else is a genuine remote failure.
                    if (myRequestId !== window.FoodProducts._getRequestId()) return;
                    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
                        setFoodSearchStatus('success', `Found ${unique.length} local result(s). Remote search timed out.`);
                        renderFoodAutocomplete(unique, false, null);
                        return;
                    }
                    console.error("Load more failed", e);
                    setFoodSearchStatus('success', `Found ${unique.length} local result(s). Remote fetch failed.`);
                    renderFoodAutocomplete(unique, false, null);
                } finally {
                    if (remoteTimeoutId !== undefined) clearTimeout(remoteTimeoutId);
                }
            };

            renderFoodAutocomplete(unique, navigator.onLine, loadMoreCallback);

            if (unique.length > 0) {
                setFoodSearchStatus('success', `Found ${unique.length} local result(s).`);
            } else {
                setFoodSearchStatus('empty', 'No local products found.');
                loadMoreCallback();
            }

        } catch (e) {
            if (requestId !== window.FoodProducts._getRequestId()) return;
            // Caller-initiated aborts (new search starting) are filtered by
            // the requestId guard above; anything left here is either the
            // 10s timeout firing or an external abort — surface it as a
            // typed status without console noise.
            if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
                setFoodSearchStatus('error', 'Search timed out');
                return;
            }
            console.error('Search failed', e);
            if (e.name === 'TypeError' || e.message.includes('fetch') || e.message === 'Network request failed' || e.message === 'Failed to fetch' || !navigator.onLine) {
                setFoodSearchStatus('empty', 'Search finished: no products found.');
                return;
            }
            setFoodSearchStatus('error', 'Search finished with an error. Please try again.');
        } finally {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
        }
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
        let timeoutId;

        try {
            if (!navigator.onLine) throw new Error("Network request failed");

            timeoutId = setTimeout(() => controller.abort(), 10_000);

            const endpoint = `/api/food/products/search?q=${encodeURIComponent(barcode)}`;
            const headers = window.makeAuthHeaders();
            const res = await fetch(endpoint, { method: "GET", headers, signal: controller.signal });

            if (res.status === 503) throw new Error("Network request failed");
            if (!res.ok) throw new Error("Search failed");
            if (requestId !== window.FoodProducts._getRequestId()) return;

            const reader = res.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer = "";
            let localResults = [];

            while (true) {
                const { done, value } = await reader.read();
                if (value) {
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const results = JSON.parse(line);
                            if (requestId !== window.FoodProducts._getRequestId()) return;
                            localResults = results || [];
                        } catch (e) { console.error("Parse error on stream chunk", e); }
                    }
                }
                if (done) {
                    if (buffer.trim()) {
                        try {
                            const results = JSON.parse(buffer);
                            if (requestId === window.FoodProducts._getRequestId()) {
                                localResults = results || [];
                            }
                        } catch (e) { }
                    }
                    break;
                }
            }

            if (requestId !== window.FoodProducts._getRequestId()) return;

            // Local stream complete — release the 10s budget so the remote
            // OpenFoodFacts callback below can run on its own deadline.
            clearTimeout(timeoutId);
            timeoutId = undefined;

            // Check for direct barcode match first
            const match = localResults.find(p => p.barcode === barcode);
            if (match) {
                document.getElementById('food-name').value = decodeFoodDisplayText(match.name);
                autofillFoodProduct(match);
                setFoodSearchStatus('success', 'Product found and filled in.');
                return;
            }

            const unique = [];
            const seen = new Set();
            for (const p of localResults) {
                if (!seen.has(p.name)) {
                    seen.add(p.name);
                    unique.push(p);
                }
            }

            // Same lifecycle pattern as the name-search loadMoreCallback:
            // claim a fresh (requestId, controller) on each invocation so
            // an intervening cancellation can't strand the "Loading..."
            // button with a stale closure.
            const loadMoreCallback = async () => {
                const prevController = window.FoodProducts._getAbortController();
                if (prevController) prevController.abort();
                const myController = new AbortController();
                window.FoodProducts._setAbortController(myController);
                const myRequestId = window.FoodProducts._nextRequestId();

                setFoodSearchStatus('loading', 'Searching OpenFoodFacts...');
                let remoteTimeoutId;
                try {
                    remoteTimeoutId = setTimeout(() => myController.abort(), 10_000);
                    const remoteEndpoint = `/api/food/products/search?q=${encodeURIComponent(barcode)}&remote=true`;
                    const remoteRes = await fetch(remoteEndpoint, { method: "GET", headers, signal: myController.signal });
                    if (!remoteRes.ok) throw new Error("Remote search failed");
                    if (myRequestId !== window.FoodProducts._getRequestId()) return;

                    const remoteReader = remoteRes.body.getReader();
                    const remoteDecoder = new TextDecoder("utf-8");
                    let remoteBuffer = "";
                    let remoteResults = [];

                    while (true) {
                        const { done, value } = await remoteReader.read();
                        if (value) {
                            remoteBuffer += remoteDecoder.decode(value, { stream: true });
                            const lines = remoteBuffer.split('\n');
                            remoteBuffer = lines.pop();
                            for (const line of lines) {
                                if (!line.trim()) continue;
                                try {
                                    remoteResults = JSON.parse(line) || [];
                                } catch (e) { }
                            }
                        }
                        if (done) {
                            if (remoteBuffer.trim()) {
                                try {
                                    remoteResults = JSON.parse(remoteBuffer) || [];
                                } catch (e) { }
                            }
                            break;
                        }
                    }

                    if (myRequestId !== window.FoodProducts._getRequestId()) return;

                    const remoteMatch = remoteResults.find(p => p.barcode === barcode);
                    if (remoteMatch) {
                        document.getElementById('food-name').value = decodeFoodDisplayText(remoteMatch.name);
                        autofillFoodProduct(remoteMatch);
                        const list = document.getElementById('food-autocomplete-list');
                        if (list) list.classList.add('hidden');
                        setFoodSearchStatus('success', 'Product found and filled in.');
                        return;
                    }

                    const mergedUnique = [...unique];
                    for (const p of remoteResults) {
                        if (!seen.has(p.name)) {
                            seen.add(p.name);
                            mergedUnique.push(p);
                        }
                    }

                    renderFoodAutocomplete(mergedUnique, false, null);
                    setFoodSearchStatus('success', `Found ${mergedUnique.length} result(s).`);

                } catch (e) {
                    // A new barcode search starting aborts our controller —
                    // that is the user's intent, not a remote failure. The
                    // requestId guard filters that case silently. A 10s
                    // deadline firing surfaces a typed status without console
                    // noise.
                    if (myRequestId !== window.FoodProducts._getRequestId()) return;
                    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
                        setFoodSearchStatus('success', `Found ${unique.length} local result(s). Remote search timed out.`);
                        renderFoodAutocomplete(unique, false, null);
                        return;
                    }
                    console.error("Load more failed", e);
                    setFoodSearchStatus('success', `Found ${unique.length} local result(s). Remote fetch failed.`);
                    renderFoodAutocomplete(unique, false, null);
                } finally {
                    if (remoteTimeoutId !== undefined) clearTimeout(remoteTimeoutId);
                }
            };

            renderFoodAutocomplete(unique, navigator.onLine, loadMoreCallback);

            if (unique.length > 0) {
                setFoodSearchStatus('success', `Found ${unique.length} local result(s).`);
            } else {
                setFoodSearchStatus('empty', 'No local products found.');
                loadMoreCallback();
            }

        } catch (e) {
            if (requestId !== window.FoodProducts._getRequestId()) return;
            // Caller-initiated aborts (new search starting) are filtered by
            // the requestId guard above; anything left here is either the
            // 10s timeout firing or an external abort — surface it as a
            // typed status without console noise.
            if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
                setFoodSearchStatus('error', 'Search timed out');
                return;
            }
            console.error('Barcode search failed', e);
            if (e.name === 'TypeError' || e.message.includes('fetch') || e.message === 'Network request failed' || e.message === 'Failed to fetch' || !navigator.onLine) {
                setFoodSearchStatus('empty', 'Search finished: no products found.');
                return;
            }
            setFoodSearchStatus('error', 'Search finished with an error. Please try again.');
        } finally {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
        }
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
            nameSpan.textContent = `🍱 ${displayName}`;
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

        if (p.id && p.id > 0) {
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

    document.getElementById('food-per-100g').checked = true;
    document.getElementById('food-carbs').value = product.carbs_100g;
    document.getElementById('food-protein').value = product.protein_100g;
    document.getElementById('food-fat').value = product.fat_100g;
    document.getElementById('food-calories').value = product.energy_kcal_100g;

    const weightInput = document.getElementById('food-weight');
    if (product.is_meal && product.total_weight_g > 0) {
        weightInput.value = product.total_weight_g;
    } else {
        weightInput.value = '';
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
        const res = await apiCall(`/api/food/products/${id}`, 'PUT', payload);
        if (!res) return;
        closeFoodProductModal();
        window.FoodProducts.cache = [];
        if (window.MedTrackerDB) {
            await window.MedTrackerDB.FoodProductsStore.clearCache();
        }
        await initFoodProductsCache();
        renderFoodAutocomplete(window.FoodProducts.cache, false, null, false);
        safeAlert('Product updated.');
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
            if (fooddbTab && !fooddbTab.classList.contains('hidden')) {
                if (typeof loadFoodDB === 'function') loadFoodDB();
            }
            if (typeof loadMyMeals === 'function') loadMyMeals();
        } catch (e) {
            console.error('Failed to delete food product:', e);
            safeAlert('Failed to delete product.');
        }
    });
}

async function navigateToFoodProduct(event, productId, isMeal) {
    event.preventDefault();
    window.ModalManager.food.close();

    if (!window.FoodProducts.cache || window.FoodProducts.cache.length === 0) {
        await initFoodProductsCache();
    }

    const libView = document.getElementById('food-library-view');
    const libBtn = document.getElementById('food-library-toggle-btn');
    if (libView) libView.classList.remove('hidden');
    if (libBtn) {
        libBtn.setAttribute('aria-expanded', 'true');
        libBtn.classList.add('wg-food-library-entry__btn--open');
    }
    if (isMeal) {
        if (typeof loadMyMeals === 'function') loadMyMeals();
    } else {
        if (typeof loadFoodDB === 'function') loadFoodDB();
    }
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
