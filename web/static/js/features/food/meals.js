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
                if (ok) {
                    try {
                        await apiCall(`/api/food/products/${meal.id}`, 'DELETE');
                        window.FoodProducts.cache = [];
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
        try {
            await apiCall('/api/food/products/from-logs', 'POST', payload);
            if (window.SyncManager && window.SyncManager.showToast) {
                window.SyncManager.showToast('Meal saved successfully!', 'success');
            }
            closeFoodSaveMealModal();
            toggleFoodSelectMode();

            window.FoodProducts.cache = [];
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

window.FoodMeals = window.FoodMeals || {};
window.FoodMeals.load = loadMyMeals;
window.FoodMeals.openSaveModal = openFoodSaveMealModal;
window.FoodMeals.closeSaveModal = closeFoodSaveMealModal;
window.FoodMeals.confirmSave = confirmSaveMeal;
