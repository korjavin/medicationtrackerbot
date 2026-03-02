(function () {
    let foodScannerStream = null, foodScannerRunning = false, foodScanLoopTimer = null, foodBarcodeDetector = null;
    const FOOD_SCAN_THROTTLE_MS = 250, FOOD_NUMERIC_BARCODE_MIN_LEN = 8;
    let foodAutoCompleteSuggestions = [], foodProductsCache = [], currentFoodLogs = {};
    let foodSearchTimeout = null, foodSearchRequestId = 0, lastFoodSearchQueryNormalized = '';
    let foodOutsideClickBound = false;
    window.currentFoodStatsPeriod = window.currentFoodStatsPeriod || 'day';

    function toISODateLocal(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    window.toISODateLocal = toISODateLocal;

    function parseOptionalNumber(rawValue) {
        const v = String(rawValue || '').trim();
        if (v === '') return null;
        const n = parseFloat(v);
        if (Number.isNaN(n)) return null;
        return n;
    }
    window.parseOptionalNumber = parseOptionalNumber;

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
        window.calculateFoodCalories();
    }
    window.onFoodPer100gChange = onFoodPer100gChange;

    function computeFoodTotals() {
        const carbsRaw = parseOptionalNumber(document.getElementById('food-carbs').value);
        const proteinRaw = parseOptionalNumber(document.getElementById('food-protein').value);
        const fatRaw = parseOptionalNumber(document.getElementById('food-fat').value);
        const caloriesRaw = parseOptionalNumber(document.getElementById('food-calories').value);
        const weightRaw = parseOptionalNumber(document.getElementById('food-weight').value);
        const per100g = document.getElementById('food-per-100g').checked;
        const weight = weightRaw && weightRaw > 0 ? weightRaw : 0;
        const multiplier = per100g && weight > 0 ? weight / 100 : 1;

        let totalCarbs = carbsRaw === null ? null : carbsRaw * multiplier;
        let totalProtein = proteinRaw === null ? null : proteinRaw * multiplier;
        let totalFat = fatRaw === null ? null : fatRaw * multiplier;
        let totalCalories = caloriesRaw;

        const missing = [];
        if (totalCarbs === null) missing.push('carbs');
        if (totalProtein === null) missing.push('protein');
        if (totalFat === null) missing.push('fat');
        if (totalCalories === null) missing.push('calories');

        if (missing.length === 1) {
            const f = missing[0];
            if (f === 'calories' && totalCarbs !== null && totalProtein !== null && totalFat !== null) {
                totalCalories = (4 * totalCarbs) + (4 * totalProtein) + (9 * totalFat);
            } else if (f === 'carbs' && totalCalories !== null && totalProtein !== null && totalFat !== null) {
                totalCarbs = (totalCalories - (4 * totalProtein) - (9 * totalFat)) / 4;
            } else if (f === 'protein' && totalCalories !== null && totalCarbs !== null && totalFat !== null) {
                totalProtein = (totalCalories - (4 * totalCarbs) - (9 * totalFat)) / 4;
            } else if (f === 'fat' && totalCalories !== null && totalCarbs !== null && totalProtein !== null) {
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
    window.computeFoodTotals = computeFoodTotals;

    window.decodeFoodDisplayText = function (raw) {
        if (!raw) return "";
        try { return decodeURIComponent(raw).replace(/\+/g, ' '); } catch (e) { return raw; }
    };

    window.initFoodProductsCache = async function () {
        if (window.MedTrackerDB) {
            const cached = await window.MedTrackerDB.FoodProductsStore.getCache();
            if (cached) { foodProductsCache = cached; return; }
        }
        try {
            const res = await window.apiCall('/api/food/products', 'GET');
            foodProductsCache = res || [];
            if (window.MedTrackerDB) await window.MedTrackerDB.FoodProductsStore.saveCache(foodProductsCache);
        } catch (e) { console.error('Failed to init food products cache', e); }
    };

    window.renderFoodAutocomplete = function (products, showLoadMore = false, loadMoreCallback = null, showList = true) {
        foodAutoCompleteSuggestions = products || [];
        const list = document.getElementById('food-autocomplete-list');
        if (!list) return;
        list.replaceChildren();
        if (foodAutoCompleteSuggestions.length === 0) { list.classList.add('hidden'); return; }
        const closeBtn = document.createElement('div'); closeBtn.className = 'autocomplete-close';
        closeBtn.innerHTML = '<span>▲ Close</span>'; closeBtn.onclick = (e) => { e.stopPropagation(); list.classList.add('hidden'); };
        list.appendChild(closeBtn);
        foodAutoCompleteSuggestions.slice(0, 50).forEach(p => {
            const name = window.decodeFoodDisplayText(p.name);
            const item = document.createElement('div'); item.className = 'autocomplete-item';
            const span = document.createElement('span'); span.className = 'autocomplete-item-name';
            span.textContent = name + (p.barcode ? ` (${p.barcode})` : '');
            span.onclick = () => { document.getElementById('food-name').value = name; window.autofillFoodProduct(p); list.classList.add('hidden'); };
            item.appendChild(span);
            if (p.id > 0) {
                const acts = document.createElement('span'); acts.className = 'autocomplete-item-actions';
                const edit = document.createElement('button'); edit.className = 'autocomplete-action-btn'; edit.textContent = '✎';
                edit.onclick = (e) => { e.stopPropagation(); list.classList.add('hidden'); window.showEditFoodProductModal(p); };
                const del = document.createElement('button'); del.className = 'autocomplete-action-btn autocomplete-action-delete'; del.textContent = '✕';
                del.onclick = (e) => { e.stopPropagation(); window.deleteFoodProduct(p.id, name); };
                acts.append(edit, del); item.appendChild(acts);
            }
            list.appendChild(item);
        });
        if (showLoadMore && loadMoreCallback) {
            const more = document.createElement('div'); more.className = 'autocomplete-load-more'; more.textContent = '... Load more ...';
            more.onclick = (e) => { e.stopPropagation(); more.textContent = 'Loading...'; loadMoreCallback(); };
            list.appendChild(more);
        }
        if (showList) list.classList.remove('hidden'); else list.classList.add('hidden');
    };

    window.autofillFoodProduct = function (product) {
        const name = window.decodeFoodDisplayText(product.name);
        document.getElementById('food-name').value = name;
        if (product.barcode) document.getElementById('food-barcode').value = product.barcode;
        document.getElementById('food-per-100g').checked = true;
        document.getElementById('food-carbs').value = product.carbs_100g || 0;
        document.getElementById('food-protein').value = product.protein_100g || 0;
        document.getElementById('food-fat').value = product.fat_100g || 0;
        document.getElementById('food-calories').dataset.baseKcal = product.energy_kcal_100g || 0;
        document.getElementById('food-weight').focus();
        window.calculateFoodCalories();
    };

    window.calculateFoodCalories = function () {
        const w = parseFloat(document.getElementById('food-weight').value) || 0;
        const per100 = document.getElementById('food-per-100g').checked;
        const baseKcalAttr = document.getElementById('food-calories').dataset.baseKcal;

        if (w > 0 && per100 && baseKcalAttr !== undefined && !isNaN(parseFloat(baseKcalAttr))) {
            const baseKcal = parseFloat(baseKcalAttr);
            document.getElementById('food-calories').value = Math.round(baseKcal * (w / 100));
        } else if (w > 0 && per100) {
            const c = parseFloat(document.getElementById('food-carbs').value) || 0;
            const p = parseFloat(document.getElementById('food-protein').value) || 0;
            const f = parseFloat(document.getElementById('food-fat').value) || 0;
            const mult = w / 100;
            const total = Math.round((4 * c * mult) + (4 * p * mult) + (9 * f * mult));
            document.getElementById('food-calories').value = total;
        }
    };

    function normalizeFoodSearchQuery(raw) {
        return String(raw || '').trim().toLowerCase();
    }

    function dedupeFoodProducts(products) {
        const result = [];
        const seen = new Set();
        for (const p of products || []) {
            if (!p) continue;
            const key = `${(p.id || 0)}|${String(p.barcode || '').trim()}|${normalizeFoodSearchQuery(window.decodeFoodDisplayText(p.name))}`;
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(p);
        }
        return result;
    }

    async function readSearchResponse(res) {
        const contentType = res.headers.get('content-type') || '';
        if (!res.body || contentType.includes('application/json')) {
            const parsed = await res.json();
            return Array.isArray(parsed) ? parsed : [];
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let lastParsed = [];

        while (true) {
            const { done, value } = await reader.read();
            if (value) {
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    try {
                        const parsed = JSON.parse(trimmed);
                        if (Array.isArray(parsed)) lastParsed = parsed;
                    } catch (_e) {
                        // ignore partial/broken line
                    }
                }
            }
            if (done) break;
        }

        if (buffer.trim()) {
            try {
                const parsed = JSON.parse(buffer.trim());
                if (Array.isArray(parsed)) lastParsed = parsed;
            } catch (_e) {
                // ignore
            }
        }
        return lastParsed;
    }

    async function fetchFoodProductsSearch(query, remote = false) {
        const endpoint = `/api/food/products/search?q=${encodeURIComponent(query)}${remote ? '&remote=true' : ''}`;
        const headers = { 'X-Requested-With': 'XMLHttpRequest' };
        if (window.userInitData) headers['X-Telegram-Init-Data'] = window.userInitData;
        const res = await fetch(endpoint, { method: 'GET', headers });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(errText || `Search failed (${res.status})`);
        }
        return await readSearchResponse(res);
    }

    window.setFoodSearchStatus = function (type, message) {
        const status = document.getElementById('food-search-status');
        if (!status) return;
        status.className = 'food-search-status';
        if (!type || !message) {
            status.classList.add('hidden');
            status.textContent = '';
            return;
        }
        status.classList.remove('hidden');
        status.classList.add(type);
        status.textContent = message;
    };

    window.onFoodNameFocus = function () {
        const list = document.getElementById('food-autocomplete-list');
        if (!list) return;
        if (foodAutoCompleteSuggestions.length > 0) list.classList.remove('hidden');
    };

    window.onFoodNameChange = async function () {
        const input = document.getElementById('food-name');
        if (!input) return;
        const query = input.value;
        const normalized = normalizeFoodSearchQuery(query);

        if (normalized.length >= 2 && normalized === lastFoodSearchQueryNormalized) {
            const list = document.getElementById('food-autocomplete-list');
            if (list && foodAutoCompleteSuggestions.length > 0) list.classList.remove('hidden');
            return;
        }

        const selected = foodAutoCompleteSuggestions.find((p) => normalizeFoodSearchQuery(window.decodeFoodDisplayText(p.name)) === normalized);
        if (selected) {
            window.autofillFoodProduct(selected);
            window.setFoodSearchStatus('success', 'Product selected.');
            return;
        }

        clearTimeout(foodSearchTimeout);
        if (normalized.length < 2) {
            lastFoodSearchQueryNormalized = '';
            window.setFoodSearchStatus();
            const list = document.getElementById('food-autocomplete-list');
            if (list) list.classList.add('hidden');
            return;
        }

        foodSearchTimeout = setTimeout(async () => {
            const requestId = ++foodSearchRequestId;
            lastFoodSearchQueryNormalized = normalized;
            window.setFoodSearchStatus('loading', 'Searching local database...');

            if (!foodProductsCache.length) await window.initFoodProductsCache();
            const cacheMatches = (foodProductsCache || []).filter((p) => {
                const name = normalizeFoodSearchQuery(window.decodeFoodDisplayText(p.name));
                const barcode = normalizeFoodSearchQuery(p.barcode);
                return name.includes(normalized) || barcode.includes(normalized);
            });

            let localApiResults = [];
            try {
                localApiResults = await fetchFoodProductsSearch(query, false);
            } catch (_e) {
                localApiResults = [];
            }
            if (requestId !== foodSearchRequestId) return;

            const localUnique = dedupeFoodProducts([...cacheMatches, ...localApiResults]);
            const loadMoreCallback = async () => {
                if (requestId !== foodSearchRequestId) return;
                window.setFoodSearchStatus('loading', 'Searching OpenFoodFacts...');
                try {
                    const remoteResults = await fetchFoodProductsSearch(query, true);
                    if (requestId !== foodSearchRequestId) return;
                    const merged = dedupeFoodProducts([...localUnique, ...(remoteResults || [])]);
                    window.renderFoodAutocomplete(merged, false, null, true);
                    window.setFoodSearchStatus('success', `Found ${merged.length} result(s).`);
                } catch (_e) {
                    if (requestId !== foodSearchRequestId) return;
                    window.renderFoodAutocomplete(localUnique, false, null, true);
                    window.setFoodSearchStatus(localUnique.length ? 'success' : 'empty', localUnique.length ? `Found ${localUnique.length} local result(s).` : 'No products found.');
                }
            };

            window.renderFoodAutocomplete(localUnique, navigator.onLine, loadMoreCallback, true);
            if (localUnique.length > 0) {
                window.setFoodSearchStatus('success', `Found ${localUnique.length} local result(s).`);
            } else if (navigator.onLine) {
                window.setFoodSearchStatus('empty', 'No local products found.');
                await loadMoreCallback();
            } else {
                window.setFoodSearchStatus('empty', 'No products found.');
            }
        }, 350);
    };

    window.onFoodBarcodeChange = async function () {
        const input = document.getElementById('food-barcode');
        if (!input) return;
        const barcode = String(input.value || '').trim();

        clearTimeout(foodSearchTimeout);
        if (barcode.length < 5) {
            window.setFoodSearchStatus();
            return;
        }

        foodSearchTimeout = setTimeout(async () => {
            const requestId = ++foodSearchRequestId;
            window.setFoodSearchStatus('loading', 'Searching by barcode...');

            if (!foodProductsCache.length) await window.initFoodProductsCache();
            const cacheMatch = (foodProductsCache || []).find((p) => String(p.barcode || '').trim() === barcode);
            if (cacheMatch) {
                window.autofillFoodProduct(cacheMatch);
                window.setFoodSearchStatus('success', 'Product found and filled in.');
                return;
            }

            let localApiResults = [];
            try {
                localApiResults = await fetchFoodProductsSearch(barcode, false);
            } catch (_e) {
                localApiResults = [];
            }
            if (requestId !== foodSearchRequestId) return;

            const localMatch = (localApiResults || []).find((p) => String(p.barcode || '').trim() === barcode);
            if (localMatch) {
                window.autofillFoodProduct(localMatch);
                window.setFoodSearchStatus('success', 'Product found and filled in.');
                return;
            }

            if (!navigator.onLine) {
                window.setFoodSearchStatus('empty', 'No local products found.');
                return;
            }

            try {
                const remoteResults = await fetchFoodProductsSearch(barcode, true);
                if (requestId !== foodSearchRequestId) return;
                const remoteMatch = (remoteResults || []).find((p) => String(p.barcode || '').trim() === barcode);
                if (remoteMatch) {
                    window.autofillFoodProduct(remoteMatch);
                    window.setFoodSearchStatus('success', 'Product found and filled in.');
                    return;
                }
                const merged = dedupeFoodProducts([...(localApiResults || []), ...(remoteResults || [])]);
                window.renderFoodAutocomplete(merged, false, null, true);
                window.setFoodSearchStatus(merged.length ? 'success' : 'empty', merged.length ? `Found ${merged.length} result(s).` : 'No products found.');
            } catch (_e) {
                window.setFoodSearchStatus('empty', 'No products found.');
            }
        }, 350);
    };

    window.showEditFoodProductModal = function (product) {
        if (!product) return;
        const id = document.getElementById('food-product-id');
        const name = document.getElementById('food-product-name');
        const barcode = document.getElementById('food-product-barcode');
        const carbs = document.getElementById('food-product-carbs');
        const protein = document.getElementById('food-product-protein');
        const fat = document.getElementById('food-product-fat');
        const calories = document.getElementById('food-product-calories');
        if (!id || !name || !barcode || !carbs || !protein || !fat || !calories) return;

        id.value = product.id || '';
        name.value = window.decodeFoodDisplayText(product.name || '');
        barcode.value = product.barcode || '';
        carbs.value = product.carbs_100g || '';
        protein.value = product.protein_100g || '';
        fat.value = product.fat_100g || '';
        calories.value = product.energy_kcal_100g || '';
        window.ModalManager?.foodProduct?.open?.();
    };

    window.closeFoodProductModal = function () {
        window.ModalManager?.foodProduct?.close?.();
    };

    window.saveFoodProduct = async function () {
        const id = document.getElementById('food-product-id')?.value;
        const name = document.getElementById('food-product-name')?.value?.trim();
        if (!id) return;
        if (!name) {
            window.safeAlert?.('Please enter a product name.');
            return;
        }

        const payload = {
            name,
            barcode: document.getElementById('food-product-barcode')?.value?.trim() || '',
            carbs_100g: parseFloat(document.getElementById('food-product-carbs')?.value) || 0,
            protein_100g: parseFloat(document.getElementById('food-product-protein')?.value) || 0,
            fat_100g: parseFloat(document.getElementById('food-product-fat')?.value) || 0,
            energy_kcal_100g: parseFloat(document.getElementById('food-product-calories')?.value) || 0
        };

        try {
            const result = await window.apiCall(`/api/food/products/${id}`, 'PUT', payload);
            if (!result) {
                window.safeAlert?.('Failed to update product.');
                return;
            }

            window.closeFoodProductModal();
            foodProductsCache = [];
            if (window.MedTrackerDB?.FoodProductsStore) {
                await window.MedTrackerDB.FoodProductsStore.clearCache();
            }
            await window.initFoodProductsCache();
            window.renderFoodAutocomplete(foodProductsCache, false, null, false);
            window.safeAlert?.('Product updated.');
        } catch (_e) {
            window.safeAlert?.('Failed to update product.');
        }
    };

    window.deleteFoodProduct = async function (id, displayName) {
        if (!id) return;
        if (!confirm(`Delete "${displayName}" from your food database?`)) return;
        try {
            const result = await window.apiCall(`/api/food/products/${id}`, 'DELETE');
            if (!result) {
                window.safeAlert?.('Failed to delete product.');
                return;
            }

            foodProductsCache = [];
            if (window.MedTrackerDB?.FoodProductsStore) {
                await window.MedTrackerDB.FoodProductsStore.clearCache();
            }
            await window.initFoodProductsCache();
            window.renderFoodAutocomplete(foodProductsCache, false, null, false);
        } catch (_e) {
            window.safeAlert?.('Failed to delete product.');
        }
    };

    window.setFoodScannerStatus = function (message) {
        const status = document.getElementById('food-scanner-status');
        if (status) status.innerText = message || '';
    };
    window.openFoodScannerModal = function () {
        window.ModalManager?.foodScanner?.open?.();
    };
    window.closeFoodScannerModal = function () {
        window.ModalManager?.foodScanner?.close?.();
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
        }
    };

    window.renderFoodData = function (groups, stats, period, date) {
        const list = document.getElementById('food-list');
        if (!list) return;
        list.replaceChildren();
        if (!groups?.length) { list.innerHTML = '<p class="hint" style="text-align:center;">No food logs for this day.</p>'; return; }

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
                const itemContent = document.createElement('div');
                const nameDiv = document.createElement('div'); nameDiv.style.fontWeight = '500'; nameDiv.textContent = l.name || 'Food';
                const metaDiv = document.createElement('div'); metaDiv.style.cssText = 'font-size:0.85em;color:var(--hint-color);'; metaDiv.textContent = `${l.weight}g \u2022 ${l.calories} kcal`;
                itemContent.appendChild(nameDiv); itemContent.appendChild(metaDiv);
                item.appendChild(itemContent);
                const del = document.createElement('button'); del.className = 'delete-btn'; del.textContent = '×';
                del.onclick = (e) => { e.stopPropagation(); window.deleteFoodLog(l.id); };
                item.appendChild(del); items.appendChild(item);
            });
            card.appendChild(items); list.appendChild(card);
        });

        // Render food summary
        const summary = document.getElementById('food-summary');
        if (summary && stats) {
            const periodLabel = period === 'week' ? 'Weekly Total' : 'Daily Total';
            const totalCalories = stats.calories || 0;
            const totalCarbs = stats.carbs || 0;
            const totalProtein = stats.protein || 0;
            const totalFat = stats.fat || 0;
            summary.innerHTML = `<div class="food-summary-row"><strong>${periodLabel}:</strong> ${totalCalories} kcal (C:${totalCarbs} P:${totalProtein} F:${totalFat})</div>`;
            if (typeof window.renderFoodTargetProgress === 'function') {
                window.renderFoodTargetProgress(totalCalories, totalCarbs, totalProtein, totalFat, period);
            }
        }
    };

    window.showAddFoodModal = function () {
        if (window.ModalManager && window.ModalManager.food) window.ModalManager.food.open();
        document.getElementById('food-modal-title').innerText = 'Log Food';
        document.getElementById('food-datetime').value = window.formatDateTimeLocalForInput();
        ['food-id', 'food-name', 'food-barcode', 'food-weight', 'food-carbs', 'food-protein', 'food-fat', 'food-calories'].forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.value = ''; delete el.dataset.baseKcal; }
        });
        document.getElementById('food-per-100g').checked = true;
        document.getElementById('food-weight').focus();
        window.initFoodProductsCache().then(() => window.renderFoodAutocomplete(foodProductsCache, false, null, false));
    };

    window.editFoodLog = function (id) {
        const log = window.currentFoodLogs[id]; if (!log) return;
        if (window.ModalManager && window.ModalManager.food) window.ModalManager.food.open();
        document.getElementById('food-modal-title').innerText = 'Edit Food';
        document.getElementById('food-id').value = log.id;
        document.getElementById('food-name').value = log.name || '';
        document.getElementById('food-barcode').value = log.barcode || '';
        document.getElementById('food-weight').value = log.weight || '';
        document.getElementById('food-per-100g').checked = log.weight > 0;
        if (log.weight > 0) {
            document.getElementById('food-carbs').value = +((log.carbs / log.weight) * 100).toFixed(1);
            document.getElementById('food-protein').value = +((log.protein / log.weight) * 100).toFixed(1);
            document.getElementById('food-fat').value = +((log.fat / log.weight) * 100).toFixed(1);
        } else {
            document.getElementById('food-carbs').value = log.carbs || '';
            document.getElementById('food-protein').value = log.protein || '';
            document.getElementById('food-fat').value = log.fat || '';
        }
        const calsRaw = document.getElementById('food-calories');
        calsRaw.value = log.calories !== undefined ? log.calories : '';
        delete calsRaw.dataset.baseKcal;
        document.getElementById('food-datetime').value = window.formatDateTimeLocalForInput(log.eaten_at);
        document.getElementById('food-weight').focus();
    };

    window.saveFoodLog = async function () {
        const name = document.getElementById('food-name').value, dt = document.getElementById('food-datetime').value;
        if (!dt) { window.safeAlert("Please enter date."); return; }
        const w = parseFloat(document.getElementById('food-weight').value) || 0, c = parseFloat(document.getElementById('food-carbs').value) || 0, p = parseFloat(document.getElementById('food-protein').value) || 0, f = parseFloat(document.getElementById('food-fat').value) || 0;
        const calsRaw = parseFloat(document.getElementById('food-calories').value);
        const per100 = document.getElementById('food-per-100g').checked, mult = per100 ? w / 100 : 1;
        if (per100 && w <= 0) { window.safeAlert("Please enter weight for per 100g mode, or uncheck it."); return; }
        const payload = {
            eaten_at: new Date(dt).toISOString(), name, barcode: document.getElementById('food-barcode').value,
            weight: w, per_100g: per100, carbs: Math.round(c * mult), protein: Math.round(p * mult), fat: Math.round(f * mult), calories: !isNaN(calsRaw) ? Math.round(calsRaw) : Math.round((4 * c * mult) + (4 * p * mult) + (9 * f * mult))
        };
        const id = document.getElementById('food-id').value;
        try {
            if (id) await window.apiCall(`/api/food/log/${id}`, 'PUT', payload);
            else await window.apiCall('/api/food/log', 'POST', payload);
            window.closeFoodModal();
            window.loadFoodLogs();
        } catch (e) { window.safeAlert("Failed to save food log."); }
    };

    window.deleteFoodLog = async function (id) {
        if (!confirm("Delete this food log?")) return;
        try { await window.apiCall(`/api/food/log/${id}`, 'DELETE'); window.loadFoodLogs(); }
        catch (e) { window.safeAlert("Failed to delete."); }
    };

    function createFoodBarcodeDetector() {
        if (!window.BarcodeDetector) return null;
        if (foodBarcodeDetector) return foodBarcodeDetector;

        const formats = [
            'qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'
        ];
        try {
            foodBarcodeDetector = new BarcodeDetector({ formats });
        } catch (e) {
            console.error('Failed to create BarcodeDetector with formats, retrying default:', e);
            foodBarcodeDetector = new BarcodeDetector();
        }
        return foodBarcodeDetector;
    }
    window.createFoodBarcodeDetector = createFoodBarcodeDetector;

    function sanitizeScannedValue(rawValue) {
        if (!rawValue) return { text: '', numeric: '' };
        const text = String(rawValue).replace(/\u200B/g, '').trim();
        const digitsOnly = text.replace(/\D/g, '');
        const numeric = digitsOnly.length >= FOOD_NUMERIC_BARCODE_MIN_LEN ? digitsOnly : '';
        return { text, numeric };
    }
    window.sanitizeScannedValue = sanitizeScannedValue;

    function handleDecodedValue(rawValue) {
        const { text, numeric } = sanitizeScannedValue(rawValue);
        if (!text) return false;

        if (numeric) {
            const barcodeInput = document.getElementById('food-barcode');
            if (barcodeInput) barcodeInput.value = numeric;
            window.onFoodBarcodeChange();
        } else {
            const nameInput = document.getElementById('food-name');
            if (nameInput) nameInput.value = text;
            if (typeof window.safeAlert === 'function') window.safeAlert('Scanned QR text was added to Food Name.');
        }
        window.closeFoodScannerModal();
        return true;
    }
    window.handleDecodedValue = handleDecodedValue;

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
            window.setFoodScannerStatus('Camera requires HTTPS (or localhost). Use "Use Photo" or manual entry.');
            return;
        }

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            window.setFoodScannerStatus('Camera is unavailable. Use "Use Photo" or manual entry.');
            return;
        }

        if (!window.BarcodeDetector) {
            window.setFoodScannerStatus('Live scan is unavailable on this browser. Use "Use Photo".');
            return;
        }

        const video = document.getElementById('food-scanner-video');
        try {
            window.setFoodScannerStatus('Requesting camera access...');
            foodScannerStream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: { facingMode: { ideal: 'environment' } }
            });
            video.srcObject = foodScannerStream;
            await video.play();
            window.setFoodScannerStatus('Point camera at barcode or QR.');
            foodScannerRunning = true;
            scanFrameLoop();
        } catch (e) {
            console.error('Failed to start food scanner:', e);
            window.setFoodScannerStatus('Camera access denied or unavailable. Use "Use Photo".');
        }
    }
    window.startFoodScanner = startFoodScanner;

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
    window.stopFoodScanner = stopFoodScanner;

    window.closeFoodModal = function () {
        if (window.ModalManager && window.ModalManager.food) window.ModalManager.food.close();
    };

    window.renderFoodTargetProgress = function (calories, carbs, protein, fat, period) {
        const container = document.getElementById('food-target-progress');
        if (!container) return;
        container.replaceChildren();

        const targets = window.foodTargets || {};
        const mult = period === 'week' ? 7 : 1;
        const tCal = (targets.calories || 0) * mult;
        const tCarbs = (targets.carbs || 0) * mult;
        const tProtein = (targets.protein || 0) * mult;
        const tFat = (targets.fat || 0) * mult;

        if (tCal <= 0 && tCarbs <= 0 && tProtein <= 0 && tFat <= 0) {
            container.classList.add('hidden');
            return;
        }
        container.classList.remove('hidden');

        const rows = [
            { label: 'Energy', current: calories, target: tCal, unit: 'kcal' },
            { label: 'Carbs', current: carbs, target: tCarbs, unit: 'g' },
            { label: 'Protein', current: protein, target: tProtein, unit: 'g' },
            { label: 'Fat', current: fat, target: tFat, unit: 'g' }
        ];

        rows.forEach(r => {
            const row = document.createElement('div');
            row.className = 'food-target-row';

            const labelEl = document.createElement('div');
            labelEl.className = 'food-target-label';
            labelEl.textContent = r.label;

            const values = document.createElement('div');
            values.className = 'food-target-values';
            const isExcess = r.target > 0 && r.current > r.target;
            if (isExcess) values.classList.add('excess-text');
            values.textContent = `${r.current} / ${r.target} ${r.unit}`;

            const bar = document.createElement('div');
            bar.className = 'food-target-bar';
            const fill = document.createElement('div');
            fill.className = 'food-target-fill';
            const pct = r.target > 0 ? Math.min((r.current / r.target) * 100, 100) : 0;
            fill.style.width = pct + '%';
            if (isExcess) fill.classList.add('excess');
            bar.appendChild(fill);

            row.appendChild(labelEl);
            row.appendChild(values);
            row.appendChild(bar);
            container.appendChild(row);
        });
    };

    window._renderFoodData = window.renderFoodData;

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

        bindClick('food-modal-cancel-btn', () => window.closeFoodModal());
        bindClick('food-modal-save-btn', () => window.saveFoodLog());
        bindClick('food-scan-btn', () => window.openFoodScannerModal());
        bindClick('food-scanner-close-btn', () => window.closeFoodScannerModal());
        bindClick('food-scanner-use-photo-btn', () => window.safeAlert?.('Photo scan is unavailable in this build yet.'));
        bindClick('food-product-cancel-btn', () => window.closeFoodProductModal());
        bindClick('food-product-save-btn', () => window.saveFoodProduct());

        bindInput('food-name', () => window.onFoodNameChange());
        bindInput('food-barcode', () => window.onFoodBarcodeChange());
        bindInput('food-weight', () => window.calculateFoodCalories());
        bindInput('food-carbs', () => window.calculateFoodCalories());
        bindInput('food-protein', () => window.calculateFoodCalories());
        bindInput('food-fat', () => window.calculateFoodCalories());
        bindInput('food-calories', function () {
            delete this.dataset.baseKcal;
        });
        bindChange('food-per-100g', () => window.calculateFoodCalories());

        const nameInput = document.getElementById('food-name');
        if (nameInput) nameInput.addEventListener('focus', () => window.onFoodNameFocus());

        if (!foodOutsideClickBound) {
            foodOutsideClickBound = true;
            document.addEventListener('click', (e) => {
                const list = document.getElementById('food-autocomplete-list');
                const input = document.getElementById('food-name');
                if (!list || !input) return;
                if (e.target !== input && e.target !== list && !list.contains(e.target)) {
                    list.classList.add('hidden');
                }
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindFoodControls, { once: true });
    }
    bindFoodControls();
})();
