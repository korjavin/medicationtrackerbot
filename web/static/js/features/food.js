let foodControlsBound = false;

// Phase 5, Task 4 — outer Food tab strip was removed in favor of an inline
// +Add button in the day-nav and a Daily/Weekly toggle inside the macros
// card. The My Meals + Food DB sections live behind a collapsible library
// entry below the meal list.
const FOOD_MACROS_RANGES = ['day', 'week'];
let foodMacrosRange = 'day';

// Freshness metadata captured from the most recent cachedFetch call for the
// daily food log. Task 5 mounts the badge component on the Food section header
// from this timestamp.
let lastFoodLogsMeta = null;

// Threshold past which the food daily-log cache is considered stale. Shared
// by the cachedFetch call (so the helper's isStale flag aligns) and the badge
// renderer (so the warning tone fires at the same age).
const FOOD_LOGS_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function renderFoodDayNavIcons() {
    const prev = document.getElementById('food-date-prev-btn');
    const next = document.getElementById('food-date-next-btn');
    if (!window.WGIcons || typeof window.WGIcons.iconSvg !== 'function') return;
    if (prev && !prev.querySelector('svg')) {
        prev.replaceChildren(window.WGIcons.iconSvg('chevronLeft'));
    }
    if (next && !next.querySelector('svg')) {
        next.replaceChildren(window.WGIcons.iconSvg('chevronRight'));
    }
}

function renderFoodModalIcons() {
    if (!window.WGIcons || typeof window.WGIcons.iconSvg !== 'function') return;
    const scanBtn = document.getElementById('food-scan-btn');
    if (scanBtn && !scanBtn.querySelector('svg')) {
        const icon = window.WGIcons.iconSvg('barcode', { size: 14 });
        scanBtn.insertBefore(icon, scanBtn.firstChild);
    }
}

function renderFoodInlineAddIcon() {
    if (!window.WGIcons || typeof window.WGIcons.iconSvg !== 'function') return;
    const btn = document.getElementById('add-food-inline-btn');
    if (btn && !btn.querySelector('svg')) {
        btn.insertBefore(window.WGIcons.iconSvg('plus', { size: 14 }), btn.firstChild);
    }
    const photoBtn = document.getElementById('add-food-photo-btn');
    if (photoBtn && !photoBtn.querySelector('svg')) {
        photoBtn.insertBefore(window.WGIcons.iconSvg('camera', { size: 14 }), photoBtn.firstChild);
    }
}

function toggleFoodLibraryView() {
    const view = document.getElementById('food-library-view');
    const btn = document.getElementById('food-library-toggle-btn');
    if (!view || !btn) return;
    const nowVisible = view.classList.toggle('hidden') === false;
    btn.setAttribute('aria-expanded', nowVisible ? 'true' : 'false');
    btn.classList.toggle('wg-food-library-entry__btn--open', nowVisible);
    if (nowVisible) {
        if (typeof loadMyMeals === 'function') loadMyMeals();
        if (typeof loadFoodDB === 'function') loadFoodDB();
    }
}

function setFoodMacrosRange(range) {
    if (FOOD_MACROS_RANGES.indexOf(range) === -1) return;
    foodMacrosRange = range;
    // Keep `currentFoodStatsPeriod` in sync so shiftFoodDate() steps by 7 days
    // in weekly mode and 1 day in daily mode.
    currentFoodStatsPeriod = range;
    syncFoodMacrosToggleActiveClass();
    // Re-pull the weekly data when flipping to 'week' for the first time;
    // loadFoodLogs() is the single source for fetching both daily groups
    // and the weekly stats bundle.
    loadFoodLogs();
}

function syncFoodMacrosToggleActiveClass() {
    const container = document.getElementById('food-macros-toggle');
    if (!container) return;
    container.querySelectorAll('.wg-food-macros-card__toggle-btn').forEach((btn) => {
        const isActive = btn.dataset.range === foodMacrosRange;
        btn.classList.toggle('wg-food-macros-card__toggle-btn--active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
}

function bindFoodControls() {
    if (foodControlsBound) return;
    foodControlsBound = true;

    const bindClick = (id, handler) => {
        const element = document.getElementById(id);
        if (element) element.addEventListener('click', handler);
    };
    const bindChange = (id, handler) => {
        const element = document.getElementById(id);
        if (element) element.addEventListener('change', handler);
    };
    const bindInput = (id, handler) => {
        const element = document.getElementById(id);
        if (element) element.addEventListener('input', handler);
    };
    const bindFocus = (id, handler) => {
        const element = document.getElementById(id);
        if (element) element.addEventListener('focus', handler);
    };

    let foodDBSearchTimeout;
    bindInput('fooddb-search', (e) => {
        clearTimeout(foodDBSearchTimeout);
        foodDBSearchTimeout = setTimeout(() => {
            foodDBQuery = e.target.value.trim();
            foodDBPage = 0;
            loadFoodDB();
        }, 300);
    });

    const sortBtns = document.querySelectorAll('.fooddb-sort-btn');
    sortBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const target = e.currentTarget;
            sortBtns.forEach(b => {
                b.classList.remove('active');
                b.classList.remove('wg-gloss--sun');
                b.setAttribute('aria-pressed', 'false');
            });
            target.classList.add('active');
            target.classList.add('wg-gloss--sun');
            target.setAttribute('aria-pressed', 'true');
            foodDBSort = target.dataset.sort;
            foodDBPage = 0;
            loadFoodDB();
        });
    });

    bindClick('fooddb-prev-btn', () => {
        if (foodDBPage > 0) {
            foodDBPage--;
            loadFoodDB();
        }
    });

    bindClick('fooddb-next-btn', () => {
        const limit = 20;
        if ((foodDBPage + 1) * limit < foodDBTotal) {
            foodDBPage++;
            loadFoodDB();
        }
    });

    bindClick('add-food-inline-btn', () => showAddFoodModal());
    bindClick('add-food-photo-btn', () => triggerFoodPhotoPicker());
    bindChange('food-photo-input', (e) => uploadFoodPhoto(e.target));
    bindClick('food-library-toggle-btn', () => toggleFoodLibraryView());

    const macrosToggle = document.getElementById('food-macros-toggle');
    if (macrosToggle) {
        macrosToggle.querySelectorAll('.wg-food-macros-card__toggle-btn').forEach((btn) => {
            btn.addEventListener('click', () => setFoodMacrosRange(btn.dataset.range));
        });
    }

    bindClick('food-date-prev-btn', () => shiftFoodDate(-1));
    bindClick('food-date-next-btn', () => shiftFoodDate(1));
    bindClick('food-date-label', () => {
        const dateFilter = document.getElementById('food-date-filter');
        if (dateFilter) {
            if (typeof dateFilter.showPicker === 'function') {
                dateFilter.showPicker();
            } else {
                dateFilter.focus();
                dateFilter.click();
            }
        }
    });
    bindChange('food-date-filter', () => loadFoodLogs());

    bindClick('food-modal-cancel-btn', () => closeFoodModal());
    bindClick('food-modal-save-btn', () => saveFoodLog());
    bindInput('food-weight', () => calculateFoodCalories());
    bindInput('food-barcode', () => onFoodBarcodeChange());
    bindClick('food-scan-btn', () => openFoodScannerModal());
    bindInput('food-name', () => onFoodNameChange());
    bindFocus('food-name', () => onFoodNameFocus());
    bindInput('food-carbs', () => calculateFoodCalories());
    bindInput('food-protein', () => calculateFoodCalories());
    bindInput('food-fat', () => calculateFoodCalories());
    bindChange('food-per-100g', () => onFoodPer100gChange());
    bindFocus('food-calories', () => onFoodCaloriesFocus());

    bindClick('food-scanner-use-photo-btn', () => openPhotoPickerAndDecode());
    bindClick('food-scanner-close-btn', () => closeFoodScannerModal());
    bindClick('food-product-cancel-btn', () => closeFoodProductModal());
    bindClick('food-product-save-btn', () => saveFoodProduct());

    bindClick('food-save-meal-cancel-btn', () => closeFoodSaveMealModal());
    bindClick('food-save-meal-confirm-btn', () => confirmSaveMeal());

    renderFoodDayNavIcons();
    renderFoodModalIcons();
    renderFoodInlineAddIcon();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindFoodControls, { once: true });
} else {
    bindFoodControls();
}

// -- Food Intake Autocomplete & Logic --

let foodDBPage = 0;
let foodDBSort = "usage";
let foodDBQuery = "";
let foodDBTotal = 0;

let foodAutoCompleteSuggestions = [];
let foodProductsCache = [];
let foodSearchTimeout;
let foodSearchRequestId = 0;
let lastFoodSearchQueryNormalized = '';
let foodScannerStream = null;
let foodScannerRunning = false;
let foodScanLoopTimer = null;
let foodBarcodeDetector = null;
const FOOD_SCAN_THROTTLE_MS = 200;
const FOOD_NUMERIC_BARCODE_MIN_LEN = 8;

let foodMultiSelectMode = false;
let foodSelectedLogIds = new Set();

function normalizeFoodSearchQuery(value) {
    return (value || '').trim().toLowerCase();
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
    if (window.MedTrackerDB) {
        foodProductsCache = await window.MedTrackerDB.FoodProductsStore.getCache();
    }
    if (!foodProductsCache) {
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
            foodProductsCache = products;
            if (window.MedTrackerDB && foodProductsCache.length > 0) {
                await window.MedTrackerDB.FoodProductsStore.saveCache(foodProductsCache);
            }
        } catch (e) {
            console.error('Failed to load food products', e);
            foodProductsCache = [];
        }
    }
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

    if (normalizedQuery.length >= 2 && normalizedQuery === lastFoodSearchQueryNormalized) {
        const list = document.getElementById('food-autocomplete-list');
        if (list && foodAutoCompleteSuggestions.length > 0) {
            list.classList.remove('hidden');
        }
        return;
    }

    // Check if user selected something from the datalist
    const selected = foodAutoCompleteSuggestions.find(p => decodeFoodDisplayText(p.name) === query);
    if (selected) {
        autofillFoodProduct(selected);
        setFoodSearchStatus('success', 'Product selected.');
        return;
    }

    if (query.length < 2) {
        renderFoodAutocomplete(foodProductsCache);
        lastFoodSearchQueryNormalized = '';
        setFoodSearchStatus();
        return;
    }

    // Debounce search
    clearTimeout(foodSearchTimeout);
    foodSearchTimeout = setTimeout(async () => {
        const requestId = ++foodSearchRequestId;
        lastFoodSearchQueryNormalized = normalizedQuery;
        setFoodSearchStatus('loading', 'Searching local database...');
        try {
            if (!navigator.onLine) throw new Error("Network request failed");

            // First pass: local fast search
            const endpoint = `/api/food/products/search?q=${encodeURIComponent(query)}`;
            const headers = { "X-Telegram-Init-Data": userInitData };
            const res = await fetch(endpoint, { method: "GET", headers });

            if (res.status === 503) throw new Error("Network request failed");
            if (!res.ok) throw new Error("Search failed");
            if (requestId !== foodSearchRequestId) return;

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
                            if (requestId !== foodSearchRequestId) return;
                            localResults = results || [];
                        } catch (e) { console.error("Parse error on stream chunk", e); }
                    }
                }
                if (done) {
                    if (buffer.trim()) {
                        try {
                            const results = JSON.parse(buffer);
                            if (requestId === foodSearchRequestId) {
                                localResults = results || [];
                            }
                        } catch (e) { }
                    }
                    break;
                }
            }

            if (requestId !== foodSearchRequestId) return;

            const unique = [];
            const seen = new Set();
            for (const p of localResults) {
                if (!seen.has(p.name)) {
                    seen.add(p.name);
                    unique.push(p);
                }
            }

            // Define the callback for loading remote OpenFoodFacts
            const loadMoreCallback = async () => {
                if (requestId !== foodSearchRequestId) return;
                setFoodSearchStatus('loading', 'Searching OpenFoodFacts...');
                try {
                    const remoteEndpoint = `/api/food/products/search?q=${encodeURIComponent(query)}&remote=true`;
                    const remoteRes = await fetch(remoteEndpoint, { method: "GET", headers });
                    if (!remoteRes.ok) throw new Error("Remote search failed");
                    if (requestId !== foodSearchRequestId) return;

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

                    if (requestId !== foodSearchRequestId) return;

                    // Merge remote on top of local
                    const mergedUnique = [...unique];
                    for (const p of remoteResults) {
                        if (!seen.has(p.name)) {
                            seen.add(p.name);
                            mergedUnique.push(p);
                        }
                    }

                    renderFoodAutocomplete(mergedUnique, false, null); // Hide load more
                    setFoodSearchStatus('success', `Found ${mergedUnique.length} result(s).`);

                } catch (e) {
                    console.error("Load more failed", e);
                    setFoodSearchStatus('success', `Found ${unique.length} local result(s). Remote fetch failed.`);
                    renderFoodAutocomplete(unique, false, null); // remove loading state
                }
            };

            renderFoodAutocomplete(unique, navigator.onLine, loadMoreCallback);

            if (unique.length > 0) {
                setFoodSearchStatus('success', `Found ${unique.length} local result(s).`);
            } else {
                setFoodSearchStatus('empty', 'No local products found.');
                loadMoreCallback(); // Auto-trigger openfoodfacts fallback if local is empty
            }

        } catch (e) {
            if (requestId !== foodSearchRequestId) return;
            console.error('Search failed', e);
            if (e.name === 'TypeError' || e.message.includes('fetch') || e.message === 'Network request failed' || e.message === 'Failed to fetch' || !navigator.onLine) {
                setFoodSearchStatus('empty', 'Search finished: no products found.');
                return;
            }
            setFoodSearchStatus('error', 'Search finished with an error. Please try again.');
        }
    }, 800);
}

async function onFoodBarcodeChange() {
    const barcode = document.getElementById('food-barcode').value;
    if (barcode.length < 5) {
        setFoodSearchStatus();
        return;
    }

    clearTimeout(foodSearchTimeout);
    foodSearchTimeout = setTimeout(async () => {
        const requestId = ++foodSearchRequestId;
        setFoodSearchStatus('loading', 'Searching by barcode...');
        try {
            if (!navigator.onLine) throw new Error("Network request failed");

            const endpoint = `/api/food/products/search?q=${encodeURIComponent(barcode)}`;
            const headers = { "X-Telegram-Init-Data": window.userInitData };
            const res = await fetch(endpoint, { method: "GET", headers });

            if (res.status === 503) throw new Error("Network request failed");
            if (!res.ok) throw new Error("Search failed");
            if (requestId !== foodSearchRequestId) return;

            const reader = res.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer = "";
            let localResults = [];

            while (true) {
                const { done, value } = await reader.read();
                if (value) {
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop(); // keep incomplete line

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const results = JSON.parse(line);
                            if (requestId !== foodSearchRequestId) return;
                            localResults = results || [];
                        } catch (e) { console.error("Parse error on stream chunk", e); }
                    }
                }
                if (done) {
                    if (buffer.trim()) {
                        try {
                            const results = JSON.parse(buffer);
                            if (requestId === foodSearchRequestId) {
                                localResults = results || [];
                            }
                        } catch (e) { }
                    }
                    break;
                }
            }

            if (requestId !== foodSearchRequestId) return;

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

            // Define the callback for loading remote OpenFoodFacts
            const loadMoreCallback = async () => {
                if (requestId !== foodSearchRequestId) return;
                setFoodSearchStatus('loading', 'Searching OpenFoodFacts...');
                try {
                    const remoteEndpoint = `/api/food/products/search?q=${encodeURIComponent(barcode)}&remote=true`;
                    const remoteRes = await fetch(remoteEndpoint, { method: "GET", headers });
                    if (!remoteRes.ok) throw new Error("Remote search failed");
                    if (requestId !== foodSearchRequestId) return;

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

                    if (requestId !== foodSearchRequestId) return;

                    // Check if remote found a direct match not seen locally
                    const remoteMatch = remoteResults.find(p => p.barcode === barcode);
                    if (remoteMatch) {
                        document.getElementById('food-name').value = decodeFoodDisplayText(remoteMatch.name);
                        autofillFoodProduct(remoteMatch);
                        // Hide autocomplete list totally if we auto-filled from remote
                        const list = document.getElementById('food-autocomplete-list');
                        if (list) list.classList.add('hidden');
                        setFoodSearchStatus('success', 'Product found and filled in.');
                        return;
                    }

                    // Merge remote on top of local
                    const mergedUnique = [...unique];
                    for (const p of remoteResults) {
                        if (!seen.has(p.name)) {
                            seen.add(p.name);
                            mergedUnique.push(p);
                        }
                    }

                    renderFoodAutocomplete(mergedUnique, false, null); // Hide load more
                    setFoodSearchStatus('success', `Found ${mergedUnique.length} result(s).`);

                } catch (e) {
                    console.error("Load more failed", e);
                    setFoodSearchStatus('success', `Found ${unique.length} local result(s). Remote fetch failed.`);
                    renderFoodAutocomplete(unique, false, null); // remove loading state
                }
            };

            renderFoodAutocomplete(unique, navigator.onLine, loadMoreCallback);

            if (unique.length > 0) {
                setFoodSearchStatus('success', `Found ${unique.length} local result(s).`);
            } else {
                setFoodSearchStatus('empty', 'No local products found.');
                loadMoreCallback(); // Auto-fetch OFF if local barcode misses
            }

        } catch (e) {
            if (requestId !== foodSearchRequestId) return;
            console.error('Barcode search failed', e);
            if (e.name === 'TypeError' || e.message.includes('fetch') || e.message === 'Network request failed' || e.message === 'Failed to fetch' || !navigator.onLine) {
                setFoodSearchStatus('empty', 'Search finished: no products found.');
                return;
            }
            setFoodSearchStatus('error', 'Search finished with an error. Please try again.');
        }
    }, 800);
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

function setFoodScannerStatus(message) {
    const status = document.getElementById('food-scanner-status');
    if (status) status.innerText = message;
}

function createFoodBarcodeDetector() {
    if (!window.BarcodeDetector) return null;
    if (foodBarcodeDetector) return foodBarcodeDetector;

    const formats = [
        'qr_code',
        'ean_13',
        'ean_8',
        'upc_a',
        'upc_e',
        'code_128',
        'code_39',
        'itf'
    ];
    try {
        foodBarcodeDetector = new BarcodeDetector({ formats });
    } catch (e) {
        console.error('Failed to create BarcodeDetector with formats, retrying default:', e);
        foodBarcodeDetector = new BarcodeDetector();
    }
    return foodBarcodeDetector;
}

function sanitizeScannedValue(rawValue) {
    if (!rawValue) return { text: '', numeric: '' };
    const text = String(rawValue).replace(/\u200B/g, '').trim();
    const digitsOnly = text.replace(/\D/g, '');
    const numeric = digitsOnly.length >= FOOD_NUMERIC_BARCODE_MIN_LEN ? digitsOnly : '';
    return { text, numeric };
}

function handleDecodedValue(rawValue) {
    const { text, numeric } = sanitizeScannedValue(rawValue);
    if (!text) return false;

    if (numeric) {
        const barcodeInput = document.getElementById('food-barcode');
        barcodeInput.value = numeric;
        onFoodBarcodeChange();
    } else {
        const nameInput = document.getElementById('food-name');
        nameInput.value = text;
        safeAlert('Scanned QR text was added to Food Name.');
    }
    closeFoodScannerModal();
    return true;
}

async function scanFrameLoop() {
    if (!foodScannerRunning) return;

    const video = document.getElementById('food-scanner-video');
    const detector = createFoodBarcodeDetector();
    if (!video || !detector || video.readyState < 2) {
        foodScanLoopTimer = setTimeout(scanFrameLoop, FOOD_SCAN_THROTTLE_MS);
        return;
    }

    try {
        const results = await detector.detect(video);
        if (results && results.length > 0) {
            const first = results.find(r => r && r.rawValue) || results[0];
            if (first && handleDecodedValue(first.rawValue)) return;
        }
    } catch (e) {
        console.error('Food scanner frame decode failed:', e);
    }

    foodScanLoopTimer = setTimeout(scanFrameLoop, FOOD_SCAN_THROTTLE_MS);
}

async function startFoodScanner() {
    const modal = document.getElementById('food-scanner-modal');
    if (!modal) return;

    if (!window.isSecureContext) {
        setFoodScannerStatus('Camera requires HTTPS (or localhost). Use "Use Photo" or manual entry.');
        return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setFoodScannerStatus('Camera is unavailable. Use "Use Photo" or manual entry.');
        return;
    }

    if (!window.BarcodeDetector) {
        setFoodScannerStatus('Live scan is unavailable on this browser. Use "Use Photo".');
        return;
    }

    const video = document.getElementById('food-scanner-video');
    try {
        setFoodScannerStatus('Requesting camera access...');
        foodScannerStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: { ideal: 'environment' } }
        });
        video.srcObject = foodScannerStream;
        await video.play();
        setFoodScannerStatus('Point camera at barcode or QR.');
        foodScannerRunning = true;
        scanFrameLoop();
    } catch (e) {
        console.error('Failed to start food scanner:', e);
        setFoodScannerStatus('Camera access denied or unavailable. Use "Use Photo".');
    }
}

function stopFoodScanner() {
    foodScannerRunning = false;

    if (foodScanLoopTimer) {
        clearTimeout(foodScanLoopTimer);
        foodScanLoopTimer = null;
    }

    const video = document.getElementById('food-scanner-video');
    if (video) {
        video.pause();
        video.srcObject = null;
    }

    if (foodScannerStream) {
        foodScannerStream.getTracks().forEach(track => track.stop());
        foodScannerStream = null;
    }
}

window.addEventListener('pagehide', stopFoodScanner);
window.addEventListener('beforeunload', stopFoodScanner);

function openFoodScannerModal() {
    window.ModalManager.foodScanner.open();
}

function closeFoodScannerModal() {
    window.ModalManager.foodScanner.close();
}

function decodeBarcodeFromImageFallback(image) {
    return new Promise((resolve, reject) => {
        const ZXingGlobal = window.ZXing;
        if (!ZXingGlobal || !ZXingGlobal.BrowserMultiFormatReader) {
            reject(new Error('Fallback decoder is not available.'));
            return;
        }

        const reader = new ZXingGlobal.BrowserMultiFormatReader();
        reader.decodeFromImageElement(image)
            .then(result => {
                reader.reset();
                resolve(result && result.text ? result.text : '');
            })
            .catch(err => {
                reader.reset();
                reject(err);
            });
    });
}

async function decodeFromImageWithDetector(image) {
    const detector = createFoodBarcodeDetector();
    if (!detector) return '';

    const results = await detector.detect(image);
    if (!results || results.length === 0) return '';
    const first = results.find(r => r && r.rawValue) || results[0];
    return first && first.rawValue ? first.rawValue : '';
}

function triggerFoodPhotoPicker() {
    const input = document.getElementById('food-photo-input');
    if (!input) return;
    // Reset value so picking the same file twice still fires `change`.
    input.value = '';
    input.click();
}

// Exposed so other features (e.g. the Today shortcut tile) can open the
// food-photo picker without first navigating to the Food section. The
// picker's hidden <input> and its change handler are bound at app startup
// via bindFoodControls(), so this works on a cold session too.
window.FoodActions = window.FoodActions || {};
window.FoodActions.triggerPhotoPicker = triggerFoodPhotoPicker;

// readFoodPhotoExifDateFromBuffer parses just enough JPEG/EXIF to extract the
// capture timestamp (DateTimeOriginal, tag 0x9003, with optional
// OffsetTimeOriginal tag 0x9011). Falls back to DateTime (0x0132) in IFD0
// when the Exif sub-IFD is missing. Returns a Date or null. Robust to
// non-JPEG inputs, missing EXIF, and malformed offsets.
function readFoodPhotoExifDateFromBuffer(buffer) {
    if (!buffer || buffer.byteLength < 4) return null;
    const view = new DataView(buffer);
    if (view.getUint16(0) !== 0xFFD8) return null; // JPEG SOI

    let offset = 2;
    const max = view.byteLength;
    while (offset + 4 <= max) {
        if (view.getUint8(offset) !== 0xFF) return null;
        const marker = view.getUint8(offset + 1);
        if (marker === 0xDA || marker === 0xD9) return null; // SOS / EOI
        const segLen = view.getUint16(offset + 2);
        if (segLen < 2) return null;
        if (marker === 0xE1 && offset + 4 + 6 <= max) {
            const sig = String.fromCharCode(
                view.getUint8(offset + 4),
                view.getUint8(offset + 5),
                view.getUint8(offset + 6),
                view.getUint8(offset + 7)
            );
            if (sig === 'Exif'
                && view.getUint8(offset + 8) === 0
                && view.getUint8(offset + 9) === 0) {
                return parseFoodPhotoExifTiff(view, offset + 10, segLen - 8);
            }
        }
        offset += 2 + segLen;
    }
    return null;
}

function parseFoodPhotoExifTiff(view, tiffStart, tiffLen) {
    const end = Math.min(tiffStart + tiffLen, view.byteLength);
    if (tiffStart + 8 > end) return null;

    const byteOrder = view.getUint16(tiffStart);
    let little;
    if (byteOrder === 0x4949) little = true;
    else if (byteOrder === 0x4D4D) little = false;
    else return null;

    if (view.getUint16(tiffStart + 2, little) !== 0x002A) return null;

    const ifd0Tags = readFoodPhotoExifIfd(view, tiffStart + view.getUint32(tiffStart + 4, little), end, little);
    if (!ifd0Tags) return null;

    let dateTimeFallback = null;
    if (ifd0Tags[0x0132]) {
        dateTimeFallback = readFoodPhotoExifAscii(view, tiffStart, end, ifd0Tags[0x0132], little);
    }

    let dateTimeOriginal = null;
    let offsetTimeOriginal = null;
    const exifPtr = ifd0Tags[0x8769];
    if (exifPtr) {
        const exifTags = readFoodPhotoExifIfd(view, tiffStart + exifPtr.valueOffset, end, little);
        if (exifTags) {
            if (exifTags[0x9003]) {
                dateTimeOriginal = readFoodPhotoExifAscii(view, tiffStart, end, exifTags[0x9003], little);
            }
            if (exifTags[0x9011]) {
                offsetTimeOriginal = readFoodPhotoExifAscii(view, tiffStart, end, exifTags[0x9011], little);
            }
        }
    }

    return parseFoodPhotoExifDateString(dateTimeOriginal || dateTimeFallback, offsetTimeOriginal);
}

function readFoodPhotoExifIfd(view, ifdOffset, end, little) {
    if (ifdOffset + 2 > end) return null;
    const count = view.getUint16(ifdOffset, little);
    if (ifdOffset + 2 + count * 12 > end) return null;
    const tags = {};
    for (let i = 0; i < count; i++) {
        const e = ifdOffset + 2 + i * 12;
        const tag = view.getUint16(e, little);
        const type = view.getUint16(e + 2, little);
        const cnt = view.getUint32(e + 4, little);
        tags[tag] = {
            type,
            count: cnt,
            valueOffset: view.getUint32(e + 8, little),
            valueFieldAt: e + 8,
        };
    }
    return tags;
}

function readFoodPhotoExifAscii(view, tiffStart, end, entry, little) {
    if (entry.type !== 2 || entry.count === 0) return null;
    const length = entry.count;
    const strStart = length <= 4 ? entry.valueFieldAt : tiffStart + entry.valueOffset;
    if (strStart + length > view.byteLength) return null;
    let s = '';
    for (let i = 0; i < length; i++) {
        const b = view.getUint8(strStart + i);
        if (b === 0) break;
        s += String.fromCharCode(b);
    }
    return s;
}

function parseFoodPhotoExifDateString(s, offsetStr) {
    if (!s) return null;
    const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
    if (!m) return null;
    const [, y, mo, d, h, mi, se] = m;
    let dt;
    if (offsetStr && /^[+-]\d{2}:\d{2}$/.test(offsetStr)) {
        dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${offsetStr}`);
    } else {
        dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se));
    }
    if (Number.isNaN(dt.getTime())) return null;
    const yr = dt.getFullYear();
    if (yr < 1995 || yr > new Date().getFullYear() + 1) return null;
    return dt;
}

async function readFoodPhotoExifDate(file) {
    if (!file || typeof file.arrayBuffer !== 'function') return null;
    try {
        return readFoodPhotoExifDateFromBuffer(await file.arrayBuffer());
    } catch (e) {
        return null;
    }
}

// readFoodPhotoLastModifiedDate is a secondary timestamp source for files that
// lack readable EXIF (HEIC, screenshots, forwarded/edited photos with stripped
// metadata). On iOS Safari, picking from the Photos library sets
// file.lastModified to the original capture time; on other platforms it's the
// filesystem mtime, which is still closer to the truth than "now".
function readFoodPhotoLastModifiedDate(file) {
    if (!file || typeof file.lastModified !== 'number' || !file.lastModified) return null;
    const dt = new Date(file.lastModified);
    if (Number.isNaN(dt.getTime())) return null;
    const yr = dt.getFullYear();
    if (yr < 1995 || yr > new Date().getFullYear() + 1) return null;
    return dt;
}

// resolveFoodPhotoEatenAt picks the eaten_at timestamp for a food photo upload:
// prefer the photo's EXIF DateTimeOriginal, then fall back to the file's
// lastModified time. If the chosen time differs from "now" by more than an
// hour, ask the user whether to use it (yes) or now (no).
async function resolveFoodPhotoEatenAt(file, now = new Date()) {
    const photoTime = (await readFoodPhotoExifDate(file))
        || readFoodPhotoLastModifiedDate(file);
    if (!photoTime) return now;
    const diffMs = Math.abs(photoTime.getTime() - now.getTime());
    if (diffMs <= 60 * 60 * 1000) return photoTime;
    const photoLabel = photoTime.toLocaleString();
    const usePhoto = await safeConfirm(
        `This photo was taken on ${photoLabel}. Use the photo's time? (Cancel = use now)`
    );
    return usePhoto ? photoTime : now;
}

async function uploadFoodPhoto(input) {
    const file = input && input.files && input.files[0];
    if (!file) return;

    if (!file.type || !file.type.startsWith('image/')) {
        safeAlert('Please choose an image file.');
        return;
    }

    const eatenAt = await resolveFoodPhotoEatenAt(file);

    const photoBtn = document.getElementById('add-food-photo-btn');
    const originalLabel = photoBtn ? photoBtn.querySelector('.wg-toolbar-btn__label') : null;
    const restoreLabel = originalLabel ? originalLabel.textContent : 'Photo';

    await withSubmit(photoBtn, async () => {
        if (originalLabel) originalLabel.textContent = 'Analyzing…';

        try {
            const form = new FormData();
            form.append('image', file, file.name || 'food.jpg');
            form.append('eaten_at', eatenAt.toISOString());

            const res = await fetch('/api/food/log/from-photo', {
                method: 'POST',
                headers: { 'X-Telegram-Init-Data': window.userInitData },
                body: form,
            });

            if (!res.ok) {
                const txt = await res.text();
                throw new Error(txt || `HTTP ${res.status}`);
            }

            const data = await res.json().catch(() => null);
            const items = (data && Array.isArray(data.items)) ? data.items : [];

            // Same cache invalidation as saveFoodLog().
            await window.DataStore.invalidateTags(['food']);
            if (typeof todayFoodKey === 'function' && window.DataStore.clearCached) {
                await window.DataStore.clearCached(todayFoodKey(new Date()));
            }
            if (window.DataStore?.advanceCursorSilently) {
                window.DataStore.advanceCursorSilently();
            }

            loadFoodLogs();
            if (typeof loadToday === 'function') loadToday();

            if (typeof showFoodPhotoSummary === 'function' && items.length) {
                let summaryHandle;
                summaryHandle = showFoodPhotoSummary({
                    items,
                    onUndo: () => undoFoodPhotoLog(items, summaryHandle),
                });
            } else {
                // Fall back to a toast-or-alert for the no-items case (e.g. AI
                // parsed nothing but the upload itself succeeded), since there
                // is nothing to undo and the rich card would render empty.
                safeAlert(items.length
                    ? `Logged ${items.length} item${items.length === 1 ? '' : 's'}.`
                    : 'Photo logged.');
            }
        } catch (e) {
            console.error('Food photo upload failed:', e);
            safeAlert('Failed to log food from photo: ' + (e.message || e));
        } finally {
            if (originalLabel) originalLabel.textContent = restoreLabel;
            input.value = '';
        }
    });
}

async function openPhotoPickerAndDecode() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';

    input.onchange = async (event) => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;

        setFoodScannerStatus('Decoding image...');
        try {
            const imageURL = URL.createObjectURL(file);
            const image = new Image();
            image.src = imageURL;
            await image.decode();

            let decoded = '';
            try {
                decoded = await decodeFromImageWithDetector(image);
            } catch (e) {
                console.log('Native image decode failed, using fallback:', e);
            }

            if (!decoded) {
                decoded = await decodeBarcodeFromImageFallback(image);
            }

            URL.revokeObjectURL(imageURL);

            if (!decoded || !handleDecodedValue(decoded)) {
                setFoodScannerStatus('No barcode/QR found in photo. Try another image.');
                safeAlert('No barcode or QR code found in the selected photo.');
            }
        } catch (e) {
            console.error('Failed to decode from photo:', e);
            setFoodScannerStatus('Failed to decode image. Try another photo or manual entry.');
            safeAlert('Could not decode barcode/QR from image.');
        }
    };

    input.click();
}

function renderFoodAutocomplete(products, showLoadMore = false, loadMoreCallback = null, showList = true) {
    foodAutoCompleteSuggestions = products || [];
    const list = document.getElementById('food-autocomplete-list');
    if (!list) return;

    list.replaceChildren();

    if (foodAutoCompleteSuggestions.length === 0) {
        list.classList.add('hidden');
        return;
    }

    // Add a close button at the top
    const closeBtn = document.createElement('div');
    closeBtn.className = 'autocomplete-close';
    const closeSpan = document.createElement('span');
    closeSpan.textContent = '▲ Close';
    closeBtn.appendChild(closeSpan);
    closeBtn.onclick = function (e) {
        e.stopPropagation(); // prevent document click listener
        list.classList.add('hidden');
    };
    list.appendChild(closeBtn);

    // Limit datalist options so browser doesn't choke
    const displayList = foodAutoCompleteSuggestions.slice(0, 50);

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

        // Show edit/delete buttons only for user's own food products (id > 0)
        if (p.id && p.id > 0) {
            const actions = document.createElement('span');
            actions.className = 'autocomplete-item-actions';

            const editBtn = document.createElement('button');
            editBtn.className = 'autocomplete-action-btn';
            editBtn.textContent = '✎'; // pencil
            editBtn.title = 'Edit product';
            editBtn.onclick = function (e) {
                e.stopPropagation();
                list.classList.add('hidden');
                showEditFoodProductModal(p);
            };
            actions.appendChild(editBtn);

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'autocomplete-action-btn autocomplete-action-delete';
            deleteBtn.textContent = '✕'; // x mark
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
    if (foodAutoCompleteSuggestions.length > 0) {
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

    // Check per 100g to auto-fill macros directly
    document.getElementById('food-per-100g').checked = true;
    document.getElementById('food-carbs').value = product.carbs_100g;
    document.getElementById('food-protein').value = product.protein_100g;
    document.getElementById('food-fat').value = product.fat_100g;
    document.getElementById('food-calories').value = product.energy_kcal_100g;

    // Auto-fill weight if it's a meal
    const weightInput = document.getElementById('food-weight');
    if (product.is_meal && product.total_weight_g > 0) {
        weightInput.value = product.total_weight_g;
    } else {
        weightInput.value = '';
    }

    // Focus weight input (or calories if weight is already filled)
    if (weightInput.value) {
        document.getElementById('food-calories').focus();
    } else {
        weightInput.focus();
    }

    calculateFoodCalories();
}

// -- Food Product Management --

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
        // Refresh the cache
        foodProductsCache = null;
        if (window.MedTrackerDB) {
            await window.MedTrackerDB.FoodProductsStore.clearCache();
        }
        await initFoodProductsCache();
        renderFoodAutocomplete(foodProductsCache, false, null, false);
        safeAlert('Product updated.');
    });
}

async function deleteFoodProduct(id, displayName) {
    await safeConfirm(`Delete "${displayName}" from your food database?`, async (ok) => {
        if (!ok) return;

        try {
            await apiCall(`/api/food/products/${id}`, 'DELETE');
            // Refresh the cache
            foodProductsCache = null;
            if (window.MedTrackerDB) {
                await window.MedTrackerDB.FoodProductsStore.clearCache();
            }
            await initFoodProductsCache();

            // Refresh UI based on context
            const fooddbTab = document.getElementById('food-fooddb-tab');
            if (fooddbTab && !fooddbTab.classList.contains('hidden')) {
                loadFoodDB();
            }
            if (typeof loadMyMeals === 'function') loadMyMeals();
        } catch (e) {
            console.error('Failed to delete food product:', e);
            safeAlert('Failed to delete product.');
        }
    });
}

// -- Food Intake Functions --

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
    // Prototype uses "20.04.2026" (DD.MM.YYYY) for the day-nav subtitle.
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

    const period = currentFoodStatsPeriod || 'day';
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

    // Set default date/time
    document.getElementById('food-datetime').value = formatDateTimeLocalForInput();

    // Clear inputs
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
    document.getElementById('food-weight').focus();

    if (!foodProductsCache || foodProductsCache.length === 0) {
        initFoodProductsCache().then(() => renderFoodAutocomplete(foodProductsCache, false, null, false));
    } else {
        renderFoodAutocomplete(foodProductsCache, false, null, false);
    }
}

function editFoodLog(id) {
    const log = currentFoodLogs[id];
    if (!log) return;

    window.ModalManager.food.open();
    document.getElementById('food-modal-title').innerText = 'Edit entry';

    document.getElementById('food-id').value = log.id;
    const pidEl = document.getElementById('food-log-product-id');
    if (pidEl) pidEl.value = log.product_id || '';
    const isMealEl = document.getElementById('food-log-is-meal');
    if (isMealEl) isMealEl.value = log.is_meal ? 'true' : '';
    document.getElementById('food-name').value = log.name || '';
    document.getElementById('food-barcode').value = log.barcode || '';
    document.getElementById('food-weight').value = log.weight || '';

    if (log.weight > 0) {
        // Convert stored totals back to per-100g for display
        document.getElementById('food-per-100g').checked = true;
        document.getElementById('food-carbs').value = +((log.carbs / log.weight) * 100).toFixed(1);
        document.getElementById('food-protein').value = +((log.protein / log.weight) * 100).toFixed(1);
        document.getElementById('food-fat').value = +((log.fat / log.weight) * 100).toFixed(1);
        calculateFoodCalories();
    } else {
        // No weight stored, show raw totals as-is
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

async function navigateToFoodProduct(event, productId, isMeal) {
    event.preventDefault();
    window.ModalManager.food.close();

    // Ensure cache is populated before trying to find the item
    if (!foodProductsCache || foodProductsCache.length === 0) {
        await initFoodProductsCache();
    }

    // The outer Food tab strip was removed in Phase 5, Task 4. Expose
    // My Meals + Food DB via the collapsible library view and open the
    // relevant edit modal once the lists have loaded.
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
        if (foodProductsCache && foodProductsCache.length > 0) {
            const item = foodProductsCache.find(p => p.id === productId);
            if (item) {
                showEditFoodProductModal(item);
            }
        }
    }, 100);
}

function closeFoodModal() {
    window.ModalManager.food.close();
}

async function saveFoodLog() {
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
        per_100g: false  // values are converted to totals before sending
    };

    const pidEl = document.getElementById('food-log-product-id');
    if (pidEl && pidEl.value) {
        payload.product_id = parseInt(pidEl.value, 10);
    }

    const id = document.getElementById('food-id').value;

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
        // Today shortcut path: the visible tab is 'today' while the food
        // modal is open, and loadFoodLogs() reads the hidden Food screen's
        // date filter (not necessarily the saved date). Refresh Today so
        // the dashboard macros reflect the new log for today's date.
        if (window.AppStore && window.AppStore.get('currentTab') === 'today'
            && typeof window.loadToday === 'function') {
            window.loadToday();
        }
    });
}

// Phase 5, Task 4 — the meal list is always daily; only the macros card
// flips between daily and weekly totals. `currentFoodStatsPeriod` is kept
// for backward compatibility with callers that still expect a
// day/week-style period getter (tests, older helpers), and mirrors
// `foodMacrosRange` so the two stay in sync.
let currentFoodStatsPeriod = 'day';

function setFoodStatsPeriod(period) {
    if (period !== 'day' && period !== 'week') return;
    currentFoodStatsPeriod = period;
    foodMacrosRange = period;
    syncFoodMacrosToggleActiveClass();
    loadFoodLogs();
}

async function loadFoodLogs() {
    const list = document.getElementById('food-list');

    // Ensure targets are available even if Settings tab hasn't been opened yet.
    await loadFoodTargets();

    const dateFilter = document.getElementById('food-date-filter');
    let dateStr = dateFilter.value;
    if (!dateStr) {
        dateStr = toISODateLocal(new Date());
        dateFilter.value = dateStr;
    }

    const weekDisplay = document.getElementById('food-week-display');
    if (weekDisplay) weekDisplay.classList.add('hidden');

    // Highlight active sort button
    const sortButtons = document.querySelectorAll('.fooddb-sort-btn');
    sortButtons.forEach(btn => {
        const isActive = btn.dataset.sort === foodDBSort;
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
        _renderFoodData(cached.groups, cached.weekStats, foodMacrosRange, dateStr);
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
            // Local-first read: route /api/food/log through cachedFetch so the
            // bootstrap-warmed `food_<date>_day` cache is reused offline. The
            // helper also propagates `fetchedAt` + `isStale` to power the
            // section freshness badge (Task 4 / Task 5).
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

        // weekStats can be null when /api/food/stats fails (offline / 5xx). Fall
        // back to whatever was previously cached so a successful daily-log read
        // doesn't blank out the macros card on every offline reload.
        const persistedWeekStats = weekStats != null
            ? weekStats
            : (cached && cached.weekStats != null ? cached.weekStats : null);
        // Tag the v2 cache row under the `food` family so `invalidateTags(['food'])`
        // (mutation refresh, change-poll) evicts it alongside `food_<date>_day`.
        // The key already matches the `food_` family prefix registered at boot.
        await window.DataStore.setCachedWithTags(cacheKey, { groups: groups || [], weekStats: persistedWeekStats }, ['food']);

        lastFoodLogsMeta = groupsMeta;
        _renderFoodData(groups || [], persistedWeekStats, foodMacrosRange, dateStr);
    } catch (e) {
        if (window.OfflineNoCacheError && e instanceof window.OfflineNoCacheError) {
            // No `food_<date>_day` cache and the network is unreachable.
            // If the legacy v2 cache already rendered groups for this date,
            // keep that render — wiping it for an "offline · no cache" message
            // would be a regression for users upgrading from a session that
            // pre-dates the cachedFetch wiring.
            if (!cached) {
                const errP = document.createElement('p');
                errP.className = 'error';
                errP.textContent = 'No cached food data — connect to load.';
                list.replaceChildren(errP);
                lastFoodLogsMeta = null;
            } else {
                // v2 cache rendered above — surface its timestamp so the badge
                // shows "Offline · Xh old" instead of falsely claiming "no cache"
                // while real data is on screen.
                let v2Ts = null;
                try {
                    if (window.MedTrackerDB?.ApiCache?.getWithMeta) {
                        const v2Entry = await window.MedTrackerDB.ApiCache.getWithMeta(`food_${dateStr}_v2`);
                        if (v2Entry && Number.isFinite(v2Entry.timestamp)) v2Ts = v2Entry.timestamp;
                    }
                } catch (_) { /* best-effort cache read */ }
                lastFoodLogsMeta = v2Ts !== null
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
// followed by `.wg-card` rows per logged item (name/grams on the left,
// sun-tinted kcal + mono P/F on the right, icon-button cluster trailing).
// Offline-pending / rejected logs get `.wg-tag--mono` badges next to the
// meta line, mirroring the BP Phase 3 pattern.
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
        currentFoodLogs[log.id] = log;
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

    if (foodMultiSelectMode) {
        const checkboxDiv = document.createElement('div');
        checkboxDiv.className = 'food-checkbox-wrap wg-food-item-row__checkbox';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'food-checkbox';
        cb.checked = foodSelectedLogIds.has(log.id);
        cb.addEventListener('click', (e) => {
            e.stopPropagation();
            if (cb.checked) {
                foodSelectedLogIds.add(log.id);
            } else {
                foodSelectedLogIds.delete(log.id);
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
    currentFoodLogs = {};

    if (!foodMultiSelectMode) {
        foodSelectedLogIds.clear();
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
    const targets = foodTargets || {};
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
            foodTargets,
            { range: 'day' }
        );
    }

    syncFoodMacrosToggleActiveClass();

    updateFoodSelectUI();

    renderFoodStaleBadge();
}

// Task 5 of local-first read resilience — paints the wg-stale-badge chip into
// the #food-stale-badge slot using the freshness metadata captured by the
// most recent cachedFetch call (lastFoodLogsMeta). The slot is hidden when
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
    const meta = lastFoodLogsMeta;
    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
    if (!meta || !Number.isFinite(meta.fetchedAt)) {
        // Cold-start offline: no cache hit AND no fresh fetch — surface the
        // explicit "Offline · no cache" tone so the user knows we have nothing.
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
    // Tone uses raw navigator-offline only — passing the same staleAfterMs the
    // helper used keeps the warning class aligned with cachedFetch's isStale
    // signal so an online + 5xx fallback to >24h cache still flips warning
    // (without mislabeling it as "Offline · 25h old").
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
//
// Phase 5, Task 4 — opts { range: 'day' | 'week' } controls the avg-per-day
// subtitle below the kcal total; values/targets for weekly mode are passed
// pre-scaled by the caller so this function stays range-agnostic at the
// bar-rendering level.
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
    foodMultiSelectMode = !foodMultiSelectMode;
    if (!foodMultiSelectMode) {
        foodSelectedLogIds.clear();
    }
    loadFoodLogs();
}

function updateFoodSelectUI() {
    let actionBtn = document.getElementById('food-save-meal-floating-btn');
    if (foodMultiSelectMode && foodSelectedLogIds.size >= 2) {
        if (!actionBtn) {
            actionBtn = document.createElement('button');
            actionBtn.id = 'food-save-meal-floating-btn';
            actionBtn.className = 'btn btn-primary btn-pill food-floating-btn';
            actionBtn.addEventListener('click', openFoodSaveMealModal);

            // Append to food-view instead of document.body so it is automatically hidden when switching tabs
            const foodView = document.getElementById('food-view');
            if (foodView) {
                foodView.appendChild(actionBtn);
            } else {
                document.body.appendChild(actionBtn); // fallback
            }
        }
        actionBtn.textContent = `Save as Meal (${foodSelectedLogIds.size})`;
        actionBtn.classList.remove('hidden');
    } else {
        if (actionBtn) {
            actionBtn.classList.add('hidden');
        }
    }
}

function openFoodSaveMealModal() {
    const defaultName = `Meal ${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;
    document.getElementById('food-save-meal-name').value = defaultName;
    window.ModalManager.open('food-save-meal-modal');
    document.getElementById('food-save-meal-name').focus();
}

function closeFoodSaveMealModal() {
    window.ModalManager.close('food-save-meal-modal');
}

async function confirmSaveMeal() {
    const name = document.getElementById('food-save-meal-name').value.trim();
    if (!name) {
        safeAlert('Please enter a meal name.');
        return;
    }

    const payload = {
        name: name,
        log_ids: Array.from(foodSelectedLogIds)
    };

    const btn = document.getElementById('food-save-meal-confirm-btn');
    await withSubmit(btn, async () => {
        try {
            await apiCall('/api/food/products/from-logs', 'POST', payload);
            if (window.SyncManager && window.SyncManager.showToast) {
                window.SyncManager.showToast('Meal saved successfully!', 'success');
            }
            closeFoodSaveMealModal();
            toggleFoodSelectMode();

            // Refresh products cache
            foodProductsCache = null;
            if (window.MedTrackerDB) {
                await window.MedTrackerDB.FoodProductsStore.clearCache();
            }
            await initFoodProductsCache();
            if (typeof loadMyMeals === 'function') loadMyMeals();
        } catch (e) {
            console.error('Failed to save meal:', e);
            safeAlert('Failed to save meal.');
        }
    });
}

async function loadMyMeals() {
    const list = document.getElementById('food-meals-list');
    if (!list) return;

    if (!foodProductsCache || foodProductsCache.length === 0) {
        await initFoodProductsCache();
    }

    if (!foodProductsCache) return;

    const meals = foodProductsCache.filter(p => p.is_meal);

    list.replaceChildren();

    if (meals.length === 0) {
        const p = document.createElement('p');
        p.className = 'wg-food-db-panel__empty';
        p.textContent = 'You haven\'t created any meals yet.';
        list.appendChild(p);
        return;
    }

    meals.forEach(meal => {
        const card = document.createElement('div');
        card.className = 'wg-card wg-food-db-card';

        const mainRow = document.createElement('div');
        mainRow.className = 'food-meal-header';

        const info = document.createElement('div');
        info.className = 'food-meal-info';

        const name = document.createElement('div');
        name.className = 'food-meal-name';
        name.textContent = decodeFoodDisplayText(meal.name);
        info.appendChild(name);
        mainRow.appendChild(info);

        const actions = document.createElement('div');
        actions.className = 'food-meal-actions';

        const editBtn = createEditButton(() => showEditFoodProductModal(meal));

        const deleteBtn = createDeleteButton(async () => {
            const displayName = decodeFoodDisplayText(meal.name);
            await safeConfirm(`Delete the meal "${displayName}"?`, async (ok) => {
                if (ok) {
                    try {
                        await apiCall(`/api/food/products/${meal.id}`, 'DELETE');
                        foodProductsCache = null;
                        if (window.MedTrackerDB) {
                            await window.MedTrackerDB.FoodProductsStore.clearCache();
                        }
                        await initFoodProductsCache();
                        if (typeof loadMyMeals === 'function') loadMyMeals();
                    } catch (e) {
                        safeAlert('Failed to delete meal');
                    }
                }
            });
        });
        actions.appendChild(editBtn);
        actions.appendChild(deleteBtn);
        mainRow.appendChild(actions);

        card.appendChild(mainRow);

        let totalCals = 0, totalCarbs = 0, totalProt = 0, totalFat = 0;
        if (meal.total_weight_g && meal.total_weight_g > 0) {
            const mult = meal.total_weight_g / 100.0;
            totalCals = Math.round((meal.energy_kcal_100g || 0) * mult);
            totalCarbs = Math.round((meal.carbs_100g || 0) * mult * 10) / 10;
            totalProt = Math.round((meal.protein_100g || 0) * mult * 10) / 10;
            totalFat = Math.round((meal.fat_100g || 0) * mult * 10) / 10;
        } else {
            totalCals = Math.round(meal.energy_kcal_100g || 0);
            totalCarbs = Math.round((meal.carbs_100g || 0) * 10) / 10;
            totalProt = Math.round((meal.protein_100g || 0) * 10) / 10;
            totalFat = Math.round((meal.fat_100g || 0) * 10) / 10;
        }

        const nutritionRow = document.createElement('div');
        nutritionRow.className = 'food-nutrition-row';
        nutritionRow.innerHTML = `
            <span><strong>${Math.round(totalCals)}</strong> kcal</span>
            <span>C: <strong>${totalCarbs}</strong>g</span>
            <span>P: <strong>${totalProt}</strong>g</span>
            <span>F: <strong>${totalFat}</strong>g</span>
        `;
        card.appendChild(nutritionRow);

        // Intentionally removing the duplicate actionsRow with Edit button
        // because we moved both Edit and Delete to the top row.

        list.appendChild(card);
    });
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
    if (foodMultiSelectMode) {
        selectBtn.classList.replace('btn-secondary', 'btn-primary');
        selectBtn.textContent = 'Cancel';
    } else {
        selectBtn.textContent = '\u2611 Select';
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

        if (foodMultiSelectMode) {
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

    const activeTargets = targets.filter(t => (foodTargets[t.key] || 0) > 0);
    if (activeTargets.length === 0) {
        container.classList.add('hidden');
        container.replaceChildren();
        return;
    }

    container.classList.remove('hidden');
    container.replaceChildren();
    activeTargets.forEach((t) => {
        let targetValue = foodTargets[t.key];
        if (period === 'week') {
            targetValue = targetValue * 7;
        } else if (period === '2weeks') {
            targetValue = targetValue * 14;
        }

        let progress = Math.round((t.value / targetValue) * 100);
        const isExcess = progress > 100;
        const displayProgress = Math.min(100, progress); // Cap the visual bar at 100%

        const excessClass = isExcess ? ' excess' : '';
        const bgColor = isExcess ? 'var(--danger-color, #ef4444)' : t.color; // Red if excess

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
    // Show cached targets immediately so food rendering isn't blocked on network
    const cachedTargets = await window.DataStore.getCached('food_targets');
    if (cachedTargets) {
        foodTargets = cachedTargets;
    }

    try {
        const targets = await apiCall('/api/food/settings/targets', 'GET');
        foodTargets = {
            calories: targets?.calories || 0,
            carbs: targets?.carbs || 0,
            protein: targets?.protein || 0,
            fat: targets?.fat || 0
        };

        await window.DataStore.setCached('food_targets', foodTargets);

        const calsInput = document.getElementById('food-target-calories');
        const carbsInput = document.getElementById('food-target-carbs');
        const protInput = document.getElementById('food-target-protein');
        const fatInput = document.getElementById('food-target-fat');
        if (calsInput) calsInput.value = foodTargets.calories || '';
        if (carbsInput) carbsInput.value = foodTargets.carbs || '';
        if (protInput) protInput.value = foodTargets.protein || '';
        if (fatInput) fatInput.value = foodTargets.fat || '';
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
        foodTargets = payload;
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

// Undo handler for the friendly food-photo summary card. Issues a parallel
// DELETE for every just-logged item, refreshes the food list + Today, then
// transitions the card to a "Removed N items" success state. On partial
// failure the card flips to its retry-able error state, and Retry only
// re-attempts the items that haven't already been deleted — otherwise the
// store's "no rows" 500 for already-deleted ids would lock the user in
// permanent error after a single successful round.
async function undoFoodPhotoLog(items, summary, originalCount) {
    if (!Array.isArray(items) || items.length === 0) return;
    const total = (typeof originalCount === 'number') ? originalCount : items.length;

    const results = await Promise.all(items.map(async (it) => {
        if (!it || !it.id) return { item: it, ok: false };
        try {
            const res = await fetch(`/api/food/log/${it.id}`, {
                method: 'DELETE',
                headers: { 'X-Telegram-Init-Data': window.userInitData },
            });
            return { item: it, ok: !!(res && res.ok) };
        } catch (_) {
            return { item: it, ok: false };
        }
    }));

    const allOk = results.every(r => r.ok);
    const anyOk = results.some(r => r.ok);

    // Refresh whenever at least one delete succeeded — partial failure still
    // mutates the server, so the UI must reflect the new state or stale rows
    // (already gone from the DB) will linger until the next manual refresh.
    if (anyOk) {
        try {
            await window.DataStore.invalidateTags(['food']);
            if (typeof todayFoodKey === 'function' && window.DataStore.clearCached) {
                await window.DataStore.clearCached(todayFoodKey(new Date()));
            }
            if (window.DataStore?.advanceCursorSilently) {
                window.DataStore.advanceCursorSilently();
            }
        } catch (e) {
            console.error('Food photo undo cache invalidation failed:', e);
        }
        loadFoodLogs();
        if (typeof loadToday === 'function') loadToday();
    }

    if (!allOk) {
        const remaining = results.filter(r => !r.ok).map(r => r.item);
        if (summary && typeof summary.showError === 'function') {
            summary.showError(
                'Could not undo all items. Tap retry to try again.',
                () => undoFoodPhotoLog(remaining, summary, total),
            );
        }
        return;
    }

    if (summary && typeof summary.showRemoved === 'function') {
        summary.showRemoved(total);
    }
}


// -- Food DB --

async function loadFoodDB() {
    const list = document.getElementById('fooddb-list');
    list.innerHTML = '<p class="wg-food-db-panel__empty">Loading products...</p>';

    const limit = 20;
    const offset = foodDBPage * limit;

    try {
        const queryParams = new URLSearchParams({
            is_meal: 'false',
            limit: limit.toString(),
            offset: offset.toString(),
            sort: foodDBSort,
        });
        if (foodDBQuery) {
            queryParams.append('q', foodDBQuery);
        }

        const resp = await apiCall(`/api/food/products?${queryParams.toString()}`, 'GET');
        if (!resp) return;

        foodDBTotal = resp.total || 0;

        // If we are on a page > 0 and the total results dropped below what would be on this page, clamp page and reload
        if (foodDBPage > 0 && foodDBPage * limit >= foodDBTotal) {
            foodDBPage = Math.max(0, Math.ceil(foodDBTotal / limit) - 1);
            loadFoodDB();
            return;
        }

        renderFoodDBList(resp.products || [], foodDBTotal);
    } catch (e) {
        console.error('Failed to load food db products', e);
        list.innerHTML = '<p class="wg-food-db-panel__empty wg-food-db-panel__empty--error">Failed to load products</p>';
    }
}

function renderFoodDBList(products, total) {
    const list = document.getElementById('fooddb-list');
    const pagination = document.getElementById('fooddb-pagination');
    const pageInfo = document.getElementById('fooddb-page-info');
    const prevBtn = document.getElementById('fooddb-prev-btn');
    const nextBtn = document.getElementById('fooddb-next-btn');

    list.innerHTML = '';

    if (products.length === 0) {
        list.innerHTML = '<p class="wg-food-db-panel__empty">No products found.</p>';
        pagination.classList.toggle('hidden', total <= 0);
        pageInfo.textContent = `Showing 0 of ${total}`;
        prevBtn.disabled = foodDBPage === 0;
        nextBtn.disabled = true;
        return;
    }

    products.forEach(p => {
        const card = document.createElement('div');
        card.className = 'wg-card wg-food-db-card';
        card.onclick = (e) => {
            if (e.target.tagName !== 'BUTTON') {
                autofillFoodProduct(p);
            }
        };

        const topRow = document.createElement('div');
        topRow.className = 'food-db-actions-row';

        const info = document.createElement('div');
        info.className = 'food-db-info';

        const name = document.createElement('div');
        name.className = 'food-db-name';
        name.textContent = decodeFoodDisplayText(p.name);
        info.appendChild(name);

        const macros = document.createElement('div');
        macros.className = 'food-db-macros';
        const c100 = Math.round(p.carbs_100g * 10) / 10;
        const p100 = Math.round(p.protein_100g); // Rounded to integer
        const f100 = Math.round(p.fat_100g * 10) / 10;
        const e100 = Math.round(p.energy_kcal_100g); // Rounded to integer
        macros.textContent = `${e100} kcal | C: ${c100}g | P: ${p100}g | F: ${f100}g per 100g`;
        info.appendChild(macros);
        topRow.appendChild(info);

        const actions = document.createElement('div');
        actions.className = 'food-db-actions';

        const editBtn = createEditButton((e) => {
            e.stopPropagation();
            showEditFoodProductModal(p);
        });
        actions.appendChild(editBtn);

        const delBtn = createDeleteButton((e) => {
            e.stopPropagation();
            deleteFoodProduct(p.id, decodeFoodDisplayText(p.name));
        });
        actions.appendChild(delBtn);
        topRow.appendChild(actions);

        card.appendChild(topRow);

        const meta = document.createElement('div');
        meta.className = 'food-db-meta';
        
        const usage = document.createElement('span');
        usage.textContent = `Used: ${p.usage_count || 1}x`;
        meta.appendChild(usage);

        if (p.last_used_at && !p.last_used_at.startsWith('0001')) {
            const lastUsed = document.createElement('span');
            const date = new Date(p.last_used_at);
            lastUsed.textContent = `Last: ${date.toLocaleDateString()}`;
            meta.appendChild(lastUsed);
        }

        if (p.is_meal) {
            const label = document.createElement('span');
            label.className = 'food-meal-badge';
            label.textContent = 'MEAL';
            meta.appendChild(label);
        }

        card.appendChild(meta);
        list.appendChild(card);
    });

    // Pagination
    const limit = 20;
    const start = foodDBPage * limit + 1;
    const end = Math.min((foodDBPage + 1) * limit, total);

    pagination.classList.toggle('hidden', total <= 0);
    pageInfo.textContent = `Showing ${start}-${end} of ${total}`;

    prevBtn.disabled = foodDBPage === 0;
    nextBtn.disabled = (foodDBPage + 1) * limit >= total;
}
