// ====================================
// FOOD ADD SHEET — kit F4–F7 (med-xso6.17)
// ====================================
//
// Owns #food-add-sheet, the one place food gets logged from:
//   - home: search (local foods first, the food database on request) with
//     inline portion picks and a "Add 150 g · 248 kcal" primary; Scan /
//     Photo / Describe tiles; Recent items that re-log in one tap;
//     "Enter manually" hands off to the manual form (#food-modal, log.js)
//   - describe: free text + a meal pick preset from the time → Estimate
//   - review: the AI's parsed items (photo or describe) before anything is
//     saved. Rows are editable, uncertain ones carry a warn chip; Log commits
//     them through CloudFoodAI.logParsedItems, then the Undo toast follows.
// The time chip (hidden datetime-local + showPicker) replaces the datetime
// field; null means "now" at the moment of the write.
//
// Entry points (window.FoodLog.addSheet): open({view, eatenAt}),
// startPhotoReview(file, eatenAt) — photo.js, and onScan(rawText, numeric)
// — scanner.js when the manual form is not the one scanning.

(function () {
    const MEAL_HOURS = { Breakfast: 8, Lunch: 13, Dinner: 19, Snack: 22 };
    const PORTIONS = [100, 150, 200];
    const RECENT_DAYS = 14;
    const RECENT_MAX = 5;
    const SEARCH_DEBOUNCE_MS = 300;

    const st = {
        view: 'home',
        eatenAt: null,
        results: [],
        remoteSearched: false,
        picked: null,
        searchTimer: undefined,
        searchSeq: 0,
        review: null,
        reviewSource: 'photo',
        reviewSeq: 0,
    };

    const $ = (id) => document.getElementById(id);

    function icon(name, size) {
        const ico = document.createElement('i');
        ico.className = size === 14 ? 'wg-ico wg-ico--sm' : 'wg-ico';
        ico.appendChild(window.WGIcons.iconSvg(name, { size: size || 18 }));
        return ico;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function hhmm(d) {
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    // Same buckets as web/domain/food.js mealNameForHour (the log's groups).
    function mealFor(d) {
        const h = d.getHours();
        if (h >= 5 && h < 11) return 'Breakfast';
        if (h >= 11 && h < 16) return 'Lunch';
        if (h >= 16 && h < 22) return 'Dinner';
        return 'Snack';
    }

    function when() {
        return st.eatenAt || new Date();
    }

    function timeLabel() {
        if (!st.eatenAt) return `Now ${hhmm(new Date())}`;
        const day = toISODateLocal(st.eatenAt);
        return `${foodRelativeDay(day) || formatFoodDateSubtitle(day).slice(0, 5)} ${hhmm(st.eatenAt)}`;
    }

    function kcal100(p) {
        const k = Number(p.energy_kcal_100g);
        if (k > 0) return k;
        return 4 * (Number(p.carbs_100g) || 0) + 4 * (Number(p.protein_100g) || 0) + 9 * (Number(p.fat_100g) || 0);
    }

    function pickedTotals() {
        const { product: p, grams } = st.picked;
        const f = grams / 100;
        return {
            carbs: Math.round((Number(p.carbs_100g) || 0) * f),
            protein: Math.round((Number(p.protein_100g) || 0) * f),
            fat: Math.round((Number(p.fat_100g) || 0) * f),
            calories: Math.round(kcal100(p) * f),
        };
    }

    // ---- view + chrome ----------------------------------------------------

    function renderHead() {
        const eyebrow = $('food-add-eyebrow');
        const back = $('food-add-back-btn');
        const n = st.review ? st.review.length : 0;
        if (eyebrow) {
            eyebrow.textContent = {
                home: mealFor(when()),
                describe: 'Describe · AI',
                review: st.review ? `Review · ${n} item${n === 1 ? '' : 's'}` : 'Estimating…',
            }[st.view];
        }
        if (back) {
            back.classList.toggle('hidden', st.view === 'home');
            const label = $('food-add-back-label');
            if (label) label.textContent = st.view === 'review' && st.reviewSource === 'description' ? 'Edit' : 'Back';
        }
        const time = $('food-add-time-label');
        if (time) time.textContent = timeLabel();
        document.querySelectorAll('#food-add-meal-picks .wg-pick').forEach((b) => {
            b.setAttribute('aria-pressed', b.dataset.meal === mealFor(when()) ? 'true' : 'false');
        });
    }

    function renderFoot() {
        const foot = $('food-add-foot');
        const primary = $('food-add-primary-btn');
        const discard = $('food-add-discard-btn');
        if (!foot || !primary) return;
        let label = '';
        if (st.view === 'home' && st.picked) {
            label = `Add ${st.picked.grams} g · ${pickedTotals().calories} kcal`;
        } else if (st.view === 'describe') {
            label = 'Estimate';
        } else if (st.view === 'review') {
            const n = st.review ? st.review.length : 0;
            label = st.review ? `Log ${n} item${n === 1 ? '' : 's'}` : 'Estimating…';
        }
        foot.classList.toggle('hidden', !label);
        primary.textContent = label;
        if (!primary.hasAttribute('data-submit-in-flight')) {
            primary.disabled = st.view === 'review' && !(st.review && st.review.length);
        }
        if (discard) discard.classList.toggle('hidden', st.view !== 'review');
    }

    function setView(view) {
        st.view = view;
        const sheet = $('food-add-sheet');
        if (sheet) sheet.dataset.view = view;
        document.querySelectorAll('#food-add-sheet .wg-food-add__pane').forEach((pane) => {
            pane.classList.toggle('hidden', pane.dataset.pane !== view);
        });
        renderHead();
        renderFoot();
    }

    function isOpen() {
        const sheet = $('food-add-sheet');
        return !!sheet && !sheet.classList.contains('hidden');
    }

    function open(opts) {
        const o = opts || {};
        st.eatenAt = o.eatenAt instanceof Date && !Number.isNaN(o.eatenAt.getTime()) ? o.eatenAt : null;
        st.picked = null;
        st.results = [];
        st.remoteSearched = false;
        st.review = null;
        st.reviewSeq++;
        cancelSearch();
        const search = $('food-add-search');
        if (search) search.value = '';
        const text = $('food-add-describe-text');
        if (text) text.value = '';
        renderResults();
        setSearchStatus('');
        resetFoodTimeInput($('food-add-datetime'));
        window.ModalManager.foodAdd.open();
        setView(o.view || 'home');
        loadRecent();
        if (st.view === 'describe' && text) text.focus();
        if (o.focusSearch && search) search.focus();
    }

    function close() {
        cancelSearch();
        st.reviewSeq++;
        window.ModalManager.foodAdd.close();
    }

    function back() {
        if (st.view === 'review' && st.reviewSource === 'description') {
            st.reviewSeq++;
            st.review = null;
            setView('describe');
        } else {
            st.reviewSeq++;
            st.review = null;
            setView('home');
        }
    }

    // ---- time chip ----------------------------------------------------------

    function openTimePicker() {
        const input = $('food-add-datetime');
        if (!input) return;
        input.value = formatDateTimeLocalForInput(when());
        openFoodTimeInput(input);
    }

    function onTimeChange() {
        const input = $('food-add-datetime');
        const d = input && input.value ? new Date(input.value) : null;
        if (d && !Number.isNaN(d.getTime())) st.eatenAt = d;
        renderHead();
    }

    // The meal pick only moves the time: the log groups by hour.
    function pickMeal(meal) {
        if (!MEAL_HOURS[meal] || mealFor(when()) === meal) return;
        const d = new Date(when().getTime());
        d.setHours(MEAL_HOURS[meal], 0, 0, 0);
        st.eatenAt = d;
        renderHead();
    }

    // ---- search -------------------------------------------------------------

    function setSearchStatus(text) {
        const status = $('food-add-search-status');
        if (!status) return;
        status.textContent = text || '';
        status.classList.toggle('hidden', !text);
    }

    function cancelSearch() {
        if (st.searchTimer !== undefined) clearTimeout(st.searchTimer);
        st.searchTimer = undefined;
        st.searchSeq++;
    }

    function onSearchInput() {
        cancelSearch();
        const q = ($('food-add-search').value || '').trim();
        st.picked = null;
        st.remoteSearched = false;
        if (q.length < 2) {
            st.results = [];
            renderResults();
            setSearchStatus('');
            renderFoot();
            return;
        }
        st.searchTimer = setTimeout(() => runSearch(q, false), SEARCH_DEBOUNCE_MS);
    }

    async function remoteConfigured() {
        const s = window.CloudFoodSearch;
        if (!s || typeof s.remoteConfigured !== 'function') return true;
        try { return !!(await s.remoteConfigured()); } catch (_) { return false; }
    }

    async function runSearch(q, remote) {
        const seq = ++st.searchSeq;
        if (remote && !(await remoteConfigured())) {
            if (seq !== st.searchSeq) return;
            setSearchStatus('Food database not configured. Add one in Settings → Integrations.');
            return;
        }
        setSearchStatus(remote ? 'Searching the food database…' : 'Searching…');
        let found;
        try {
            found = await window.CloudFoodSearch.search(q, { remote: !!remote });
        } catch (e) {
            if (seq !== st.searchSeq) return;
            console.error('Food search failed', e);
            setSearchStatus('Search failed. Try again.');
            return;
        }
        if (seq !== st.searchSeq) return;
        st.results = Array.isArray(found) ? found : [];
        st.remoteSearched = !!remote;
        setSearchStatus(st.results.length ? '' : (remote ? 'Nothing found.' : 'No saved foods match.'));
        renderResults();
        if (!remote && st.results.length === 0) runSearch(q, true);
    }

    function productName(p) {
        return decodeFoodDisplayText(p.name) || 'Food';
    }

    function resultRow(p) {
        const isPicked = st.picked && st.picked.product === p;
        const row = el(isPicked ? 'div' : 'button', isPicked ? 'wg-row wg-row--pad wg-food-add__result' : 'wg-row wg-food-add__result');
        if (!isPicked) row.type = 'button';
        const body = el('span', 'wg-row__body');
        body.appendChild(el('span', 'wg-row__title', productName(p)));
        const meta = el('span', 'wg-row__meta', `${Math.round(kcal100(p))} kcal / 100 g`);
        if (p.id) meta.appendChild(el('span', 'wg-tag', p.is_meal ? 'Meal' : 'Mine'));
        else meta.appendChild(document.createTextNode(' · Food database'));
        body.appendChild(meta);
        row.appendChild(body);
        if (isPicked) {
            body.appendChild(portionPicks(p));
        } else {
            const chev = icon('chev-r');
            chev.classList.add('wg-row__chev');
            row.appendChild(chev);
            row.addEventListener('click', () => pick(p));
        }
        return row;
    }

    function portionPicks(p) {
        const picks = el('span', 'wg-picks wg-food-add__portions');
        picks.setAttribute('role', 'group');
        picks.setAttribute('aria-label', 'Portion');
        const grams = PORTIONS.slice();
        if (p.is_meal && p.total_weight_g > 0 && grams.indexOf(p.total_weight_g) === -1) grams.unshift(p.total_weight_g);
        const custom = grams.indexOf(st.picked.grams) === -1;
        for (const g of grams) {
            const b = el('button', 'wg-pick', String(g));
            b.type = 'button';
            b.dataset.grams = String(g);
            b.appendChild(el('small', '', 'g'));
            b.setAttribute('aria-pressed', st.picked.grams === g ? 'true' : 'false');
            b.addEventListener('click', () => setGrams(g));
            picks.appendChild(b);
        }
        const other = el('button', 'wg-pick', custom ? `${st.picked.grams}` : 'Other');
        other.type = 'button';
        other.dataset.grams = 'other';
        if (custom) other.appendChild(el('small', '', 'g'));
        other.setAttribute('aria-pressed', custom ? 'true' : 'false');
        other.addEventListener('click', async () => {
            const v = await safePrompt('', {
                title: 'How many grams?', label: 'Grams', value: String(st.picked.grams),
                inputMode: 'decimal', confirmLabel: 'Use', emptyError: 'Enter the grams.',
            });
            const g = Math.round(parseFloat(v));
            if (g > 0 && st.picked) setGrams(g);
        });
        picks.appendChild(other);
        return picks;
    }

    function setGrams(g) {
        if (!st.picked) return;
        st.picked.grams = g;
        renderResults();
        renderFoot();
    }

    function pick(p) {
        const grams = p.is_meal && p.total_weight_g > 0 ? p.total_weight_g : 100;
        st.picked = { product: p, grams };
        renderResults();
        renderFoot();
    }

    function renderResults() {
        const list = $('food-add-results');
        const recent = $('food-add-recent-section');
        if (!list) return;
        list.replaceChildren();
        const q = (($('food-add-search') || {}).value || '').trim();
        const searching = q.length >= 2;
        for (const p of st.results.slice(0, 30)) list.appendChild(resultRow(p));
        if (searching && !st.remoteSearched) {
            const more = el('button', 'wg-row wg-food-add__more');
            more.type = 'button';
            const body = el('span', 'wg-row__body');
            body.appendChild(el('span', 'wg-row__title', 'Search the food database'));
            more.appendChild(body);
            more.appendChild(icon('search'));
            more.addEventListener('click', () => runSearch(q, true));
            list.appendChild(more);
        }
        list.classList.toggle('hidden', !list.children.length);
        if (recent) recent.classList.toggle('hidden', searching || !(($('food-add-recent') || {}).children || []).length);
    }

    function logPicked() {
        if (!st.picked) return null;
        const p = st.picked.product;
        const t = pickedTotals();
        const payload = {
            eaten_at: when().toISOString(),
            weight: st.picked.grams,
            carbs: t.carbs,
            protein: t.protein,
            fat: t.fat,
            calories: t.calories,
            name: productName(p),
            barcode: p.barcode || '',
            per_100g: false,
        };
        // A database hit has no id: the bare name upserts it into "Mine".
        if (p.id) payload.product_id = p.id;
        return submitWrite(payload, `${payload.name} · ${payload.weight} g`);
    }

    async function submitWrite(payload, label) {
        let res = null;
        await withSubmit($('food-add-primary-btn'), async () => {
            try {
                res = await writeFoodLog(payload);
            } catch (e) {
                console.error('Food log failed:', e);
                safeToast(`Failed to log food: ${e && e.message ? e.message : e}`, 'error');
                return;
            }
            if (!res) return;
            close();
            safeToast(`Logged ${label}`, 'success');
        });
        return res;
    }

    // ---- scan ---------------------------------------------------------------

    async function lookupBarcode(code) {
        const search = window.CloudFoodSearch;
        if (!search) return null;
        const local = await search.search(code, { remote: false });
        const hit = (local || []).find((p) => p.barcode === code);
        if (hit || !(await remoteConfigured())) return hit || null;
        const merged = await search.search(code, { remote: true });
        return (merged || []).find((p) => p.barcode === code) || null;
    }

    async function onScan(text, numeric) {
        if (!isOpen()) open();
        const input = $('food-add-search');
        if (!numeric) {
            if (input) input.value = text;
            cancelSearch();
            st.picked = null;
            await runSearch(text.trim(), false);
            return;
        }
        cancelSearch();
        const seq = st.searchSeq;
        setSearchStatus('Looking up the barcode…');
        let hit = null;
        try {
            hit = await lookupBarcode(numeric);
        } catch (e) {
            console.error('Barcode lookup failed', e);
        }
        if (seq !== st.searchSeq) return;
        if (!hit) {
            setSearchStatus('');
            safeToast('No product found for that barcode. Enter it once and it will be found next time.', 'info');
            openManual({ barcode: numeric });
            return;
        }
        if (input) input.value = productName(hit);
        st.results = [hit];
        st.remoteSearched = true;
        setSearchStatus('');
        pick(hit);
    }

    // ---- recent -------------------------------------------------------------

    async function loadRecent() {
        const list = $('food-add-recent');
        if (!list) return;
        let groups = [];
        try {
            const raw = await apiCall(`/api/food/log?date=${toISODateLocal(new Date())}&days=${RECENT_DAYS}`, 'GET');
            groups = Array.isArray(raw) ? raw : [];
        } catch (_) {
            groups = [];
        }
        const logs = [];
        for (const g of groups) for (const l of (g && g.logs) || []) if (l && l.name) logs.push(l);
        logs.sort((a, b) => (Date.parse(b.eaten_at) || 0) - (Date.parse(a.eaten_at) || 0));
        const seen = new Set();
        const recent = [];
        for (const l of logs) {
            const key = l.product_id ? `p:${l.product_id}` : `n:${String(l.name).toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            recent.push(l);
            if (recent.length >= RECENT_MAX) break;
        }
        list.replaceChildren(...recent.map(recentRow));
        renderResults();
    }

    function recentRow(log) {
        const row = el('div', 'wg-row wg-food-add__recent');
        const body = el('span', 'wg-row__body');
        body.appendChild(el('span', 'wg-row__title', log.name));
        const meta = el('span', 'wg-row__meta', `${Math.round(log.weight || 0)} g · ${Math.round(log.calories || 0)} kcal`);
        if (log.is_meal) meta.appendChild(el('span', 'wg-tag', 'Meal'));
        body.appendChild(meta);
        row.appendChild(body);
        const trail = el('span', 'wg-row__trail');
        const add = el('button', 'wg-btn wg-btn--icon wg-btn--sm');
        add.type = 'button';
        add.setAttribute('aria-label', `Add ${log.name} ${Math.round(log.weight || 0)} g`);
        add.appendChild(icon('plus'));
        add.addEventListener('click', () => withSubmit(add, () => relog(log)));
        trail.appendChild(add);
        row.appendChild(trail);
        return row;
    }

    function relog(log) {
        const payload = {
            eaten_at: when().toISOString(),
            weight: log.weight || 0,
            carbs: log.carbs || 0,
            protein: log.protein || 0,
            fat: log.fat || 0,
            calories: log.calories || 0,
            name: log.name,
            per_100g: false,
        };
        if (log.product_id) payload.product_id = log.product_id;
        return submitWrite(payload, `${log.name} · ${Math.round(log.weight || 0)} g`);
    }

    // ---- describe + review --------------------------------------------------

    function openDescribe() {
        if (!isOpen()) open({ view: 'describe' });
        else setView('describe');
        const text = $('food-add-describe-text');
        if (text) text.focus();
    }

    function withConsent(fn) {
        const tc = window.TrialConsent;
        return tc && typeof tc.retryAfterConsent === 'function' ? tc.retryAfterConsent(fn) : fn();
    }

    async function runReview(source, parse, onFail) {
        st.reviewSource = source;
        st.review = null;
        const seq = ++st.reviewSeq;
        setView('review');
        const list = $('food-add-review-list');
        if (list) list.replaceChildren(createSkeleton('row', 3));
        let result;
        try {
            result = await withConsent(parse);
        } catch (e) {
            if (seq !== st.reviewSeq) return;
            console.error('Food AI parse failed:', e);
            safeToast(`${source === 'photo' ? 'Could not read the photo' : 'Failed to parse meal'}: ${e && e.message ? e.message : e}`, 'error');
            onFail();
            return;
        }
        if (seq !== st.reviewSeq) return;
        st.review = (result && Array.isArray(result.items) ? result.items : []).map((it) => ({ ...it }));
        renderReview();
    }

    function estimate() {
        const description = (($('food-add-describe-text') || {}).value || '').trim();
        if (!description) {
            safeAlert('Please describe your meal.');
            return null;
        }
        return runReview('description',
            () => window.CloudFoodAI.parseMealFromDescription(description, { dryRun: true }),
            () => setView('describe'));
    }

    function startPhotoReview(file, eatenAt) {
        if (!isOpen()) open({ eatenAt });
        else if (eatenAt instanceof Date) st.eatenAt = eatenAt;
        return runReview('photo',
            () => window.CloudFoodAI.parseMealFromPhoto(file, { dryRun: true }),
            () => { st.review = null; setView('home'); });
    }

    // Display-only recompute (web/domain/food.js calculateMacros); the commit
    // recomputes in the domain from the same per-100g values.
    function recompute(item, grams) {
        const c = Math.trunc((item.carbs_100g * grams) / 100);
        const p = Math.trunc((item.protein_100g * grams) / 100);
        const f = Math.trunc((item.fat_100g * grams) / 100);
        return { ...item, weight: grams, carbs: c, protein: p, fat: f, calories: 4 * c + 4 * p + 9 * f };
    }

    function reviewRow(item, i) {
        const row = el('div', 'wg-row wg-food-add__review-row');
        row.dataset.index = String(i);
        const body = el('span', 'wg-row__body');
        body.appendChild(el('span', 'wg-row__title', item.name));
        const meta = el('span', 'wg-row__meta', `${Math.round(item.weight)} g · P ${Math.round(item.protein)} · F ${Math.round(item.fat)}`);
        if (item.uncertain) meta.appendChild(window.WGChip.create({ text: 'estimate', state: 'warn', small: true }));
        body.appendChild(meta);
        row.appendChild(body);
        const value = el('span', 'wg-row__value wg-row__value--sun', String(Math.round(item.calories)));
        value.appendChild(el('small', '', 'kcal'));
        row.appendChild(value);
        const trail = el('span', 'wg-row__trail');
        row.appendChild(trail);
        return window.WGRowActions.attach(row, {
            label: item.name,
            trail,
            tapEdits: true,
            onEdit: () => editReviewItem(i),
            onDelete: () => { st.review.splice(i, 1); renderReview(); },
        });
    }

    function renderReview() {
        const list = $('food-add-review-list');
        if (!list || !st.review) return;
        list.replaceChildren(...st.review.map(reviewRow));
        if (!st.review.length) {
            list.appendChild(createEmptyState({ icon: 'food', title: 'Nothing to log', body: 'The AI found no food. Go back and try again.', inline: true }));
        }
        const total = $('food-add-review-total');
        if (total) total.textContent = `${Math.round(st.review.reduce((s, it) => s + (Number(it.calories) || 0), 0))} kcal`;
        renderHead();
        renderFoot();
    }

    async function editReviewItem(i) {
        const item = st.review && st.review[i];
        if (!item) return;
        const content = el('div', 'wg-vstack');
        const field = (labelText, input) => {
            const f = el('label', 'wg-field');
            f.appendChild(el('span', 'wg-label', labelText));
            f.appendChild(input);
            return f;
        };
        const name = el('input', 'wg-input wg-input--text');
        name.value = item.name;
        const grams = el('input', 'wg-input');
        grams.type = 'number';
        grams.inputMode = 'decimal';
        grams.value = String(item.weight);
        content.append(field('Name', name), field('Grams', grams));
        const choice = await safeForm('', content, {
            title: 'Edit item',
            confirmLabel: 'Done',
            collect: () => {
                const g = Math.round(parseFloat(grams.value));
                if (!name.value.trim() || !(g > 0)) return null;
                return { name: name.value.trim(), grams: g };
            },
        });
        if (!choice || !st.review || st.review[i] !== item) return;
        st.review[i] = { ...recompute(item, choice.grams), name: choice.name };
        renderReview();
    }

    async function commitReview() {
        const items = st.review ? st.review.slice() : [];
        if (!items.length) return;
        const eatenAt = when();
        const source = st.reviewSource;
        await withSubmit($('food-add-primary-btn'), async () => {
            const iso = eatenAt.toISOString();
            const stamp = Date.now();
            const pending = items.map((it, i) => ({
                id: `local_${stamp}_${i}`, name: it.name, weight: it.weight, carbs: it.carbs,
                protein: it.protein, fat: it.fat, calories: it.calories, eaten_at: iso,
                product_id: null, isLocal: true, pending: true,
            }));
            const day = toISODateLocal(eatenAt);
            const dayKey = typeof todayFoodKey === 'function' ? todayFoodKey(eatenAt) : `food_${day}_day`;
            const mutator = (includeWeekStats) => (prev) => {
                const next = buildOptimisticFoodCache(prev, pending[0], null, { includeWeekStats });
                const group = next.groups[next.groups.length - 1];
                group.logs = pending.slice();
                recomputeFoodGroupTotals(group);
                return next;
            };
            const ds = window.DataStore;
            const handles = [
                await ds.applyOptimistic(`food_${day}_v2`, mutator(true), ['food']),
                await ds.applyOptimistic(dayKey, mutator(false), ['food']),
            ];
            const settle = async (method) => {
                for (const h of handles) { try { await h[method](null); } catch (_) { /* best-effort */ } }
            };

            let res;
            try {
                // The description / photo never leave the device via /api:
                // CloudFoodAI is the browser-direct domain (web/domain/foodai.js).
                res = await window.CloudFoodAI.logParsedItems(items, { eatenAt: eatenAt.getTime() });
            } catch (e) {
                await settle('rollback');
                console.error('Food AI log failed:', e);
                safeToast(`Failed to log food: ${e && e.message ? e.message : e}`, 'error');
                return;
            }
            await settle('commit');
            const saved = Array.isArray(res && res.items) ? res.items : [];
            const failed = Math.max(0, Math.trunc(Number(res && res.failed) || 0));
            await ds.invalidateTags(['food', 'gamification']);
            if (typeof todayFoodKey === 'function' && ds.clearCached) await ds.clearCached(todayFoodKey(new Date()));
            close();
            loadFoodLogs();
            if (typeof loadToday === 'function') loadToday();
            if (typeof showFoodPhotoSummary === 'function') {
                let summary;
                summary = showFoodPhotoSummary({
                    items: saved, failed, source,
                    onUndo: () => undoFoodAIItems(saved, summary),
                });
            }
        });
    }

    function discard() {
        st.review = null;
        close();
    }

    function openManual(prefill) {
        const p = prefill || {};
        const name = p.name !== undefined ? p.name : (($('food-add-search') || {}).value || '').trim();
        const eatenAt = st.eatenAt;
        close();
        showManualFoodModal({ ...p, name, eatenAt });
    }

    function onPrimary() {
        if (st.view === 'home') return logPicked();
        if (st.view === 'describe') return estimate();
        if (st.view === 'review') return commitReview();
        return null;
    }

    function bind() {
        const on = (id, type, fn) => {
            const node = $(id);
            if (node) node.addEventListener(type, fn);
        };
        on('food-add-close-btn', 'click', () => close());
        on('food-add-back-btn', 'click', () => back());
        on('food-add-time-btn', 'click', () => openTimePicker());
        on('food-add-datetime', 'change', () => onTimeChange());
        on('food-add-search', 'input', () => onSearchInput());
        on('food-add-scan-btn', 'click', () => window.ModalManager.foodScanner.open());
        on('food-add-photo-btn', 'click', () => triggerFoodPhotoPicker());
        on('food-add-describe-btn', 'click', () => openDescribe());
        on('food-add-manual-btn', 'click', () => openManual());
        on('food-add-primary-btn', 'click', () => onPrimary());
        on('food-add-discard-btn', 'click', () => discard());
        document.querySelectorAll('#food-add-meal-picks .wg-pick').forEach((b) => {
            b.addEventListener('click', () => pickMeal(b.dataset.meal));
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind, { once: true });
    } else {
        bind();
    }

    window.FoodLog = window.FoodLog || {};
    window.FoodLog.addSheet = {
        open, close, isOpen, openDescribe, startPhotoReview, onScan, estimate, commitReview,
        logPicked, relog, loadRecent, runSearch, pick, setGrams, pickMeal, back,
        get state() { return st; },
    };
})();
