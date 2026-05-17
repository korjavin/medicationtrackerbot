// ====================================
// FOOD MEALS — My Meals list + save-as-meal flow
// ====================================
//
// Owns the My Meals section that lives behind the collapsible library
// entry, plus the multi-select + "Save as Meal" workflow that lets a user
// combine N existing logs into a reusable meal template (POST
// /api/food/products/from-logs).
//
// The multi-select state itself (foodMultiSelectMode + foodSelectedLogIds)
// lives in log.js because the item rows are rendered there; this file
// consumes the state via window.FoodLog accessors and triggers the
// post-save refresh through loadFoodLogs/loadMyMeals.

async function loadMyMeals() {
    const list = document.getElementById('food-meals-list');
    if (!list) return;

    let cache = window.FoodProducts && window.FoodProducts.cache;
    if (!cache || cache.length === 0) {
        await initFoodProductsCache();
        cache = window.FoodProducts.cache;
    }

    if (!cache) return;

    const meals = cache.filter(p => p.is_meal);

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
                if (!ok) return;

                // Optimistic: drop the meal from window.FoodProducts.cache and
                // the cached `food_products_cache` payload + re-render the list
                // BEFORE the DELETE round-trip resolves so the row disappears
                // instantly. Snapshot for rollback on POST failure.
                const cacheBefore = Array.isArray(window.FoodProducts.cache)
                    ? window.FoodProducts.cache.slice()
                    : [];
                window.FoodProducts.cache = cacheBefore.filter((p) => p && p.id !== meal.id);
                if (typeof loadMyMeals === 'function') loadMyMeals();

                const handle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
                    ? await window.DataStore.applyOptimistic('food_products_cache', (prev) => {
                        if (!Array.isArray(prev)) return prev;
                        return prev.filter((p) => p && p.id !== meal.id);
                    }, ['food'])
                    : null;

                try {
                    const res = await apiCall(`/api/food/products/${meal.id}`, 'DELETE');
                    if (res === null) {
                        // apiCall surfaces offline/5xx as a null return (with its
                        // own safeAlert), so the throw branch never fires. Roll
                        // back the optimistic delete so the row reappears.
                        window.FoodProducts.cache = cacheBefore;
                        if (handle) await handle.rollback();
                        if (typeof loadMyMeals === 'function') loadMyMeals();
                        return;
                    }
                    if (handle) await handle.commit(null);
                    if (window.MedTrackerDB) {
                        await window.MedTrackerDB.FoodProductsStore.clearCache();
                    }
                    await initFoodProductsCache();
                    if (typeof loadMyMeals === 'function') loadMyMeals();
                } catch (e) {
                    window.FoodProducts.cache = cacheBefore;
                    if (handle) await handle.rollback();
                    if (typeof loadMyMeals === 'function') loadMyMeals();
                    safeAlert('Failed to delete meal');
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

        list.appendChild(card);
    });
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

    const selected = window.FoodLog && typeof window.FoodLog.getSelectedIds === 'function'
        ? window.FoodLog.getSelectedIds()
        : [];

    const payload = {
        name: name,
        log_ids: selected
    };

    const btn = document.getElementById('food-save-meal-confirm-btn');
    await withSubmit(btn, async () => {
        // Optimistic: append a placeholder meal product into the cache so the
        // My Meals list renders the new row before the POST resolves. The
        // server response replaces the placeholder with authoritative data
        // via initFoodProductsCache + loadMyMeals on success.
        const localId = `local_${Date.now()}`;
        const placeholder = {
            id: localId,
            name: name,
            is_meal: true,
            total_weight_g: 0,
            energy_kcal_100g: 0,
            carbs_100g: 0,
            protein_100g: 0,
            fat_100g: 0,
            isLocal: true
        };
        const cacheBefore = Array.isArray(window.FoodProducts.cache)
            ? window.FoodProducts.cache.slice()
            : [];
        window.FoodProducts.cache = [...cacheBefore, placeholder];

        const handle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
            ? await window.DataStore.applyOptimistic('food_products_cache', (prev) => {
                const arr = Array.isArray(prev) ? prev.slice() : [];
                arr.push(placeholder);
                return arr;
            }, ['food'])
            : null;

        if (typeof loadMyMeals === 'function') loadMyMeals();

        try {
            const res = await apiCall('/api/food/products/from-logs', 'POST', payload);
            if (res === null) {
                // apiCall returns null (and shows its own error alert) on
                // offline/5xx without throwing, so the catch branch never
                // fires for those. Roll back the optimistic placeholder and
                // suppress the success toast.
                window.FoodProducts.cache = cacheBefore;
                if (handle) await handle.rollback();
                if (typeof loadMyMeals === 'function') loadMyMeals();
                return;
            }
            if (window.SyncManager && window.SyncManager.showToast) {
                window.SyncManager.showToast('Meal saved successfully!', 'success');
            }
            if (handle) await handle.commit(null);
            closeFoodSaveMealModal();
            toggleFoodSelectMode();

            window.FoodProducts.cache = [];
            if (window.MedTrackerDB) {
                await window.MedTrackerDB.FoodProductsStore.clearCache();
            }
            await initFoodProductsCache();
            if (typeof loadMyMeals === 'function') loadMyMeals();
        } catch (e) {
            window.FoodProducts.cache = cacheBefore;
            if (handle) await handle.rollback();
            if (typeof loadMyMeals === 'function') loadMyMeals();
            console.error('Failed to save meal:', e);
            safeAlert('Failed to save meal.');
        }
    });
}

window.FoodMeals = window.FoodMeals || {};
window.FoodMeals.load = loadMyMeals;
window.FoodMeals.openSaveModal = openFoodSaveMealModal;
window.FoodMeals.closeSaveModal = closeFoodSaveMealModal;
window.FoodMeals.confirmSave = confirmSaveMeal;
