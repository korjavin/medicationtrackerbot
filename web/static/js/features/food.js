let foodControlsBound = false;

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
            sortBtns.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            foodDBSort = e.target.dataset.sort;
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

    bindClick('food-period-day-link', () => setFoodStatsPeriod('day'));
    bindClick('food-period-week-link', () => setFoodStatsPeriod('week'));
    bindClick('add-food-btn', () => showAddFoodModal());
    bindClick('food-date-prev-btn', () => shiftFoodDate(-1));
    bindClick('food-date-next-btn', () => shiftFoodDate(1));
    bindClick('food-today-btn', () => goFoodToday());
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

    bindTabGroup({
        container: document.querySelector('.food-tabs'),
        buttonSelector: '.food-tab',
        onTabSelect: switchFoodTab
    });

    bindClick('food-save-meal-cancel-btn', () => closeFoodSaveMealModal());
    bindClick('food-save-meal-confirm-btn', () => confirmSaveMeal());
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindFoodControls, { once: true });
}
bindFoodControls();

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
            const resp = await apiCall('/api/food/products', 'GET');
            foodProductsCache = resp ? (resp.products || []) : [];
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
    list.appendChild(closeBtn);

    // Limit datalist options so browser doesn't choke
    const displayList = foodAutoCompleteSuggestions.slice(0, 50);

    displayList.forEach(p => {
        const displayName = decodeFoodDisplayText(p.name);
        const item = document.createElement('div');
        item.className = 'autocomplete-item';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'autocomplete-item-name';

        let displayText = displayName;
        if (p.is_meal) {
            displayText = `🍱 ${displayName} (Meal)`;
        } else if (p.barcode) {
            displayText += ` (${p.barcode})`;
        }
        nameSpan.textContent = displayText;

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

function updateFoodDateNav() {
    const dateFilter = document.getElementById('food-date-filter');
    const label = document.getElementById('food-date-label');
    const nextBtn = document.getElementById('food-date-next-btn');
    const todayBtn = document.getElementById('food-today-btn');
    if (!dateFilter || !label || !nextBtn || !todayBtn) return;

    const dateStr = dateFilter.value;
    if (!dateStr) return;

    label.textContent = formatFoodDateLabel(dateStr);

    const date = new Date(`${dateStr}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const isTodayOrFuture = date.getTime() >= today.getTime();
    nextBtn.disabled = isTodayOrFuture;
    todayBtn.style.display = isTodayOrFuture ? 'none' : 'inline-flex';
}

function goFoodToday() {
    const dateFilter = document.getElementById('food-date-filter');
    if (!dateFilter) return;
    dateFilter.value = toISODateLocal(new Date());
    loadFoodLogs();
    updateFoodDateNav();
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
    document.getElementById('food-modal-title').innerText = 'Log Food';

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
        linkContainer.innerHTML = `<a href="#" onclick="navigateToFoodProduct(event, ${log.product_id}, ${log.is_meal ? 'true' : 'false'})" style="color: var(--primary-color); text-decoration: none;">${linkText}</a>`;
        linkContainer.classList.remove('hidden');
    } else {
        linkContainer.innerHTML = '';
        linkContainer.classList.add('hidden');
    }

    document.getElementById('food-weight').focus();
}

function navigateToFoodProduct(event, productId, isMeal) {
    event.preventDefault();
    window.ModalManager.food.close();
    if (isMeal) {
        switchFoodTab('meals');
        setTimeout(() => {
            if (foodMealsCache && foodMealsCache.length > 0) {
                const meal = foodMealsCache.find(m => m.id === productId);
                if (meal) {
                    showEditFoodProductModal(meal);
                }
            }
        }, 100);
    } else {
        switchFoodTab('fooddb');
        setTimeout(() => {
            if (foodProductsCache && foodProductsCache.length > 0) {
                const product = foodProductsCache.find(p => p.id === productId);
                if (product) {
                    showEditFoodProductModal(product);
                }
            }
        }, 100);
    }
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

    if (typeof loadMyMeals === 'function') {
        loadMyMeals();
    }

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

    // Highlight active sort button
    const sortButtons = document.querySelectorAll('.fooddb-sort-btn');
    sortButtons.forEach(btn => {
        if (btn.dataset.sort === foodDBSort) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    // Show cached data immediately (stale-while-revalidate)
    const cacheKey = `food_${dateStr}_${period}`;
    const cached = await window.DataStore.getCached(cacheKey);
    if (cached) {
        _renderFoodData(cached.groups, cached.weekStats, period, dateStr);
    } else {
        const loadingStr = document.createTextNode('Loading...');
        list.replaceChildren(loadingStr);
    }

    updateFoodDateNav();

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

    if (!foodMultiSelectMode) {
        foodSelectedLogIds.clear();
    }

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
            totals.textContent = `${Math.round(group.calories)} kcal (C:${Math.round(group.carbs)} P:${Math.round(group.protein)} F:${Math.round(group.fat)})`;
            header.appendChild(title);
            header.appendChild(time);
            header.appendChild(totals);
            groupDiv.appendChild(header);

            group.logs.forEach(log => {
                currentFoodLogs[log.id] = log;

                const item = document.createElement('div');
                item.className = 'history-item';
                item.style.cssText = 'padding: 8px 0; border-bottom: 1px solid rgba(0,0,0,0.05); cursor: pointer; display: flex; align-items: center;';

                if (foodMultiSelectMode) {
                    const checkboxDiv = document.createElement('div');
                    checkboxDiv.style.cssText = 'margin-right: 10px; flex-shrink: 0;';
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.style.cssText = 'width: 18px; height: 18px; cursor: pointer;';
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
                    item.addEventListener('click', () => {
                        editFoodLog(log.id);
                    });
                }

                const itemBody = document.createElement('div');
                itemBody.style.flex = '1';
                itemBody.style.overflow = 'hidden';
                const name = document.createElement('div');
                name.style.fontWeight = '500';

                if (log.is_meal) {
                    name.textContent = '🍽 ' + (log.name || 'Food');
                } else {
                    name.textContent = log.name || 'Food';
                }
                const meta = document.createElement('div');
                meta.style.cssText = 'font-size:0.85em; color:var(--hint-color);';
                meta.textContent = `${Math.round(log.weight)}g • ${Math.round(log.calories)} kcal`;
                itemBody.appendChild(name);
                itemBody.appendChild(meta);

                const actionIcons = document.createElement('div');
                actionIcons.style.display = 'flex';
                actionIcons.style.gap = '8px';

                const editButton = createEditButton((event) => {
                    event.stopPropagation();
                    editFoodLog(log.id);
                });

                const deleteButton = createDeleteButton((event) => {
                    event.stopPropagation();
                    deleteFoodLog(log.id);
                });

                actionIcons.appendChild(editButton);
                actionIcons.appendChild(deleteButton);

                item.appendChild(itemBody);
                item.appendChild(actionIcons);
                groupDiv.appendChild(item);
            });

            list.appendChild(groupDiv);
        });
    }

    const hasTargets = foodTargets.calories > 0 || foodTargets.protein > 0 || foodTargets.carbs > 0 || foodTargets.fat > 0;
    const periodContainer = document.getElementById('food-stats-period-container');
    if (periodContainer) {
        periodContainer.classList.remove('hidden');
    }

    if (period === 'week' || period === '2weeks') {
        const stats = weekStats;
        summary.style.display = 'block';
        const label = period === 'week' ? '7-Day Total' : '14-Day Total';
        renderFoodSummary(summary, label, Math.round(stats?.calories || 0), Math.round(stats?.carbs || 0), Math.round(stats?.protein || 0), Math.round(stats?.fat || 0));
        renderFoodTargetProgress(Math.round(stats?.calories || 0), Math.round(stats?.carbs || 0), Math.round(stats?.protein || 0), Math.round(stats?.fat || 0), period);
    } else {
        if (groups && groups.length > 0) {
            summary.style.display = 'block';
            renderFoodSummary(summary, 'Daily Total', Math.round(dayCals), Math.round(dayCarbs), Math.round(dayProt), Math.round(dayFat));
            renderFoodTargetProgress(Math.round(dayCals), Math.round(dayCarbs), Math.round(dayProt), Math.round(dayFat), period);
        } else {
            summary.style.display = 'none';
            renderFoodTargetProgress(0, 0, 0, 0, period);
        }
    }

    updateFoodSelectUI();
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
            actionBtn.className = 'primary shadow';
            actionBtn.style.cssText = 'position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%); z-index: 1000; border-radius: 20px; padding: 10px 20px;';
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
        actionBtn.style.display = 'block';
    } else {
        if (actionBtn) {
            actionBtn.style.display = 'none';
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
        p.className = 'hint';
        p.textContent = 'You haven\'t created any meals yet.';
        list.appendChild(p);
        return;
    }

    meals.forEach(meal => {
        const card = document.createElement('div');
        card.className = 'food-db-card';
        
        const mainRow = document.createElement('div');
        mainRow.style.cssText = 'display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;';

        const info = document.createElement('div');
        info.style.flex = '1';
        info.style.minWidth = '0';
        info.className = 'food-meal-info';

        const name = document.createElement('div');
        name.className = 'food-meal-name';
        name.style.fontWeight = '600';
        name.style.fontSize = '1.1em';
        name.textContent = decodeFoodDisplayText(meal.name);
        info.appendChild(name);
        mainRow.appendChild(info);

        const actions = document.createElement('div');
        actions.className = 'food-meal-actions';
        actions.style.cssText = 'display: flex; gap: 8px; flex-shrink: 0;';

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
        nutritionRow.style.cssText = 'font-size: 0.9em; margin-bottom: 10px; display: flex; gap: 15px; color: var(--text-color);';
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

function renderFoodSummary(summaryEl, label, calories, carbs, protein, fat) {
    summaryEl.replaceChildren();

    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.justifyContent = 'space-between';
    wrapper.style.alignItems = 'center';

    const textGroup = document.createElement('div');
    const text = document.createTextNode(`${label}: ${Math.round(calories)} kcal `);
    const details = document.createElement('span');
    details.style.cssText = 'font-weight:normal; font-size:0.9em; margin-left:10px;';
    details.textContent = `(C:${Math.round(carbs * 10) / 10} P:${Math.round(protein)} F:${Math.round(fat * 10) / 10})`;
    textGroup.appendChild(text);
    textGroup.appendChild(details);
    
    wrapper.appendChild(textGroup);

    if (label === 'Daily Total') {
        const selectBtn = document.createElement('button');
        selectBtn.className = 'secondary small-btn';
        selectBtn.style.margin = '0';
        selectBtn.style.padding = '4px 8px';
        selectBtn.style.border = '1px solid var(--border-color, #ccc)';
        
        if (foodMultiSelectMode) {
            selectBtn.classList.replace('secondary', 'primary');
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
        if (document.querySelector('.tab.active')?.dataset.tab === 'food') {
            loadFoodLogs();
        }
    } catch (e) {
        console.error('Failed to save food targets:', e);
        safeAlert('Failed to save food targets');
    }
}


function switchFoodTab(tab) {
    const activated = activateTabGroup(tab, {
        buttonSelector: '.food-tab',
        contentSelector: '.food-tab-content',
        contentIdFromTab: (tabName) => `food-${tabName}-tab`
    });
    if (!activated) return;

    if (tab === 'log') { loadFoodLogs(); }
    else if (tab === 'meals') { loadMyMeals(); }
    else if (tab === 'fooddb') { loadFoodDB(); }
}

async function deleteFoodLog(id) {
    await safeConfirm("Delete this entry?", async (ok) => {
        if (ok) {
            const res = await apiCall(`/api/food/log/${id}`, 'DELETE');
            if (res) loadFoodLogs();
        }
    });
}


// -- Food DB --

async function loadFoodDB() {
    const list = document.getElementById('fooddb-list');
    list.innerHTML = '<p class="hint">Loading products...</p>';

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
        list.innerHTML = '<p class="error">Failed to load products</p>';
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
        list.innerHTML = '<p class="hint">No products found.</p>';
        pagination.style.display = total > 0 ? 'flex' : 'none';
        pageInfo.textContent = `Showing 0 of ${total}`;
        prevBtn.disabled = foodDBPage === 0;
        nextBtn.disabled = true;
        return;
    }

    products.forEach(p => {
        const card = document.createElement('div');
        card.className = 'food-db-card';
        card.onclick = (e) => {
            if (e.target.tagName !== 'BUTTON') {
                autofillFoodProduct(p);
            }
        };

        const topRow = document.createElement('div');
        topRow.className = 'food-db-actions-row';
        topRow.style.cssText = 'display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;';

        const info = document.createElement('div');
        info.className = 'food-db-info';
        info.style.flex = '1';
        info.style.minWidth = '0';

        const name = document.createElement('div');
        name.className = 'food-db-name';
        name.style.cssText = 'font-weight: 600; font-size: 1.1em; margin-bottom: 4px; color: var(--text-color);';
        name.textContent = decodeFoodDisplayText(p.name);
        info.appendChild(name);

        const macros = document.createElement('div');
        macros.className = 'food-db-macros';
        macros.style.cssText = 'font-size: 0.9em; color: var(--hint-color);';
        const c100 = Math.round(p.carbs_100g * 10) / 10;
        const p100 = Math.round(p.protein_100g); // Rounded to integer
        const f100 = Math.round(p.fat_100g * 10) / 10;
        const e100 = Math.round(p.energy_kcal_100g); // Rounded to integer
        macros.textContent = `${e100} kcal | C: ${c100}g | P: ${p100}g | F: ${f100}g per 100g`;
        info.appendChild(macros);
        topRow.appendChild(info);

        const actions = document.createElement('div');
        actions.className = 'food-db-actions';
        actions.style.flexShrink = '0';
        actions.style.marginLeft = '12px';

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
        meta.style.cssText = 'font-size: 0.8em; color: var(--hint-color); border-top: 1px solid rgba(0,0,0,0.03); padding-top: 8px; display: flex; gap: 12px;';
        
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
            label.style.cssText = 'background: rgba(36, 129, 204, 0.1); color: var(--link-color); padding: 1px 6px; border-radius: 4px; font-weight: 600; font-size: 0.9em; margin-left: auto;';
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

    pagination.style.display = total > 0 ? 'flex' : 'none';
    pageInfo.textContent = `Showing ${start}-${end} of ${total}`;

    prevBtn.disabled = foodDBPage === 0;
    nextBtn.disabled = (foodDBPage + 1) * limit >= total;
}
