// ====================================
// FOOD DB — browse + paginate the user's product catalogue
// ====================================
//
// Owns the Food DB panel inside the collapsible library entry:
//   - paginated GET /api/food/products with usage / last_used / name sort
//   - search input debounce + page clamping when results shrink
//   - per-card edit/delete handoff to products.js modal flow
//
// Closure-private state — page index, sort key, query, total — is exposed
// via window.FoodDB getters/setters so the orchestrator's search input
// handler (index.js) can mutate it without touching internals directly.

(function () {
    let foodDBPage = 0;
    let foodDBSort = 'usage';
    let foodDBQuery = '';
    let foodDBTotal = 0;

    window.FoodDB = window.FoodDB || {};
    Object.defineProperty(window.FoodDB, 'page', {
        get: () => foodDBPage,
        set: (v) => { foodDBPage = Number(v) || 0; },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(window.FoodDB, 'sort', {
        get: () => foodDBSort,
        set: (v) => { foodDBSort = v || 'usage'; },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(window.FoodDB, 'query', {
        get: () => foodDBQuery,
        set: (v) => { foodDBQuery = v || ''; },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(window.FoodDB, 'total', {
        get: () => foodDBTotal,
        set: (v) => { foodDBTotal = Number(v) || 0; },
        enumerable: true,
        configurable: true
    });
})();

async function loadFoodDB() {
    const list = document.getElementById('fooddb-list');
    list.innerHTML = '<p class="wg-food-db-panel__empty">Loading products...</p>';

    const limit = 20;
    const offset = window.FoodDB.page * limit;

    try {
        const queryParams = new URLSearchParams({
            is_meal: 'false',
            limit: limit.toString(),
            offset: offset.toString(),
            sort: window.FoodDB.sort,
        });
        if (window.FoodDB.query) {
            queryParams.append('q', window.FoodDB.query);
        }

        const resp = await apiCall(`/api/food/products?${queryParams.toString()}`, 'GET');
        if (!resp) return;

        window.FoodDB.total = resp.total || 0;

        // If we paged past the new end, clamp and reload.
        if (window.FoodDB.page > 0 && window.FoodDB.page * limit >= window.FoodDB.total) {
            window.FoodDB.page = Math.max(0, Math.ceil(window.FoodDB.total / limit) - 1);
            loadFoodDB();
            return;
        }

        renderFoodDBList(resp.products || [], window.FoodDB.total);
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
        prevBtn.disabled = window.FoodDB.page === 0;
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
        const p100 = Math.round(p.protein_100g);
        const f100 = Math.round(p.fat_100g * 10) / 10;
        const e100 = Math.round(p.energy_kcal_100g);
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

    const limit = 20;
    const start = window.FoodDB.page * limit + 1;
    const end = Math.min((window.FoodDB.page + 1) * limit, total);

    pagination.classList.toggle('hidden', total <= 0);
    pageInfo.textContent = `Showing ${start}-${end} of ${total}`;

    prevBtn.disabled = window.FoodDB.page === 0;
    nextBtn.disabled = (window.FoodDB.page + 1) * limit >= total;
}

window.FoodDB.load = loadFoodDB;
window.FoodDB.render = renderFoodDBList;
