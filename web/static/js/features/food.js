<<<<<<< Updated upstream
let foodControlsBound = false;
=======
(function () {
    let foodScannerStream = null, foodScannerRunning = false, foodScanLoopTimer = null, foodBarcodeDetector = null;
    const FOOD_SCAN_THROTTLE_MS = 250, FOOD_NUMERIC_BARCODE_MIN_LEN = 8;
    let foodAutoCompleteSuggestions = [], foodProductsCache = [], currentFoodLogs = {};
    window.currentFoodStatsPeriod = window.currentFoodStatsPeriod || 'day';

    function toISODateLocal(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
>>>>>>> Stashed changes

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

    bindClick('food-period-day-link', () => setFoodStatsPeriod('day'));
    bindClick('food-period-week-link', () => setFoodStatsPeriod('week'));
    bindClick('add-food-btn', () => showAddFoodModal());
    bindClick('food-date-prev-btn', () => shiftFoodDate(-1));
    bindClick('food-date-next-btn', () => shiftFoodDate(1));
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
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindFoodControls, { once: true });
}
bindFoodControls();

// -- Food Intake Autocomplete & Logic --

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
            foodProductsCache = await apiCall('/api/food/products', 'GET') || [];
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

<<<<<<< Updated upstream
    if (normalizedQuery.length >= 2 && normalizedQuery === lastFoodSearchQueryNormalized) {
        const list = document.getElementById('food-autocomplete-list');
        if (list && foodAutoCompleteSuggestions.length > 0) {
            list.classList.remove('hidden');
=======
    window.calculateFoodCalories = function () {
        const w = parseFloat(document.getElementById('food-weight').value) || 0;
        const c = parseFloat(document.getElementById('food-carbs').value) || 0;
        const p = parseFloat(document.getElementById('food-protein').value) || 0;
        const f = parseFloat(document.getElementById('food-fat').value) || 0;
        const per100 = document.getElementById('food-per-100g').checked;
        const mult = per100 ? w / 100 : 1;
        const total = Math.round((4 * c * mult) + (4 * p * mult) + (9 * f * mult));
        document.getElementById('food-calories').value = total;
    };

    window.setFoodStatsPeriod = function (period) {
        window.currentFoodStatsPeriod = period === 'week' ? 'week' : 'day';
        document.querySelectorAll('#food-stats-period-container .period-link').forEach((el) => {
            el.classList.toggle('active', el.dataset.period === window.currentFoodStatsPeriod);
        });
        window.loadFoodLogs();
    };

    window.shiftFoodDate = function (deltaDays) {
        const input = document.getElementById('food-date-filter');
        if (!input) return;
        const step = (window.currentFoodStatsPeriod === 'week' ? 7 : 1) * deltaDays;
        const base = input.value ? new Date(`${input.value}T00:00:00`) : new Date();
        base.setDate(base.getDate() + step);
        input.value = toISODateLocal(base);
        window.loadFoodLogs();
    };

    window.loadFoodLogs = async function () {
        const dateInput = document.getElementById('food-date-filter');
        if (dateInput && !dateInput.value) dateInput.value = toISODateLocal(new Date());
        const date = dateInput?.value || toISODateLocal(new Date());
        const period = window.currentFoodStatsPeriod || 'day';
        const key = `food_${date}_${period}`;
        const weekDisplay = document.getElementById('food-week-display');

        if (weekDisplay) {
            if (period === 'week') {
                const end = new Date(`${date}T00:00:00`);
                const start = new Date(end);
                start.setDate(end.getDate() - 6);
                const fmt = { month: 'short', day: 'numeric' };
                weekDisplay.textContent = `${start.toLocaleDateString(undefined, fmt)} - ${end.toLocaleDateString(undefined, fmt)}`;
                weekDisplay.classList.remove('hidden');
            } else {
                weekDisplay.classList.add('hidden');
            }
        }

        if (typeof window.loadFoodTargets === 'function') {
            await window.loadFoodTargets();
        }

        if (window.DataStore) {
            await window.DataStore.loadSWR({
                key, tags: ['food'],
                fetcher: async () => {
                    const days = period === 'week' ? '&days=7' : '';
                    const logs = await window.apiCall(`/api/food/log?date=${date}${days}`, 'GET');
                    let stats = null;
                    if (period === 'week') stats = await window.apiCall(`/api/food/stats?date=${date}&days=7`, 'GET');
                    return { logs, stats };
                },
                onCached: (cached) => window.renderFoodData(cached.logs, cached.stats, period, date),
                onFresh: (fresh) => window.renderFoodData(fresh.logs, fresh.stats, period, date)
            });
>>>>>>> Stashed changes
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

<<<<<<< Updated upstream
    if (query.length < 2) {
        renderFoodAutocomplete(foodProductsCache);
        lastFoodSearchQueryNormalized = '';
        setFoodSearchStatus();
        return;
    }
=======
        currentFoodLogs = {};
        window.currentFoodLogs = currentFoodLogs;

        groups.forEach(g => {
            const card = document.createElement('div'); card.className = 'history-group';
            card.innerHTML = `<div class="history-header"><strong>${g.name}</strong> <span style="font-weight:normal;color:var(--hint-color);">(${g.time})</span> <span style="margin-left:auto;font-size:0.9em;">${g.calories} kcal (C:${g.carbs} P:${g.protein} F:${g.fat})</span></div>`;
            const items = document.createElement('div');
            g.logs.forEach(l => {
                currentFoodLogs[l.id] = l;
                const item = document.createElement('div'); item.className = 'history-item';
                item.style.cssText = 'padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.05);cursor:pointer;display:flex;justify-content:space-between;align-items:center;';
                item.onclick = () => window.editFoodLog(l.id);
                item.innerHTML = `<div><div style="font-weight:500;">${l.name || 'Food'}</div><div style="font-size:0.85em;color:var(--hint-color);">${l.weight}g • ${l.calories} kcal</div></div>`;
                const del = document.createElement('button'); del.className = 'delete-btn'; del.textContent = '×';
                del.onclick = (e) => { e.stopPropagation(); window.deleteFoodLog(l.id); };
                item.appendChild(del); items.appendChild(item);
            });
            card.appendChild(items); list.appendChild(card);
        });
    };
>>>>>>> Stashed changes

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
            let matchFoundAndFilled = false;
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

    status.className = 'food-search-status';
    if (!type || !message) {
        status.classList.add('hidden');
        status.innerText = '';
        return;
    }

    status.classList.remove('hidden');
    status.classList.add(type);
    status.innerText = message;
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
<<<<<<< Updated upstream
    list.appendChild(closeBtn);

    // Limit datalist options so browser doesn't choke
    const displayList = foodAutoCompleteSuggestions.slice(0, 50);

    displayList.forEach(p => {
        const displayName = decodeFoodDisplayText(p.name);
        const item = document.createElement('div');
        item.className = 'autocomplete-item';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'autocomplete-item-name';
        nameSpan.textContent = displayName;
        if (p.barcode) {
            nameSpan.textContent += ` (${p.barcode})`;
        }
        nameSpan.onclick = function () {
            document.getElementById('food-name').value = displayName;
            autofillFoodProduct(p);
            setFoodSearchStatus('success', 'Product selected.');
            list.classList.add('hidden');
        };
        item.appendChild(nameSpan);

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

    // Check per 100g to auto-fill macros directly
    document.getElementById('food-per-100g').checked = true;
    document.getElementById('food-carbs').value = product.carbs_100g;
    document.getElementById('food-protein').value = product.protein_100g;
    document.getElementById('food-fat').value = product.fat_100g;
    document.getElementById('food-calories').value = product.energy_kcal_100g;

    // Focus weight input
    document.getElementById('food-weight').focus();
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

    const payload = {
        name: name,
        barcode: document.getElementById('food-product-barcode').value.trim(),
        carbs_100g: parseFloat(document.getElementById('food-product-carbs').value) || 0,
        protein_100g: parseFloat(document.getElementById('food-product-protein').value) || 0,
        fat_100g: parseFloat(document.getElementById('food-product-fat').value) || 0,
        energy_kcal_100g: parseFloat(document.getElementById('food-product-calories').value) || 0,
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
    if (!confirm(`Delete "${displayName}" from your food database?`)) return;

    try {
        await apiCall(`/api/food/products/${id}`, 'DELETE');
        // Refresh the cache
        foodProductsCache = null;
        if (window.MedTrackerDB) {
            await window.MedTrackerDB.FoodProductsStore.clearCache();
        }
        await initFoodProductsCache();
        renderFoodAutocomplete(foodProductsCache);
    } catch (e) {
        console.error('Failed to delete food product', e);
        safeAlert('Failed to delete product.');
    }
}

// -- Food Intake Functions --

function calculateFoodCalories() {
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
    if (per100g || caloriesInput.value === '') {
        caloriesInput.value = totalCals;
    }
}

function onFoodPer100gChange() {
    const per100gCheckbox = document.getElementById('food-per-100g');
    if (!per100gCheckbox.checked) {
        const weight = parseFloat(document.getElementById('food-weight').value) || 0;
        if (weight > 0) {
            const carbsInput = document.getElementById('food-carbs');
            const proteinInput = document.getElementById('food-protein');
            const fatInput = document.getElementById('food-fat');
            const carbsPer100 = parseFloat(carbsInput.value);
            const proteinPer100 = parseFloat(proteinInput.value);
            const fatPer100 = parseFloat(fatInput.value);
            if (!Number.isNaN(carbsPer100)) carbsInput.value = +((carbsPer100 * weight) / 100).toFixed(1);
            if (!Number.isNaN(proteinPer100)) proteinInput.value = +((proteinPer100 * weight) / 100).toFixed(1);
            if (!Number.isNaN(fatPer100)) fatInput.value = +((fatPer100 * weight) / 100).toFixed(1);
        }
    }
    calculateFoodCalories();
}

function onFoodCaloriesFocus() {
    const per100gCheckbox = document.getElementById('food-per-100g');
    if (per100gCheckbox.checked) {
        per100gCheckbox.checked = false;
        onFoodPer100gChange();
    }
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
        carbs: Math.round(Math.max(0, totalCarbs || 0)),
        protein: Math.round(Math.max(0, totalProtein || 0)),
        fat: Math.round(Math.max(0, totalFat || 0)),
        calories: Math.round(Math.max(0, totalCalories || 0)),
        per100g
    };
}

function toISODateLocal(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
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
}

function showAddFoodModal() {
    window.ModalManager.food.open();
    document.getElementById('food-modal-title').innerText = 'Log Food';

    // Set default date/time
    document.getElementById('food-datetime').value = formatDateTimeLocalForInput();

    // Clear inputs
    document.getElementById('food-id').value = '';
    document.getElementById('food-name').value = '';
    document.getElementById('food-barcode').value = '';
    document.getElementById('food-weight').value = '';
    document.getElementById('food-carbs').value = '';
    document.getElementById('food-protein').value = '';
    document.getElementById('food-fat').value = '';
    document.getElementById('food-calories').value = '';
    document.getElementById('food-per-100g').checked = true;
    document.getElementById('food-weight').focus();

    if (foodProductsCache.length === 0) {
        initFoodProductsCache().then(() => renderFoodAutocomplete(foodProductsCache, false, null, false));
    } else {
        renderFoodAutocomplete(foodProductsCache, false, null, false);
    }
}

function editFoodLog(id) {
    const log = currentFoodLogs[id];
    if (!log) return;

    window.ModalManager.food.open();
    document.getElementById('food-modal-title').innerText = 'Edit Food';

    document.getElementById('food-id').value = log.id;
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
    document.getElementById('food-weight').focus();
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

    const id = document.getElementById('food-id').value;

    const btn = document.getElementById('food-modal-save-btn');
    await withSubmit(btn, async () => {
        if (id) {
            await apiCall(`/api/food/log/${id}`, 'PUT', payload);
        } else {
            await apiCall('/api/food/log', 'POST', payload);
        }
        closeFoodModal();
        loadFoodLogs();
    });
}

let currentFoodStatsPeriod = 'day';

function setFoodStatsPeriod(period) {
    currentFoodStatsPeriod = period;
    document.querySelectorAll('#food-stats-period-container .period-link').forEach(el => {
        if (el.dataset.period === period) {
            el.classList.add('active');
        } else {
            el.classList.remove('active');
        }
    });
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

    const period = currentFoodStatsPeriod || 'day';
    const weekDisplay = document.getElementById('food-week-display');
    if (period === 'week') {
        const dEnd = new Date(`${dateStr}T00:00:00`);
        const dStart = new Date(dEnd);
        dStart.setDate(dEnd.getDate() - 6);
        const fmt = { month: 'short', day: 'numeric' };
        if (weekDisplay) {
            weekDisplay.innerText = `${dStart.toLocaleDateString(undefined, fmt)} - ${dEnd.toLocaleDateString(undefined, fmt)}`;
            weekDisplay.classList.remove('hidden');
        }
    } else {
        if (weekDisplay) weekDisplay.classList.add('hidden');
    }

    // Show cached data immediately (stale-while-revalidate)
    const cacheKey = `food_${dateStr}_${period}`;
    const cached = await window.DataStore.getCached(cacheKey);
    if (cached) {
        _renderFoodData(cached.groups, cached.weekStats, period, dateStr);
    } else {
        const loadingStr = document.createTextNode('Loading...');
        list.replaceChildren(loadingStr);
    }

    // Always fetch fresh data
    try {
        const daysParam = period === 'week' ? '&days=7' : '';
        const groups = await apiCall(`/api/food/log?date=${dateStr}${daysParam}`, 'GET');

        let weekStats = null;
        if (period === 'week' || period === '2weeks') {
            const daysCount = period === 'week' ? 7 : 14;
            weekStats = await apiCall(`/api/food/stats?date=${dateStr}&days=${daysCount}`, 'GET');
        }

        await window.DataStore.setCached(cacheKey, { groups: groups || [], weekStats });

        _renderFoodData(groups || [], weekStats, period, dateStr);
    } catch (e) {
        console.error(e);
        if (!cached) {
            const errP = document.createElement('p');
            errP.className = 'error';
            errP.textContent = 'Failed to load food logs.';
            list.replaceChildren(errP);
        }
    }
}

function _renderFoodData(groups, weekStats, period, dateStr) {
    const list = document.getElementById('food-list');
    const summary = document.getElementById('food-summary');

    list.replaceChildren();
    let dayCals = 0, dayCarbs = 0, dayProt = 0, dayFat = 0;
    currentFoodLogs = {};

    if (!groups || groups.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'hint';
        empty.style.textAlign = 'center';
        empty.textContent = 'No food logs for this day.';
        list.appendChild(empty);
    } else {
        groups.forEach(group => {
            dayCals += group.calories;
            dayCarbs += group.carbs;
            dayProt += group.protein;
            dayFat += group.fat;

            const groupDiv = document.createElement('div');
            groupDiv.className = 'history-group';

            const header = document.createElement('div');
            header.className = 'history-header';
            const title = document.createElement('strong');
            title.textContent = group.name;
            const time = document.createElement('span');
            time.style.cssText = 'font-weight:normal; color:var(--hint-color);';
            time.textContent = `(${group.time})`;
            const totals = document.createElement('span');
            totals.style.cssText = 'margin-left:auto; font-size:0.9em;';
            totals.textContent = `${group.calories} kcal (C:${group.carbs} P:${group.protein} F:${group.fat})`;
            header.appendChild(title);
            header.appendChild(time);
            header.appendChild(totals);
            groupDiv.appendChild(header);

            group.logs.forEach(log => {
                currentFoodLogs[log.id] = log;

                const item = document.createElement('div');
                item.className = 'history-item';
                item.style.cssText = 'padding: 8px 0; border-bottom: 1px solid rgba(0,0,0,0.05); cursor: pointer;';
                item.addEventListener('click', () => {
                    editFoodLog(log.id);
                });

                const itemBody = document.createElement('div');
                itemBody.style.flex = '1';
                const name = document.createElement('div');
                name.style.fontWeight = '500';
                name.textContent = log.name || 'Food';
                const meta = document.createElement('div');
                meta.style.cssText = 'font-size:0.85em; color:var(--hint-color);';
                meta.textContent = `${log.weight}g • ${log.calories} kcal`;
                itemBody.appendChild(name);
                itemBody.appendChild(meta);

                const deleteButton = document.createElement('button');
                deleteButton.type = 'button';
                deleteButton.className = 'delete-btn';
                deleteButton.style.fontSize = '16px';
                deleteButton.textContent = '×';
                deleteButton.addEventListener('click', (event) => {
                    event.stopPropagation();
                    deleteFoodLog(log.id);
                });

                item.appendChild(itemBody);
                item.appendChild(deleteButton);
                groupDiv.appendChild(item);
            });

            list.appendChild(groupDiv);
        });
    }

    const hasTargets = foodTargets.calories > 0 || foodTargets.protein > 0 || foodTargets.carbs > 0 || foodTargets.fat > 0;
    const periodContainer = document.getElementById('food-stats-period-container');
    if (periodContainer) {
        hasTargets ? periodContainer.classList.remove('hidden') : periodContainer.classList.add('hidden');
    }

    if (period === 'week' || period === '2weeks') {
        const stats = weekStats;
        summary.style.display = 'block';
        const label = period === 'week' ? '7-Day Total' : '14-Day Total';
        renderFoodSummary(summary, label, stats?.calories || 0, stats?.carbs || 0, stats?.protein || 0, stats?.fat || 0);
        renderFoodTargetProgress(stats?.calories || 0, stats?.carbs || 0, stats?.protein || 0, stats?.fat || 0, period);
    } else {
        if (groups && groups.length > 0) {
            summary.style.display = 'block';
            renderFoodSummary(summary, 'Daily Total', dayCals, dayCarbs, dayProt, dayFat);
            renderFoodTargetProgress(dayCals, dayCarbs, dayProt, dayFat, period);
        } else {
            summary.style.display = 'none';
            renderFoodTargetProgress(0, 0, 0, 0, period);
        }
    }
}

function renderFoodSummary(summaryEl, label, calories, carbs, protein, fat) {
    summaryEl.replaceChildren();

    const text = document.createTextNode(`${label}: ${calories} kcal `);
    const details = document.createElement('span');
    details.style.cssText = 'font-weight:normal; font-size:0.9em; margin-left:10px;';
    details.textContent = `(C:${carbs} P:${protein} F:${fat})`;

    summaryEl.appendChild(text);
    summaryEl.appendChild(details);
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
        values.textContent = `${t.value} / ${targetValue} ${t.unit}`;

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
        if (document.querySelector('.tab.active')?.dataset.tab === 'food') {
            loadFoodLogs();
        }
    } catch (e) {
        console.error('Failed to save food targets:', e);
        safeAlert('Failed to save food targets');
    }
}

async function deleteFoodLog(id) {
    if (!confirm("Delete this entry?")) return;
    const ok = await apiCall(`/api/food/log/${id}`, 'DELETE');
    if (ok) loadFoodLogs();
}

=======

    let foodControlsBound = false;
    function bindFoodControls() {
        if (foodControlsBound) return;
        foodControlsBound = true;

        const bindClick = (id, handler) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', handler);
        };
        const bindInput = (id, handler) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', handler);
        };
        const bindChange = (id, handler) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', handler);
        };

        bindClick('food-period-day-link', () => window.setFoodStatsPeriod('day'));
        bindClick('food-period-week-link', () => window.setFoodStatsPeriod('week'));
        bindClick('add-food-btn', () => window.showAddFoodModal());
        bindClick('food-date-prev-btn', () => window.shiftFoodDate(-1));
        bindClick('food-date-next-btn', () => window.shiftFoodDate(1));
        bindChange('food-date-filter', () => window.loadFoodLogs());

        bindClick('food-modal-cancel-btn', () => window.ModalManager?.food?.close?.());
        bindClick('food-modal-save-btn', () => window.saveFoodLog());
        bindInput('food-weight', () => window.calculateFoodCalories());
        bindInput('food-carbs', () => window.calculateFoodCalories());
        bindInput('food-protein', () => window.calculateFoodCalories());
        bindInput('food-fat', () => window.calculateFoodCalories());
        bindChange('food-per-100g', () => window.calculateFoodCalories());
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindFoodControls, { once: true });
    }
    bindFoodControls();
})();
>>>>>>> Stashed changes
