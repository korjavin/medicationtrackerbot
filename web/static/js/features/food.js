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
        if (!groups?.length) { list.innerHTML = '<p class="hint" style="text-align:center;">No logs for this day.</p>'; return; }

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
        const payload = {
            eaten_at: new Date(dt).toISOString(), name, barcode: document.getElementById('food-barcode').value,
            weight: w, carbs: Math.round(c * mult), protein: Math.round(p * mult), fat: Math.round(f * mult), calories: !isNaN(calsRaw) ? Math.round(calsRaw) : Math.round((4 * c * mult) + (4 * p * mult) + (9 * f * mult))
        };
        const id = document.getElementById('food-id').value;
        try {
            if (id) await window.apiCall(`/api/food/log/${id}`, 'PUT', payload);
            else await window.apiCall('/api/food/log', 'POST', payload);
            if (window.ModalManager && window.ModalManager.food) window.ModalManager.food.close();
            window.loadFoodLogs();
        } catch (e) { window.safeAlert("Failed to save food log."); }
    };

    window.deleteFoodLog = async function (id) {
        if (!confirm("Delete this food log?")) return;
        try { await window.apiCall(`/api/food/log/${id}`, 'DELETE'); window.loadFoodLogs(); }
        catch (e) { window.safeAlert("Failed to delete food log."); }
    };

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
        bindInput('food-calories', function () {
            delete this.dataset.baseKcal;
        });
        bindChange('food-per-100g', () => window.calculateFoodCalories());
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindFoodControls, { once: true });
    }
    bindFoodControls();
})();
